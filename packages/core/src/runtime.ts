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
import { MailPipeline, triageMailTool, type MailConfig } from './mail.ts';
import { projectTools } from './tools/project-tools.ts';
import { historyTools } from './tools/history-tools.ts';
import { createRunCommandTool } from './tools/command-tool.ts';
import { createWebFetchTool, createWebSearchTool, type SearchBackend } from './tools/web-tools.ts';
import { connectMcp, type McpServerConfig, type McpStdioClient } from './mcp/client.ts';
import { fileTools } from './tools/fs-tools.ts';
import { ToolRegistry, validateInput, type FileExtractor, type Tool } from './tools/types.ts';
import { Tracer } from './trace.ts';
import type { SettingsBridge } from './settings-tools.ts';
import { PluginSampler } from './sampling.ts';
import { BUILTIN_CATALOG } from './catalog/builtin.ts';
import { catalogProblems, catalogProvider, effectiveCatalog, presetProblems, pricesFromCatalog, type CatalogPreset, type ModelCatalog } from './catalog/catalog.ts';
import type {
  AgentRole,
  ChildNoteMeta,
  CreateProjectRequest,
  CreateSessionRequest,
  CwdChangeMeta,
  GuardCause,
  Message,
  ProjectDetail,
  PluginToolResult,
  SessionInfo,
  ProjectInfo,
  ProjectActivityKind,
  ProjectLogEntry,
  SessionStatus,
  SetCwdResult,
  WorkflowDef,
  WorkObject,
} from './types.ts';
import { existsSync, mkdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { moveFolderContents, removeEmptyTree, within } from './move-folder.ts';
import { newId, redact } from './util.ts';
import { exportUsageLog, type UsageLogFilter } from './export.ts';
import { BUILTIN_TEMPLATES, loadWorkflows, type RoleTemplate } from './projects.ts';

export interface RuntimeOptions {
  providers: Provider[];
  /**
   * Values that must never appear in exports or records: model keys, client
   * secrets, endpoint addresses (host names are added for URLs). Write-only:
   * see addRedactions().
   */
  redactions?: readonly (string | undefined)[];
  /** Defaults for new sessions. */
  /**
   * strongModel: the model for heavy work (plugins asking for a strong model get it), on the default
   * provider or on strongProviderId when it is on another connection.
   */
  defaults: { providerId: string; model: string; maxTokens: number; maxTurns?: number; system?: string; strongModel?: string; strongProviderId?: string };
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
  /** Mail pipeline (sources, interval, triage). Polling starts only with mail.start(). */
  mail?: MailConfig;
  /**
   * The product name the models are told they work in (system prompts, the
   * guard's notes, the web_fetch user agent). Default 'Spica'. Internal names
   * (package names, spica_ tools, SPICA_ variables, spica-*:// links) do not change.
   */
  appName?: string;
  /** A company's model connections (the packaging's deploy.json), first in the settings form. */
  catalogPresets?: CatalogPreset[];
  /** Where attached images are kept (one folder per conversation, deleted with it). Default: the temp folder. */
  mediaDir?: string;
  /**
   * A conversation started without a folder (not in a project, not a sub-agent)
   * works in its own folder here: <sessionFilesDir>/<session id>/files, made on
   * creation. Without it such conversations use `cwd`.
   */
  sessionFilesDir?: string;
}

export { APP_NAME_SLOT, withAppName } from './util.ts';

/** What sessions need from the runtime. Not part of the public API. */
export interface RuntimeInternals {
  readonly appName: string;
  readonly events: EventBus;
  mediaDir(sessionId: string): string;
  /** The folder a conversation without a chosen one works in (in the app data); undefined when there are none. */
  ownFolder(sessionId: string): string | undefined;
  /** true / false when the catalog says whether the model takes images (or it refused them before); undefined: unknown, send them. */
  imagesAllowed(providerId: string, model: string): boolean | undefined;
  /** The provider refused images for this model: later requests to it leave the images out. */
  markNoImages(providerId: string, model: string): void;
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
  session(id: string): Session | undefined;
  recordDecision(sessionId: string, decision: string, by: 'user' | 'agent'): void;
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
  'You are an agent in {{app}}, a desktop workbench. Use the available tools to inspect files and gather facts ' +
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
  /** Keys and endpoint addresses to redact. Write-only: nothing reads it back out of the runtime. */
  readonly #secrets = new Set<string>();
  readonly #limiters = new Map<string, RateLimiter>();
  readonly #sessions = new Map<string, Session>();
  readonly #opts: RuntimeOptions;
  /** Incoming mail → triage → project managers. */
  readonly mail: MailPipeline;
  #workflows: { workflows: Map<string, WorkflowDef>; errors: string[] };
  readonly #mcp = new Map<string, { client: McpStdioClient; source: string; disconnect: () => Promise<void> }>();
  readonly #reports = new Map<string, string>();
  readonly #viewConfirms = new Map<string, (approved: boolean) => void>();
  #catalogUpdate: ModelCatalog | undefined;
  #presets: CatalogPreset[] = [];

  /** The model catalog in use: the built-in one or a newer update, with the company's presets first. */
  get catalog(): ModelCatalog {
    return effectiveCatalog(BUILTIN_CATALOG, this.#catalogUpdate, this.#presets);
  }

  /**
   * Take a catalog update (used when newer than the built-in one) and / or the
   * company's presets; invalid ones are left out and named in the result. The
   * price table follows the catalog unless the deployment gave its own prices.
   */
  setCatalog(o: { update?: unknown; presets?: unknown }): string[] {
    const warnings: string[] = [];
    if (o.update !== undefined) {
      const bad = catalogProblems(o.update);
      if (bad.length) warnings.push(`model catalog update not used: ${bad.slice(0, 5).join('; ')}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ''}`);
      else this.#catalogUpdate = o.update as ModelCatalog;
    }
    if (o.presets !== undefined) {
      const bad = presetProblems(o.presets);
      if (bad.length) warnings.push(`company model presets not used: ${bad.join('; ')}`);
      else this.#presets = o.presets as CatalogPreset[];
    }
    if (!this.#opts.prices) this.ledger.setPrices(pricesFromCatalog(this.catalog));
    return warnings;
  }

  /** Plugins using the user's models (MCP sampling): daily limits, rate limits, records. */
  readonly sampler = new PluginSampler(this);

  readonly #noImages = new Set<string>();

  /** The folder a conversation without a chosen one works in: <sessionFilesDir>/<id>/files. */
  ownFolder(sessionId: string): string | undefined {
    return this.#opts.sessionFilesDir ? join(this.#opts.sessionFilesDir, sessionId, 'files') : undefined;
  }

  /** Folder for the images attached in a conversation. */
  mediaDir(sessionId: string): string {
    return join(this.#opts.mediaDir ?? join(tmpdir(), 'spica-media'), sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));
  }

  imagesAllowed(providerId: string, model: string): boolean | undefined {
    if (this.#noImages.has(`${providerId}|${model}`)) return false;
    const catalogId = this.ledger.catalogIdOf(providerId);
    const known = catalogProvider(this.catalog, catalogId)?.models.find((m) => m.id === model)?.vision;
    return known;
  }

  markNoImages(providerId: string, model: string): void {
    this.#noImages.add(`${providerId}|${model}`);
  }

  /** See RuntimeOptions.appName. */
  get appName(): string {
    return this.#opts.appName?.trim() || 'Spica';
  }

  /** Confirmations only the window may answer (not Spica's MCP service: the asking script would answer itself). */
  readonly #userOnly = new Set<string>();
  /**
   * How Spica's MCP service reaches the host's settings (set by startBackend; see
   * settings-tools.ts). Undefined: the settings tools say they are not available.
   */
  settingsBridge: SettingsBridge | undefined;
  /**
   * Changes to the settings from Spica's MCP service wait for the user's
   * confirmation. Default off: they apply at once and are shown in the
   * conversations (settings.changed, a note with meta.settingsChange).
   */
  confirmSettingsChanges = false;
  readonly #viewLimiters = new Map<string, RateLimiter>();

  constructor(opts: RuntimeOptions) {
    this.#opts = opts;
    this.#workflows = loadWorkflows(opts.workflowsDir, opts.workflows ?? []);
    this.mail = new MailPipeline(this, opts.mail ?? {});
    this.store = opts.store ?? new MemoryStore();
    this.addRedactions(opts.redactions ?? []);
    this.tracer = new Tracer(this.store, this.events, (text) => redact(text, [...this.#secrets]));
    this.ledger = new CostLedger(opts.prices ?? DEFAULT_PRICES, opts.budget ?? {});
    if (opts.catalogPresets) for (const w of this.setCatalog({ presets: opts.catalogPresets })) console.error(w);
    this.extractors = [...(opts.extractors ?? [])];
    for (const p of opts.providers) this.addProvider(p, opts.limits?.[p.id]);
    const defaults = [
      ...fileTools,
      createRunCommandTool(opts.spillDir ? { spillDir: opts.spillDir } : {}),
      createWebFetchTool({ userAgent: `${this.appName.replace(/[^A-Za-z0-9._-]+/g, '-') || 'Spica'}/0.1 (+agent web_fetch)` }),
      ...agentTools,
      ...projectTools,
      ...historyTools,
      triageMailTool,
    ];
    for (const t of opts.tools ?? defaults) this.tools.register(t, 'core');
    if (opts.search && !opts.tools) this.setSearch(opts.search);
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
    this.setProvider(p, limits);
  }

  // ---------------------------------------------------------------------------
  // Settings that can change while running (the settings page never needs a
  // backend restart). Running sessions keep their provider and model.
  // ---------------------------------------------------------------------------

  /** Add or replace a provider; its rate limiter (and anyone queued on it) is kept. */
  setProvider(p: Provider, limits?: LimiterConfig): void {
    this.#providers.set(p.id, p);
    p.attach?.({ tracer: this.tracer });
    const existing = this.#limiters.get(p.id);
    if (existing) {
      if (limits) existing.configure(limits);
    } else {
      this.#limiters.set(p.id, new RateLimiter(limits ?? {}));
    }
  }

  /** Remove a provider; sessions still using it get a clear error on their next model call. */
  removeProvider(id: string): boolean {
    return this.#providers.delete(id);
  }

  get providerIds(): string[] {
    return [...this.#providers.keys()];
  }

  /** Defaults for new sessions (provider, model, max tokens, max turns). */
  setDefaults(d: Partial<RuntimeOptions['defaults']>): void {
    const next = { ...this.#opts.defaults, ...d };
    if (!this.#providers.has(next.providerId)) throw new Error(`unknown provider: ${next.providerId}`);
    this.#opts.defaults = next;
  }

  get defaults(): RuntimeOptions['defaults'] {
    return { ...this.#opts.defaults };
  }

  setLimits(providerId: string, limits: LimiterConfig): void {
    this.limiter(providerId).configure(limits);
  }

  /** Interface language for new sessions. */
  setLocale(locale: string): void {
    this.#opts.locale = locale;
  }

  /** Read the workflow files again (e.g. a new folder chosen in the settings). Returns the problems found. */
  reloadWorkflows(dir?: string): string[] {
    if (dir !== undefined) this.#opts.workflowsDir = dir;
    this.#workflows = loadWorkflows(this.#opts.workflowsDir, this.#opts.workflows ?? []);
    return [...this.#workflows.errors];
  }

  #removeSearch: (() => void) | undefined;

  /** Configure or remove (undefined) the web_search backend; the tool appears or disappears. */
  setSearch(backend: SearchBackend | undefined): void {
    this.#removeSearch?.();
    this.#removeSearch = undefined;
    if (backend) this.#removeSearch = this.tools.register(createWebSearchTool(backend), 'core');
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
    const sessionId = newId('ses');
    // a conversation of its own without a folder: its own folder in the app's data, not one under Documents
    const ownFolder = !req.cwd && !parent && !req.projectId ? this.ownFolder(sessionId) : undefined;
    if (ownFolder) mkdirSync(ownFolder, { recursive: true });
    const config: SessionConfig = {
      system: req.system ?? tpl?.system ?? d.system ?? DEFAULT_SYSTEM_PROMPT,
      providerId: req.providerId ?? tpl?.providerId ?? parent?.config.providerId ?? d.providerId,
      model: req.model ?? tpl?.model ?? (req.providerId || tpl?.providerId ? undefined : parent?.config.model) ?? d.model,
      maxTokens: req.maxTokens ?? d.maxTokens,
      cwd: req.cwd ?? parent?.config.cwd ?? ownFolder ?? this.#opts.cwd ?? process.cwd(),
      maxTurns: req.maxTurns ?? d.maxTurns ?? 50,
      locale: req.locale ?? parent?.config.locale ?? this.#opts.locale ?? 'zh-CN',
      serverWebSearch: false,
      // A sub-agent gets its parent's tool allow-list unless told otherwise.
      ...(tools ? { tools } : {}),
      ...(tpl ? { templateId: tpl.id } : {}),
      ...((req.projectId ?? parent?.config.projectId) ? { projectId: req.projectId ?? parent?.config.projectId } : {}),
      // sub-agents work under their parent's approval mode
      ...((req.approvalMode ?? parent?.config.approvalMode) === 'auto' ? { approvalMode: 'auto' as const } : {}),
    };
    const provider = this.provider(config.providerId); // fail fast
    config.serverWebSearch = (this.#opts.hostedWebSearch ?? true) && provider.capabilities.serverWebSearch;
    const record: SessionRecord = {
      id: sessionId,
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
    if (result.reason !== 'completed') return;
    if (!session.parentId) {
      if (session.info().projectId) this.#managerReport(session, result.text || '(finished without a written report)');
      return;
    }
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

  /** Who asked a project manager something (message_agent from an assistant conversation): its next report goes there. */
  readonly #askers = new Map<string, string>();

  /** An assistant conversation asked `targetId` (a session that is not its own sub-agent) to do something. */
  noteAsker(targetId: string, askerId: string): void {
    this.#askers.set(targetId, askerId);
  }

  /**
   * A project manager finished: the report goes into the project's activity,
   * and back to the conversation that asked, if one did; otherwise it counts
   * as an unread update of the project (the sidebar marks it; nothing pops up
   * in other conversations).
   */
  #managerReport(session: Session, report: string): void {
    this.#reports.set(session.id, report);
    const projectId = session.info().projectId!;
    this.logProjectActivity(session, 'manager.report', 'The project manager reported', session.info().title ?? undefined, report.slice(0, 500));
    const askerId = this.#askers.get(session.id);
    this.#askers.delete(session.id);
    const asker = askerId ? this.session(askerId) : undefined;
    if (asker) {
      this.store.appendRelay(this.#relayRecord(asker.id, session.id, 'report', report));
      this.events.emit({ sessionId: asker.id, parentChain: asker.parentChain }, { type: 'child.report', childId: session.id, summary: report.slice(0, 500) });
      asker.addNote('report', `[Report from project manager ${label(session)}]\n${report}`, { ...this.#noteMeta(session, 'report', report) });
      return;
    }
    const p = this.store.getProject(projectId);
    if (!p) return;
    const updated: ProjectInfo = { ...p, unread: (p.unread ?? 0) + 1, updatedAt: isoNow() };
    this.store.upsertProject(updated);
    this.events.emit(this.eventHost, { type: 'project.updated', project: updated });
  }

  /** The user looked at a project's updates: its unread count goes back to 0. */
  markProjectRead(projectId: string): ProjectInfo {
    const p = this.store.getProject(projectId);
    if (!p) throw new Error(`unknown project: ${projectId}`);
    if (!p.unread) return p;
    const updated: ProjectInfo = { ...p, unread: 0 };
    this.store.upsertProject(updated);
    this.events.emit(this.eventHost, { type: 'project.updated', project: updated });
    return updated;
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

  /**
   * The assistant conversation used most recently (created when there is none).
   * No conversation is special: every one outside a project is the assistant;
   * this is only where something without a conversation of its own goes.
   */
  top(): Session {
    return this.#existingTop() ?? this.createSession({ templateId: 'top' });
  }

  #existingTop(): Session | undefined {
    // the user's conversations only: not the mail-sorting thread or another background thread made from its own template
    const threads = this.sessions().filter((s) => {
      const info = s.info();
      return info.role === 'top' && s.parentId === null && !info.projectId && (info.templateId === undefined || info.templateId === 'top');
    });
    return threads.sort((a, b) => (a.info().updatedAt < b.info().updatedAt ? 1 : a.info().updatedAt > b.info().updatedAt ? -1 : 0))[0];
  }

  /**
   * Where runtime-wide events (settings, mail settings, projects) are sent:
   * the top-level thread when there is one, else '' — never creates it, since
   * that needs a configured model (a fresh install has none).
   */
  get eventHost(): { sessionId: string; parentChain: string[] } {
    return { sessionId: '', parentChain: [] };
  }

  get workflows(): ReadonlyMap<string, WorkflowDef> {
    return this.#workflows.workflows;
  }

  /** Problems found while loading workflow files (shown to the user by the UI). */
  get workflowErrors(): readonly string[] {
    return this.#workflows.errors;
  }

  /** `askerId`: the conversation that created it gets the manager's report on the brief. */
  createProject(req: CreateProjectRequest, opts: { askerId?: string } = {}): ProjectInfo {
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
    const id = newId('prj');
    // a standing session of its own: no conversation is its parent; any assistant conversation can talk to it
    const manager = this.createSession({ templateId: 'project-manager', title: name, cwd: folder, projectId: id });
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
    this.events.emit(this.eventHost, { type: 'project.created', project });
    if (opts.askerId) this.noteAsker(manager.id, opts.askerId);
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
    this.events.emit(this.eventHost, { type: 'project.updated', project: updated });
    return updated;
  }

  /**
   * A plugin's view calls one of that plugin's own tools (checked by the
   * source the tool was registered under). No model and no session history;
   * hooks still apply, and irreversible tools ask the user (confirm.request,
   * cause plugin_view). Calls of one plugin share a small limiter; MCP tools
   * leave their traceable record with initiator `view:<plugin>`.
   */
  async callPluginTool(
    pluginId: string,
    toolName: string,
    args: Record<string, unknown>,
    opts: { sessionId?: string; confirmed?: boolean } = {},
  ): Promise<PluginToolResult> {
    // the full name as registered (any of the plugin's servers), or the bare name under the plugin's prefix;
    // either way it must have been registered by this plugin
    const entries = this.tools.entries();
    const entry = [toolName, `${pluginId}__${toolName}`]
      .map((n) => entries.find((e) => e.tool.spec.name === n))
      .find((e) => e?.source === `plugin:${pluginId}`);
    if (!entry) throw new Error(`plugin ${pluginId} has no tool ${toolName}`);
    const name = entry.tool.spec.name;
    const session = opts.sessionId ? this.session(opts.sessionId) : undefined;
    if (opts.sessionId && !session) throw new Error(`unknown session: ${opts.sessionId}`);
    // no model is involved: use the default top-level thread if there is one, never create it (that needs a provider)
    const host = session ?? this.#existingTop();
    const now = isoNow();
    const cwd = host?.config.cwd ?? this.#opts.cwd ?? process.cwd();
    const hookSession: SessionInfo = host?.info() ?? {
      id: `view:${pluginId}`,
      parentId: null,
      parentChain: [],
      role: 'top',
      title: null,
      status: 'idle',
      providerId: '',
      model: '',
      cwd,
      costUsd: 0,
      createdAt: now,
      updatedAt: now,
    };
    const tool = entry.tool;
    const invalid = validateInput(tool.spec.inputSchema, args ?? {});
    if (invalid) return { content: `Invalid input for ${name}: ${invalid}.`, isError: true };
    const callId = newId('view');
    const { decision, input } = await this.hooks.beforeTool(
      { callId, name, input: args ?? {}, irreversible: !!tool.irreversible },
      { session: hookSession, runId: `view:${pluginId}`, turn: 0 },
    );
    if (decision.action === 'deny') return { content: `Blocked: ${decision.reason}`, isError: true };
    let confirmedBy: 'user' | 'view' | undefined;
    if (tool.irreversible || decision.action === 'confirm') {
      const reason = decision.action === 'confirm' && !decision.byDefault && decision.reason ? decision.reason : 'a plugin view asks to run an irreversible action';
      if (opts.confirmed === true) {
        confirmedBy = 'view'; // the view asked the user itself
      } else if (opts.confirmed === false) {
        return { content: reason, isError: true, needsConfirmation: true }; // the caller asks and comes back with confirmed: true
      } else {
        const ok = await this.#askView(host, callId, name, input, reason);
        if (!ok) return { content: 'The user declined this action.', isError: true, declined: true };
        confirmedBy = 'user';
      }
    }
    const lease = await this.#viewLimiter(pluginId).acquire();
    try {
      const r = await tool.execute((input ?? {}) as Record<string, unknown>, {
        sessionId: session?.id ?? '',
        parentChain: session?.parentChain ?? [],
        cwd,
        signal: AbortSignal.timeout(120_000),
        tracer: this.tracer,
        extractors: this.extractors,
        services: { runtime: this },
        callId,
        emit: () => {},
        initiator: `view:${pluginId}`,
        ...(confirmedBy ? { confirmedBy } : {}),
      });
      return { content: r.content, isError: !!r.isError };
    } catch (err) {
      return { content: `Tool failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    } finally {
      lease.release();
    }
  }

  /** Answer a confirmation a plugin view asked for. False when the id is not one of those. */
  resolveViewConfirm(callId: string, approved: boolean): boolean {
    const waiting = this.#viewConfirms.get(callId);
    if (!waiting) return false;
    waiting(approved);
    return true;
  }

  #askView(host: Session | undefined, callId: string, name: string, input: unknown, reason: string): Promise<boolean> {
    return this.askOutsideSession({ callId, name, input, reason, cause: 'plugin_view', ...(host ? { host } : {}) }).answer;
  }

  /**
   * Show a confirmation card that belongs to no conversation (a plugin view's
   * action, a settings change from a script). It goes out on `host` or the runtime
   * ('' session id); answered with confirm(anySessionId, callId, approved).
   * `userOnly`: Spica's MCP service may not answer it. Unanswered after 10 minutes: no.
   */
  askOutsideSession(card: {
    name: string;
    input: unknown;
    reason: string;
    cause: GuardCause;
    callId?: string;
    host?: Session;
    userOnly?: boolean;
  }): { callId: string; answer: Promise<boolean> } {
    const callId = card.callId ?? newId('ask');
    const where = { sessionId: card.host?.id ?? '', parentChain: card.host?.parentChain ?? [] };
    if (card.userOnly) this.#userOnly.add(callId);
    const answer = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), 10 * 60_000); // nobody answered: no
      timer.unref?.();
      const finish = (approved: boolean) => {
        clearTimeout(timer);
        this.#viewConfirms.delete(callId);
        this.#userOnly.delete(callId);
        this.events.emit(where, { type: 'confirm.resolved', callId, approved });
        resolve(approved);
      };
      this.#viewConfirms.set(callId, finish);
      this.events.emit(where, { type: 'confirm.request', callId, name: card.name, input: card.input, reason: card.reason, cause: card.cause });
    });
    return { callId, answer };
  }

  /** True for a confirmation only the window may answer (see askOutsideSession). */
  isUserOnlyConfirm(callId: string): boolean {
    return this.#userOnly.has(callId);
  }

  #viewLimiter(pluginId: string): RateLimiter {
    let l = this.#viewLimiters.get(pluginId);
    if (!l) this.#viewLimiters.set(pluginId, (l = new RateLimiter({ maxConcurrent: 4, requestsPerMinute: 120 })));
    return l;
  }

  /** Rename a project; its manager session takes the same title. */
  renameProject(projectId: string, name: string): ProjectInfo {
    const p = this.store.getProject(projectId);
    if (!p) throw new Error(`unknown project: ${projectId}`);
    const n = name.trim();
    if (!n) throw new Error('a project needs a name');
    const updated: ProjectInfo = { ...p, name: n, updatedAt: isoNow() };
    this.store.upsertProject(updated);
    this.session(p.managerSessionId)?.rename(n);
    this.events.emit(this.eventHost, { type: 'project.updated', project: updated });
    return updated;
  }

  /**
   * Remove a project from Spica: the project, its manager and every session
   * under it, its activity log and work objects. The folder and its files are
   * not touched. Running sessions are stopped first. Mail filed under it
   * becomes a "new matter" again, and sender memory pointing at it is
   * forgotten. Traceable records stay (spending history and limits).
   */
  async deleteProject(projectId: string): Promise<void> {
    const p = this.store.getProject(projectId);
    if (!p) throw new Error(`unknown project: ${projectId}`);
    const ids = this.#withDescendants(this.store.listSessions().filter((s) => s.id === p.managerSessionId || s.config.projectId === p.id).map((s) => s.id));
    await this.#stopAll(ids, 'project deleted');
    for (const m of this.store.listMail({ projectId: p.id, limit: 1_000_000 })) {
      const { routedTo: _r, ...rest } = m;
      void _r;
      const triage = m.triage ? (({ projectId: _p, ...t }) => (void _p, { ...t, decision: 'new' as const }))(m.triage) : undefined;
      this.store.upsertMail({ ...rest, status: m.status === 'ignored' ? 'ignored' : 'triaged', ...(triage ? { triage } : {}), updatedAt: isoNow() });
    }
    this.#drop(ids);
    this.store.deleteProject(p.id);
    this.events.emit(this.eventHost, { type: 'project.deleted', projectId: p.id });
  }

  /**
   * Delete a conversation and the sub-agents under it: their records (messages, tool calls, queued and pending items,
   * relays) and the copies of attached images. Files they made, in their working folder (also their own
   * sessions/<id>/files), stay. Running ones are stopped first. A project manager is deleted with its project only.
   * Traceable records stay (spending history and limits). A project manager this conversation was waiting on
   * reports to the project (an unread update) instead.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const rec = this.store.getSession(sessionId);
    if (!rec) throw new Error(`unknown session: ${sessionId}`);
    const project = this.store.listProjects().find((p) => p.managerSessionId === sessionId);
    if (project) throw new Error(`${sessionId} is the project manager of "${project.name}": delete the project instead`);
    const ids = this.#withDescendants([sessionId]);
    await this.#stopAll(ids, 'conversation deleted');
    this.#drop(ids);
  }

  /**
   * The user chooses the working folder of a conversation that had none (it worked in its own folder in the app
   * data), once. What it made there moves to the chosen folder, all or nothing (see moveFolderContents); its
   * sub-agents that worked there move along; each gets a note saying where the folder is now and where the files
   * went, so relative paths in earlier messages still hold. Refused while it or a sub-agent runs or waits for the user.
   */
  setSessionCwd(sessionId: string, folder: string): SetCwdResult {
    const s = this.session(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);
    if (!s.info().canChooseCwd) {
      return { ok: false, code: 'cwd.not_changeable', message: 'This conversation already has its working folder (chosen before, or part of a project).' };
    }
    const src = this.ownFolder(sessionId)!;
    const tree = [...this.#withDescendants([sessionId])].map((id) => this.session(id)).filter((x): x is Session => !!x);
    if (tree.some((x) => x.busy)) return { ok: false, code: 'cwd.busy', message: 'The conversation is running or waits for an answer; choose the folder when it is done.' };
    const dest = resolve(folder);
    if (!isAbsolute(folder)) return { ok: false, code: 'cwd.bad_folder', message: `Not an absolute path: ${folder}` };
    if (within(src, dest) || within(dest, src)) return { ok: false, code: 'cwd.bad_folder', message: `${dest} is the conversation's own folder or holds it.` };
    if (existsSync(dest) && !statSync(dest).isDirectory()) return { ok: false, code: 'cwd.bad_folder', message: `${dest} is a file, not a folder.` };
    const res = moveFolderContents(src, dest);
    if (!res.ok) {
      const left = res.notRestored.length ? ` Could not put back: ${res.notRestored.join(', ')} (still in ${dest}).` : '';
      return {
        ok: false,
        code: res.file ? 'cwd.move_failed' : 'cwd.bad_folder',
        message: res.file ? `Moving ${res.file} failed (${res.message}); everything else was put back.${left}` : `Cannot make ${dest}: ${res.message}`,
        ...(res.file ? { file: res.file } : {}),
        ...(res.notRestored.length ? { notRestored: res.notRestored } : {}),
      };
    }
    try {
      removeEmptyTree(src);
      rmdirSync(dirname(src)); // sessions/<id>, when nothing else is in it
    } catch {
      // left over folders do no harm
    }
    const change: CwdChangeMeta = { from: src, to: dest, moved: res.moved, renamed: res.renamed };
    const renamed = res.renamed.length
      ? ` Renamed because a file of that name was already there: ${res.renamed.slice(0, 20).map((r) => `${r.from} → ${r.to}`).join(', ')}${res.renamed.length > 20 ? `, and ${res.renamed.length - 20} more` : ''}.`
      : '';
    const what = res.moved.length
      ? `The ${res.moved.length} file${res.moved.length === 1 ? '' : 's'} made so far moved there from ${src}, at the same paths relative to the working folder.${renamed} ` +
        `Relative paths in earlier messages now point into ${dest}; paths that started with ${src} now start with ${dest}.`
      : 'Nothing had been made in the old folder.';
    for (const x of tree) {
      if (x.config.cwd !== src) continue;
      x.setCwd(dest);
      x.addNote('note', `[The user chose the working folder for this conversation: ${dest}. ${what}]`, { author: 'runtime', cwdChange: change });
    }
    return { ok: true, info: s.info(), moved: res.moved, renamed: res.renamed };
  }

  /** These sessions and every session under them. */
  #withDescendants(roots: string[]): Set<string> {
    const all = this.store.listSessions();
    const ids = new Set(roots);
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of all) {
        if (s.parentId && ids.has(s.parentId) && !ids.has(s.id)) {
          ids.add(s.id);
          grew = true;
        }
      }
    }
    return ids;
  }

  /** Stop what runs, children first so they do not report into a session about to go; wait up to 10 s each. */
  async #stopAll(ids: Set<string>, reason: string): Promise<void> {
    const live = [...ids].map((id) => this.session(id)).filter((s): s is Session => !!s);
    for (const s of [...live].reverse()) if (s.running) s.abort(reason);
    for (const s of live) {
      const t0 = Date.now();
      while (s.running && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Remove the sessions' records and attached-image copies (not their working folders), and tell the window. */
  #drop(ids: Set<string>): void {
    for (const id of ids) {
      const s = this.session(id);
      const parentChain = s?.parentChain ?? [];
      this.store.deleteSession(id);
      rmSync(this.mediaDir(id), { recursive: true, force: true }); // its attached images
      this.#sessions.delete(id);
      this.#reports.delete(id);
      for (const [pm, asker] of this.#askers) if (asker === id) this.#askers.delete(pm); // its answer goes to the project instead
      this.events.emit({ sessionId: id, parentChain }, { type: 'session.deleted' });
    }
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
    const entry: ProjectLogEntry = {
      id: newId('plog'),
      projectId,
      sessionId: session.id,
      at: isoNow(),
      action,
      ...(target ? { target: target.slice(0, 500) } : {}),
      ...(detail ? { detail: detail.slice(0, 500) } : {}),
      summary: summary.slice(0, 500),
    };
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
   * Run a registered tool directly (not through a model), e.g. the mail
   * pipeline calling a plugin's list tool. Hooks and confirmation do not
   * apply, so use it only for read-only tools.
   */
  async invokeTool(name: string, input: Record<string, unknown>, session?: Session): Promise<{ content: string; isError: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) return { content: `unknown tool ${name}`, isError: true };
    try {
      const r = await tool.execute(input, {
        sessionId: session?.id ?? 'runtime',
        parentChain: session?.parentChain ?? [],
        cwd: session?.config.cwd ?? this.#opts.cwd ?? process.cwd(),
        signal: AbortSignal.timeout(120_000),
        tracer: this.tracer,
        extractors: this.extractors,
        services: { runtime: this },
        callId: newId('call'),
        emit: () => {},
      });
      return { content: r.content, isError: !!r.isError };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
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
  /**
   * Register values to remove from exports and traceable records (keys, client
   * secrets, endpoint addresses; a URL also adds its host name). There is no
   * way to read them back, so extensions holding the runtime cannot get them.
   * Kept after a provider is removed: old records may still mention them.
   */
  addRedactions(values: readonly (string | undefined)[]): void {
    for (const v of values) {
      if (!v || v.length < 6) continue;
      this.#secrets.add(v);
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
        try {
          const host = new URL(v).host;
          if (host.length >= 6) this.#secrets.add(host);
        } catch {
          // not a URL after all
        }
      }
    }
  }

  /**
   * Usage log (JSON Lines) of sessions, messages, tool calls, traceable
   * records, relays, project activity and mail, filtered by project and time.
   * Model keys, endpoint addresses and key-looking strings are redacted.
   */
  /** Remove every registered secret value from a text (see addRedactions); reveals nothing. */
  redact(text: string): string {
    return redact(text, [...this.#secrets]);
  }

  exportUsageLog(filter: UsageLogFilter = {}): string {
    return exportUsageLog(this.store, filter, { secrets: [...this.#secrets] });
  }

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
    const lastContext = new Map<string, number>();
    for (const t of traces) {
      if (t.kind !== 'model' || !t.sessionId || t.status !== 'ok') continue;
      const kind = t.providerId ? this.#providers.get(t.providerId)?.kind : undefined;
      const cached = kind === 'anthropic' ? (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0) : 0;
      lastInput.set(t.sessionId, (t.inputTokens ?? 0) + cached);
      lastContext.set(t.sessionId, (t.inputTokens ?? 0) + cached + (t.outputTokens ?? 0));
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
      let record = status === rec.status ? rec : { ...rec, status, updatedAt: isoNow() };
      // older data: a project manager was a child of the default conversation; now it stands on its own (same id)
      if (record.role === 'manager' && record.config.projectId && record.parentId) record = { ...record, parentId: null };
      if (record !== rec) this.store.upsertSession(record);
      const messages = this.store.listMessages(rec.id).map((m) => {
        if (m.meta?.partial !== true || m.meta.interrupted === true) return m;
        const fixed = { ...m, meta: { ...m.meta, interrupted: true } };
        this.store.updateMessage(fixed); // a stream cut off by the crash
        return fixed;
      });
      const s = new Session(this, record, messages, {
        lastInputTokens: lastInput.get(rec.id) ?? 0,
        ...(lastContext.has(rec.id) ? { contextTokens: lastContext.get(rec.id)! } : {}),
      });
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
    // a plugin allowed to use the user's models: its sampling requests are answered here
    const grant = config.sampling;
    const withSampling = grant ? { ...config, onSampling: (p: unknown, signal: AbortSignal) => this.sampler.createMessage(grant, p, signal) } : config;
    const h = await connectMcp(this.tools, this.tracer, withSampling, opts);
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
    this.mail.stop();
    await Promise.all([...this.#sessions.values()].map((s) => s.shutdown()));
    await Promise.all([...this.#mcp.values()].map((m) => m.disconnect()));
    this.store.close();
  }
}
