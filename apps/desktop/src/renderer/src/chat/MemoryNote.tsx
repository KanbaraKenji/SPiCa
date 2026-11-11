// The line a remember / forget call leaves in the conversation: 已记住 / 已更新 / 已忘记 and 撤销,
// 已撤销 once it was taken back.
import { createContext, useContext, useState } from 'react';
import type { MemoryCardMeta, MemoryItem } from '@spica/protocol';
import { memoryLine } from '../store/transcript';

export interface MemoryLines {
  /** The memory as it is now, with replaced and forgotten items; null until known. */
  items: MemoryItem[] | null;
  /** 撤销 (absent when the core cannot undo). */
  undo?: ((id: number) => Promise<unknown>) | undefined;
}

export const MemoryLinesContext = createContext<MemoryLines>({ items: null });

export function MemoryNote({ card }: { card: MemoryCardMeta }) {
  const { items, undo } = useContext(MemoryLinesContext);
  const [busy, setBusy] = useState(false);
  const id = card.item?.id;
  const line = memoryLine(card, items?.find((m) => m.id === id));
  if (!line || id === undefined) return null;
  return (
    <p className="turn-note memory-note">
      {line.text}
      {line.undo && undo ? (
        <button
          type="button"
          className="text-btn memory-undo"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void undo(id).finally(() => setBusy(false));
          }}
        >
          撤销
        </button>
      ) : null}
    </p>
  );
}
