// Multi-line input. Enter sends, Shift+Enter adds a line. While an IME is
// composing (Chinese pinyin etc.), Enter confirms the candidate and never sends.
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../ui/Icon';

export interface ComposerProps {
  running: boolean;
  onSend(text: string): void;
  onStop(): void;
  /** Changes when the session changes, so each session keeps its own draft. */
  sessionKey: string;
}

const drafts = new Map<string, string>();

/** True while an input method is composing; keyCode 229 covers Chromium's IME keydown. */
export function isComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

export function Composer({ running, onSend, onStop, sessionKey }: ComposerProps) {
  const [text, setText] = useState(() => drafts.get(sessionKey) ?? '');
  const [prevKey, setPrevKey] = useState(sessionKey);
  const ref = useRef<HTMLTextAreaElement>(null);

  if (prevKey !== sessionKey) {
    setPrevKey(sessionKey);
    setText(drafts.get(sessionKey) ?? '');
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

  const send = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    update('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || isComposing(e)) return;
    e.preventDefault();
    send();
  };

  const canSend = text.trim().length > 0;
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={running ? '补充或改方向，会在下一步生效' : '给 Spica 发消息'}
          aria-label="消息"
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-actions">
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
  );
}
