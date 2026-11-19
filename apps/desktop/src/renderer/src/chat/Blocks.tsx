// Inline blocks of an answer: text, collapsible thinking and tool rows, and
// the three cards (file, question, suggestion) plus the confirmation card.
import { createContext, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import { askAnswerLines, type ChangePreview, type InstallPreview, type FileCardMeta, type HistoryCardMeta, type SourceCardMeta, type SourceRow } from '@spica/protocol';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fileCardLine, fileCardParts, fileCardVerb, NO_REPORT_WORDS, type Block, type ChildNote, type FileRef } from '../store/transcript';
import { N_, t } from '../../../shared/i18n';
import { useLocale } from '../i18n';
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
import { confirmTitle, fileFolder, fileName, formatBytes, formatClock, formatDuration, GUARD_CAUSE_TEXT, HISTORY_TOOLS } from './format';
import { groupWords, runningGroup, runningWords, toolWords } from './tool-words';
import { hostOf } from './sources';
import { AllowSplit } from './AllowSplit';
import { CallArgs, CallDetail, callChange, CommandBox, FileChange } from './CallDetail';

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

const HISTORY_COLUMN: Record<HistoryCardMeta['tool'], string> = { search_history: N_('匹配内容'), read_history: N_('内容'), find_history_files: N_('文件') };

/** What a history tool found, as a two-column table: the conversation, and the matching text (or the file).
 *  A row opens that conversation at the message. The text given to the model is not shown. */
function HistoryTable({ card }: { card: HistoryCardMeta }) {
  const open = useContext(OpenSessionContext);
  if (!card.rows.length) return <p className="tool-empty">{t('没有找到')}</p>;
  return (
    <div className="history-table">
      <div className="history-head" aria-hidden>
        <span>{t('对话')}</span>
        <span>{t(HISTORY_COLUMN[card.tool])}</span>
      </div>
      {card.rows.map((r) => {
        const name = r.name ?? t('未命名对话');
        const project = r.projectName && r.projectName !== name ? r.projectName : '';
        const right = card.tool === 'find_history_files' ? (r.path ?? r.text) : r.text;
        return (
          <button key={`${r.ref}|${r.sessionId}|${r.seq ?? 0}`} type="button" className="history-row" onClick={() => open?.(r.sessionId, r.seq)} aria-label={t('打开「{name}」', { name })}>
            <span className="history-name">
              {name}
              {project ? <span className="history-project">{project}</span> : null}
            </span>
            <span className="history-text">{right}</span>
          </button>
        );
      })}
      {card.total > card.rows.length ? <p className="history-more">{t('共 {total} 条，显示最近 {n} 条', { total: card.total, n: card.rows.length })}</p> : null}
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
    <button type="button" className="text-btn history-link" title={t('打开对话')} onClick={() => open(to.sessionId, to.seq)}>
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
    const closed = end !== undefined && /(?:\x60{3,}|~{3,})[ \t]*$/.test(source.slice(0, end));
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
    const closed = end !== undefined && /(?:\x60{3,}|~{3,})[ \t]*$/.test(source.slice(0, end));
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
        <span className="code-lang">{t('流程图')}</span>
        <button type="button" className="icon-btn md-tool" aria-label={asCode ? t('查看预览') : t('查看代码')} title={asCode ? t('查看预览') : t('查看代码')} onClick={() => setAsCode((v) => !v)}>
          <Icon name={asCode ? 'eye' : 'code'} size={14} />
        </button>
        <CopyButton className="icon-btn md-tool" copy={() => clipboard.write(code)} />
      </div>
      {asCode ? (
        <pre>
          <code>{code}</code>
        </pre>
      ) : (
        <button type="button" className="flow-image zoomable" onClick={() => setBig(true)} title={t('流程图')}>
          <img src={url} alt={t('流程图')} />
        </button>
      )}
      {big ? <ImageViewer pictures={[{ url, name: t('流程图') }]} onClose={() => setBig(false)} /> : null}
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
        title={closed ? t('预览') : undefined}
        onClick={() => {
          if (closed) open(title, html);
        }}
      >
        <FileBadge name="page.html" />
        <span className="file-card-text">
          <span className="file-card-name">{title}</span>
          <span className="file-card-sub">{t('HTML · {n} 行', { n: lines })}</span>
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
  const closed = end !== undefined && /(?:\x60{3,}|~{3,})[ \t]*$/.test(source.slice(0, end));
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
      title={kind === 'folder' ? t('打开文件夹 {path}', { path: text }) : t('预览 {path}', { path: text })}
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
  const shown = done ? t('已导出') : t('导出 CSV');
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
  const caption = alt || t('图片');
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
        <span>{t('显示图片')}</span>
        <span className="md-image-host">{source.host}</span>
      </button>
    );
  if (!url) return <span className="md-image-wait" />;
  return (
    <>
      <button type="button" className="md-image zoomable" ref={button} onClick={() => setBig(group())} title={caption}>
        <img src={url} alt={caption} onError={() => setFailed(true)} />
      </button>
      {big ? <ImageViewer pictures={big.pictures} start={big.index} onClose={() => setBig(null)} /> : null}
    </>
  );
}

