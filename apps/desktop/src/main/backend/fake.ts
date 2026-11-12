// A scripted stand-in for @spica/core. It implements the same AgentApi and
// emits the same CoreEvent stream (docs/design/agent-core.md §4), so every
// screen can be built, tested and screenshotted before the real core exists.
// It never touches the network or the disk.
import type {
  AgentRole,
  ContentBlock,
  ContextBreakdown,
  CoreEvent,
  CoreEventBody,
  CreateProjectRequest,
  CreateSessionRequest,
  FileCardMeta,
  MailFeedback,
  MailItem,
  MailPollResult,
  MemoryCardMeta,
  MemoryItem,
  MemoryRefusal,
  MemoryTidyRun,
  Message,
  MessageKind,
  SourceCardMeta,
  PendingItem,
  ProjectDetail,
  ProjectInfo,
  RegenerateCode,
  RegenerateResult,
  RegenerateState,
  SendResult,
  SessionInfo,
  SessionStatus,
  SetCwdResult,
  SteerMode,
  ToolCategory,
} from '@spica/protocol';
import { REGENERATE_HINTS } from '@spica/protocol';
import type { AgentBackend } from './types';
import { buildSeed, fakeCard } from './fake-seed';
import { FAKE_PROJECTS, FakeMailbox } from './fake-mail';
import { isoAt } from './time';
import { FakeMemory, type MemoryPlan } from './fake-memory';

