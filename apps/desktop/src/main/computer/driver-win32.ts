// The real driver for 操作电脑 on Windows (driver.ts): windows and their programs through user32 / kernel32, the
// picture through Electron's desktopCapturer, input through SendInput, the person's Escape through a low-level
// keyboard hook in a small process of its own (escape-watch.ts). Only made when driverKind() says real: never in
// the tests or a test window. Not yet run on a real machine.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { app, desktopCapturer, screen, utilityProcess } from 'electron';
import type { Bitmap } from './bitmap';
import type { Driver, WindowInfo } from './driver';
import type { InputStep } from './input';
import { win32, type Win32 } from './win32';

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x0008;
const TokenElevation = 20;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const SW_RESTORE = 9;
const GA_ROOT = 2;
// predefined keys are sign-extended 32-bit values: (HKEY)(LONG)0x80000001
const HKCU = -0x7fffffff;
const HKLM = -0x7ffffffe;
const RRF_RT_REG_SZ = 0x2;
const RRF_RT_REG_EXPAND_SZ = 0x4;

/** One INPUT for SendInput (x64: 40 bytes; the union starts at 8). */
const INPUT_SIZE = 40;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSE = { leftdown: 0x2, leftup: 0x4, rightdown: 0x8, rightup: 0x10, middledown: 0x20, middleup: 0x40, wheel: 0x800, hwheel: 0x1000 };
const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;
const KEYEVENTF_UNICODE = 0x4;
/** Keys sent with the extended flag (arrows, Insert, Delete, Home, End, Page Up/Down, Windows, menu, divide). */
const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5d, 0x6f]);
const WHEEL_DELTA = 120;

function mouseInput(flags: number, data = 0): Buffer {
  const b = Buffer.alloc(INPUT_SIZE);
  b.writeUInt32LE(INPUT_MOUSE, 0);
  b.writeInt32LE(data, 16);
  b.writeUInt32LE(flags, 20);
  return b;
}

function keyInput(vk: number, scan: number, flags: number): Buffer {
  const b = Buffer.alloc(INPUT_SIZE);
  b.writeUInt32LE(INPUT_KEYBOARD, 0);
  b.writeUInt16LE(vk, 8);
  b.writeUInt16LE(scan, 10);
  b.writeUInt32LE(flags, 12);
  return b;
}

