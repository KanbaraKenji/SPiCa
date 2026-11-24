// The details panel (详情, at the window's right edge): the open session's tool calls, files, cost. A fixed width:
// no edge to drag, no 最大化 (the file preview beside it has both).
import type { FileCardMeta, ProjectInfo, ProjectLogEntry, SessionInfo } from '@spica/protocol';
import { filesOf, MEMORY_TOOLS, type Block, type Transcript } from '../store/transcript';
import { changesAfter } from '../store/relocate';
import { Icon } from '../ui/Icon';
import { InfoTip } from '../ui/InfoTip';
import { FileGlyph } from '../ui/FileIcon';
import { activityText } from './activity';
import { useState } from 'react';
import { fileName, formatUsd } from '../chat/format';
import { spendText } from '../../../shared/spend';
import { runningWords, toolWords } from '../chat/tool-words';
import { SpicaStatusIcon } from '@spica/brand/react';
import { N_, t, tc } from '../../../shared/i18n';
import { CommandJobs } from './CommandJobs';
import { SubTaskDetail, SubTasks } from './SubTasks';

export type ToolBlock = Extract<Block, { type: 'tool' }>;

/** Files listed before 显示更多. */
export const FILES_SHOWN = 5;

/**
 * A call still going (its ring under 工具调用): only while the conversation's run goes on; a call left running by a
 * run that was stopped (or a reopened conversation) is over (已中断 in the list beside).
 */
export const isRunning = (t: ToolBlock, live: boolean) => live && (t.state === 'running' || t.state === 'pending');

/** The calls the details count: remember / forget are the 已记住 line in the conversation (listed here they would say it twice). */
export function detailTools(transcript: Transcript): ToolBlock[] {
  return transcript.items.flatMap((i) => (i.kind === 'response' ? i.blocks : [])).filter((b): b is ToolBlock => b.type === 'tool' && !MEMORY_TOOLS.has(b.name));
}

export interface DetailPanelProps {
  session: SessionInfo | undefined;
  parent: SessionInfo | undefined;
  transcript: Transcript;
  globalCostUsd: number;
  /** Some conversation used a model without a price (not in globalCostUsd): shown 「+ 未计价」. */
  globalUnpriced?: boolean;
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
  /** 工具调用's heading: every call, shown where the preview goes. */
  history?: { open: boolean; toggle(): void };
  /** 后台命令's 停止. */
  onStopJob?: (jobId: string) => void;
  /**
   * The sub-tasks the open conversation sent out (its 子任务 section) and how to show one:
   * its record (loaded on a click), 停止, its whole conversation in the main area.
   */
  subTasks?: {
    tasks: SessionInfo[];
    /** Its record; undefined while it loads. */
    transcriptOf(id: string): Transcript | undefined;
    load(id: string): void;
    stop(id: string): void;
    open(id: string): void;
  };
}


function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const ROLE_LABEL: Record<SessionInfo['role'], string> = { top: N_('对话'), manager: N_('项目经理'), worker: N_('子任务') };

/** A call in the list: the conversation's words for it, the verb and then the object quieter. */
export function ToolListText({ t, card, running = false }: { t: Parameters<typeof toolWords>[0]; card?: FileCardMeta | undefined; running?: boolean }) {
  const w = toolWords(t, card);
  // while it runs, the verb as the conversation says it then (Writing, Running…)
  const line = running ? runningWords(t) : '';
  const verb = running && w.verb && line.endsWith(` ${w.object}`) ? line.slice(0, line.length - w.object.length - 1) : w.verb;
  return (
    <span className="detail-item-main" title={w.full}>
      {verb || w.object}
      {verb ? <span className="detail-item-sub"> {w.object}</span> : null}
    </span>
  );
}

