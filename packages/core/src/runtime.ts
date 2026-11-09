// Runtime: owns the session tree and everything sessions share
// (providers, rate limiters, cost ledger, hooks, tools, store, event bus).
import { CostLedger, DEFAULT_PRICES, type BudgetConfig, type PriceTable } from './cost.ts';
import { EventBus, isoNow } from './events.ts';
import { HookRegistry } from './hooks.ts';
import { RateLimiter, type LimiterConfig } from './limiter.ts';
import type { Provider } from './providers/types.ts';
import { Session, type RunResult } from './session.ts';
import { MemoryStore } from './store/memory.ts';
import type { RelayRecord, SessionConfig, SessionRecord, Store } from './store/types.ts';
import { agentTools } from './tools/agent-tools.ts';
import { projectTools } from './tools/project-tools.ts';
import { createRunCommandTool } from './tools/command-tool.ts';
import { createWebFetchTool, createWebSearchTool, type SearchBackend } from './tools/web-tools.ts';
import { connectMcp, type McpServerConfig, type McpStdioClient } from './mcp/client.ts';
import { fileTools } from './tools/fs-tools.ts';
import { ToolRegistry, type FileExtractor, type Tool } from './tools/types.ts';
import { Tracer } from './trace.ts';
import type {
  AgentRole,
  ChildNoteMeta,
  CreateProjectRequest,
  CreateSessionRequest,
  Message,
  ProjectDetail,
  ProjectInfo,
  ProjectActivityKind,
  SessionStatus,
  WorkflowDef,
  WorkObject,
} from './types.ts';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { newId } from './util.ts';
import { BUILTIN_TEMPLATES, loadWorkflows, projectLogEntry, type RoleTemplate } from './projects.ts';

export interface RuntimeOptions {
  providers: Provider[];
  /** Defaults for new sessions. */
  defaults: { providerId: string; model: string; maxTokens: number; maxTurns?: number; system?: string };
  store?: Store;
  /** Rate limits per provider id (deployment configuration). */
  limits?: Record<string, LimiterConfig>;
  prices?: PriceTable;
  budget?: BudgetConfig;
  /** Built-in tools to register. Default: file tools, run_command, ask_user, suggest_actions and the session-tree tools. */
  tools?: Tool[];
  extractors?: FileExtractor[];
  /** Default working folder for sessions. */
  cwd?: string;
  /** Where run_command saves outputs too long to return (default: a temp folder). */
  spillDir?: string;
  /** Search backend for web_search. Without one (and without hosted search) the tool is not offered. */
  search?: SearchBackend;
  /** Use the model's own hosted web search when the provider has it. Default true. */
  hostedWebSearch?: boolean;
  /** Interface language for new sessions (BCP 47). Default zh-CN. */
  locale?: string;
  /** Role templates in addition to the built-in 'top' and 'project-manager' (same id replaces). */
  templates?: RoleTemplate[];
  /** Folder of workflow JSON files (stages, work-object levels). */
  workflowsDir?: string;
  /** Workflow definitions given directly (validated like files). */
  workflows?: unknown[];
  /** Where new project folders go when no absolute folder is given. Default: cwd. */
  projectsRoot?: string;
}

/** What sessions need from the runtime. Not part of the public API. */
export interface RuntimeInternals {
  readonly events: EventBus;
  readonly hooks: HookRegistry;
  readonly tools: ToolRegistry;
  readonly store: Store;
  readonly tracer: Tracer;
  readonly ledger: CostLedger;
  readonly extractors: FileExtractor[];
  provider(id: string): Provider;
  limiter(providerId: string): RateLimiter;
  parentChain(sessionId: string): string[];
  services(session: Session): Record<string, unknown>;
  onUserMessage(session: Session, message: Message): void;
  onStatus(session: Session, status: SessionStatus): void;
  onRunEnd(session: Session, result: RunResult): void;
  onToolDone(session: Session, call: { name: string; input: unknown }, result: { isError: boolean }): void;
  hasChildren(sessionId: string): boolean;
}

/** How a session is named in text written for the model. */
function label(s: Session): string {
  const title = s.info().title;
  return title ? `"${title}" (${s.id})` : s.id;
}

