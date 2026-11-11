// Inline blocks of an answer: text, collapsible thinking and tool rows, and
// the three cards (file, question, suggestion) plus the confirmation card.
import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { HistoryCardMeta } from '@spica/protocol';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fileCardLine, type Block, type ChildNote, type FileRef } from '../store/transcript';
import { Icon } from '../ui/Icon';
import { FileBadge } from '../ui/FileIcon';
import { clipboard } from '../ui/clipboard';
import { CopyButton } from '../ui/CopyButton';
import { fullPath } from './local-path';
import { tableRows, toCsv, toHtml, toTsv } from './table-data';
import { confirmTitle, fileFolder, fileName, formatClock, formatDuration, GUARD_CAUSE_TEXT, HISTORY_TOOLS, toolLabel, toolTarget } from './format';

/** Opens a conversation by id, at message number `seq` when given (rows and links from earlier conversations). */
export const OpenSessionContext = createContext<((id: string, seq?: number) => void) | null>(null);
/** Where history:n links in this conversation go (its history tools' rows by their number). */
export const HistoryRefContext = createContext<((ref: number) => { sessionId: string; seq?: number } | undefined) | null>(null);
/** What the history tools found in this conversation, by call id. */
export const HistoryCardsContext = createContext<Record<string, HistoryCardMeta> | undefined>(undefined);

const HISTORY_COLUMN: Record<HistoryCardMeta['tool'], string> = { search_history: '匹配内容', read_history: '内容', find_history_files: '文件' };

/** What a history tool found, as a two-column table: the conversation, and the matching text (or the file).
 *  A row opens that conversation at the message. The text given to the model is not shown. */
function HistoryTable({ card }: { card: HistoryCardMeta }) {
  const open = useContext(OpenSessionContext);
  if (!card.rows.length) return <p className="tool-empty">没有找到</p>;
  return (
    <div className="history-table">
      <div className="history-head" aria-hidden>
        <span>对话</span>
        <span>{HISTORY_COLUMN[card.tool]}</span>
      </div>
      {card.rows.map((r) => {
        const name = r.name ?? '未命名对话';
        const project = r.projectName && r.projectName !== name ? r.projectName : '';
        const right = card.tool === 'find_history_files' ? (r.path ?? r.text) : r.text;
        return (
          <button key={`${r.ref}|${r.sessionId}|${r.seq ?? 0}`} type="button" className="history-row" onClick={() => open?.(r.sessionId, r.seq)} aria-label={`打开「${name}」`}>
            <span className="history-name">
              {name}
              {project ? <span className="history-project">{project}</span> : null}
            </span>
            <span className="history-text">{right}</span>
          </button>
        );
      })}
      {card.total > card.rows.length ? <p className="history-more">共 {card.total} 条，显示最近 {card.rows.length} 条</p> : null}
    </div>
  );
}

/** [name](history:n) in an answer: opens that conversation at the place; plain text when the number is not known here. */
function HistoryLink({ href, children }: { href: string; children: ReactNode }) {
  const open = useContext(OpenSessionContext);
  const resolve = useContext(HistoryRefContext);
  const digits = href.slice('history:'.length);
  const to = /^\d+$/.test(digits) ? resolve?.(Number(digits)) : undefined;
  if (!to || !open) return <>{children}</>;
  return (
    <button type="button" className="text-btn history-link" title="打开对话" onClick={() => open(to.sessionId, to.seq)}>
      {children}
    </button>
  );
}
import { SpicaMark, SpicaStatusIcon } from '@spica/brand/react';

type ToolBlock = Extract<Block, { type: 'tool' }>;

/** What an answer's tables can do here. */
export interface AnswerTools {
  /** 导出 CSV on a table; absent: no such button. */
  saveCsv?: ((text: string) => Promise<boolean>) | undefined;
}
export const AnswerToolsContext = createContext<AnswerTools | null>(null);

/** A code block: the code as written, 复制 at its top right (always there). */
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="code-block">
      <pre ref={ref}>
        {children}
      </pre>
      <div className="code-tools">
        <CopyButton className="icon-btn md-tool" copy={() => clipboard.write((ref.current?.textContent ?? '').replace(/\n$/, ''))} />
      </div>
    </div>
  );
}

/** A table: 复制 (pastes into Excel as cells) and 导出 CSV above its right end. */
function MdTable({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);
  const tools = useContext(AnswerToolsContext);
  const rows = () => (ref.current ? tableRows(ref.current) : []);
  return (
    <div className="md-table">
      <div className="md-table-tools">
        <CopyButton className="icon-btn md-tool" copy={() => clipboard.writeRich(toTsv(rows()), toHtml(rows()))} />
        {tools?.saveCsv ? <SaveCsvButton save={(text) => tools.saveCsv!(text)} rows={rows} /> : null}
      </div>
      <table ref={ref}>{children}</table>
    </div>
  );
}

