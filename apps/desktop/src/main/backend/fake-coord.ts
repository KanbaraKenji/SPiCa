// Demo of a project whose sub-agents ask the project's own conversation (the upper agent) before the user
// (SPICA_DEMO_COORD=1, not in installed builds; the switch is in that conversation's 详情). A few seconds after a
// sub-agent's conversation is first opened the upper agent answers: one call it allows (no card, the row keeps who
// and why), one it hands back (its card, with the reason, and a reminder in the upper conversation). One it could not
// answer (its card, 没有回复); one only the user may answer (无法撤销: never asked of it); one finished earlier whose
// command it allowed (the record in its history).
import type { ConfirmAnswer, ConfirmDelegate, ConfirmHandover, ContentBlock, Message, PendingItem, SessionInfo, SessionStatus } from '@spica/protocol';
import { isoAt } from './time';

export const COORD_IDS = {
  pm: 's-cd-pm',
  report: 's-cd-report',
  sync: 's-cd-sync',
  chart: 's-cd-chart',
  clean: 's-cd-clean',
  numbers: 's-cd-numbers',
} as const;

/** Sub-agents whose confirmation only the user may answer (无法撤销): never asked of the upper agent. */
export const COORD_USER_ONLY: readonly string[] = [COORD_IDS.clean];

export const COORD_PROJECT = { id: 'p-cd', name: '样机测试', folder: 'D:\\工作\\样机测试' } as const;

const UPPER: ConfirmDelegate = { sessionId: COORD_IDS.pm, title: COORD_PROJECT.name };
const ASKING: ConfirmHandover = { ...UPPER, state: 'asking' };

/** What the upper agent does with a call asked of it, once the sub-agent's conversation was first opened. */
export type CoordAnswer =
  | { callId: string; allow: true; answer: ConfirmAnswer; result: string; durationMs: number; after: string }
  | { callId: string; allow: false; handover: ConfirmHandover; reminder: string; result: string; after: string };

export const COORD_ANSWERS: Record<string, CoordAnswer> = {
  [COORD_IDS.report]: {
    callId: 'cd-report-run',
    allow: true,
    answer: { ...UPPER, reason: '在项目文件夹内合并三份测试报告，只写入 汇总.xlsx，与任务一致' },
    result: 'exit code 0, 2.1 s\n已写入 汇总.xlsx（3 份报告，42 行）',
    durationMs: 2100,
    after: '汇总表已生成：汇总.xlsx，三份报告共 42 行。',
  },
  [COORD_IDS.sync]: {
    callId: 'cd-sync-write',
    allow: false,
    handover: { ...UPPER, state: 'returned', reason: '任务要求结果留在项目文件夹内，写入 D:\\共享\\评审 需要你确认' },
    reminder: '「同步评审表」要写入 D:\\共享\\评审\\评审表.xlsx，在项目文件夹以外，我没有放行。需要的话请点「处理」确认。',
    // allowed by the user's words in the upper conversation (放行)
    result: '已写入 D:\\共享\\评审\\评审表.xlsx',
    after: '评审表已更新为最新的测试结论。',
  },
};

