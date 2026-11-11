// Inline blocks of an answer: text, collapsible thinking and tool rows, and
// the three cards (file, question, suggestion) plus the confirmation card.
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileCardMeta, HistoryCardMeta } from '@spica/protocol';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fileCardLine, fileCardVerb, type Block, type ChildNote, type FileRef } from '../store/transcript';
import { Icon } from '../ui/Icon';
import { FileBadge } from '../ui/FileIcon';
import { clipboard } from '../ui/clipboard';
import { CopyButton } from '../ui/CopyButton';
import { fullPath, openablePathKind } from './local-path';
import { tableRows, toCsv, toHtml, toTsv } from './table-data';
import { blockLanguage, blockLanguageName, colourSplit, highlightCode } from './highlight';
import { confirmTitle, fileFolder, fileName, formatClock, formatDuration, GUARD_CAUSE_TEXT, HISTORY_TOOLS } from './format';
import { groupWords, runningGroup, runningWords, toolWords } from './tool-words';

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

/** What an answer's paths and tables can do here: absent where nothing opens (the paths stay plain code). */
export interface AnswerTools {
  /** A file path clicked: shown in the right panel. */
  openFile(path: string): void;
  /** A folder path clicked: opened in Explorer. */
  openFolder(path: string): void;
  /** The conversation's working folder: a network path (\\host\share\…) opens only inside it. */
  cwd?: string | undefined;
  /** 导出 CSV on a table; absent: no such button. */
  saveCsv?: ((text: string) => Promise<boolean>) | undefined;
}
export const AnswerToolsContext = createContext<AnswerTools | null>(null);

/** Set inside a code block, so its code is not taken for inline code. */
const InBlockContext = createContext(false);

/** The parts of a code block's syntax node this needs: its code element, and where it ends in the answer's text. */
interface PreNode {
  position?: { end?: { offset?: number | undefined } } | undefined;
  children?: { type: string; tagName?: string; properties?: { className?: unknown }; children?: { type: string; value?: string }[] }[];
}

/**
 * A code block: a slim head with the language as written (empty when none) and 复制, always there; the code
 * below it, scrolling sideways on its own. Coloured line by line as it streams in: finished lines are coloured,
 * the one being written stays plain until it ends (`source`: the answer's text, to see whether the block is
 * closed yet). A coloured line never changes back, and colouring does not move the text.
 */
