// Demo data for the fake backend: a neutral, fictional workspace with one
// finished conversation, two projects and their sub-agents in every state the
// UI has to draw. Used by screenshots, so keep it stable.
import type { ContentBlock, FileCardMeta, Message, PendingItem, ProjectLogEntry, SessionInfo, SessionStatus, AgentRole } from '@spica/protocol';
import { isoAt } from './time';

export interface Seed {
  sessions: SessionInfo[];
  messages: Record<string, Message[]>;
  pending: Record<string, PendingItem[]>;
}

/** What the core reports about a file it read (file.card), with demo numbers. */
export function fakeCard(path: string, now: Date): FileCardMeta {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const at = isoAt(now);
  const base = { path: `D:\\工作\\样机评审\\${name}`, name, sizeBytes: 48_213, modifiedAt: at, extractedAt: at };
  if (ext === 'pdf') return { ...base, kind: 'pdf', pageCount: 12, read: { pages: '1-12' } };
  if (ext === 'docx') return { ...base, kind: 'docx', pageCount: 4, read: {} };
  if (ext === 'xlsx') return { ...base, kind: 'xlsx', sheets: [{ name: '报价', rows: 36, cols: 8 }, { name: '交期', rows: 12, cols: 5 }], read: { sheet: '报价', rows: '1-36' } };
  return { ...base, kind: 'text', read: { rows: '1-80' } };
}

export const SEED_IDS = {
  chat: 's-chat-1',
  chat2: 's-chat-2',
  pm: 's-pm-1',
  quotes: 's-w-1',
  tests: 's-w-2',
  minutes: 's-w-3',
  pm2: 's-pm-2',
  budget: 's-w-4',
} as const;

