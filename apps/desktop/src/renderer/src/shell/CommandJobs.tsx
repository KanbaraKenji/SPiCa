// 后台命令 in the details: the commands this conversation started in the background (run_command with
// run_in_background), each by its command (its description in the hover). The ones running first, each with its
// ring, how long it has run and 停止 (the message box's stop button, smaller); then the ended ones,
// newest first, with how they ended. After a restart the records come back the same way (core keeps them).
import { useEffect, useState } from 'react';
import type { CommandJob } from '@spica/protocol';
import { SpicaStatusIcon } from '@spica/brand/react';
import { Icon } from '../ui/Icon';
import { formatClock, formatDuration } from '../chat/format';
import { t } from '../../../shared/i18n';

/** The jobs as the details list them: running ones in the order they started, then the rest newest first. */
export function jobsInOrder(jobs: Record<string, CommandJob> | undefined): CommandJob[] {
  const all = Object.values(jobs ?? {});
  const running = all.filter((j) => !j.end).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const ended = all.filter((j) => j.end).sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt));
  return [...running, ...ended];
}

/** How many of a conversation's commands still run. */
export const runningJobs = (jobs: Record<string, CommandJob> | undefined) => Object.values(jobs ?? {}).filter((j) => !j.end).length;

const ms = (from: string, to: string | number) => Math.max(0, (typeof to === 'number' ? to : Date.parse(to)) - Date.parse(from));

/** An ended job's icon and its words after the name: stopped (by anyone) as 已停止 · time; a crash 已中断; else its time. */
function ended(j: CommandJob): { icon: 'done' | 'error' | 'stopped'; meta: React.ReactNode } {
  const took = j.endedAt ? formatDuration(ms(j.startedAt, j.endedAt)) : '';
  if (j.end === 'failed') return { icon: 'error', meta: <span className="text-danger">Failed</span> };
  if (j.end === 'app_crashed') return { icon: 'stopped', meta: <span className="text-danger">{t('已中断')}</span> };
  if (j.end === 'exited') return { icon: j.exitCode === 0 ? 'done' : 'error', meta: took };
  return { icon: 'stopped', meta: took ? `${t('已停止')} · ${took}` : t('已停止') };
}

/** The running ones' time, a tick a second while any runs. */
function useSecond(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

export function CommandJobs({ jobs, onStop }: { jobs: Record<string, CommandJob> | undefined; onStop?: ((jobId: string) => void) | undefined }) {
  const list = jobsInOrder(jobs);
  const now = useSecond(list.some((j) => !j.end));
  // Stopping a process tree takes a moment on Windows: 停止 pressed once is greyed until the job says it ended.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  if (!list.length) return null;
  return (
    <section className="detail-section">
      <h3 className="detail-title">
        {t('后台命令')}
        <span className="detail-count">{list.length}</span>
      </h3>
      <ul className="detail-list">
        {list.map((j) => {
          const end = j.end ? ended(j) : undefined;
          return (
            <li key={j.id} className="detail-item detail-job" title={j.description ? `${j.description}\n${j.command}` : j.command}>
              <span className="detail-item-icon">
                {end ? <SpicaStatusIcon name={end.icon} size={14} /> : <SpicaStatusIcon name="running" size={14} title={t('运行中')} />}
              </span>
              <span className="detail-item-main detail-job-cmd">{j.command}</span>
              <span className="detail-item-meta">{end ? end.meta : formatClock(ms(j.startedAt, now))}</span>
              {!end && onStop ? (
                <button type="button" className="icon-btn composer-stop detail-job-stop" disabled={stopping.has(j.id)}
                  onClick={() => {
                    setStopping((s) => new Set(s).add(j.id));
                    onStop(j.id);
                  }}
                  aria-label={`${t('停止')} ${j.command}`} title={t('停止')}>
                  <Icon name="stop" size={14} />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