function SaveCsvButton({ save, rows }: { save(text: string): Promise<boolean>; rows(): string[][] }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const shown = done ? '已导出' : '导出 CSV';
  return (
    <button
      type="button"
      className="icon-btn md-tool"
      aria-label={shown}
      title={shown}
      onClick={() =>
        void save(toCsv(rows()))
          .then((ok) => {
            if (!ok) return;
            setDone(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setDone(false), 1500);
          })
          .catch(() => undefined)
      }
    >
      <Icon name={done ? 'check' : 'download'} size={14} />
    </button>
  );
}

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        // history:n (a place in an earlier conversation) is kept; other addresses as react-markdown allows them.
        urlTransform={(url) => (url.startsWith('history:') ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) =>
            href?.startsWith('history:') ? (
              <HistoryLink href={href}>{children}</HistoryLink>
            ) : (
              <a href={href} target="_blank" rel="noreferrer" title={href}>
                {children}
              </a>
            ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => <MdTable>{children}</MdTable>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});

function Disclosure({ open, onToggle, icon, label, meta, tail, children }: { open: boolean; onToggle(): void; icon: ReactNode; label: ReactNode; meta?: ReactNode; tail?: ReactNode; children?: ReactNode }) {
  return (
    <div className={open ? 'fold fold-open' : 'fold'}>
      <button type="button" className="fold-head" aria-expanded={open} onClick={onToggle}>
        <span className="fold-icon">{icon}</span>
        <span className="fold-label">{label}</span>
        {meta ? <span className="fold-meta">{meta}</span> : null}
        <Icon name="chevronRight" size={14} className="fold-chevron" />
        {tail ? <span className="fold-meta">{tail}</span> : null}
      </button>
      {open ? <div className="fold-body">{children}</div> : null}
    </div>
  );
}

/**
 * The time this run has taken, ticking: at the end of the line that says what it is doing now
 * (that line stands in for the status line under the answer while it is there).
 */
function RunClock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="status-clock">{formatClock(now - since)}</span>;
}

/** The turning mark at the front of the line that says what the run is doing now. */
const LIVE_MARK = <SpicaMark size={14} state="tool" className="fold-mark" />;

/** `since`: this is what the run is doing right now (the run's start, for the clock at the end). */
export function ThinkingBlock({ text, live, since }: { text: string; live: boolean; since?: number | undefined }) {
  const [open, setOpen] = useState(false);
  const now = live && since !== undefined;
  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen((o) => !o)}
      icon={now ? <SpicaMark size={14} state="think" className="fold-mark" /> : <Icon name="thinking" size={14} />}
      label={live ? '正在思考' : '思考过程'}
      tail={now ? <RunClock since={since} /> : undefined}
    >
      <p className="thinking-text">{text}</p>
    </Disclosure>
  );
}

function toolLine(b: ToolBlock): string {
  const target = toolTarget(b.input);
  const verb = toolLabel(b.name);
  return target ? `${verb}  ${target}` : verb;
}

/**
 * The first place of a tool's line says how it stands: turning while it runs, done, failed,
 * stopped (timed out, or its plugin was off). Nothing after the name repeats it. A call not
 * started yet keeps the tool icon and the turning ring after its name.
 */
export function toolIcon(b: ToolBlock): ReactNode {
  switch (b.state) {
    case 'running':
      return <SpicaStatusIcon name="running" size={14} title="进行中" />;
    case 'done':
      return <SpicaStatusIcon name="done" size={14} />;
    case 'error':
      return <SpicaStatusIcon name="error" size={14} />;
    case 'unavailable':
    case 'timeout':
      return <SpicaStatusIcon name="stopped" size={14} />;
    default:
      return <Icon name="tool" size={14} />;
  }
}

