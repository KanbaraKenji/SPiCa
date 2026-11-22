// What the agent's clicks, keys and typing become (操作电脑): a list of plain input steps the driver sends one after
// another (driver-win32.ts turns them into SendInput calls; the fake driver only writes them down).
// Keys are named as in Claude's computer-use tools (xdotool's names): "Return", "ctrl+s", "alt+Tab", "F5".

export type Button = 'left' | 'right' | 'middle';

export type InputStep =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'button'; button: Button; down: boolean }
  /** Wheel notches: dy > 0 down, dx > 0 right. */
  | { kind: 'wheel'; dx: number; dy: number }
  /** A key by its Windows virtual-key code. */
  | { kind: 'key'; vk: number; down: boolean }
  /** Text typed as characters (not keys): the keyboard layout plays no part. */
  | { kind: 'text'; text: string };

/** Windows virtual-key codes by name (lower case; several names for one key). */
const VK: Record<string, number> = {
  backspace: 0x08,
  tab: 0x09,
  return: 0x0d,
  enter: 0x0d,
  kp_enter: 0x0d,
  shift: 0x10,
  shift_l: 0x10,
  shift_r: 0x10,
  ctrl: 0x11,
  control: 0x11,
  control_l: 0x11,
  control_r: 0x11,
  alt: 0x12,
  alt_l: 0x12,
  alt_r: 0x12,
  pause: 0x13,
  caps_lock: 0x14,
  capslock: 0x14,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  page_up: 0x21,
  prior: 0x21,
  pageup: 0x21,
  page_down: 0x22,
  next: 0x22,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  print: 0x2c,
  insert: 0x2d,
  delete: 0x2e,
  del: 0x2e,
  super: 0x5b,
  super_l: 0x5b,
  win: 0x5b,
  meta: 0x5b,
  cmd: 0x5b,
  menu: 0x5d,
  multiply: 0x6a,
  add: 0x6b,
  subtract: 0x6d,
  decimal: 0x6e,
  divide: 0x6f,
  num_lock: 0x90,
  scroll_lock: 0x91,
  minus: 0xbd,
  plus: 0xbb,
  equal: 0xbb,
  comma: 0xbc,
  period: 0xbe,
  slash: 0xbf,
  semicolon: 0xba,
  apostrophe: 0xde,
  bracketleft: 0xdb,
  bracketright: 0xdd,
  backslash: 0xdc,
  grave: 0xc0,
};

/** Keys that are held while the last one is pressed. */
const MODIFIERS = new Set([0x10, 0x11, 0x12, 0x5b]);

/** One key's code: a name above, a single letter or digit, F1–F24; undefined when unknown. */
export function keyCode(name: string): number | undefined {
  const k = name.trim().toLowerCase();
  if (VK[k] !== undefined) return VK[k];
  if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  const f = /^f([1-9]|1\d|2[0-4])$/.exec(k);
  if (f) return 0x6f + Number(f[1]);
  const kp = /^kp_([0-9])$/.exec(k);
  if (kp) return 0x60 + Number(kp[1]);
  const single: Record<string, number> = { '-': 0xbd, '=': 0xbb, ',': 0xbc, '.': 0xbe, '/': 0xbf, ';': 0xba, "'": 0xde, '[': 0xdb, ']': 0xdd, '\\': 0xdc, '`': 0xc0 };
  return single[k];
}

/**
 * A key or combination ("ctrl+shift+s") pressed `repeat` times: the keys down in order, then up the other way
 * round. An error naming the key that is not known.
 */
export function keySteps(combo: string, repeat = 1): { steps: InputStep[] } | { error: string } {
  const parts = combo.split('+').map((p) => p.trim());
  // "ctrl++" is ctrl and plus
  const names = parts.flatMap((p, i) => (p === '' && i === parts.length - 1 && parts.length > 1 ? ['plus'] : p === '' ? [] : [p]));
  if (!names.length) return { error: 'no key given' };
  const codes: number[] = [];
  for (const n of names) {
    const c = keyCode(n);
    if (c === undefined) return { error: `unknown key "${n}"` };
    codes.push(c);
  }
  const steps: InputStep[] = [];
  const times = Math.max(1, Math.min(100, Math.floor(repeat) || 1));
  for (let i = 0; i < times; i++) {
    for (const vk of codes) steps.push({ kind: 'key', vk, down: true });
    for (const vk of [...codes].reverse()) steps.push({ kind: 'key', vk, down: false });
  }
  return { steps };
}

/** Whether a key code is a modifier (held for a click: "ctrl" + click). */
export function isModifier(vk: number): boolean {
  return MODIFIERS.has(vk);
}

/** Whether a combination is the Escape key alone (the agent's own Escape never counts as the person's 停止). */
export function isEscape(vk: number): boolean {
  return vk === 0x1b;
}

/** Clicks at a point: `count` 1–3, holding the modifier keys named in `modifiers` ("ctrl", "shift+alt"). */
export function clickSteps(x: number, y: number, button: Button, count: number, modifiers?: string): { steps: InputStep[] } | { error: string } {
  const mods: number[] = [];
  if (modifiers?.trim()) {
    for (const n of modifiers.split('+')) {
      const c = keyCode(n);
      if (c === undefined || !isModifier(c)) return { error: `"${n}" is not a modifier key (shift, ctrl, alt, super)` };
      mods.push(c);
    }
  }
  const steps: InputStep[] = [{ kind: 'move', x, y }];
  for (const vk of mods) steps.push({ kind: 'key', vk, down: true });
  for (let i = 0; i < count; i++) steps.push({ kind: 'button', button, down: true }, { kind: 'button', button, down: false });
  for (const vk of [...mods].reverse()) steps.push({ kind: 'key', vk, down: false });
  return { steps };
}