/** What the user typed in a message (its text blocks). */
function textOf(m: Message | undefined): string {
  return (m?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
}

export interface FakeBackendOptions {
  /** Multiplies every delay; 0 runs scripts instantly (tests). Default 1. */
  speed?: number;
  /** Start with the demo projects and history. Default true. */
  seed?: boolean;
  /** Clock, for deterministic screenshots and tests. */
  now?: () => Date;
  /** Like the core's: the folder all conversations shared up to 0.1.0-rc.2; ones there choose a folder once, their files stay. */
  legacyDefaultCwd?: string;
  /** Writes a picture a plugin tool would have returned and gives its path (the app's main process passes one). */
  demoImage?: () => string;
}

type Listener = (event: CoreEvent) => void;

interface Waiter {
  callId: string;
  resolve: (value: string) => void;
}

interface Run {
  controller: AbortController;
  steers: Message[];
  waiter?: Waiter;
}

class Aborted extends Error {}

/** Tools of the script that only read (a round that used only these can be regenerated, as in the core). */
const READ_ONLY_TOOLS = new Set(['list_dir', 'read_file', 'glob', 'grep', 'web_fetch', 'web_search', 'ask_user', 'suggest_actions']);
const ANSWER_KINDS = new Set<MessageKind>(['assistant', 'tool_results', 'steer']);

/** What the demo's web search finds (the answer cites the second). */
export const FAKE_SEARCH_RESULTS = [
  { url: 'https://example.com/mold/basics', title: '注塑模具成本由哪些部分组成', snippet: '模具成本主要包括模具钢、加工工时、热流道和试模费用……', published: '2026-09-02' },
  { url: 'https://example.org/steel-2026', title: '2026 年模具钢价格走势', snippet: '受原料影响，今年模具钢价格较去年上涨约 8%……', published: '2026-10-15' },
  { url: 'https://example.net/forum/quote', title: null, snippet: '论坛讨论：外壳模具报价差别为什么这么大' },
  { url: 'https://example.com/mold/lead-time', title: '模具交期怎么估', snippet: '交期取决于结构复杂度与排产……' },
];

/** The 流程 answer: a mermaid flowchart and an HTML page. */
export const FAKE_FLOW_ANSWER =
  '评审流程如下：\n\n' +
  '```mermaid\nflowchart LR\n  A[收齐报价] --> B{价格达标?}\n  B -- 是 --> C[样机评审]\n  B -- 否 --> D[重新议价]\n  D --> A\n  C --> E[下单]\n```\n\n' +
  '通知页面的草稿：\n\n' +
  '```html\n<!doctype html>\n<title>样机评审通知</title>\n<h2 style="font-family:sans-serif">样机评审通知</h2>\n<p style="font-family:sans-serif">时间：周四 14:00<br>地点：三楼会议室</p>\n<script>alert(1)</script>\n```';

/** A long command for the confirmation demo: what it really does is at its end. */
export const FAKE_LONG_COMMAND =
  "Get-ChildItem 'D:\\工作\\样机评审\\报价' -Filter *.xlsx | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Sort-Object LastWriteTime | Select-Object -First 50 | ForEach-Object { $_.FullName }; Remove-Item 'D:\\工作\\样机评审' -Recurse -Force";

/** The kind of each step the demo takes (the core says it on tool.start). */
const FAKE_CATEGORY: Partial<Record<string, ToolCategory>> = { list_dir: 'read', read_file: 'read', write_file: 'write', run_command: 'command', present_files: 'present' };

/** What the 汇总 answer's command leaves behind: one file it changed, then new ones. */
export const FAKE_EXPORT_FILES = ['D:\\工作\\样机评审\\报价\\索引.csv', ...['华东精密', '启明电子', '远航塑胶', '恒信五金', '东方模具', '新锐包装', '海联物流'].map((n) => `D:\\工作\\样机评审\\报价\\${n}.csv`)];

/** The file the 汇总 answer writes, and the answer: paths in inline code, a table and a code block. */
export const FAKE_SUMMARY_FILE = 'D:\\工作\\样机评审\\报价汇总.xlsx';
export const FAKE_SUMMARY_ANSWER =
  '已汇总到 `D:\\工作\\样机评审\\报价汇总.xlsx`，原始报价在 `D:\\工作\\样机评审\\报价\\`。\n\n' +
  '| 供应商 | 单价（元） | 交期 | 状态 |\n' +
  '|---|---|---|---|\n' +
  '| 华东精密 | 128.50 | 12 天 | 已回价 |\n' +
  '| 启明电子 | 131.00 | 10 天 | 已回价 |\n' +
  '| 远航塑胶 | — | — | 未回价 |\n' +
  '| 恒信五金 | — | — | 未回价 |\n\n' +
  '重新生成汇总表：\n\n' +
  '```powershell\n' +
  "$files = Get-ChildItem 'D:\\工作\\样机评审\\报价' -Filter *.xlsx\n" +
  "$rows = $files | ForEach-Object { Import-Excel $_.FullName }\n" +
  "$rows | Export-Excel 'D:\\工作\\样机评审\\报价汇总.xlsx' -AutoSize\n" +
  '```\n\n' +
  '远航塑胶和恒信五金还没回价，`单价` 列先留空。';

/** The BOM answer: files deep in a temporary folder, written as full paths (inline code, and once as plain text). */
const FAKE_BOM_DIR = 'C:\\Users\\Demo\\AppData\\Local\\Temp\\claude\\6b0adec76d142027\\97c9b4d3-10ad-4f09-864f-b53a275d8ee4\\scratchpad\\concurrent\\A';
export const FAKE_BOM_FILES = [`${FAKE_BOM_DIR}\\280040440007.pdf`, `${FAKE_BOM_DIR}\\280040440007_BOM.xlsx`];
export const FAKE_BOM_ANSWER =
  '图纸和物料清单都整理好了：\n\n' +
  `- 图纸：\`${FAKE_BOM_FILES[0]}\`\n` +
  `- 物料清单：\`${FAKE_BOM_FILES[1]}\`\n\n` +
  `都在 \`${FAKE_BOM_DIR}\\\` 里。\n\n` +
  '两版报价同名，放在不同文件夹：`D:\\工作\\样机评审\\第一版\\报价.xlsx` 和 `D:\\工作\\样机评审\\第二版\\报价.xlsx`。\n\n' +
  `不用代码格式写的路径：${FAKE_BOM_FILES[0]}`;

/** The 纪要 answer, for screenshots of the conversation's text: headings, a list, inline code and a code block. */
export const FAKE_MINUTES_ANSWER =
  '## 样机评审纪要\n\n' +
  '### 结论\n\n' +
  '1. **外壳尺寸** 定为 120×80×24 mm，比上一版薄 2 mm。\n' +
  '2. **续航** 实测 11.5 小时，高于 10 小时的要求。\n' +
  '3. **交付** 首批样机 20 台，月底前交付。\n\n' +
  '### 待办\n\n' +
  '- 跟进 `远航塑胶` 和 `恒信五金` 的报价\n' +
  '- 两家回价后更新汇总表\n\n' +
  '```text\n' +
  '负责人：采购部\n' +
  '截止：本周五\n' +
  '```';

/** Splits text into small chunks the way a model stream arrives. */
export function chunk(text: string, size = 3): string[] {
  const out: string[] = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

export class FakeBackend implements AgentBackend {
  readonly #speed: number;
  readonly #now: () => Date;
  readonly #legacyCwd: string | undefined;
  readonly #demoImage: (() => string) | undefined;
  /** What a call said about itself until its result is stored (see #takeCallMeta). */
  readonly #callInfo = new Map<string, { category?: ToolCategory; summary?: string; cards?: FileCardMeta[]; sources?: SourceCardMeta; memory?: MemoryCardMeta }>();
  #seq = 0;
  #ids = 0;
  #listeners = new Set<Listener>();
  #sessions = new Map<string, SessionInfo>();
  #messages = new Map<string, Message[]>();
  /** Answers a regenerate replaced (Message.superseded), per session. */
  #superseded = new Map<string, Message[]>();
  /** Confirmations the user declined: nothing ran. */
  #declined = new Set<string>();
  #pending = new Map<string, PendingItem[]>();
  #runs = new Map<string, Run>();
  #globalCost = 0;
  #projects = new Map<string, ProjectInfo>();
  readonly #mail: FakeMailbox;
  readonly #memory: FakeMemory;
  #tidying = false;

  constructor(options: FakeBackendOptions = {}) {
    this.#speed = options.speed ?? 1;
    this.#now = options.now ?? (() => new Date());
    this.#legacyCwd = options.legacyDefaultCwd;
    this.#demoImage = options.demoImage;
    this.#memory = new FakeMemory(
      () => isoAt(this.#now()),
      (sid, body) => this.#emit(sid, body),
    );
    this.#mail = new FakeMailbox(
      this.#now,
      (sid, body) => this.#emit(sid, body),
      (ms) => new Promise((r) => setTimeout(r, ms * this.#speed)),
      options.seed ?? true,
      () => [...this.#projects.values()],
    );
    if (options.seed ?? true) {
      const seed = buildSeed(this.#now());
      for (const s of seed.sessions) this.#sessions.set(s.id, { ...s, canChooseCwd: s.role === 'top' && !s.parentId && (!s.cwd || s.cwd === this.#legacyCwd) });
      for (const [id, list] of Object.entries(seed.messages)) this.#messages.set(id, list);
      for (const [id, list] of Object.entries(seed.pending)) this.#pending.set(id, list);
      this.#ids = 1000;
      for (const p of FAKE_PROJECTS) {
        const pm = this.#sessions.get(p.managerSessionId);
        if (!pm) continue;
        this.#projects.set(p.id, {
          id: p.id,
          name: p.name,
          folder: pm.cwd,
          managerSessionId: pm.id,
          workflowId: null,
          stage: null,
          status: 'active',
          createdAt: pm.createdAt,
          updatedAt: pm.updatedAt,
        });
      }
    }
    for (const s of this.#sessions.values()) s.regenerate = this.#regenerateState(s.id);
  }

  // ----- events -------------------------------------------------------------

  onEvent(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(sessionId: string, body: CoreEventBody): void {
    const session = this.#sessions.get(sessionId);
    const event = {
      ...body,
      seq: ++this.#seq,
      at: isoAt(this.#now()),
      sessionId,
      parentChain: session?.parentChain ?? [],
    } as CoreEvent;
    for (const l of this.#listeners) {
      try {
        l(event);
      } catch {
        // A broken consumer must not stop the script.
      }
    }
  }

  #id(prefix: string): string {
    return `${prefix}-${++this.#ids}`;
  }

  #setStatus(sessionId: string, status: SessionStatus, detail?: string): void {
    const s = this.#sessions.get(sessionId);
    if (!s) return;
    s.status = status;
    s.updatedAt = isoAt(this.#now());
    this.#emit(sessionId, detail ? { type: 'status', status, detail } : { type: 'status', status });
    this.#syncRegenerate(sessionId);
  }

  /** Like the core: session.updated whenever the regenerate button state changes. */
  #syncRegenerate(sessionId: string): void {
    const s = this.#sessions.get(sessionId);
    if (!s) return;
    const next = this.#regenerateState(sessionId);
    if (JSON.stringify(next) === JSON.stringify(s.regenerate)) return;
    s.regenerate = next;
    this.#emit(sessionId, { type: 'session.updated', info: structuredClone(s) });
  }

  #nextSeq(sessionId: string): number {
    const all = [...(this.#messages.get(sessionId) ?? []), ...(this.#superseded.get(sessionId) ?? [])];
    return all.reduce((n, m) => Math.max(n, m.seq), 0) + 1;
  }

  #lastRound(sessionId: string): { anchor: Message | undefined; answer: Message[] } {
    const list = this.#messages.get(sessionId) ?? [];
    let i = list.length - 1;
    while (i >= 0 && !(list[i]!.role === 'user' && list[i]!.kind === 'user')) i--;
    if (i < 0) return { anchor: undefined, answer: [] };
    return { anchor: list[i], answer: list.slice(i + 1).filter((m) => ANSWER_KINDS.has(m.kind)) };
  }

  #regenerateState(sessionId: string): RegenerateState {
    const s = this.#sessions.get(sessionId);
    const { anchor, answer } = this.#lastRound(sessionId);
    const anchorId = anchor?.id ?? null;
    const no = (code: RegenerateCode): RegenerateState => ({ anchorId, ok: false, code, hint: REGENERATE_HINTS[code] });
    if (!s || s.role !== 'top' || s.parentId || s.projectId || (s.templateId && s.templateId !== 'top')) return no('regenerate.role');
    if (!anchor) return no('regenerate.no_turn');
    // the script keeps its run open while it waits; the core has ended the run by then (so: waiting first)
    if ((this.#pending.get(sessionId) ?? []).length > 0) return no('regenerate.waiting');
    if (this.#runs.has(sessionId)) return no('regenerate.running');
    if ((anchor.meta?.author ?? 'user') !== 'user') return no('regenerate.not_typed');
    let files = false;
    let agents = false;
    let other = false;
    for (const m of answer) {
      for (const b of m.content) {
        if (b.type !== 'tool_use' || READ_ONLY_TOOLS.has(b.name) || this.#declined.has(b.id)) continue;
        if (b.name === 'write_file' || b.name === 'edit_file') files = true;
        else if (b.name === 'spawn_agent' || b.name === 'message_agent') agents = true;
        else other = true;
      }
    }
    if (files) return no('regenerate.wrote_files');
    if (agents) return no('regenerate.spawned');
    if (other) return no('regenerate.acted');
    return { anchorId, ok: true };
  }

  #append(sessionId: string, role: 'user' | 'assistant', kind: MessageKind, content: ContentBlock[], meta?: Record<string, unknown>): Message {
    const list = this.#messages.get(sessionId) ?? [];
    const message: Message = {
      id: this.#id('m'),
      sessionId,
      seq: this.#nextSeq(sessionId),
      role,
      kind,
      content,
      createdAt: isoAt(this.#now()),
      ...(meta ? { meta } : {}),
    };
    list.push(message);
    this.#messages.set(sessionId, list);
    this.#emit(sessionId, { type: 'message', message });
    return message;
  }

  // ----- AgentApi -----------------------------------------------------------

  async createSession(req: CreateSessionRequest): Promise<SessionInfo> {
    const parent = req.parentId ? this.#sessions.get(req.parentId) : undefined;
    const at = isoAt(this.#now());
    const role: AgentRole = req.role ?? (parent ? 'worker' : 'top');
    const info: SessionInfo = {
      id: this.#id('s'),
      parentId: parent?.id ?? null,
      parentChain: parent ? [parent.id, ...parent.parentChain] : [],
      role,
      title: req.title ?? null,
      status: 'idle',
      providerId: req.providerId ?? 'fake',
      model: req.model ?? 'deepseek-flash',
      cwd: req.cwd ?? parent?.cwd ?? '',
      costUsd: 0,
      approvalMode: req.approvalMode ?? parent?.approvalMode ?? 'manual',
      contextTokens: null,
      contextWindow: null,
      createdAt: at,
      updatedAt: at,
      canChooseCwd: role === 'top' && !parent && !req.projectId && (!req.cwd || req.cwd === this.#legacyCwd),
      ...(req.templateId ? { templateId: req.templateId } : {}),
      ...(req.projectId ? { projectId: req.projectId } : {}),
    };
    this.#sessions.set(info.id, info);
    this.#messages.set(info.id, []);
    info.regenerate = this.#regenerateState(info.id);
    if (parent) this.#emit(parent.id, { type: 'child.spawned', childId: info.id, title: info.title });
    return structuredClone(info);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.#sessions.values()].map((s) => structuredClone(s));
  }

  async getSession(sessionId: string): Promise<SessionInfo | undefined> {
    const s = this.#sessions.get(sessionId);
    return s ? structuredClone(s) : undefined;
  }

  async getMessages(sessionId: string, opts?: { superseded?: boolean }): Promise<Message[]> {
    const current = this.#messages.get(sessionId) ?? [];
    if (!opts?.superseded) return structuredClone(current);
    return structuredClone([...current, ...(this.#superseded.get(sessionId) ?? [])].sort((a, b) => a.seq - b.seq));
  }

  /** As the core: the last round's answer becomes an old version and the same question is answered again. */
  async regenerate(sessionId: string, messageId?: string): Promise<RegenerateResult> {
    this.#requireSession(sessionId);
    const refuse = (code: RegenerateCode): RegenerateResult => ({ ok: false, code, hint: REGENERATE_HINTS[code] });
    const state = this.#regenerateState(sessionId);
    const { anchor, answer } = this.#lastRound(sessionId);
    if (state.code === 'regenerate.role') return refuse(state.code);
    if (messageId !== undefined && messageId !== anchor?.id && !answer.some((m) => m.id === messageId)) return refuse('regenerate.not_last');
    if (!state.ok || !anchor) return refuse(state.code ?? 'regenerate.no_turn');
    const old = this.#superseded.get(sessionId) ?? [];
    const version = old.filter((m) => m.superseded?.of === anchor.id).reduce((n, m) => Math.max(n, m.superseded!.version), 0) + 1;
    if (answer.length > 0) {
      const mark = { at: isoAt(this.#now()), of: anchor.id, version };
      const gone = new Set(answer.map((m) => m.id));
      this.#messages.set(sessionId, (this.#messages.get(sessionId) ?? []).filter((m) => !gone.has(m.id)));
      this.#superseded.set(sessionId, [...old, ...answer.map((m) => ({ ...m, superseded: mark }))].sort((a, b) => a.seq - b.seq));
      this.#emit(sessionId, { type: 'messages.superseded', anchorId: anchor.id, messageIds: [...gone], version });
    }
    const next = answer.length > 0 ? version + 1 : version;
    const text = anchor.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    void this.#run(sessionId, text, { version: next });
    return { ok: true, anchorId: anchor.id, version: next };
  }

  async getPending(sessionId: string): Promise<PendingItem[]> {
    return structuredClone(this.#pending.get(sessionId) ?? []);
  }

  async send(sessionId: string, text: string): Promise<SendResult> {
    this.#requireSession(sessionId);
    const run = this.#runs.get(sessionId);
    if (run) return this.steer(sessionId, text, 'next');
    const message = this.#append(sessionId, 'user', 'user', [{ type: 'text', text }], { author: 'user' });
    void this.#run(sessionId, text);
    return { messageId: message.id, started: true };
  }

  async steer(sessionId: string, text: string, mode: SteerMode): Promise<SendResult> {
    this.#requireSession(sessionId);
    const run = this.#runs.get(sessionId);
    if (!run) return this.send(sessionId, text);
    const message: Message = {
      id: this.#id('m'),
      sessionId,
      seq: 0,
      role: 'user',
      kind: 'steer',
      content: [{ type: 'text', text }],
      createdAt: isoAt(this.#now()),
      meta: { author: 'user' },
    };
    run.steers.push(message);
    this.#emit(sessionId, { type: 'steer.queued', messageId: message.id, mode });
    return { messageId: message.id, started: false };
  }

  async renameSession(sessionId: string, title: string | null): Promise<SessionInfo> {
    const s = this.#requireSession(sessionId);
    s.title = title?.trim() ? title.trim() : null; // a settings change is not use: updatedAt stays, as in the core
    this.#emit(sessionId, { type: 'session.renamed', title: s.title });
    return structuredClone(s);
  }

  async setSessionModel(sessionId: string, providerId: string, model: string): Promise<SessionInfo> {
    const s = this.#requireSession(sessionId);
    Object.assign(s, { providerId, model });
    this.#emit(sessionId, { type: 'session.updated', info: structuredClone(s) });
    return structuredClone(s);
  }

  async setApprovalMode(sessionId: string, mode: 'manual' | 'auto'): Promise<SessionInfo> {
    const s = this.#requireSession(sessionId);
    Object.assign(s, { approvalMode: mode });
    this.#emit(sessionId, { type: 'session.updated', info: structuredClone(s) });
    return structuredClone(s);
  }

  async resume(sessionId: string): Promise<void> {
    const s = this.#requireSession(sessionId);
    if (s.status !== 'interrupted' || this.#runs.has(sessionId)) return;
    void this.#run(sessionId, '', { resumeWith: '继续上次的' });
  }

  async answer(sessionId: string, callId: string, answer: string): Promise<void> {
    this.#resolvePending(sessionId, callId, answer);
    this.#emit(sessionId, { type: 'ask.resolved', callId, answer });
  }

  async confirm(sessionId: string, callId: string, approved: boolean): Promise<void> {
    if (!approved) this.#declined.add(callId);
    this.#resolvePending(sessionId, callId, approved ? 'yes' : 'no');
    this.#emit(sessionId, { type: 'confirm.resolved', callId, approved });
  }

  async abort(sessionId: string): Promise<void> {
    this.#runs.get(sessionId)?.controller.abort();
  }

  // Projects: the seed's two, plus any made with createProject.

  async getTopSession(): Promise<SessionInfo> {
    // Like the core: the first top-level session is the assistant's default thread; made on first call.
    const top = [...this.#sessions.values()].find((s) => s.role === 'top' && !s.parentId);
    return top ? structuredClone(top) : this.createSession({ role: 'top' });
  }

  /** Made-up parts for the card under the context ring, adding up to the conversation's context. */
  async contextBreakdown(sessionId: string): Promise<ContextBreakdown | null> {
    const s = this.#sessions.get(sessionId);
    if (!s) return null;
    const window = s.contextWindow ?? null;
    const total = s.contextTokens ?? 9_800;
    const measured = typeof s.contextTokens === 'number';
    const part = (share: number) => Math.round(total * share);
    const parts: ContextBreakdown['parts'] = measured
      ? [
          { key: 'system', tokens: part(0.245), estimated: true, children: [{ key: 'system.base', tokens: part(0.17) }, { key: 'system.rules', tokens: part(0.075) }] },
          { key: 'tools', tokens: part(0.103), estimated: true },
          {
            key: 'messages',
            tokens: total - part(0.245) - part(0.103),
            estimated: true,
            children: [
              { key: 'messages.user', tokens: part(0.11) },
              { key: 'messages.assistant', tokens: part(0.241) },
              { key: 'messages.tool_results', tokens: part(0.259) },
              { key: 'messages.notes', tokens: part(0.014) },
              { key: 'messages.images', tokens: total - part(0.245) - part(0.103) - part(0.11) - part(0.241) - part(0.259) - part(0.014) },
            ],
          },
        ]
      : [
          { key: 'system', tokens: part(0.704), estimated: true, children: [{ key: 'system.base', tokens: part(0.49) }, { key: 'system.rules', tokens: part(0.214) }] },
          { key: 'tools', tokens: total - part(0.704), estimated: true },
        ];
    const outputReserve = window ? Math.min(32_000, Math.round(window / 5)) : 0;
    return { window, total, measured, parts, outputReserve, free: window ? Math.max(0, window - total - outputReserve) : null };
  }

  async listProjects(): Promise<ProjectInfo[]> {
    return [...this.#projects.values()].map((p) => structuredClone(p));
  }

  async getProject(projectId: string): Promise<ProjectDetail | undefined> {
    const p = this.#projects.get(projectId);
    const manager = p ? this.#sessions.get(p.managerSessionId) : undefined;
    if (!p || !manager) return undefined;
    const agents = [...this.#sessions.values()].filter((s) => s.parentId === manager.id);
    return structuredClone({ ...p, workflow: null, objects: [], recentLog: [], manager, agents });
  }

  async renameProject(projectId: string, name: string): Promise<ProjectInfo> {
    const p = this.#projects.get(projectId);
    if (!p) throw new Error(`unknown project: ${projectId}`);
    const n = name.trim();
    if (!n) throw new Error('a project needs a name');
    Object.assign(p, { name: n, updatedAt: isoAt(this.#now()) });
    await this.renameSession(p.managerSessionId, n);
    this.#emit(p.managerSessionId, { type: 'project.updated', project: structuredClone(p) });
    return structuredClone(p);
  }

  async callPluginTool(pluginId: string, toolName: string): Promise<{ content: string; isError: boolean }> {
    return { content: `${pluginId}__${toolName} is not available in the fake backend`, isError: true };
  }

  async deleteProject(projectId: string): Promise<void> {
    const p = this.#projects.get(projectId);
    if (!p) throw new Error(`unknown project: ${projectId}`);
    const ids = new Set([p.managerSessionId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of this.#sessions.values()) {
        if (s.parentId && ids.has(s.parentId) && !ids.has(s.id)) {
          ids.add(s.id);
          grew = true;
        }
      }
    }
    for (const id of ids) {
      this.#runs.get(id)?.controller.abort();
      this.#emit(id, { type: 'session.deleted' });
      this.#sessions.delete(id);
      this.#messages.delete(id);
      this.#superseded.delete(id);
      this.#pending.delete(id);
    }
    this.#projects.delete(projectId);
    const top = [...this.#sessions.values()].find((s) => s.role === 'top' && !s.parentId);
    this.#emit(top?.id ?? '', { type: 'project.deleted', projectId });
  }

  /** Like the core, without files: a conversation that has none chooses its folder once, not while it runs. */
  async setSessionCwd(sessionId: string, folder: string): Promise<SetCwdResult> {
    const s = this.#requireSession(sessionId);
    if (!s.canChooseCwd) return { ok: false, code: 'cwd.not_changeable', message: 'This conversation already has its working folder.' };
    if (this.#runs.has(sessionId) || (this.#pending.get(sessionId)?.length ?? 0) > 0) {
      return { ok: false, code: 'cwd.busy', message: 'The conversation is running or waits for an answer.' };
    }
    if (!/^([A-Za-z]:[\\/]|\/)/.test(folder)) return { ok: false, code: 'cwd.bad_folder', message: `Not an absolute path: ${folder}` };
    const old = s.cwd;
    for (const x of this.#sessions.values()) {
      if (x.id !== sessionId && !x.parentChain.includes(sessionId)) continue;
      if (x.cwd !== old) continue;
      Object.assign(x, { cwd: folder, canChooseCwd: false });
      this.#emit(x.id, { type: 'session.updated', info: structuredClone(x) });
    }
    // the folder of older versions keeps its files (as in the core)
    return { ok: true, info: structuredClone(s), moved: [], renamed: [], ...(old && old === this.#legacyCwd ? { filesStayIn: old } : {}) };
  }

  /** Like the core: the conversation and its sub-agents go, a project manager only with its project. */
  setMemoryEnabled(on: boolean): void {
    this.#memory.enabled = on;
  }

  async listMemories(opts?: { all?: boolean }): Promise<MemoryItem[]> {
    return this.#memory.list(opts);
  }

  async addMemory(text: string): Promise<MemoryCardMeta | MemoryRefusal> {
    return this.#memory.addOwn(text);
  }

  async editMemory(id: number, text: string): Promise<MemoryCardMeta | MemoryRefusal | undefined> {
    return this.#memory.edit(id, text);
  }

  async forgetMemory(id: number): Promise<MemoryCardMeta | undefined> {
    return this.#memory.forget(id, 'user');
  }

  async clearMemories(): Promise<number> {
    return this.#memory.clear();
  }

  async undoMemory(id: number): Promise<MemoryCardMeta | undefined> {
    return this.#memory.undo(id);
  }

  async tidyMemories(): Promise<{ started: true; id: number } | { started: false; reason: 'running' | 'off' | 'no_model' }> {
    if (this.#tidying) return { started: false, reason: 'running' };
    if (!this.#memory.enabled) return { started: false, reason: 'off' };
    const id = (this.#memory.tidies(1)[0]?.id ?? 0) + 1;
    const at = isoAt(this.#now());
    this.#tidying = true;
    this.#emit('', { type: 'memory.tidy', run: { id, by: 'user', status: 'running', startedAt: at, sessions: 0, messages: 0, changes: [], refused: 0 } });
    // the core reads what the user typed in the assistant's conversations (not projects) and asks the model
    const typed = [...this.#sessions.values()]
      .filter((s) => s.role === 'top' && !s.projectId && !s.parentId)
      .flatMap((s) => (this.#messages.get(s.id) ?? []).filter((m) => m.role === 'user' && m.kind === 'user').map((m) => ({ sessionId: s.id, seq: m.seq, at: m.createdAt, text: textOf(m) })));
    setTimeout(() => {
      this.#tidying = false;
      const run = this.#memory.tidy(typed);
      if ('status' in run) this.#emit('', { type: 'memory.tidy', run });
    }, 1500 * this.#speed);
    return { started: true, id };
  }

  async listMemoryTidies(limit?: number): Promise<MemoryTidyRun[]> {
    return this.#memory.tidies(limit);
  }

  async undoMemoryTidy(id: number, change?: number): Promise<MemoryTidyRun | undefined> {
    const run = this.#memory.undoTidy(id, change);
    if (run) this.#emit('', { type: 'memory.tidy', run });
    return run;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.#requireSession(sessionId);
    const project = [...this.#projects.values()].find((p) => p.managerSessionId === sessionId);
    if (project) throw new Error(`${sessionId} is the project manager of "${project.name}": delete the project instead`);
    const ids = new Set([sessionId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of this.#sessions.values()) {
        if (s.parentId && ids.has(s.parentId) && !ids.has(s.id)) {
          ids.add(s.id);
          grew = true;
        }
      }
    }
    for (const id of ids) {
      this.#runs.get(id)?.controller.abort();
      this.#emit(id, { type: 'session.deleted' });
      this.#sessions.delete(id);
      this.#messages.delete(id);
      this.#superseded.delete(id);
      this.#pending.delete(id);
    }
  }

  async createProject(req: CreateProjectRequest): Promise<ProjectInfo> {
    const name = req.name.trim();
    if (!name) throw new Error('project name is required');
    const manager = await this.createSession({ role: 'manager', title: name, cwd: req.folder ?? `D:\\工作\\${name}` });
    const at = isoAt(this.#now());
    const project: ProjectInfo = {
      id: this.#id('p'),
      name,
      folder: manager.cwd,
      managerSessionId: manager.id,
      workflowId: req.workflowId ?? null,
      stage: null,
      status: 'active',
      createdAt: at,
      updatedAt: at,
    };
    const s = this.#sessions.get(manager.id);
    if (s) s.projectId = project.id;
    this.#projects.set(project.id, project);
    this.#emit(manager.id, { type: 'project.created', project: structuredClone(project) });
    if (req.brief) void this.send(manager.id, req.brief);
    return structuredClone(project);
  }

  async listMail(filter?: Parameters<NonNullable<AgentBackend['listMail']>>[0]): Promise<MailItem[]> {
    return this.#mail.list(filter);
  }

  pollMail(): Promise<MailPollResult> {
    return this.#mail.poll();
  }

  async mailFeedback(mailId: string, fb: { action: MailFeedback['action']; projectId?: string }): Promise<MailItem> {
    return this.#mail.feedback(mailId, fb);
  }

  async exportTraces(): Promise<string> {
    return '';
  }

  dispose(): void {
    for (const run of this.#runs.values()) run.controller.abort();
    this.#runs.clear();
    this.#listeners.clear();
  }

  // ----- script -------------------------------------------------------------

  #requireSession(sessionId: string): SessionInfo {
    const s = this.#sessions.get(sessionId);
    if (!s) throw new Error(`找不到这个会话（${sessionId}）`);
    return s;
  }

  #resolvePending(sessionId: string, callId: string, value: string): void {
    const list = this.#pending.get(sessionId) ?? [];
    this.#pending.set(
      sessionId,
      list.filter((p) => p.callId !== callId),
    );
    const run = this.#runs.get(sessionId);
    if (run?.waiter?.callId === callId) {
      const w = run.waiter;
      run.waiter = undefined;
      w.resolve(value);
    } else if (!run) {
      // Pending from history (e.g. after a restart): resume with a short follow-up.
      const s = this.#sessions.get(sessionId);
      if (s && (s.status === 'awaiting_answer' || s.status === 'awaiting_confirm')) {
        void this.#run(sessionId, '', { resumeWith: value });
      }
    }
  }

  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Aborted());
    const wait = ms * this.#speed;
    if (wait <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, wait);
      const onAbort = () => {
        clearTimeout(t);
        reject(new Aborted());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #waitFor(run: Run, callId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      run.waiter = { callId, resolve };
      run.controller.signal.addEventListener('abort', () => reject(new Aborted()), { once: true });
    });
  }

  async #stream(sessionId: string, kind: 'text' | 'thinking', text: string, signal: AbortSignal): Promise<void> {
    for (const piece of chunk(text, kind === 'thinking' ? 6 : 3)) {
      await this.#sleep(kind === 'thinking' ? 30 : 22, signal);
      this.#emit(sessionId, kind === 'text' ? { type: 'text.delta', delta: piece } : { type: 'thinking.delta', delta: piece });
    }
  }

  #applySteers(sessionId: string, run: Run): void {
    if (run.steers.length === 0) return;
    const list = this.#messages.get(sessionId) ?? [];
    const ids: string[] = [];
    for (const m of run.steers) {
      m.seq = this.#nextSeq(sessionId);
      list.push(m);
      ids.push(m.id);
      this.#emit(sessionId, { type: 'message', message: m });
    }
    run.steers = [];
    this.#emit(sessionId, { type: 'steer.applied', messageIds: ids });
  }

  /** One tool call; `fail`: it ends in an error with `result` as the error text. */
  /** `made`: what the call says about itself (its kind, and the cards of files it made), as the core does. */
  async #tool(sessionId: string, run: Run, name: string, input: unknown, result: string, ms: number, fail = false, made: { category?: ToolCategory; cards?: FileCardMeta[]; sources?: SourceCardMeta } = {}): Promise<ContentBlock[]> {
    const callId = this.#id('call');
    this.#emit(sessionId, { type: 'tool.call', callId, name });
    // As the core does: the kind of step, and the model's line on a command (its description argument).
    const category = made.category ?? FAKE_CATEGORY[name];
    const summary = name === 'run_command' ? (input as { description?: unknown }).description : undefined;
    this.#emit(sessionId, { type: 'tool.start', callId, name, input, ...(category ? { category } : {}), ...(typeof summary === 'string' && summary ? { summary } : {}) });
    this.#callInfo.set(callId, { ...(category ? { category } : {}), ...(typeof summary === 'string' && summary ? { summary } : {}), ...(made.cards?.length && !fail ? { cards: made.cards } : {}), ...(made.sources && !fail ? { sources: made.sources } : {}) });
    this.#setStatus(sessionId, 'tool', name);
    await this.#sleep(ms, run.controller.signal);
    const path = (input as { path?: unknown }).path;
    if (name === 'read_file' && typeof path === 'string' && !fail) this.#emit(sessionId, { type: 'file.card', callId, file: fakeCard(path, this.#now()) });
    const cards = made.cards ?? [];
    if (cards.length && !fail) this.#emit(sessionId, { type: 'file.card', callId, file: cards[0]!, ...(cards.length > 1 ? { files: cards } : {}) });
    if (made.sources && !fail) this.#emit(sessionId, { type: 'source.card', callId, card: made.sources });
    const content = fail ? result : `${isoAt(this.#now())}\n${result}`;
    this.#emit(sessionId, { type: 'tool.end', callId, name, isError: fail, preview: result.slice(0, 160), durationMs: ms });
    return [
      { type: 'tool_use', id: callId, name, input },
      { type: 'tool_result', toolUseId: callId, content, ...(fail ? { isError: true } : {}) },
    ];
  }

  /** remember / forget as the core runs them: the card goes out with the call id and is kept with the result. */
  #remember(sessionId: string, plan: MemoryPlan): ContentBlock[] {
    const callId = this.#id('call');
    const userSeq = [...(this.#messages.get(sessionId) ?? [])].reverse().find((m) => m.role === 'user' && m.kind === 'user')?.seq;
    const quote = textOf(this.#messages.get(sessionId)?.find((m) => m.seq === userSeq));
    const name = plan.action === 'forget' ? 'forget' : 'remember';
    const input = plan.action === 'forget' ? { id: plan.id, quote } : { text: plan.text, quote, ...(plan.action === 'replace' ? { replaces: plan.replaces } : {}) };
    this.#emit(sessionId, { type: 'tool.call', callId, name });
    this.#emit(sessionId, { type: 'tool.start', callId, name, input, category: 'other' });
    const card =
      plan.action === 'forget'
        ? this.#memory.forget(plan.id, 'assistant', true)
        : this.#memory.add({ text: plan.text, quote, by: 'assistant', sessionId, ...(userSeq !== undefined ? { seq: userSeq } : {}), ...(plan.action === 'replace' ? { replaces: plan.replaces } : {}) });
    if (card) this.#emit(sessionId, { type: 'memory.changed', callId, card });
    this.#callInfo.set(callId, { category: 'other', ...(card ? { memory: card } : {}) });
    const result = card?.item ? (card.action === 'forgotten' ? `Forgot [${card.item.id}].` : `Saved as [${card.item.id}].`) : 'Nothing changed.';
    this.#emit(sessionId, { type: 'tool.end', callId, name, isError: false, preview: result, durationMs: 20 });
    return [
      { type: 'tool_use', id: callId, name, input },
      { type: 'tool_result', toolUseId: callId, content: result },
    ];
  }

  #charge(sessionId: string, inputTokens: number, outputTokens: number): void {
    const costUsd = (inputTokens * 0.27 + outputTokens * 1.1) / 1_000_000;
    const s = this.#sessions.get(sessionId);
    if (s) s.costUsd += costUsd;
    this.#globalCost += costUsd;
    this.#emit(sessionId, { type: 'usage', usage: { inputTokens, outputTokens }, costUsd, providerId: 'fake', model: 'deepseek-flash' });
    this.#emit(sessionId, { type: 'cost', scope: 'session', spentUsd: s?.costUsd ?? costUsd, warning: false });
    this.#emit(sessionId, { type: 'cost', scope: 'global', spentUsd: this.#globalCost, limitUsd: 100, warning: false });
  }

  /** Commits one assistant message made of the blocks streamed so far. */
  #commitAssistant(sessionId: string, blocks: ContentBlock[]): void {
    const own = blocks.filter((b) => b.type !== 'tool_result');
    const results = blocks.filter((b) => b.type === 'tool_result');
    if (own.length) this.#append(sessionId, 'assistant', 'assistant', own);
    if (results.length) this.#append(sessionId, 'user', 'tool_results', results, { author: 'runtime', ...this.#takeCallMeta(results) });
    blocks.length = 0;
  }

  /** What the core stores with tool results so a reopened conversation looks the same: each call's kind and line, and its file cards. */
  #takeCallMeta(results: ContentBlock[]): Record<string, unknown> {
    const toolInfo: Record<string, { category: ToolCategory; summary?: string }> = {};
    const fileCards: Record<string, FileCardMeta> = {};
    const fileCardLists: Record<string, FileCardMeta[]> = {};
    const sourceCards: Record<string, SourceCardMeta> = {};
    const memoryCards: Record<string, MemoryCardMeta> = {};
    for (const r of results) {
      if (r.type !== 'tool_result') continue;
      const info = this.#callInfo.get(r.toolUseId);
      this.#callInfo.delete(r.toolUseId);
      if (!info) continue;
      if (info.category) toolInfo[r.toolUseId] = { category: info.category, ...(info.summary ? { summary: info.summary } : {}) };
      if (info.sources) sourceCards[r.toolUseId] = info.sources;
      if (info.memory) memoryCards[r.toolUseId] = info.memory;
      if (info.cards?.length) {
        fileCards[r.toolUseId] = info.cards[0]!;
        fileCardLists[r.toolUseId] = info.cards;
      }
    }
    return {
      ...(Object.keys(toolInfo).length ? { toolInfo } : {}),
      ...(Object.keys(fileCards).length ? { fileCards, fileCardLists } : {}),
      ...(Object.keys(sourceCards).length ? { sourceCards } : {}),
      ...(Object.keys(memoryCards).length ? { memoryCards } : {}),
    };
  }

  async #run(sessionId: string, text: string, opts: { resumeWith?: string; version?: number } = {}): Promise<void> {
    const run: Run = { controller: new AbortController(), steers: [] };
    this.#runs.set(sessionId, run);
    const signal = run.controller.signal;
    const blocks: ContentBlock[] = [];
    let turn = 0;
    try {
      this.#setStatus(sessionId, 'thinking');
      this.#emit(sessionId, { type: 'turn.start', turn: ++turn });

      if (opts.resumeWith !== undefined) {
        const reply = `好的，按「${opts.resumeWith}」继续。纪要初稿已经按这个口径整理好了。`;
        await this.#stream(sessionId, 'text', reply, signal);
        blocks.push({ type: 'text', text: reply });
        this.#commitAssistant(sessionId, blocks);
        this.#charge(sessionId, 1800, 120);
        this.#emit(sessionId, { type: 'turn.end', turn });
        this.#finish(sessionId, 'completed');
        return;
      }

      // 「记住…」「改用…」「…别记了」 in the assistant's own conversations: the memory line, then a short answer.
      const info = this.#sessions.get(sessionId);
      const plan = info && info.role === 'top' && !info.projectId ? this.#memory.plan(text) : undefined;
      if (plan) {
        await this.#sleep(400, signal);
        blocks.push(...this.#remember(sessionId, plan));
        this.#commitAssistant(sessionId, blocks);
        this.#emit(sessionId, { type: 'turn.end', turn });
        this.#emit(sessionId, { type: 'turn.start', turn: ++turn });
        const reply = plan.action === 'forget' ? '好的，这条已经删掉了。' : plan.action === 'replace' ? '好的，已经按新的改过来了。' : '好的，记住了。';
        await this.#stream(sessionId, 'text', reply, signal);
        blocks.push({ type: 'text', text: reply });
        this.#commitAssistant(sessionId, blocks);
        this.#charge(sessionId, 1800, 60);
        this.#emit(sessionId, { type: 'turn.end', turn });
        this.#finish(sessionId, 'completed');
        return;
      }

      const thinking = `用户说「${text.slice(0, 40)}」。先看一眼工作文件夹里有什么，再决定怎么回答。`;
      await this.#sleep(400, signal);
      await this.#stream(sessionId, 'thinking', thinking, signal);
      blocks.push({ type: 'thinking', text: thinking });

      const intro = '我先看一下工作文件夹里的资料。';
      this.#setStatus(sessionId, 'thinking');
      await this.#stream(sessionId, 'text', intro, signal);
      blocks.push({ type: 'text', text: intro });

      // For screenshots of tools at work: 「慢」 makes each call take 4 s, 「失败」 makes reading the file fail.
      const slow = /慢/.test(text);
      const fails = /失败/.test(text);
      blocks.push(
        ...(await this.#tool(sessionId, run, 'list_dir', { path: '.' }, '会议记录/\n报价单.xlsx\n测试报告.pdf\n需求说明.docx', slow ? 4000 : 500)),
      );
      blocks.push(
        ...(await this.#tool(
          sessionId,
          run,
          'read_file',
          { path: '需求说明.docx' },
          fails ? '[FILE_LOCKED] 文件正被其他程序占用，无法读取。' : '需求说明 v3：外壳尺寸 120×80×24 mm；续航不少于 10 小时；首批样机 20 台，月底前交付。',
          slow ? 4000 : 700,
          fails,
        )),
      );
      this.#commitAssistant(sessionId, blocks);
      this.#charge(sessionId, 2400, 180);
      this.#emit(sessionId, { type: 'turn.end', turn });
      this.#applySteers(sessionId, run);

      this.#emit(sessionId, { type: 'turn.start', turn: ++turn });
      this.#setStatus(sessionId, 'thinking');
      await this.#sleep(300, signal);

      if (/画个图/.test(text)) {
        // A plugin tool that returns a picture: as the core does, it is saved and handed over as a card (produced).
        const path = this.#demoImage?.() ?? 'D:\\工作\\样机评审\\报价对比图.png';
        const at = isoAt(this.#now());
        const picture: FileCardMeta = { path, name: path.split(/[\\/]/).pop() ?? path, kind: 'other', sizeBytes: 4096, modifiedAt: at, extractedAt: at, read: {}, origin: 'produced' };
        blocks.push(...(await this.#tool(sessionId, run, 'charts__render', { type: 'bar', title: '四家报价对比' }, '已生成 1 张图', 500, false, { category: 'plugin', cards: [picture] })));
        this.#setStatus(sessionId, 'thinking');
        const answer = '四家报价的对比图画好了。';
        await this.#stream(sessionId, 'text', answer, signal);
        blocks.push({ type: 'text', text: answer });
      } else if (/查一下/.test(text)) {
        // Looking things up on the web: a search (four results, the answer cites one) and a page it opened.
        const at = isoAt(this.#now());
        const search: SourceCardMeta = { tool: 'web_search', query: '注塑模具 报价 行情', sources: FAKE_SEARCH_RESULTS.map((r) => ({ ...r, fetchedAt: at })) };
        blocks.push(...(await this.#tool(sessionId, run, 'web_search', { query: '注塑模具 报价 行情' }, '找到 4 条结果', 500, false, { category: 'web', sources: search })));
        const page: SourceCardMeta = { tool: 'web_fetch', sources: [{ url: 'https://example.com/mold/price-guide', title: '模具报价指南：材料、结构与交期', fetchedAt: at }] };
        blocks.push(...(await this.#tool(sessionId, run, 'web_fetch', { url: 'https://example.com/mold/price-guide' }, '模具报价指南…', 500, false, { category: 'web', sources: page })));
        // A page it read but does not link in the answer: that one shows under 来源.
        const unlinked: SourceCardMeta = { tool: 'web_fetch', sources: [{ url: 'https://example.net/steel/index-2026', title: '2026 年模具钢价格指数', fetchedAt: at }] };
        blocks.push(...(await this.#tool(sessionId, run, 'web_fetch', { url: 'https://example.net/steel/index-2026' }, '模具钢价格指数…', 400, false, { category: 'web', sources: unlinked })));
        this.#setStatus(sessionId, 'thinking');
        const answer =
          '查到的行情：中等复杂度的外壳模具一般在 3 万到 6 万元之间，交期 25 到 40 天（[模具报价指南](https://example.com/mold/price-guide)）。' +
          '今年钢材涨价，报价普遍上调 5% 左右（[2026 年模具钢价格走势](https://example.org/steel-2026)）。';
        await this.#stream(sessionId, 'text', answer, signal);
        blocks.push({ type: 'text', text: answer });
      } else if (/删除/.test(text)) {
        // A command that needs confirming, long enough that a cut title would hide its end (and the model's
        // description says something milder than what it does).
        const callId = this.#id('call');
        const input = { command: FAKE_LONG_COMMAND, description: '整理旧的报价文件' };
        const lead = '要清理旧报价，这条命令需要你确认。';
        await this.#stream(sessionId, 'text', lead, signal);
        blocks.push({ type: 'text', text: lead });
        this.#emit(sessionId, { type: 'tool.call', callId, name: 'run_command' });
        this.#emit(sessionId, { type: 'tool.start', callId, name: 'run_command', input, category: 'command', summary: input.description });
        this.#addPending(sessionId, { kind: 'confirm', callId, toolName: 'run_command', input, reason: '运行命令', createdAt: isoAt(this.#now()) });
        this.#emit(sessionId, { type: 'confirm.request', callId, name: 'run_command', input, reason: '运行命令' });
        this.#setStatus(sessionId, 'awaiting_confirm', 'run_command');
        const ok = (await this.#waitFor(run, callId)) === 'yes';
        this.#emit(sessionId, { type: 'tool.end', callId, name: 'run_command', isError: !ok, preview: ok ? '已删除' : '用户拒绝了这条命令', durationMs: 300 });
        blocks.push({ type: 'tool_use', id: callId, name: 'run_command', input }, { type: 'tool_result', toolUseId: callId, content: ok ? '已删除' : '用户拒绝了这条命令', isError: !ok });
        this.#setStatus(sessionId, 'thinking');
        const after = ok ? '\n\n旧报价已清理。' : '\n\n好的，没有运行。';
        await this.#stream(sessionId, 'text', after, signal);
        blocks.push({ type: 'text', text: after });
      } else if (/确认|发送|发给/.test(text)) {
        const callId = this.#id('call');
        const input = { to: '项目组', subject: '样机评审时间', body: '各位好，样机评审定在周四下午两点。' };
        const lead = '我拟好了一封通知，发出前需要你确认。';
        await this.#stream(sessionId, 'text', lead, signal);
        blocks.push({ type: 'text', text: lead });
        this.#emit(sessionId, { type: 'tool.call', callId, name: 'send_email' });
        this.#emit(sessionId, { type: 'tool.start', callId, name: 'send_email', input });
        this.#addPending(sessionId, { kind: 'confirm', callId, toolName: 'send_email', input, reason: '发送邮件给「项目组」', createdAt: isoAt(this.#now()) });
        this.#emit(sessionId, { type: 'confirm.request', callId, name: 'send_email', input, reason: '发送邮件给「项目组」' });
        this.#setStatus(sessionId, 'awaiting_confirm', 'send_email');
        const decision = await this.#waitFor(run, callId);
        const ok = decision === 'yes';
        this.#emit(sessionId, { type: 'tool.end', callId, name: 'send_email', isError: !ok, preview: ok ? '已发送' : '用户取消了发送', durationMs: 300 });
        blocks.push({ type: 'tool_use', id: callId, name: 'send_email', input }, { type: 'tool_result', toolUseId: callId, content: ok ? '已发送' : '用户取消了发送', isError: !ok });
        this.#setStatus(sessionId, 'thinking');
        const after = ok ? '\n\n邮件已经发出。' : '\n\n好的，这封邮件没有发。';
        await this.#stream(sessionId, 'text', after, signal);
        blocks.push({ type: 'text', text: after });
      } else if (/问|选/.test(text)) {
        const callId = this.#id('call');
        const question = '纪要按哪种口径写？';
        const options = ['只写结论', '结论加讨论过程', '按议题逐条写'];
        this.#addPending(sessionId, { kind: 'ask', callId, question, options, createdAt: isoAt(this.#now()) });
        this.#emit(sessionId, { type: 'ask.request', callId, question, options });
        this.#setStatus(sessionId, 'awaiting_answer');
        const answer = await this.#waitFor(run, callId);
        blocks.push({ type: 'tool_use', id: callId, name: 'ask_user', input: { question, options } }, { type: 'tool_result', toolUseId: callId, content: answer });
        this.#setStatus(sessionId, 'thinking');
        const after = `好，按「${answer}」来写。`;
        await this.#stream(sessionId, 'text', after, signal);
        blocks.push({ type: 'text', text: after });
      } else if (/流程/.test(text)) {
        // A flowchart and a small HTML page (with a script that must never run).
        await this.#stream(sessionId, 'text', FAKE_FLOW_ANSWER, signal);
        blocks.push({ type: 'text', text: FAKE_FLOW_ANSWER });
      } else if (/对比图/.test(text)) {
        // Pictures in an answer: a local one (the demo's chart), one on the web, and one on a network share (never loaded).
        const local = this.#demoImage?.() ?? 'D:\\工作\\样机评审\\报价对比图.png';
        const answer =
          '四家报价对比如下：\n\n' +
          `![四家报价对比](<${local}>)\n\n` +
          '网上找到的模具报价参考：\n\n' +
          '![模具报价参考](https://example.com/mold-quote.png)\n\n' +
          '共享盘里的旧图不显示：\n\n' +
          '![旧版报价图](<\\\\files\\proj\\old.png>)';
        await this.#stream(sessionId, 'text', answer, signal);
        blocks.push({ type: 'text', text: answer });
      } else if (/纪要/.test(text)) {
        await this.#stream(sessionId, 'text', FAKE_MINUTES_ANSWER, signal);
        blocks.push({ type: 'text', text: FAKE_MINUTES_ANSWER });
      } else if (/BOM/i.test(text)) {
        // Long full paths in an answer, with the cards of the same two files under it.
        const at = isoAt(this.#now());
        const cards = FAKE_BOM_FILES.map((path): FileCardMeta => ({ path, name: path.split('\\').pop() ?? path, kind: path.endsWith('.xlsx') ? 'xlsx' : 'other', sizeBytes: 2048, modifiedAt: at, extractedAt: at, read: {}, origin: 'created' }));
        blocks.push(...(await this.#tool(sessionId, run, 'present_files', { paths: FAKE_BOM_FILES }, '已交付 2 个文件', 200, false, { category: 'present', cards })));
        this.#setStatus(sessionId, 'thinking');
        await this.#stream(sessionId, 'text', FAKE_BOM_ANSWER, signal);
        blocks.push({ type: 'text', text: FAKE_BOM_ANSWER });
      } else if (/汇总/.test(text)) {
        // For screenshots of what an answer can hold: a file it wrote, paths, a table and a code block.
        const at = isoAt(this.#now());
        const made = (path: string, origin: 'created' | 'modified', lines?: { added: number; removed: number }): FileCardMeta => ({
          path,
          name: path.split('\\').pop() ?? path,
          kind: path.endsWith('.xlsx') ? 'xlsx' : path.endsWith('.csv') ? 'csv' : 'other',
          sizeBytes: 2048,
          modifiedAt: at,
          extractedAt: at,
          read: {},
          origin,
          ...(lines ? { lines } : {}),
        });
        blocks.push(...(await this.#tool(sessionId, run, 'write_file', { path: FAKE_SUMMARY_FILE }, '已写入 4 行', 600, false, { category: 'write', cards: [made(FAKE_SUMMARY_FILE, 'created', { added: 5, removed: 0 })] })));
        // A command that leaves several files behind (the core reports up to 20).
        const exports = FAKE_EXPORT_FILES.map((f, i) => made(f, i === 0 ? 'modified' : 'created'));
        blocks.push(...(await this.#tool(sessionId, run, 'run_command', { command: 'python 导出各家报价.py', description: '导出各家报价' }, '导出 8 个文件', 600, false, { category: 'command', cards: exports })));
        blocks.push(...(await this.#tool(sessionId, run, 'present_files', { paths: [FAKE_SUMMARY_FILE] }, '已交付 1 个文件', 200, false, { category: 'present', cards: [made(FAKE_SUMMARY_FILE, 'created')] })));
        this.#setStatus(sessionId, 'thinking');
        await this.#stream(sessionId, 'text', FAKE_SUMMARY_ANSWER, signal);
        blocks.push({ type: 'text', text: FAKE_SUMMARY_ANSWER });
      } else {
        const answer = (opts.version ?? 1) > 1
          ? `第 ${opts.version} 版：重新看了一遍，按优先级排：\n\n` +
            '1. **交付** 首批样机 20 台，月底前交付，是最紧的一项。\n' +
            '2. **续航** 实测 11.5 小时，高于 10 小时的要求。\n' +
            '3. **外壳尺寸** 120×80×24 mm，比上一版薄 2 mm。\n\n' +
            '另外报价单里有两家供应商还没回价。'
          : '看完了，要点如下：\n\n' +
          '1. **外壳尺寸** 定为 120×80×24 mm，和上一版相比薄了 2 mm。\n' +
          '2. **续航** 要求不少于 10 小时，测试报告里实测 11.5 小时，达标。\n' +
          '3. **交付** 首批样机 20 台，月底前交付，时间比较紧。\n\n' +
          '报价单里还有两家供应商没回价，建议今天跟进一下。';
        await this.#stream(sessionId, 'text', answer, signal);
        blocks.push({ type: 'text', text: answer });
        const suggest = {
          title: '接下来可以',
          actions: [
            { label: '起草催价邮件', prompt: '帮我起草一封催价邮件，发给还没回价的两家供应商' },
            { label: '把要点整理成纪要', prompt: '把这些要点整理成评审纪要' },
          ],
        };
        const suggestId = this.#id('call');
        this.#emit(sessionId, { type: 'suggest.actions', callId: suggestId, ...suggest });
        blocks.push({ type: 'tool_use', id: suggestId, name: 'suggest_actions', input: suggest }, { type: 'tool_result', toolUseId: suggestId, content: '已给出建议' });
      }
      this.#commitAssistant(sessionId, blocks);
      this.#charge(sessionId, 3100, 260);
      this.#emit(sessionId, { type: 'turn.end', turn });
      this.#applySteers(sessionId, run);
      this.#finish(sessionId, 'completed');
    } catch (err) {
      if (err instanceof Aborted || signal.aborted) {
        // Keep what was already streamed, marked as interrupted.
        if (blocks.length) {
          const own = blocks.filter((b) => b.type !== 'tool_result');
          if (own.length) this.#append(sessionId, 'assistant', 'assistant', own, { interrupted: true });
        }
        this.#pending.set(sessionId, []);
        this.#finish(sessionId, 'aborted');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.#emit(sessionId, { type: 'error', message });
        this.#finish(sessionId, 'error', message);
      }
    }
  }

  #addPending(sessionId: string, item: PendingItem): void {
    this.#pending.set(sessionId, [...(this.#pending.get(sessionId) ?? []), item]);
  }

  #finish(sessionId: string, reason: 'completed' | 'aborted' | 'error', detail?: string): void {
    this.#runs.delete(sessionId);
    const s = this.#sessions.get(sessionId);
    const status: SessionStatus =
      reason === 'completed' ? (s?.role === 'worker' ? 'done' : 'idle') : reason === 'aborted' ? 'aborted' : 'error';
    this.#setStatus(sessionId, status);
    this.#emit(sessionId, detail ? { type: 'run.end', reason, detail } : { type: 'run.end', reason });
  }
}
