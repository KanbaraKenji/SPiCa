// The row under every message: copy it, 重新生成 (only under the last round's answer), flip between the answers a
// regenerate left (‹ 1 / 2 ›), and when it was written. Always there, not only on hover.
import type { RegenerateState } from '@spica/protocol';
import { REGENERATE_HINTS } from '@spica/protocol';
import { Icon } from '../ui/Icon';
import { clipboard } from '../ui/clipboard';
import { CopyButton } from '../ui/CopyButton';
import { mailTime } from '../../../shared/mail';
import type { Block } from '../store/transcript';

/** What 复制 copies of an answer: its text as written (Markdown), the parts in order. */
export function answerText(blocks: readonly Block[]): string {
  return blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

export { clipboard };

export interface RegenerateButton {
  /** The core's word on the last round (SessionInfo.regenerate). Only the last round's answer has the button. */
  state: RegenerateState;
  onRegenerate(): void;
}

function Regenerate({ r }: { r: RegenerateButton }) {
  const why = r.state.ok ? null : (r.state.hint ?? (r.state.code ? REGENERATE_HINTS[r.state.code] : null));
  // Not usable but said why: aria-disabled keeps the hover text (a disabled button shows none).
  return (
    <button
      type="button"
      className="icon-btn msg-action"
      aria-label="重新生成"
      aria-disabled={why ? 'true' : undefined}
      title={why ?? '重新生成'}
      onClick={() => {
        if (!why) r.onRegenerate();
      }}
    >
      <Icon name="refresh" size={14} />
    </button>
  );
}

export interface MessageActionsProps {
  /** What 复制 puts on the clipboard. */
  text: string;
  /** When it was written (ISO). */
  at?: string | undefined;
  regenerate?: RegenerateButton | undefined;
  /** Answers a regenerate left: which one shows (0-based) and how many there are. */
  versions?: { shown: number; count: number; onShow(n: number): void } | undefined;
  /** Under a message of the user's (on the right). */
  mine?: boolean;
}

export function MessageActions({ text, at, regenerate, versions, mine = false }: MessageActionsProps) {
  const time = at ? mailTime(at) : '';
  return (
    <div className={mine ? 'msg-actions is-mine' : 'msg-actions'} role="group" aria-label={mine ? '这条消息' : '这条回答'}>
      {versions && versions.count > 1 ? (
        <span className="msg-versions">
          <button type="button" className="icon-btn msg-action" aria-label="上一版" title="上一版" aria-disabled={versions.shown === 0 ? 'true' : undefined} onClick={() => versions.shown > 0 && versions.onShow(versions.shown - 1)}>
            <Icon name="chevronLeft" size={14} />
          </button>
          <span className="msg-versions-text" aria-label={`第 ${versions.shown + 1} 版，共 ${versions.count} 版`}>
            {versions.shown + 1} / {versions.count}
          </span>
          <button
            type="button"
            className="icon-btn msg-action"
            aria-label="下一版"
            title="下一版"
            aria-disabled={versions.shown === versions.count - 1 ? 'true' : undefined}
            onClick={() => versions.shown < versions.count - 1 && versions.onShow(versions.shown + 1)}
          >
            <Icon name="chevronRight" size={14} />
          </button>
        </span>
      ) : null}
      {text ? <CopyButton copy={() => clipboard.write(text)} /> : null}
      {regenerate ? <Regenerate r={regenerate} /> : null}
      {time ? (
        <time className="msg-time" dateTime={at}>
          {time}
        </time>
      ) : null}
    </div>
  );
}
