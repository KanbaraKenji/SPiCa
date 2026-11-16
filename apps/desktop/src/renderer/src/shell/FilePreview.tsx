// A file shown in the right panel, read-only: PDF in the built-in viewer,
// Markdown rendered, text and code with line numbers (code in colour), HTML in a sandbox
// (no scripts, nothing from the network), images. Anything else: a sentence
// and the system program.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PreviewInfo } from '../../../shared/bridge';
import { MarkdownText } from '../chat/Blocks';
import { HIGHLIGHT_MAX_CHARS, highlightLines, languageOf } from '../chat/highlight';
import { Icon } from '../ui/Icon';
import { FileGlyph } from '../ui/FileIcon';
import { ImageViewer } from '../ui/ImageViewer';
import { MaxButton, type MaxState } from '../ui/MaxButton';
import { clipboard } from '../ui/clipboard';
import { CopyButton } from '../ui/CopyButton';
import { Select } from '../ui/Select';
import { N_, t, tx } from '../../../shared/i18n';

export interface FilePreviewProps {
  /** null while loading. */
  info: PreviewInfo | null;
  /** The file being read (while `info` is null): its name in the head already. */
  loadingPath?: string;
  onOpenExternal(path: string): void;
  /** 打开所在文件夹 (the file selected in Explorer), by a press on the file's name; absent: the name is only its name. */
  onReveal?: (path: string) => void;
  onClose(): void;
  /** An Excel workbook: show its sheet number n (1-based). */
  onSheet?: (n: number) => void;
  /** An Excel sheet: its rows from row number `from` on (the next page as it scrolls). */
  loadRows?: (from: number) => Promise<PreviewInfo>;
  /** The preview over the whole conversation: whether it is, and the button's press. Absent: no such button. */
  max?: MaxState;
  /** 预览方式: the app's own or a plugin's preview page, for this file only. Absent: no choice. */
  source?: { options: { id: string; label: string }[]; value: string; onChange(id: string): void };
  /** A line above the preview (why the app's own is shown), with 重试 when the page may manage. */
  note?: { text: string; onRetry?: () => void } | null;
  /** Shown instead of the app's own preview (a plugin's preview page). */
  children?: ReactNode;
}

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

/**
 * Text with line numbers; code in a language coloured here (chat/highlight.ts, the colours of code in answers).
 * Long files render in pieces as you scroll down. A file up to HIGHLIGHT_MAX_CHARS is coloured before it shows;
 * a longer one shows plain first and its colours follow (about 0.3 s for 20 000 lines), so it opens at once.
 */
function Lines({ text, language }: { text: string; language: string | null }) {
  const plain = useMemo(() => text.replace(/\r\n?/g, '\n'), [text]);
  const lines = useMemo(() => plain.split('\n'), [plain]);
  const now = useMemo(() => (language && plain.length <= HIGHLIGHT_MAX_CHARS ? highlightLines(language, plain) : null), [language, plain]);
  const [later, setLater] = useState<{ text: string; lines: ReactNode[][] | null } | null>(null);
  useEffect(() => {
    if (!language || plain.length <= HIGHLIGHT_MAX_CHARS) return;
    const id = setTimeout(() => setLater({ text: plain, lines: highlightLines(language, plain) }), 0);
    return () => clearTimeout(id);
  }, [language, plain]);
  const coloured = now ?? (later?.text === plain ? later.lines : null);
  const [shown, setShown] = useState(2000);
  return (
    // A pre, as every block of code (the code colours are set for code in one).
    <pre
      className="preview-code"
      onScroll={(e) => {
        const el = e.currentTarget;
        if (shown < lines.length && el.scrollTop + el.clientHeight > el.scrollHeight - 400) setShown((n) => n + 2000);
      }}
    >
      {lines.slice(0, shown).map((l, i) => (
        <span key={i} className="preview-line">
          <span className="preview-ln" aria-hidden>
            {i + 1}
          </span>
          <span className="preview-lt">{coloured?.[i]?.length ? coloured[i] : l || ' '}</span>
        </span>
      ))}
    </pre>
  );
}

type SheetInfo = Extract<PreviewInfo, { kind: 'sheet' }>;

/** Rows drawn above and below the ones in view; the rest of a long sheet is empty space of the same height. */
const SHEET_OVERSCAN = 150;
/** A column no wider than this; a longer cell is cut, its whole text on hover. */
const SHEET_COL_MAX = 480;
/** A cell's padding and line, beside its text (styles.css .preview-sheet td), and a little room. */
const SHEET_CELL_EXTRA = 21 + 4;

let measureCanvas: HTMLCanvasElement | null = null;

