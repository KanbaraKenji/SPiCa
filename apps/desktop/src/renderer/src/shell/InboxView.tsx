// 收件箱: mail the core fetched through a mail plugin and sorted into projects.
// Each mail shows where it went and why; the user accepts, ignores or moves
// it. Only suggestions: nothing here sends, moves or marks mail.
import { useMemo, useState, type ReactNode } from 'react';
import type { MailItem } from '@spica/protocol';
import { byReceived, mailTime, needsYou, reasonOf, surenessOf, verdictOf } from '../../../shared/mail';
import type { MailPrefs } from '../../../shared/settings';
import type { MailView } from '../store/mail';
import { ContextMenu } from '../ui/ContextMenu';
import { Icon } from '../ui/Icon';
import { GUARD_FLAG_TEXT } from '../chat/format';
import { SpicaStatusIcon } from '@spica/brand/react';
import { t, tx } from '../../../shared/i18n';

export interface InboxProject {
  id: string;
  name: string;
  managerSessionId: string;
}

export interface InboxViewProps {
  mail: MailView;
  /** 模拟模式 is on: the mail is the plugins' demo data. */
  mock?: boolean;
  prefs: MailPrefs;
  projects: InboxProject[];
  onPoll(): void;
  onAccept(mailId: string): void;
  onIgnore(mailId: string): void;
  onMove(mailId: string, projectId: string): void;
  /** A 「新事务」 mail: start a project named after the suggestion, then move the mail into it. */
  onNewProject?: (item: MailItem) => void;
  onOpenSession(sessionId: string): void;
  onOpenSettings(): void;
  onDismissProblem(): void;
  /** For tests and screenshots. */
  now?: Date;
  /** Cards above the mail under 待确认 (定时任务 runs waiting for the user, tasks off after failing). */
  before?: ReactNode;
}

type Filter = 'todo' | 'all';

function MailCard({ item, props, onMoveMenu }: { item: MailItem; props: InboxViewProps; onMoveMenu(item: MailItem, button: HTMLElement): void }) {
  const nameOf = (pid: string) => props.projects.find((p) => p.id === pid)?.name;
  const verdict = verdictOf(item, nameOf);
  const reason = reasonOf(item);
  const sure = surenessOf(item);
  const open = needsYou(item);
  const tri = item.triage;
  const others = props.projects.filter((p) => p.id !== tri?.projectId);
  const manager = item.routedTo ?? (tri?.projectId ? props.projects.find((p) => p.id === tri.projectId)?.managerSessionId : undefined);
  return (
    <article className={open ? 'mail-card is-open' : 'mail-card'} aria-label={item.subject || t('无主题')}>
      <div className="mail-top">
        <span className="mail-from" title={item.fromAddress ?? ''}>
          {item.fromName || item.fromAddress || '—'}
        </span>
        <span className="mail-time">{mailTime(item.receivedAt ?? item.createdAt, props.now)}</span>
      </div>
      <p className="mail-subject">{item.subject || t('（无主题）')}</p>
      {item.preview ? <p className="mail-preview">{item.preview}</p> : null}
      <div className="mail-verdict">
        <span className={`mail-tag is-${verdict.tone}`}>
          {verdict.tone === 'pending' ? <SpicaStatusIcon name="running" size={14} /> : null}
          {verdict.text}
        </span>
        {reason ? <span className="mail-reason">{reason}</span> : null}
        {sure ? <span className="mail-sure">{sure}</span> : null}
      </div>
      {props.mail.flagged.includes(item.id) ? <p className="guard-note mail-guard">{GUARD_FLAG_TEXT.mail}</p> : null}
      {verdict.tone === 'pending' ? null : (
        <div className="mail-actions">
          {verdict.handled ? (
            <span className="mail-handled">
              <SpicaStatusIcon name="done" size={15} />
              {verdict.handled}
            </span>
          ) : null}
          {open && tri?.decision === 'new' && props.onNewProject ? (
            <button type="button" className="btn btn-small" onClick={() => props.onNewProject?.(item)}>
              {t('新建项目')}
            </button>
          ) : null}
          {open && tri?.decision !== 'new' ? (
            <button type="button" className="btn btn-small btn-primary" onClick={() => props.onAccept(item.id)}>
              {t('采纳')}
            </button>
          ) : null}
          {open && tri?.decision !== 'ignore' ? (
            <button type="button" className="btn btn-small" onClick={() => props.onIgnore(item.id)}>
              {t('忽略')}
            </button>
          ) : null}
          {others.length ? (
            <button
              type="button"
              className="btn btn-small"
              aria-haspopup="menu"
              onClick={(e) => onMoveMenu(item, e.currentTarget)}
            >
              {t('更改项目')}
              <Icon name="chevronDown" size={12} />
            </button>
          ) : null}
          {manager && item.status === 'routed' ? (
            <button type="button" className="btn btn-small btn-plain" onClick={() => props.onOpenSession(manager)}>
              {t('打开项目')}
              <Icon name="arrowRight" size={12} />
            </button>
          ) : null}
        </div>
      )}
    </article>
  );
}

