// The fake backend's mailbox: a few fictional mails already sorted into the
// demo projects, plus one more on every pollMail(). Same MailItem shape and
// mail.* events as the core's mail pipeline (docs/design/agent-core.md, M6).
import type { CoreEventBody, MailFeedback, MailItem, MailPollResult, MailTriage } from '@spica/protocol';
import { isoAt } from './time';
import { SEED_IDS } from './fake-seed';

/** The demo projects (manager session ids from the seed). */
export const FAKE_PROJECTS = [
  { id: 'p-review', name: '新品样机评审', managerSessionId: SEED_IDS.pm },
  { id: 'p-budget', name: '年度预算', managerSessionId: SEED_IDS.pm2 },
] as const;

/** The triage thread's session id (events of the mail pipeline carry it). */
export const FAKE_MAIL_THREAD = 's-mail';

type Emit = (sessionId: string, body: CoreEventBody) => void;

export class FakeMailbox {
  readonly #now: () => Date;
  readonly #emit: Emit;
  readonly #wait: (ms: number) => Promise<void>;
  readonly #items = new Map<string, MailItem>();
  readonly #projects: () => readonly { id: string; managerSessionId: string }[];
  #polls = 0;

  constructor(
    now: () => Date,
    emit: Emit,
    wait: (ms: number) => Promise<void>,
    seed = true,
    projects: () => readonly { id: string; managerSessionId: string }[] = () => FAKE_PROJECTS,
  ) {
    this.#projects = projects;
    this.#now = now;
    this.#emit = emit;
    this.#wait = wait;
    if (seed) for (const m of seedMail(now())) this.#items.set(m.id, m);
  }

