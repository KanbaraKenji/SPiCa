// The button that lays the file preview over the whole conversation (Ctrl+Shift+\), and back.
// It sits in the preview's own head. The details panel has none (a fixed width), and it is never in
// the window's title bar.
import { Icon } from './Icon';

export interface MaxState {
  on: boolean;
  toggle(): void;
}

/** `hint`: the keys said on hover (the preview's by default; '' for none). */
export function MaxButton({ max, hint = 'Ctrl+Shift+\\' }: { max: MaxState; hint?: string }) {
  return (
    <button
      type="button"
      className={max.on ? 'icon-btn is-on' : 'icon-btn'}
      onClick={max.toggle}
      aria-label={max.on ? '还原' : '最大化'}
      aria-pressed={max.on}
      title={`${max.on ? '还原' : '最大化'}${hint ? `（${hint}）` : ''}`}
    >
      <Icon name={max.on ? 'restore' : 'maximize'} size={15} />
    </button>
  );
}
