// A file shown in the right panel, read-only: PDF in the built-in viewer,
// Markdown rendered, text and code with line numbers (code in colour), HTML in a sandbox
// (no scripts, nothing from the network), images. Anything else: a sentence
// and the system program.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PreviewInfo } from '../../../shared/bridge';
import { MarkdownText } from '../chat/Blocks';
import { HIGHLIGHT_MAX_CHARS, highlightLines, languageOf } from '../chat/highlight';
import { Icon } from '../ui/Icon';
import { FileGlyph } from '../ui/FileIcon';
import { MaxButton, type MaxState } from '../ui/MaxButton';
import { clipboard } from '../ui/clipboard';
import { CopyButton } from '../ui/CopyButton';
import { Select } from '../ui/Select';
import { N_, t, tx } from '../../../shared/i18n';
import { POPUPS } from './BrowserPane';

export interface FilePreviewProps {
  /** null while loading. */
  info: PreviewInfo | null;
  onOpenExternal(path: string): void;
  /** 打开所在文件夹 (the file selected in Explorer), by a press on the file's name; absent: the name is only its name. */
  onReveal?: (path: string) => void;
  onClose(): void;
  /** An Excel workbook: show its sheet number n (1-based). */
  onSheet?: (n: number) => void;
  /** The preview over the whole conversation: whether it is, and the button's press. Absent: no such button. */
  max?: MaxState;
  /** 预览方式: the app's own or a plugin's preview page, for this file only. Absent: no choice. */
  source?: { options: { id: string; label: string }[]; value: string; onChange(id: string): void };
  /** A line above the preview (why the app's own is shown), with 重试 when the page may manage. */
  note?: { text: string; onRetry?: () => void } | null;
  /** Shown instead of the app's own preview (a plugin's preview page). */
  children?: ReactNode;
  /**
   * The panel's tab row (shell/PaneTabs.tsx), above the file's own row. The tab names the file, so the row shows its
   * full path instead; 最大化 and 关闭 are in the tab row.
   */
  tabs?: ReactNode;
  /** An HTML file's address in the built-in browser: its 预览 face runs its scripts there (shell/BrowserPane.tsx). */
  page?: string | null;
  /** Hosts the page tried to load from and was stopped (not on the allowed lists): a mark with their number. */
  blocked?: string[];
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

/** An Excel sheet: its sheets as tabs above, the grid with Excel's column letters and row numbers. */
function Sheet({ info, onSheet }: { info: Extract<PreviewInfo, { kind: 'sheet' }>; onSheet?: ((n: number) => void) | undefined }) {
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
      {info.truncated ? <p className="preview-note">{t('仅显示前 {shown} 行（共 {total} 行）', { shown: info.rows.length, total: info.sheets[info.sheet - 1]?.rows ?? info.rows.length })}</p> : null}
      {info.rows.length ? (
        <div className="preview-body preview-sheet">
          <table>
            <thead>
              <tr>
                <th aria-hidden />
                {info.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {info.rows.map((r) => (
                <tr key={r.n}>
                  <th>{r.n}</th>
                  {info.columns.map((c, i) => (
                    <td key={c}>{r.cells[i] ?? ''}</td>
                  ))}
                </tr>
              ))}
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

/** What a cut-off preview says: a Word document stops after 500 paragraphs, text after 512 KB. */
function cutNote(info: { name: string; size: number }): string {
  return WORD_NAME.test(info.name) ? t('仅显示前 500 段') : t('仅显示前 512 KB（共 {size}）', { size: sizeText(info.size) });
}

/** What can be shown both ways in the panel: as a page or picture, and as its code (and the code's language). */
function codeOf(info: PreviewInfo | null): { text: string; language: string } | null {
  if (!info) return null;
  if (info.kind === 'html') return { text: info.text, language: 'xml' };
  if (info.kind === 'markdown' && !WORD_NAME.test(info.name)) return { text: info.text, language: 'markdown' };
  if (info.kind === 'image' && info.text !== undefined) return { text: info.text, language: 'xml' };
  return null;
}

export function FilePreview({ info, onOpenExternal, onReveal, onSheet, onClose, max, source, note, children, tabs, page, blocked }: FilePreviewProps) {
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
  return (
    <section className="preview" aria-label={info ? t('预览 {name}', { name: info.name }) : t('预览')}>
      {tabs}
      <header className="preview-head panel-head">
        {tabs ? null : <FileGlyph name={info?.name ?? ''} />}
        {/* The name opens the file's folder (its hover note says so, with the full path); 复制路径 right after it. */}
        {info && hasFile && onReveal ? (
          <button type="button" className={tabs ? 'preview-name preview-path is-button' : 'preview-name is-button'} onClick={() => onReveal(info.path)} title={[t('打开所在文件夹'), info.path].join('\n')}>
            {tabs ? info.path : info.name}
          </button>
        ) : (
          <span className={tabs ? 'preview-name preview-path' : 'preview-name'} title={info?.path ?? ''}>
            {tabs ? (info?.path ?? '') : (info?.name ?? '')}
          </span>
        )}
        {info && hasFile ? <CopyButton className="icon-btn" label={t('复制路径')} copy={() => clipboard.write(info.path)} /> : null}
        <span className="preview-head-gap" />
        {/* What the page tried to load from the web and was stopped: a mark, not a button (the hosts on hover). */}
        {blocked?.length && !asCode ? (
          <span className="preview-blocked" role="status" title={t('已拦截：{hosts}', { hosts: blocked.join(t('、')) })} aria-label={t('已拦截：{hosts}', { hosts: blocked.join(t('、')) })}>
            <Icon name="shield" size={14} />
            {blocked.length}
          </span>
        ) : null}
        {source && source.options.length > 1 ? (
          <Select className="preview-source" label={t('预览方式')} title={t('预览方式')} value={source.value} onChange={source.onChange} options={source.options.map((o) => ({ value: o.id, label: o.label }))} />
        ) : null}
        {code !== null ? (
          // One button: its icon and its note say the face a press goes to (预览 shows the code icon, 代码 the eye).
          <button type="button" className="icon-btn" onClick={() => showAs(!asCode)} aria-label={asCode ? t('查看预览') : t('查看代码')} title={asCode ? t('查看预览') : t('查看代码')}>
            <Icon name={asCode ? 'eye' : 'code'} size={15} />
          </button>
        ) : null}
        {max && !tabs ? <MaxButton max={max} /> : null}
        {/* The file's own buttons: not for a page drawn from an answer (it has no file). */}
        {info && hasFile ? (
          <button type="button" className="icon-btn" onClick={() => onOpenExternal(info.path)} aria-label={t('用系统程序打开')} title={t('用系统程序打开')}>
            <Icon name="external" size={15} />
          </button>
        ) : null}
        {tabs ? null : (
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('关闭预览')} title={t('关闭预览')}>
            <Icon name="close" size={14} />
          </button>
        )}
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
        <div className="preview-body" />
      ) : asCode ? (
        <Lines key={`${id}|code`} text={code.text} language={code.language} />
      ) : info.kind === 'pdf' ? (
        <iframe className="preview-frame" src={info.url} title={info.name} />
      ) : info.kind === 'image' ? (
        <div className="preview-body preview-image-wrap">
          <img className="preview-image" src={info.url} alt={info.name} />
        </div>
      ) : info.kind === 'sheet' ? (
        <Sheet info={info} onSheet={onSheet} />
      ) : info.kind === 'markdown' || info.kind === 'text' || info.kind === 'html' ? (
        <>
          {info.truncated ? <p className="preview-note">{cutNote(info)}</p> : null}
          {info.kind === 'markdown' ? (
            <div className="preview-body preview-md">
              <MarkdownText text={info.text} />
            </div>
          ) : info.kind === 'html' && page ? (
            // In the built-in browser, scripts and all (its own process and storage; main/browser/local-pages.ts).
            <webview className="preview-frame preview-html" src={page} title={info.name} {...POPUPS} />
          ) : info.kind === 'html' ? (
            // Until its address is there (or without one): sandbox with no permissions, no scripts; only the page itself.
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

/** Loads a preview whenever the requested file changes. */
export function usePreview(load: (sessionId: string | null, path: string, sheet?: number) => Promise<PreviewInfo>, want: { sessionId: string | null; path: string; sheet?: number } | null): PreviewInfo | null {
  const [state, setState] = useState<{ key: string; info: PreviewInfo } | null>(null);
  const key = want ? `${want.sessionId ?? ''}|${want.path}|${want.sheet ?? ''}` : '';
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