/** How wide `text` is in `font`, by a canvas (no layout). */
function textWidth(font: string, text: string): number {
  measureCanvas ??= document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  if (!ctx) return 0;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** A rough length to pick the longest cell of a column by (a Chinese character counts two). */
function roughLength(s: string): number {
  let n = s.length;
  for (const ch of s) if (ch.charCodeAt(0) > 0x2e80) n++;
  return n;
}

/**
 * An Excel sheet: its sheets as tabs above, the grid with Excel's column letters and row numbers. Its rows come
 * a page at a time: near the bottom the next page is asked for (`loadRows`) and added, to the sheet's last row.
 * Only the rows near the view are drawn (every row is one line high), so a sheet of 50 000 rows scrolls as one
 * of 500; each column is as wide as its longest cell so far (up to SHEET_COL_MAX), so it does not change as it scrolls.
 */
function Sheet({ info, onSheet, loadRows }: { info: SheetInfo; onSheet?: ((n: number) => void) | undefined; loadRows?: ((from: number) => Promise<PreviewInfo>) | undefined }) {
  // The pages added to the first one, the row height and column widths: this first page only (this sheet, as
  // read this time: read again, it starts over).
  const id = info.rows;
  const [added, setAdded] = useState<{ id: SheetInfo['rows']; rows: SheetInfo['rows']; more: boolean } | null>(null);
  // A page being asked for (a ref: two scroll events before the next render must not ask twice).
  const loading = useRef(false);
  const [view, setView] = useState({ top: 0, height: 800 });
  // Row height, and each column's width (the row numbers first) from the rows seen so far (`upto` of them).
  const [measured, setMeasured] = useState<{ id: SheetInfo['rows']; row: number; widths: number[]; upto: number } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const own = added?.id === id ? added : null;
  const rows = useMemo(() => (own ? [...info.rows, ...own.rows] : info.rows), [info.rows, own]);
  const more = own ? own.more : info.more;
  const sized = measured?.id === id ? measured : null;
  const rowH = sized?.row ?? 29;
  const first = Math.max(0, Math.floor(view.top / rowH) - SHEET_OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / rowH) + SHEET_OVERSCAN);
  const next = () => {
    const end = rows.at(-1);
    if (!more || loading.current || !loadRows || !end) return;
    loading.current = true;
    loadRows(end.n + 1)
      .then((page) => {
        if (page.kind !== 'sheet') return;
        setAdded((a) => {
          const have = a?.id === id ? a.rows : [];
          // Only rows after the last one there (a page that came twice adds nothing).
          const after = (have.at(-1) ?? info.rows.at(-1))?.n ?? 0;
          return { id, rows: [...have, ...page.rows.filter((r) => r.n > after)], more: page.more };
        });
      })
      .catch(() => setAdded((a) => ({ id, rows: a?.id === id ? a.rows : [], more: false })))
      .finally(() => {
        loading.current = false;
      });
  };
  // The row height from the first row drawn; the widths from the rows added since last time (the longest cell
  // of each column measured), never narrower than before.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || (sized && sized.upto === rows.length)) return;
    const row = sized?.row ?? el.querySelector<HTMLElement>('tbody tr:not(.preview-gap)')?.getBoundingClientRect().height ?? 0;
    const table = el.querySelector('table');
    if (row <= 0 || !table) return;
    const style = getComputedStyle(table);
    const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const widths = sized ? [...sized.widths] : [];
    const fit = (i: number, text: string) => {
      const w = Math.min(SHEET_COL_MAX, Math.ceil(textWidth(font, text)) + SHEET_CELL_EXTRA);
      if (!(widths[i]! >= w)) widths[i] = w;
    };
    const from = sized?.upto ?? 0;
    fit(0, String(rows.at(-1)?.n ?? ''));
    info.columns.forEach((c, k) => {
      // The longest cells by length, all measured (the same length is not the same width: 2026-11-01, 2026-11-02).
      let most = sized ? 0 : roughLength(c);
      for (let r = from; r < rows.length; r++) most = Math.max(most, roughLength(rows[r]!.cells[k] ?? ''));
      let measuredCells = 0;
      if (!sized) fit(k + 1, c);
      for (let r = from; r < rows.length && measuredCells < 50; r++) {
        const cell = rows[r]!.cells[k] ?? '';
        if (cell && roughLength(cell) >= most - 1) {
          fit(k + 1, cell);
          measuredCells++;
        }
      }
    });
    if (widths.every((w) => w > SHEET_CELL_EXTRA)) setMeasured({ id, row, widths, upto: rows.length });
  }, [sized, rows, info.columns, id]);
  useEffect(() => {
    const el = body.current;
    if (el) setView({ top: el.scrollTop, height: el.clientHeight || 800 });
  }, [id]);
  return (
    <>
      {info.sheets.length > 1 ? (
        <div className="tabs preview-sheets" role="tablist" aria-label={t('工作表')}>
          {info.sheets.map((s, i) => (
            <button key={`${i}|${s.name}`} type="button" role="tab" aria-selected={info.sheet === i + 1} className={info.sheet === i + 1 ? 'tab is-on' : 'tab'} onClick={() => onSheet?.(i + 1)}>
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
      {info.left ? <p className="preview-note">{t('仅显示前 {shown} 行（共 {total} 行）', info.left)}</p> : null}
      {rows.length ? (
        <div
          ref={body}
          className="preview-body preview-sheet"
          onScroll={(e) => {
            const el = e.currentTarget;
            setView({ top: el.scrollTop, height: el.clientHeight || 800 });
            if (el.scrollTop + el.clientHeight > el.scrollHeight - 600) next();
          }}
        >
          <table className={sized ? 'is-fixed' : undefined} style={sized ? { width: sized.widths.reduce((a, w) => a + w, 0) } : undefined}>
            {sized ? (
              <colgroup>
                {sized.widths.map((w, i) => (
                  <col key={i} style={{ width: w }} />
                ))}
              </colgroup>
            ) : null}
            <thead>
              <tr>
                <th aria-hidden />
                {info.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {first > 0 ? (
                <tr className="preview-gap" aria-hidden>
                  <td colSpan={info.columns.length + 1} style={{ height: first * rowH }} />
                </tr>
              ) : null}
              {rows.slice(first, last).map((r) => (
                <tr key={r.n}>
                  <th>{r.n}</th>
                  {info.columns.map((c, i) => (
                    <td key={c} title={(r.cells[i]?.length ?? 0) > 30 ? r.cells[i] : undefined}>
                      {r.cells[i] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
              {last < rows.length ? (
                <tr className="preview-gap" aria-hidden>
                  <td colSpan={info.columns.length + 1} style={{ height: (rows.length - last) * rowH }} />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="preview-body preview-empty">
          <p>{t('此工作表为空')}</p>
        </div>
      )}
    </>
  );
}

/** A Word document: shown as the text read from it (main/office-preview.ts), not a file with code of its own. */
const WORD_NAME = /\.doc[xm]$/i;

/** What a cut-off preview says: how much of a Word document (main/office-preview.ts), or of text after 512 KB. */
function cutNote(info: { name: string; size: number; blocks?: { shown: number; total: number } }): string {
  if (info.blocks) return t('仅显示前 {shown} 段（共 {total} 段）', info.blocks);
  return t('仅显示前 512 KB（共 {size}）', { size: sizeText(info.size) });
}

/** What can be shown both ways in the panel: as a page, picture or table, and as its code (and the code's language). */
function codeOf(info: PreviewInfo | null): { text: string; language: string | null } | null {
  if (!info) return null;
  if (info.kind === 'sheet' && info.text !== undefined) return { text: info.text, language: null };
  if (info.kind === 'html') return { text: info.text, language: 'xml' };
  if (info.kind === 'markdown' && !WORD_NAME.test(info.name)) return { text: info.text, language: 'markdown' };
  if (info.kind === 'image' && info.text !== undefined) return { text: info.text, language: 'xml' };
  return null;
}

export function FilePreview({ info, loadingPath, onOpenExternal, onReveal, onSheet, loadRows, onClose, max, source, note, children }: FilePreviewProps) {
  // 预览 / 代码: per file, kept while the panel is open (another file opens as its preview; back to this one, as left).
  const id = info ? `${info.kind}|${info.path}|${info.name}` : '';
  const [codeFor, setCodeFor] = useState<ReadonlySet<string>>(() => new Set());
  const code = children ? null : codeOf(info);
  const asCode = code !== null && codeFor.has(id);
  const showAs = (on: boolean) =>
    setCodeFor((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const hasFile = Boolean(info && info.kind !== 'missing' && info.path);
  const loadingName = !info && loadingPath ? loadingPath.split(/[\\/]/).pop() : undefined;
  // A picture pressed: over the window, as pictures in the conversation (the wheel zooms, a drag moves it, a
  // press or Esc puts it back).
  const [bigFor, setBigFor] = useState<string | null>(null);
  return (
    <section className="preview" aria-label={info ? t('预览 {name}', { name: info.name }) : t('预览')}>
      <header className="preview-head panel-head">
        <FileGlyph name={info?.name ?? loadingName ?? ''} />
        {/* The name opens the file's folder (its hover note says so, with the full path); 复制路径 right after it. */}
        {info && hasFile && onReveal ? (
          <button type="button" className="preview-name is-button" onClick={() => onReveal(info.path)} title={[t('打开所在文件夹'), info.path].join('\n')}>
            {info.name}
          </button>
        ) : (
          <span className="preview-name" title={info?.path ?? loadingPath ?? ''}>
            {info?.name ?? loadingName ?? ''}
          </span>
        )}
        {info && hasFile ? <CopyButton className="icon-btn" label={t('复制路径')} copy={() => clipboard.write(info.path)} /> : null}
        <span className="preview-head-gap" />
        {source && source.options.length > 1 ? (
          <Select className="preview-source" label={t('预览方式')} title={t('预览方式')} value={source.value} onChange={source.onChange} options={source.options.map((o) => ({ value: o.id, label: o.label }))} />
        ) : null}
        {code !== null ? (
          // One button: its icon and its note say the face a press goes to (预览 shows the code icon, 代码 the eye).
          <button type="button" className="icon-btn" onClick={() => showAs(!asCode)} aria-label={asCode ? t('查看预览') : t('查看代码')} title={asCode ? t('查看预览') : t('查看代码')}>
            <Icon name={asCode ? 'eye' : 'code'} size={15} />
          </button>
        ) : null}
        {max ? <MaxButton max={max} /> : null}
        {/* The file's own buttons: not for a page drawn from an answer (it has no file). */}
        {info && hasFile ? (
          <button type="button" className="icon-btn" onClick={() => onOpenExternal(info.path)} aria-label={t('用系统程序打开')} title={t('用系统程序打开')}>
            <Icon name="external" size={15} />
          </button>
        ) : null}
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('关闭预览')} title={t('关闭预览')}>
          <Icon name="close" size={14} />
        </button>
      </header>
      {note ? (
        <p className="preview-note preview-fallback">
          <span>{note.text}</span>
          {note.onRetry ? (
            <button type="button" className="btn btn-small" onClick={note.onRetry}>
              {t('重试')}
            </button>
          ) : null}
        </p>
      ) : null}
      {children ? (
        children
      ) : !info ? (
        // Being read (a big workbook takes a few seconds; another sheet too): said, after a moment.
        <div className="preview-body preview-empty preview-loading" role="status">
          <span className="spinner" aria-hidden />
          <span>{t('正在打开…')}</span>
        </div>
      ) : asCode ? (
        <Lines key={`${id}|code`} text={code.text} language={code.language} />
      ) : info.kind === 'pdf' ? (
        <iframe className="preview-frame" src={info.url} title={info.name} />
      ) : info.kind === 'image' ? (
        <div className="preview-body preview-image-wrap">
          <img
            className="preview-image"
            src={info.url}
            alt={info.name}
            title={t('放大')}
            role="button"
            tabIndex={0}
            onClick={() => setBigFor(id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setBigFor(id);
              }
            }}
          />
          {/* On the page itself: the panel (laid over the conversation, floating, 最大化) is a layer of its own. */}
          {bigFor === id ? createPortal(<ImageViewer pictures={[{ url: info.url, name: info.name }]} onClose={() => setBigFor(null)} />, document.body) : null}
        </div>
      ) : info.kind === 'sheet' ? (
        <Sheet info={info} onSheet={onSheet} loadRows={loadRows} />
      ) : info.kind === 'markdown' || info.kind === 'text' || info.kind === 'html' ? (
        <>
          {info.truncated ? <p className="preview-note">{cutNote(info)}</p> : null}
          {info.kind === 'markdown' ? (
            <div className="preview-body preview-md">
              <MarkdownText text={info.text} />
            </div>
          ) : info.kind === 'html' ? (
            // sandbox with no permissions: no scripts, no forms, no navigation; only the page itself.
            <iframe className="preview-frame preview-html" sandbox="" srcDoc={info.text} title={info.name} />
          ) : (
            <Lines key={info.path} text={info.text} language={languageOf(info.name)} />
          )}
        </>
      ) : (
        <div className="preview-body preview-empty">
          <p>{'message' in info ? tx(info.message) : ''}</p>
        </div>
      )}
    </section>
  );
}

/** Loads a preview whenever the requested file changes, or is asked for again (`opened`: a file rewritten since shows as it is now). */
export function usePreview(load: (sessionId: string | null, path: string, sheet?: number) => Promise<PreviewInfo>, want: { sessionId: string | null; path: string; sheet?: number; opened?: number } | null): PreviewInfo | null {
  const [state, setState] = useState<{ key: string; info: PreviewInfo } | null>(null);
  const key = want ? `${want.sessionId ?? ''}|${want.path}|${want.sheet ?? ''}|${want.opened ?? ''}` : '';
  useEffect(() => {
    if (!want) return;
    let alive = true;
    load(want.sessionId, want.path, want.sheet)
      .then((info) => alive && setState({ key, info }))
      .catch(() => alive && setState({ key, info: { kind: 'missing', name: want.path.split(/[\\/]/).pop() ?? want.path, path: want.path, size: 0, message: N_('无法读取文件。') } }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state && state.key === key ? state.info : null;
}