function CodeBlock({ node, source, children }: { node?: PreNode | undefined; source: string; children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const code = node?.children?.find((c) => c.type === 'element' && c.tagName === 'code');
  const name = blockLanguageName(code?.properties?.className);
  const language = blockLanguage(code?.properties?.className);
  const raw = code?.children?.map((t) => (t.type === 'text' ? (t.value ?? '') : '')).join('') ?? '';
  const end = node?.position?.end?.offset;
  const closed = end !== undefined && /(?:`{3,}|~{3,})[ \t]*$/.test(source.slice(0, end));
  // The code's text always ends with a line break; while the block is open, its last line is finished only when
  // the answer's text so far ends with one.
  const upto = end !== undefined ? source.slice(0, end) : source;
  const text = closed || upto.endsWith('\n') || !raw.endsWith('\n') ? raw : raw.slice(0, -1);
  const { done, rest } = language ? colourSplit(text, closed) : { done: '', rest: text };
  const tail = raw.slice(text.length);
  const coloured = useMemo(() => (language && done ? highlightCode(language, done) : null), [language, done]);
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{name}</span>
        <CopyButton className="icon-btn md-tool" copy={() => clipboard.write((ref.current?.textContent ?? '').replace(/\n$/, ''))} />
      </div>
      <pre ref={ref}>
        {coloured ? (
          <code className={`language-${language}`}>
            {coloured}
            {rest}
            {tail}
          </code>
        ) : (
          <InBlockContext.Provider value={true}>{children}</InBlockContext.Provider>
        )}
      </pre>
    </div>
  );
}

/** Inline code: a full local path in it opens (a file in the right panel, a folder in Explorer); anything else is code. */
function InlineCode({ className, children }: { className?: string | undefined; children?: ReactNode }) {
  const inBlock = useContext(InBlockContext);
  const tools = useContext(AnswerToolsContext);
  const text = typeof children === 'string' ? children : null;
  const kind = !inBlock && tools && text !== null ? openablePathKind(text, tools.cwd) : null;
  if (!kind || !tools || text === null) return <code className={className}>{children}</code>;
  const open = () => (kind === 'folder' ? tools.openFolder(text) : tools.openFile(text));
  // A link role on the code itself (not a button around it), so a long path still wraps with the line.
  return (
    <code
      className="md-path"
      role="link"
      tabIndex={0}
      title={kind === 'folder' ? '打开文件夹' : '预览'}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      {text}
    </code>
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
          pre: ({ node, children }) => (
            <CodeBlock node={node as PreNode | undefined} source={text}>
              {children}
            </CodeBlock>
          ),
          code: ({ className, children }) => <InlineCode className={className}>{children}</InlineCode>,
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

/** Each call's file card (write_file's says Created or Edited and the lines), by call id. */
export const ToolCardsContext = createContext<Record<string, FileCardMeta> | undefined>(undefined);

/** What a call's own line says after its words: how it ended (Failed, stopped), or how long it took. */
function toolMeta(block: ToolBlock): ReactNode {
  if (block.state === 'pending') return <SpicaStatusIcon name="running" size={14} title="进行中" />;
  if (block.state === 'error') return <span className="text-danger">Failed</span>;
  if (block.state === 'unavailable') return '已停用，未执行';
  if (block.state === 'timeout') return '已超时';
  if (block.state === 'running') return null;
  if (block.durationMs !== undefined) return block.autoApproved ? `Auto · ${formatDuration(block.durationMs)}` : formatDuration(block.durationMs);
  return block.autoApproved ? 'Auto' : null;
}

/** A call's words: the verb quieter, the object as it is; the whole path or address on hover when it was cut. */
function ToolText({ block }: { block: ToolBlock }) {
  const card = useContext(ToolCardsContext)?.[block.callId];
  const w = toolWords(block, card);
  return (
    <span className="tool-text" title={w.full ?? (block.summary && block.name === 'run_command' ? toolArg(block, 'command') : undefined)}>
      {w.verb ? <span className="tool-verb">{w.verb}</span> : null}
      {w.verb ? ' ' : null}
      <span className="tool-object">{w.object}</span>
    </span>
  );
}

const toolArg = (b: ToolBlock, key: string): string => {
  const v = (b.input as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' ? v : '';
};

/** A call's arguments as short lines (long values cut), for steps that are not a command. */
function argsText(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => {
      const t = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${t && t.length > 300 ? `${t.slice(0, 300)}…` : t}`;
    })
    .join('\n');
}

/**
 * The innermost level: a command as written (in a code box of its own that scrolls) and what it printed; other
 * steps give their arguments and their result as plain text; the history tools their table.
 */
function ToolDetail({ block }: { block: ToolBlock }) {
  const history = useContext(HistoryCardsContext)?.[block.callId];
  if (history && HISTORY_TOOLS.has(block.name)) return <HistoryTable card={history} />;
  const body = block.result ?? block.preview;
  const command = block.name === 'run_command' ? toolArg(block, 'command') : '';
  const args = command ? '' : argsText(block.input);
  return (
    <div className="tool-detail">
      {command ? <CommandBox command={command} /> : args ? <pre className="tool-args">{args}</pre> : null}
      {body ? <pre className="tool-result">{body}</pre> : !command && !args ? <p className="tool-empty">—</p> : null}
    </div>
  );
}

/** A command as written: $ and the command, coloured as PowerShell, in a box that scrolls on its own. */
function CommandBox({ command }: { command: string }) {
  const coloured = useMemo(() => highlightCode('powershell', command), [command]);
  return (
    <div className="tool-command">
      <div className="code-head">
        <span className="code-lang" />
        <CopyButton className="icon-btn md-tool" copy={() => clipboard.write(command)} />
      </div>
      <pre>
        <code>
          <span className="tool-prompt">$ </span>
          {coloured ?? command}
        </code>
      </pre>
    </div>
  );
}

/** One call in a group's list: its state first, its words, how it ended; a click opens the command and its output. */
function ToolItem({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? 'tool-item is-open' : 'tool-item'}>
      <button type="button" className="tool-item-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="fold-icon">{toolIcon(block)}</span>
        {block.state === 'running' || block.state === 'pending' ? <span className="tool-text">{runningWords(block)}</span> : <ToolText block={block} />}
        {toolMeta(block) ? <span className="fold-meta">{toolMeta(block)}</span> : null}
        <Icon name="chevronRight" size={14} className="fold-chevron" />
      </button>
      {open ? (
        <div className="tool-item-body">
          <ToolDetail block={block} />
        </div>
      ) : null}
    </div>
  );
}

