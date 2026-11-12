// What stopped the last run or how it ended, just above the input box and as wide as it (he picked this layout,
// 「C」, from three mockups): a neutral strip with an outline, the icon and one line, a small outlined button at the
// right end. It stays there while older messages are scrolled into view. Each notice comes and goes as it did in the
// conversation: the run's error and the repeated-call stop until the next run starts; 上次运行已中断 while the
// conversation is interrupted; 回答到达长度上限 while the last answer is the cut one. Several at once are stacked, the
// one nearest the box last.
import { SpicaStatusIcon } from '@spica/brand/react';

export interface Notice {
  key: string;
  tone: 'error' | 'warning';
  text: string;
  action?: { label: string; onClick(): void };
}

export function RunNotices({ notices }: { notices: readonly Notice[] }) {
  if (!notices.length) return null;
  return (
    <div className="run-notices">
      {notices.map((n) => (
        <div key={n.key} className={`run-notice is-${n.tone}`} role={n.tone === 'error' ? 'alert' : 'status'}>
          <SpicaStatusIcon name={n.tone} size={15} />
          <span className="run-notice-text">{n.text}</span>
          {n.action ? (
            <button type="button" className="btn btn-small" onClick={n.action.onClick}>
              {n.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
