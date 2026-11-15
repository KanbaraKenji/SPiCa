// The app's own colour picker (in place of the browser's input type=color, which opens the system's window): a
// swatch of the colour; pressing it opens a layer under it with a colour area (saturation across, brightness up),
// a hue bar and the colour's hex. Dragging or the arrow keys change it as you go. Closes on Esc (a layer of
// ui/escape.ts), a press elsewhere, the wheel elsewhere or resizing, as a menu does.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { normalizeHex } from '../../../shared/skin';
import { useEscape } from './escape';

export interface Hsv {
  /** 0–360 */
  h: number;
  /** 0–1 */
  s: number;
  /** 0–1 */
  v: number;
}

/** #rrggbb as hue, saturation and value. */
export function hexToHsv(hex: string): Hsv {
  const n = parseInt(hex.slice(1, 7), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: max ? d / max : 0, v: max };
}

/** Hue, saturation and value as #rrggbb (lower case, as the skins keep them). */
export function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((k) => Math.round((k + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

/** The swatch and, while it is open, its layer. `label`: the field's name (底色, 强调色), for what it is called. */
export function ColorPicker({ label, value, onChange }: { label: string; value: string; onChange(hex: string): void }) {
  // the swatch while its layer is open (the layer sits under it); null: closed
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = anchor !== null;
  return (
    <>
      <button
        type="button"
        className={open ? 'color-swatch is-open' : 'color-swatch'}
        aria-label={`${label}取色`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={value}
        onClick={(e) => {
          const b = e.currentTarget;
          setAnchor((a) => (a ? null : b));
        }}
      >
        <span className="color-swatch-fill" style={{ background: value }} />
      </button>
      {anchor ? <ColorLayer label={label} value={value} onChange={onChange} anchor={anchor} onClose={() => setAnchor(null)} /> : null}
    </>
  );
}

function ColorLayer({ label, value, onChange, anchor, onClose }: { label: string; value: string; onChange(hex: string): void; anchor: HTMLElement | null; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  // The hue is kept here: a grey (no saturation) or black has none of its own, and dragging through one keeps it.
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [draft, setDraft] = useState(value);
  const [prop, setProp] = useState(value);
  if (prop !== value) {
    // changed elsewhere (typed beside the swatch, a preset): follow it, unless it is what this layer just made
    setProp(value);
    setDraft(value);
    if (hsvToHex(hsv) !== value) setHsv(hexToHsv(value));
  }
  useEscape(true, onClose);

  const set = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setDraft(hex);
    onChange(hex);
  };

  // Under the swatch (over it when there is no room below), inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const below = a.bottom + 4;
    const top = below + r.height <= window.innerHeight - 4 ? below : a.top - 4 - r.height;
    setPos({ left: Math.max(4, Math.min(a.left, window.innerWidth - r.width - 4)), top: Math.max(4, top) });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor?.contains(t)) onClose();
    };
    const onWheel = (e: WheelEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('wheel', onWheel);
    };
  }, [onClose, anchor]);

  /** A drag on the area or the bar: where the pointer is, from the press until it is let go. */
  const drag = (at: (x: number, y: number) => void) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const move = (x: number, y: number) => at(clamp((x - r.left) / (r.width || 1)), clamp((y - r.top) / (r.height || 1)));
    move(e.clientX, e.clientY);
    el.setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => move(ev.clientX, ev.clientY);
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  };

  const areaKeys = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    set({ ...hsv, s: clamp(hsv.s + d[0]!), v: clamp(hsv.v + d[1]!) });
  };
  const hueKeys = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    set({ ...hsv, h: clamp(hsv.h + d, 0, 359) });
  };
  const commit = () => {
    const hex = normalizeHex(draft);
    if (hex && hex !== value) {
      setHsv(hexToHsv(hex));
      onChange(hex);
    } else setDraft(value);
  };

  const hex = hsvToHex(hsv);
  return (
    <div ref={ref} className="context-menu color-layer" role="dialog" aria-label={`${label}取色`} style={{ left: pos.left, top: pos.top }}>
      <div
        className="color-area"
        role="slider"
        tabIndex={0}
        aria-label={`${label}饱和度与亮度`}
        aria-valuetext={hex}
        aria-valuenow={Math.round(hsv.s * 100)}
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h}, 100%, 50%))` }}
        onPointerDown={drag((x, y) => set({ ...hsv, s: x, v: 1 - y }))}
        onKeyDown={areaKeys}
      >
        <span className="color-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }} />
      </div>
      <div
        className="color-hue"
        role="slider"
        tabIndex={0}
        aria-label={`${label}色相`}
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(hsv.h)}
        onPointerDown={drag((x) => set({ ...hsv, h: Math.min(359, x * 360) }))}
        onKeyDown={hueKeys}
      >
        <span className="color-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, top: '50%', background: `hsl(${hsv.h}, 100%, 50%)` }} />
      </div>
      <input
        className="input input-hex"
        value={draft}
        spellCheck={false}
        aria-label="色值"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </div>
  );
}
