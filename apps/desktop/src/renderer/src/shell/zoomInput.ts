// Whole-window zoom from the page: Ctrl+wheel and Ctrl+= / Ctrl+- / Ctrl+0.
// The page swallows these so Chromium does not zoom on its own, and asks the
// main process for one step; main keeps the level and saves it.
export type ZoomStep = 'in' | 'out' | 'reset';

/** Wheel distance that counts as one step (a mouse notch is 100-120; trackpads send small deltas). */
const WHEEL_STEP = 60;

export function zoomKey(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'key' | 'code'>): ZoomStep | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === '0' || e.code === 'Numpad0') return 'reset';
  if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') return 'in';
  if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') return 'out';
  return null;
}

export function installZoomInput(zoom: (step: ZoomStep) => void, target: Window = window): () => void {
  let acc = 0;
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    acc += e.deltaY;
    // One step per notch, even when a fast wheel reports a big delta at once.
    if (Math.abs(acc) >= WHEEL_STEP) {
      zoom(acc < 0 ? 'in' : 'out');
      acc = 0;
    }
  };
  const onKey = (e: KeyboardEvent) => {
    const step = zoomKey(e);
    if (!step) return;
    e.preventDefault();
    zoom(step);
  };
  target.addEventListener('wheel', onWheel, { passive: false });
  target.addEventListener('keydown', onKey);
  return () => {
    target.removeEventListener('wheel', onWheel);
    target.removeEventListener('keydown', onKey);
  };
}
