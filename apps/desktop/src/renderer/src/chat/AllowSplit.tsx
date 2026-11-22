// 始终允许 as the main button, 允许一次 in its drop-down: a confirmation that can be allowed for good (a write outside
// the conversation's folders: that folder). One shape: the main part and the arrow share the outer corners, the
// inner edge is straight on both. Keys: Enter / Space on the main part is 始终允许; on the arrow, or Alt+Down on the
// main part, the menu opens with 允许一次 focused (Up / Down / Enter / Esc as in every menu).
import { useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../../shared/i18n';
import { Icon } from '../ui/Icon';
import { ContextMenu } from '../ui/ContextMenu';

/**
 * The looks of the drop-down on trial, set by hand on the page (DevTools: document.documentElement.dataset.allowMenu =
 * 'main' | 'pill' | 'a' | 'b' | 'c'); nothing in the app sets it, so it is 甲 ('a') until one is picked. 乙 and 丙 are
 * as wide as the button. Goes once one is picked.
 */
const sameWidth = (): boolean => ['b', 'c'].includes(document.documentElement.dataset.allowMenu ?? '');

/**
 * Every confirmation that can be allowed for good uses this one (a write outside the folders, the computer-use card):
 * `onAllow(true)` is Always allow, `onAllow(false)` Allow once; `hint` is the main part's hover text (what is allowed).
 */
export function AllowSplit({ disabled, hint, onAllow }: { disabled: boolean; hint?: string; onAllow(always: boolean): void }) {
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
      <button type="button" className="btn btn-primary allow-split-main" disabled={disabled} title={hint} onClick={() => onAllow(true)} onKeyDown={onMainKey}>
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
        ? createPortal(
            <ContextMenu
              x={0}
              y={0}
              anchor={box}
              align="end"
              className="allow-split-menu"
              // 乙 / 丙 (the looks on trial, html[data-allow-menu]): as wide as the button
              minWidth={sameWidth() ? box.offsetWidth : undefined}
              items={[{ label: t('允许一次'), onSelect: () => onAllow(false) }]}
              onClose={() => setBox(null)}
            />,
            document.body,
          )
        : null}
    </span>
  );
}
