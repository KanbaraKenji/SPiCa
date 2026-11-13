// The one drop-down of the app. The browser's own select element is not used: its arrow is drawn by the browser against
// the right edge (it ignores our padding), and its open list is a window the system draws (square corners, the
// system's blue highlight, its own size and edge), which no style sheet reaches. Here the box is a button with
// the arrow drawn as far from the right edge as the words are from the left, and the list is the app's own menu
// (ui/ContextMenu.tsx: its edge, corners, ground, hover and size), lined up under the box (over it when there is
// no room), the chosen item ticked. Up and Down open it from the box; in the list Up, Down, Enter, Esc (first
// closes the list, a layer of ui/escape.ts) as in every menu; Tab leaves.
import { useState, type KeyboardEvent } from 'react';
import { ContextMenu } from './ContextMenu';
import { Icon } from './Icon';

export interface SelectOption {
  value: string;
  label: string;
  /** Shown but cannot be picked (a plugin that is gone). */
  disabled?: boolean;
  /** A heading over the first option of each run with the same group. */
  group?: string;
  /** Tells two groups apart when their headings read the same. */
  groupKey?: string;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange(value: string): void;
  /** For screen readers (the row's name). */
  label: string;
  /** Said on hover. */
  title?: string;
  /** Shown while the value is none of the options (选择服务商). */
  placeholder?: string;
  /** Sizes and places the box (as on the input it replaced). */
  className?: string;
}

export function Select({ value, options, onChange, label, title, placeholder = '', className }: SelectProps) {
  // The box while its list is open (the list sits under it).
  const [box, setBox] = useState<HTMLButtonElement | null>(null);
  const open = box !== null;
  const chosen = options.find((o) => o.value === value);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setBox(e.currentTarget);
    }
  };
  const close = () => {
    const at = box;
    setBox(null);
    // Picked (or closed from the list): the focus goes back to the box; a click elsewhere keeps its own.
    setTimeout(() => {
      const now = document.activeElement;
      if (at?.isConnected && (!now || now === document.body || !now.isConnected)) at.focus({ preventScroll: true });
    }, 0);
  };
  return (
    <>
      <button
        type="button"
        className={['input', 'select-box', className].filter(Boolean).join(' ')}
        role="combobox"
        data-value={value}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        {...(title ? { title } : {})}
        onClick={(e) => (open ? setBox(null) : setBox(e.currentTarget))}
        onKeyDown={onKeyDown}
      >
        <span className={chosen ? 'select-value' : 'select-value is-placeholder'}>{chosen?.label ?? placeholder}</span>
        <Icon name="chevronDown" size={14} className="select-arrow" />
      </button>
      {open ? (
        <ContextMenu
          x={0}
          y={0}
          anchor={box}
          minWidth={box.offsetWidth}
          focusChecked
          items={options.map((o) => ({
            label: o.label,
            value: o.value,
            checked: o.value === value,
            ...(o.disabled ? { disabled: true } : {}),
            ...(o.group ? { group: o.group } : {}),
            ...(o.groupKey ? { groupKey: o.groupKey } : {}),
            onSelect: () => {
              if (o.value !== value) onChange(o.value);
            },
          }))}
          onClose={close}
        />
      ) : null}
    </>
  );
}