export function buildSeed(now: Date): Seed {
  const at = (minutesAgo: number) => isoAt(new Date(now.getTime() - minutesAgo * 60_000));
  const session = (
    id: string,
    role: AgentRole,
    title: string,
    status: SessionStatus,
    parent: SessionInfo | null,
    minutesAgo: number,
    costUsd: number,
    cwd = '',
  ): SessionInfo => ({
    id,
    parentId: parent?.id ?? null,
    parentChain: parent ? [parent.id, ...parent.parentChain] : [],
    role,
    title,
    status,
    providerId: 'fake',
    model: 'deepseek-flash',
    cwd: cwd || parent?.cwd || '',
    costUsd,
    approvalMode: 'manual',
    contextTokens: null,
    contextWindow: null,
    createdAt: at(minutesAgo + 30),
    updatedAt: at(minutesAgo),
  });

  const chat = session(SEED_IDS.chat, 'top', '看一下样机评审资料', 'idle', null, 4, 0.0042, 'D:\\工作\\样机评审');
  Object.assign(chat, { contextTokens: 23_400, contextWindow: 128_000 });
  const chat2 = session(SEED_IDS.chat2, 'top', '整理本周来信', 'idle', null, 180, 0.0019);
  const pm = { ...session(SEED_IDS.pm, 'manager', '新品样机评审', 'thinking', null, 1, 0.0213, 'D:\\工作\\样机评审'), projectId: 'p-review' };
  const quotes = session(SEED_IDS.quotes, 'worker', '整理供应商报价', 'tool', pm, 1, 0.0061);
  const tests = session(SEED_IDS.tests, 'worker', '汇总测试报告', 'queued', pm, 2, 0.0008);
  const minutes = session(SEED_IDS.minutes, 'worker', '起草评审纪要', 'awaiting_answer', pm, 3, 0.0034);
  const pm2 = { ...session(SEED_IDS.pm2, 'manager', '年度预算', 'idle', null, 1440, 0.0105, 'D:\\工作\\年度预算'), projectId: 'p-budget' };
  const budget = session(SEED_IDS.budget, 'worker', '核对三季度支出', 'done', pm2, 1450, 0.0047);

  let n = 0;
  const msg = (s: SessionInfo, role: 'user' | 'assistant', kind: Message['kind'], content: ContentBlock[], minutesAgo: number): Message => ({
    id: `seed-m-${++n}`,
    sessionId: s.id,
    seq: n,
    role,
    kind,
    content,
    createdAt: at(minutesAgo),
    meta: role === 'user' ? { author: kind === 'tool_results' ? 'runtime' : 'user' } : {},
  });
  const text = (t: string): ContentBlock => ({ type: 'text', text: t });
  const stamp = at(5);

  const chatMessages: Message[] = [
    msg(chat, 'user', 'user', [text('帮我看看样机评审的资料，整理一下要点')], 6),
    msg(
      chat,
      'assistant',
      'assistant',
      [
        { type: 'thinking', text: '用户要样机评审资料的要点。先列出工作文件夹，再读需求说明和测试报告。' },
        text('我先看一下工作文件夹里的资料。'),
        { type: 'tool_use', id: 'seed-call-1', name: 'list_dir', input: { path: '.' } },
        { type: 'tool_use', id: 'seed-call-2', name: 'read_file', input: { path: '需求说明.docx' } },
        { type: 'tool_use', id: 'seed-call-3', name: 'read_file', input: { path: '测试报告.pdf' } },
      ],
      6,
    ),
    msg(
      chat,
      'user',
      'tool_results',
      [
        { type: 'tool_result', toolUseId: 'seed-call-1', content: `${stamp}\n会议记录/\n报价单.xlsx\n测试报告.pdf\n需求说明.docx` },
        { type: 'tool_result', toolUseId: 'seed-call-2', content: `${stamp}\n需求说明 v3：外壳尺寸 120×80×24 mm；续航不少于 10 小时；首批样机 20 台，月底前交付。` },
        { type: 'tool_result', toolUseId: 'seed-call-3', content: `${stamp}\n续航实测 11.5 小时；跌落测试 1.2 m 通过；高温 55 ℃ 下待机正常。` },
      ],
      5,
    ),
    msg(
      chat,
      'assistant',
      'assistant',
      [
        text(
          '看完了，要点如下：\n\n' +
            '1. **外壳尺寸** 定为 120×80×24 mm，和上一版相比薄了 2 mm。\n' +
            '2. **续航** 要求不少于 10 小时，测试报告里实测 11.5 小时，达标。\n' +
            '3. **可靠性** 1.2 m 跌落、55 ℃ 高温待机都通过了。\n' +
            '4. **交付** 首批样机 20 台，月底前交付，时间比较紧。\n\n' +
            '报价单里还有两家供应商没回价，建议今天跟进一下。',
        ),
        {
          type: 'tool_use',
          id: 'seed-call-4',
          name: 'suggest_actions',
          input: {
            title: '接下来可以',
            actions: [
              { label: '起草催价邮件', prompt: '帮我起草一封催价邮件，发给还没回价的两家供应商' },
              { label: '把要点整理成纪要', prompt: '把这些要点整理成评审纪要' },
            ],
          },
        },
      ],
      4,
    ),
  ];

  // The core reports read files as file.card events; history here carries them the forward-compatible way.
  const results = chatMessages[2];
  if (results) results.meta = { ...results.meta, fileCards: { 'seed-call-2': fakeCard('需求说明.docx', now), 'seed-call-3': fakeCard('测试报告.pdf', now) } };

  const minutesMessages: Message[] = [
    msg(minutes, 'user', 'user', [text('根据会议记录起草一份评审纪要')], 4),
    msg(minutes, 'assistant', 'assistant', [text('会议记录我看过了，动笔前先确认一下写法。'), { type: 'tool_use', id: 'seed-ask-1', name: 'ask_user', input: { question: '纪要按哪种口径写？' } }], 3),
  ];

  const sub = subProjects(now, session, msg, text);

  return {
    sessions: [chat, chat2, pm, quotes, tests, minutes, pm2, budget, ...sub.sessions],
    messages: {
      [chat.id]: chatMessages,
      [chat2.id]: [msg(chat2, 'user', 'user', [text('把本周来信按项目归一下类')], 190), msg(chat2, 'assistant', 'assistant', [text('本周一共 14 封来信：样机评审 6 封、年度预算 3 封，其余 5 封是通知类，不需要处理。')], 180)],
      [pm.id]: [msg(pm, 'user', 'user', [text('周四前把评审材料准备齐')], 20)],
      [quotes.id]: [msg(quotes, 'user', 'user', [text('把报价单里各家的单价和交期整理成表')], 10)],
      [tests.id]: [msg(tests, 'user', 'user', [text('汇总三份测试报告的结论')], 9)],
      [minutes.id]: minutesMessages,
      [pm2.id]: [],
      [budget.id]: [msg(budget, 'user', 'user', [text('核对三季度支出和预算的差额')], 1460), msg(budget, 'assistant', 'assistant', [text('三季度实际支出比预算低 4.2%，差额主要在差旅。')], 1450)],
      ...sub.messages,
    },
    pending: {
      [minutes.id]: [{ kind: 'ask', callId: 'seed-ask-1', question: '纪要按哪种口径写？', options: ['只写结论', '结论加讨论过程', '按议题逐条写'], createdAt: at(3) }],
    },
  };
}

