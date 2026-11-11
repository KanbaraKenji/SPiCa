// An icon button that copies: the copy icon, a check for a moment after it worked. Its name is on hover.
// Under messages, on code blocks, tables and file cards.
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface CopyButtonProps {
  /** Puts the text on the clipboard. */
  copy(): Promise<void>;
  /** Its name (hover and screen readers). */
  label?: string;
  className?: string;
}

export function CopyButton({ copy, label = '复制', className = 'icon-btn msg-action' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const shown = copied ? '已复制' : label;
  return (
    <button
      type="button"
      className={className}
      aria-label={shown}
      title={shown}
      onClick={() =>
        void copy()
          .then(() => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined)
      }
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
    </button>
  );
}
