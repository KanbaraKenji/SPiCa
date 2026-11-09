// 收件箱: mail the core fetched through a mail plugin and sorted into projects.
// Each mail shows where it went and why; the user accepts, ignores or moves
// it. Only suggestions: nothing here sends, moves or marks mail.
import { useMemo, useState } from 'react';
import type { MailItem } from '@spica/protocol';
import { byReceived, mailTime, needsYou, reasonOf, surenessOf, verdictOf } from '../../../shared/mail';
import type { MailPrefs } from '../../../shared/settings';
import type { MailView } from '../store/mail';
import { ContextMenu } from '../ui/ContextMenu';
import { Icon } from '../ui/Icon';
import { GUARD_FLAG_TEXT } from '../chat/format';

export interface InboxProject {
  id: string;
  name: string;
  managerSessionId: string;
}

export interface InboxViewProps {
  mail: MailView;
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
}

type Filter = 'todo' | 'all';

function MailCard({ item, props, onMoveMenu }: { item: MailItem; props: InboxViewProps; onMoveMenu(item: MailItem, x: number, y: number): void }) {
  const nameOf = (pid: string) => props.projects.find((p) => p.id === pid)?.name;
  const verdict = verdictOf(item, nameOf);
  const reason = reasonOf(item);
  const sure = surenessOf(item);
  const open = needsYou(item);
  const t = item.triage;
  const others = props.projects.filter((p) => p.id !== t?.projectId);
  const manager = item.routedTo ?? (t?.projectId ? props.projects.find((p) => p.id === t.projectId)?.managerSessionId : undefined);
  return (
    <article className={open ? 'mail-card is-open' : 'mail-card'} aria-label={item.subject || '没有主题'}>
      <div className="mail-top">
        <span className="mail-from" title={item.fromAddress ?? ''}>
          {item.fromName || item.fromAddress || '—'}
        </span>
        <span className="mail-time">{mailTime(item.receivedAt ?? item.createdAt, props.now)}</span>
      </div>
      <p className="mail-subject">{item.subject || '（没有主题）'}</p>
      {item.preview ? <p className="mail-preview">{item.preview}</p> : null}
      <div className="mail-verdict">
        <span className={`mail-tag is-${verdict.tone}`}>
          {verdict.tone === 'pending' ? <span className="spinner" aria-hidden /> : null}
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
              <Icon name="check" size={14} />
              {verdict.handled}
            </span>
          ) : null}
          {open && t?.decision === 'new' && props.onNewProject ? (
            <button type="button" className="btn btn-small" onClick={() => props.onNewProject?.(item)}>
              建成项目
            </button>
          ) : null}
          {open && t?.decision !== 'new' ? (
            <button type="button" className="btn btn-small btn-primary" onClick={() => props.onAccept(item.id)}>
              采纳
            </button>
          ) : null}
          {open && t?.decision !== 'ignore' ? (
            <button type="button" className="btn btn-small" onClick={() => props.onIgnore(item.id)}>
              忽略
            </button>
          ) : null}
          {others.length ? (
            <button
              type="button"
              className="btn btn-small"
              aria-haspopup="menu"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onMoveMenu(item, r.left, r.bottom + 4);
              }}
            >
              改归属
              <Icon name="chevronDown" size={12} />
            </button>
          ) : null}
          {manager && item.status === 'routed' ? (
            <button type="button" className="btn btn-small btn-plain" onClick={() => props.onOpenSession(manager)}>
              去项目看
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
  const [menu, setMenu] = useState<{ item: MailItem; x: number; y: number } | null>(null);
  const sorted = useMemo(() => [...mail.items].sort(byReceived), [mail.items]);
  const todo = sorted.filter((m) => needsYou(m) || m.status === 'new');
  const shown = filter === 'todo' ? todo : sorted;

  const status = !prefs.enabled
    ? null
    : [`每 ${prefs.intervalMinutes < 60 ? `${prefs.intervalMinutes} 分钟` : `${prefs.intervalMinutes / 60} 小时`}查一次`, mail.lastPolledAt ? `上次 ${mailTime(mail.lastPolledAt, props.now)}` : '']
        .filter(Boolean)
        .join(' · ');

  return (
    <div className="inbox">
      <div className="inbox-column">
        <div className="inbox-head">
          <div className="tabs inbox-tabs" role="tablist" aria-label="收件箱">
            <button type="button" role="tab" aria-selected={filter === 'todo'} className={filter === 'todo' ? 'tab is-on' : 'tab'} onClick={() => setFilter('todo')}>
              待你确认
            </button>
            <button type="button" role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'tab is-on' : 'tab'} onClick={() => setFilter('all')}>
              全部
            </button>
          </div>
          <div className="inbox-status">
            {prefs.enabled ? (
              <span className="settings-hint">{status}</span>
            ) : (
              <span className="settings-hint">
                邮件分类已关闭
                <button type="button" className="text-btn" onClick={props.onOpenSettings}>
                  去打开
                </button>
              </span>
            )}
            <button type="button" className="btn" disabled={mail.polling || !mail.supported} onClick={props.onPoll}>
              {mail.polling ? <span className="spinner" aria-hidden /> : null}
              现在查收
            </button>
          </div>
        </div>

        {mail.problem ? (
          <div className="inbox-problem" role="alert">
            <span>{mail.problem}</span>
            <button type="button" className="icon-btn" onClick={props.onDismissProblem} aria-label="关闭提示">
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : null}

        {!mail.supported ? (
          <p className="inbox-empty">这个版本还不能收邮件。</p>
        ) : !mail.loaded ? null : sorted.length === 0 ? (
          <div className="inbox-empty">
            <p className="inbox-empty-title">还没有来信</p>
            <p className="settings-hint">来信从邮件插件来：在 设置 › 插件 装好并打开（比如 Outlook），之后会按设好的间隔查收，分好的信出现在这里。</p>
          </div>
        ) : shown.length === 0 ? (
          <div className="inbox-empty">
            <p className="inbox-empty-title">都确认过了</p>
            <p className="settings-hint">处理过的信在「全部」里。</p>
          </div>
        ) : (
          <div className="mail-list">
            {shown.map((m) => (
              <MailCard key={m.id} item={m} props={props} onMoveMenu={(item, x, y) => setMenu({ item, x, y })} />
            ))}
          </div>
        )}
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={props.projects
            .filter((p) => p.id !== menu.item.triage?.projectId)
            .map((p) => ({ label: p.name, onSelect: () => props.onMove(menu.item.id, p.id) }))}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
