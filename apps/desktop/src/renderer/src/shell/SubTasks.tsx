// 子任务 in the details: what the open conversation's manager sent out, as Claude's
// Background tasks. The ones going first (its ring, how long it has run, 停止), the ones kept for later jobs with
// them; the ended ones folded under 「N 个已结束」. A click on a row shows that sub-task in the details: what it was
// asked, the calls it made (each opens as in 工具调用), what it said last; ← 子任务 goes back to the list.
import { useEffect, useState } from 'react';
import type { SessionInfo } from '@spica/protocol';
import { SpicaStatusIcon } from '@spica/brand/react';
import type { StatusIconName } from '@spica/brand';
import type { Transcript } from '../store/transcript';
import { CallDetail } from '../chat/CallDetail';
import { toolIcon } from '../chat/Blocks';
import { formatClock, formatDuration } from '../chat/format';
import { Icon } from '../ui/Icon';
import { STATUS_LABEL } from './row-status';
import { detailTools, isRunning, ToolListText } from './DetailPanel';
import { t } from '../../../shared/i18n';

const ms = (from: string, to: string | number) => Math.max(0, (typeof to === 'number' ? to : Date.parse(to)) - Date.parse(from));

/** A sub-task that is over: done, failed, stopped; one not kept for later that sits idle is over too. */
export function isEnded(s: SessionInfo): boolean {
  if (s.status === 'done' || s.status === 'error' || s.status === 'aborted' || s.status === 'interrupted') return true;
  return s.status === 'idle' && !s.resident;
}