  list(filter: { status?: MailItem['status']; projectId?: string; limit?: number } = {}): MailItem[] {
    let out = [...this.#items.values()];
    if (filter.status) out = out.filter((m) => m.status === filter.status);
    if (filter.projectId) out = out.filter((m) => m.triage?.projectId === filter.projectId);
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  async poll(): Promise<MailPollResult> {
    const n = ++this.#polls;
    const at = isoAt(this.#now());
    const item: MailItem = {
      id: `demo:poll-${n}`,
      sourceId: 'demo',
      messageId: `poll-${n}`,
      fromName: '测试组 赵工',
      fromAddress: 'zhao@example.com',
      subject: `样机第 ${n + 2} 轮测试结果`,
      receivedAt: at,
      preview: '附件是这一轮的测试数据，跌落和温升两项需要再看一下。',
      status: 'new',
      createdAt: at,
      updatedAt: at,
    };
    this.#put(item);
    this.#emit(FAKE_MAIL_THREAD, { type: 'mail.polled', sourceId: 'demo', fetched: 1, added: 1 });
    await this.#wait(1200);
    const triaged = this.#put({
      ...item,
      status: 'triaged',
      triage: { decision: 'project', projectId: 'p-review', reason: '讲的是样机测试结果，属于新品样机评审。', confidence: 0.86, by: 'model', at: isoAt(this.#now()) },
      updatedAt: isoAt(this.#now()),
    });
    this.#emit(FAKE_MAIL_THREAD, { type: 'mail.triaged', item: triaged });
    const routed = this.#put({ ...triaged, status: 'routed', routedTo: SEED_IDS.pm, updatedAt: isoAt(this.#now()) });
    this.#emit(FAKE_MAIL_THREAD, { type: 'mail.routed', item: routed, managerSessionId: SEED_IDS.pm });
    return { fetched: 1, added: 1, triaged: 1, routed: 1 };
  }

  feedback(mailId: string, fb: { action: MailFeedback['action']; projectId?: string }): MailItem {
    const item = this.#items.get(mailId);
    if (!item) throw new Error(`unknown mail: ${mailId}`);
    const at = isoAt(this.#now());
    const feedback: MailFeedback = { action: fb.action, ...(fb.projectId ? { projectId: fb.projectId } : {}), at };
    let next: MailItem = { ...item, feedback, updatedAt: at };
    if (fb.action === 'ignore') next = { ...next, status: 'ignored' };
    if (fb.action === 'reassign') {
      const project = this.#projects().find((p) => p.id === fb.projectId);
      if (!project) throw new Error('reassign needs an existing projectId');
      const triage: MailTriage = { decision: 'project', projectId: project.id, reason: 'put here by the user', confidence: 1, by: item.triage?.by ?? 'model', at };
      next = { ...next, status: 'routed', triage, routedTo: project.managerSessionId };
    }
    this.#put(next);
    this.#emit(FAKE_MAIL_THREAD, { type: 'mail.feedback', item: next });
    if (fb.action === 'reassign' && next.routedTo) this.#emit(FAKE_MAIL_THREAD, { type: 'mail.routed', item: next, managerSessionId: next.routedTo });
    return next;
  }

  #put(m: MailItem): MailItem {
    this.#items.set(m.id, m);
    return m;
  }
}

/** Fictional mail in every state the inbox draws. */
export function seedMail(now: Date): MailItem[] {
  const at = (minutesAgo: number) => isoAt(new Date(now.getTime() - minutesAgo * 60_000));
  const mail = (
    n: number,
    minutesAgo: number,
    from: [string, string],
    subject: string,
    preview: string,
    status: MailItem['status'],
    triage: Omit<MailTriage, 'at'>,
    extra: Partial<MailItem> = {},
  ): MailItem => ({
    id: `demo:m${n}`,
    sourceId: 'demo',
    messageId: `m${n}`,
    fromName: from[0],
    fromAddress: from[1],
    subject,
    receivedAt: at(minutesAgo),
    preview,
    status,
    triage: { ...triage, at: at(minutesAgo - 1) },
    createdAt: at(minutesAgo - 1),
    updatedAt: at(minutesAgo - 2),
    ...extra,
  });
  return [
    mail(1, 12, ['采购部 王工', 'wang@example.com'], '外壳模具报价补充说明', '上次报价漏了二次开模的费用，补充如下，请评审时一并考虑。', 'routed',
      { decision: 'project', projectId: 'p-review', reason: '讲的是样机外壳模具的报价，属于新品样机评审。', confidence: 0.91, by: 'model' }, { routedTo: SEED_IDS.pm }),
    mail(2, 40, ['财务部 李会计', 'li@example.com'], '三季度费用报销截止提醒', '三季度费用请在本月 20 日前提交，逾期顺延到下季度。', 'routed',
      { decision: 'project', projectId: 'p-budget', reason: 'same sender as an earlier mail you put in this project', confidence: 1, by: 'sender_memory' }, { routedTo: SEED_IDS.pm2 }),
    mail(3, 65, ['供应商 陈经理', 'chen@example.com'], '关于交期的说明', '受原材料影响，第二批交期可能推迟一周，具体以下周确认为准。', 'routed',
      { decision: 'project', projectId: 'p-review', reason: '提到样机零件的交期，可能和样机评审有关。', confidence: 0.58, by: 'model' }, { routedTo: SEED_IDS.pm }),
    mail(4, 90, ['行政部', 'admin@example.com'], '季度团建活动征集意见', '本季度团建拟定在月底，请各部门在周五前反馈人数和偏好。', 'triaged',
      { decision: 'new', suggestion: '季度团建', reason: '和现有项目都无关，是一件新的事。', confidence: 0.62, by: 'model' }),
    mail(5, 130, ['行业周刊', 'news@example.com'], '本周行业资讯', '本期内容：新材料、展会预告、政策解读。', 'ignored',
      { decision: 'ignore', reason: '订阅的资讯，不需要处理。', confidence: 0.95, by: 'model' }),
    mail(6, 300, ['会议室系统', 'rooms@example.com'], '会议室预订成功', '你预订的 3 号会议室（周四 14:00–15:00）已确认。', 'ignored',
      { decision: 'ignore', reason: '系统通知，不需要处理。', confidence: 0.88, by: 'model' }, { feedback: { action: 'accept', at: at(250) } }),
  ];
}
