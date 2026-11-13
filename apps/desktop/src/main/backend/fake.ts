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
  MemoryEntry,
  MemoryEntryInput,
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
  RequestRecord,
  SendResult,
  SessionInfo,
  SessionStatus,
  SetCwdResult,
  SteerMode,
  ToolCategory,
  UsageQuery,
  UsageSummary,
} from '@spica/protocol';
import { summarizeRequests } from '@spica/core/src/usage.ts';
import { usdText } from '@spica/core/src/money.ts';
import { fakeRequests } from './fake-usage';
import { AGENT_MESSAGES_LIMIT_MARK, REGENERATE_HINTS, REPEAT_REMINDER_MARK, REPEAT_STOP_MARK } from '@spica/protocol';
import type { AgentBackend } from './types';
import { buildSeed, fakeCard } from './fake-seed';
import { FAKE_PROJECTS, FakeMailbox } from './fake-mail';
import { isoAt } from './time';
import { DEMO_MEMORIES, FakeMemory, guessEntry, type MemoryPlan } from './fake-memory';

/** What the user typed in a message (its text blocks). */
function textOf(m: Message | undefined): string {
  return (m?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
}

export interface FakeBackendOptions {
  /** Multiplies every delay; 0 runs scripts instantly (tests). Default 1. */
  speed?: number;
  /** Start with the demo projects and history. Default true. */
  seed?: boolean;
  /** The demo's own memory notes (default: with the seed). */
  demoMemories?: boolean;
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
  /** Counted against 单次运行花费上限 (USD); `unpriced`: the run's model has no price (「未计价」 in the message); `dear`: each call costs about 0.85 USD (「花费上限」 in the message). */
  spent: number;
  unpriced?: boolean;
  dear?: boolean;
}

class Aborted extends Error {}

/** Tools of the script that only read (a round that used only these can be regenerated, as in the core). */
const READ_ONLY_TOOLS = new Set(['list_dir', 'read_file', 'glob', 'grep', 'web_fetch', 'web_search', 'ask_user', 'suggest_actions']);
/** remember / forget: taken back when their answer is regenerated, so they do not keep it from being regenerated (as in the core). */
const MEMORY_TOOLS = new Set(['remember', 'forget']);
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
/** 「批量」: a command that leaves fourteen files (two handed over), for the list that stands in for cards. */
const FAKE_BATCH_DIR = 'D:\\工作\\样机评审\\规格书';
export const FAKE_BATCH_FILES = [
  ...['MV-SPSS26010', 'MV-SPSS26011', 'MV-SPSS26012', 'MV-SPSS26013', 'MV-SPSS26014', 'MV-SPSS26015', 'MV-SPSS26016', 'MV-SPSS26017', 'MV-SPSS26018', 'MV-SPSS26019'].map((n) => `${FAKE_BATCH_DIR}\\${n}_规格书.pdf`),
  `${FAKE_BATCH_DIR}\\规格书汇总.xlsx`,
  `${FAKE_BATCH_DIR}\\下载记录.csv`,
  `${FAKE_BATCH_DIR}\\外形尺寸对比.png`,
  `${FAKE_BATCH_DIR}\\说明.txt`,
];
export const FAKE_BATCH_ANSWER = '十份规格书都下载好了，汇总表里按料号列了每份的版本和日期。';

/** 「照片」: an answer with three pictures (the demo chart and two drawn here), for going through them full size. */
export const FAKE_PHOTO_DATA = [
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAACgCAIAAAC9uXYyAAABxklEQVR42u3aMREAIAwEwThCIWJRAhJokiKwzNVfMFsmxlzSM4UvENAS0BLQEtACWgJaAloCWgJaQEtAS0BLQEtAC2gJaAloCWgJaAEtAS0BLQEtAS2gJaAloCWgJaAFtAS0BLQEtAS0gJaAloCWgBbQEtAS0BLQEtACWgJaAloCWmoKet9eyoidlB2ggQYaaICABtoO0EDbARpooIEGGmigAQIaaDtAA20HaKCBBrpGPKzfogfaDtBA2wEaaKCBBghooEEEGmg7QANtB2iggQYaIKCBtgM00HaAdpwEK9BAAw00QEADbQdooO0ADTTQQAMNNNAgAg20HaCBtgM00EADDTTQjpMggx5oO0ADbQdooO0ADTTQQAMENNB2gAbaDtBA2wEaIKCBBghooO0A7TjJjuMkoIEGGiCggQYRaKDtAA20HaCBBhpogIAGGkSggbYDNNBAAw000I6TIIMeaDtAA20HaKDtAC0BLQEtoCWgJaAloCWgBbQEtAS0BLQEtICWgJaAloCWgBbQEtAS0BLQEtACWgJaAloCWkBLQEtAS0BLQAtoCWgJaAloCWgBLQEtAS0BLQEtoCWgJaAloCWgBbTUqAMXbfNAA6Jd3AAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAACgCAIAAAC9uXYyAAABxklEQVR42u3aMREAIAwEwajALmIQChJokiKwzNVfMFsmxprSM4UvENAS0BLQEtACWgJaAloCWgJaQEtAS0BLQEtAC2gJaAloCWgJaAEtAS0BLQEtAS2gJaAloCWgJaAFtAS0BLQEtAS0gJaAloCWgBbQEtAS0BLQEtACWgJaAloCWmoKet9eyoidlB2ggQYaaICABtoO0EDbARpooIEGGmigAQIaaDtAA20HaKCBBrpGPKzfogfaDtBA2wEaaKCBBghooEEEGmg7QANtB2iggQYaIKCBtgM00HaAdpwEK9BAAw00QEADbQdooO0ADTTQQAMNNNAgAg20HaCBtgM00EADDTTQjpMggx5oO0ADbQdooO0ADTTQQAMENNB2gAbaDtBA2wEaIKCBBghooO0A7TjJjuMkoIEGGiCggQYRaKDtAA20HaCBBhpogIAGGkSggbYDNNBAAw000I6TIIMeaDtAA20HaKDtAC0BLQEtoCWgJaAloCWgBbQEtAS0BLQEtICWgJaAloCWgBbQEtAS0BLQEtACWgJaAloCWkBLQEtAS0BLQAtoCWgJaAloCWgBLQEtAS0BLQEtoCWgJaAloCWgBbTUqAMNV/klhV3ffAAAAABJRU5ErkJggg==',
];
export const fakePhotoAnswer = (chart: string) =>
  '样机的三张图：\n\n' + `![报价对比](<${chart}>)\n\n` + `![样机正面](${FAKE_PHOTO_DATA[0]})\n\n` + `![样机侧面](${FAKE_PHOTO_DATA[1]})`;

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
  /** Calls of a model without a price were made (in any conversation). */
  #globalUnpriced = false;
  /** 设置 › 模型 › a provider's 花费上限 (USD in all; null: none), as the core gets it; the demo has one provider. */
  #spendLimit: { providerId: string; usd: number; sinceUsd: number; name?: string } | null = null;
  /** What the demo's priced calls have cost in all. */
  #spent = 0;
  /** The request log (the usage page, the monitor): two weeks of demo records, then the calls made here. */
  #requests: RequestRecord[] = [];
  /** 设置 › 模型 › 代理互发消息上限 (null: none), as the core gets it. */
  #agentMessages: number | null = 10;
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
      (options.demoMemories ?? options.seed ?? true) ? DEMO_MEMORIES : [],
    );
    this.#mail = new FakeMailbox(
      this.#now,
      (sid, body) => this.#emit(sid, body),
      (ms) => new Promise((r) => setTimeout(r, ms * this.#speed)),
      options.seed ?? true,
      () => [...this.#projects.values()],
    );
    if (options.seed ?? true) {
      this.#requests = fakeRequests(this.#now());
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
        if (b.type !== 'tool_use' || READ_ONLY_TOOLS.has(b.name) || MEMORY_TOOLS.has(b.name) || this.#declined.has(b.id)) continue;
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
      // what the old answer did to the memory is taken back first (as in the core)
      const kept = Object.assign({}, ...answer.map((m) => m.meta?.memoryCards ?? {})) as Record<string, MemoryCardMeta>;
      const cards = answer.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_use' && kept[b.id] ? [kept[b.id]!] : [])));
      this.#memory.revert(cards);
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
    this.#resolvePending(sessionId, callId, answer, 'ask');
    this.#emit(sessionId, { type: 'ask.resolved', callId, answer });
  }

  async confirm(sessionId: string, callId: string, approved: boolean): Promise<void> {
    this.#resolvePending(sessionId, callId, approved ? 'yes' : 'no', 'confirm');
    if (!approved) this.#declined.add(callId);
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

  /** A provider's 花费上限 changed in the settings (as the core's budget.perProvider[id].globalUsd). */
  setSpendLimit(providerId: string | null, usd: number | null, sinceUsd = 0, name?: string): void {
    this.#spendLimit = providerId && usd !== null ? { providerId, usd, sinceUsd, ...(name ? { name } : {}) } : null;
  }

  /** What the demo has cost in all (the core's providerSpend). */
  spentUsd(): number {
    return this.#spent;
  }

  /** The usage page (the core's usageSummary). */
  async usageSummary(query: UsageQuery): Promise<UsageSummary> {
    return summarizeRequests(this.#requests, query, this.#requests[0]?.startedAt ?? null);
  }

  /** The newest request records (the core's recentRequests). */
  async recentRequests(limit = 500): Promise<RequestRecord[]> {
    return structuredClone(this.#requests.slice(-Math.max(0, limit)));
  }

  /** One request of a demo call, kept and sent as the core does. */
  #request(sessionId: string, rec: Omit<RequestRecord, 'id' | 'traceId' | 'startedAt' | 'sessionId' | 'initiator' | 'attempt'> & { attempt?: number }): void {
    const record: RequestRecord = { id: `rq_${++this.#ids}`, traceId: `tr_${this.#ids}`, startedAt: isoAt(this.#now()), sessionId, initiator: 'model', attempt: 1, ...rec };
    this.#requests.push(record);
    this.#emit(sessionId, { type: 'request', record: structuredClone(record) });
  }

  /** 代理互发消息上限 changed in the settings (as the core's configure({ defaults: { agentMessages } })). */
  setAgentMessages(n: number | null): void {
    this.#agentMessages = n;
  }

  async listMemories(opts?: { all?: boolean }): Promise<MemoryItem[]> {
    return this.#memory.list(opts);
  }

  async listMemoryEntries(): Promise<MemoryEntry[]> {
    return this.#memory.entries();
  }

  async addMemory(text: string, entry?: number | MemoryEntryInput): Promise<MemoryCardMeta | MemoryRefusal> {
    return this.#memory.addOwn(text, entry);
  }

  async editMemory(id: number, text: string): Promise<MemoryCardMeta | MemoryRefusal | undefined> {
    return this.#memory.edit(id, text);
  }

  async editMemoryEntry(id: number, entry: MemoryEntryInput): Promise<MemoryCardMeta | MemoryRefusal | undefined> {
    return this.#memory.editEntry(id, entry);
  }

  async deleteMemoryEntry(id: number): Promise<MemoryCardMeta | undefined> {
    return this.#memory.deleteEntry(id);
  }

  async forgetMemory(id: number): Promise<MemoryCardMeta | undefined> {
    return this.#memory.delete(id);
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

  /** As the core: a card it no longer waits on (stopped, answered already) is refused with the core's words. */
  #resolvePending(sessionId: string, callId: string, value: string, kind: PendingItem['kind']): void {
    const list = this.#pending.get(sessionId) ?? [];
    if (!list.some((p) => p.callId === callId && p.kind === kind)) throw new Error(`no pending ${kind} with id ${callId}`);
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
    const entry = plan.action === 'save' ? guessEntry(plan.text) : undefined;
    const input = plan.action === 'forget' ? { id: plan.id, quote } : { text: plan.text, quote, ...(entry ? { entry: entry.name, summary: entry.summary, category: entry.category } : {}), ...(plan.action === 'replace' ? { replaces: plan.replaces } : {}) };
    this.#emit(sessionId, { type: 'tool.call', callId, name });
    this.#emit(sessionId, { type: 'tool.start', callId, name, input, category: 'other' });
    const card =
      plan.action === 'forget'
        ? this.#memory.forget(plan.id, 'assistant', true)
        : this.#memory.add({ text: plan.text, quote, by: 'assistant', ...(entry ? { entry } : {}), sessionId, ...(userSeq !== undefined ? { seq: userSeq } : {}), ...(plan.action === 'replace' ? { replaces: plan.replaces } : {}) });
    if (card) this.#emit(sessionId, { type: 'memory.changed', callId, card });
    this.#callInfo.set(callId, { category: 'other', ...(card ? { memory: card } : {}) });
    const result = card?.item ? (card.action === 'forgotten' ? `Forgot [${card.item.id}].` : `Saved as [${card.item.id}].`) : 'Nothing changed.';
    this.#emit(sessionId, { type: 'tool.end', callId, name, isError: false, preview: result, durationMs: 20 });
    return [
      { type: 'tool_use', id: callId, name, input },
      { type: 'tool_result', toolUseId: callId, content: result },
    ];
  }

  /** What one call of the run costs (USD): the demo price, or about 0.85 USD when the message asked for 「花费上限」. */
  #callUsd(run: Run | undefined, inputTokens: number, outputTokens: number): number {
    return ((inputTokens * 0.27 + outputTokens * 1.1) / 1_000_000) * (run?.dear ? 1000 : 1);
  }

  /**
   * As the core: the next call is not started once what the provider has cost in all has reached its 花费上限 (what
   * the call might cost is not counted in; a model without a price never stops). Returns true when the run was stopped.
   */
  #stopsAtLimit(sessionId: string, run: Run, nextUsd: number): boolean {
    const limit = this.#spendLimit;
    if (limit === null || run.unpriced) return false;
    // since the last 清零, as the settings show 已花
    const spent = Math.max(0, this.#spent - limit.sinceUsd);
    if (spent < limit.usd) return false;
    const scope = `${limit.providerId}:global`;
    const message = `spending limit reached: ${limit.name ?? limit.providerId} spent ${usdText(spent)} of ${usdText(limit.usd)}`;
    this.#emit(sessionId, { type: 'budget.stop', scope, spentUsd: spent, limitUsd: limit.usd, nextUsd, message });
    this.#finish(sessionId, 'budget', message);
    return true;
  }

  #charge(sessionId: string, inputTokens: number, outputTokens: number): void {
    const run = this.#runs.get(sessionId);
    const s = this.#sessions.get(sessionId);
    if (run?.unpriced) {
      // a company gateway model without a price: nothing is counted, it is marked (as the core)
      if (s) s.unpriced = true;
      this.#globalUnpriced = true;
      this.#request(sessionId, { providerId: 'fake', model: 'gateway-model', durationMs: 1800, status: 'ok', httpStatus: 200, inputTokens, outputTokens, unpriced: true });
      this.#emit(sessionId, { type: 'usage', usage: { inputTokens, outputTokens }, costUsd: 0, providerId: 'fake', model: 'gateway-model', unpriced: true });
      this.#emit(sessionId, { type: 'cost', scope: 'session', spentUsd: s?.costUsd ?? 0, warning: false, unpriced: true });
      this.#emit(sessionId, { type: 'cost', scope: 'global', spentUsd: this.#globalCost, warning: false, unpriced: true });
      if (s) this.#emit(sessionId, { type: 'session.updated', info: structuredClone(s) });
      return;
    }
    const costUsd = this.#callUsd(run, inputTokens, outputTokens);
    if (run) run.spent += costUsd;
    this.#spent += costUsd;
    if (s) s.costUsd += costUsd;
    this.#globalCost += costUsd;
    this.#request(sessionId, { providerId: 'fake', model: 'deepseek-flash', durationMs: 1800, status: 'ok', httpStatus: 200, inputTokens, outputTokens, costUsd });
    this.#emit(sessionId, { type: 'usage', usage: { inputTokens, outputTokens }, costUsd, providerId: 'fake', model: 'deepseek-flash' });
    this.#emit(sessionId, { type: 'cost', scope: 'session', spentUsd: s?.costUsd ?? costUsd, warning: false, ...(s?.unpriced ? { unpriced: true as const } : {}) });
    this.#emit(sessionId, { type: 'cost', scope: 'global', spentUsd: this.#globalCost, warning: false, ...(this.#globalUnpriced ? { unpriced: true as const } : {}) });
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
    // 「未计价」: the run uses a model without a price; 「花费上限」: its calls are dear (to reach 单次运行花费上限)
    const run: Run = { controller: new AbortController(), steers: [], spent: 0, ...(/未计价/.test(text) ? { unpriced: true } : {}), ...(/花费上限/.test(text) ? { dear: true } : {}) };
    this.#runs.set(sessionId, run);
    const signal = run.controller.signal;
    const blocks: ContentBlock[] = [];
    // The card the run waits on (a confirmation or a question): stopped while it waits, it is kept with a cancelled
    // result, as the core does.
    // `stored`: its call is already in the history (with its message), as the core stores it before asking.
    let waiting: { id: string; name: string; input: unknown; stored?: boolean } | undefined;
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

      // 「工具详情」: one of each kind of call, a line of the answer between them so each is a row of its own (for
      // pictures of what a call shows opened): a command that works, one that fails with its exit code, a plugin
      // tool answering JSON (fenced, as the core hands outside content to the model) and one failing, a long read,
      // a file written, edited in one place and in several, written over. Names and data are made up. The edits and
      // the overwrite carry the change as the core works it out (tools/line-diff.ts: line numbers, three lines around).
      if (/工具详情/.test(text)) {
        const at = isoAt(this.#now());
        const card = (path: string, origin: 'created' | 'modified', added: number, removed: number, change?: FileCardMeta['change']): FileCardMeta => ({
          path: `D:\\工作\\样机评审\\${path}`, name: path.split('\\').pop() ?? path, kind: 'text', sizeBytes: 612, modifiedAt: at, extractedAt: at, read: {}, origin, lines: { added, removed }, ...(change ? { change } : {}),
        });
        const say = async (words: string) => {
          await this.#stream(sessionId, 'text', words, signal);
          blocks.push({ type: 'text', text: words });
        };
        const fenced = (source: string, body: string) => `<untrusted_data kind="mcp" source="${source}">\n${body}\n</untrusted_data>`;
        const SCRIPT = [
          'import csv',
          'from pathlib import Path',
          '',
          'TOTAL = 0',
          '',
          '',
          'def read_quotes(folder: Path) -> list[dict]:',
          '    """Every quote in the folder, one dict a row."""',
          '    rows = []',
          '    for f in sorted(folder.glob("*.csv")):',
          '        with f.open(encoding="utf-8") as fh:',
          '            rows.extend(csv.DictReader(fh))',
          '    return rows',
          '',
          '',
          'if __name__ == "__main__":',
          '    quotes = read_quotes(Path("报价"))',
          '    print(len(quotes), "quotes")',
        ].join('\n');
        await say('先统计报价单。');
        blocks.push(...(await this.#tool(sessionId, run, 'run_command', { command: "Get-ChildItem -Path '.\\报价' -Filter *.csv | Measure-Object | Select-Object Count", description: '统计报价单数量' }, 'exit code 0, 0.4 s\n\nCount\n-----\n    7', 400)));
        await say('再检查格式。');
        blocks.push(...(await this.#tool(sessionId, run, 'run_command', { command: 'python .\\tools\\check_quotes.py --strict .\\报价', description: '检查报价单格式' }, 'exit code 2, 1.3 s\nTraceback (most recent call last):\n  File "tools\\check_quotes.py", line 41, in <module>\n    check(row)\n  File "tools\\check_quotes.py", line 18, in check\n    raise ValueError(f"第 {row.line} 行缺少单价")\nValueError: 第 3 行缺少单价', 600, true)));
        await say('查一下两个零件的规格。');
        const specs = { env: 'test', items: [{ id: 'DEMO-1001', summary: { name: '外壳上盖', size_mm: [120, 80, 24], material: 'PC+ABS', approved: true, revisions: 3 } }, { id: 'DEMO-1002', summary: { name: '电池仓', size_mm: [96, 52, 18], material: 'PA66', approved: false, revisions: 1, note: null } }], total: 2 };
        blocks.push(...(await this.#tool(sessionId, run, 'demo-specs__get_spec', { part_ids: ['DEMO-1001', 'DEMO-1002'], detail: true }, fenced('demo-specs__get_spec', JSON.stringify(specs)), 500, false, { category: 'plugin' })));
        await say('第三个零件查不到。');
        blocks.push(...(await this.#tool(sessionId, run, 'demo-specs__get_spec', { part_ids: ['DEMO-9999'] }, 'Tool failed: HTTP 404 Not Found: part DEMO-9999 does not exist', 400, true, { category: 'plugin' })));
        await say('读一下评审纪要。');
        const minutes = Array.from({ length: 60 }, (_, i) => (i % 6 === 0 ? `## 议题 ${i / 6 + 1}` : `- 第 ${i + 1} 条：外壳样机第 ${(i % 3) + 1} 轮评审意见，跟进人 ALEX.CHEN。`)).join('\n');
        blocks.push(...(await this.#tool(sessionId, run, 'read_file', { path: '评审纪要.md' }, `评审纪要.md (lines 1-60 of 60)\n${minutes}`, 400)));
        await say('写一个汇总脚本。');
        blocks.push(...(await this.#tool(sessionId, run, 'write_file', { path: 'tools\\summary.py', content: SCRIPT }, 'Created tools\\summary.py (612 bytes).', 300, false, { category: 'write', cards: [card('tools\\summary.py', 'created', 18, 0)] })));
        await say('改一处。');
        const edit1 = { hunks: [{ oldStart: 1, newStart: 1, lines: [' import csv', ' from pathlib import Path', ' ', '-TOTAL = 0', '+TOTAL = 0.0', ' ', ' ', ' def read_quotes(folder: Path) -> list[dict]:'] }] };
        blocks.push(...(await this.#tool(sessionId, run, 'edit_file', { path: 'tools\\summary.py', old_string: 'TOTAL = 0', new_string: 'TOTAL = 0.0' }, 'Edited tools\\summary.py: 1 replacement(s).', 300, false, { category: 'write', cards: [card('tools\\summary.py', 'modified', 1, 1, edit1)] })));
        await say('再改几处。');
        blocks.push(...(await this.#tool(sessionId, run, 'edit_file', {
          path: 'tools\\summary.py',
          old_string: 'if __name__ == "__main__":\n    quotes = read_quotes(Path("报价"))\n    print(len(quotes), "quotes")',
          new_string: 'if __name__ == "__main__":\n    folder = Path("报价")\n    quotes = read_quotes(folder)\n    total = sum(float(q["单价"]) for q in quotes)\n    print(len(quotes), "quotes, total", round(total, 2))',
        }, 'Edited tools\\summary.py: 1 replacement(s).', 300, false, {
          category: 'write',
          cards: [
            card('tools\\summary.py', 'modified', 4, 2, {
              hunks: [{ oldStart: 14, newStart: 14, lines: [' ', ' ', ' if __name__ == "__main__":', '-    quotes = read_quotes(Path("报价"))', '-    print(len(quotes), "quotes")', '+    folder = Path("报价")', '+    quotes = read_quotes(folder)', '+    total = sum(float(q["单价"]) for q in quotes)', '+    print(len(quotes), "quotes, total", round(total, 2))'] }],
            }),
          ],
        })));
        await say('整份重写，输出改成 JSON。');
        const rewritten = SCRIPT.replace('import csv\n', 'import csv\nimport json\n')
          .replace('TOTAL = 0', 'TOTAL = 0.0')
          .replace('    quotes = read_quotes(Path("报价"))\n    print(len(quotes), "quotes")', '    folder = Path("报价")\n    quotes = read_quotes(folder)\n    total = sum(float(q["单价"]) for q in quotes)\n    print(json.dumps({"quotes": len(quotes), "total": round(total, 2)}, ensure_ascii=False))');
        blocks.push(...(await this.#tool(sessionId, run, 'write_file', { path: 'tools\\summary.py', content: rewritten }, `Overwrote tools\\summary.py (${new TextEncoder().encode(rewritten).length} bytes).`, 300, false, {
          category: 'write',
          cards: [
            card('tools\\summary.py', 'modified', 2, 1, {
              hunks: [
                { oldStart: 1, newStart: 1, lines: [' import csv', '+import json', ' from pathlib import Path', ' ', ' TOTAL = 0.0'] },
                { oldStart: 17, newStart: 18, lines: ['     folder = Path("报价")', '     quotes = read_quotes(folder)', '     total = sum(float(q["单价"]) for q in quotes)', '-    print(len(quotes), "quotes, total", round(total, 2))', '+    print(json.dumps({"quotes": len(quotes), "total": round(total, 2)}, ensure_ascii=False))'] },
              ],
            }),
          ],
        })));
        await say('都做完了。');
        this.#commitAssistant(sessionId, blocks);
        this.#charge(sessionId, 4200, 300);
        this.#emit(sessionId, { type: 'turn.end', turn });
        this.#finish(sessionId, 'completed');
        return;
      }

      // 「边想边做」: thinking before every call, as models that think between steps do (each call a turn of its own).
      // The first turn starts writing a file and is cut off at the length limit: its call was announced but never
      // made (the core streamed tool.call; the finished message has no such call). 「卡住」 keeps the last call
      // running. 「只想一想」: a round with thinking and an answer, no call.
      if (/边想边做|只想一想/.test(text)) {
        const think = async (words: string) => {
          await this.#sleep(200, signal);
          await this.#stream(sessionId, 'thinking', words, signal);
          blocks.push({ type: 'thinking', text: words });
        };
        if (/只想一想/.test(text)) {
          await think('只是问个想法，不用看文件：先说结论，再给一句理由。');
          const reply = '可以先做样机评审，再定报价：评审的结论会影响要不要改结构件。';
          await this.#stream(sessionId, 'text', reply, signal);
          blocks.push({ type: 'text', text: reply });
          this.#commitAssistant(sessionId, blocks);
          this.#charge(sessionId, 1200, 90);
          this.#emit(sessionId, { type: 'turn.end', turn });
          this.#finish(sessionId, 'completed');
          return;
        }
        await think('要先看看文件夹里有什么，再读需求，最后跑一下统计。');
        const lead = '开始做，先整理资料。';
        await this.#stream(sessionId, 'text', lead, signal);
        blocks.push({ type: 'text', text: lead });
        this.#emit(sessionId, { type: 'tool.call', callId: this.#id('call'), name: 'write_file' });
        await this.#sleep(300, signal);
        this.#append(sessionId, 'assistant', 'assistant', [...blocks], { stopReason: 'max_tokens' });
        blocks.length = 0;
        this.#emit(sessionId, { type: 'turn.end', turn });
        const steps: [string, string, unknown, string][] = [
          ['刚才那段写长了，先换个做法：列一下文件夹。', 'list_dir', { path: '.' }, '会议记录/\n报价单.xlsx\n测试报告.pdf\n需求说明.docx'],
          ['有需求说明，读一下。', 'read_file', { path: '需求说明.docx' }, '需求说明 v3：外壳尺寸 120×80×24 mm；续航不少于 10 小时；首批样机 20 台。'],
          ['再数一下报价单里有几家回了价。', 'run_command', { command: "Import-Csv '报价单.csv' | Measure-Object", description: '统计报价单行数' }, 'Count : 4'],
        ];
        for (const [i, [words, name, input, result]] of steps.entries()) {
          this.#emit(sessionId, { type: 'turn.start', turn: ++turn });
          this.#setStatus(sessionId, 'thinking');
          await think(words);
          const last = i === steps.length - 1;
          blocks.push(...(await this.#tool(sessionId, run, name, input, result, last && /卡住/.test(text) ? 3_600_000 : 500)));
          this.#commitAssistant(sessionId, blocks);
          this.#emit(sessionId, { type: 'turn.end', turn });
        }
        this.#emit(sessionId, { type: 'turn.start', turn: ++turn });
        this.#setStatus(sessionId, 'thinking');
        await think('都齐了，写结论。');
        const done = '资料都看过了：需求说明是第 3 版，报价单里 4 家已回价。';
        await this.#stream(sessionId, 'text', done, signal);
        blocks.push({ type: 'text', text: done });
        this.#commitAssistant(sessionId, blocks);
        this.#charge(sessionId, 4200, 300);
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

      // For screenshots of tools at work: 「慢」 makes each call take 4 s, 「失败」 makes reading the file fail,
      // 「卡住」 keeps reading the file running for an hour (the Running … line and its clock, until 停止).
      const slow = /慢/.test(text);
      const stuck = /卡住/.test(text);
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
          stuck ? 3_600_000 : slow ? 4000 : 700,
          fails,
        )),
      );
      this.#commitAssistant(sessionId, blocks);
      this.#charge(sessionId, 2400, 180);
      this.#emit(sessionId, { type: 'turn.end', turn });
      this.#applySteers(sessionId, run);
      // the next call's worst case (its input at least this call's, all of maxTokens out), as the core counts it
      if (this.#stopsAtLimit(sessionId, run, this.#callUsd(run, 3100, 4096))) return;

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
        // As the core does: the call is stored with its message and asked about; it starts only once allowed.
        this.#emit(sessionId, { type: 'tool.call', callId, name: 'run_command' });
        this.#commitAssistant(sessionId, [...blocks.splice(0), { type: 'tool_use', id: callId, name: 'run_command', input }]);
        this.#addPending(sessionId, { kind: 'confirm', callId, toolName: 'run_command', input, reason: '运行命令', createdAt: isoAt(this.#now()) });
        this.#emit(sessionId, { type: 'confirm.request', callId, name: 'run_command', input, reason: '运行命令' });
        this.#setStatus(sessionId, 'awaiting_confirm', 'run_command');
        waiting = { id: callId, name: 'run_command', input, stored: true };
        const ok = (await this.#waitFor(run, callId)) === 'yes';
        waiting = undefined;
        if (ok) this.#emit(sessionId, { type: 'tool.start', callId, name: 'run_command', input, category: 'command', summary: input.description });
        this.#emit(sessionId, { type: 'tool.end', callId, name: 'run_command', isError: !ok, preview: ok ? '已删除' : '用户拒绝了这条命令', durationMs: 300 });
        this.#commitAssistant(sessionId, [{ type: 'tool_result', toolUseId: callId, content: ok ? '已删除' : '用户拒绝了这条命令', isError: !ok }]);
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
        this.#commitAssistant(sessionId, [...blocks.splice(0), { type: 'tool_use', id: callId, name: 'send_email', input }]);
        this.#addPending(sessionId, { kind: 'confirm', callId, toolName: 'send_email', input, reason: '发送邮件给「项目组」', createdAt: isoAt(this.#now()) });
        this.#emit(sessionId, { type: 'confirm.request', callId, name: 'send_email', input, reason: '发送邮件给「项目组」' });
        this.#setStatus(sessionId, 'awaiting_confirm', 'send_email');
        waiting = { id: callId, name: 'send_email', input, stored: true };
        const decision = await this.#waitFor(run, callId);
        waiting = undefined;
        const ok = decision === 'yes';
        if (ok) this.#emit(sessionId, { type: 'tool.start', callId, name: 'send_email', input });
        this.#emit(sessionId, { type: 'tool.end', callId, name: 'send_email', isError: !ok, preview: ok ? '已发送' : '用户取消了发送', durationMs: 300 });
        this.#commitAssistant(sessionId, [{ type: 'tool_result', toolUseId: callId, content: ok ? '已发送' : '用户取消了发送', isError: !ok }]);
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
        waiting = { id: callId, name: 'ask_user', input: { question, options } };
        const answer = await this.#waitFor(run, callId);
        waiting = undefined;
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
      } else if (/照片/.test(text)) {
        const answer = fakePhotoAnswer(this.#demoImage?.() ?? 'D:\\工作\\样机评审\\报价对比图.png');
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
      } else if (/批量/.test(text)) {
        const at = isoAt(this.#now());
        const card = (path: string): FileCardMeta => {
          const name = path.split('\\').pop() ?? path;
          const kind = name.endsWith('.pdf') ? 'pdf' : name.endsWith('.xlsx') ? 'xlsx' : name.endsWith('.csv') ? 'csv' : name.endsWith('.txt') ? 'text' : 'other';
          return { path, name, kind, sizeBytes: 2048, modifiedAt: at, extractedAt: at, read: {}, origin: 'created', ...(kind === 'pdf' ? { pageCount: 4 } : {}), ...(kind === 'xlsx' ? { sheets: [{ name: '汇总', rows: 11, cols: 4 }, { name: '明细', rows: 40, cols: 6 }] } : {}) };
        };
        const cards = FAKE_BATCH_FILES.map(card);
        blocks.push(...(await this.#tool(sessionId, run, 'run_command', { command: 'python 批量下载规格书.py', description: '批量下载规格书' }, `下载 ${cards.length} 个文件`, 600, false, { category: 'command', cards })));
        blocks.push(...(await this.#tool(sessionId, run, 'present_files', { paths: FAKE_BATCH_FILES.slice(10, 12) }, '已交付 2 个文件', 200, false, { category: 'present', cards: cards.slice(10, 12) })));
        this.#setStatus(sessionId, 'thinking');
        await this.#stream(sessionId, 'text', FAKE_BATCH_ANSWER, signal);
        blocks.push({ type: 'text', text: FAKE_BATCH_ANSWER });
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
      } else if (/互发/.test(text)) {
        // Messaging a sub-agent again and again: past 代理互发消息上限 the core refuses (AGENT_MESSAGES_LIMIT_MARK).
        const limit = this.#agentMessages;
        const tries = limit === null ? 3 : limit + 1;
        for (let i = 1; i <= tries; i++) {
          const refused = limit !== null && i > limit;
          const result = refused
            ? `${AGENT_MESSAGES_LIMIT_MARK} This conversation has sent ${limit} messages to other agents since the user last wrote here (the limit is ${limit}).`
            : '已发送；子Agent A 开始处理。';
          blocks.push(...(await this.#tool(sessionId, run, 'message_agent', { id: 'ses-sub-a', text: `第 ${i} 次：再核对一遍报价` }, result, 150, refused)));
        }
        this.#setStatus(sessionId, 'thinking');
        const reply = limit === null ? '已经让子Agent A 再核对了三遍报价。' : `已经给子Agent A 发了 ${limit} 条消息，到了上限，先停在这里，等你说下一句。`;
        await this.#stream(sessionId, 'text', reply, signal);
        blocks.push({ type: 'text', text: reply });
      } else if (/重复/.test(text)) {
        // The same call again and again, as the core counts it (repeat-guard.ts): the 3rd to 7th results carry a note
        // for the model (not shown), the 8th is not run and the run stops ('repeated').
        for (let i = 1; i <= 8; i++) {
          const input = { path: '.' };
          if (i === 8) {
            blocks.push(...(await this.#tool(sessionId, run, 'list_dir', input, `${REPEAT_STOP_MARK} This would have been the 8th same list_dir call in a row with the same result, so it was not run and the run stopped. The user decides whether to go on.`, 50, true)));
            break;
          }
          const got = await this.#tool(sessionId, run, 'list_dir', input, '需求说明.docx\n报价单.xlsx', 120);
          const result = got[1];
          if (i >= 3 && result?.type === 'tool_result') result.content += `\n\n${REPEAT_REMINDER_MARK} You have now made this same list_dir call ${i} times in a row and got the same result each time.`;
          blocks.push(...got);
        }
        this.#commitAssistant(sessionId, blocks);
        this.#emit(sessionId, { type: 'turn.end', turn });
        this.#finish(sessionId, 'repeated', 'the same call came 8 times in a row with the same result; it was not run');
        return;
      } else if (/超时/.test(text)) {
        // the model's interface did not answer in time: a plain error with nothing to set (模型接口超时)
        throw new Error('request timed out after 120s');
      } else if (/断电/.test(text)) {
        // as if the app quit mid-run: the conversation is left interrupted (上次运行已中断, 继续 goes on)
        this.#commitAssistant(sessionId, blocks);
        this.#runs.delete(sessionId);
        this.#setStatus(sessionId, 'interrupted');
        this.#emit(sessionId, { type: 'run.end', reason: 'aborted', detail: 'the app closed while the run was going' });
        return;
      } else if (/欠费/.test(text)) {
        // the provider's account is out of money, as an OpenAI-style API says it
        throw new Error('HTTP 402 [insufficient_balance]: Insufficient Balance');
      } else if (/写长一点/.test(text)) {
        // An answer that stopped at the most the model may write at once (stopReason max_tokens, as the core stores it).
        const cut = '好的，写详细一点：\n\n1. **外壳尺寸** 定为 120×80×24 mm，比上一版薄 2 mm，主要是电池仓改了排布，' +
          '散热片从两片改成一片，结构件供应商已经确认能做。\n2. **续航** 要求不少于 10 小时，测试报告里在 25°C、亮度 50% 的条件下';
        await this.#stream(sessionId, 'text', cut, signal);
        blocks.push({ type: 'text', text: cut });
        this.#append(sessionId, 'assistant', 'assistant', [...blocks], { stopReason: 'max_tokens' });
        blocks.length = 0;
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
        if (waiting && !waiting.stored) blocks.push({ type: 'tool_use', id: waiting.id, name: waiting.name, input: waiting.input });
        if (blocks.length) {
          const own = blocks.filter((b) => b.type !== 'tool_result');
          if (own.length) this.#append(sessionId, 'assistant', 'assistant', own, { interrupted: true });
        }
        if (waiting) this.#append(sessionId, 'user', 'tool_results', [{ type: 'tool_result', toolUseId: waiting.id, content: 'Cancelled: aborted by user.', isError: true }], { author: 'runtime' });
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

  #finish(sessionId: string, reason: 'completed' | 'aborted' | 'error' | 'budget' | 'repeated', detail?: string): void {
    this.#runs.delete(sessionId);
    const s = this.#sessions.get(sessionId);
    const status: SessionStatus =
      reason === 'completed' || reason === 'budget' || reason === 'repeated' ? (s?.role === 'worker' ? 'done' : 'idle') : reason === 'aborted' ? 'aborted' : 'error';
    this.#setStatus(sessionId, status);
    this.#emit(sessionId, detail ? { type: 'run.end', reason, detail } : { type: 'run.end', reason });
  }
}
