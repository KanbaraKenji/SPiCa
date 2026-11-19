// A made-up desktop for 操作电脑 (driver.ts): a few windows drawn as coloured blocks, input written down instead of
// sent, Escape pressed by a test. Used by the tests, by test windows (SPICA_HIDDEN) and with the demo backend, so
// none of them ever sees the real screen or moves the real mouse.
import { encodePng, type Bitmap } from './bitmap';
import type { Driver, WindowInfo } from './driver';
import type { InputStep } from './input';

interface FakeWindow extends WindowInfo {
  /** Its colour in the picture, as 0xRRGGBB. */
  colour: number;
}

/** Programs the fake desktop knows, by exe: their name, colour and where their window opens. */
export const FAKE_PROGRAMS: Record<string, { name: string; colour: number; title: string; icon: number }> = {
  'C:\\Windows\\explorer.exe': { name: '文件资源管理器', colour: 0x2f5f8f, title: '', icon: 0xe0a526 },
  'C:\\Windows\\System32\\notepad.exe': { name: '记事本', colour: 0xf4f4f4, title: '无标题 - 记事本', icon: 0x3b82c4 },
  'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE': { name: 'Microsoft Excel', colour: 0x1d6f42, title: '采购清单.xlsx - Excel', icon: 0x1d6f42 },
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe': { name: 'Microsoft Edge', colour: 0x2b88d8, title: 'example.com - Microsoft Edge', icon: 0x2b88d8 },
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe': { name: 'Windows PowerShell', colour: 0x012456, title: 'Windows PowerShell', icon: 0x012456 },
  'C:\\Windows\\System32\\mspaint.exe': { name: '画图', colour: 0xe8e0d0, title: '无标题 - 画图', icon: 0xd9534f },
};

export const FAKE_SPICA_PID = 1;

export class FakeDriver implements Driver {
  readonly kind = 'fake' as const;
  readonly width: number;
  readonly height: number;
  /** Everything sent, in order. */
  readonly sent: InputStep[] = [];
  /** Programs started. */
  readonly launched: string[] = [];
  /** Windows that refuse to come to the front (a test of the system saying no). */
  readonly refuseFocus = new Set<number>();
  #windows: FakeWindow[] = [];
  #nextId = 100;
  #nextPid = 1000;
  #escape = new Set<() => void>();

  constructor(opts: { width?: number; height?: number; open?: string[] } = {}) {
    this.width = opts.width ?? 1920;
    this.height = opts.height ?? 1080;
    const explorer = 'C:\\Windows\\explorer.exe';
    const pid = this.#nextPid++;
    // the taskbar on top of everything, the desktop under everything: both Explorer's, as on a real screen
    this.#windows.push({ id: this.#nextId++, pid, exe: explorer, title: '', rect: { x: 0, y: this.height - 48, width: this.width, height: 48 }, elevated: false, colour: 0x202020 });
    this.#windows.push({ id: this.#nextId++, pid, exe: explorer, title: 'Program Manager', rect: { x: 0, y: 0, width: this.width, height: this.height }, elevated: false, colour: 0x3a6ea5 });
    // Spica's own window
    this.#addTop({ id: this.#nextId++, pid: FAKE_SPICA_PID, exe: 'C:\\Program Files\\Spica\\Spica.exe', title: 'Spica', rect: { x: 1200, y: 80, width: 640, height: 800 }, elevated: false, colour: 0xfafafa });
    for (const exe of opts.open ?? []) this.open(exe);
  }

  /** Opens a window of a program (as if the person had started it). */
  open(exe: string, extra: Partial<WindowInfo> = {}): WindowInfo {
    const p = FAKE_PROGRAMS[exe] ?? { name: exe, colour: 0x888888, title: exe };
    const n = this.#windows.length;
    const w: FakeWindow = {
      id: this.#nextId++,
      pid: this.#nextPid++,
      exe,
      title: p.title,
      rect: { x: 60 + n * 40, y: 40 + n * 30, width: 900, height: 620 },
      elevated: false,
      colour: p.colour,
      ...extra,
    };
    this.#addTop(w);
    return { ...w };
  }