/** `since`: a call on its own that is what the run is doing now: said as 正在… with the run's clock at the end. */
function ToolRow({ block, since }: { block: ToolBlock; since?: number | undefined }) {
  const [open, setOpen] = useState(false);
  const now = since !== undefined && block.state === 'running';
  const meta = block.state === 'pending' ? (
    <SpicaStatusIcon name="running" size={14} title="进行中" />
  ) : block.state === 'error' ? (
    <span className="text-danger">Failed</span>
  ) : block.state === 'unavailable' ? (
    '已停用，未执行'
  ) : block.state === 'timeout' ? (
    '已超时'
  ) : block.state === 'running' ? null : block.durationMs !== undefined ? (
    block.autoApproved ? `Auto · ${formatDuration(block.durationMs)}` : formatDuration(block.durationMs)
  ) : block.autoApproved ? (
    'Auto'
  ) : null;
  const body = block.result ?? block.preview;
  const card = useContext(HistoryCardsContext)?.[block.callId];
  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen((o) => !o)}
      icon={now ? LIVE_MARK : toolIcon(block)}
      label={now ? `正在${toolLine(block)}` : toolLine(block)}
      meta={meta}
      tail={now ? <RunClock since={since} /> : undefined}
    >
      {card && HISTORY_TOOLS.has(block.name) ? <HistoryTable card={card} /> : body ? <pre className="tool-result">{body}</pre> : <p className="tool-empty">—</p>}
    </Disclosure>
  );
}

/** What the group's line says while its tools run: the first running one by name, and how many when more run at once. */
export function runningText(running: ToolBlock[]): string {
  const first = running[0]!;
  return running.length > 1 ? `正在${toolLabel(first.name)} 等 ${running.length} 个工具` : `正在${toolLine(first)}`;
}

/**
 * Consecutive tool calls fold into one line; a single call is its own line. `since`: these are
 * what the run is doing now: while some run, the line says so (the turning mark first, 正在 and
 * the tool, the run's clock at the end) in place of the status line under the answer; after, it
 * is 调用了 N 个工具 again, with how many failed.
 */
export function ToolGroup({ blocks, since }: { blocks: ToolBlock[]; since?: number | undefined }) {
  const [open, setOpen] = useState(false);
  if (blocks.length === 1 && blocks[0]) return <ToolRow block={blocks[0]} since={since} />;
  const running = blocks.filter((b) => b.state === 'running');
  const busy = running.length > 0 || blocks.some((b) => b.state === 'pending');
  const now = since !== undefined && running.length > 0;
  const failed = blocks.filter((b) => b.state === 'error').length;
  const total = blocks.reduce((n, b) => n + (b.durationMs ?? 0), 0);
  const label = now ? runningText(running) : busy ? toolLine(running[0] ?? blocks.find((b) => b.state === 'pending')!) : `调用了 ${blocks.length} 个工具`;
  const meta = busy ? (now ? null : <SpicaStatusIcon name="running" size={14} title="进行中" />) : failed ? <span className="text-danger">{failed} failed</span> : total ? formatDuration(total) : null;
  return (
    <Disclosure open={open} onToggle={() => setOpen((o) => !o)} icon={now ? LIVE_MARK : <Icon name="tool" size={14} />} label={label} meta={meta} tail={now ? <RunClock since={since} /> : undefined}>
      <div className="fold-list">
        {blocks.map((b) => (
          <ToolRow key={b.callId} block={b} />
        ))}
      </div>
    </Disclosure>
  );
}

/** A file card's two actions at its right end, always there: 打开所在文件夹 and 复制路径. */
export interface FileCardActions {
  /** Shows the file selected in Explorer (an absolute path). */
  reveal(path: string): void;
  /** The conversation's working folder, for a path the model wrote relative to it. */
  cwd?: string | undefined;
}

export function FileCards({ files, onOpen, actions }: { files: FileRef[]; onOpen(path: string): void; actions?: FileCardActions | undefined }) {
  if (files.length === 0) return null;
  return (
    <div className="file-cards">
      {files.map((f) => {
        const shown = f.shown ?? f.path;
        const full = fullPath(f.path, actions?.cwd);
        return (
          <div key={f.path} className="card file-card">
            <button type="button" className="file-card-main" onClick={() => onOpen(f.path)} title={`打开 ${full}`}>
              <FileBadge name={f.card?.name ?? fileName(shown)} />
              <span className="file-card-text">
                <span className="file-card-name">{f.card?.name ?? fileName(shown)}</span>
                <span className="file-card-sub">
                  {f.card ? fileCardLine(f.card) : `${f.tool === 'read_file' ? '已读取' : f.tool === 'write_file' ? '已写入' : '已修改'}${fileFolder(shown) ? ` · ${fileFolder(shown)}` : ''}`}
                </span>
              </span>
            </button>
            {actions ? (
              <span className="file-card-tools">
                <button type="button" className="icon-btn md-tool" aria-label="打开所在文件夹" title="打开所在文件夹" onClick={() => actions.reveal(full)}>
                  <Icon name="folder" size={14} />
                </button>
                <CopyButton className="icon-btn md-tool" label="复制路径" copy={() => clipboard.write(full)} />
              </span>
            ) : null}
          </div>
        );
      })}
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
