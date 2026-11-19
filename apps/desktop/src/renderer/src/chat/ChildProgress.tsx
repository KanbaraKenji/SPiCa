// The sub-agents a wait_agents call waits for, in its opened row: each one's name and how far its plan (update_plan)
// is, read from its own conversation (loaded once the row opens; its live events keep it current).
import { createContext, useContext, useEffect } from 'react';
import { planProgress, type SessionInfo, type SessionStatus } from '@spica/protocol';
import { SpicaStatusIcon } from '@spica/brand/react';
import { currentPlan, isRunning, type Transcript } from '../store/transcript';
import { N_, t } from '../../../shared/i18n';

export interface ChildSource {
  /** The conversation that is open (the parent): a wait without ids waits for its sub-agents. */
  parentId: string | null;
  sessions: readonly SessionInfo[];
  transcripts: Readonly<Record<string, Transcript>>;
  load(id: string): void;
}

export const ChildSourceContext = createContext<ChildSource | null>(null);

function Mark({ status, finished, running }: { status: SessionStatus | undefined; finished: boolean; running: boolean }) {
  if (finished) return <SpicaStatusIcon name="done" size={14} />;
  if (running) return <SpicaStatusIcon name="running" size={14} />;
  return <span className={`plan-dot${isRunning(status) ? ' is-current' : ''}`} aria-hidden="true" />;
}

/** A sub-agent's state in words, when its plan does not say (no plan, or it stopped before the plan was done). */
const STATE_WORDS: Partial<Record<SessionStatus, string>> = { awaiting_answer: N_('等待回答'), awaiting_confirm: N_('等待确认'), error: N_('出错'), aborted: N_('已中断'), interrupted: N_('已中断') };

export function ChildProgress({ ids }: { ids: readonly string[] | undefined }) {
  const src = useContext(ChildSourceContext);
  const children = !src ? [] : ids?.length ? ids.flatMap((id) => src.sessions.filter((s) => s.id === id)) : src.sessions.filter((s) => s.parentId === src.parentId);
  const key = children.map((c) => c.id).join(' ');
  useEffect(() => {
    if (src) for (const id of key.split(' ').filter(Boolean)) src.load(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!src || !children.length) return null;
  return (
    <ul className="child-progress">
      {children.map((c) => {
        const tr = src.transcripts[c.id];
        const plan = tr ? currentPlan(tr) : undefined;
        const p = plan ? planProgress(plan.steps) : undefined;
        const all = p !== undefined && p.done === p.total;
        const ended = !isRunning(c.status);
        const finished = all || (!p && (c.status === 'done' || c.status === 'idle'));
        const running = !finished && (c.status === 'queued' || c.status === 'thinking' || c.status === 'tool');
        const state = STATE_WORDS[c.status];
        const line = all ? t('已完成') : state ? t(state) : p ? (p.current?.step ?? '') : ended ? t('已完成') : t('进行中');
        return (
          <li key={c.id} className="child-progress-row">
            <span className="plan-mark">
              <Mark status={c.status} finished={finished} running={running} />
            </span>
            <span className="child-progress-name">{c.title ?? t('子任务')}</span>
            {p ? <span className="plan-count">{`${all ? p.total : p.currentIndex + 1} / ${p.total}`}</span> : null}
            <span className="plan-current">{line}</span>
          </li>
        );
      })}
    </ul>
  );
}
