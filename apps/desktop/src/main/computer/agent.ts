// 操作电脑 in the main process: the host methods 'computer.*' the agent's tools call (backend/computer-tools.ts).
// What it decides, on plain data from the driver (driver.ts), so the tests run it on the made-up desktop:
//  - which programs a request names, and which of them need the person's approval card (prepare); what the card
//    allowed (grant: 始终允许 into the settings, 允许一次 for this conversation), checked again here, never taken
//    from the model's input;
//  - one conversation at a time (the others are told so, no queue); the bar at the top of the screen while it acts;
//    the person's Escape and the bar's 停止 stop it;
//  - every screenshot greyed where a program it may not see is on top (截图范围 E1), Spica itself always;
//  - before every click, drag, key and typed word: which program is under the point (or in front), and whether
//    its tier allows it (restricted.ts); a program running with higher rights is never sent anything.
import { crop, encodePng, fitForModel, greyOut, maskScreen, resize, type Bitmap, type Rect } from './bitmap';
import { windowAt, type Driver, type WindowInfo } from './driver';
import { clickSteps, keySteps, type Button, type InputStep } from './input';
import { allows, exeName, ruleFor, type Rule, type Tier } from '../../shared/computer-use';

/** A program the person allowed always (设置 › 始终允许的程序). */
export interface AlwaysApp {
  exe: string;
  name: string;
  icon?: string;
}

/** Where the settings keep what was allowed and what was added to 受限的程序. */
export interface GrantStore {
  always(): AlwaysApp[];
  addAlways(apps: AlwaysApp[]): void;
  denied(): string[];
}

/** A program as a request named it, worked out. */
export interface PreparedApp {
  /** What the model asked for. */
  asked: string;
  exe: string;
  name: string;
  icon?: string;
  tier: Tier;
  highRisk?: boolean;
  shared?: boolean;
  /** For a shared exe: the title of its window now, so the person sees which program it is. */
  title?: string;
  /** allowed: already (no card for it); ask: on the card; blocked: never; elevated: runs as administrator. */
  state: 'allowed' | 'ask' | 'blocked' | 'elevated';
}

/** What the bar at the top of the screen shows (null: nothing is being operated). */
export interface ComputerState {
  sessionId: string;
  /** The program in front, by name ('' before the first step). */
  app: string;
  icon?: string;
  shots: number;
  /** Estimated input tokens of the screenshots taken so far (width × height / 750, Claude's rule). */
  tokens: number;
}

/** A conversation that has not acted for this long lets go of the computer (another one may take it). */
export const IDLE_MS = 90_000;
/** The picture computer_zoom returns is at most this many pixels on its longer side. */
const ZOOM_MAX = 1024;

interface Holder {
  sessionId: string;
  at: number;
  state: ComputerState;
  stopEscape: () => void;
}

interface Shot {
  /** Model pixels per screen pixel of the last screenshot. */
  scale: number;
  width: number;
  height: number;
}

export class ComputerAgent {
  readonly #driver: Driver;
  readonly #store: GrantStore;
  readonly #onState: (s: ComputerState | null) => void;
  readonly #onStop: (sessionId: string) => void;
  readonly #now: () => number;
  /** 允许一次: exe paths (lower case) by conversation. */
  readonly #once = new Map<string, Set<string>>();
  /** What a card is about to allow, by the call's id (never what the model's input says). */
  readonly #pending = new Map<string, { sessionId: string; apps: PreparedApp[] }>();
  readonly #shots = new Map<string, Shot>();
  #holder: Holder | undefined;

  constructor(opts: { driver: Driver; store: GrantStore; onState?: (s: ComputerState | null) => void; onStop?: (sessionId: string) => void; now?: () => number }) {
    this.#driver = opts.driver;
    this.#store = opts.store;
    this.#onState = opts.onState ?? (() => undefined);
    this.#onStop = opts.onStop ?? (() => undefined);
    this.#now = opts.now ?? Date.now;
  }

  get driverKind(): 'real' | 'fake' {
    return this.#driver.kind;
  }

  /** Who is operating the computer now. */
  state(): ComputerState | null {
    this.#expire();
    return this.#holder ? { ...this.#holder.state } : null;
  }

  // ---- what is allowed ----

