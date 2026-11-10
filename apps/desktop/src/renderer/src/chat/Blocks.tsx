// Inline blocks of an answer: text, collapsible thinking and tool rows, and
// the three cards (file, question, suggestion) plus the confirmation card.
import { createContext, memo, useContext, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fileCardLine, type Block, type ChildNote, type FileRef } from '../store/transcript';
import { Icon } from '../ui/Icon';
import { FileBadge } from '../ui/FileIcon';
import { confirmTitle, fileFolder, fileName, formatDuration, GUARD_CAUSE_TEXT, HISTORY_TOOLS, toolLabel, toolTarget } from './format';

/** Opens a conversation by id (links in what the assistant found in earlier conversations). */
export const OpenSessionContext = createContext<((id: string) => void) | null>(null);

/** A history tool's result with each conversation it names (ses_…, ses_…#n) as a link to it. */
function HistoryResult({ text }: { text: string }) {
  const open = useContext(OpenSessionContext);
  if (!open) return <pre className="tool-result">{text}</pre>;
  const parts = text.split(/(\bses_[A-Za-z0-9_-]+(?:#\d+)?)/g);
  return (
    <pre className="tool-result">
      {parts.map((p, i) =>
        /^ses_/.test(p) ? (
          <button key={i} type="button" className="text-btn history-link" onClick={() => open(p.split('#')[0]!)} title="打开该对话">
            {p}
          </button>
        ) : (
          p
        ),
      )}
    </pre>
  );
}
import { SpicaStatusIcon } from '@spica/brand/react';

type ToolBlock = Extract<Block, { type: 'tool' }>;

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" title={href}>
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});

function Disclosure({ open, onToggle, icon, label, meta, children }: { open: boolean; onToggle(): void; icon: ReactNode; label: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className={open ? 'fold fold-open' : 'fold'}>
      <button type="button" className="fold-head" aria-expanded={open} onClick={onToggle}>
        <span className="fold-icon">{icon}</span>
        <span className="fold-label">{label}</span>
        {meta ? <span className="fold-meta">{meta}</span> : null}
        <Icon name="chevronRight" size={14} className="fold-chevron" />
      </button>
      {open ? <div className="fold-body">{children}</div> : null}
    </div>
  );
}

export function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure open={open} onToggle={() => setOpen((o) => !o)} icon={<Icon name="thinking" size={14} />} label={live ? '正在思考' : '思考过程'}>
      <p className="thinking-text">{text}</p>
    </Disclosure>
  );
}

function toolLine(b: ToolBlock): string {
  const target = toolTarget(b.input);
  const verb = toolLabel(b.name);
  return target ? `${verb}  ${target}` : verb;
}

