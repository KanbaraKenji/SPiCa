// Inline blocks of an answer: text, collapsible thinking and tool rows, and
// the three cards (file, question, suggestion) plus the confirmation card.
import { createContext, Fragment, memo, useContext, useEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import type { FileCardMeta, HistoryCardMeta, SourceCardMeta, SourceRow } from '@spica/protocol';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fileCardLine, fileCardParts, fileCardVerb, type Block, type ChildNote, type FileRef } from '../store/transcript';
import { Icon } from '../ui/Icon';
import { FileBadge, FileGlyph } from '../ui/FileIcon';
import { clipboard } from '../ui/clipboard';
import { CopyButton } from '../ui/CopyButton';
import { ImageViewer, useImageGroup, type Picture } from '../ui/ImageViewer';
import { imageSource } from './answer-image';
import { drawFlow, pageMode, svgUrl } from './flow-draw';
import { commandFacts, dangerSpans } from './command-plain';
import { fullPath, openablePathKind, pathLabel, remarkLocalPaths } from './local-path';
import { tableRows, toCsv, toHtml, toTsv } from './table-data';
import { blockLanguage, blockLanguageName, colourSplit, highlightCode } from './highlight';
import { confirmTitle, fileFolder, fileName, formatClock, formatDuration, GUARD_CAUSE_TEXT, HISTORY_TOOLS } from './format';
import { groupWords, runningGroup, runningWords, toolWords } from './tool-words';
import { hostOf } from './sources';

/** Opens a conversation by id, at message number `seq` when given (rows and links from earlier conversations). */
export const OpenSessionContext = createContext<((id: string, seq?: number) => void) | null>(null);
/** Where history:n links in this conversation go (its history tools' rows by their number). */
export const HistoryRefContext = createContext<((ref: number) => { sessionId: string; seq?: number } | undefined) | null>(null);
/** What the history tools found in this conversation, by call id. */
export const HistoryCardsContext = createContext<Record<string, HistoryCardMeta> | undefined>(undefined);
/**
 * The round these tool lines are in is over (他: 「已经完成的轮次工具调用后面不写时间」): no time after a call, a
 * group or a step. While the round goes on each finished step keeps its time, to see which one is slow.
 */
export const RoundDoneContext = createContext(false);

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
  /** A URL that shows a local picture (the app's file scheme); absent: local pictures show as their caption. */
  imageUrl?: ((path: string) => Promise<string>) | undefined;
  /** An HTML code block's card was clicked: the page in the right panel (its title, and the HTML). */
  previewHtml?: ((title: string, html: string) => void) | undefined;
  /** Pictures on the web: loaded as the answer shows ('auto'), only after a click ('click'), or never (absent). */
  webImages?: 'auto' | 'click' | undefined;
}
export const AnswerToolsContext = createContext<AnswerTools | null>(null);

/** Every full local path written in inline code in this answer: a path shows its name, enough of it to tell it from the others. */
const AnswerPathsContext = createContext<readonly string[]>([]);

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
  const code = node?.children?.find((c) => c.type === 'element' && c.tagName === 'code');
  const name = blockLanguageName(code?.properties?.className);
  const tools = useContext(AnswerToolsContext);
  if (tools?.previewHtml && /^html?$/i.test(name)) {
    const raw = code?.children?.map((t) => (t.type === 'text' ? (t.value ?? '') : '')).join('') ?? '';
    const end = node?.position?.end?.offset;
    const closed = end !== undefined && /(?:`{3,}|~{3,})[ \t]*$/.test(source.slice(0, end));
    return <HtmlCard html={raw.replace(/\n$/, '')} closed={closed} open={tools.previewHtml} />;
  }
  const body = (
    <CodeBlockBody node={node} source={source} code={code} name={name}>
      {children}
    </CodeBlockBody>
  );
  if (/^mermaid$/i.test(name)) {
    const raw = code?.children?.map((t) => (t.type === 'text' ? (t.value ?? '') : '')).join('') ?? '';
    const end = node?.position?.end?.offset;
    const closed = end !== undefined && /(?:`{3,}|~{3,})[ \t]*$/.test(source.slice(0, end));
    // Drawn once written; until then, and if it cannot be drawn, the code as it is.
    if (closed) return <FlowFigure code={raw.replace(/\n$/, '')} fallback={body} />;
  }
  return body;
}

