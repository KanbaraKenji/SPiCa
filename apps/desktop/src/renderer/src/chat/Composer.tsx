// Multi-line input. Enter sends, Shift+Enter adds a line. While an IME is
// composing (Chinese pinyin etc.), Enter confirms the candidate and never sends.
// Below the text: attachments and the working folder (new conversation) on the
// left; approval, model and how full the context is on the right.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ApprovalMode } from '@spica/protocol';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { Icon } from '../ui/Icon';
import { FileGlyph } from '../ui/FileIcon';
import { APP_NAME } from '../../../shared/app-identity';

export interface ComposerTools {
  /** Windows' file picker; absent: no attachments. */
  pickFiles?: () => Promise<string[]>;
  /** Path of a file dropped on the box ('' when none). */
  pathForFile?: (file: File) => string;
  /** Only before a conversation exists: which folder it works in. */
  folder?: { name: string; path: string; onPick(): void };
  approval?: { mode: ApprovalMode; onChange(mode: ApprovalMode): void };
  /** The model this conversation uses; options to switch (a menu only when there is a choice). */
  /** Options by connection (`group`); `marks`: 默认 / 强模型. */
  model?: { label: string; options: { label: string; group?: string; marks?: string; current: boolean; onPick(): void }[] };
  /** Tokens the context takes now and the model's window (only when the window is known). */
  context?: { tokens: number; window: number };
}

export interface ComposerProps {
  running: boolean;
  onSend(text: string, attachments: string[]): void;
  onStop(): void;
  /** Changes when the session changes, so each session keeps its own draft. */
  sessionKey: string;
  tools?: ComposerTools;
}

const drafts = new Map<string, string>();
const attached = new Map<string, string[]>();

/** True while an input method is composing; keyCode 229 covers Chromium's IME keydown. */
export function isComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/** 12345 -> 「1.2 万」, 980 -> 「980」 (token counts, as people say them). */
export function tokenText(n: number): string {
  if (n < 10_000) return String(Math.round(n));
  const w = n / 10_000;
  return `${w >= 100 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, '')} 万`;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function ContextRing({ tokens, window }: { tokens: number; window: number }) {
  const label = `上下文已用 ${tokenText(tokens)} / ${tokenText(window)}（${Math.min(100, Math.round((tokens / window) * 100))}%）`;
  const share = Math.min(1, tokens / window);
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <span className={share >= 0.8 ? 'composer-context is-full' : 'composer-context'} role="img" aria-label={label} title={label}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={r} className="ring-track" />
        <circle cx="9" cy="9" r={r} className="ring-fill" strokeDasharray={`${c * share} ${c}`} transform="rotate(-90 9 9)" />
      </svg>
      {/* The number too, so the ring is not taken for a 'working' spinner. */}
      <span className="composer-context-pct">{Math.min(100, Math.round(share * 100))}%</span>
    </span>
  );
}

const APPROVAL_TEXT: Record<ApprovalMode, string> = { manual: '每次确认', auto: '自动批准' };
const APPROVAL_HINT = '自动批准：不可逆操作直接执行；处理外部内容后的操作仍需确认。';