export function coordSeed(now: Date): { sessions: SessionInfo[]; messages: Record<string, Message[]>; pending: Record<string, PendingItem[]> } {
  const at = (minutesAgo: number) => isoAt(new Date(now.getTime() - minutesAgo * 60_000));
  const session = (id: string, role: 'manager' | 'worker', title: string, status: SessionStatus, minutesAgo: number, cost: number): SessionInfo => ({
    id,
    parentId: role === 'worker' ? COORD_IDS.pm : null,
    parentChain: role === 'worker' ? [COORD_IDS.pm] : [],
    role,
    title,
    status,
    providerId: 'fake',
    model: 'deepseek-flash',
    cwd: COORD_PROJECT.folder,
    costUsd: cost,
    approvalMode: 'manual',
    contextTokens: null,
    contextWindow: null,
    projectId: COORD_PROJECT.id,
    createdAt: at(minutesAgo + 20),
    updatedAt: at(minutesAgo),
  });
  const pm = session(COORD_IDS.pm, 'manager', COORD_PROJECT.name, 'tool', 0, 0.0142);
  // asked of the upper agent: still running as far as anyone can see (no card, nothing waits on the user)
  const report = session(COORD_IDS.report, 'worker', '整理测试报告', 'tool', 1, 0.0031);
  const sync = session(COORD_IDS.sync, 'worker', '同步评审表', 'tool', 1, 0.0018);
  const chart = session(COORD_IDS.chart, 'worker', '生成趋势图', 'awaiting_confirm', 3, 0.0015);
  const clean = session(COORD_IDS.clean, 'worker', '清理旧日志', 'awaiting_confirm', 2, 0.0012);
  const numbers = session(COORD_IDS.numbers, 'worker', '核对报告编号', 'done', 9, 0.0024);

  let n = 0;
  const msg = (s: SessionInfo, role: 'user' | 'assistant', kind: Message['kind'], content: ContentBlock[], minutesAgo: number, meta: Message['meta'] = {}): Message => ({
    id: `cd-m-${++n}`,
    sessionId: s.id,
    seq: n,
    role,
    kind,
    content,
    createdAt: at(minutesAgo),
    meta: role === 'user' ? { author: kind === 'tool_results' ? 'runtime' : s.role === 'worker' && kind === 'user' ? 'parent' : 'user', ...meta } : meta,
  });
  const text = (t: string): ContentBlock => ({ type: 'text', text: t });
  const call = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name, input });
  const result = (id: string, content: string, isError = false): ContentBlock => ({ type: 'tool_result', toolUseId: id, content, ...(isError ? { isError: true } : {}) });

  const numbersAnswer: ConfirmAnswer = { ...UPPER, reason: '只读取 报告 文件夹并输出编号清单，不修改文件' };
  const spawned: [SessionInfo, string][] = [
    [numbers, '核对三份测试报告的编号是否连续、有无重复'],
    [report, '把三份测试报告合并成 汇总.xlsx'],
    [sync, '把评审表更新为最新的测试结论'],
    [chart, '用三份报告的数据生成趋势图'],
    [clean, '删除 日志\\2025 文件夹'],
  ];
  const pmMessages = [
    msg(pm, 'user', 'user', [text('把三份样机测试报告整理成汇总表，核对报告编号，同步评审表，出一张趋势图，清掉 2025 年的旧日志')], 22),
    msg(pm, 'assistant', 'assistant', [text('分五件事派出去。'), ...spawned.map(([s, task], i) => call(`cd-sp-${i}`, 'spawn_agent', { title: s.title, task }))], 21),
    msg(pm, 'user', 'tool_results', spawned.map(([s], i) => result(`cd-sp-${i}`, `已派出：${s.title}（${s.id}）`)), 21),
    msg(pm, 'assistant', 'assistant', [call('cd-ans-1', 'answer_confirmation', { agent: numbers.id, call_id: 'cd-numbers-run', allow: true, reason: numbersAnswer.reason })], 12),
    msg(pm, 'user', 'tool_results', [result('cd-ans-1', 'Allowed once. 核对报告编号 goes on.')], 12, { toolInfo: { 'cd-ans-1': { category: 'agent', title: '核对报告编号' } } }),
    msg(pm, 'assistant', 'assistant', [call('cd-wait-1', 'wait_agents', {})], 11),
  ];

  const numbersCommand = 'Get-ChildItem 报告 -Filter *.pdf | Select-Object -ExpandProperty BaseName';
  const numbersMessages = [
    msg(numbers, 'user', 'user', [text('核对三份测试报告的编号是否连续、有无重复')], 20),
    msg(numbers, 'assistant', 'assistant', [text('先列出报告文件名。'), call('cd-numbers-run', 'run_command', { command: numbersCommand, description: '列出报告编号' })], 13),
    msg(numbers, 'user', 'tool_results', [result('cd-numbers-run', 'exit code 0, 0.4 s\nTR-2611-01\nTR-2611-02\nTR-2611-03')], 12, { agentAnswered: { 'cd-numbers-run': numbersAnswer } }),
    msg(numbers, 'assistant', 'assistant', [text('三份报告编号 TR-2611-01 到 TR-2611-03，连续，无重复。')], 9),
  ];

  const reportCommand = 'python tools\\merge_reports.py 报告 --out 汇总.xlsx';
  const syncPath = 'D:\\共享\\评审\\评审表.xlsx';
  const chartCommand = 'python tools\\trend_chart.py 汇总.xlsx --out 图表\\趋势.png';
  const cleanCommand = 'Remove-Item 日志\\2025 -Recurse -Force';
  return {
    sessions: [pm, numbers, report, sync, chart, clean],
    messages: {
      [pm.id]: pmMessages,
      [numbers.id]: numbersMessages,
      [report.id]: [
        msg(report, 'user', 'user', [text('把三份测试报告合并成 汇总.xlsx')], 20),
        msg(report, 'assistant', 'assistant', [text('用项目里的合并脚本生成汇总表。'), call('cd-report-run', 'run_command', { command: reportCommand, description: '合并测试报告' })], 1),
      ],
      [sync.id]: [
        msg(sync, 'user', 'user', [text('把评审表更新为最新的测试结论')], 20),
        msg(sync, 'assistant', 'assistant', [text('评审表在共享文件夹里，直接改那一份。'), call('cd-sync-write', 'write_file', { path: syncPath, content: '…' })], 1),
      ],
      [chart.id]: [
        msg(chart, 'user', 'user', [text('用三份报告的数据生成趋势图')], 20),
        msg(chart, 'assistant', 'assistant', [text('用项目里的画图脚本。'), call('cd-chart-run', 'run_command', { command: chartCommand, description: '生成趋势图' })], 3),
      ],
      [clean.id]: [
        msg(clean, 'user', 'user', [text('删除 日志\\2025 文件夹')], 20),
        msg(clean, 'assistant', 'assistant', [call('cd-clean-run', 'run_command', { command: cleanCommand, description: '删除 2025 年的日志' })], 2),
      ],
    },
    pending: {
      [report.id]: [{ kind: 'confirm', callId: 'cd-report-run', toolName: 'run_command', input: { command: reportCommand, description: '合并测试报告' }, reason: 'irreversible action', delegated: ASKING, createdAt: at(1) }],
      [sync.id]: [{ kind: 'confirm', callId: 'cd-sync-write', toolName: 'write_file', input: { path: syncPath, content: '…' }, reason: 'writes a file outside the folders of this conversation', cause: 'outside_folder', outsideFolder: 'D:\\共享\\评审', delegated: ASKING, createdAt: at(1) }],
      // the upper agent did not answer in time: the card is the user's
      [chart.id]: [{ kind: 'confirm', callId: 'cd-chart-run', toolName: 'run_command', input: { command: chartCommand, description: '生成趋势图' }, reason: 'irreversible action', delegated: { ...UPPER, state: 'no_answer' }, createdAt: at(3) }],
      [clean.id]: [{ kind: 'confirm', callId: 'cd-clean-run', toolName: 'run_command', input: { command: cleanCommand, description: '删除 2025 年的日志' }, reason: 'irreversible action', createdAt: at(2) }],
    },
  };
}
