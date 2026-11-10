// A file shown in the right panel, read-only: PDF in the built-in viewer,
// Markdown rendered, text and code with line numbers, HTML in a sandbox
// (no scripts, nothing from the network), images. Anything else: a sentence
// and the system program.
import { useEffect, useState } from 'react';
import type { PreviewInfo } from '../../../shared/bridge';
import { MarkdownText } from '../chat/Blocks';
import { Icon } from '../ui/Icon';
import { FileGlyph } from '../ui/FileIcon';

export interface FilePreviewProps {
  /** null while loading. */
  info: PreviewInfo | null;
  onOpenExternal(path: string): void;
  onClose(): void;
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

export function FilePreview({ info, onOpenExternal, onClose }: FilePreviewProps) {
  return (
    <section className="preview" aria-label={info ? `预览 ${info.name}` : '预览'}>
      <header className="preview-head">
        <FileGlyph name={info?.name ?? ''} />
        <span className="preview-name" title={info?.path ?? ''}>
          {info?.name ?? ''}
        </span>
        {info && info.kind !== 'missing' ? (
          <button type="button" className="text-btn" onClick={() => onOpenExternal(info.path)}>
            用系统程序打开
          </button>
        ) : null}
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭预览" title="关闭预览">
          <Icon name="close" size={14} />
        </button>
      </header>
      {!info ? (
        <div className="preview-body" />
      ) : info.kind === 'pdf' ? (
        <iframe className="preview-frame" src={info.url} title={info.name} />
      ) : info.kind === 'image' ? (
        <div className="preview-body preview-image-wrap">
          <img className="preview-image" src={info.url} alt={info.name} />
        </div>
      ) : info.kind === 'markdown' || info.kind === 'text' || info.kind === 'html' ? (
        <>
          {info.truncated ? <p className="preview-note">文件有 {sizeText(info.size)}，这里只显示前 512 KB。完整内容请用系统程序打开。</p> : null}
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
export function usePreview(load: (sessionId: string | null, path: string) => Promise<PreviewInfo>, want: { sessionId: string | null; path: string } | null): PreviewInfo | null {
  const [state, setState] = useState<{ key: string; info: PreviewInfo } | null>(null);
  const key = want ? `${want.sessionId ?? ''}|${want.path}` : '';
  useEffect(() => {
    if (!want) return;
    let alive = true;
    load(want.sessionId, want.path)
      .then((info) => alive && setState({ key, info }))
      .catch(() => alive && setState({ key, info: { kind: 'missing', name: want.path.split(/[\\/]/).pop() ?? want.path, path: want.path, size: 0, message: '无法读取文件。' } }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state && state.key === key ? state.info : null;
}