export function Composer({ running, onSend, onStop, sessionKey, tools }: ComposerProps) {
  const [text, setText] = useState(() => drafts.get(sessionKey) ?? '');
  const [files, setFiles] = useState<string[]>(() => attached.get(sessionKey) ?? []);
  const [prevKey, setPrevKey] = useState(sessionKey);
  const [menu, setMenu] = useState<{ items: MenuItem[]; x: number; y: number } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  if (prevKey !== sessionKey) {
    setPrevKey(sessionKey);
    setText(drafts.get(sessionKey) ?? '');
    setFiles(attached.get(sessionKey) ?? []);
  }

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  useLayoutEffect(() => {
    ref.current?.focus();
  }, [sessionKey]);

  const update = (value: string) => {
    setText(value);
    drafts.set(sessionKey, value);
  };
  const setAttached = (list: string[]) => {
    const unique = [...new Set(list)].slice(0, 20);
    setFiles(unique);
    attached.set(sessionKey, unique);
  };

  const send = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value, files);
    update('');
    setAttached([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || isComposing(e)) return;
    e.preventDefault();
    send();
  };

  const openMenu = (el: HTMLElement, items: MenuItem[]) => {
    const r = el.getBoundingClientRect();
    const groups = new Set(items.map((i) => i.group).filter(Boolean)).size;
    setMenu({ items, x: r.left, y: r.top - 8 - items.length * 34 - groups * 24 });
  };

  const canSend = text.trim().length > 0;
  const t = tools ?? {};
  const left: ReactNode[] = [];
  if (t.pickFiles) {
    const pick = t.pickFiles;
    left.push(
      <button key="attach" type="button" className="icon-btn" aria-label="添加附件" title="添加附件" onClick={() => void pick().then((p) => p.length && setAttached([...files, ...p]))}>
        <Icon name="plus" size={16} />
      </button>,
    );
  }
  if (t.folder) {
    left.push(
      <button key="folder" type="button" className="composer-chip" title={`工作文件夹：${t.folder.path}`} onClick={t.folder.onPick}>
        <Icon name="folder" size={14} />
        <span className="composer-chip-text">{t.folder.name}</span>
      </button>,
    );
  }
  return (
    <div className="composer-wrap">
      <div
        className="composer"
        onDragOver={(e) => {
          if (t.pathForFile && e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!t.pathForFile) return;
          const paths = [...e.dataTransfer.files].map((f) => t.pathForFile!(f)).filter(Boolean);
          if (!paths.length) return;
          e.preventDefault();
          setAttached([...files, ...paths]);
        }}
      >
        {files.length ? (
          <div className="composer-files">
            {files.map((p) => (
              <span key={p} className="composer-file" title={p}>
                <FileGlyph name={p} />
                <span className="composer-chip-text">{baseName(p)}</span>
                <button type="button" className="composer-file-remove" aria-label={`移除 ${baseName(p)}`} onClick={() => setAttached(files.filter((x) => x !== p))}>
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={running ? '补充说明（下一步生效）' : `给 ${APP_NAME} 发消息`}
          aria-label="消息"
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-bar">
          <div className="composer-left">{left}</div>
          <div className="composer-right">
            {t.approval ? (
              <button
                type="button"
                className="composer-chip"
                aria-haspopup="menu"
                title={APPROVAL_HINT}
                onClick={(e) => {
                  const a = t.approval!;
                  openMenu(e.currentTarget, [
                    { label: APPROVAL_TEXT.manual, onSelect: () => a.onChange('manual') },
                    { label: APPROVAL_TEXT.auto, onSelect: () => a.onChange('auto') },
                  ]);
                }}
              >
                <span className="composer-chip-text">{APPROVAL_TEXT[t.approval.mode]}</span>
                <Icon name="chevronDown" size={12} />
              </button>
            ) : null}
            {t.model ? (
              t.model.options.length > 1 ? (
                <button
                  type="button"
                  className="composer-chip composer-model"
                  aria-haspopup="menu"
                  title="切换模型（下一步生效）"
                  onClick={(e) =>
                    openMenu(
                      e.currentTarget,
                      t.model!.options.map((o) => {
                        const hint = [o.current ? '当前' : '', o.marks ?? ''].filter(Boolean).join(' · ');
                        return { label: o.label, ...(o.group ? { group: o.group } : {}), ...(hint ? { hint } : {}), onSelect: o.onPick };
                      }),
                    )
                  }
                >
                  <span className="composer-chip-text">{t.model.label}</span>
                  <Icon name="chevronDown" size={12} />
                </button>
              ) : (
                <span className="composer-label">{t.model.label}</span>
              )
            ) : null}
            {t.context ? <ContextRing tokens={t.context.tokens} window={t.context.window} /> : null}
            {running ? (
              <button type="button" className="icon-btn composer-stop" onClick={onStop} aria-label="停止" title="停止">
                <Icon name="stop" size={14} />
              </button>
            ) : null}
            <button type="button" className="icon-btn composer-send" onClick={send} disabled={!canSend} aria-label="发送" title="发送（Enter）">
              <Icon name="send" size={16} />
            </button>
          </div>
        </div>
      </div>
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
