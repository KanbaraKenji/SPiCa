// The time for words that say how long ago something was (just now, 9 minutes ago): one clock for the whole
// window, a tick a minute while anything shows such words, and at once when the window comes back (from the tray,
// minimized, or another window in front).
import { useSyncExternalStore } from 'react';

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function tick(): void {
  now = Date.now();
  for (const l of listeners) l();
}

function onBack(): void {
  if (document.visibilityState !== 'hidden') tick();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    timer = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
    }
  };
}

const snapshot = () => now;

/** Now, in ms: changes once a minute and when the window comes back. */
export function useMinuteNow(): number {
  return useSyncExternalStore(subscribe, snapshot);
}