  #rule(w: { exe: string; pid?: number }): Rule {
    const own = w.pid !== undefined && this.#driver.ownPids().has(w.pid);
    if (!w.exe) return { tier: 'blocked' };
    return ruleFor(w.exe, { own, denied: this.#store.denied() });
  }

  #granted(sessionId: string, exe: string): boolean {
    const key = exe.toLowerCase();
    if (this.#once.get(sessionId)?.has(key)) return true;
    return this.#store.always().some((a) => a.exe.toLowerCase() === key);
  }

  /** The tier a window may be operated at in this conversation: blocked when not allowed. */
  #tierOf(sessionId: string, w: WindowInfo): Tier {
    const rule = this.#rule(w);
    if (rule.tier === 'blocked' || !this.#granted(sessionId, w.exe)) return 'blocked';
    return rule.tier;
  }

  async #resolve(name: string, windows: readonly WindowInfo[]): Promise<{ exe: string; window?: WindowInfo } | undefined> {
    const n = name.trim().toLowerCase();
    if (!n) return undefined;
    const bare = n.replace(/\.exe$/, '');
    const own = this.#driver.ownPids();
    const candidates = windows.filter((w) => w.exe && !own.has(w.pid));
    const byPath = candidates.find((w) => w.exe.toLowerCase() === n);
    if (byPath) return { exe: byPath.exe, window: byPath };
    const byExe = candidates.find((w) => exeName(w.exe).replace(/\.exe$/, '') === bare);
    if (byExe) return { exe: byExe.exe, window: byExe };
    for (const w of candidates) if ((await this.#driver.describe(w.exe)).toLowerCase() === n) return { exe: w.exe, window: w };
    const found = await this.#driver.locate(name.trim());
    return found ? { exe: found, window: candidates.find((w) => w.exe.toLowerCase() === found.toLowerCase()) } : undefined;
  }

  /**
   * computer_request_access, before the card: each program named, worked out (missing: names no program was found
   * for). The ones still to be allowed are kept under the call's id; `ask` says whether a card is needed at all.
   */
  async prepare(sessionId: string, args: Record<string, unknown>): Promise<{ apps: PreparedApp[]; missing: string[]; ask: boolean }> {
    const names = Array.isArray(args.apps) ? [...new Set(args.apps.map(String).map((s) => s.trim()).filter(Boolean))] : [];
    const windows = await this.#driver.windows();
    const apps: PreparedApp[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const asked of names.slice(0, 20)) {
      const r = await this.#resolve(asked, windows);
      if (!r) {
        missing.push(asked);
        continue;
      }
      if (seen.has(r.exe.toLowerCase())) continue;
      seen.add(r.exe.toLowerCase());
      const rule = this.#rule({ exe: r.exe, ...(r.window ? { pid: r.window.pid } : {}) });
      const state: PreparedApp['state'] = rule.tier === 'blocked' ? 'blocked' : r.window?.elevated ? 'elevated' : this.#granted(sessionId, r.exe) ? 'allowed' : 'ask';
      const icon = await this.#driver.icon(r.exe).catch(() => undefined);
      apps.push({
        asked,
        exe: r.exe,
        name: await this.#driver.describe(r.exe),
        ...(icon ? { icon } : {}),
        tier: rule.tier,
        ...(rule.highRisk ? { highRisk: true } : {}),
        ...(rule.shared ? { shared: true } : {}),
        ...(rule.shared && r.window?.title ? { title: r.window.title } : {}),
        state,
      });
    }
    const ask = apps.some((a) => a.state === 'ask');
    const callId = typeof args.callId === 'string' ? args.callId : '';
    if (ask && callId) this.#pending.set(callId, { sessionId, apps: apps.filter((a) => a.state === 'ask') });
    return { apps, missing, ask };
  }

  /**
   * The card was allowed: what prepare kept for this call, each checked again (a program that became restricted in
   * between is left out). always: into 始终允许的程序, except programs that share one exe (this conversation only).
   */
  grant(sessionId: string, args: Record<string, unknown>): { granted: PreparedApp[]; always: boolean } {
    const callId = typeof args.callId === 'string' ? args.callId : '';
    const p = this.#pending.get(callId);
    if (!p || p.sessionId !== sessionId) throw new Error('this approval is no longer known (Spica was restarted); call computer_request_access again');
    this.#pending.delete(callId);
    const always = args.always === true;
    const granted = p.apps.filter((a) => this.#rule({ exe: a.exe }).tier !== 'blocked');
    const once = this.#once.get(sessionId) ?? new Set<string>();
    const forever: AlwaysApp[] = [];
    for (const a of granted) {
      if (always && !a.shared) forever.push({ exe: a.exe, name: a.name, ...(a.icon ? { icon: a.icon } : {}) });
      else once.add(a.exe.toLowerCase());
    }
    this.#once.set(sessionId, once);
    if (forever.length) this.#store.addAlways(forever);
    return { granted, always };
  }

  /** The card was declined: nothing kept. */
  forget(args: Record<string, unknown>): void {
    if (typeof args.callId === 'string') this.#pending.delete(args.callId);
  }

  /** computer_list_apps: programs with a window now, each with what this conversation may do with it. */
  async listApps(sessionId: string): Promise<{ text: string }> {
    const windows = await this.#driver.windows();
    const own = this.#driver.ownPids();
    const byExe = new Map<string, WindowInfo[]>();
    for (const w of windows) if (w.exe && !own.has(w.pid)) byExe.set(w.exe, [...(byExe.get(w.exe) ?? []), w]);
    const lines: string[] = [];
    for (const [exe, ws] of byExe) {
      const rule = this.#rule({ exe, pid: ws[0]!.pid });
      const state = rule.tier === 'blocked' ? 'not allowed' : ws.some((w) => w.elevated) ? 'runs as administrator: cannot be operated' : this.#granted(sessionId, exe) ? TIER_WORDS[rule.tier] : 'not approved yet (computer_request_access)';
      const titles = ws.map((w) => w.title).filter(Boolean);
      lines.push(`- ${await this.#driver.describe(exe)} (${exe}): ${state}${titles.length ? ` — windows: ${titles.map((t) => `"${t}"`).join(', ')}` : ''}`);
    }
    return { text: lines.length ? `Programs with a window now:\n${lines.join('\n')}` : 'No program has a window now.' };
  }

  // ---- one conversation at a time ----

  #expire(): void {
    const h = this.#holder;
    if (h && this.#now() - h.at > IDLE_MS) this.release(h.sessionId);
  }

  #take(sessionId: string): Holder {
    this.#expire();
    const h = this.#holder;
    if (h && h.sessionId !== sessionId) throw new Error('another conversation is operating the computer now; try again when it has finished, or tell the user');
    if (h) {
      h.at = this.#now();
      return h;
    }
    const holder: Holder = {
      sessionId,
      at: this.#now(),
      state: { sessionId, app: '', shots: 0, tokens: 0 },
      stopEscape: () => undefined,
    };
    holder.stopEscape = this.#driver.watchEscape(() => this.stop(sessionId));
    this.#holder = holder;
    this.#publish();
    return holder;
  }

  #publish(): void {
    this.#onState(this.#holder ? { ...this.#holder.state } : null);
  }

  /** Lets go of the computer (the run ended, was stopped, or the conversation was idle): the bar goes. */
  release(sessionId: string): void {
    const h = this.#holder;
    if (!h || h.sessionId !== sessionId) return;
    h.stopEscape();
    this.#holder = undefined;
    this.#shots.delete(sessionId);
    this.#publish();
  }

  /** 停止 on the bar, or the person's Escape: the run is stopped and the computer let go. */
  stop(sessionId?: string): void {
    const id = sessionId ?? this.#holder?.sessionId;
    if (!id || this.#holder?.sessionId !== id) return;
    this.release(id);
    this.#onStop(id);
  }

  /** The conversation was deleted: what it was allowed once goes too. */
  forgetSession(sessionId: string): void {
    this.release(sessionId);
    this.#once.delete(sessionId);
  }

  // ---- seeing ----

  /** The screen as the model may see it: greyed where it may not, Spica's own windows always. */
  async #picture(sessionId: string): Promise<{ bitmap: Bitmap; windows: WindowInfo[] }> {
    const windows = await this.#driver.windows();
    const raw = await this.#driver.capture();
    const own = this.#driver.ownPids();
    const masked = maskScreen(
      raw,
      windows.map((w) => ({ rect: w.rect, visible: !own.has(w.pid) && this.#tierOf(sessionId, w) !== 'blocked' })),
    );
    // Spica's windows are left out of the capture by the system; in case they are there after all
    const bitmap = greyOut(masked, windows.filter((w) => own.has(w.pid)).map((w) => w.rect));
    return { bitmap, windows };
  }

  #note(h: Holder, width: number, height: number, front?: WindowInfo): void {
    h.state.shots += 1;
    h.state.tokens += Math.round((width * height) / 750);
    if (front) void this.#front(h, front);
    this.#publish();
  }

  async #front(h: Holder, w: WindowInfo): Promise<void> {
    const name = await this.#driver.describe(w.exe);
    const icon = await this.#driver.icon(w.exe).catch(() => undefined);
    if (h.state.app === name) return;
    h.state.app = name;
    if (icon) h.state.icon = icon;
    else delete h.state.icon;
    this.#publish();
  }

  /** computer_screenshot: the picture (PNG, base64) at the model's size, and the size. */
  async screenshot(sessionId: string): Promise<{ png: string; width: number; height: number; text: string }> {
    const h = this.#take(sessionId);
    const { bitmap, windows } = await this.#picture(sessionId);
    const fit = fitForModel(bitmap.width, bitmap.height);
    const small = resize(bitmap, fit.width, fit.height);
    this.#shots.set(sessionId, { scale: fit.scale, width: fit.width, height: fit.height });
    const front = this.#frontWindow(windows, sessionId);
    this.#note(h, fit.width, fit.height, front);
    const seen = [...new Set(windows.filter((w) => this.#tierOf(sessionId, w) !== 'blocked').map((w) => w.exe))];
    const names = await Promise.all(seen.map((e) => this.#driver.describe(e)));
    return {
      png: encodePng(small).toString('base64'),
      width: fit.width,
      height: fit.height,
      text:
        `Screenshot of the screen, ${fit.width}×${fit.height}; coordinates for the other computer tools are in this picture's pixels. ` +
        `Grey areas are programs this conversation may not see.${names.length ? ` Visible: ${names.join(', ')}.` : ' No approved program is visible.'}`,
    };
  }

  /** computer_zoom: a part of the last screenshot's area ([x0, y0, x1, y1] in its pixels), larger. */
  async zoom(sessionId: string, args: Record<string, unknown>): Promise<{ png: string; width: number; height: number; text: string }> {
    const h = this.#take(sessionId);
    const shot = this.#needShot(sessionId);
    const region = Array.isArray(args.region) ? args.region.map(Number) : [];
    if (region.length !== 4 || region.some((v) => !Number.isFinite(v))) throw new Error('region must be [x0, y0, x1, y1]');
    const [x0, y0, x1, y1] = region as [number, number, number, number];
    if (x1 <= x0 || y1 <= y0) throw new Error('region must have x1 > x0 and y1 > y0');
    const { bitmap } = await this.#picture(sessionId);
    const r: Rect = { x: x0 / shot.scale, y: y0 / shot.scale, width: (x1 - x0) / shot.scale, height: (y1 - y0) / shot.scale };
    const part = crop(bitmap, r);
    if (!part.width || !part.height) throw new Error('region is outside the screen');
    // larger up to 4 times, at most ZOOM_MAX on the longer side (within what the model takes)
    const k = Math.min(4, ZOOM_MAX / Math.max(part.width, part.height));
    const out = resize(part, Math.max(1, Math.round(part.width * k)), Math.max(1, Math.round(part.height * k)));
    this.#note(h, out.width, out.height);
    return { png: encodePng(out).toString('base64'), width: out.width, height: out.height, text: `Zoomed view of [${x0}, ${y0}, ${x1}, ${y1}] of the last screenshot, ${out.width}×${out.height}. Coordinates for clicks stay those of the screenshot.` };
  }

  #needShot(sessionId: string): Shot {
    const s = this.#shots.get(sessionId);
    if (!s) throw new Error('take a screenshot first (computer_screenshot): coordinates are in its pixels');
    return s;
  }

  #frontWindow(windows: readonly WindowInfo[], sessionId: string): WindowInfo | undefined {
    void sessionId;
    // windows that stay on top (the taskbar, Spica's bar) are not the program in front: the first window that is
    // neither Explorer's taskbar nor Spica's own
    const own = this.#driver.ownPids();
    return windows.find((w) => !own.has(w.pid) && !(exeName(w.exe) === 'explorer.exe' && !w.title));
  }

  // ---- acting ----

  #toScreen(shot: Shot, x: unknown, y: unknown): { x: number; y: number } {
    const mx = Number(x);
    const my = Number(y);
    if (!Number.isFinite(mx) || !Number.isFinite(my)) throw new Error('coordinate must be [x, y]');
    if (mx < 0 || my < 0 || mx >= shot.width || my >= shot.height) throw new Error(`coordinate [${mx}, ${my}] is outside the screenshot (${shot.width}×${shot.height})`);
    return { x: Math.min(this.#driver.screen().width - 1, Math.round(mx / shot.scale)), y: Math.min(this.#driver.screen().height - 1, Math.round(my / shot.scale)) };
  }

  /** Whether a window may take this kind of input here; the reason when not. */
  async #check(sessionId: string, w: WindowInfo | undefined, what: 'click' | 'type'): Promise<string | undefined> {
    if (!w) return 'there is no window there';
    const name = w.exe ? await this.#driver.describe(w.exe) : 'an unknown program';
    if (this.#driver.ownPids().has(w.pid)) return 'that is Spica itself, which is never operated';
    if (w.elevated) return `${name} runs as administrator; Windows does not let Spica send it input`;
    const rule = this.#rule(w);
    if (rule.tier === 'blocked') return `${name} is a restricted program`;
    if (!this.#granted(sessionId, w.exe)) return `${name} is not approved for this conversation (computer_request_access)`;
    if (!allows(rule.tier, what)) return `${name} is ${TIER_WORDS[rule.tier]}`;
    return undefined;
  }

  /** The point's window, checked; then the steps sent. */
  async #at(sessionId: string, point: { x: number; y: number }, what: 'click' | 'type', steps: InputStep[]): Promise<WindowInfo> {
    const windows = await this.#driver.windows();
    const w = windowAt(windows, point.x, point.y);
    const why = await this.#check(sessionId, w, what);
    if (why) throw new Error(`nothing was done: at that point ${why}`);
    await this.#driver.send(steps);
    return w!;
  }

  /** computer_left_click and the other clicks; computer_mouse_move (count 0). */
  async click(sessionId: string, args: Record<string, unknown>): Promise<{ text: string }> {
    const h = this.#take(sessionId);
    const shot = this.#needShot(sessionId);
    const c = Array.isArray(args.coordinate) ? args.coordinate : [];
    const p = this.#toScreen(shot, c[0], c[1]);
    const button = (['left', 'right', 'middle'].includes(String(args.button)) ? args.button : 'left') as Button;
    const count = Math.max(0, Math.min(3, Number(args.count ?? 1)));
    const steps = count === 0 ? { steps: [{ kind: 'move' as const, ...p }] } : clickSteps(p.x, p.y, button, count, typeof args.text === 'string' ? args.text : undefined);
    if ('error' in steps) throw new Error(steps.error);
    const w = await this.#at(sessionId, p, 'click', steps.steps);
    await this.#front(h, w);
    const name = await this.#driver.describe(w.exe);
    const what = count === 0 ? 'Moved the pointer' : `${['', '', 'Double-', 'Triple-'][count] ?? ''}${count > 1 ? 'clicked' : button === 'left' ? 'Clicked' : `${button[0]!.toUpperCase()}${button.slice(1)}-clicked`}`;
    return { text: `${what} at [${String(c[0])}, ${String(c[1])}] in ${name}.` };
  }

  /** computer_left_click_drag: both ends are checked. */
  async drag(sessionId: string, args: Record<string, unknown>): Promise<{ text: string }> {
    this.#take(sessionId);
    const shot = this.#needShot(sessionId);
    const a = Array.isArray(args.start_coordinate) ? args.start_coordinate : [];
    const b = Array.isArray(args.coordinate) ? args.coordinate : [];
    const from = this.#toScreen(shot, a[0], a[1]);
    const to = this.#toScreen(shot, b[0], b[1]);
    const windows = await this.#driver.windows();
    for (const p of [from, to]) {
      const why = await this.#check(sessionId, windowAt(windows, p.x, p.y), 'click');
      if (why) throw new Error(`nothing was done: at [${p === from ? a.join(', ') : b.join(', ')}] ${why}`);
    }
    await this.#driver.send([{ kind: 'move', ...from }, { kind: 'button', button: 'left', down: true }, { kind: 'move', ...to }, { kind: 'button', button: 'left', down: false }]);
    return { text: `Dragged from [${a.join(', ')}] to [${b.join(', ')}].` };
  }

  /** computer_scroll. */
  async scroll(sessionId: string, args: Record<string, unknown>): Promise<{ text: string }> {
    this.#take(sessionId);
    const shot = this.#needShot(sessionId);
    const c = Array.isArray(args.coordinate) ? args.coordinate : [];
    const p = this.#toScreen(shot, c[0], c[1]);
    const dir = String(args.scroll_direction ?? 'down');
    if (!['up', 'down', 'left', 'right'].includes(dir)) throw new Error('scroll_direction must be up, down, left or right');
    const n = Math.max(1, Math.min(20, Math.floor(Number(args.scroll_amount ?? 3)) || 3));
    const wheel = { kind: 'wheel' as const, dx: dir === 'right' ? n : dir === 'left' ? -n : 0, dy: dir === 'down' ? n : dir === 'up' ? -n : 0 };
    const w = await this.#at(sessionId, p, 'click', [{ kind: 'move', ...p }, wheel]);
    return { text: `Scrolled ${dir} ${n} in ${await this.#driver.describe(w.exe)}.` };
  }

  /** The program typing and keys go to: the one in front, checked. */
  async #typeTarget(sessionId: string): Promise<WindowInfo> {
    const windows = await this.#driver.windows();
    const id = await this.#driver.foreground();
    const w = id === undefined ? this.#frontWindow(windows, sessionId) : windows.find((x) => x.id === id);
    const why = await this.#check(sessionId, w, 'type');
    if (why) throw new Error(`nothing was done: the program in front: ${why}`);
    return w!;
  }

  /** computer_type: text as characters, to the program in front. */
  async type(sessionId: string, args: Record<string, unknown>): Promise<{ text: string }> {
    this.#take(sessionId);
    const text = typeof args.text === 'string' ? args.text : '';
    if (!text) throw new Error('text is empty');
    const w = await this.#typeTarget(sessionId);
    await this.#driver.send([{ kind: 'text', text }]);
    return { text: `Typed ${text.length} characters into ${await this.#driver.describe(w.exe)}.` };
  }

  /** computer_key: a key or combination, `repeat` times, to the program in front. */
  async key(sessionId: string, args: Record<string, unknown>): Promise<{ text: string }> {
    this.#take(sessionId);
    const combo = typeof args.text === 'string' ? args.text : '';
    const steps = keySteps(combo, Number(args.repeat ?? 1));
    if ('error' in steps) throw new Error(steps.error);
    const w = await this.#typeTarget(sessionId);
    await this.#driver.send(steps.steps);
    return { text: `Pressed ${combo} in ${await this.#driver.describe(w.exe)}.` };
  }

  /** computer_open_application: an approved program to the front, started when it is not running. */
  async open(sessionId: string, args: Record<string, unknown>): Promise<{ text: string }> {
    const h = this.#take(sessionId);
    const asked = typeof args.app === 'string' ? args.app : '';
    const windows = await this.#driver.windows();
    const r = await this.#resolve(asked, windows);
    if (!r) throw new Error(`no program found for "${asked}"`);
    const name = await this.#driver.describe(r.exe);
    const rule = this.#rule({ exe: r.exe, ...(r.window ? { pid: r.window.pid } : {}) });
    if (rule.tier === 'blocked') throw new Error(`${name} is a restricted program`);
    if (!this.#granted(sessionId, r.exe)) throw new Error(`${name} is not approved for this conversation; call computer_request_access first`);
    if (r.window?.elevated) throw new Error(`${name} runs as administrator; Windows does not let Spica operate it`);
    if (r.window) {
      const ok = await this.#driver.focus(r.window.id);
      if (!ok) throw new Error(`Windows did not let ${name} come to the front; ask the user to click it once`);
      await this.#front(h, r.window);
      return { text: `${name} is in front.` };
    }
    await this.#driver.launch(r.exe);
    h.state.app = name;
    this.#publish();
    return { text: `Started ${name}. Take a screenshot to see it (it may take a moment to open).` };
  }
}

const TIER_WORDS: Record<Tier, string> = {
  blocked: 'not allowed',
  view: 'view only (screenshots; no clicks or typing)',
  click: 'click only (screenshots and clicks; no typing or keys)',
  full: 'allowed',
};
