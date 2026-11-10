// Mail pipeline: new mail from mail-type plugins is triaged into projects and
// handed to the project manager. The core knows only "mail sources" (plugin
// tool names + field mapping), never a particular mail system.
import { isoNow } from './events.ts';
import type { Runtime } from './runtime.ts';
import type { Session } from './session.ts';
import type { Tool } from './tools/types.ts';
import type { GuardNote, MailFeedback, MailItem, MailPollResult, MailTriage } from './types.ts';
import { fence } from './guard.ts';

export interface MailSource {
  id: string;
  /** Plugin tool that lists messages (e.g. outlook__list_messages). */
  listTool: string;
  /** Plugin tool that reads one message (given to the triage thread and the managers). */
  readTool: string;
  /** Default { unread_only: true, limit: 50 }. */
  listArgs?: Record<string, unknown>;
  /** Field names in the list result. Defaults: id, from_name, from_address, subject, received, preview; array under `messages`. */
  fields?: { list?: string; id?: string; fromName?: string; fromAddress?: string; subject?: string; received?: string; preview?: string };
}

export interface MailConfig {
  /** Off unless the user turns it on: polling sends mail content to a model. */
  enabled?: boolean;
  /** Default 5. */
  intervalMinutes?: number;
  /** Mails per triage batch. Default 20. */
  batchSize?: number;
  sources?: MailSource[];
  /** Role template of the triage thread. Default 'mail-triage'. */
  triageTemplateId?: string;
  /** Extra sorting rules for the triage agent (deployment or plugin supplied). */
  rules?: string;
  /**
   * Mail ignored without asking the model. Each entry is a case-insensitive
   * substring, or a regular expression written as /pattern/flags.
   */
  ignore?: { from?: string[]; subject?: string[] };
}

/** Does `text` match one rule entry (substring, or /regex/flags)? */
export function matchesRule(text: string, rule: string): boolean {
  const re = /^\/(.+)\/([a-z]*)$/.exec(rule);
  if (re) {
    try {
      return new RegExp(re[1]!, re[2]!.includes('i') ? re[2] : `${re[2]}i`).test(text);
    } catch {
      return false;
    }
  }
  return text.toLowerCase().includes(rule.toLowerCase());
}

const DEFAULT_FIELDS = { list: 'messages', id: 'id', fromName: 'from_name', fromAddress: 'from_address', subject: 'subject', received: 'received', preview: 'preview' };

