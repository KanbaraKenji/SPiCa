// Demo conversations for the 定时任务 mock-up (SPICA_DEMO_SCHEDULE=1, development only): runs a schedule started
// (one done, one waiting for a confirmation) and conversations in which the agent set one up. The schedules
// themselves are the window's demo list (renderer/src/schedule/demo.ts), which names these ids.
import type { ContentBlock, Message, PendingItem, SessionInfo, SessionStatus } from '@spica/protocol';
import type { Seed } from './fake-seed';
import { isoAt } from './time';

export const SCHEDULE_IDS = {
  report: 'sch-run-report',
  orders: 'sch-run-orders',
  sameChat: 'sch-chat-same',
  sameWaiting: 'sch-chat-waiting',
  newChat: 'sch-chat-new',
  listChat: 'sch-chat-list',
} as const;

export function buildScheduleSeed(now: Date): Seed {
  const day = (offset: number, h: number, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, h, m);
  const iso = (d: Date) => isoAt(d);
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  const session = (id: string, title: string, status: SessionStatus, updated: Date, cwd: string, cost: number): SessionInfo => ({
    id,
    parentId: null,
    parentChain: [],
    role: 'top',
    title,
    status,
    providerId: 'fake',
    model: 'deepseek-flash',
    cwd,
    costUsd: cost,
    approvalMode: 'manual',
    contextTokens: null,
    contextWindow: null,
    createdAt: iso(new Date(updated.getTime() - 3 * 60_000)),
    updatedAt: iso(updated),
  });
  let n = 0;
  const msg = (s: SessionInfo, role: 'user' | 'assistant', kind: Message['kind'], content: ContentBlock[], at: Date, meta: Record<string, unknown> = {}): Message => ({
    id: `sch-m-${++n}`,
    sessionId: s.id,
    seq: n,
    role,
    kind,
    content,
    createdAt: iso(at),
    meta: role === 'user' ? { author: kind === 'tool_results' ? 'runtime' : 'user', ...meta } : meta,
  });
  const text = (t: string): ContentBlock => ({ type: 'text', text: t });
  /** The line a run starts with: which schedule, when (meta.scheduleRun; the prompt is the schedule's). */
  const runNote = (s: SessionInfo, title: string, at: Date) => msg(s, 'user', 'note', [text(title)], at, { author: 'runtime', scheduleRun: { title, at: iso(at) } });

  // A run in a new conversation: done this morning.
  const reportAt = day(0, 9);
  const report = session(SCHEDULE_IDS.report, '每日报表', 'idle', new Date(reportAt.getTime() + 2 * 60_000), 'D:\\工作\\报表', 0.0031);
  const reportFile = `D:\\工作\\报表\\出货来单_${reportAt.getFullYear()}-${String(reportAt.getMonth() + 1).padStart(2, '0')}-${String(reportAt.getDate()).padStart(2, '0')}.xlsx`;
  const reportMessages = [
    runNote(report, '每日报表', reportAt),
    msg(report, 'user', 'user', [text('汇总昨天的出货和来单，按客户列成表，存到 报表 文件夹，文件名带日期。')], reportAt),
    msg(report, 'assistant', 'assistant', [
      { type: 'tool_use', id: 'sch-c-1', name: 'list_dir', input: { path: '出货' } },
      { type: 'tool_use', id: 'sch-c-2', name: 'read_file', input: { path: '来单\\昨日来单.csv' } },
      { type: 'tool_use', id: 'sch-c-3', name: 'write_file', input: { path: reportFile.replace('D:\\工作\\报表\\', '') } },
    ], new Date(reportAt.getTime() + 30_000)),
    msg(report, 'user', 'tool_results', [
      { type: 'tool_result', toolUseId: 'sch-c-1', content: '出货_明细.csv\n出货_汇总.csv' },
      { type: 'tool_result', toolUseId: 'sch-c-2', content: '客户,单号,数量\n华东精密,A-1182,400\n启明电子,A-1183,120' },
      { type: 'tool_result', toolUseId: 'sch-c-3', content: `Wrote ${reportFile}` },
    ], new Date(reportAt.getTime() + 60_000)),
    msg(report, 'assistant', 'assistant', [
      text(
        `昨天出货 38 单、来单 41 单，按客户列好了：\n\n| 客户 | 出货 | 来单 |\n|---|---|---|\n| 华东精密 | 12 | 15 |\n| 启明电子 | 9 | 8 |\n| 远航塑胶 | 7 | 10 |\n| 其他 6 家 | 10 | 8 |\n\n已存到 ${reportFile}。`,
      ),
    ], new Date(reportAt.getTime() + 2 * 60_000)),
  ];

  // A run in a new conversation: stopped at a confirmation an hour ago, nobody there.
  const ordersAt = ago(73);
  const orders = session(SCHEDULE_IDS.orders, '来单汇总', 'awaiting_confirm', new Date(ordersAt.getTime() + 60_000), 'D:\\工作\\来单', 0.0012);
  const mail = { to: 'alex.chen@example.com', subject: '加急订单 3 单', body: '今天新到 3 张加急订单：A-1190、A-1191、A-1195，明细见附件 来单汇总.xlsx。' };
  const ordersMessages = [
    runNote(orders, '来单汇总', ordersAt),
    msg(orders, 'user', 'user', [text('查看 来单 文件夹里新到的订单，汇总成一张表，有加急的单子发邮件告诉 ALEX.CHEN。')], ordersAt),
    msg(orders, 'assistant', 'assistant', [{ type: 'tool_use', id: 'sch-c-4', name: 'list_dir', input: { path: '.' } }], new Date(ordersAt.getTime() + 20_000)),
    msg(orders, 'user', 'tool_results', [{ type: 'tool_result', toolUseId: 'sch-c-4', content: 'A-1190.pdf\nA-1191.pdf\nA-1192.pdf\nA-1195.pdf' }], new Date(ordersAt.getTime() + 25_000)),
    msg(orders, 'assistant', 'assistant', [text('新到 4 张订单，3 张标了加急，汇总表存好了。下面这封邮件要你确认。'), { type: 'tool_use', id: 'sch-c-5', name: 'send_email', input: mail }], new Date(ordersAt.getTime() + 60_000)),
  ];

  // The agent set a schedule up in this conversation; its runs come back here.
  const setupAt = day(-3, 16, 40);
  const same = session(SCHEDULE_IDS.sameChat, '整理来信', 'idle', day(-1, 17, 2), 'D:\\工作', 0.0044);
  const sameInput = { title: '整理来信', prompt: '每天下班前把今天的来信按项目归类，接着上次的表往下写。', repeat: { kind: 'daily', time: '17:00' }, cwd: 'D:\\工作', model: 'deepseek-flash' };
  const sameMessages = [
    msg(same, 'user', 'user', [text('以后每天下班前帮我把来信按项目归一下类，接着上次的表写')], setupAt),
    msg(same, 'assistant', 'assistant', [{ type: 'tool_use', id: 'sch-c-6', name: 'schedule_task', input: sameInput }], new Date(setupAt.getTime() + 10_000)),
    msg(same, 'user', 'tool_results', [{ type: 'tool_result', toolUseId: 'sch-c-6', content: 'Scheduled 整理来信: every day at 17:00.' }], new Date(setupAt.getTime() + 40_000)),
    msg(same, 'assistant', 'assistant', [text('建好了，每天 17:00 在这个对话里整理一次。')], new Date(setupAt.getTime() + 45_000)),
    runNote(same, '整理来信', day(-2, 17)),
    msg(same, 'assistant', 'assistant', [text('11 封来信：样机评审 5 封、年度预算 2 封、通知 4 封。已接在 来信归类.xlsx 后面。')], day(-2, 17, 2)),
    runNote(same, '整理来信', day(-1, 17)),
    msg(same, 'assistant', 'assistant', [text('9 封来信：样机评审 4 封、年度预算 1 封、通知 4 封。已接在 来信归类.xlsx 后面。')], day(-1, 17, 2)),
  ];

  // Set up the same way; this morning's run waits for a confirmation.
  const waitSetup = day(-1, 10, 12);
  const waiting = session(SCHEDULE_IDS.sameWaiting, '更新交期表', 'awaiting_confirm', day(0, 8, 1), 'D:\\工作\\样机评审', 0.0027);
  const waitInput = { title: '更新交期表', prompt: '每天 8 点读一遍供应商回信，把交期更新进 交期.xlsx。', repeat: { kind: 'daily', time: '08:00' }, cwd: 'D:\\工作\\样机评审', model: 'deepseek-flash' };
  const waitingMessages = [
    msg(waiting, 'user', 'user', [text('每天早上 8 点读一遍供应商回信，把交期更新进交期表')], waitSetup),
    msg(waiting, 'assistant', 'assistant', [{ type: 'tool_use', id: 'sch-c-7', name: 'schedule_task', input: waitInput }], new Date(waitSetup.getTime() + 10_000)),
    msg(waiting, 'user', 'tool_results', [{ type: 'tool_result', toolUseId: 'sch-c-7', content: 'Scheduled 更新交期表: every day at 08:00.' }], new Date(waitSetup.getTime() + 30_000)),
    msg(waiting, 'assistant', 'assistant', [text('建好了，每天 08:00 在这个对话里更新一次。')], new Date(waitSetup.getTime() + 35_000)),
    runNote(waiting, '更新交期表', day(0, 8)),
    msg(waiting, 'assistant', 'assistant', [{ type: 'tool_use', id: 'sch-c-11', name: 'read_file', input: { path: '回信\\启明电子_1121.eml' } }], day(0, 8)),
    msg(waiting, 'user', 'tool_results', [{ type: 'tool_result', toolUseId: 'sch-c-11', content: 'L1 交期改到 12/05。' }], day(0, 8)),
    msg(waiting, 'assistant', 'assistant', [text('启明电子回信把 L1 的交期改到 12/05，用脚本改交期表里这一格。'), { type: 'tool_use', id: 'sch-c-8', name: 'run_command', input: { command: 'python 更新交期.py --row L1 --date 12/05' } }], day(0, 8, 1)),
  ];

  // The agent proposes a schedule; the card waits for the user.
  const askAt = ago(2);
  const fresh = session(SCHEDULE_IDS.newChat, '每周来单汇总', 'awaiting_confirm', askAt, 'D:\\工作\\报表', 0.0006);
  const freshInput = { title: '每周来单汇总', prompt: '汇总上周的来单，按客户和品类各列一张表，存到 报表 文件夹，文件名带周数。', repeat: { kind: 'weekly', days: [1], time: '09:00' }, cwd: 'D:\\工作\\报表', model: 'deepseek-flash' };
  const freshMessages = [
    msg(fresh, 'user', 'user', [text('以后每周一早上 9 点帮我把上周的来单汇总一下，存到报表文件夹')], ago(3)),
    msg(fresh, 'assistant', 'assistant', [text('好的，按下面这样排：'), { type: 'tool_use', id: 'sch-c-9', name: 'schedule_task', input: freshInput }], askAt),
  ];

  // Asked which schedules there are: the agent lists them.
  const listAt = ago(1);
  const list = session(SCHEDULE_IDS.listChat, '我的定时任务', 'idle', listAt, 'D:\\工作', 0.0004);
  const listMessages = [
    msg(list, 'user', 'user', [text('我现在有哪些定时任务？')], ago(2)),
    msg(list, 'assistant', 'assistant', [{ type: 'tool_use', id: 'sch-c-10', name: 'list_schedules', input: {} }], ago(2)),
    msg(list, 'user', 'tool_results', [{ type: 'tool_result', toolUseId: 'sch-c-10', content: '7 scheduled tasks' }], ago(2)),
    msg(list, 'assistant', 'assistant', [
      text(
        '一共 7 个，6 个开着：\n\n| 名称 | 重复 | 下次 | 上次 |\n|---|---|---|---|\n| 每日报表 | 每天 09:00 | 明天 09:00 | 已完成 |\n| 来单汇总 | 每 2 小时 | 今天 16:00 | 等待确认 |\n| 周报 | 每周五 17:30 | 周五 17:30 | 已完成 |\n| 备份报价单 | 每天 18:00 | 已暂停 | 失败 3 次 |\n| 提醒交样机 | 11/28 10:00 | 11/28 10:00 | — |\n| 整理来信 | 每天 17:00 | 今天 17:00 | 已完成 |\n| 更新交期表 | 每天 08:00 | 明天 08:00 | 等待确认 |\n\n来单汇总 和 更新交期表 在等你确认；备份报价单 连续 3 次找不到网络路径，已暂停。',
      ),
    ], listAt),
  ];

  const pending: Record<string, PendingItem[]> = {
    [orders.id]: [{ kind: 'confirm', callId: 'sch-c-5', toolName: 'send_email', input: mail, reason: '发送邮件给「ALEX.CHEN」', irreversible: true, cause: 'untrusted_turn', createdAt: iso(new Date(ordersAt.getTime() + 60_000)) }],
    [waiting.id]: [
      {
        kind: 'confirm',
        callId: 'sch-c-8',
        toolName: 'run_command',
        input: { command: 'python 更新交期.py --row L1 --date 12/05' },
        reason: '运行命令',
        cause: 'untrusted_turn',
        createdAt: iso(day(0, 8, 1)),
      },
    ],
    [fresh.id]: [{ kind: 'confirm', callId: 'sch-c-9', toolName: 'schedule_task', input: freshInput, reason: '新建定时任务', createdAt: iso(askAt) }],
  };
  return {
    sessions: [report, orders, same, waiting, fresh, list],
    messages: { [report.id]: reportMessages, [orders.id]: ordersMessages, [same.id]: sameMessages, [waiting.id]: waitingMessages, [fresh.id]: freshMessages, [list.id]: listMessages },
    pending,
  };
}
