// Did the window's page load and draw? Only told in the log, nothing else is done. Seen once: after the opening
// animation the window stayed all black while the page and GPU processes were there and nothing was logged; a
// second restart was fine. So each load of the page (at start, and after page-recovery.ts reloads it) notes when
// it started loading, finished or failed, was ready to show and was first shown. Shortly after it has finished
// and the window is on screen, the page is looked at: it is asked for two frames and whether #root has content,
// and a picture of the window is checked for being all one colour. A good load adds one line; anything else
// adds one warning with the steps that were seen.

/** After the page finished loading (and the window is shown), this long before it is looked at. */
export const SETTLE_MS = 3000;
/** No finished load this long after it started: told. */
export const LOAD_LIMIT_MS = 15_000;

export type PageStep = 'load-start' | 'finish' | 'fail' | 'ready-to-show' | 'shown';

/** What looking at the page found: each problem in a few words; none for a page that drew. */
export type Look = string[];

export interface WatchOptions {
  /** Looks at the page (see lookAtPage in index.ts). */
  look(): Promise<Look>;
  /** The window is on screen (a window started hidden is looked at once it is shown). */
  visible(): boolean;
  log(line: string): void;
  warn(line: string): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface PageWatch {
  step(step: PageStep, detail?: string): void;
}

export function watchPage(o: WatchOptions): PageWatch {
  const now = o.now ?? (() => Date.now());
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let t0 = now();
  let seen: string[] = [];
  let finished = false;
  let done = false;
  let timer: unknown = null;
  let load = 0;
  const steps = () => seen.join(', ') || 'none';
  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const lookLater = () => {
    if (done || !finished || timer !== null || !o.visible()) return;
    const mine = load;
    timer = setTimer(() => {
      timer = null;
      // Hidden again meanwhile (the notification area): looked at when it is next shown.
      if (!o.visible()) return;
      void o
        .look()
        .catch((err: unknown) => [`could not look (${err instanceof Error ? err.message : String(err)})`])
        .then((problems) => {
          if (mine !== load || done) return;
          done = true;
          if (problems.length) o.warn(`[spica] window: page not drawn (${problems.join('; ')}; steps: ${steps()})`);
          else o.log(`[spica] window: page drawn (${steps()})`);
        });
    }, SETTLE_MS);
  };
  return {
    step(step, detail) {
      if (step === 'load-start') {
        // A new load (start, reload): watched from here.
        stop();
        load++;
        t0 = now();
        seen = [];
        finished = false;
        done = false;
        const mine = load;
        timer = setTimer(() => {
          timer = null;
          if (mine !== load || finished || done) return;
          done = true;
          o.warn(`[spica] window: page not loaded ${LOAD_LIMIT_MS / 1000} s after it started (steps: ${steps()})`);
        }, LOAD_LIMIT_MS);
      }
      // Each step is noted once per load (the window is shown again and again from the notification area).
      if (!seen.some((s) => s.startsWith(step))) seen.push(`${step}${detail ? ` ${detail}` : ''} ${((now() - t0) / 1000).toFixed(1)} s`);
      if (step === 'fail') {
        stop();
        if (!done) {
          done = true;
          o.warn(`[spica] window: page failed to load (steps: ${steps()})`);
        }
      }
      if (step === 'finish') {
        finished = true;
        stop();
      }
      lookLater();
    },
  };
}

/** True when a BGRA picture is empty or every sampled pixel is the same colour (within a small difference). */
export function oneColour(bgra: Uint8Array, samples = 20_000): boolean {
  const pixels = Math.floor(bgra.length / 4);
  if (!pixels) return true;
  const stride = Math.max(1, Math.floor(pixels / samples));
  const b = bgra[0]!;
  const g = bgra[1]!;
  const r = bgra[2]!;
  for (let p = stride; p < pixels; p += stride) {
    const i = p * 4;
    if (Math.abs(bgra[i]! - b) > 6 || Math.abs(bgra[i + 1]! - g) > 6 || Math.abs(bgra[i + 2]! - r) > 6) return false;
  }
  return true;
}

/** The part of webContents that looking at the page uses. */
export interface LookTarget {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  capturePage(): Promise<{ toBitmap(): Uint8Array }>;
}

/** Two frames asked of the page, with what #root holds; a picture of the window checked for one colour. */
export async function lookAtPage(wc: LookTarget, frameLimitMs = 2000): Promise<Look> {
  const problems: Look = [];
  const frame = wc.executeJavaScript("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r((document.getElementById('root')?.childElementCount ?? 0) > 0))))", true);
  let limit: ReturnType<typeof setTimeout> | undefined;
  const answer = await Promise.race([frame, new Promise((r) => (limit = setTimeout(() => r('late'), frameLimitMs)))]).catch(() => 'error');
  clearTimeout(limit);
  if (answer === 'late') problems.push(`no frame within ${frameLimitMs / 1000} s`);
  else if (answer === 'error') problems.push('the page did not answer');
  else if (answer !== true) problems.push('#root empty');
  const picture = await wc.capturePage().then((i) => i.toBitmap()).catch(() => null);
  if (!picture) problems.push('no picture of the window');
  else if (oneColour(picture)) problems.push('window all one colour');
  return problems;
}
