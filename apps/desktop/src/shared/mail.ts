// Words for the inbox: what the core decided about each mail (MailItem from
// @spica/protocol), written in the interface language. The core sends only
// structured fields; everything the user reads is made here.
import type { MailItem } from '@spica/protocol';
import { t } from './i18n';

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
  const tr = item.triage;
  const fb = item.feedback;
  if (fb?.action === 'ignore') return { tone: 'ignore', text: t('无需处理'), handled: t('已忽略') };
  if (item.status === 'new' || !tr) return { tone: 'pending', text: t('分类中'), handled: '' };
  const handled = fb?.action === 'accept' ? t('已采纳') : fb?.action === 'reassign' ? t('已更改') : '';
  if (tr.decision === 'project') {
    const name = (tr.projectId && projectName(tr.projectId)) || t('已删除的项目');
    return { tone: 'project', text: t('归入 {project}', { project: name }), handled };
  }
  if (tr.decision === 'new') return { tone: 'new', text: tr.suggestion ? t('新事务：{name}', { name: tr.suggestion }) : t('新事务'), handled };
  return { tone: 'ignore', text: t('无需处理'), handled };
}

/** Why it was sorted this way, in words; empty when there is nothing to add. */
export function reasonOf(item: MailItem): string {
  const tr = item.triage;
  if (!tr || item.status === 'new') return '';
  if (item.feedback?.action === 'reassign') return '';
  if (tr.by === 'rule') return t('按规则忽略');
  if (tr.by === 'sender_memory') return tr.decision === 'ignore' ? t('曾被忽略') : t('该发件人的邮件曾归入此项目');
  return tr.reason.trim();
}

/** How sure the sorting was; only for the model's own decisions. */
export function surenessOf(item: MailItem): string {
  const tr = item.triage;
  if (!tr || item.status === 'new' || tr.by !== 'model' || item.feedback) return '';
  if (tr.confidence >= 0.8) return t('置信度高');
  if (tr.confidence >= 0.5) return t('置信度中');
  return t('置信度低');
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
  return t('{month}月{day}日', { month: d.getMonth() + 1, day: d.getDate() });
}

/** Newest first (received time, else when the core first saw it). */
export function byReceived(a: MailItem, b: MailItem): number {
  const at = (m: MailItem) => Date.parse(m.receivedAt ?? '') || Date.parse(m.createdAt) || 0;
  return at(b) - at(a);
}