function ToolRow({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const running = block.state === 'running' || block.state === 'pending';
  const meta = running ? (
    <SpicaStatusIcon name="running" size={14} title="进行中" />
  ) : block.state === 'error' ? (
    <span className="status-with-icon text-danger">
      <SpicaStatusIcon name="error" size={14} />
      失败
    </span>
  ) : block.state === 'unavailable' ? (
    <span className="status-with-icon">
      <SpicaStatusIcon name="stopped" size={14} />
      已停用，未执行
    </span>
  ) : block.state === 'timeout' ? (
    <span className="status-with-icon">
      <SpicaStatusIcon name="stopped" size={14} />
      已超时
    </span>
  ) : block.durationMs !== undefined ? (
    block.autoApproved ? `Auto · ${formatDuration(block.durationMs)}` : formatDuration(block.durationMs)
  ) : block.autoApproved ? (
    'Auto'
  ) : null;
  const body = block.result ?? block.preview;
  return (
    <Disclosure open={open} onToggle={() => setOpen((o) => !o)} icon={<Icon name="tool" size={14} />} label={toolLine(block)} meta={meta}>
      {body ? HISTORY_TOOLS.has(block.name) ? <HistoryResult text={body} /> : <pre className="tool-result">{body}</pre> : <p className="tool-empty">—</p>}
    </Disclosure>
  );
}

/** Consecutive tool calls fold into one line; a single call is its own line. */
export function ToolGroup({ blocks }: { blocks: ToolBlock[] }) {
  const [open, setOpen] = useState(false);
  if (blocks.length === 1 && blocks[0]) return <ToolRow block={blocks[0]} />;
  const running = blocks.find((b) => b.state === 'running' || b.state === 'pending');
  const failed = blocks.filter((b) => b.state === 'error').length;
  const total = blocks.reduce((n, b) => n + (b.durationMs ?? 0), 0);
  const label = running ? `${toolLine(running)}` : `调用了 ${blocks.length} 个工具`;
  const meta = running ? (
    <SpicaStatusIcon name="running" size={14} title="进行中" />
  ) : failed ? (
    <span className="status-with-icon text-danger">
      <SpicaStatusIcon name="error" size={14} />
      {failed} 个失败
    </span>
  ) : total ? formatDuration(total) : null;
  return (
    <Disclosure open={open} onToggle={() => setOpen((o) => !o)} icon={<Icon name="tool" size={14} />} label={label} meta={meta}>
      <div className="fold-list">
        {blocks.map((b) => (
          <ToolRow key={b.callId} block={b} />
        ))}
      </div>
    </Disclosure>
  );
}

export function FileCards({ files, onOpen }: { files: FileRef[]; onOpen(path: string): void }) {
  if (files.length === 0) return null;
  return (
    <div className="file-cards">
      {files.map((f) => (
        <button key={f.path} type="button" className="card file-card" onClick={() => onOpen(f.path)} title={`打开 ${f.path}`}>
          <FileBadge name={f.card?.name ?? fileName(f.path)} />
          <span className="file-card-text">
            <span className="file-card-name">{f.card?.name ?? fileName(f.path)}</span>
            <span className="file-card-sub">
              {f.card ? fileCardLine(f.card) : `${f.tool === 'read_file' ? '已读取' : f.tool === 'write_file' ? '已写入' : '已修改'}${fileFolder(f.path) ? ` · ${fileFolder(f.path)}` : ''}`}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function AskCard({ block, onAnswer }: { block: Extract<Block, { type: 'ask' }>; onAnswer(answer: string): void }) {
  const [draft, setDraft] = useState('');
  const answered = block.answer !== undefined;
  const submit = (value: string) => {
    const v = value.trim();
    if (v) onAnswer(v);
  };
  return (
    <section className={answered ? 'card ask-card is-done' : 'card ask-card'} aria-label="提问">
      <header className="card-head">
        <Icon name="question" size={16} className="card-head-icon" />
        <span className="card-title">{block.question}</span>
      </header>
      {answered ? (
        <p className="card-answer">
          <SpicaStatusIcon name="done" size={15} />
          <span>{block.answer}</span>
        </p>
      ) : (
        <>
          {block.options.length ? (
            <div className="ask-options">
              {block.options.map((o) => (
                <button key={o} type="button" className="btn ask-option" onClick={() => submit(o)}>
                  {o}
                </button>
              ))}
            </div>
          ) : null}
          <form
            className="ask-free"
            onSubmit={(e) => {
              e.preventDefault();
              submit(draft);
            }}
          >
            <input
              className="input"
              value={draft}
              placeholder={block.options.length ? '或输入回答' : '输入回答'}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="回答"
            />
            <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
              回答
            </button>
          </form>
        </>
      )}
    </section>
  );
}

export function ConfirmCard({ block, onDecide }: { block: Extract<Block, { type: 'confirm' }>; onDecide(approved: boolean): void }) {
  const decided = block.approved !== undefined;
  return (
    <section className={decided ? 'card confirm-card is-done' : 'card confirm-card'} aria-label="确认">
      <header className="card-head">
        <Icon name="shield" size={16} className="card-head-icon" />
        <span className="card-title">{confirmTitle(block.name, block.input, block.reason)}</span>
      </header>
      {block.cause && GUARD_CAUSE_TEXT[block.cause] ? <p className="card-why">{GUARD_CAUSE_TEXT[block.cause]}</p> : null}
      {decided ? (
        <p className="card-answer">
          <SpicaStatusIcon name={block.approved ? 'done' : 'stopped'} size={15} />
          <span>{block.approved ? '已允许' : '已拒绝'}</span>
        </p>
      ) : (
        <div className="card-actions">
          <button type="button" className="btn" onClick={() => onDecide(false)}>
            拒绝
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onDecide(true)}>
            允许
          </button>
        </div>
      )}
    </section>
  );
}

export function SuggestCard({ block, onPick }: { block: Extract<Block, { type: 'suggest' }>; onPick(prompt: string): void }) {
  if (block.actions.length === 0) return null;
  return (
    <section className="card suggest-card" aria-label="操作建议">
      {block.title ? <header className="suggest-title">{block.title}</header> : null}
      <div className="suggest-list">
        {block.actions.map((a) => (
          <button key={a.label} type="button" className="suggest-item" onClick={() => onPick(a.prompt)} title={a.prompt}>
            <span>{a.label}</span>
            <Icon name="arrowRight" size={14} />
          </button>
        ))}
      </div>
    </section>
  );
}

const NOTE_HEAD: Record<ChildNote['kind'], string> = {
  report: '已完成',
  relay: '你的回复',
  decision: '已决定',
};

/** A sub-agent's report, something the user said in a sub-session, or a decision made there. */
export function ChildNoteCard({ note, onOpen }: { note: ChildNote; onOpen(id: string): void }) {
  const from = note.fromTitle ?? '子任务';
  const head = NOTE_HEAD[note.kind];
  return (
    <section className={`card note-card note-${note.kind}`} aria-label={`${from}：${head}`}>
      <header className="note-head">
        <button type="button" className="note-from" onClick={() => onOpen(note.fromSessionId)} title={`打开「${from}」`}>
          {from}
        </button>
        <span className="note-kind">{head}</span>
      </header>
      {note.kind === 'report' ? <MarkdownText text={note.text} /> : <p className="note-text">{note.text}</p>}
    </section>
  );
}