/** Folder name for a project: keeps the name, drops characters Windows does not allow. */
function safeFolderName(name: string): string {
  const cleaned = [...name]
    .map((ch) => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? '_' : ch))
    .join('')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned || 'project';
}

export const DEFAULT_SYSTEM_PROMPT =
  'You are an agent in Spica, a desktop workbench. Use the available tools to inspect files and gather facts ' +
  'instead of guessing. Every tool result starts with the time the data was fetched; treat older results as ' +
  'possibly out of date and fetch again when the current state matters. Be concise.';

export class Runtime implements RuntimeInternals {
  readonly events = new EventBus();
  readonly hooks = new HookRegistry();
  readonly tools = new ToolRegistry();
  readonly store: Store;
  readonly tracer: Tracer;
  readonly ledger: CostLedger;
  readonly extractors: FileExtractor[];
  readonly #providers = new Map<string, Provider>();
  readonly #limiters = new Map<string, RateLimiter>();
  readonly #sessions = new Map<string, Session>();
  readonly #opts: RuntimeOptions;
  readonly #workflows: { workflows: Map<string, WorkflowDef>; errors: string[] };
  readonly #mcp = new Map<string, { client: McpStdioClient; source: string; disconnect: () => Promise<void> }>();
  readonly #reports = new Map<string, string>();

  constructor(opts: RuntimeOptions) {
    this.#opts = opts;
    this.#workflows = loadWorkflows(opts.workflowsDir, opts.workflows ?? []);
    this.store = opts.store ?? new MemoryStore();
    this.tracer = new Tracer(this.store, this.events);
    this.ledger = new CostLedger(opts.prices ?? DEFAULT_PRICES, opts.budget ?? {});
    this.extractors = [...(opts.extractors ?? [])];
    for (const p of opts.providers) this.addProvider(p, opts.limits?.[p.id]);
    const defaults = [
      ...fileTools,
      createRunCommandTool(opts.spillDir ? { spillDir: opts.spillDir } : {}),
      createWebFetchTool(),
      ...(opts.search ? [createWebSearchTool(opts.search)] : []),
      ...agentTools,
      ...projectTools,
    ];
    for (const t of opts.tools ?? defaults) this.tools.register(t, 'core');
    // Waiting is done with wait_agents: refuse commands that only sleep, before
    // they reach the confirmation card.
    this.hooks.register('core:guard', {
      beforeTool: (call) => {
        if (call.name !== 'run_command') return;
        const cmd = String((call.input as { command?: unknown } | null)?.command ?? '').trim();
        if (/^(start-sleep|sleep|timeout(\.exe)?|ping\s+(-n|-c)\s+\d+\s+(127\.0\.0\.1|localhost))\b[^;&|]*$/i.test(cmd)) {
          return { action: 'deny', reason: 'do not wait with sleep commands; use wait_agents to wait for sub-agents or project managers' };
        }
        return undefined;
      },
    });
    // Sessions inside a project see their project and stage every turn.
    this.hooks.register('core:project', {
      inject: (ctx) => {
        const projectId = ctx.session.projectId;
        const p = projectId ? this.store.getProject(projectId) : undefined;
        if (!p) return;
        const wf = p.workflowId ? this.#workflows.workflows.get(p.workflowId) : undefined;
        const stage = wf?.stages.find((s) => s.id === p.stage);
        const text =
          `You work for the project "${p.name}" (${p.id}); project folder: ${p.folder}.` +
          (wf ? ` Workflow: ${wf.name}; current stage: ${stage?.name ?? p.stage}${stage?.goal ? ` (goal: ${stage.goal})` : ''}.` : '');
        return [{ position: 'system:after', text, priority: 10 }];
      },
    });
  }

  addProvider(p: Provider, limits?: LimiterConfig): void {
    this.#providers.set(p.id, p);
    p.attach?.({ tracer: this.tracer });
    this.#limiters.set(p.id, new RateLimiter(limits ?? {}));
  }

  provider(id: string): Provider {
    const p = this.#providers.get(id);
    if (!p) throw new Error(`unknown provider: ${id}`);
    return p;
  }

  limiter(providerId: string): RateLimiter {
    let l = this.#limiters.get(providerId);
    if (!l) {
      l = new RateLimiter({});
      this.#limiters.set(providerId, l);
    }
    return l;
  }