/** The SendInput records for steps other than a move (a move is SetCursorPos, in screen pixels). */
export function inputRecords(step: InputStep): Buffer[] {
  switch (step.kind) {
    case 'button':
      return [mouseInput(MOUSE[`${step.button}${step.down ? 'down' : 'up'}`])];
    case 'wheel':
      return [...(step.dy ? [mouseInput(MOUSE.wheel, -step.dy * WHEEL_DELTA)] : []), ...(step.dx ? [mouseInput(MOUSE.hwheel, step.dx * WHEEL_DELTA)] : [])];
    case 'key':
      return [keyInput(step.vk, 0, (step.down ? 0 : KEYEVENTF_KEYUP) | (EXTENDED.has(step.vk) ? KEYEVENTF_EXTENDEDKEY : 0))];
    case 'text': {
      const out: Buffer[] = [];
      for (let i = 0; i < step.text.length; i++) {
        const unit = step.text.charCodeAt(i);
        // a line break as the Enter key: programs take a typed CR as a new line inconsistently
        if (unit === 0x0a) {
          out.push(keyInput(0x0d, 0, 0), keyInput(0x0d, 0, KEYEVENTF_KEYUP));
          continue;
        }
        if (unit === 0x0d) continue;
        out.push(keyInput(0, unit, KEYEVENTF_UNICODE), keyInput(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
      }
      return out;
    }
    default:
      return [];
  }
}

export class Win32Driver implements Driver {
  readonly kind = 'real' as const;
  readonly #api: Win32;
  readonly #names = new Map<string, string>();
  readonly #selfElevated: boolean;

  private constructor(api: Win32) {
    this.#api = api;
    this.#selfElevated = this.#elevated(process.pid) === true;
  }

  static async create(): Promise<Win32Driver> {
    return new Win32Driver(await win32());
  }

  screen() {
    const d = screen.getPrimaryDisplay();
    return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  }

  #elevated(pid: number): boolean | undefined {
    const a = this.#api;
    const h = a.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!h) return undefined;
    try {
      const tok: number[] = [0];
      if (!a.OpenProcessToken(h, TOKEN_QUERY, tok)) return undefined;
      try {
        const buf = Buffer.alloc(4);
        const len: number[] = [0];
        if (!a.GetTokenInformation(tok[0]!, TokenElevation, buf, 4, len)) return undefined;
        return buf.readUInt32LE(0) !== 0;
      } finally {
        a.CloseHandle(tok[0]!);
      }
    } finally {
      a.CloseHandle(h);
    }
  }

  #exe(pid: number): string {
    const a = this.#api;
    const h = a.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!h) return '';
    try {
      const buf = Buffer.alloc(2 * 1024);
      const size: number[] = [1024];
      if (!a.QueryFullProcessImageNameW(h, 0, buf, size)) return '';
      return buf.toString('utf16le', 0, size[0]! * 2);
    } finally {
      a.CloseHandle(h);
    }
  }

  async windows(): Promise<WindowInfo[]> {
    const a = this.#api;
    const handles: number[] = [];
    // EnumWindows lists top-level windows from the top of the order down
    a.EnumWindows((hwnd: number) => {
      handles.push(Number(hwnd));
      return true;
    }, 0);
    const out: WindowInfo[] = [];
    for (const hwnd of handles) {
      if (!a.IsWindowVisible(hwnd) || a.IsIconic(hwnd)) continue;
      const cloaked = Buffer.alloc(4);
      if (a.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked.readUInt32LE(0) !== 0) continue;
      const r = Buffer.alloc(16);
      let rect: { left: number; top: number; right: number; bottom: number };
      if (a.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) === 0) rect = { left: r.readInt32LE(0), top: r.readInt32LE(4), right: r.readInt32LE(8), bottom: r.readInt32LE(12) };
      else {
        const o = { left: 0, top: 0, right: 0, bottom: 0 };
        if (!a.GetWindowRect(hwnd, o)) continue;
        rect = o;
      }
      if (rect.right <= rect.left || rect.bottom <= rect.top) continue;
      const pidOut: number[] = [0];
      a.GetWindowThreadProcessId(hwnd, pidOut);
      const pid = pidOut[0]!;
      const title = Buffer.alloc(2 * 512);
      const n = a.GetWindowTextW(hwnd, title, 512);
      const elevated = this.#elevated(pid);
      out.push({
        id: hwnd,
        pid,
        exe: this.#exe(pid),
        title: title.toString('utf16le', 0, Math.max(0, n) * 2),
        rect: { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top },
        // a process whose rights cannot be read counts as above Spica (nothing is sent to it)
        elevated: elevated === undefined ? true : elevated && !this.#selfElevated,
      });
    }
    return out;
  }

  async capture(): Promise<Bitmap> {
    const d = screen.getPrimaryDisplay();
    const size = this.screen();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
    if (!src) throw new Error('the screen could not be captured');
    const img = src.thumbnail.getSize().width === size.width ? src.thumbnail : src.thumbnail.resize({ width: size.width, height: size.height });
    const s = img.getSize();
    return { width: s.width, height: s.height, data: img.toBitmap() };
  }

  async send(steps: readonly InputStep[]): Promise<void> {
    const a = this.#api;
    for (const step of steps) {
      if (step.kind === 'move') {
        a.SetCursorPos(step.x, step.y);
        continue;
      }
      const records = inputRecords(step);
      if (!records.length) continue;
      const sent = a.SendInput(records.length, Buffer.concat(records), INPUT_SIZE);
      if (sent !== records.length) throw new Error('Windows did not take the input (another program may be holding it)');
    }
  }

  async focus(windowId: number): Promise<boolean> {
    const a = this.#api;
    const root = a.GetAncestor(windowId, GA_ROOT) || windowId;
    if (a.IsIconic(root)) a.ShowWindow(root, SW_RESTORE);
    a.SetForegroundWindow(root);
    return Number(a.GetForegroundWindow()) === Number(root);
  }

  async launch(exe: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }

  async describe(exe: string): Promise<string> {
    const known = this.#names.get(exe.toLowerCase());
    if (known) return known;
    const name = this.#description(exe) || (exe.split('\\').pop() ?? exe);
    this.#names.set(exe.toLowerCase(), name);
    return name;
  }

  #description(exe: string): string {
    const a = this.#api;
    const k = a.koffi;
    try {
      const size = a.GetFileVersionInfoSizeW(exe, null);
      if (!size) return '';
      const data = Buffer.alloc(size);
      if (!a.GetFileVersionInfoW(exe, 0, size, data)) return '';
      const p: unknown[] = [null];
      const len: number[] = [0];
      if (!a.VerQueryValueW(data, '\\VarFileInfo\\Translation', p, len) || !p[0] || len[0]! < 4) return '';
      const [lang, cp] = k.decode(p[0], 'uint16_t', 2) as number[];
      const key = `\\StringFileInfo\\${lang!.toString(16).padStart(4, '0')}${cp!.toString(16).padStart(4, '0')}\\FileDescription`;
      if (!a.VerQueryValueW(data, key, p, len) || !p[0]) return '';
      return String(k.decode(p[0], 'str16')).trim();
    } catch {
      return '';
    }
  }

  async icon(exe: string): Promise<string | undefined> {
    try {
      const img = await app.getFileIcon(exe, { size: 'small' });
      return img.isEmpty() ? undefined : img.toDataURL();
    } catch {
      return undefined;
    }
  }

  async locate(name: string): Promise<string | undefined> {
    const n = name.trim();
    if (isAbsolute(n)) return existsSync(n) && /\.exe$/i.test(n) ? n : undefined;
    if (/[\\/]/.test(n)) return undefined;
    const file = /\.exe$/i.test(n) ? n : `${n}.exe`;
    // App Paths: where installers register their programs by exe name
    for (const root of [HKCU, HKLM]) {
      const buf = Buffer.alloc(2 * 1024);
      const size: number[] = [buf.length];
      if (this.#api.RegGetValueW(root, `Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${file}`, null as unknown as string, RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ, null, buf, size) === 0) {
        const p = buf.toString('utf16le', 0, size[0]!).replace(/\0.*$/s, '').replace(/^"|"$/g, '');
        if (p && existsSync(p)) return p;
      }
    }
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir) continue;
      const p = join(dir, file);
      if (existsSync(p)) return p;
    }
    return undefined;
  }

  ownPids(): ReadonlySet<number> {
    return new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)]);
  }

  watchEscape(onEscape: () => void): () => void {
    // the hook runs in its own small process: a hook that answers late is taken away by Windows without a word,
    // and Spica's main process is sometimes busy (escape-watch.ts reinstalls it from time to time as well)
    const child = utilityProcess.fork(join(__dirname, 'escape-watch.js'), [], { serviceName: 'Spica Escape watch', stdio: 'ignore' });
    child.on('message', (m: unknown) => {
      if (m === 'escape') onEscape();
    });
    return () => {
      child.kill();
    };
  }
}
