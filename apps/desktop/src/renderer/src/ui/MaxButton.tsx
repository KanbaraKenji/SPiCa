// The button that lays the file preview over the whole conversation (Ctrl+Shift+\), and back.
// It sits in the preview's own head. The details panel has none (a fixed width), and it is never in
// the window's title bar.
import { Icon } from './Icon';
import { t } from '../../../shared/i18n';

export interface MaxState {
  on: boolean;
  toggle(): void;
}

/** `hint`: the keys said on hover (the preview's by default; '' for none). */
export function MaxButton({ max, hint = 'Ctrl+Shift+\\' }: { max: MaxState; hint?: string }) {
  const name = max.on ? t('还原') : t('最大化');
  return (
    <button
      type="button"
      className={max.on ? 'icon-btn is-on' : 'icon-btn'}
      onClick={max.toggle}
      aria-label={name}
      aria-pressed={max.on}
      title={hint ? t('{name}（{keys}）', { name, keys: hint }) : name}
    >
      <Icon name={max.on ? 'restore' : 'maximize'} size={15} />
    </button>
  );
}
