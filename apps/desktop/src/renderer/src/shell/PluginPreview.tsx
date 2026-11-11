// A file in the right panel shown by a plugin's preview page (views/<id>.json with placement preview), chosen in
// 设置 › 常规 › 文件预览. The page gets this one file's bytes (never its path) through window.spica.preview; it is
// not opened for a file larger than it takes, and when it fails, errs before it is drawn, or is not drawn within
// PREVIEW_TIMEOUT_MS, the panel goes back to the app's own preview (预览方式 then says 自带预览) with a line saying
// why (onFallback).
// The page lives only while it is shown: closing the preview or choosing another way removes it.
import { useEffect, useRef, useState } from 'react';
import type { PreviewFile } from '../../../shared/bridge';
import type { PluginView } from '../../../shared/plugin-view';
import { PluginFrame, type PluginFrameProps, type PreviewPayload } from './PluginFrame';

export const PREVIEW_TIMEOUT_MS = 15_000;

/** Why the panel went back to the app's own preview; `text` null: nothing to say (the file is gone, the page is). */
export interface PreviewFallback {
  text: string | null;
  /** The page may manage next time (重试). */
  retry: boolean;
}

export interface PluginPreviewProps extends Pick<PluginFrameProps, 'theme' | 'changed' | 'call' | 'cancel' | 'confirm' | 'notify'> {
  view: PluginView;
  file: { sessionId: string | null; path: string };
  loadFile(sessionId: string | null, path: string, maxBytes: number, peek: boolean): Promise<PreviewFile>;
  /** Whether the page's entry file is there (its plugin may have been removed). */
  exists(plugin: string, path: string): Promise<boolean>;
  onFallback(why: PreviewFallback): void;
  /** For tests. */
  timeoutMs?: number;
}

function sizeMb(bytes: number): string {
  return String(Math.round((bytes / 1024 / 1024) * 10) / 10);
}

/** What the panel says when a file is not given to the page. */
export function refusedText(r: Extract<PreviewFile, { ok: false }>, view: PluginView): string | null {
  if (r.problem === 'too-large') return `文件超过 ${sizeMb(view.preview?.maxBytes ?? 0)} MB`;
  return null;
}

export function PluginPreview({ view, file, loadFile, exists, onFallback, timeoutMs = PREVIEW_TIMEOUT_MS, ...frame }: PluginPreviewProps) {
  const maxBytes = view.preview?.maxBytes ?? 0;
  const fileKey = `${file.sessionId ?? ''}|${file.path}`;
  // Whether the page may be opened for the file it was mounted with: its entry is there and the file not too big.
  const [open, setOpen] = useState(false);
  const latest = useRef({ file, onFallback });
  useEffect(() => {
    latest.current = { file, onFallback };
  });
  const gone = useRef(false);
  const fallBack = (why: PreviewFallback) => {
    if (gone.current) return;
    gone.current = true;
    latest.current.onFallback(why);
  };

  useEffect(() => {
    let alive = true;
    void Promise.all([exists(view.plugin, view.entry).catch(() => false), loadFile(file.sessionId, file.path, maxBytes, true).catch((): PreviewFile => ({ ok: false, problem: 'unreadable' }))]).then(([there, peek]) => {
      if (!alive) return;
      if (!there) fallBack({ text: null, retry: false });
      else if (!peek.ok) fallBack({ text: refusedText(peek, view), retry: false });
      else setOpen(true);
    });
    return () => {
      alive = false;
    };
    // Mounted per page and attempt; another file is handed to the page that is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Not drawn in time: from the page's load, and again from each file it is given.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const startTimer = () => {
    stopTimer();
    timer.current = setTimeout(() => fallBack({ text: `「${view.title}」打开超时`, retry: true }), timeoutMs);
  };
  useEffect(() => {
    if (open) startTimer();
    return stopTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fileKey]);

  if (!open) return <div className="plugin-page" />;
  return (
    <div className="plugin-page">
      <PluginFrame
        {...frame}
        view={view}
        openFile={async () => '预览页不能打开其他文件。'}
        preview={{
          fileKey,
          file: async (): Promise<PreviewPayload> => {
            const f = latest.current.file;
            const r = await loadFile(f.sessionId, f.path, maxBytes, false);
            if (!r.ok || !r.bytes) {
              fallBack({ text: r.ok ? null : refusedText(r, view), retry: false });
              throw new Error('无法读取文件。');
            }
            const bytes = r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength) as ArrayBuffer;
            return { name: r.name, size: r.size, modifiedAt: r.modifiedAt, extension: r.extension, bytes };
          },
          ready: stopTimer,
          fail: (text) => {
            stopTimer();
            fallBack({ text: `「${view.title}」：${text.trim() || '无法打开此文件'}`, retry: true });
          },
          // The page's script failed before it drew the file (its words are hidden from the window: "Script error.").
          error: () => {
            stopTimer();
            fallBack({ text: `「${view.title}」出错`, retry: true });
          },
          loaded: startTimer,
        }}
      />
    </div>
  );
}