// ----- Projects that hold sub-projects ------------------------------------------------
// 机种 holds three 磁件, 游戏攻略 holds one game. Each sub-project is a conversation, its manager; 磁件 T1's manager
// has sent out sub-tasks (two running, one kept for later jobs, four ended).

export const SUB_IDS = {
  t1: 's-sp-t1',
  l1: 's-sp-l1',
  l2: 's-sp-l2',
  game: 's-sp-game',
  quote: 's-st-quote',
  oldParts: 's-st-old',
  samples: 's-st-sample',
  spec: 's-st-spec',
  winding: 's-st-winding',
  heat: 's-st-heat',
  core: 's-st-core',
  l1Quote: 's-st-l1q',
} as const;

/** The demo's projects: two that hold sub-projects (no conversation of their own) and their sub-projects. */
export const SUB_PROJECTS: readonly { id: string; name: string; folder?: string; parentId?: string; managerSessionId: string }[] = [
  { id: 'p-models', name: '机种', folder: 'D:\\工作\\机种', managerSessionId: '' },
  { id: 'p-t1', name: '磁件 T1', parentId: 'p-models', managerSessionId: SUB_IDS.t1 },
  { id: 'p-l1', name: '磁件 L1', parentId: 'p-models', managerSessionId: SUB_IDS.l1 },
  { id: 'p-l2', name: '磁件 L2', parentId: 'p-models', managerSessionId: SUB_IDS.l2 },
  { id: 'p-games', name: '游戏攻略', folder: 'D:\\游戏攻略', managerSessionId: '' },
  { id: 'p-game', name: '怪物猎人: 冰原', parentId: 'p-games', managerSessionId: SUB_IDS.game },
];

type MakeSession = (id: string, role: AgentRole, title: string, status: SessionStatus, parent: SessionInfo | null, minutesAgo: number, costUsd: number, cwd?: string) => SessionInfo;
type MakeMessage = (s: SessionInfo, role: 'user' | 'assistant', kind: Message['kind'], content: ContentBlock[], minutesAgo: number) => Message;

