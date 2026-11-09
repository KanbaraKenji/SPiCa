// Demo data for the fake backend: a neutral, fictional workspace with one
// finished conversation, two projects and their sub-agents in every state the
// UI has to draw. Used by screenshots, so keep it stable.
import type { ContentBlock, FileCardMeta, Message, PendingItem, SessionInfo, SessionStatus, AgentRole } from '@spica/protocol';
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
    model: 'fake-model',
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

  return {
    sessions: [chat, chat2, pm, quotes, tests, minutes, pm2, budget],
    messages: {
      [chat.id]: chatMessages,
      [chat2.id]: [msg(chat2, 'user', 'user', [text('把本周来信按项目归一下类')], 190), msg(chat2, 'assistant', 'assistant', [text('本周一共 14 封来信：样机评审 6 封、年度预算 3 封，其余 5 封是通知类，不需要处理。')], 180)],
      [pm.id]: [msg(pm, 'user', 'user', [text('周四前把评审材料准备齐')], 20)],
      [quotes.id]: [msg(quotes, 'user', 'user', [text('把报价单里各家的单价和交期整理成表')], 10)],
      [tests.id]: [msg(tests, 'user', 'user', [text('汇总三份测试报告的结论')], 9)],
      [minutes.id]: minutesMessages,
      [pm2.id]: [],
      [budget.id]: [msg(budget, 'user', 'user', [text('核对三季度支出和预算的差额')], 1460), msg(budget, 'assistant', 'assistant', [text('三季度实际支出比预算低 4.2%，差额主要在差旅。')], 1450)],
    },
    pending: {
      [minutes.id]: [{ kind: 'ask', callId: 'seed-ask-1', question: '纪要按哪种口径写？', options: ['只写结论', '结论加讨论过程', '按议题逐条写'], createdAt: at(3) }],
    },
  };
}