/**
 * A flowchart in an answer, drawn (flow-draw.ts) and shown as a picture, in the same box as a code block: 流程图
 * and, at the head's right, 代码 (the chart's text; 预览 back) and 复制. A click on the chart shows it full size.
 * While it is being drawn, and if it cannot be, the code block itself.
 */
function FlowFigure({ code, fallback }: { code: string; fallback: ReactNode }) {
  const mode = pageMode();
  const [state, setState] = useState<{ key: string; url: string | null; failed: boolean }>({ key: '', url: null, failed: false });
  const key = `${mode}\u0000${code}`;
  const [asCode, setAsCode] = useState(false);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let alive = true;
    drawFlow(code, mode).then(
      (svg) => alive && setState({ key, url: svgUrl(svg), failed: false }),
      () => alive && setState({ key, url: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [code, mode, key]);
  const url = state.key === key ? state.url : null;
  if (!url) return <>{fallback}</>;
  return (
    <div className="code-block flow-figure">
      <div className="code-head">
        <span className="code-lang">流程图</span>
        <button type="button" className="icon-btn md-tool" aria-pressed={asCode} aria-label={asCode ? '预览' : '代码'} title={asCode ? '预览' : '代码'} onClick={() => setAsCode((v) => !v)}>
          <Icon name={asCode ? 'eye' : 'code'} size={14} />
        </button>
        <CopyButton className="icon-btn md-tool" copy={() => clipboard.write(code)} />
      </div>
      {asCode ? (
        <pre>
          <code>{code}</code>
        </pre>
      ) : (
        <button type="button" className="flow-image" onClick={() => setBig(true)} title="流程图">
          <img src={url} alt="流程图" />
        </button>
      )}
      {big ? <ImageViewer pictures={[{ url, name: '流程图' }]} onClose={() => setBig(false)} /> : null}
    </div>
  );
}

/** What an HTML page is called: its <title>, else its first heading, else HTML. */
export function htmlTitle(html: string): string {
  const pick = (re: RegExp) => re.exec(html)?.[1]?.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return pick(/<title[^>]*>([\s\S]*?)<\/title>/i) || pick(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || 'HTML';
}

/**
 * An HTML code block in an answer is a card, not code: its title and how long it is; a click shows the page in
 * the right panel (in the preview's sandbox: no scripts, nothing from the network), where it can be switched to
 * its code. While it is still being written the card waits; 复制 copies the HTML.
 */
function HtmlCard({ html, closed, open }: { html: string; closed: boolean; open(title: string, html: string): void }) {
  const title = htmlTitle(html);
  const lines = html ? html.split('\n').length : 0;
  return (
    <div className="card file-card html-card">
      <button
        type="button"
        className="file-card-main"
        aria-disabled={closed ? undefined : 'true'}
        title={closed ? '预览' : undefined}
        onClick={() => {
          if (closed) open(title, html);
        }}
      >
        <FileBadge name="page.html" />
        <span className="file-card-text">
          <span className="file-card-name">{title}</span>
          <span className="file-card-sub">HTML · {lines} 行</span>
        </span>
      </button>
      <span className="file-card-tools">
        <CopyButton className="icon-btn md-tool" copy={() => clipboard.write(html)} />
      </span>
    </div>
  );
}

function CodeBlockBody({ node, source, code, name, children }: { node?: PreNode | undefined; source: string; code: NonNullable<PreNode['children']>[number] | undefined; name: string; children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
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

/**
 * Inline code, and a full local path written in plain text (`plain`, see remarkLocalPaths). A full local path
 * opens (a file in the right panel, a folder in Explorer) and shows only its name (pathLabel); the full path is
 * in its hover note, and copying a selection over it copies the full path. Other inline code is code; a path
 * from plain text that nothing here opens stays plain text.
 */
/**
 * Whether a path in an answer shows as its name: only a file whose name has an extension. A folder shows whole
 * (他: 「文件夹不要省略，比如你说的XXX文件都在“A\”里，看着好怪」), and so does a path that may be either (its
 * last part has no extension). Folders are told by how the path is written (a separator at the end), not by
 * asking the disk.
 */
function shortLabel(path: string, kind: 'file' | 'folder'): boolean {
  return kind === 'file' && /\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/.test(path.slice(path.search(/[^\\/]*$/)));
}

function InlineCode({ className, plain, children }: { className?: string | undefined; plain?: boolean; children?: ReactNode }) {
  const inBlock = useContext(InBlockContext);
  const tools = useContext(AnswerToolsContext);
  const paths = useContext(AnswerPathsContext);
  const text = typeof children === 'string' ? children : null;
  const kind = !inBlock && tools && text !== null ? openablePathKind(text, tools.cwd) : null;
  // A path from plain text that does not open here stays plain text.
  if (!kind || !tools || text === null) return plain ? <>{children}</> : <code className={className}>{children}</code>;
  const open = () => (kind === 'folder' ? tools.openFolder(text) : tools.openFile(text));
  // A link role on the code itself (not a button around it), so a long name still wraps with the line.
  return (
    <code
      className="md-path"
      role="link"
      tabIndex={0}
      data-path={text}
      aria-label={text}
      title={`${kind === 'folder' ? '打开文件夹' : '预览'} ${text}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      {shortLabel(text, kind) ? pathLabel(text, paths) : text}
    </code>
  );
}

/** Copying a selection that covers a path's name: the full path goes on the clipboard in its place. */
function copyFullPaths(e: ClipboardEvent<HTMLDivElement>) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (![...e.currentTarget.querySelectorAll('code.md-path[data-path]')].some((el) => range.intersectsNode(el))) return;
  // Laid out off screen, so its text keeps the line breaks the page shows.
  const box = document.createElement('div');
  box.className = 'md';
  box.style.cssText = 'position:fixed;left:-99999px;top:0';
  box.appendChild(range.cloneContents());
  for (const el of box.querySelectorAll<HTMLElement>('code.md-path[data-path]')) el.textContent = el.dataset.path ?? el.textContent;
  document.body.appendChild(box);
  const plain = box.innerText || (box.textContent ?? '');
  const html = box.innerHTML;
  box.remove();
  e.clipboardData.setData('text/plain', plain);
  e.clipboardData.setData('text/html', html);
  e.preventDefault();
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

/**
 * A picture in an answer: a local file, or one on the web (see answer-image.ts); a click shows it full size.
 * One that may not load, or fails to, is its caption in quiet text.
 */
function MdImage({ src, alt }: { src?: string | undefined; alt?: string | undefined }) {
  const tools = useContext(AnswerToolsContext);
  const source = imageSource(src, tools?.cwd);
  const [url, setUrl] = useState<string | null>(source.kind === 'data' || (source.kind === 'web' && tools?.webImages === 'auto') ? source.url : null);
  const [failed, setFailed] = useState(false);
  // Opened full size: with the other pictures of this answer (ImageGroup in Conversation), this one first.
  const [big, setBig] = useState<{ pictures: Picture[]; index: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const caption = alt || '图片';
  const group = useImageGroup(button, url, caption);
  const localPath = source.kind === 'local' ? source.path : '';
  const toUrl = tools?.imageUrl;
  useEffect(() => {
    let alive = true;
    if (localPath && toUrl) void toUrl(localPath).then((u) => alive && setUrl(u), () => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [localPath, toUrl]);
  if (failed || source.kind === 'blocked' || (source.kind === 'web' && !tools?.webImages) || (source.kind === 'local' && !toUrl))
    return <span className="md-image-caption">{caption}</span>;
  if (!url && source.kind === 'web')
    return (
      <button type="button" className="md-image-ask" title={source.url} onClick={() => setUrl(source.url)}>
        <Icon name="eye" size={14} />
        <span>显示图片</span>
        <span className="md-image-host">{source.host}</span>
      </button>
    );
  if (!url) return <span className="md-image-wait" />;
  return (
    <>
      <button type="button" className="md-image" ref={button} onClick={() => setBig(group())} title={caption}>
        <img src={url} alt={caption} onError={() => setFailed(true)} />
      </button>
      {big ? <ImageViewer pictures={big.pictures} start={big.index} onClose={() => setBig(null)} /> : null}
    </>
  );
}

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  // Every path of the answer, filled in as Markdown reads it (before any part of it is drawn).
  const paths = useMemo<string[]>(() => [], []);
  const plugins = useMemo(() => [remarkGfm, remarkLocalPaths(paths)], [paths]);
  return (
    <div className="md" onCopy={copyFullPaths}>
      <AnswerPathsContext.Provider value={paths}>
        <Markdown
          remarkPlugins={plugins}
          // history:n (a place in an earlier conversation) is kept; other addresses as react-markdown allows them.
          // A picture's address is kept as written (local paths too): MdImage decides what may load.
          urlTransform={(url, key, node) => (url.startsWith('history:') || (key === 'src' && node.tagName === 'img') ? url : defaultUrlTransform(url))}
          components={{
            a: ({ href, children }) =>
              href?.startsWith('history:') ? (
                <HistoryLink href={href}>{children}</HistoryLink>
              ) : (
                <a href={href} target="_blank" rel="noreferrer" title={href}>
                  {/^https?:/i.test(href ?? '') ? <Icon name="link" size={12} className="md-link-icon" /> : null}
                  {children}
                </a>
              ),
            pre: ({ node, children }) => (
              <CodeBlock node={node as PreNode | undefined} source={text}>
                {children}
              </CodeBlock>
            ),
            code: ({ node, className, children }) => (
              <InlineCode className={className} plain={Boolean(node?.properties?.dataPlain)}>
                {children}
              </InlineCode>
            ),
            table: ({ children }) => <MdTable>{children}</MdTable>,
            img: ({ src, alt }) => <MdImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
          }}
        >
          {text}
        </Markdown>
      </AnswerPathsContext.Provider>
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

/**
 * The turning mark at the front of the line that says what the run is doing now: 18, as it was when it stood in
 * the status line under the answer (the row keeps its 14px place for it, styles.css .fold-mark).
 */
const LIVE_MARK_SIZE = 18;
const LIVE_MARK = <SpicaMark size={LIVE_MARK_SIZE} state="tool" className="fold-mark" />;

/** `since`: this is what the run is doing right now (the run's start, for the clock at the end). */
export function ThinkingBlock({ text, live, since }: { text: string; live: boolean; since?: number | undefined }) {
  const [open, setOpen] = useState(false);
  const now = live && since !== undefined;
  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen((o) => !o)}
      icon={now ? <SpicaMark size={LIVE_MARK_SIZE} state="think" className="fold-mark" /> : <Icon name="thinking" size={14} />}
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
    case 'repeated':
      return <SpicaStatusIcon name="stopped" size={14} />;
    default:
      return <Icon name="tool" size={14} />;
  }
}

/** The web pages each web_fetch / web_search call used, by call id. */
export const SourceCardsContext = createContext<Record<string, SourceCardMeta> | undefined>(undefined);

/** One web page: its title (the site when it has none), the site, and for a search result its snippet; opens in the browser. */
function SourceLink({ row, className }: { row: SourceRow; className: string }) {
  const host = hostOf(row.url);
  return (
    <a className={className} href={row.url} target="_blank" rel="noreferrer" title={row.url}>
      <span className="source-title">{row.title || host}</span>
      {row.title ? <span className="source-host">{host}</span> : null}
      {row.snippet && className === 'source-row' ? <span className="source-snippet">{row.snippet}</span> : null}
    </a>
  );
}

/** What a web call found, inside its line: one page a row. */
function SourceList({ card }: { card: SourceCardMeta }) {
  if (!card.sources.length) return <p className="tool-empty">—</p>;
  return (
    <div className="source-list">
      {card.sources.map((r) => (
        <SourceLink key={r.url} row={r} className="source-row" />
      ))}
    </div>
  );
}

/** Up to this many sources show under an answer; more fold behind 全部 N 个. */
const SOURCES_SHOWN = 6;

/** Under an answer: the web pages it rests on (see sources.ts), each opening in the browser. */
export function AnswerSources({ sources }: { sources: SourceRow[] }) {
  const [all, setAll] = useState(false);
  if (!sources.length) return null;
  const fold = sources.length > SOURCES_SHOWN + 1;
  const shown = fold && !all ? sources.slice(0, SOURCES_SHOWN) : sources;
  return (
    <section className="answer-sources" aria-label="来源">
      <span className="answer-sources-label">来源</span>
      {shown.map((r) => (
        <SourceLink key={r.url} row={r} className="source-chip" />
      ))}
      {fold ? (
        <button type="button" className="btn file-cards-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? '收起' : `全部 ${sources.length} 个`}
        </button>
      ) : null}
    </section>
  );
}

/** Each call's file card (write_file's says Created or Edited and the lines), by call id. */
export const ToolCardsContext = createContext<Record<string, FileCardMeta> | undefined>(undefined);

/** What a call's own line says after its words: how it ended (Failed, stopped), or how long it took. */
function toolMeta(block: ToolBlock, done = false): ReactNode {
  if (block.state === 'pending') return <SpicaStatusIcon name="running" size={14} title="进行中" />;
  if (block.state === 'error') return <span className="text-danger">Failed</span>;
  if (block.state === 'unavailable') return '已停用，未执行';
  if (block.state === 'repeated') return '重复，未执行';
  if (block.state === 'timeout') return '已超时';
  if (block.state === 'running') return null;
  if (block.durationMs !== undefined && !done) return block.autoApproved ? `Auto · ${formatDuration(block.durationMs)}` : formatDuration(block.durationMs);
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
  const sources = useContext(SourceCardsContext)?.[block.callId];
  if (history && HISTORY_TOOLS.has(block.name)) return <HistoryTable card={history} />;
  if (sources) return <SourceList card={sources} />;
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

/**
 * A command as written: $ and the command, coloured as PowerShell, in a box that scrolls on its own. `marks`
 * (where the dangerous words are): those words on a red ground in place of the colours. `bare`: no box and no
 * head of its own (the card it is in is the box and has the copy button).
 */
function CommandBox({ command, marks, bare }: { command: string; marks?: [number, number][] | undefined; bare?: boolean }) {
  const red = marks && marks.length ? marks : null;
  const coloured = useMemo(() => (red ? null : highlightCode('powershell', command)), [command, red]);
  let body: ReactNode = coloured ?? command;
  if (red) {
    const parts: ReactNode[] = [];
    let at = 0;
    red.forEach(([a, b], i) => {
      if (a < at) return;
      parts.push(command.slice(at, a), <mark key={i} className="cmd-danger">{command.slice(a, b)}</mark>);
      at = b;
    });
    parts.push(command.slice(at));
    body = parts;
  }
  return (
    <div className={bare ? 'tool-command is-bare' : 'tool-command'}>
      {bare ? null : (
        <div className="code-head">
          <span className="code-lang" />
          <CopyButton className="icon-btn md-tool" copy={() => clipboard.write(command)} />
        </div>
      )}
      <pre>
        <code>
          <span className="tool-prompt">$ </span>
          {body}
        </code>
      </pre>
    </div>
  );
}

/** One call in a group's list: its state first, its words, how it ended; a click opens the command and its output. */
function ToolItem({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const meta = toolMeta(block, useContext(RoundDoneContext));
  return (
    <div className={open ? 'tool-item is-open' : 'tool-item'}>
      <button type="button" className="tool-item-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="fold-icon">{toolIcon(block)}</span>
        {block.state === 'running' || block.state === 'pending' ? <span className="tool-text">{runningWords(block)}</span> : <ToolText block={block} />}
        {meta ? <span className="fold-meta">{meta}</span> : null}
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

/** A stretch of thinking among a group's calls: a line of its own in the list, opening to the thoughts. */
function ThinkingItem({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? 'tool-item is-open' : 'tool-item'}>
      <button type="button" className="tool-item-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="fold-icon">
          <Icon name="thinking" size={14} />
        </span>
        <span className="tool-text">
          <span className="tool-verb">思考过程</span>
        </span>
        <Icon name="chevronRight" size={14} className="fold-chevron" />
      </button>
      {open ? (
        <div className="tool-item-body">
          <p className="thinking-text">{text}</p>
        </div>
      ) : null}
    </div>
  );
}

/** A step in a group: a call, or the thinking the model did between calls. */
export type GroupStep = ToolBlock | { type: 'thinking'; text: string };

/** `since`: a call on its own that is what the run is doing now: said as Running … with the run's clock at the end. */
function ToolRow({ block, since }: { block: ToolBlock; since?: number | undefined }) {
  const [open, setOpen] = useState(false);
  const done = useContext(RoundDoneContext);
  const now = since !== undefined && block.state === 'running';
  return (
    <Disclosure
      open={open}
      onToggle={() => setOpen((o) => !o)}
      icon={now ? LIVE_MARK : toolIcon(block)}
      label={now || block.state === 'running' || block.state === 'pending' ? runningWords(block) : <ToolText block={block} />}
      meta={toolMeta(block, done)}
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
 * lists them one per line; a call opens to its command and output. A single call is its own line. `steps`: the
 * calls with the thinking between them, in order (the line counts the calls only; open, the thinking has lines of
 * its own among them); a single call with thinking is a group too. `since`: these
 * are what the run is doing now: while some run, the line says so (the turning mark first, Running and the
 * step, the run's clock at the end) in place of the status line under the answer.
 */
export function ToolGroup({ blocks, steps = blocks, since }: { blocks: ToolBlock[]; steps?: GroupStep[]; since?: number | undefined }) {
  const [open, setOpen] = useState(false);
  const cards = useContext(ToolCardsContext);
  const done = useContext(RoundDoneContext);
  if (blocks.length === 1 && blocks[0] && steps.length === 1) return <ToolRow block={blocks[0]} since={since} />;
  const running = blocks.filter((b) => b.state === 'running');
  const busy = running.length > 0 || blocks.some((b) => b.state === 'pending');
  const now = since !== undefined && running.length > 0;
  const failed = blocks.filter((b) => b.state === 'error').length;
  const total = blocks.reduce((n, b) => n + (b.durationMs ?? 0), 0);
  const label = now ? runningText(running) : busy ? runningWords(running[0] ?? blocks.find((b) => b.state === 'pending')!) : groupWords(blocks.map((b) => ({ call: b, card: cards?.[b.callId] })));
  const meta = busy ? (now ? null : <SpicaStatusIcon name="running" size={14} title="进行中" />) : failed ? <span className="text-danger">{failed} failed</span> : total && !done ? formatDuration(total) : null;
  return (
    <Disclosure open={open} onToggle={() => setOpen((o) => !o)} icon={now ? LIVE_MARK : <Icon name="tool" size={14} />} label={label} meta={meta} tail={now ? <RunClock since={since} /> : undefined}>
      <div className="tool-list">
        {steps.map((b, i) => (b.type === 'thinking' ? <ThinkingItem key={`thinking-${i}`} text={b.text} /> : <ToolItem key={b.callId} block={b} />))}
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
  /** A URL that shows a local picture: a picture file's card shows it small in place of its type badge. */
  imageUrl?: ((path: string) => Promise<string>) | undefined;
}

/** Picture files a card shows as a small picture (only ever in an img: an SVG's scripts never run). */
const PICTURE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** A picture file's own picture, small, where the card's type badge would be; the badge when it cannot be shown. */
function CardPicture({ path, name, url }: { path: string; name: string; url: (path: string) => Promise<string> }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void url(path).then((u) => alive && setSrc(u), () => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [path, url]);
  if (failed || !src) return <FileBadge name={name} />;
  return <img className="file-card-picture" src={src} alt="" onError={() => setFailed(true)} />;
}

/**
 * Up to this many files show as cards; more show as a list, one a line (他: 「我怕下载10份20份全部都做成卡片堆满屏幕。
 * 那种情况其实是用列表或者表格+超链接最合适」). A plugin's tool may be called any number of times in a round.
 */
export const FILE_CARDS_MAX = 4;
/** A list longer than this shows its first FILE_LIST_SHOWN lines, the rest behind 全部 N 个. */
export const FILE_LIST_FOLD = 10;
export const FILE_LIST_SHOWN = 8;

/** What the round did with a file (Created +8 −1), else what was read of it (Read pages 1-3), else the call's verb. */
function FileDid({ f, className }: { f: FileRef; className: string }) {
  const verb = fileCardVerb(f);
  if (verb)
    return (
      <span className={className}>
        {verb}
        {f.lines?.added ? <span className="file-lines-added"> +{f.lines.added}</span> : null}
        {f.lines?.removed ? <span className="file-lines-removed"> −{f.lines.removed}</span> : null}
      </span>
    );
  const read = f.card ? fileCardParts(f.card).read : '';
  return <span className={className}>{read || (f.tool === 'read_file' ? 'Read' : f.tool === 'write_file' ? 'Wrote' : 'Edited')}</span>;
}

/** 打开所在文件夹 and 复制路径, as on a card. */
function FileTools({ full, actions }: { full: string; actions: FileCardActions }) {
  return (
    <span className="file-card-tools">
      <button type="button" className="icon-btn md-tool" aria-label="打开所在文件夹" title="打开所在文件夹" onClick={() => actions.reveal(full)}>
        <Icon name="folder" size={14} />
      </button>
      <CopyButton className="icon-btn md-tool" label="复制路径" copy={() => clipboard.write(full)} />
    </span>
  );
}

/**
 * Many files: a list in columns, no lines or heads: the type's icon and the name (opens it, as a card does),
 * what it is (Excel · 3 个表), what the round did with it, and 打开所在文件夹 / 复制路径. A narrow answer drops
 * what it is first, then what was done. Pictures show their icon only.
 */
function FileList({ files, onOpen, actions }: { files: FileRef[]; onOpen(path: string): void; actions?: FileCardActions | undefined }) {
  const [all, setAll] = useState(false);
  const fold = files.length > FILE_LIST_FOLD;
  const shownFiles = fold && !all ? files.slice(0, FILE_LIST_SHOWN) : files;
  return (
    <>
      <ul className="file-list" aria-label={`${files.length} 个文件`}>
        {shownFiles.map((f) => {
          const shown = f.shown ?? f.path;
          const name = f.card?.name ?? fileName(shown);
          const full = fullPath(f.path, actions?.cwd);
          return (
            <li key={f.path} className="file-row">
              <button type="button" className="file-row-main" onClick={() => onOpen(f.path)} title={`打开 ${full}`}>
                <span className="file-row-name">
                  <FileGlyph name={name} />
                  <span className="file-row-text">{name}</span>
                </span>
                <span className="file-row-kind">{f.card ? fileCardParts(f.card).kind : fileFolder(shown)}</span>
                <FileDid f={f} className="file-row-did" />
              </button>
              {actions ? <FileTools full={full} actions={actions} /> : <span />}
            </li>
          );
        })}
      </ul>
      {fold ? (
        <button type="button" className="btn file-cards-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? '收起' : `全部 ${files.length} 个`}
        </button>
      ) : null}
    </>
  );
}

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
  return <span className="file-card-sub">{f.card ? fileCardLine(f.card) : `${f.tool === 'read_file' ? 'Read' : f.tool === 'write_file' ? 'Wrote' : 'Edited'}${fileFolder(shown) ? ` · ${fileFolder(shown)}` : ''}`}</span>;
}

export function FileCards({ files, onOpen, actions }: { files: FileRef[]; onOpen(path: string): void; actions?: FileCardActions | undefined }) {
  if (files.length === 0) return null;
  if (files.length > FILE_CARDS_MAX) return <FileList files={files} onOpen={onOpen} actions={actions} />;
  return (
    <div className="file-cards">
      {files.map((f) => {
        const shown = f.shown ?? f.path;
        const full = fullPath(f.path, actions?.cwd);
        return (
          <div key={f.path} className="card file-card">
            <button type="button" className="file-card-main" onClick={() => onOpen(f.path)} title={`打开 ${full}`}>
              {actions?.imageUrl && PICTURE.test(f.card?.name ?? shown) ? (
                <CardPicture path={full} name={f.card?.name ?? fileName(shown)} url={actions.imageUrl} />
              ) : (
                <FileBadge name={f.card?.name ?? fileName(shown)} />
              )}
              <span className="file-card-text">
                <span className="file-card-name">{f.card?.name ?? fileName(shown)}</span>
                <FileCardSub f={f} />
              </span>
            </button>
            {actions ? <FileTools full={full} actions={actions} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A question card. Answered, it shows the answer; dropped unanswered (the run was stopped), 已中断 in the same
 * place. Once an answer is sent it takes no second one (a second would be refused: the question is gone).
 */
export function AskCard({ block, onAnswer }: { block: Extract<Block, { type: 'ask' }>; onAnswer(answer: string): void }) {
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState(false);
  const answered = block.answer !== undefined;
  const closed = answered || block.cancelled === true;
  const submit = (value: string) => {
    const v = value.trim();
    if (!v || sent) return;
    setSent(true);
    onAnswer(v);
  };
  return (
    <section className={closed ? 'card ask-card is-done' : 'card ask-card'} aria-label="提问">
      {/* One row as on a confirmation card: the question (no mark before it: 他问「为什么要有问号」, it says
          nothing the question and its options do not), and once closed the answer (or 已中断) at its right end;
          the options and the box below, in a part of their own. */}
      <header className="card-head">
        <span className="card-title">{block.question}</span>
        <span className="confirm-spacer" />
        {closed ? (
          <p className={answered ? 'card-answer' : 'card-answer is-stopped'}>
            <SpicaStatusIcon name={answered ? 'done' : 'stopped'} size={15} />
            <span>{answered ? block.answer : CARD_STOPPED}</span>
          </p>
        ) : null}
      </header>
      {closed ? null : (
        <div className="ask-body">
          {block.options.length ? (
            <div className="ask-options">
              {block.options.map((o) => (
                <button key={o} type="button" className="btn ask-option" disabled={sent} onClick={() => submit(o)}>
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
              disabled={sent}
            />
            <button type="submit" className="btn btn-primary" disabled={sent || !draft.trim()}>
              回答
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

/** What a question or confirmation says when the run was stopped while it waited; red, as the answer's own
 * （中断） is. The user's own 已拒绝 stays grey. */
const CARD_STOPPED = '已中断';

/** Names for the arguments people see when asked to confirm (what is not here shows by its own name). */
const ARG_LABEL: Record<string, string> = {
  path: '路径',
  url: '网址',
  to: '收件人',
  cc: '抄送',
  bcc: '密送',
  subject: '标题',
  body: '正文',
  content: '内容',
  text: '内容',
  query: '搜索词',
  title: '标题',
  task: '任务',
};

/**
 * Exactly what a confirmation would let run, nothing cut: a command in its code box, other calls their
 * arguments in full. Not the model's description of the step: it may not match what would run.
 */
export function ConfirmTarget({ name, input, bare }: { name: string; input: unknown; bare?: boolean }) {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (name === 'run_command' && typeof v.command === 'string') return <CommandBox command={v.command} marks={dangerSpans(v.command)} bare={bare} />;
  const rows = Object.entries(v).filter(([k, val]) => k !== 'description' && val !== undefined && val !== null && val !== '');
  if (!rows.length) return null;
  return (
    <dl className="confirm-args">
      {rows.map(([k, val]) => (
        <Fragment key={k}>
          <dt>{ARG_LABEL[k] ?? k}</dt>
          <dd>{typeof val === 'string' ? val : JSON.stringify(val, null, 2)}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * A confirmation: the card is what would run. One slim row (what it will do, 无法撤销 when it cannot be taken
 * back, copy for a command, 拒绝 / 允许 or what was decided), then the command in full or the call's arguments.
 * For a command, the title is the app's own reading of it (运行命令 when it cannot tell), not the model's words.
 */
export function ConfirmCard({ block, onDecide }: { block: Extract<Block, { type: 'confirm' }>; onDecide(approved: boolean): void }) {
  const [sent, setSent] = useState(false);
  const decided = block.approved !== undefined || block.cancelled === true;
  const decide = (approved: boolean) => {
    if (sent) return;
    setSent(true);
    onDecide(approved);
  };
  const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
  const command = block.name === 'run_command' && typeof input.command === 'string' ? input.command : null;
  const facts = command !== null ? commandFacts(command) : [];
  // 无法撤销 and the warning: a dangerous command, or a step a plugin marked irreversible (its hook, or its manifest).
  const danger = facts.some((f) => f.danger) || block.irreversible === true;
  const title = command === null ? confirmTitle(block.name, block.input, block.reason) : facts.length ? facts.map((f) => f.text).join('；') : '运行命令';
  const cls = ['card', 'confirm-card', danger ? 'is-danger' : '', decided ? 'is-done' : ''].filter(Boolean).join(' ');
  return (
    <section className={cls} aria-label="确认">
      <header className="card-head">
        {/* Only a dangerous one has a mark (the warning); an ordinary one's ringed i said nothing its 拒绝 / 允许
            do not (他在决策页 d26 选「只去掉普通确认卡的 i」). */}
        {danger ? <SpicaStatusIcon name="warning" size={16} /> : null}
        <span className="card-title">{title}</span>
        {danger ? <span className="confirm-undo">无法撤销</span> : null}
        <span className="confirm-spacer" />
        {command !== null ? <CopyButton className="icon-btn md-tool" copy={() => clipboard.write(command)} /> : null}
        {decided ? (
          <p className={block.cancelled === true && block.approved === undefined ? 'card-answer is-stopped' : 'card-answer'}>
            <SpicaStatusIcon name={block.approved ? 'done' : 'stopped'} size={15} />
            <span>{block.approved ? '已允许' : block.approved === false ? '已拒绝' : CARD_STOPPED}</span>
          </p>
        ) : (
          <div className="card-actions">
            <button type="button" className="btn" disabled={sent} onClick={() => decide(false)}>
              拒绝
            </button>
            <button type="button" className="btn btn-primary" disabled={sent} onClick={() => decide(true)}>
              允许
            </button>
          </div>
        )}
      </header>
      <ConfirmTarget name={block.name} input={block.input} bare />
      {block.cause && GUARD_CAUSE_TEXT[block.cause] ? <p className="card-why">{GUARD_CAUSE_TEXT[block.cause]}</p> : null}
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