/** Parse a tool result: optional "[...]" hint lines, then JSON. */
export function parseToolJson(content: string): unknown {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => /^\s*[[{]/.test(l) && !/^\s*\[[^\]"{]*\]\s*$/.test(l));
  return JSON.parse(lines.slice(start < 0 ? 0 : start).join('\n'));
}

export class MailPipeline {
  readonly #rt: Runtime;
  #cfg: MailConfig;
  readonly #sources: MailSource[];
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling: Promise<MailPollResult> | undefined;
  /** Mail ids of the batch the triage thread is working on. */
  #batch = new Set<string>();

  constructor(rt: Runtime, cfg: MailConfig = {}) {
    this.#rt = rt;
    this.#cfg = cfg;
    this.#sources = [...(cfg.sources ?? [])];
  }

  /** Plugins (attachBackend) or the host can add sources at runtime. */
  addSource(src: MailSource): () => void {
    this.#sources.push(src);
    return () => {
      const i = this.#sources.indexOf(src);
      if (i >= 0) this.#sources.splice(i, 1);
    };
  }

  /** Sources whose tools are currently registered (plugin installed and enabled). */
  get activeSources(): MailSource[] {
    return this.#sources.filter((s) => this.#rt.tools.get(s.listTool));
  }

  /** Start polling on the interval (and once right away). Returns false unless the user turned mail on. */
  start(): boolean {
    if (this.#cfg.enabled !== true || this.#timer) return false;
    const minutes = this.#cfg.intervalMinutes ?? 5;
    const tick = () => void this.poll().catch(() => undefined);
    this.#timer = setInterval(tick, minutes * 60_000);
    this.#timer.unref?.();
    setTimeout(tick, 0).unref?.();
    return true;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Polling on its interval right now. */
  get running(): boolean {
    return this.#timer !== undefined;
  }

  /** Current settings (sources are listed separately in activeSources). */
  get settings(): Omit<MailConfig, 'sources'> & { enabled: boolean; triageModel: { providerId: string; model: string } } {
    const { sources: _s, ...rest } = this.#cfg;
    void _s;
    return { ...rest, enabled: this.#cfg.enabled === true, triageModel: this.triageModel };
  }

  /**
   * The model the sorting sends mail content to (the triage template's model,
   * else the defaults). Project managers then read their mail with their own
   * model. The settings page names it when the user turns mail on.
   */
  get triageModel(): { providerId: string; model: string } {
    const tpl = this.#rt.template(this.#cfg.triageTemplateId ?? 'mail-triage');
    const d = this.#rt.defaults;
    return { providerId: tpl?.providerId ?? d.providerId, model: tpl?.model ?? d.model };
  }

  /**
   * Change settings without restarting the backend: a new interval reschedules
   * the timer, enabled:false stops polling, enabled:true starts it again.
   * Emits mail.configured.
   */
  configure(patch: Omit<MailConfig, 'sources'>): Omit<MailConfig, 'sources'> {
    const wasRunning = this.running;
    this.#cfg = { ...this.#cfg, ...patch };
    const shouldRun = this.#cfg.enabled === true && (wasRunning || patch.enabled === true);
    if (this.running && (!shouldRun || patch.intervalMinutes !== undefined)) this.stop();
    if (shouldRun && !this.running) this.start();
    const settings = this.settings;
    this.#rt.events.emit(this.#rt.eventHost, { type: 'mail.configured', settings, running: this.running });
    return settings;
  }

  /** Fetch new mail, triage it and route it. Concurrent calls share one run. */
  poll(): Promise<MailPollResult> {
    this.#polling ??= this.#poll().finally(() => (this.#polling = undefined));
    return this.#polling;
  }

  async #poll(): Promise<MailPollResult> {
    const result: MailPollResult = { fetched: 0, added: 0, triaged: 0, routed: 0 };
    const sources = this.activeSources;
    if (sources.length === 0) return result;
    const thread = this.thread();
    thread.setTools(this.#threadTools());
    for (const src of sources) {
      const f = { ...DEFAULT_FIELDS, ...src.fields };
      const out = await this.#rt.invokeTool(src.listTool, { unread_only: true, limit: 50, ...src.listArgs }, thread);
      if (out.isError) {
        this.#emit(thread, { type: 'error', message: `mail source ${src.id}: ${out.content.slice(0, 300)}` });
        continue;
      }
      let list: Record<string, unknown>[];
      try {
        const parsed = parseToolJson(out.content) as Record<string, unknown> | unknown[];
        list = (Array.isArray(parsed) ? parsed : (parsed[f.list] as unknown[] | undefined) ?? []) as Record<string, unknown>[];
      } catch {
        this.#emit(thread, { type: 'error', message: `mail source ${src.id}: the list result is not JSON` });
        continue;
      }
      let added = 0;
      for (const m of list) {
        const messageId = String(m[f.id] ?? '');
        if (!messageId) continue;
        const id = `${src.id}:${messageId}`;
        if (this.#rt.store.getMail(id)) continue;
        const now = isoNow();
        const item: MailItem = {
          id,
          sourceId: src.id,
          messageId,
          subject: String(m[f.subject] ?? ''),
          ...(m[f.fromName] ? { fromName: String(m[f.fromName]) } : {}),
          ...(m[f.fromAddress] ? { fromAddress: String(m[f.fromAddress]) } : {}),
          ...(m[f.received] ? { receivedAt: String(m[f.received]) } : {}),
          ...(m[f.preview] ? { preview: String(m[f.preview]) } : {}),
          status: 'new',
          createdAt: now,
          updatedAt: now,
        };
        this.#rt.store.upsertMail(item);
        added++;
      }
      result.fetched += list.length;
      result.added += added;
      this.#emit(thread, { type: 'mail.polled', sourceId: src.id, fetched: list.length, added });
    }

    const waiting = this.#rt.store.listMail({ status: 'new' });
    // 1. Decided without asking the model: configured ignore rules, then what the
    //    user did with mail from the same sender before.
    const toModel: MailItem[] = [];
    const ign = this.#cfg.ignore ?? {};
    for (const item of waiting) {
      const from = `${item.fromName ?? ''} <${item.fromAddress ?? ''}>`;
      const rule = (ign.from ?? []).find((r) => matchesRule(from, r)) ?? (ign.subject ?? []).find((r) => matchesRule(item.subject, r));
      if (rule) {
        this.#setTriage(item, { decision: 'ignore', reason: `matches the ignore rule ${rule}`, confidence: 1, by: 'rule', at: isoNow() }, thread);
        result.triaged++;
        continue;
      }
      const known = item.fromAddress ? this.#rt.store.getSenderDecision(item.fromAddress) : undefined;
      if (known?.decision === 'project' && this.#rt.store.getProject(known.projectId)) {
        this.#setTriage(item, { decision: 'project', projectId: known.projectId, reason: 'same sender as an earlier mail you put in this project', confidence: 1, by: 'sender_memory', at: isoNow() }, thread);
        result.triaged++;
      } else if (known?.decision === 'ignore') {
        this.#setTriage(item, { decision: 'ignore', reason: 'you ignored mail from this sender before', confidence: 1, by: 'sender_memory', at: isoNow() }, thread);
        result.triaged++;
      } else {
        toModel.push(item);
      }
    }
    // 2. The rest goes to the triage agent, batch by batch.
    const size = this.#cfg.batchSize ?? 20;
    for (let i = 0; i < toModel.length; i += size) {
      const batch = toModel.slice(i, i + size);
      this.#batch = new Set(batch.map((b) => b.id));
      const msg = this.#batchMessage(batch);
      this.#flag(thread, msg.notes);
      await thread.send(msg.text, { author: 'runtime', kind: 'user', meta: { untrusted: msg.notes } }).done;
      // The agent answered without (complete) triage_mail results: ask once more, naming the mails.
      const open = batch.filter((m) => this.#rt.store.getMail(m.id)?.status === 'new').map((m) => m.id);
      if (open.length > 0) {
        await thread.send(`These mails still have no result. Call triage_mail now with a result for each: ${open.join(', ')}`, { author: 'runtime', kind: 'user' }).done;
      }
      this.#batch = new Set();
      result.triaged += batch.filter((b) => this.#rt.store.getMail(b.id)?.status !== 'new').length;
    }
    // 3. Hand mail that belongs to a project to its manager: one message per manager per poll.
    const toRoute = this.#rt.store.listMail({ status: 'triaged' }).filter((m) => m.triage?.decision === 'project' && !m.routedTo);
    result.routed = this.#route(toRoute, thread);
    return result;
  }

  /** The triage thread: a top-level thread with the mail-triage template. */
  thread(): Session {
    const tpl = this.#cfg.triageTemplateId ?? 'mail-triage';
    const existing = this.#rt.sessions().find((s) => s.parentId === null && s.info().templateId === tpl);
    if (existing) return existing;
    return this.#rt.createSession({ templateId: tpl, tools: this.#threadTools() });
  }

  /** The triage thread sees triage_mail, the project list and the read tools of the active sources. */
  #threadTools(): string[] {
    return ['triage_mail', 'list_projects', 'open_project', ...new Set(this.activeSources.map((s) => s.readTool))];
  }

  /** What came from the sender (name, address, subject, preview) is fenced as data; ids and our notes stay outside. */
  #fencedMail(m: MailItem, indent: string): { text: string; note: GuardNote } {
    const raw = [
      `from: ${m.fromName ?? ''} <${m.fromAddress ?? ''}>`,
      `subject: ${m.subject}`,
      m.receivedAt ? `received: ${m.receivedAt}` : '',
      m.preview ? `preview: ${m.preview}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const f = fence(raw, 'mail', `mail:${m.id}`, this.#rt.appName);
    return { text: f.text.replace(/^/gm, indent), note: f.note };
  }

  #flag(thread: Session, notes: GuardNote[]): void {
    for (const note of notes) if (note.signals.length) this.#emit(thread, { type: 'guard.flagged', note });
  }

  #batchMessage(batch: MailItem[]): { text: string; notes: GuardNote[] } {
    const notes: GuardNote[] = [];
    const projects = this.#rt.listProjects().filter((p) => p.status === 'active');
    const lines = [
      `New mail to sort (${batch.length}). Call triage_mail once with a result for every mail_id.`,
      '',
      'Projects:',
      ...(projects.length ? projects.map((p) => `- ${p.id}: ${p.name}${p.stage ? ` (stage ${p.stage})` : ''}`) : ['(no projects yet)']),
      '',
      'Mail:',
      ...batch.map((m) => {
        const d = m.fromAddress ? this.#rt.store.getSenderDecision(m.fromAddress) : undefined;
        const known = d?.decision === 'project' ? d.projectId : undefined;
        const f = this.#fencedMail(m, '  ');
        notes.push(f.note);
        return [
          `- mail_id: ${m.id}`,
          f.text,
          known ? `  note: mail from this sender was put in project ${known} before` : '',
        ]
          .filter(Boolean)
          .join('\n');
      }),
    ];
    if (this.#cfg.rules?.trim()) lines.push('', 'Additional sorting rules:', this.#cfg.rules.trim());
    return { text: lines.join('\n'), notes };
  }

  /** Called by the triage_mail tool. Returns problems for the model to fix (empty when all applied). */
  applyTriage(results: unknown[], thread: Session): string[] {
    const problems: string[] = [];
    for (const raw of results) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const item = this.#rt.store.getMail(String(r.mail_id ?? ''));
      if (!item) {
        problems.push(`unknown mail_id ${String(r.mail_id)}`);
        continue;
      }
      const decision = r.decision;
      if (decision !== 'project' && decision !== 'new' && decision !== 'ignore') {
        problems.push(`${item.id}: decision must be project, new or ignore`);
        continue;
      }
      const projectId = typeof r.project_id === 'string' ? r.project_id : undefined;
      if (decision === 'project' && (!projectId || !this.#rt.store.getProject(projectId))) {
        problems.push(`${item.id}: project_id ${String(projectId)} is not one of the listed projects`);
        continue;
      }
      const confidence = Math.min(1, Math.max(0, Number(r.confidence ?? 0.5) || 0));
      this.#setTriage(
        item,
        {
          decision,
          ...(decision === 'project' && projectId ? { projectId } : {}),
          ...(typeof r.suggestion === 'string' && r.suggestion ? { suggestion: r.suggestion } : {}),
          reason: String(r.reason ?? ''),
          confidence,
          by: 'model',
          at: isoNow(),
        },
        thread,
      );
    }
    // every mail of the current batch needs a result
    const missing = [...this.#batch].filter((id) => this.#rt.store.getMail(id)?.status === 'new');
    if (missing.length > 0) problems.push(`no result yet for: ${missing.join(', ')}`);
    return problems;
  }

  #setTriage(item: MailItem, triage: MailTriage, thread: Session): void {
    const updated: MailItem = { ...item, triage, status: triage.decision === 'ignore' ? 'ignored' : 'triaged', updatedAt: isoNow() };
    this.#rt.store.upsertMail(updated);
    this.#emit(thread, { type: 'mail.triaged', item: updated });
  }

  /** Send triaged mail to the project managers: one message per manager listing its new mail. Returns how many were routed. */
  #route(items: MailItem[], thread: Session): number {
    const byProject = new Map<string, MailItem[]>();
    for (const it of items) {
      const pid = it.triage?.projectId;
      if (!pid) continue;
      byProject.set(pid, [...(byProject.get(pid) ?? []), it]);
    }
    let routed = 0;
    for (const [pid, list] of byProject) {
      const project = this.#rt.store.getProject(pid);
      const manager = project && this.#rt.session(project.managerSessionId);
      if (!project || !manager) continue;
      const readTools = [...new Set(list.map((m) => this.#sources.find((s) => s.id === m.sourceId)?.readTool).filter(Boolean))];
      const notes: GuardNote[] = [];
      const text = [
        list.length === 1 ? 'New mail for this project.' : `${list.length} new mails for this project.`,
        '',
        ...list.map((m, k) => {
          const f = this.#fencedMail(m, '   ');
          notes.push(f.note);
          return [
            `${k + 1}. Mail id: ${m.messageId}`,
            f.text,
            // the triage agent's reason can quote the mail: fenced too
            m.triage?.reason ? `   Why it was put here: ${fence(m.triage.reason, 'mail', `triage:${m.id}`, this.#rt.appName).text}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        }),
        '',
        `Read the mails${readTools.length ? ` (with ${readTools.join(', ')})` : ''}, then give the user a few next steps with ` +
          "suggest_actions. If a reply is needed, write it only as a draft with the mail plugin's draft tool; never send mail. " +
          "Moving or marking mail follows the plugin's confirmation rules.",
        `Write to the user in ${manager.config.locale ?? 'zh-CN'}, including any short remark before you use tools.`,
      ].join('\n');
      this.#flag(manager, notes);
      manager.send(text, { author: 'parent', meta: { mails: list.map((m) => ({ id: m.id, sourceId: m.sourceId, messageId: m.messageId })), untrusted: notes } });
      for (const m of list) {
        const done: MailItem = { ...m, status: 'routed', routedTo: manager.id, updatedAt: isoNow() };
        this.#rt.store.upsertMail(done);
        this.#rt.logProjectActivity(manager, 'mail', `Mail received: ${m.subject}`, m.subject, m.id);
        this.#emit(thread, { type: 'mail.routed', item: done, managerSessionId: manager.id });
        routed++;
      }
    }
    return routed;
  }

  /** The user's handling of a mail; accept / reassign teach the sender memory. */
  feedback(mailId: string, fb: { action: MailFeedback['action']; projectId?: string }): MailItem {
    const item = this.#rt.store.getMail(mailId);
    if (!item) throw new Error(`unknown mail: ${mailId}`);
    const thread = this.thread();
    const feedback: MailFeedback = { action: fb.action, ...(fb.projectId ? { projectId: fb.projectId } : {}), at: isoNow() };
    let updated: MailItem = { ...item, feedback, updatedAt: isoNow() };
    if (fb.action === 'ignore') {
      updated = { ...updated, status: 'ignored' };
      if (item.fromAddress) this.#rt.store.setSenderDecision(item.fromAddress, { decision: 'ignore' });
    } else if (fb.action === 'accept') {
      if (item.fromAddress && item.triage?.decision === 'project' && item.triage.projectId) {
        this.#rt.store.setSenderDecision(item.fromAddress, { decision: 'project', projectId: item.triage.projectId });
      } else if (item.fromAddress && item.triage?.decision === 'ignore') {
        this.#rt.store.setSenderDecision(item.fromAddress, { decision: 'ignore' });
      }
    } else {
      if (!fb.projectId || !this.#rt.store.getProject(fb.projectId)) throw new Error('reassign needs an existing projectId');
      if (item.fromAddress) this.#rt.store.setSenderDecision(item.fromAddress, { decision: 'project', projectId: fb.projectId });
      updated = {
        ...updated,
        status: 'triaged',
        triage: { decision: 'project', projectId: fb.projectId, reason: 'put here by the user', confidence: 1, by: item.triage?.by ?? 'model', at: isoNow() },
      };
      delete updated.routedTo;
    }
    this.#rt.store.upsertMail(updated);
    this.#emit(thread, { type: 'mail.feedback', item: updated });
    if (fb.action === 'reassign') this.#route([updated], thread);
    return this.#rt.store.getMail(mailId)!;
  }

  #emit(thread: Session, body: Parameters<Runtime['events']['emit']>[1]): void {
    this.#rt.events.emit({ sessionId: thread.id, parentChain: [] }, body);
  }
}

/** The triage thread's only way to answer: structured results, validated by the core. */
export const triageMailTool: Tool = {
  spec: {
    name: 'triage_mail',
    description:
      'Record where each mail of the batch belongs. decision: "project" (give project_id from the list), "new" (a new matter; ' +
      'give a short suggestion such as a project name), or "ignore" (newsletters, notifications, spam, nothing to do). ' +
      'Give a short reason and a confidence between 0 and 1. Include every mail_id of the batch.',
    inputSchema: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              mail_id: { type: 'string' },
              decision: { type: 'string', enum: ['project', 'new', 'ignore'] },
              project_id: { type: 'string' },
              suggestion: { type: 'string' },
              reason: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['mail_id', 'decision', 'reason'],
          },
        },
      },
      required: ['results'],
    },
  },
  available: (env) => env.templateId === 'mail-triage',
  async execute(input, ctx) {
    const rt = ctx.services.runtime as Runtime;
    const thread = rt.session(ctx.sessionId);
    if (!thread) return { content: 'unknown session', isError: true };
    const results = Array.isArray(input.results) ? (input.results as unknown[]) : [];
    const problems = rt.mail.applyTriage(results, thread);
    const left = rt.store.listMail({ status: 'new' }).length;
    if (problems.length > 0) return { content: `Some results were not recorded:\n- ${problems.join('\n- ')}\nFix them and call triage_mail again for those mails.`, isError: true };
    return { content: `Recorded ${results.length} result(s).${left ? ` ${left} mail(s) are still waiting for a decision.` : ''}` };
  },
};
