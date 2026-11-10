// Right panel: details of the open session (tool calls, files, cost).
import type { ProjectInfo, ProjectLogEntry, SessionInfo } from '@spica/protocol';
import { filesOf, type Block, type Transcript } from '../store/transcript';
import { changesAfter } from '../store/relocate';
import { Icon } from '../ui/Icon';
import { InfoTip } from '../ui/InfoTip';
import { FileGlyph } from '../ui/FileIcon';
import { activityText } from './activity';
import { fileFolder, fileName, formatDuration, formatUsd, toolLabel, toolTarget } from '../chat/format';
import { SpicaStatusIcon } from '@spica/brand/react';

type ToolBlock = Extract<Block, { type: 'tool' }>;

export interface DetailPanelProps {
  session: SessionInfo | undefined;
  parent: SessionInfo | undefined;
  transcript: Transcript;
  globalCostUsd: number;
  /** Opens a folder (or a file) with Windows. */
  onOpenFile(path: string): void;
  /** Shows a file in the right panel; absent: files open with Windows. */
  onPreviewFile?: (path: string) => void;
  onOpenSession(id: string): void;
  /** Set when the session belongs to a project. */
  project?: ProjectInfo | undefined;
  activity?: ProjectLogEntry[];
  onClose?: () => void;
  /** A tab above already says 详情: leave out the heading (the close button stays). */
  hideHeading?: boolean;
}


function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const ROLE_LABEL: Record<SessionInfo['role'], string> = { top: '对话', manager: '项目经理', worker: '子任务' };

export function DetailPanel({ session, parent, transcript, globalCostUsd, onOpenFile, onPreviewFile, onOpenSession, project, activity = [], onClose, hideHeading = false }: DetailPanelProps) {
  const blocks = transcript.items.flatMap((i) => (i.kind === 'response' ? i.blocks : []));
  const tools = blocks.filter((b): b is ToolBlock => b.type === 'tool');
  // Per answer, so files named before the working-folder note are where it put them; each file once.
  const moves = changesAfter(transcript.items);
  const files = [
    ...new Map(transcript.items.flatMap((i) => (i.kind === 'response' ? filesOf(i.blocks, transcript.fileCards, moves.get(i.id)) : [])).map((f) => [f.path, f] as const)).values(),
  ];
  return (
    <aside className="detail" aria-label="详情">
      {hideHeading && !onClose ? null : (
      <header className="detail-head">
        {hideHeading ? <span /> : <span className="detail-heading">详情</span>}
        {onClose ? (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭详情" title="关闭详情">
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </header>
      )}
      {/* Nothing open yet: the panel stays empty rather than a column of dashes. */}
      {session ? (
      <div className="detail-scroll">
        {session ? (
          <section className="detail-section">
            <dl className="detail-facts">
              <dt>类型</dt>
              <dd>{ROLE_LABEL[session.role]}</dd>
              {/* A project's sub-task belongs to its manager, who is the project: say it once, under 项目. */}
              {parent && !(project && project.managerSessionId === parent.id) ? (
                <>
                  <dt>所属</dt>
                  <dd>
                    <button type="button" className="link-btn" onClick={() => onOpenSession(parent.id)}>
                      {parent.title}
                    </button>
                  </dd>
                </>
              ) : null}
              {project ? (
                <>
                  <dt>项目</dt>
                  <dd>
                    {project.managerSessionId === session.id ? (
                      project.name
                    ) : (
                      <button type="button" className="link-btn" onClick={() => onOpenSession(project.managerSessionId)}>
                        {project.name}
                      </button>
                    )}
                  </dd>
                </>
              ) : null}
              {project?.folder || session.cwd ? (
                <>
                  <dt>
                    文件夹
                    {/* Chosen by the user for this conversation: once, for good. */}
                    {!project && session.canChooseCwd === false && session.role === 'top' && !session.parentId ? <InfoTip text="选定后不能更改" label="文件夹" /> : null}
                  </dt>
                  <dd className="detail-folder">
                    <span className="detail-path" title={project?.folder ?? session.cwd}>
                      {project?.folder ?? session.cwd}
                    </span>
                    <button type="button" className="link-btn" onClick={() => onOpenFile(project?.folder ?? session.cwd)}>
                      打开
                    </button>
                  </dd>
                </>
              ) : null}
            </dl>
          </section>
        ) : null}

        {project ? (
          <section className="detail-section">
            <h3 className="detail-title">项目动态</h3>
            {activity.length ? (
              <ul className="detail-list">
                {activity.slice(0, 12).map((a) => (
                  <li key={a.id} className="activity-item" title={activityText(a)}>
                    <span className="activity-time">{clock(a.at)}</span>
                    <span className="activity-text">{activityText(a)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="detail-empty">—</p>
            )}
          </section>
        ) : null}

        <section className="detail-section">
          <h3 className="detail-title">
            工具调用<span className="detail-count">{tools.length || ''}</span>
          </h3>
          {tools.length ? (
            <ul className="detail-list">
              {tools.map((t) => (
                <li key={t.callId} className="detail-item">
                  <span className={t.state === 'error' ? 'detail-item-main text-danger' : 'detail-item-main'}>
                    {toolLabel(t.name)}
                    {toolTarget(t.input) ? <span className="detail-item-sub"> {toolTarget(t.input)}</span> : null}
                  </span>
                  <span className="detail-item-meta">
                    {t.state === 'running' || t.state === 'pending' ? <SpicaStatusIcon name="running" size={14} title="进行中" /> : t.durationMs !== undefined ? formatDuration(t.durationMs) : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="detail-empty">—</p>
          )}
        </section>

        <section className="detail-section">
          <h3 className="detail-title">
            文件<span className="detail-count">{files.length || ''}</span>
          </h3>
          {files.length ? (
            <ul className="detail-list">
              {files.map((f) => (
                <li key={f.path}>
                  <button type="button" className="detail-file" onClick={() => (onPreviewFile ?? onOpenFile)(f.path)} title={`查看 ${f.path}`}>
                    <FileGlyph name={f.shown ?? f.path} />
                    <span className="detail-file-name">{fileName(f.shown ?? f.path)}</span>
                    {fileFolder(f.shown ?? f.path) ? <span className="detail-item-sub">{fileFolder(f.shown ?? f.path)}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="detail-empty">—</p>
          )}
        </section>

        <section className="detail-section">
          <h3 className="detail-title">花费</h3>
          <dl className="detail-facts">
            <dt>本对话</dt>
            <dd className="num">{session ? formatUsd(session.costUsd) : '—'}</dd>
            <dt>全部对话</dt>
            <dd className="num">{formatUsd(globalCostUsd)}</dd>
          </dl>
        </section>
      </div>
      ) : null}
    </aside>
  );
}
