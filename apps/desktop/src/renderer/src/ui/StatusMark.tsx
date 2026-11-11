// The one status place at the end of a sidebar row: a coloured dot (waiting for you, an error,
// something new) or a small icon from the brand's status family (running, queued, stopped).
import { SpicaStatusIcon } from '@spica/brand/react';
import type { Slot } from '../shell/row-status';

const ICON = { running: 'running', queued: 'queued', stopped: 'stopped' } as const;

/** `text`: said instead of the state's own name (a collapsed row's counts). The place is kept when there is nothing to show. */
export function StatusSlot({ slot, text, onClick }: { slot: Slot | null; text?: string; onClick?: () => void }) {
  if (!slot) return <span className="status-slot" aria-hidden onClick={onClick} />;
  const said = text || slot.text;
  const icon = slot.kind === 'running' || slot.kind === 'queued' || slot.kind === 'stopped' ? ICON[slot.kind] : null;
  return (
    <span className={`status-slot is-${slot.kind}`} role="img" aria-label={said} title={said} onClick={onClick}>
      {icon ? <SpicaStatusIcon name={icon} size={12} /> : <span className="slot-dot" />}
    </span>
  );
}