/** The sub-tasks as the details list them: the ones going (oldest first), then the ended ones (newest first). */
export function tasksInOrder(tasks: SessionInfo[]): { going: SessionInfo[]; ended: SessionInfo[] } {
  const going = tasks.filter((s) => !isEnded(s)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const ended = tasks.filter(isEnded).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { going, ended };
}

function iconOf(s: SessionInfo): StatusIconName {
  switch (s.status) {
    case 'done':
      return 'done';
    case 'error':
    case 'interrupted':
      return 'error';
    case 'aborted':
      return 'stopped';
    case 'awaiting_answer':
      return 'question';
    case 'awaiting_confirm':
      return 'waiting';
    case 'queued':
      return 'queued';
    case 'idle':
      return 'done';
    default:
      return 'running';
  }
}

const isLive = (s: SessionInfo) => s.status === 'thinking' || s.status === 'tool' || s.status === 'queued';

/** After the name: a running one's time; waiting, its state; kept for later and idle, 常驻; ended, how it ended. */
function metaOf(s: SessionInfo, now: number): React.ReactNode {
  if (s.status === 'awaiting_answer' || s.status === 'awaiting_confirm') return t(STATUS_LABEL[s.status]);
  if (s.status === 'error' || s.status === 'interrupted') return <span className="text-danger">{t(STATUS_LABEL[s.status])}</span>;
  if (s.status === 'aborted') return t('已停止');
  if (s.status === 'idle' && s.resident) return t('常驻');
  if (isEnded(s)) return formatDuration(ms(s.createdAt, s.updatedAt));
  return formatClock(ms(s.createdAt, now));
}

function useSecond(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

export interface SubTasksProps {
  tasks: SessionInfo[];
  onSelect(id: string): void;
  onStop?: ((id: string) => void) | undefined;
}

export function SubTasks({ tasks, onSelect, onStop }: SubTasksProps) {
  const { going, ended } = tasksInOrder(tasks);
  const now = useSecond(going.some(isLive));
  const [endedOpen, setEndedOpen] = useState(false);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  if (!tasks.length) return null;
  const row = (s: SessionInfo) => {
    const name = s.title ?? '';
    const canStop = onStop && !isEnded(s);
    return (
      <li key={s.id} className="detail-task-row">
        <button type="button" className="detail-task" onClick={() => onSelect(s.id)} title={name}>
          <span className="detail-item-icon">
            <SpicaStatusIcon name={iconOf(s)} size={14} />
          </span>
          <span className="detail-item-main">{name}</span>
          <span className="detail-item-meta">{metaOf(s, now)}</span>
        </button>
        {canStop ? (
          <button
            type="button"
            className="icon-btn composer-stop detail-job-stop"
            disabled={stopping.has(s.id)}
            onClick={() => {
              setStopping((x) => new Set(x).add(s.id));
              onStop(s.id);
            }}
            aria-label={`${t('停止')} ${name}`}
            title={t('停止')}
          >
            <Icon name="stop" size={14} />
          </button>
        ) : null}
      </li>
    );
  };
  return (
    <section className="detail-section">
      <h3 className="detail-title">
        {t('子任务')}
        <span className="detail-count">{tasks.length}</span>
      </h3>
      <ul className="detail-list">
        {going.map(row)}
        {ended.length ? (
          <li>
            <button type="button" className="detail-task detail-task-fold" aria-expanded={endedOpen} onClick={() => setEndedOpen((o) => !o)}>
              <span className="detail-item-icon">
                <Icon name={endedOpen ? 'chevronDown' : 'chevronRight'} size={14} />
              </span>
              <span className="detail-item-main">{t('{n} 个已结束', { n: ended.length })}</span>
            </button>
          </li>
        ) : null}
        {endedOpen ? ended.map(row) : null}
      </ul>
    </section>
  );
}

/** The last thing the sub-task said (its last answer's words). */
function lastWords(tr: Transcript): string {
  for (let i = tr.items.length - 1; i >= 0; i--) {
    const it = tr.items[i]!;
    if (it.kind !== 'response') continue;
    for (let j = it.blocks.length - 1; j >= 0; j--) {
      const b = it.blocks[j]!;
      if (b.type === 'text' && b.text.trim()) return b.text.trim();
    }
  }
  return '';
}

/** What it was asked: the first message of its conversation (its manager's). */
function firstAsk(tr: Transcript): string {
  for (const it of tr.items) if (it.kind === 'user' && it.text.trim()) return it.text.trim();
  return '';
}

export interface SubTaskDetailProps {
  task: SessionInfo;
  /** Its record; undefined while it loads (only its name and state are drawn till then, nothing changes shape). */
  transcript: Transcript | undefined;
  onBack(): void;
  /** Its whole conversation in the main area (to go on talking to it). */
  onOpen(id: string): void;
  onStop?: ((id: string) => void) | undefined;
}

export function SubTaskDetail({ task, transcript, onBack, onOpen, onStop }: SubTaskDetailProps) {
  const now = useSecond(isLive(task));
  const live = Boolean(transcript?.run) || isLive(task);
  const calls = transcript ? detailTools(transcript) : [];
  const [open, setOpen] = useState<string | null>(null);
  const ask = transcript ? firstAsk(transcript) : '';
  const said = transcript ? lastWords(transcript) : '';
  const canStop = onStop && !isEnded(task);
  return (
    <div className="detail-scroll subtask-detail">
      <button type="button" className="back-link" onClick={onBack}>
        <Icon name="arrowLeft" size={16} />
        <span>{t('子任务')}</span>
      </button>
      <div className="subtask-head">
        <span className="detail-item-icon">
          <SpicaStatusIcon name={iconOf(task)} size={16} />
        </span>
        <span className="subtask-name" title={task.title ?? ''}>
          {task.title}
        </span>
        <span className="detail-item-meta">{metaOf(task, now)}</span>
        {canStop ? (
          <button type="button" className="icon-btn composer-stop detail-job-stop" onClick={() => onStop(task.id)} aria-label={`${t('停止')} ${task.title ?? ''}`} title={t('停止')}>
            <Icon name="stop" size={14} />
          </button>
        ) : null}
      </div>
      {transcript ? (
      <>
      <section className="detail-section">
        <h3 className="detail-title">{t('任务')}</h3>
        <p className="subtask-text">{ask || '—'}</p>
      </section>
      <section className="detail-section">
        <h3 className="detail-title">
          {t('工具调用')}
          <span className="detail-count">{calls.length || ''}</span>
        </h3>
        {calls.length ? (
          <ol className="detail-list subtask-calls">
            {calls.map((b) => {
              const isOpen = open === b.callId;
              const running = isRunning(b, live);
              return (
                <li key={b.callId} className={isOpen ? 'tool-history-item is-open' : 'tool-history-item'}>
                  <button type="button" className="tool-history-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : b.callId)}>
                    <span className="detail-item-icon">{running ? <SpicaStatusIcon name="running" size={14} /> : toolIcon(b)}</span>
                    <ToolListText t={b} card={transcript?.fileCards?.[b.callId]} running={running} />
                  </button>
                  {isOpen ? (
                    <div className="tool-history-body">
                      <CallDetail block={b} card={transcript?.fileCards?.[b.callId]} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="detail-empty">—</p>
        )}
      </section>
      {/* What it said last, once it is over (or, kept for later, between jobs); while it runs its calls say it. */}
      {isEnded(task) || task.status === 'idle' ? (
        <section className="detail-section">
          <h3 className="detail-title">{t('回报')}</h3>
          <p className="subtask-text">{said || '—'}</p>
        </section>
      ) : null}
      <section className="detail-section">
        <button type="button" className="btn" onClick={() => onOpen(task.id)}>
          {t('打开对话')}
        </button>
      </section>
      </>
      ) : null}
    </div>
  );
}