export function DetailPanel({ session, parent, transcript, globalCostUsd, globalUnpriced, onOpenFile, onPreviewFile, onOpenSession, project, activity = [], onClose, hideHeading = false, history, onStopJob, subTasks }: DetailPanelProps) {
  const tools = detailTools(transcript);
  const live = Boolean(transcript.run);
  const running = tools.filter((b) => isRunning(b, live));
  const [filesOpen, setFilesOpen] = useState(true);
  const [allFiles, setAllFiles] = useState(false);
  // another conversation: its files open again, the first five
  /** A sub-task shown in place of the list (子任务 › one of them). */
  const [taskShown, setTaskShown] = useState<string | null>(null);
  const [shownFor, setShownFor] = useState(session?.id);
  if (shownFor !== session?.id) {
    setShownFor(session?.id);
    setFilesOpen(true);
    setAllFiles(false);
    setTaskShown(null);
  }
  const task = taskShown ? subTasks?.tasks.find((x) => x.id === taskShown) : undefined;
  // Per answer, so files named before the working-folder note are where it put them; each file once.
  const moves = changesAfter(transcript.items);
  const files = [
    ...new Map(transcript.items.flatMap((i) => (i.kind === 'response' ? filesOf(i.blocks, transcript.fileCards, moves.get(i.id), transcript.fileCardLists) : [])).map((f) => [f.path, f] as const)).values(),
  ].filter((f) => !f.card?.notSaved); // a file a tool's result carried that was not kept is no file of the conversation
  return (
    <aside className="detail" aria-label={t('详情')}>
      {hideHeading && !onClose ? null : (
      <header className="detail-head panel-head">
        {hideHeading ? <span /> : <span className="detail-heading">{t('详情')}</span>}
        {onClose ? (
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('关闭详情')} title={t('关闭详情')}>
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </header>
      )}
      {/* Nothing open yet: the panel stays empty rather than a column of dashes. */}
      {task && subTasks ? (
        <SubTaskDetail task={task} transcript={subTasks.transcriptOf(task.id)} onBack={() => setTaskShown(null)} onOpen={subTasks.open} onStop={subTasks.stop} />
      ) : session ? (
      <div className="detail-scroll">
        {session ? (
          <section className="detail-section">
            <dl className="detail-facts">
              <dt>{t('类型')}</dt>
              <dd>{t(ROLE_LABEL[session.role])}</dd>
              {/* A project's sub-task belongs to its manager, who is the project: say it once, under 项目. */}
              {parent && !(project && project.managerSessionId === parent.id) ? (
                <>
                  <dt>{t('所属')}</dt>
                  <dd>
                    <button type="button" className="link-btn" onClick={() => onOpenSession(parent.id)}>
                      {parent.title}
                    </button>
                  </dd>
                </>
              ) : null}
              {project ? (
                <>
                  <dt>{t('项目')}</dt>
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
                    {t('文件夹')}
                    {/* Chosen by the user for this conversation: once, for good. */}
                    {!project && session.canChooseCwd === false && session.role === 'top' && !session.parentId ? <InfoTip text={t('选定后不能更改')} label={t('文件夹')} /> : null}
                  </dt>
                  <dd className="detail-folder">
                    <span className="detail-path" title={project?.folder ?? session.cwd}>
                      {project?.folder ?? session.cwd}
                    </span>
                    <button type="button" className="link-btn" onClick={() => onOpenFile(project?.folder ?? session.cwd)}>
                      {t('打开')}
                    </button>
                  </dd>
                </>
              ) : null}
            </dl>
          </section>
        ) : null}

        {subTasks?.tasks.length ? (
          <SubTasks
            tasks={subTasks.tasks}
            onSelect={(id) => {
              subTasks.load(id);
              setTaskShown(id);
            }}
            onStop={subTasks.stop}
          />
        ) : null}

        {project ? (
          <section className="detail-section">
            <h3 className="detail-title">{t('项目动态')}</h3>
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

        {/* 工具调用: one group (his words: the running ones and the rest are the same thing). Its heading is a row
            that opens every call beside, where the preview goes (how many in all, ›); under it only the calls running
            now, each with its ring. */}
        {tools.length ? (
          <section className="detail-section">
            <h3 className="detail-title">
              {history ? (
                <button type="button" className={history.open ? 'detail-fold detail-calls is-on' : 'detail-fold detail-calls'} aria-expanded={history.open} onClick={history.toggle}>
                  {t('工具调用')}
                  <span className="detail-count">{tools.length}</span>
                  <Icon name="chevronRight" size={12} className="detail-calls-chevron" />
                </button>
              ) : (
                <>
                  {t('工具调用')}<span className="detail-count">{tools.length}</span>
                </>
              )}
            </h3>
            {running.length ? (
            <ul className="detail-list">
              {running.map((b) => (
                <li key={b.callId} className="detail-item">
                  <span className="detail-item-icon">
                    <SpicaStatusIcon name="running" size={14} title={t('进行中')} />
                  </span>
                  <ToolListText t={b} card={transcript.fileCards?.[b.callId]} running />
                </li>
              ))}
            </ul>
            ) : null}
          </section>
        ) : null}

        <CommandJobs jobs={transcript.jobs} onStop={onStopJob} />

        {/* As Claude's Outputs: the heading folds it (the count beside it while folded); five, then 显示更多. */}
        <section className="detail-section">
          <h3 className="detail-title">
            <button type="button" className="detail-fold" aria-expanded={filesOpen} onClick={() => setFilesOpen((o) => !o)}>
              {tc('heading', '文件')}
              <Icon name="chevronDown" size={12} className="detail-fold-chevron" />
              {filesOpen ? null : <span className="detail-count">{files.length || ''}</span>}
            </button>
          </h3>
          {filesOpen ? (
            files.length ? (
              <ul className="detail-list">
                {(allFiles ? files : files.slice(0, FILES_SHOWN)).map((f) => (
                  <li key={f.path}>
                    <button type="button" className="detail-file" onClick={() => (onPreviewFile ?? onOpenFile)(f.path)} title={f.shown ?? f.path}>
                      <FileGlyph name={f.shown ?? f.path} />
                      <span className="detail-file-name">{fileName(f.shown ?? f.path)}</span>
                    </button>
                  </li>
                ))}
                {files.length > FILES_SHOWN ? (
                  <li>
                    <button type="button" className="detail-more" onClick={() => setAllFiles((a) => !a)}>
                      {allFiles ? t('收起') : t('显示更多')}
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="detail-empty">—</p>
            )
          ) : null}
        </section>

        <section className="detail-section">
          <h3 className="detail-title">{t('花费')}</h3>
          <dl className="detail-facts">
            <dt>{t('本对话')}</dt>
            <dd className="num">{session ? spendText(session.costUsd, session.unpriced, formatUsd) : '—'}</dd>
            <dt>{t('全部对话')}</dt>
            <dd className="num">{spendText(globalCostUsd, globalUnpriced, formatUsd)}</dd>
          </dl>
        </section>
      </div>
      ) : null}
    </aside>
  );
}