type BreakNode = { type: string; value?: string; children?: BreakNode[] };

/**
 * Every single line break inside a paragraph (or a list item's text) drawn as a line break, not a space (code keeps its
 * own: its text is not a text node). For a question card: the model writes a line per thing it needs, often without
 * a Markdown list.
 */
export function remarkLineBreaks() {
  const walk = (node: BreakNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((c): BreakNode[] => {
      if (c.type !== 'text' || !c.value?.includes('\n')) {
        walk(c);
        return [c];
      }
      return c.value.split(/\r?\n/).flatMap((line, i): BreakNode[] => [...(i ? [{ type: 'break' }] : []), ...(line ? [{ type: 'text', value: line }] : [])]);
    });
  };
  return (tree: BreakNode) => walk(tree);
}

export const MarkdownText = memo(function MarkdownText({ text, lineBreaks = false }: { text: string; /** single line breaks as lines (remarkLineBreaks) */ lineBreaks?: boolean }) {
  // Kept in a memo: redrawn when the language changes too (the words of its cards and buttons).
  useLocale();
  // Every path of the answer, filled in as Markdown reads it (before any part of it is drawn).
  const paths = useMemo<string[]>(() => [], []);
  const plugins = useMemo(() => [remarkGfm, ...(lineBreaks ? [remarkLineBreaks] : []), remarkLocalPaths(paths)], [paths, lineBreaks]);
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
      label={live ? t('正在思考') : t('思考过程')}
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
      return <SpicaStatusIcon name="running" size={14} title={t('进行中')} />;
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
    <section className="answer-sources" aria-label={t('来源')}>
      <span className="answer-sources-label">{t('来源')}</span>
      {shown.map((r) => (
        <SourceLink key={r.url} row={r} className="source-chip" />
      ))}
      {fold ? (
        <button type="button" className="btn file-cards-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? t('收起') : t('全部 {n} 个', { n: sources.length })}
        </button>
      ) : null}
    </section>
  );
}

/** Each call's file card (write_file's says Created or Edited and the lines), by call id. */
export const ToolCardsContext = createContext<Record<string, FileCardMeta> | undefined>(undefined);

/** What a call's own line says after its words: how it ended (Failed, stopped), or how long it took. */
function toolMeta(block: ToolBlock, done = false): ReactNode {
  if (block.state === 'pending') return <SpicaStatusIcon name="running" size={14} title={t('进行中')} />;
  if (block.state === 'error') return <span className="text-danger">Failed</span>;
  if (block.state === 'unavailable') return t('已停用，未执行');
  if (block.state === 'repeated') return t('重复，未执行');
  if (block.state === 'timeout') return t('已超时');
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
      {w.file ? (
        <span className="tool-object">
          {w.file.name}
          {w.file.added ? <span className="file-lines-added"> +{w.file.added}</span> : null}
          {w.file.removed ? <span className="file-lines-removed"> −{w.file.removed}</span> : null}
        </span>
      ) : (
        <span className="tool-object">{w.object}</span>
      )}
    </span>
  );
}

