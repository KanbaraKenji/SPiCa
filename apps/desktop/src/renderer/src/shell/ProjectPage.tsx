// A project's own page: the name of a project that holds sub-projects opens it in the main area. The folder, the
// cost of all its sub-projects, its own conversation (when it has one), the sub-projects (a click opens one's
// conversation, its manager; 新子项目 under them), their activity.
import type { ProjectInfo, ProjectLogEntry, SessionInfo } from '@spica/protocol';
import { SpicaStatusIcon } from '@spica/brand/react';
import { Icon } from '../ui/Icon';
import { activityText } from './activity';
import { STATUS_LABEL } from './row-status';
import { formatUsd } from '../chat/format';
import { spendText } from '../../../shared/spend';
import { t } from '../../../shared/i18n';

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A sub-project's state after its name: running or waiting (its own or a sub-task's); idle says nothing. */
function stateOf(manager: SessionInfo, below: SessionInfo[]): { text: string; waiting: boolean } | null {
  const all = [manager, ...below];
  const waiting = all.find((s) => s.status === 'awaiting_answer' || s.status === 'awaiting_confirm');
  if (waiting) return { text: t(STATUS_LABEL[waiting.status]), waiting: true };
  if (all.some((s) => s.status === 'thinking' || s.status === 'tool' || s.status === 'queued')) return { text: t('进行中'), waiting: false };
  return null;
}

export interface ProjectPageProps {
  project: ProjectInfo;
  /** Its sub-projects, each with its manager's conversation and everything that manager sent out. */
  subs: { project: ProjectInfo; manager: SessionInfo; below: SessionInfo[] }[];
  /** The sub-projects' activity, newest first. */
  activity: (ProjectLogEntry & { from: string })[];
  /** Its own conversation (its manager), when it has one besides the sub-projects; with what that sent out. */
  own?: { manager: SessionInfo; below: SessionInfo[] };
  onOpenSession(id: string): void;
  onOpenFolder(path: string): void;
  /** 新子项目 under the sub-projects. Absent: not offered. */
  onNewSubProject?: () => void;
}

export function ProjectPage({ project, subs, own, activity, onOpenSession, onOpenFolder, onNewSubProject }: ProjectPageProps) {
  const sessions = [...(own ? [own.manager, ...own.below] : []), ...subs.flatMap((x) => [x.manager, ...x.below])];
  const cost = sessions.reduce((n, s) => n + s.costUsd, 0);
  const unpriced = sessions.some((s) => s.unpriced);
  return (
    <div className="project-page">
      <div className="project-scroll">
        <div className="project-column">
          <dl className="detail-facts project-facts">
            {project.folder ? (
              <>
                <dt>{t('文件夹')}</dt>
                <dd className="detail-folder">
                  <button type="button" className="link-btn detail-path" title={project.folder} onClick={() => onOpenFolder(project.folder)}>
                    {project.folder}
                  </button>
                </dd>
              </>
            ) : null}
            <dt>{t('花费')}</dt>
            <dd>{spendText(cost, unpriced, formatUsd)}</dd>
            {own ? (
              <>
                <dt>{t('对话')}</dt>
                <dd>
                  <button type="button" className="link-btn" onClick={() => onOpenSession(own.manager.id)}>
                    {project.name}
                  </button>
                </dd>
              </>
            ) : null}
          </dl>

          <section className="project-section">
            <h3 className="detail-title">
              {t('子项目')}
              <span className="detail-count">{subs.length || ''}</span>
            </h3>
            {subs.length ? (
              <ul className="detail-list">
                {subs.map(({ project: p, manager, below }) => {
                  const state = stateOf(manager, below);
                  return (
                    <li key={p.id}>
                      <button type="button" className="project-task" onClick={() => onOpenSession(manager.id)} title={p.name}>
                        <span className="project-task-name">{p.name}</span>
                        {state ? (
                          <span className={state.waiting ? 'project-state is-waiting' : 'project-state'}>
                            {state.waiting ? null : <SpicaStatusIcon name="running" size={14} />}
                            {state.text}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : onNewSubProject ? null : (
              <p className="detail-empty">—</p>
            )}
            {onNewSubProject ? (
              <button type="button" className="project-task project-new" onClick={onNewSubProject}>
                <Icon name="plus" size={16} />
                <span className="project-task-name">{t('新子项目')}</span>
              </button>
            ) : null}
          </section>

          <section className="project-section">
            <h3 className="detail-title">{t('项目动态')}</h3>
            {activity.length ? (
              <ul className="detail-list">
                {activity.slice(0, 20).map((a) => (
                  <li key={a.id} className="activity-item" title={activityText(a)}>
                    <span className="activity-time">{clock(a.at)}</span>
                    <span className="activity-text">
                      <span className="project-activity-from">{a.from}</span> {activityText(a)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="detail-empty">—</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