function subProjects(now: Date, session: MakeSession, msg: MakeMessage, text: (t: string) => ContentBlock): { sessions: SessionInfo[]; messages: Record<string, Message[]> } {
  const at = (minutesAgo: number) => isoAt(new Date(now.getTime() - minutesAgo * 60_000));
  /** A sub-task started `ran` minutes ago (its time in the list) and last touched `last` minutes ago. */
  const task = (id: string, title: string, status: SessionStatus, parent: SessionInfo, ran: number, last: number, cost: number): SessionInfo => ({
    ...session(id, 'worker', title, status, parent, last, cost),
    projectId: parent.projectId!,
    createdAt: at(ran),
  });
  const manager = (id: string, title: string, status: SessionStatus, projectId: string, cwd: string, minutesAgo: number, cost: number, created: number): SessionInfo => ({
    ...session(id, 'manager', title, status, null, minutesAgo, cost, cwd),
    projectId,
    createdAt: at(created),
  });
  const t1 = manager(SUB_IDS.t1, '磁件 T1', 'thinking', 'p-t1', 'D:\\工作\\机种\\磁件 T1', 1, 0.0186, 9000);
  const l1 = manager(SUB_IDS.l1, '磁件 L1', 'idle', 'p-l1', 'D:\\工作\\机种\\磁件 L1', 95, 0.0074, 8000);
  const l2 = manager(SUB_IDS.l2, '磁件 L2', 'idle', 'p-l2', 'D:\\工作\\机种\\磁件 L2', 2900, 0.0012, 7000);
  const game = manager(SUB_IDS.game, '怪物猎人: 冰原', 'idle', 'p-game', 'D:\\游戏攻略\\怪物猎人 冰原', 300, 0.0051, 6000);

  const quote = task(SUB_IDS.quote, '查报价', 'tool', t1, 16, 0, 0.0043);
  const oldParts = task(SUB_IDS.oldParts, '查旧料参考', 'thinking', t1, 10, 0, 0.0027);
  const samples: SessionInfo = { ...task(SUB_IDS.samples, '追踪样制', 'idle', t1, 58, 8, 0.0019), resident: true };
  const spec = task(SUB_IDS.spec, '整理规格书', 'done', t1, 70, 52, 0.0031);
  const winding = task(SUB_IDS.winding, '核对绕线参数', 'done', t1, 66, 49, 0.0022);
  const heat = task(SUB_IDS.heat, '汇总温升数据', 'done', t1, 64, 47, 0.0026);
  const core = task(SUB_IDS.core, '比对磁芯规格', 'aborted', t1, 62, 55, 0.0009);
  const l1Quote = task(SUB_IDS.l1Quote, '查报价', 'done', l1, 120, 96, 0.0018);

  let k = 0;
  const call = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id: `seed-st-${++k}`, name, input });
  const result = (c: { id: string }, content: string): ContentBlock => ({ type: 'tool_result', toolUseId: c.id, content });

  const spawnQuote = call('spawn_agent', { title: '查报价', task: '向三家供应商询磁件 T1 的单价和交期，整理成表' });
  const spawnOld = call('spawn_agent', { title: '查旧料参考', task: '在旧料清单里找和 T1 规格接近的料，列出差异' });
  const spawnSample = call('spawn_agent', { title: '追踪样制', task: '每天查一次样品进度，有变化就告诉我' });
  const t1Messages = [
    msg(t1, 'user', 'user', [text('T1 打样前把报价、旧料参考和样品进度都跟上')], 17),
    msg(t1, 'assistant', 'assistant', [text('分三件事派出去：查报价、查旧料参考、追踪样制。'), spawnQuote, spawnOld, spawnSample], 16),
    msg(t1, 'user', 'tool_results', [result(spawnQuote, `已派出：查报价（${SUB_IDS.quote}）`), result(spawnOld, `已派出：查旧料参考（${SUB_IDS.oldParts}）`), result(spawnSample, `已派出：追踪样制（${SUB_IDS.samples}）`)], 16),
  ];

  const qList = call('list_dir', { path: '报价' });
  const qRead = call('read_file', { path: '报价\\供应商A.xlsx' });
  const qRead2 = call('read_file', { path: '报价\\供应商B.pdf' });
  const qRead3 = call('read_file', { path: '报价\\供应商C.pdf' });
  const quoteMessages = [
    msg(quote, 'user', 'user', [text('向三家供应商询磁件 T1 的单价和交期，整理成表')], 16),
    msg(quote, 'assistant', 'assistant', [text('先看报价文件夹里已有的回复。'), qList, qRead, qRead2], 14),
    msg(quote, 'user', 'tool_results', [result(qList, '供应商A.xlsx\n供应商B.pdf\n供应商C.pdf'), result(qRead, '单价 2.35，交期 3 周，MOQ 2k'), result(qRead2, '单价 2.18，交期 5 周，MOQ 5k')], 12),
    msg(quote, 'assistant', 'assistant', [text('A、B 两家已经有数，再看 C。'), qRead3], 1),
  ];

  const sList = call('glob', { pattern: '规格\\*.pdf' });
  const sRead = call('read_file', { path: '规格\\T1 规格书 v2.pdf' });
  const sWrite = call('write_file', { path: 'T1 规格摘要.md', content: '# T1 规格摘要\n\n- 电感量 120 µH ±10%\n- 额定电流 3.2 A\n- 温升 ≤ 40 K' });
  const specMessages = [
    msg(spec, 'user', 'user', [text('把 T1 规格书整理成一页摘要')], 70),
    msg(spec, 'assistant', 'assistant', [sList, sRead], 66),
    msg(spec, 'user', 'tool_results', [result(sList, '规格\\T1 规格书 v2.pdf'), result(sRead, '电感量 120 µH ±10%；额定电流 3.2 A；温升 ≤ 40 K；外形 EE16')], 60),
    msg(spec, 'assistant', 'assistant', [sWrite], 56),
    msg(spec, 'user', 'tool_results', [result(sWrite, '已写入 T1 规格摘要.md')], 55),
    msg(spec, 'assistant', 'assistant', [text('摘要写好了：电感量 120 µH ±10%，额定电流 3.2 A，温升不超过 40 K，外形 EE16。放在 T1 规格摘要.md。')], 52),
  ];

  const sampleRead = call('read_file', { path: '样制\\进度.xlsx' });
  const sampleMessages = [
    msg(samples, 'user', 'user', [text('每天查一次样品进度，有变化就告诉我')], 58),
    msg(samples, 'assistant', 'assistant', [sampleRead], 9),
    msg(samples, 'user', 'tool_results', [result(sampleRead, '绕线完成 20/20；浸漆 12/20；预计周五出样')], 9),
    msg(samples, 'assistant', 'assistant', [text('今天的进度：绕线 20 台都完成了，浸漆 12/20，预计周五出样。')], 8),
  ];

  const done = (s: SessionInfo, ask: string, answer: string) => [msg(s, 'user', 'user', [text(ask)], 60), msg(s, 'assistant', 'assistant', [text(answer)], 48)];

  return {
    sessions: [t1, l1, l2, game, quote, oldParts, samples, spec, winding, heat, core, l1Quote],
    messages: {
      [t1.id]: t1Messages,
      [l1.id]: [msg(l1, 'user', 'user', [text('L1 先把报价拿到')], 125)],
      [l2.id]: [],
      [game.id]: [msg(game, 'user', 'user', [text('整理冰原里大剑的配装')], 310), msg(game, 'assistant', 'assistant', [text('先按上位和大师级各出一套。')], 300)],
      [quote.id]: quoteMessages,
      [oldParts.id]: [msg(oldParts, 'user', 'user', [text('在旧料清单里找和 T1 规格接近的料，列出差异')], 10)],
      [samples.id]: sampleMessages,
      [spec.id]: specMessages,
      [winding.id]: done(winding, '核对 T1 的绕线参数和规格书是否一致', '匝数、线径都和规格书一致；层间胶带规格书写 2 层，图纸写 3 层，已标出。'),
      [heat.id]: done(heat, '汇总上一版的温升数据', '三台样品温升 31 K、33 K、35 K，都在 40 K 以内。'),
      [core.id]: [msg(core, 'user', 'user', [text('比对两家磁芯的规格')], 62)],
      [l1Quote.id]: done(l1Quote, '向两家供应商询磁件 L1 的价', '两家都回了：1.12 和 1.05，交期都是 4 周。'),
    },
  };
}

