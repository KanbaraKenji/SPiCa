import { describe, expect, it } from 'vitest';
import { LOAD_LIMIT_MS, lookAtPage, oneColour, SETTLE_MS, watchPage, type Look } from './page-watch';

function setup(look: Look | (() => Promise<Look>) = [], visible = true) {
  let t = 0;
  let shown = visible;
  const timers: { at: number; fn: () => void; h: number }[] = [];
  let id = 0;
  const lines: string[] = [];
  let looks = 0;
  const w = watchPage({
    look: () => {
      looks++;
      return typeof look === 'function' ? look() : Promise.resolve(look);
    },
    visible: () => shown,
    log: (l) => lines.push(l),
    warn: (l) => lines.push(`WARN ${l}`),
    now: () => t,
    setTimer: (fn, ms) => {
      timers.push({ at: t + ms, fn, h: ++id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.h === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = async (ms: number) => {
    t += ms;
    for (const due of timers.filter((x) => x.at <= t)) {
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  return { w, lines, advance, looks: () => looks, show: (v: boolean) => (shown = v) };
}

describe('watching the page load', () => {
  it('a good start adds one line with the steps', async () => {
    const r = setup();
    r.w.step('load-start');
    await r.advance(800);
    r.w.step('ready-to-show');
    r.w.step('shown');
    await r.advance(400);
    r.w.step('finish');
    await r.advance(SETTLE_MS);
    expect(r.lines).toEqual(['[spica] window: page drawn (load-start 0.0 s, ready-to-show 0.8 s, shown 0.8 s, finish 1.2 s)']);
    await r.advance(LOAD_LIMIT_MS);
    expect(r.lines).toHaveLength(1);
  });

  it('a page that did not draw is one warning naming what was wrong', async () => {
    const r = setup(['window all one colour']);
    r.w.step('load-start');
    r.w.step('finish');
    r.w.step('shown');
    await r.advance(SETTLE_MS);
    expect(r.lines).toEqual(['WARN [spica] window: page not drawn (window all one colour; steps: load-start 0.0 s, finish 0.0 s, shown 0.0 s)']);
  });

  it('a load that never finishes is told once', async () => {
    const r = setup();
    r.w.step('load-start');
    r.w.step('shown');
    await r.advance(LOAD_LIMIT_MS);
    await r.advance(LOAD_LIMIT_MS);
    expect(r.lines).toEqual(['WARN [spica] window: page not loaded 15 s after it started (steps: load-start 0.0 s, shown 0.0 s)']);
    expect(r.looks()).toBe(0);
  });

  it('a failed load is told with its reason', async () => {
    const r = setup();
    r.w.step('load-start');
    r.w.step('fail', '-102 ERR_CONNECTION_REFUSED');
    await r.advance(LOAD_LIMIT_MS);
    expect(r.lines).toEqual(['WARN [spica] window: page failed to load (steps: load-start 0.0 s, fail -102 ERR_CONNECTION_REFUSED 0.0 s)']);
  });

  it('a window started hidden is looked at once it is shown, and shown again adds nothing', async () => {
    const r = setup([], false);
    r.w.step('load-start');
    r.w.step('finish');
    await r.advance(60_000);
    expect(r.lines).toEqual([]);
    r.show(true);
    r.w.step('shown');
    await r.advance(SETTLE_MS);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain('page drawn');
    r.w.step('shown');
    await r.advance(SETTLE_MS);
    expect(r.lines).toHaveLength(1);
  });

  it('a reload is watched afresh, and a look from the old load is dropped', async () => {
    let answer: (l: Look) => void = () => undefined;
    const r = setup(() => new Promise<Look>((res) => (answer = res)));
    r.w.step('load-start');
    r.w.step('finish');
    await r.advance(SETTLE_MS);
    r.w.step('load-start');
    answer(['#root empty']);
    await r.advance(0);
    expect(r.lines).toEqual([]);
    r.w.step('finish');
    await r.advance(SETTLE_MS);
    answer([]);
    await r.advance(0);
    expect(r.lines).toEqual(['[spica] window: page drawn (load-start 0.0 s, finish 0.0 s)']);
  });
});

describe('looking at the page', () => {
  const px = (n: number, f: (i: number) => [number, number, number]) => {
    const a = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) a.set([...f(i), 255], i * 4);
    return a;
  };

  it('one colour: empty or uniform; a small mark is enough to count as drawn', () => {
    expect(oneColour(new Uint8Array(0))).toBe(true);
    expect(oneColour(px(10_000, () => [10, 10, 12]))).toBe(true);
    expect(oneColour(px(10_000, (i) => (i > 5000 && i < 5100 ? [200, 200, 200] : [10, 10, 12])))).toBe(false);
  });

  it('names each problem', async () => {
    const blank = { toBitmap: () => px(100, () => [0, 0, 0]) };
    expect(await lookAtPage({ executeJavaScript: () => Promise.resolve(true), capturePage: () => Promise.resolve({ toBitmap: () => px(100, (i) => [i, i, i]) }) })).toEqual([]);
    expect(await lookAtPage({ executeJavaScript: () => Promise.resolve(false), capturePage: () => Promise.resolve(blank) })).toEqual(['#root empty', 'window all one colour']);
    expect(await lookAtPage({ executeJavaScript: () => new Promise(() => undefined), capturePage: () => Promise.resolve(blank) }, 10)).toEqual(['no frame within 0.01 s', 'window all one colour']);
    expect(await lookAtPage({ executeJavaScript: () => Promise.reject(new Error('gone')), capturePage: () => Promise.reject(new Error('gone')) })).toEqual(['the page did not answer', 'no picture of the window']);
  });
});