export function InboxView(props: InboxViewProps) {
  const { mail, prefs } = props;
  const [filter, setFilter] = useState<Filter>('todo');
  const [menu, setMenu] = useState<{ item: MailItem; anchor: HTMLElement } | null>(null);
  const sorted = useMemo(() => [...mail.items].sort(byReceived), [mail.items]);
  const todo = sorted.filter((m) => needsYou(m) || m.status === 'new');
  const shown = filter === 'todo' ? todo : sorted;

  const status = !prefs.enabled
    ? null
    : [
        prefs.intervalMinutes < 60 ? t('每 {n} 分钟检查', { n: prefs.intervalMinutes }) : t('每 {n} 小时检查', { n: prefs.intervalMinutes / 60 }),
        mail.lastPolledAt ? t('上次 {time}', { time: mailTime(mail.lastPolledAt, props.now) }) : '',
        mail.lastAdded === null ? '' : mail.lastAdded ? t('{n} 封新邮件', { n: mail.lastAdded }) : t('没有新邮件'),
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <div className="inbox">
      <div className="inbox-column">
        <div className="inbox-head">
          <div className="tabs inbox-tabs" role="tablist" aria-label={t('收件箱')}>
            <button type="button" role="tab" aria-selected={filter === 'todo'} className={filter === 'todo' ? 'tab is-on' : 'tab'} onClick={() => setFilter('todo')}>
              {t('待确认')}
            </button>
            <button type="button" role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'tab is-on' : 'tab'} onClick={() => setFilter('all')}>
              {t('全部')}
            </button>
          </div>
          <div className="inbox-status">
            {props.mock ? (
              <span className="mock-tag" title={t('模拟模式已开启')}>
                {t('模拟数据')}
              </span>
            ) : null}
            {prefs.enabled ? (
              <span className="settings-hint">{status}</span>
            ) : (
              <span className="settings-hint">
                {t('邮件分类已关闭')}
                <button type="button" className="text-btn" onClick={props.onOpenSettings}>
                  {t('开启')}
                </button>
              </span>
            )}
            <button type="button" className="btn btn-square" disabled={mail.polling || !mail.supported} onClick={props.onPoll} aria-label={t('现在查收')} title={t('现在查收')}>
              {mail.polling ? <span className="spinner" aria-hidden /> : <Icon name="refresh" size={16} />}
            </button>
          </div>
        </div>

        {mail.problem ? (
          <div className="inbox-problem" role="alert">
            <span>{tx(mail.problem)}</span>
            <button type="button" className="icon-btn" onClick={props.onDismissProblem} aria-label={t('关闭提示')} title={t('关闭')}>
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : null}

        {filter === 'todo' && props.before ? <div className="mail-list inbox-before">{props.before}</div> : null}
        {!mail.supported ? (
          <p className="inbox-empty">{t('当前版本不支持邮件。')}</p>
        ) : !mail.loaded ? null : sorted.length === 0 ? (
          <div className="inbox-empty">
            <p className="inbox-empty-title">{t('没有邮件')}</p>
          </div>
        ) : shown.length === 0 ? (
          <div className="inbox-empty">
            <p className="inbox-empty-title">{t('全部已处理')}</p>
          </div>
        ) : (
          <div className="mail-list">
            {shown.map((m) => (
              <MailCard key={m.id} item={m} props={props} onMoveMenu={(item, anchor) => setMenu((now) => (now?.anchor === anchor ? null : { item, anchor }))} />
            ))}
          </div>
        )}
      </div>
      {menu ? (
        // Under its button (over it when there is no room below); the button again closes it.
        <ContextMenu
          x={0}
          y={0}
          anchor={menu.anchor}
          items={props.projects
            .filter((p) => p.id !== menu.item.triage?.projectId)
            .map((p) => ({ label: p.name, onSelect: () => props.onMove(menu.item.id, p.id) }))}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