/** The sub-projects' activity (getProject's recentLog), newest first. */
export function subProjectLog(projectId: string, now: Date): ProjectLogEntry[] {
  const at = (minutesAgo: number) => isoAt(new Date(now.getTime() - minutesAgo * 60_000));
  const e = (n: number, sessionId: string, minutesAgo: number, action: ProjectLogEntry['action'], target: string, detail?: string): ProjectLogEntry => ({
    id: `seed-log-${projectId}-${n}`,
    projectId,
    sessionId,
    at: at(minutesAgo),
    action,
    target,
    ...(detail ? { detail } : {}),
    summary: '',
  });
  if (projectId === 'p-t1')
    return [
      e(8, SUB_IDS.samples, 8, 'child.report', '追踪样制', '浸漆 12/20，预计周五出样'),
      e(7, SUB_IDS.t1, 16, 'child.spawn', '追踪样制'),
      e(6, SUB_IDS.t1, 16, 'child.spawn', '查旧料参考'),
      e(5, SUB_IDS.t1, 16, 'child.spawn', '查报价'),
      e(4, SUB_IDS.heat, 47, 'child.report', '汇总温升数据', '三台温升都在 40 K 以内'),
      e(3, SUB_IDS.spec, 55, 'file.write', 'T1 规格摘要.md'),
    ];
  if (projectId === 'p-l1') return [e(1, SUB_IDS.l1Quote, 96, 'child.report', '查报价', '两家都回了')];
  if (projectId === 'p-game') return [e(1, SUB_IDS.game, 300, 'file.write', '大剑配装.md')];
  return [];
}