const toolArg = (b: ToolBlock, key: string): string => {
  const v = (b.input as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' ? v : '';
};

/**
 * The innermost level: the history tools their table, web calls their pages; every other call what it did, how it
 * ended when it failed and what came out (chat/CallDetail.tsx).
 */
function ToolDetail({ block }: { block: ToolBlock }) {
  const history = useContext(HistoryCardsContext)?.[block.callId];
  const sources = useContext(SourceCardsContext)?.[block.callId];
  const card = useContext(ToolCardsContext)?.[block.callId];
  if (history && HISTORY_TOOLS.has(block.name)) return <HistoryTable card={history} />;
  if (sources) return <SourceList card={sources} />;
  return <CallDetail block={block} card={card} />;
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
          <span className="tool-verb">{t('思考过程')}</span>
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
  const meta = busy ? (now ? null : <SpicaStatusIcon name="running" size={14} title={t('进行中')} />) : failed ? <span className="text-danger">{failed} failed</span> : total && !done ? formatDuration(total) : null;
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
      <button type="button" className="icon-btn md-tool" aria-label={t('打开所在文件夹')} title={t('打开所在文件夹')} onClick={() => actions.reveal(full)}>
        <Icon name="folder" size={14} />
      </button>
      <CopyButton className="icon-btn md-tool" label={t('复制路径')} copy={() => clipboard.write(full)} />
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
      <ul className="file-list" aria-label={t('{n} 个文件', { n: files.length })}>
        {shownFiles.map((f) => {
          const shown = f.shown ?? f.path;
          const name = f.card?.name ?? fileName(shown);
          const full = fullPath(f.path, actions?.cwd);
          return (
            <li key={f.path} className="file-row">
              <button type="button" className="file-row-main" onClick={() => onOpen(f.path)} title={t('打开 {path}', { path: full })}>
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
          {all ? t('收起') : t('全部 {n} 个', { n: files.length })}
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
            <button type="button" className="file-card-main" onClick={() => onOpen(f.path)} title={t('打开 {path}', { path: full })}>
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

/** A question's first line, when the rest is under it: what it asks, in the title's weight; the rest (the things to
 * fill in, one a line) in the body's. A first line that is already a list item belongs to the rest. */
export function askQuestionParts(question: string): { head: string; rest: string } {
  const q = question.trim();
  const nl = q.indexOf('\n');
  const first = nl < 0 ? q : q.slice(0, nl);
  // a half-width marker wants a space after it (**bold**, 1.5 are no list items); a full-width one does not
  if (/^\s*([-*+]\s|\d+[.)]\s|\d+[）、])/.test(first) && nl >= 0) return { head: '', rest: q };
  return { head: first, rest: nl < 0 ? '' : q.slice(nl + 1).replace(/^\n+/, '') };
}

/**
 * A question card. Waiting (it stands above the message box, Conversation; its question and options scroll there
 * when they are long): the question (its first line in the title's weight, the rest under it), the options
 * one a row (a round mark for one, a square for several, the number, the words, 建议 after the suggested one), last
 * a row of its own to type in, and 确定: nothing is sent until it is pressed, one option chosen or several. Answered,
 * in the conversation: a done mark before the question's first line, the answer under it; dropped unanswered (the
 * run was stopped), a stopped mark and 已中断. Once an answer is sent it takes no second one (a second would be refused: the question is gone).
 */
export function AskCard({
  block,
  onAnswer,
  place,
}: {
  block: Extract<Block, { type: 'ask' }>;
  onAnswer(answer: string): void;
  /** which of the questions waiting this is, of how many (shown only when more than one wait) */
  place?: readonly [number, number];
}) {
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState(false);
  // What is chosen, by place; the row to type in is the place after the last option (OTHER).
  const [chosen, setChosen] = useState<readonly number[]>([]);
  const name = useId();
  const box = useRef<HTMLInputElement>(null);
  const options = block.options;
  const OTHER = options.length;
  const multi = block.multiSelect === true && options.length > 0;
  const answered = block.answer !== undefined;
  const closed = answered || block.cancelled === true;
  const { head, rest } = askQuestionParts(block.question);
  const on = (i: number) => chosen.includes(i);
  const choose = (i: number) => setChosen((was) => (!multi ? [i] : was.includes(i) ? was.filter((x) => x !== i) : [...was, i].sort((a, b) => a - b)));
  const type = (v: string) => {
    setDraft(v);
    // words in the box choose its row (one: instead of an option); emptied, it is off again
    const has = v.trim() !== '';
    setChosen((was) => (has ? (was.includes(OTHER) ? was : multi ? [...was, OTHER] : [OTHER]) : was.filter((x) => x !== OTHER)));
  };
  const answer = askAnswerLines(chosen.map((i) => (i === OTHER ? draft : (options[i] ?? ''))));
  const canSend = !sent && answer.trim() !== '';
  const submit = () => {
    if (!canSend) return;
    setSent(true);
    onAnswer(answer.trim());
  };
  // A several-option answer comes back one a line: shown on one line, 、 between.
  const shownAnswer = multi ? (block.answer ?? '').split('\n').filter(Boolean).join(t('、')) : block.answer;
  if (closed) {
    // a first line ending in a colon (请补充：) leads into what is under it; on its own, before the answer, without it
    const line = (head || rest.split('\n')[0] || '').replace(/\*\*|`/g, '').replace(/\s*[:：]\s*$/, '');
    // The mark before the question's line (on that line, not centred on the card); the answer under the question,
    // lined up with its words: a long answer wraps to a second line instead of squeezing the question.
    return (
      <section className={answered ? 'card ask-card is-done' : 'card ask-card is-done is-stopped'} aria-label={t('提问')}>
        <span className="ask-done-mark">
          <SpicaStatusIcon name={answered ? 'done' : 'stopped'} size={15} />
        </span>
        <div className="ask-done-text">
          <p className="ask-done-title" title={block.question}>
            {line}
          </p>
          <p className="ask-done-answer" title={answered ? shownAnswer : undefined}>
            {answered ? shownAnswer : t(CARD_STOPPED)}
          </p>
        </div>
      </section>
    );
  }
  const mark = multi ? 'checkbox' : 'radio';
  return (
    <section className="card ask-card is-open" aria-label={t('提问')}>
      <div className="ask-scroll">
        <div className="ask-question">
          {head || place ? (
            <div className="ask-head">
              {place ? <span className="ask-place">{`${place[0]} / ${place[1]}`}</span> : null}
              {head ? <MarkdownText text={head} /> : null}
            </div>
          ) : null}
          {rest ? (
            <div className="ask-rest">
              <MarkdownText text={rest} lineBreaks />
            </div>
          ) : null}
        </div>
        {options.length ? (
          <ol
            className="ask-options"
            role={multi ? 'group' : 'radiogroup'}
            aria-label={head || t('提问')}
            onKeyDown={(e) => {
              // Enter on a mark sends what is chosen, as it does in the box
              if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement) || (e.target.type !== 'radio' && e.target.type !== 'checkbox')) return;
              e.preventDefault();
              submit();
            }}
          >
            {options.map((o, i) => (
              <li key={i}>
                <label className={on(i) ? 'ask-row is-on' : 'ask-row'}>
                  <input type={mark} name={name} checked={on(i)} disabled={sent} onChange={() => choose(i)} />
                  <span className="ask-option-n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="ask-option-text">
                    {o}
                    {o === block.recommended ? <span className="ask-option-tag">{t('建议')}</span> : null}
                  </span>
                </label>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="ask-row ask-other">
          {options.length ? (
            <>
              <input
                type={mark}
                name={name}
                aria-label={t('其他')}
                checked={on(OTHER)}
                disabled={sent}
                onChange={() => {
                  // an empty box: its row is chosen once there are words in it; until then the box takes them
                  if (draft.trim()) choose(OTHER);
                  box.current?.focus();
                }}
              />
              <span className="ask-option-n" aria-hidden="true">
                {OTHER + 1}
              </span>
            </>
          ) : null}
          <input
            ref={box}
            className="input ask-other-input"
            value={draft}
            placeholder={options.length ? t('其他') : t('输入回答')}
            onChange={(e) => type(e.target.value)}
            aria-label={t('输入回答')}
            disabled={sent}
          />
        </div>
        {/* 确定 on a row of its own at the card's right end: what is chosen is sent by it, not by the box */}
        <div className="ask-foot">
          <button type="submit" className="btn btn-primary" disabled={!canSend}>
            {t('确定')}
          </button>
        </div>
      </form>
    </section>
  );
}

/** What a question or confirmation says when the run was stopped while it waited; red, as the answer's own
 * （中断） is. The user's own 已拒绝 stays grey. */
const CARD_STOPPED = N_('已中断');

/** Names for the arguments people see when asked to confirm (what is not here shows by its own name). */
const ARG_LABEL: Record<string, string> = {
  path: N_('路径'),
  url: N_('网址'),
  to: N_('收件人'),
  cc: N_('抄送'),
  bcc: N_('密送'),
  subject: N_('标题|mail'),
  body: N_('正文'),
  content: N_('内容'),
  text: N_('内容'),
  query: N_('搜索词'),
  title: N_('标题'),
  task: N_('任务'),
};

/** ARG_LABEL in the current language. */
const argLabels = (): Record<string, string> => Object.fromEntries(Object.entries(ARG_LABEL).map(([k, v]) => [k, t(v)]));

/**
 * Exactly what a confirmation would let run, nothing cut: a command in its code box, other calls their
 * arguments in full, laid out as a call opened in the conversation (CallArgs: long text and lists under their
 * name, JSON coloured, 20 lines then it scrolls) under names people read. Not the model's description of the step:
 * it may not match what would run.
 */
export function ConfirmTarget({ name, input, bare, change, outsideFolder }: { name: string; input: unknown; bare?: boolean; change?: ChangePreview | undefined; outsideFolder?: string | undefined }) {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (name === 'run_command' && typeof v.command === 'string') {
    // a command writing outside the conversation's folders: where, marked in the command; or the folder it runs in
    const outside = outsideFolder ? outsideSpans(v.command, outsideFolder) : [];
    const marks = [...dangerSpans(v.command), ...outside].sort((a, b) => a[0] - b[0]);
    const runsIn = outsideFolder && !outside.length && typeof v.cwd === 'string' && v.cwd ? v.cwd : null;
    return (
      <>
        <CommandBox command={v.command} marks={marks} bare={bare} />
        {runsIn ? (
          <p className="card-why">
            {t('{label}：{path}', { label: t('起始文件夹'), path: runsIn })}
          </p>
        ) : null}
      </>
    );
  }
  // The built-in browser: the title already says which site and what (the button's words, the box and what goes in);
  // the element's number is the agent's, nothing a person reads.
  if (name === 'browser_click' || name === 'browser_type' || name === 'browser_press' || name === 'browser_select' || name === 'browser_hover' || name === 'browser_drag') return null;
  // a script in the page: the script itself, as a command is shown; an upload: the files, in full
  if (name === 'browser_javascript' && typeof v.code === 'string') return <CommandBox command={v.code} bare={bare} code={{ label: 'JavaScript', language: 'javascript' }} />;
  if (name === 'browser_file_upload' && Array.isArray(v.paths)) return <CommandBox command={v.paths.map(String).join('\n')} bare={bare} code={{ label: '' }} />;
  // A write or an edit: what it would change, as its row shows it after (the core worked it out when it asked: the
  // lines numbered, green in, red out; a new file all green). Without that (an older core) the arguments' own lines.
  if (name === 'write_file' || name === 'edit_file') {
    const card = change ? { path: change.path, origin: change.created ? ('created' as const) : ('modified' as const), ...(change.change ? { change: change.change } : {}) } : undefined;
    const lines = callChange({ type: 'tool', callId: '', name, input, state: 'pending' }, card);
    if (lines) return <FileChange {...lines} />;
  }
  const rows = Object.entries(v).filter(([k, val]) => k !== 'description' && val !== undefined && val !== null && val !== '');
  if (!rows.length) return null;
  return <CallArgs input={Object.fromEntries(rows)} labels={argLabels()} bare={bare} />;
}

/** Where a command names the folder (or something in it), in any case: up to the end of that path. */
function outsideSpans(command: string, folder: string): [number, number][] {
  const out: [number, number][] = [];
  const low = command.toLowerCase();
  const key = folder.toLowerCase().replace(/[\\/]+$/, '');
  for (let at = low.indexOf(key); at >= 0 && key; at = low.indexOf(key, at + 1)) {
    let end = at + key.length;
    while (end < command.length && !/[\s'"`;|]/.test(command[end]!)) end++;
    out.push([at, end]);
    at = end - 1;
  }
  return out;
}

/** The title of a python_env confirmation: what it downloads (Python, packages, or both). */
export function installTitle(p: InstallPreview): string {
  const n = p.packages.length;
  if (p.python && n) return t('下载 Python {version} 和 {n} 个库', { version: p.python.version, n });
  if (p.python) return t('下载 Python {version}', { version: p.python.version });
  return t('安装 {n} 个库', { n });
}

/**
 * What a python_env confirmation would download, one row each: name and version, where from, size (— when the
 * source does not say), then the total, only when every size is known (the first time, before there is a Python to
 * resolve with, the packages have no version or size yet).
 */
export function InstallList({ preview }: { preview: InstallPreview }) {
  const rows = [
    ...(preview.python ? [{ key: 'python', name: `Python ${preview.python.version}`, host: preview.python.host, bytes: preview.python.bytes }] : []),
    ...preview.packages.map((p) => ({ key: p.name, name: p.version ? `${p.name} ${p.version}` : p.name, host: preview.packageHost, bytes: p.bytes })),
  ];
  const known = rows.filter((r) => typeof r.bytes === 'number');
  const total = known.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  return (
    <div className="download-list" role="table" aria-label={t('下载内容')}>
      {rows.map((r) => (
        <div key={r.key} className="download-row" role="row">
          <span className="download-name" role="cell">
            {r.name}
          </span>
          <span className="download-host" role="cell">
            {r.host}
          </span>
          <span className="download-size" role="cell">
            {typeof r.bytes === 'number' ? formatBytes(r.bytes) : '—'}
          </span>
        </div>
      ))}
      {rows.length > 1 && known.length === rows.length ? (
        <div className="download-row is-total" role="row">
          <span className="download-name" role="cell">
            {t('合计')}
          </span>
          <span className="download-host" role="cell" />
          <span className="download-size" role="cell">
            {formatBytes(total)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** The room a confirmation card's words need on its one row (in characters of its size), else its buttons go under. */
const CONFIRM_WORDS_ROOM = 9;

/** Width of a head item as it is on one row: a row of things (the buttons, what was decided) as wide as they are. */
function naturalWidth(el: Element): number {
  const style = getComputedStyle(el);
  const margins = (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
  const kids = [...el.children];
  if (!kids.length || !style.display.includes('flex')) return el.getBoundingClientRect().width + margins;
  const gap = parseFloat(style.columnGap) || 0;
  return kids.reduce((sum, k) => sum + k.getBoundingClientRect().width, 0) + gap * (kids.length - 1) + margins;
}

/** Whether the words would be narrower than CONFIRM_WORDS_ROOM characters with everything on one row. */
function wordsSqueezed(head: HTMLElement): boolean {
  const title = head.querySelector(':scope > .card-title');
  if (!title) return false;
  const style = getComputedStyle(head);
  const kids = [...head.children];
  const others = kids.filter((k) => k !== title && !k.classList.contains('confirm-spacer')).reduce((sum, k) => sum + naturalWidth(k), 0);
  const gaps = (parseFloat(style.columnGap) || 0) * (kids.length - 1);
  const room = head.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) - others - gaps;
  return room < (parseFloat(getComputedStyle(title).fontSize) || 14) * CONFIRM_WORDS_ROOM;
}

/**
 * A confirmation: the card is what would run. One slim row (what it will do, 无法撤销 when it cannot be taken
 * back, 拒绝 / 允许 or what was decided), then the command in full (copy at its top right) or the call's arguments.
 * For a command, the title is the app's own reading of it (运行命令 when it cannot tell), not the model's words.
 */
export function ConfirmCard({ block, onDecide }: { block: Extract<Block, { type: 'confirm' }>; onDecide(approved: boolean, allowFolder?: boolean): void }) {
  const [sent, setSent] = useState(false);
  const decided = block.approved !== undefined || block.cancelled === true;
  // A narrow card (the chat squeezed by the panel) whose words would be a column a few characters wide: 拒绝 / 允许
  // (or what was decided) on a row under them. Measured here, not a container query: that would change how the card
  // is painted at every width.
  const head = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = head.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setNarrow(wordsSqueezed(el)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [decided]);
  const decide = (approved: boolean, allowFolder = false) => {
    if (sent) return;
    setSent(true);
    if (allowFolder) onDecide(approved, true);
    else onDecide(approved);
  };
  const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
  const command = block.name === 'run_command' && typeof input.command === 'string' ? input.command : null;
  const facts = command !== null ? commandFacts(command) : [];
  // 无法撤销 and the warning: a dangerous command, or a step a plugin marked irreversible (its hook, or its manifest).
  const danger = facts.some((f) => f.danger) || block.irreversible === true;
  // A reason on two lines (the built-in browser's: what, then where and on what): the second is a grey line under
  // the title. One line: the card as before.
  const [reasonHead, ...reasonRest] = block.reason.split('\n');
  const sub = command === null && !block.install && reasonRest.length ? reasonRest.join(' ') : '';
  const title = block.install ? installTitle(block.install) : command === null ? confirmTitle(block.name, block.input, sub ? (reasonHead ?? '') : block.reason) : facts.length ? facts.map((f) => f.text).join(t('；')) : t('运行命令');
  const cls = ['card', 'confirm-card', danger ? 'is-danger' : '', decided ? 'is-done' : '', narrow ? 'is-narrow' : ''].filter(Boolean).join(' ');
  return (
    <section className={cls} aria-label={t('确认')}>
      <header ref={head} className="card-head">
        {/* Only a dangerous one has a mark (the warning); an ordinary one's ringed i said nothing its 拒绝 / 允许
            do not (他在决策页 d26 选「只去掉普通确认卡的 i」). */}
        {danger ? <SpicaStatusIcon name="warning" size={16} /> : null}
        <span className="card-title" title={title} data-tip-clipped="">{title}</span>
        {danger ? <span className="confirm-undo">{t('无法撤销')}</span> : null}
        {/* a write outside the conversation's folders: said as a tag, as 无法撤销 is (the path is in the change below) */}
        {block.outsideFolder ? <span className="confirm-undo">{t('工作文件夹以外')}</span> : null}
        <span className="confirm-spacer" />
        {decided ? (
          <p className={block.cancelled === true && block.approved === undefined ? 'card-answer is-stopped' : 'card-answer'}>
            <SpicaStatusIcon name={block.approved ? 'done' : 'stopped'} size={15} />
            <span>{block.approved ? t('已允许') : block.approved === false ? t('已拒绝') : t(CARD_STOPPED)}</span>
          </p>
        ) : (
          <div className="card-actions">
            <button type="button" className="btn" disabled={sent} onClick={() => decide(false)}>
              {t('拒绝')}
            </button>
            {block.outsideFolder && !block.folderTooWide ? (
              <AllowSplit disabled={sent} hint={block.outsideFolder} onAllow={(always) => decide(true, always)} />
            ) : (
              <button type="button" className="btn btn-primary" disabled={sent} onClick={() => decide(true)}>
                {t('允许')}
              </button>
            )}
          </div>
        )}
      </header>
      {/* The reason's second line: under the head, lined up with the title, the card's whole width (whole on hover). */}
      {sub ? (
        <p className="card-sub" title={sub}>
          {sub}
        </p>
      ) : null}
      {block.install ? <InstallList preview={block.install} /> : <ConfirmTarget name={block.name} input={block.input} change={block.change} outsideFolder={block.outsideFolder} bare />}
      {block.cause && GUARD_CAUSE_TEXT[block.cause] ? <p className="card-why">{GUARD_CAUSE_TEXT[block.cause]}</p> : null}
    </section>
  );
}

export function SuggestCard({ block, onPick }: { block: Extract<Block, { type: 'suggest' }>; onPick(prompt: string): void }) {
  if (block.actions.length === 0) return null;
  return (
    <section className="card suggest-card" aria-label={t('操作建议')}>
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
  report: N_('已完成'),
  relay: N_('你的回复'),
  decision: N_('已决定'),
};

/** A sub-agent's report, something the user said in a sub-session, or a decision made there. */
export function ChildNoteCard({ note, onOpen }: { note: ChildNote; onOpen(id: string): void }) {
  const from = note.fromTitle ?? t('子任务');
  const head = t(NOTE_HEAD[note.kind]);
  // A report with nothing written: the window's own words, in the current language.
  const text = note.text === NO_REPORT_WORDS ? t(NO_REPORT_WORDS) : note.text;
  return (
    <section className={`card note-card note-${note.kind}`} aria-label={t('{from}：{kind}', { from, kind: head })}>
      <header className="note-head">
        <button type="button" className="note-from" onClick={() => onOpen(note.fromSessionId)} title={t('打开「{name}」', { name: from })}>
          {from}
        </button>
        <span className="note-kind">{head}</span>
      </header>
      {note.kind === 'report' ? <MarkdownText text={text} /> : <p className="note-text">{text}</p>}
    </section>
  );
}
