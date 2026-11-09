// Right panel: details of the open session (tool calls, files, cost).
import type { SessionInfo } from '@spica/protocol';
import { filesOf, type Block, type Transcript } from '../store/transcript';
import { Icon } from '../ui/Icon';
import { fileFolder, fileName, formatDuration, formatUsd, toolLabel, toolTarget } from '../chat/format';

type ToolBlock = Extract<Block, { type: 'tool' }>;

export interface DetailPanelProps {
  session: SessionInfo | undefined;
  parent: SessionInfo | undefined;
  transcript: Transcript;
  globalCostUsd: number;
  onOpenFile(path: string): void;
  onOpenSession(id: string): void;
  onClose?: () => void;
}

const ROLE_LABEL: Record<SessionInfo['role'], string> = { top: '对话', manager: '项目经理', worker: '子任务' };

export function DetailPanel({ session, parent, transcript, globalCostUsd, onOpenFile, onOpenSession, onClose }: DetailPanelProps) {
  const blocks = transcript.items.flatMap((i) => (i.kind === 'response' ? i.blocks : []));
  const tools = blocks.filter((b): b is ToolBlock => b.type === 'tool');
  const files = filesOf(blocks, transcript.fileCards);
  return (
    <aside className="detail" aria-label="详情">
      <header className="detail-head">
        <span className="detail-heading">详情</span>
        {onClose ? (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭详情" title="关闭详情">
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </header>
      {/* Nothing open yet: the panel stays empty rather than a column of dashes. */}
      {session ? (
      <div className="detail-scroll">
        {session ? (
          <section className="detail-section">
            <dl className="detail-facts">
              <dt>类型</dt>
              <dd>{ROLE_LABEL[session.role]}</dd>
              {parent ? (
                <>
                  <dt>属于</dt>
                  <dd>
                    <button type="button" className="link-btn" onClick={() => onOpenSession(parent.id)}>
                      {parent.title}
                    </button>
                  </dd>
                </>
              ) : null}
              {session.cwd ? (
                <>
                  <dt>文件夹</dt>
                  <dd className="detail-path" title={session.cwd}>
                    {session.cwd}
                  </dd>
                </>
              ) : null}
            </dl>
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
                    {t.state === 'running' || t.state === 'pending' ? <span className="spinner" aria-label="进行中" /> : t.durationMs !== undefined ? formatDuration(t.durationMs) : ''}
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
                  <button type="button" className="detail-file" onClick={() => onOpenFile(f.path)} title={`打开 ${f.path}`}>
                    <Icon name="file" size={14} />
                    <span className="detail-file-name">{fileName(f.path)}</span>
                    {fileFolder(f.path) ? <span className="detail-item-sub">{fileFolder(f.path)}</span> : null}
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
            <dt>本会话</dt>
            <dd className="num">{session ? formatUsd(session.costUsd) : '—'}</dd>
            <dt>全部会话</dt>
            <dd className="num">{formatUsd(globalCostUsd)}</dd>
          </dl>
        </section>
      </div>
      ) : null}
    </aside>
  );
}