/** `since`: a call on its own that is what the run is doing now: said as Running … with the run's clock at the end. */
function ToolRow({ block, since }: { block: ToolBlock; since?: number | undefined }) {
  const [open, setOpen] = useState(false);
  const now = since !== undefined && block.state === 'running';
  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen((o) => !o)}
      icon={now ? LIVE_MARK : toolIcon(block)}
      label={now || block.state === 'running' || block.state === 'pending' ? runningWords(block) : <ToolText block={block} />}
      meta={toolMeta(block)}
      tail={now ? <RunClock since={since} /> : undefined}
    >
      <ToolDetail block={block} />
    </Disclosure>
  );
}

/** What the group's line says while its tools run: the first running one, and how many more run with it. */
export function runningText(running: ToolBlock[]): string {
  return runningGroup(running);
}

/**
 * Consecutive tool calls fold into one line that says what they did (Ran 4 commands, created a file); open, it
 * lists them one per line; a call opens to its command and output. A single call is its own line. `since`: these
 * are what the run is doing now: while some run, the line says so (the turning mark first, Running and the
 * step, the run's clock at the end) in place of the status line under the answer.
 */
export function ToolGroup({ blocks, since }: { blocks: ToolBlock[]; since?: number | undefined }) {
  const [open, setOpen] = useState(false);
  const cards = useContext(ToolCardsContext);
  if (blocks.length === 1 && blocks[0]) return <ToolRow block={blocks[0]} since={since} />;
  const running = blocks.filter((b) => b.state === 'running');
  const busy = running.length > 0 || blocks.some((b) => b.state === 'pending');
  const now = since !== undefined && running.length > 0;
  const failed = blocks.filter((b) => b.state === 'error').length;
  const total = blocks.reduce((n, b) => n + (b.durationMs ?? 0), 0);
  const label = now ? runningText(running) : busy ? runningWords(running[0] ?? blocks.find((b) => b.state === 'pending')!) : groupWords(blocks.map((b) => ({ call: b, card: cards?.[b.callId] })));
  const meta = busy ? (now ? null : <SpicaStatusIcon name="running" size={14} title="进行中" />) : failed ? <span className="text-danger">{failed} failed</span> : total ? formatDuration(total) : null;
  return (
    <Disclosure open={open} onToggle={() => setOpen((o) => !o)} icon={now ? LIVE_MARK : <Icon name="tool" size={14} />} label={label} meta={meta} tail={now ? <RunClock since={since} /> : undefined}>
      <div className="tool-list">
        {blocks.map((b) => (
          <ToolItem key={b.callId} block={b} />
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

/** Up to this many cards show at once; more (a command can report 20) fold behind 全部 N 个. */
export const FILE_CARDS_SHOWN = 6;

/** The second line of a card: what the round did with the file (Created +8 −1), or what was read. */
function FileCardSub({ f }: { f: FileRef }) {
  const verb = fileCardVerb(f);
  if (verb)
    return (
      <span className="file-card-sub">
        {verb}
        {f.lines?.added ? <span className="file-lines-added"> +{f.lines.added}</span> : null}
        {f.lines?.removed ? <span className="file-lines-removed"> −{f.lines.removed}</span> : null}
      </span>
    );
  const shown = f.shown ?? f.path;
  return <span className="file-card-sub">{f.card ? fileCardLine(f.card) : `${f.tool === 'read_file' ? '已读取' : f.tool === 'write_file' ? '已写入' : '已修改'}${fileFolder(shown) ? ` · ${fileFolder(shown)}` : ''}`}</span>;
}

export function FileCards({ files, onOpen, actions }: { files: FileRef[]; onOpen(path: string): void; actions?: FileCardActions | undefined }) {
  const [all, setAll] = useState(false);
  if (files.length === 0) return null;
  // Folded only when it saves at least two cards' room, so 全部 N 个 never stands in for a single card.
  const fold = files.length > FILE_CARDS_SHOWN + 1;
  const shownFiles = fold && !all ? files.slice(0, FILE_CARDS_SHOWN) : files;
  return (
    <>
    <div className="file-cards">
      {shownFiles.map((f) => {
        const shown = f.shown ?? f.path;
        const full = fullPath(f.path, actions?.cwd);
        return (
          <div key={f.path} className="card file-card">
            <button type="button" className="file-card-main" onClick={() => onOpen(f.path)} title={`打开 ${full}`}>
              <FileBadge name={f.card?.name ?? fileName(shown)} />
              <span className="file-card-text">
                <span className="file-card-name">{f.card?.name ?? fileName(shown)}</span>
                <FileCardSub f={f} />
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
    {fold ? (
      <button type="button" className="btn file-cards-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
        {all ? '收起' : `全部 ${files.length} 个`}
      </button>
    ) : null}
    </>
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
