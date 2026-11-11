// Words for the inbox: what the core decided about each mail (MailItem from
// @spica/protocol), written in the interface language. The core sends only
// structured fields; everything the user reads is made here.
import type { MailItem } from '@spica/protocol';

export type MailTone = 'pending' | 'project' | 'new' | 'ignore';

export interface MailVerdict {
  tone: MailTone;
  /** e.g. 「归到 网站改版」「新事务」「不用管」「正在分类」 */
  text: string;
  /** The user already handled it: 「已采纳」「已忽略」「你改的」; empty when not. */
  handled: string;
}

/** The project's name, or a placeholder when it is gone. */
export type ProjectName = (projectId: string) => string | undefined;

export function verdictOf(item: MailItem, projectName: ProjectName): MailVerdict {
  const t = item.triage;
  const fb = item.feedback;
  if (fb?.action === 'ignore') return { tone: 'ignore', text: '无需处理', handled: '已忽略' };
  if (item.status === 'new' || !t) return { tone: 'pending', text: '分类中', handled: '' };
  const handled = fb?.action === 'accept' ? '已采纳' : fb?.action === 'reassign' ? '已更改' : '';
  if (t.decision === 'project') {
    const name = (t.projectId && projectName(t.projectId)) || '已删除的项目';
    return { tone: 'project', text: `归入 ${name}`, handled };
  }
  if (t.decision === 'new') return { tone: 'new', text: t.suggestion ? `新事务：${t.suggestion}` : '新事务', handled };
  return { tone: 'ignore', text: '无需处理', handled };
}

/** Why it was sorted this way, in words; empty when there is nothing to add. */
export function reasonOf(item: MailItem): string {
  const t = item.triage;
  if (!t || item.status === 'new') return '';
  if (item.feedback?.action === 'reassign') return '';
  if (t.by === 'rule') return '按规则忽略';
  if (t.by === 'sender_memory') return t.decision === 'ignore' ? '曾被忽略' : '该发件人的邮件曾归入此项目';
  return t.reason.trim();
}

/** How sure the sorting was; only for the model's own decisions. */
export function surenessOf(item: MailItem): string {
  const t = item.triage;
  if (!t || item.status === 'new' || t.by !== 'model' || item.feedback) return '';
  if (t.confidence >= 0.8) return '置信度高';
  if (t.confidence >= 0.5) return '置信度中';
  return '置信度低';
}

/** Sorted and not yet handled by the user. */
export function needsYou(item: MailItem): boolean {
  return item.status !== 'new' && !item.feedback;
}

/** 「10:32」 today, 「11月8日」 on other days. */
export function mailTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** Newest first (received time, else when the core first saw it). */
export function byReceived(a: MailItem, b: MailItem): number {
  const t = (m: MailItem) => Date.parse(m.receivedAt ?? '') || Date.parse(m.createdAt) || 0;
  return t(b) - t(a);
}