  createSession(req: CreateSessionRequest = {}): Session {
    const d = this.#opts.defaults;
    const parent = req.parentId ? this.session(req.parentId) : undefined;
    if (req.parentId && !parent) throw new Error(`unknown parent session: ${req.parentId}`);
    // A session without a parent is a thread of the top-level agent: it uses the
    // 'top' template unless told otherwise (one role, many conversation threads).
    const implicitTop = !parent && !req.templateId && (req.role ?? 'top') === 'top';
    const templateId = req.templateId ?? (implicitTop ? 'top' : undefined);
    const tpl = templateId ? this.template(templateId) : undefined;
    if (req.templateId && !tpl) throw new Error(`unknown role template: ${req.templateId}`);
    const now = isoNow();
    const role: AgentRole = req.role ?? tpl?.role ?? (parent ? 'worker' : 'top');
    const tools = req.tools ?? tpl?.tools ?? parent?.config.tools;
    const config: SessionConfig = {
      system: req.system ?? tpl?.system ?? d.system ?? DEFAULT_SYSTEM_PROMPT,
      providerId: req.providerId ?? tpl?.providerId ?? parent?.config.providerId ?? d.providerId,
      model: req.model ?? tpl?.model ?? (req.providerId || tpl?.providerId ? undefined : parent?.config.model) ?? d.model,
      maxTokens: req.maxTokens ?? d.maxTokens,
      cwd: req.cwd ?? parent?.config.cwd ?? this.#opts.cwd ?? process.cwd(),
      maxTurns: req.maxTurns ?? d.maxTurns ?? 50,
      locale: req.locale ?? parent?.config.locale ?? this.#opts.locale ?? 'zh-CN',
      serverWebSearch: false,
      // A sub-agent gets its parent's tool allow-list unless told otherwise.
      ...(tools ? { tools } : {}),
      ...(tpl ? { templateId: tpl.id } : {}),
      ...((req.projectId ?? parent?.config.projectId) ? { projectId: req.projectId ?? parent?.config.projectId } : {}),
    };
    const provider = this.provider(config.providerId); // fail fast
    config.serverWebSearch = (this.#opts.hostedWebSearch ?? true) && provider.capabilities.serverWebSearch;
    const record: SessionRecord = {
      id: newId('ses'),
      parentId: parent?.id ?? null,
      role,
      title: req.title ?? null,
      status: 'idle',
      config,
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsertSession(record);
    const s = new Session(this, record);
    this.#sessions.set(s.id, s);
    if (parent) {
      this.events.emit(
        { sessionId: parent.id, parentChain: parent.parentChain },
        { type: 'child.spawned', childId: s.id, title: record.title },
      );
      if (parent.info().projectId && config.projectId) {
        this.logProjectActivity(parent, 'child.spawn', `Started sub-agent ${record.title ?? s.id}`, record.title ?? undefined, s.id);
      }
    }
    this.events.emit({ sessionId: s.id, parentChain: s.parentChain }, { type: 'status', status: 'idle' });
    return s;
  }

  /** A role template by id (deployment templates override the built-in ones). */
  template(id: string): RoleTemplate | undefined {
    return (this.#opts.templates ?? []).find((t) => t.id === id) ?? BUILTIN_TEMPLATES.find((t) => t.id === id);
  }

  session(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  sessions(): Session[] {
    return [...this.#sessions.values()];
  }

  hasChildren(id: string): boolean {
    return this.sessions().some((s) => s.parentId === id);
  }

  /** All sessions below `id` in the tree. */
  descendants(id: string): Session[] {
    const out: Session[] = [];
    const walk = (pid: string) => {
      for (const c of this.children(pid)) {
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }

  /**
   * Sessions `callerId` may message or wait for: its own sub-agents (any
   * depth), and for any top-level thread also every project manager and the
   * manager's sub-agents.
   */
  directable(callerId: string): Session[] {
    const caller = this.session(callerId);
    if (!caller) return [];
    const own = this.descendants(callerId);
    if (caller.info().role !== 'top') return own;
    const seen = new Set(own.map((s) => s.id));
    for (const s of this.sessions()) {
      if (!seen.has(s.id) && s.id !== callerId && s.info().projectId) {
        own.push(s);
        seen.add(s.id);
      }
    }
    return own;
  }

  canDirect(callerId: string, targetId: string): boolean {
    return this.directable(callerId).some((s) => s.id === targetId);
  }

  children(id: string): Session[] {
    return this.sessions().filter((s) => s.parentId === id);
  }

  parentChain(sessionId: string): string[] {
    const chain: string[] = [];
    let cur = this.#sessions.get(sessionId)?.parentId ?? this.store.getSession(sessionId)?.parentId ?? null;
    while (cur && !chain.includes(cur)) {
      chain.push(cur);
      cur = this.#sessions.get(cur)?.parentId ?? this.store.getSession(cur)?.parentId ?? null;
    }
    return chain;
  }

  /** Services handed to tools (session-tree tools use these). */
  services(): Record<string, unknown> {
    return { runtime: this };
  }

  /**
   * Default relay: every message the user writes in a child session is added
   * to the parent's context as a note (and stored), so the parent knows what
   * the user said there.
   */
  onUserMessage(session: Session, message: Message): void {
    if (message.meta?.author !== 'user') return;
    const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    this.#relay(session, 'user_message', `The user wrote in that session: "${text}"`, this.#noteMeta(session, 'relay', text));
  }

  onStatus(): void {}

  /**
   * A child's finished run becomes its report: always written into the
   * parent as a `report` message (ChildNoteMeta), at the parent's next turn
   * boundary if it is running (e.g. inside wait_agents) or right away if idle.
   */
  onRunEnd(session: Session, result: RunResult): void {
    if (!session.parentId || result.reason !== 'completed') return;
    const report = result.text || '(finished without a written report)';
    this.#reports.set(session.id, report);
    const parent = this.session(session.parentId);
    if (!parent) return;
    this.store.appendRelay(this.#relayRecord(parent.id, session.id, 'report', report));
    if (session.info().projectId) {
      const title = session.info().title;
      this.logProjectActivity(session, 'child.report', `Sub-agent ${title ?? session.id} reported`, title ?? undefined, report.slice(0, 200));
    }
    this.events.emit({ sessionId: parent.id, parentChain: parent.parentChain }, { type: 'child.report', childId: session.id, summary: report.slice(0, 500) });
    parent.addNote('report', `[Report from sub-agent ${label(session)}]\n${report}`, { ...this.#noteMeta(session, 'report', report) });
  }

  /**
   * Record a decision made or changed in a session; it is relayed to the
   * parent like a user message. `by` says who recorded it.
   */
  recordDecision(sessionId: string, decision: string, by: 'user' | 'agent'): void {
    const s = this.session(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);
    this.events.emit({ sessionId, parentChain: s.parentChain }, { type: 'relay', fromSessionId: sessionId, note: `decision: ${decision}` });
    this.#relay(s, 'decision', `Decision ${by === 'user' ? 'made by the user' : 'recorded'} there: ${decision}`, {
      ...this.#noteMeta(s, 'decision', decision),
      by,
    });
  }

  // ---------------------------------------------------------------------------
  // Projects: a folder + a persistent project-manager session under the top-level agent
  // ---------------------------------------------------------------------------

  /** The single top-level agent session (created on first call). */
  top(): Session {
    const existing = this.sessions().find((s) => s.info().role === 'top' && s.parentId === null && s.info().templateId === 'top');
    return existing ?? this.createSession({ templateId: 'top' });
  }

  get workflows(): ReadonlyMap<string, WorkflowDef> {
    return this.#workflows.workflows;
  }

  /** Problems found while loading workflow files (shown to the user by the UI). */
  get workflowErrors(): readonly string[] {
    return this.#workflows.errors;
  }

  createProject(req: CreateProjectRequest): ProjectInfo {
    const name = req.name.trim();
    if (!name) throw new Error('a project needs a name');
    const rootDir = this.#opts.projectsRoot ?? this.#opts.cwd ?? process.cwd();
    const folder = req.folder ? (isAbsolute(req.folder) ? req.folder : join(rootDir, req.folder)) : join(rootDir, safeFolderName(name));
    let workflow: WorkflowDef | undefined;
    if (req.workflowId) {
      workflow = this.#workflows.workflows.get(req.workflowId);
      if (!workflow) throw new Error(`unknown workflow "${req.workflowId}"; known: ${[...this.#workflows.workflows.keys()].join(', ') || 'none'}`);
    }
    mkdirSync(folder, { recursive: true });
    const top = this.top();
    const id = newId('prj');
    const manager = this.createSession({ parentId: top.id, templateId: 'project-manager', title: name, cwd: folder, projectId: id });
    const now = isoNow();
    const project: ProjectInfo = {
      id,
      name,
      folder,
      managerSessionId: manager.id,
      workflowId: workflow?.id ?? null,
      stage: workflow?.stages[0]?.id ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsertProject(project);
    this.events.emit({ sessionId: top.id, parentChain: [] }, { type: 'project.created', project });
    if (req.brief?.trim()) manager.send(req.brief, { author: 'parent' });
    return project;
  }

  listProjects(): ProjectInfo[] {
    return this.store.listProjects();
  }

  getProject(projectId: string): ProjectDetail | undefined {
    const p = this.store.getProject(projectId);
    if (!p) return undefined;
    const manager = this.session(p.managerSessionId);
    if (!manager) return undefined;
    return {
      ...p,
      workflow: p.workflowId ? (this.#workflows.workflows.get(p.workflowId) ?? null) : null,
      objects: this.store.listWorkObjects(projectId),
      recentLog: this.store.listProjectLog(projectId, 20),
      manager: manager.info(),
      agents: this.children(manager.id).map((c) => c.info()),
    };
  }

  /** Move a project to another stage of its workflow; relayed to the top-level agent. */
  setStage(projectId: string, stageId: string, note: string | undefined, bySessionId: string): ProjectInfo {
    const p = this.store.getProject(projectId);
    if (!p) throw new Error(`unknown project: ${projectId}`);
    const wf = p.workflowId ? this.#workflows.workflows.get(p.workflowId) : undefined;
    if (!wf) throw new Error('this project has no workflow, so it has no stages');
    const stage = wf.stages.find((s) => s.id === stageId || s.name === stageId);
    if (!stage) throw new Error(`unknown stage "${stageId}"; stages: ${wf.stages.map((s) => s.id).join(', ')}`);
    const updated: ProjectInfo = { ...p, stage: stage.id, updatedAt: isoNow() };
    this.store.upsertProject(updated);
    const by = this.session(bySessionId) ?? this.session(p.managerSessionId);
    const summary = `Stage changed to "${stage.name}"${note ? `: ${note}` : ''}`;
    if (by) this.logProjectActivity(by, 'stage', summary, stage.id, note);
    const manager = this.session(p.managerSessionId);
    if (manager) this.recordDecision(manager.id, `Project "${p.name}": ${summary}`, 'agent');
    const top = this.top();
    this.events.emit({ sessionId: top.id, parentChain: [] }, { type: 'project.updated', project: updated });
    return updated;
  }

  addWorkObject(projectId: string, obj: { level: string; name: string; parentId?: string | null; data?: Record<string, unknown> }): WorkObject {
    const p = this.store.getProject(projectId);
    if (!p) throw new Error(`unknown project: ${projectId}`);
    const levels = (p.workflowId ? this.#workflows.workflows.get(p.workflowId)?.objectLevels : undefined) ?? [];
    const level = levels.find((l) => l.id === obj.level || l.name === obj.level);
    if (levels.length > 0 && !level) throw new Error(`unknown level "${obj.level}"; levels: ${levels.map((l) => l.id).join(', ')}`);
    const levelId = level?.id ?? obj.level;
    const existing = this.store.listWorkObjects(projectId);
    const parent = obj.parentId ? existing.find((o) => o.id === obj.parentId) : undefined;
    if (obj.parentId && !parent) throw new Error(`unknown parent object: ${obj.parentId}`);
    if (level?.parent && !parent) throw new Error(`a "${level.id}" belongs under a "${level.parent}"; give parent_id`);
    if (level && parent && level.parent !== parent.level) throw new Error(`a "${level.id}" belongs under a "${level.parent ?? 'nothing'}", not a "${parent.level}"`);
    const o: WorkObject = {
      id: newId('obj'),
      projectId,
      level: levelId,
      name: obj.name.trim(),
      parentId: parent?.id ?? null,
      ...(obj.data ? { data: obj.data } : {}),
      createdAt: isoNow(),
    };
    if (!o.name) throw new Error('a work object needs a name');
    this.store.upsertWorkObject(o);
    return o;
  }

  /**
   * Record a key action inside a project (for the top-level agent) and emit
   * project.activity. `summary` is English for the model; UIs use kind/target/detail.
   */
  logProjectActivity(session: Session, action: ProjectActivityKind, summary: string, target?: string, detail?: string): void {
    const projectId = session.info().projectId;
    if (!projectId) return;
    const entry = projectLogEntry({
      id: newId('plog'),
      projectId,
      sessionId: session.id,
      at: isoNow(),
      action,
      ...(target ? { target: target.slice(0, 500) } : {}),
      ...(detail ? { detail: detail.slice(0, 500) } : {}),
      summary: summary.slice(0, 500),
    });
    this.store.appendProjectLog(entry);
    this.events.emit({ sessionId: session.id, parentChain: session.parentChain }, { type: 'project.activity', entry });
  }

  /** Called after each tool call: key actions in a project go to the project log. */
  onToolDone(session: Session, call: { name: string; input: unknown }, result: { isError: boolean }): void {
    if (result.isError || !session.info().projectId) return;
    const input = (call.input ?? {}) as Record<string, unknown>;
    const path = typeof input.path === 'string' ? this.#projectRelative(session, input.path) : undefined;
    if (call.name === 'write_file') this.logProjectActivity(session, 'file.write', `Wrote ${path ?? 'a file'}`, path);
    else if (call.name === 'edit_file') this.logProjectActivity(session, 'file.edit', `Edited ${path ?? 'a file'}`, path);
    else if (call.name === 'run_command') {
      const cmd = String(input.command ?? '').slice(0, 200);
      this.logProjectActivity(session, 'command', `Ran: ${cmd}`, cmd);
    } else if (call.name === 'record_decision') {
      const d = String(input.decision ?? '');
      this.logProjectActivity(session, 'decision', `Decision: ${d}`, undefined, d);
    }
  }

  /** A path as seen from the project folder (absolute when it is outside). */
  #projectRelative(session: Session, p: string): string {
    const projectId = session.info().projectId;
    const folder = projectId ? this.store.getProject(projectId)?.folder : undefined;
    const abs = isAbsolute(p) ? p : join(session.config.cwd, p);
    if (!folder) return p;
    const rel = relative(folder, abs);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split('\\').join('/') : abs;
  }

  lastReport(sessionId: string): string | undefined {
    return this.#reports.get(sessionId) ?? this.store.listRelays(this.session(sessionId)?.parentId ?? '').filter((r) => r.childId === sessionId && r.kind === 'report').pop()?.text;
  }

  /**
   * Withdraw everything a plugin registered: hooks, tools, and the MCP servers
   * it connected. Hooks and tools are gone immediately; await `stopped` before
   * deleting the plugin's files (server processes are still exiting).
   */
  unregisterSource(source: string): { hooks: number; tools: number; mcpServers: number; stopped: Promise<void> } {
    const servers = [...this.#mcp.values()].filter((m) => m.source === source);
    const stopped = Promise.all(servers.map((m) => m.disconnect())).then(() => undefined);
    return { hooks: this.hooks.unregisterSource(source), tools: this.tools.unregisterSource(source), mcpServers: servers.length, stopped };
  }

  #noteMeta(child: Session, kind: ChildNoteMeta['kind'], text: string): ChildNoteMeta {
    return { author: 'child', kind, fromSessionId: child.id, fromTitle: child.info().title, at: isoNow(), text };
  }

  #relay(child: Session, kind: RelayRecord['kind'], body: string, meta: ChildNoteMeta): void {
    if (!child.parentId) return;
    const parent = this.session(child.parentId);
    if (!parent) return;
    const note = `[From sub-agent ${label(child)}] ${body}`;
    this.store.appendRelay(this.#relayRecord(parent.id, child.id, kind, meta.text));
    parent.addNote('relay', note, { ...meta });
    this.events.emit({ sessionId: parent.id, parentChain: parent.parentChain }, { type: 'relay', fromSessionId: child.id, note });
  }

  #relayRecord(parentId: string, childId: string, kind: RelayRecord['kind'], text: string): RelayRecord {
    return { id: newId('rel'), parentId, childId, kind, text, createdAt: isoNow() };
  }

  /** Traceable records as JSON Lines. */
  exportTraces(filter?: { sessionId?: string }): string {
    return this.tracer.exportJsonl(filter);
  }

  /**
   * Rebuild the session tree from the store after a restart. Sessions caught
   * mid-run become `interrupted` (continue them with `session.resume()`);
   * pending questions and confirmations are kept; queued steers are applied
   * when the session runs again; cost totals are re-seeded from the records.
   */
  restore(): { sessions: number; interrupted: string[]; awaiting: string[] } {
    const interrupted: string[] = [];
    const awaiting: string[] = [];
    const traces = this.store.listTraces();
    const lastInput = new Map<string, number>();
    for (const t of traces) {
      if (t.kind !== 'model' || !t.sessionId || t.status !== 'ok') continue;
      const kind = t.providerId ? this.#providers.get(t.providerId)?.kind : undefined;
      const cached = kind === 'anthropic' ? (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0) : 0;
      lastInput.set(t.sessionId, (t.inputTokens ?? 0) + cached);
    }
    let count = 0;
    for (const rec of this.store.listSessions()) {
      if (this.#sessions.has(rec.id)) continue;
      let status = rec.status;
      const pending = this.store.listPending(rec.id);
      if (pending.length > 0) {
        status = pending.some((p) => p.item.kind === 'confirm') ? 'awaiting_confirm' : 'awaiting_answer';
        awaiting.push(rec.id);
      } else if (status === 'thinking' || status === 'tool' || status === 'queued' || status === 'awaiting_confirm' || status === 'awaiting_answer') {
        status = 'interrupted';
      }
      if (status === 'interrupted') interrupted.push(rec.id);
      const record = status === rec.status ? rec : { ...rec, status, updatedAt: isoNow() };
      if (record !== rec) this.store.upsertSession(record);
      const messages = this.store.listMessages(rec.id).map((m) => {
        if (m.meta?.partial !== true || m.meta.interrupted === true) return m;
        const fixed = { ...m, meta: { ...m.meta, interrupted: true } };
        this.store.updateMessage(fixed); // a stream cut off by the crash
        return fixed;
      });
      const s = new Session(this, record, messages, { lastInputTokens: lastInput.get(rec.id) ?? 0 });
      this.#sessions.set(s.id, s);
      count++;
    }
    this.ledger.seed(
      traces
        .filter((t) => t.costUsd)
        .map((t) => ({ providerId: t.providerId ?? 'unknown', ...(t.sessionId ? { sessionId: t.sessionId } : {}), costUsd: t.costUsd ?? 0 })),
    );
    for (const s of this.#sessions.values()) {
      this.events.emit({ sessionId: s.id, parentChain: s.parentChain }, { type: 'status', status: s.status });
    }
    return { sessions: count, interrupted, awaiting };
  }

  /**
   * Start an MCP server (stdio) and add its tools under `opts.source`
   * (default `mcp:<name>`); `unregisterSource(source)` or `disconnect()`
   * removes the tools and stops the server.
   */
  async connectMcp(
    config: McpServerConfig,
    opts: { source?: string } = {},
  ): Promise<{ tools: string[]; source: string; disconnect: () => Promise<void> }> {
    if (this.#mcp.has(config.name)) throw new Error(`MCP server "${config.name}" is already connected`);
    const h = await connectMcp(this.tools, this.tracer, config, opts);
    // Resolves when the server process has exited.
    const disconnect = () => {
      this.#mcp.delete(config.name);
      return h.disconnect();
    };
    this.#mcp.set(config.name, { client: h.client, source: h.source, disconnect });
    return { tools: h.tools, source: h.source, disconnect };
  }

  /** Stop all runs (they become `interrupted`, resumable after restart), stop MCP servers, close the store. */
  async close(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((s) => s.shutdown()));
    await Promise.all([...this.#mcp.values()].map((m) => m.disconnect()));
    this.store.close();
  }
}
