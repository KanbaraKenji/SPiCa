// A file shown in the right panel, read-only: PDF in the built-in viewer,
// Markdown rendered, text and code with line numbers, HTML in a sandbox
// (no scripts, nothing from the network), images. Anything else: a sentence
// and the system program.
import { useEffect, useState, type ReactNode } from 'react';
import type { PreviewInfo } from '../../../shared/bridge';
import { MarkdownText } from '../chat/Blocks';
import { Icon } from '../ui/Icon';
import { FileGlyph } from '../ui/FileIcon';
import { MaxButton, type MaxState } from '../ui/MaxButton';
import { clipboard } from '../ui/clipboard';
import { CopyButton } from '../ui/CopyButton';
import { Select } from '../ui/Select';

export interface FilePreviewProps {
  /** null while loading. */
  info: PreviewInfo | null;
  onOpenExternal(path: string): void;
  /** 打开所在文件夹 (the file selected in Explorer); absent: no such button. */
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
}

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** Text with line numbers; long files render in pieces as you scroll down. */
function Lines({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const [shown, setShown] = useState(2000);
  return (
    <div
      className="preview-code"
      onScroll={(e) => {
        const el = e.currentTarget;
        if (shown < lines.length && el.scrollTop + el.clientHeight > el.scrollHeight - 400) setShown((n) => n + 2000);
      }}
    >
      {lines.slice(0, shown).map((l, i) => (
        <div key={i} className="preview-line">
          <span className="preview-ln" aria-hidden>
            {i + 1}
          </span>
          <span className="preview-lt">{l || ' '}</span>
        </div>
      ))}
    </div>
  );
}

/** An Excel sheet: its sheets as tabs above, the grid with Excel's column letters and row numbers. */
function Sheet({ info, onSheet }: { info: Extract<PreviewInfo, { kind: 'sheet' }>; onSheet?: ((n: number) => void) | undefined }) {
  return (
    <>
      {info.sheets.length > 1 ? (
        <div className="tabs preview-sheets" role="tablist" aria-label="工作表">
          {info.sheets.map((s, i) => (
            <button key={`${i}|${s.name}`} type="button" role="tab" aria-selected={info.sheet === i + 1} className={info.sheet === i + 1 ? 'tab is-on' : 'tab'} onClick={() => onSheet?.(i + 1)}>
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
      {info.truncated ? <p className="preview-note">仅显示前 {info.rows.length} 行（共 {info.sheets[info.sheet - 1]?.rows ?? info.rows.length} 行）</p> : null}
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
          <p>此工作表为空</p>
        </div>
      )}
    </>
  );
}

/** A Word document: shown as the text read from it (main/office-preview.ts), not a file with code of its own. */
const WORD_NAME = /\.doc[xm]$/i;

/** What a cut-off preview says: a Word document stops after 500 paragraphs, text after 512 KB. */
function cutNote(info: { name: string; size: number }): string {
  return WORD_NAME.test(info.name) ? '仅显示前 500 段' : `仅显示前 512 KB（共 ${sizeText(info.size)}）`;
}

/** What can be shown both ways in the panel: as a page or picture, and as its code. */
function codeOf(info: PreviewInfo | null): string | null {
  if (!info) return null;
  if (info.kind === 'html' || (info.kind === 'markdown' && !WORD_NAME.test(info.name))) return info.text;
  if (info.kind === 'image' && info.text !== undefined) return info.text;
  return null;
}

export function FilePreview({ info, onOpenExternal, onReveal, onSheet, onClose, max, source, note, children }: FilePreviewProps) {
  // 代码 / 预览: per file (another file opens as its preview again).
  const id = info ? `${info.kind}|${info.path}|${info.name}` : '';
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const code = children ? null : codeOf(info);
  const asCode = code !== null && codeFor === id;
  return (
    <section className="preview" aria-label={info ? `预览 ${info.name}` : '预览'}>
      <header className="preview-head panel-head">
        <FileGlyph name={info?.name ?? ''} />
        <span className="preview-name" title={info?.path ?? ''}>
          {info?.name ?? ''}
        </span>
        {source && source.options.length > 1 ? (
          <Select className="preview-source" label="预览方式" title="预览方式" value={source.value} onChange={source.onChange} options={source.options.map((o) => ({ value: o.id, label: o.label }))} />
        ) : null}
        {code !== null ? (
          <button type="button" className="icon-btn" aria-pressed={asCode} onClick={() => setCodeFor(asCode ? null : id)} aria-label={asCode ? '预览' : '代码'} title={asCode ? '预览' : '代码'}>
            <Icon name={asCode ? 'eye' : 'code'} size={15} />
          </button>
        ) : null}
        {max ? <MaxButton max={max} /> : null}
        {/* The file's own buttons: not for a page drawn from an answer (it has no file). */}
        {info && info.kind !== 'missing' && info.path && onReveal ? (
          <button type="button" className="icon-btn" onClick={() => onReveal(info.path)} aria-label="打开所在文件夹" title="打开所在文件夹">
            <Icon name="folder" size={15} />
          </button>
        ) : null}
        {info && info.kind !== 'missing' && info.path ? <CopyButton className="icon-btn" label="复制路径" copy={() => clipboard.write(info.path)} /> : null}
        {info && info.kind !== 'missing' && info.path ? (
          <button type="button" className="icon-btn" onClick={() => onOpenExternal(info.path)} aria-label="用系统程序打开" title="用系统程序打开">
            <Icon name="external" size={15} />
          </button>
        ) : null}
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭预览" title="关闭预览">
          <Icon name="close" size={14} />
        </button>
      </header>
      {note ? (
        <p className="preview-note preview-fallback">
          <span>{note.text}</span>
          {note.onRetry ? (
            <button type="button" className="btn btn-small" onClick={note.onRetry}>
              重试
            </button>
          ) : null}
        </p>
      ) : null}
      {children ? (
        children
      ) : !info ? (
        <div className="preview-body" />
      ) : asCode ? (
        <Lines key={`${id}|code`} text={code} />
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
          ) : info.kind === 'html' ? (
            // sandbox with no permissions: no scripts, no forms, no navigation; only the page itself.
            <iframe className="preview-frame preview-html" sandbox="" srcDoc={info.text} title={info.name} />
          ) : (
            <Lines key={info.path} text={info.text} />
          )}
        </>
      ) : (
        <div className="preview-body preview-empty">
          <p>{'message' in info ? info.message : ''}</p>
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
      .catch(() => alive && setState({ key, info: { kind: 'missing', name: want.path.split(/[\\/]/).pop() ?? want.path, path: want.path, size: 0, message: '无法读取文件。' } }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state && state.key === key ? state.info : null;
}
