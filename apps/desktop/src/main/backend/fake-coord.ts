// Demo for 由项目经理确认子任务的操作 (SPICA_DEMO_COORD=1, not in installed builds): a project whose manager answers
// its sub-agents' confirmations. One sub-agent's card is handed to the manager, which allows it a few seconds after
// the card is first shown; one the manager declines; one only the user may answer (无法撤销); one finished earlier
// whose command the manager allowed (the record in its history).
import type { ContentBlock, ConfirmAnswer, ConfirmDelegate, Message, PendingItem, SessionInfo, SessionStatus } from '@spica/protocol';
import { isoAt } from './time';

export const COORD_IDS = {
  pm: 's-cd-pm',
  report: 's-cd-report',
  sync: 's-cd-sync',
  clean: 's-cd-clean',
  numbers: 's-cd-numbers',
} as const;

export const COORD_PROJECT = { id: 'p-cd', name: '样机测试', folder: 'D:\\工作\\样机测试' } as const;

const MANAGER: ConfirmDelegate = { sessionId: COORD_IDS.pm, title: COORD_PROJECT.name };

/** What the manager answers when a handed-over card is first shown (call id → its answer). */
export const COORD_ANSWERS: Record<string, ConfirmAnswer> = {
  'cd-report-run': { ...MANAGER, approved: true, reason: '在项目文件夹内合并三份测试报告，只写入 汇总.xlsx，与任务一致' },
  'cd-sync-write': { ...MANAGER, approved: false, reason: '任务要求结果放在项目文件夹内，不需要写入 D:\\共享\\评审' },
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
  const report = session(COORD_IDS.report, 'worker', '整理测试报告', 'awaiting_confirm', 1, 0.0031);
  const sync = session(COORD_IDS.sync, 'worker', '同步评审表', 'awaiting_confirm', 1, 0.0018);
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

  const numbersAnswer: ConfirmAnswer = { ...MANAGER, approved: true, reason: '只读取 报告 文件夹并输出编号清单，不修改文件' };
  const pmMessages = [
    msg(pm, 'user', 'user', [text('把三份样机测试报告整理成汇总表，核对报告编号，同步评审表，清掉 2025 年的旧日志')], 22),
    msg(
      pm,
      'assistant',
      'assistant',
      [
        text('分四件事派出去。'),
        call('cd-sp-1', 'spawn_agent', { title: '核对报告编号', task: '核对三份测试报告的编号是否连续、有无重复' }),
        call('cd-sp-2', 'spawn_agent', { title: '整理测试报告', task: '把三份测试报告合并成 汇总.xlsx' }),
        call('cd-sp-3', 'spawn_agent', { title: '同步评审表', task: '把评审表更新为最新的测试结论' }),
        call('cd-sp-4', 'spawn_agent', { title: '清理旧日志', task: '删除 日志\\2025 文件夹' }),
      ],
      21,
    ),
    msg(pm, 'user', 'tool_results', [result('cd-sp-1', `已派出：核对报告编号（${numbers.id}）`), result('cd-sp-2', `已派出：整理测试报告（${report.id}）`), result('cd-sp-3', `已派出：同步评审表（${sync.id}）`), result('cd-sp-4', `已派出：清理旧日志（${clean.id}）`)], 21),
    msg(pm, 'assistant', 'assistant', [call('cd-ans-1', 'answer_confirmation', { agent: numbers.id, call_id: 'cd-numbers-run', approve: true, reason: numbersAnswer.reason })], 12),
    msg(pm, 'user', 'tool_results', [result('cd-ans-1', 'Allowed once. 核对报告编号 continues.')], 12, { toolInfo: { 'cd-ans-1': { category: 'agent', title: '核对报告编号' } } }),
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
  const cleanCommand = 'Remove-Item 日志\\2025 -Recurse -Force';
  return {
    sessions: [pm, numbers, report, sync, clean],
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
      [clean.id]: [
        msg(clean, 'user', 'user', [text('删除 日志\\2025 文件夹')], 20),
        msg(clean, 'assistant', 'assistant', [call('cd-clean-run', 'run_command', { command: cleanCommand, description: '删除 2025 年的日志' })], 2),
      ],
    },
    pending: {
      [report.id]: [{ kind: 'confirm', callId: 'cd-report-run', toolName: 'run_command', input: { command: reportCommand, description: '合并测试报告' }, reason: 'irreversible action', delegated: MANAGER, createdAt: at(1) }],
      [sync.id]: [{ kind: 'confirm', callId: 'cd-sync-write', toolName: 'write_file', input: { path: syncPath, content: '…' }, reason: 'writes a file outside the folders of this conversation', cause: 'outside_folder', outsideFolder: 'D:\\共享\\评审', delegated: MANAGER, createdAt: at(1) }],
      [clean.id]: [{ kind: 'confirm', callId: 'cd-clean-run', toolName: 'run_command', input: { command: cleanCommand, description: '删除 2025 年的日志' }, reason: 'irreversible action', createdAt: at(2) }],
    },
  };
}
