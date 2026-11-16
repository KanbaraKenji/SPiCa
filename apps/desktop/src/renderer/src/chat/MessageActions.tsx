// The row under every message: copy it, 重新生成 (only under the last round's answer), flip between the answers a
// regenerate left (‹ 1 / 2 ›), and when it was written. Always there, not only on hover.
import type { RegenerateCode, RegenerateState } from '@spica/protocol';
import { N_, t, tx } from '../../../shared/i18n';
import { Icon } from '../ui/Icon';
import { clipboard } from '../ui/clipboard';
import { CopyButton } from '../ui/CopyButton';
import { fullTime, relativeTime } from './format';
import { useMinuteNow } from './now';
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

/** Why 重新生成 cannot run, by the core's code (the same words as the core's REGENERATE_HINTS). */
const REGENERATE_WORDS: Record<RegenerateCode, string> = {
  'regenerate.running': N_('对话正在运行，无法重新生成。'),
  'regenerate.waiting': N_('对话正在等待确认或回答，无法重新生成。'),
  'regenerate.wrote_files': N_('这一轮修改过文件，无法重新生成。'),
  'regenerate.spawned': N_('这一轮派出过子任务，无法重新生成。'),
  'regenerate.acted': N_('这一轮调用过可能产生改动的工具，无法重新生成。'),
  'regenerate.not_last': N_('这不是最后一轮回答，无法重新生成。'),
  'regenerate.not_typed': N_('这一轮不是由用户消息开始的，无法重新生成。'),
  'regenerate.role': N_('项目经理、子任务和邮件分拣的对话无法重新生成。'),
  'regenerate.no_turn': N_('没有可以重新生成的回答。'),
};

function Regenerate({ r }: { r: RegenerateButton }) {
  // By code in the current language; a hint without a known code as the core wrote it.
  const words = r.state.code ? REGENERATE_WORDS[r.state.code] : undefined;
  const why = r.state.ok ? null : words ? t(words) : r.state.hint ? tx(r.state.hint) : null;
  // Not usable but said why: aria-disabled keeps the hover text (a disabled button shows none).
  return (
    <button
      type="button"
      className="icon-btn msg-action"
      aria-label={t('重新生成')}
      aria-disabled={why ? 'true' : undefined}
      title={why ?? t('重新生成')}
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
  const now = useMinuteNow();
  // How long ago (just now, 9 minutes ago), the full moment on hover.
  const time = at ? relativeTime(at, now) : '';
  return (
    <div className={mine ? 'msg-actions is-mine' : 'msg-actions'} role="group" aria-label={mine ? t('这条消息') : t('这条回答')}>
      {versions && versions.count > 1 ? (
        <span className="msg-versions">
          <button type="button" className="icon-btn msg-action" aria-label={t('上一版')} title={t('上一版')} aria-disabled={versions.shown === 0 ? 'true' : undefined} onClick={() => versions.shown > 0 && versions.onShow(versions.shown - 1)}>
            <Icon name="chevronLeft" size={14} />
          </button>
          <span className="msg-versions-text" aria-label={t('第 {n} 版，共 {count} 版', { n: versions.shown + 1, count: versions.count })}>
            {versions.shown + 1} / {versions.count}
          </span>
          <button
            type="button"
            className="icon-btn msg-action"
            aria-label={t('下一版')}
            title={t('下一版')}
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
        <time className="msg-time" dateTime={at} title={at ? fullTime(at) : undefined}>
          {time}
        </time>
      ) : null}
    </div>
  );
}
