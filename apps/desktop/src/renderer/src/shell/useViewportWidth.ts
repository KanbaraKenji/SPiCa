import { useSyncExternalStore } from 'react';

function subscribe(cb: () => void): () => void {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}

/** Viewport width in CSS px; Electron's zoom already divides it by the zoom factor. */
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribe, () => window.innerWidth);
}
