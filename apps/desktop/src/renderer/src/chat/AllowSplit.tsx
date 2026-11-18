// 始终允许 as the main button, 允许一次 in its drop-down: a confirmation that can be allowed for good (a write outside
// the conversation's folders: that folder). One shape: the main part and the arrow share the outer corners, the
// inner edge is straight on both. Keys: Enter / Space on the main part is 始终允许; on the arrow, or Alt+Down on the
// main part, the menu opens with 允许一次 focused (Up / Down / Enter / Esc as in every menu).
import { useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../../shared/i18n';
import { Icon } from '../ui/Icon';
import { ContextMenu } from '../ui/ContextMenu';

export function AllowSplit({ disabled, folder, onAllow }: { disabled: boolean; folder: string; onAllow(always: boolean): void }) {
  // The whole button while its menu is open (the menu's right edge goes on its right edge); null when closed.
  const [box, setBox] = useState<HTMLElement | null>(null);
  const open = box !== null;
  const openMenu = (from: HTMLElement) => {
    if (!disabled && from.parentElement) setBox(from.parentElement);
  };
  const onMainKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      openMenu(e.currentTarget);
    }
  };
  return (
    <span className={open ? 'allow-split is-open' : 'allow-split'}>
      <button type="button" className="btn btn-primary allow-split-main" disabled={disabled} title={folder} onClick={() => onAllow(true)} onKeyDown={onMainKey}>
        {t('始终允许')}
      </button>
      <button
        type="button"
        className="btn btn-primary allow-split-more"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('更多选项')}
        title={t('更多选项')}
        onClick={(e) => (open ? setBox(null) : openMenu(e.currentTarget))}
      >
        <Icon name="chevronDown" size={14} />
      </button>
      {/* On the page itself: inside the conversation a fixed position would be taken from the card. */}
      {open
        ? createPortal(<ContextMenu x={0} y={0} anchor={box} align="end" items={[{ label: t('允许一次'), onSelect: () => onAllow(false) }]} onClose={() => setBox(null)} />, document.body)
        : null}
    </span>
  );
}