  /** Closes a window. */
  close(id: number): void {
    this.#windows = this.#windows.filter((w) => w.id !== id);
  }

  /** The person presses Escape on the keyboard. */
  pressEscape(): void {
    for (const cb of [...this.#escape]) cb();
  }

  /** Whether anything watches Escape now. */
  watchingEscape(): boolean {
    return this.#escape.size > 0;
  }

  #addTop(w: FakeWindow): void {
    // under the taskbar (the first one), above the rest
    this.#windows.splice(1, 0, w);
  }

  screen() {
    return { width: this.width, height: this.height };
  }

  async windows(): Promise<WindowInfo[]> {
    return this.#windows.map((w) => ({ id: w.id, pid: w.pid, exe: w.exe, title: w.title, rect: { ...w.rect }, elevated: w.elevated }));
  }

  async capture(): Promise<Bitmap> {
    const data = Buffer.alloc(this.width * this.height * 4);
    for (let i = this.#windows.length - 1; i >= 0; i--) {
      const w = this.#windows[i]!;
      const bar = Math.min(32, w.rect.height);
      for (let y = Math.max(0, w.rect.y); y < Math.min(this.height, w.rect.y + w.rect.height); y++) {
        const c = y < w.rect.y + bar && w.title ? shade(w.colour) : w.colour;
        for (let x = Math.max(0, w.rect.x); x < Math.min(this.width, w.rect.x + w.rect.width); x++) {
          const o = (y * this.width + x) * 4;
          data[o] = c & 0xff;
          data[o + 1] = (c >> 8) & 0xff;
          data[o + 2] = (c >> 16) & 0xff;
          data[o + 3] = 0xff;
        }
      }
    }
    return { width: this.width, height: this.height, data };
  }

  async send(steps: readonly InputStep[]): Promise<void> {
    this.sent.push(...steps.map((s) => ({ ...s })));
  }

  async focus(windowId: number): Promise<boolean> {
    if (this.refuseFocus.has(windowId)) return false;
    const i = this.#windows.findIndex((w) => w.id === windowId);
    if (i < 0) return false;
    const [w] = this.#windows.splice(i, 1);
    this.#addTop(w!);
    return true;
  }

  async launch(exe: string): Promise<void> {
    this.launched.push(exe);
    this.open(exe);
  }

  async describe(exe: string): Promise<string> {
    return FAKE_PROGRAMS[exe]?.name ?? exe.split('\\').pop() ?? exe;
  }

  async icon(exe: string): Promise<string | undefined> {
    const p = FAKE_PROGRAMS[exe];
    return p ? fakeIcon(p.icon) : undefined;
  }

  async locate(name: string): Promise<string | undefined> {
    const n = name.trim().toLowerCase().replace(/\.exe$/, '');
    return Object.keys(FAKE_PROGRAMS).find((exe) => (exe.split('\\').pop() ?? '').toLowerCase().replace(/\.exe$/, '') === n);
  }

  ownPids(): ReadonlySet<number> {
    return new Set([FAKE_SPICA_PID]);
  }

  watchEscape(onEscape: () => void): () => void {
    this.#escape.add(onEscape);
    return () => this.#escape.delete(onEscape);
  }
}

function shade(c: number): number {
  const f = (v: number) => Math.round(v * 0.8);
  return (f((c >> 16) & 0xff) << 16) | (f((c >> 8) & 0xff) << 8) | f(c & 0xff);
}

/** A made-up program icon: a 16-pixel square of its colour (as a PNG data URL). */
export function fakeIcon(colour: number): string {
  const data = Buffer.alloc(16 * 16 * 4);
  for (let o = 0; o < data.length; o += 4) {
    data[o] = colour & 0xff;
    data[o + 1] = (colour >> 8) & 0xff;
    data[o + 2] = (colour >> 16) & 0xff;
    data[o + 3] = 0xff;
  }
  return `data:image/png;base64,${encodePng({ width: 16, height: 16, data }).toString('base64')}`;
}
