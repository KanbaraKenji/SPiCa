// The demo list of 定时任务 the screenshots show (mock-up data, in the demo's own words).
import type { ScheduleItem } from './model';
import type { RunCard } from './ScheduleViews';

/** The demo list, around `now`: one done this morning, one waiting, one weekly, one paused after failures, one once. */
export function demoSchedules(now: Date, runIds: { report: string; orders: string; sameChat: string; sameWaiting: string }): ScheduleItem[] {
  const at = (dayOffset: number, h: number, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, m).toISOString();
  const nextWeekday = (wd: number, h: number, m: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    while (d.getDay() !== wd || d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  };
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  return [
    {
      id: 'sch-report',
      title: '每日报表',
      prompt: '汇总昨天的出货和来单，按客户列成表，存到 报表 文件夹，文件名带日期。',
      trigger: { type: 'time', repeat: { kind: 'daily', time: '09:00' } },
      cwd: 'D:\\工作\\报表',
      model: 'deepseek-flash',
      enabled: true,
      output: 'new',
      nextAt: at(1, 9),
      runs: [
        { id: 'r1', at: at(0, 9), status: 'done', sessionId: runIds.report },
        { id: 'r2', at: at(-1, 9), status: 'done' },
        { id: 'r3', at: at(-2, 9), status: 'done' },
      ],
    },
    {
      id: 'sch-orders',
      title: '来单汇总',
      prompt: '查看 来单 文件夹里新到的订单，汇总成一张表，有加急的单子发邮件告诉 ALEX.CHEN。',
      trigger: { type: 'time', repeat: { kind: 'interval', minutes: 120 } },
      cwd: 'D:\\工作\\来单',
      model: 'deepseek-flash',
      enabled: true,
      output: 'new',
      nextAt: new Date(now.getTime() + 47 * 60_000).toISOString(),
      runs: [
        { id: 'r4', at: ago(73), status: 'waiting', sessionId: runIds.orders },
        { id: 'r5', at: ago(193), status: 'done' },
      ],
    },
    {
      id: 'sch-weekly',
      title: '周报',
      prompt: '把这周的报表合成一份周报，列出本周和上周的差别。',
      trigger: { type: 'time', repeat: { kind: 'weekly', days: [5], time: '17:30' } },
      cwd: 'D:\\工作\\报表',
      model: 'deepseek-pro',
      enabled: true,
      output: 'new',
      nextAt: nextWeekday(5, 17, 30),
      runs: [{ id: 'r6', at: at(-7, 17, 30), status: 'done' }],
    },
    {
      id: 'sch-backup',
      title: '备份报价单',
      prompt: '把 报价 文件夹复制到 \\\\nas\\备份\\报价，按日期建子文件夹。',
      trigger: { type: 'time', repeat: { kind: 'daily', time: '18:00' } },
      cwd: 'D:\\工作\\样机评审',
      model: 'deepseek-flash',
      enabled: false,
      output: 'new',
      nextAt: null,
      pausedAfterFailures: 3,
      runs: [
        { id: 'r7', at: at(-1, 18), status: 'failed', reason: '找不到网络路径' },
        { id: 'r8', at: at(-2, 18), status: 'failed', reason: '找不到网络路径' },
        { id: 'r9', at: at(-3, 18), status: 'failed', reason: '找不到网络路径' },
      ],
    },
    {
      id: 'sch-sample',
      title: '提醒交样机',
      prompt: '看一下样机评审的进度，还没交的列出来。',
      trigger: { type: 'time', repeat: { kind: 'once', at: at(6, 10) } },
      cwd: 'D:\\工作\\样机评审',
      model: 'deepseek-flash',
      enabled: true,
      output: 'new',
      nextAt: at(6, 10),
      runs: [],
    },
    {
      id: 'sch-same',
      title: '整理来信',
      prompt: '每天下班前把今天的来信按项目归类，接着上次的表往下写。',
      trigger: { type: 'time', repeat: { kind: 'daily', time: '17:00' } },
      cwd: 'D:\\工作',
      model: 'deepseek-flash',
      enabled: true,
      output: 'same',
      sessionId: runIds.sameChat,
      nextAt: at(0, 17),
      runs: [
        { id: 'r10', at: at(-1, 17), status: 'done', sessionId: runIds.sameChat },
        { id: 'r11', at: at(-2, 17), status: 'done', sessionId: runIds.sameChat },
      ],
    },
    {
      id: 'sch-same-2',
      title: '更新交期表',
      prompt: '每天 8 点读一遍供应商回信，把交期更新进 交期.xlsx。',
      trigger: { type: 'time', repeat: { kind: 'daily', time: '08:00' } },
      cwd: 'D:\\工作\\样机评审',
      model: 'deepseek-flash',
      enabled: true,
      output: 'same',
      sessionId: runIds.sameWaiting,
      nextAt: at(1, 8),
      runs: [{ id: 'r12', at: at(0, 8), status: 'waiting', sessionId: runIds.sameWaiting }],
    },
  ];
}

/** What the form shows filled in, in the pictures of 新建. */
export const DEMO_FORM = { title: '每日报表', prompt: '汇总昨天的出货和来单，按客户列成表，存到 报表 文件夹，文件名带日期。', cwd: 'D:\\工作\\报表' };

/** 收件箱's 定时任务 cards for the demo list: the runs waiting for a confirmation, the task paused after failures. */
export function demoRunCards(items: ScheduleItem[]): RunCard[] {
  const out: RunCard[] = [];
  const what: Record<string, string> = { 'sch-orders': '发送邮件给「ALEX.CHEN」', 'sch-same-2': '运行命令' };
  for (const s of items) {
    const run = s.runs[0];
    if (run?.status === 'waiting') out.push({ id: `rc-${s.id}`, title: s.title, status: 'waiting', at: run.at, what: what[s.id] ?? '', ...(run.sessionId ? { sessionId: run.sessionId } : {}), scheduleId: s.id });
    else if (!s.enabled && s.pausedAfterFailures && run) out.push({ id: `rc-${s.id}`, title: s.title, status: 'failed', at: run.at, what: `连续 ${s.pausedAfterFailures} 次失败：${run.reason ?? ''}`, scheduleId: s.id });
  }
  return out;
}
