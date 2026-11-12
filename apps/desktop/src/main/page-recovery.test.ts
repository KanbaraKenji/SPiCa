import { describe, expect, it } from 'vitest';
import { AUTO_RELOADS, LOSS_WINDOW_MS, pageAlive, pageRecovery, type RecoveryOptions } from './page-recovery';

function setup(answer: boolean | 'never' = true) {
  let t = 1_000_000;
  let quitting = false;
  const calls: string[] = [];
  const lines: string[] = [];
  const pending: ((v: boolean) => void)[] = [];
  const o: RecoveryOptions = {
    quitting: () => quitting,
    reload: () => calls.push('reload'),
    ask: () => {
      calls.push('ask');
      return answer === 'never' ? new Promise((r) => pending.push(r)) : Promise.resolve(answer);
    },
    quit: () => calls.push('quit'),
    warn: (l) => lines.push(l),
    now: () => t,
  };
  const gone = pageRecovery(o);
  return {
    gone: (reason = 'killed', exitCode = 1) => gone({ reason, exitCode }),
    calls,
    lines,
    pending,
    advance: (ms: number) => (t += ms),
    quit: () => (quitting = true),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('page lost', () => {
  it('reloads at once and says so in one line with the reason and exit code', () => {
    const r = setup();
    r.gone('crashed', 34);
    expect(r.calls).toEqual(['reload']);
    expect(r.lines).toEqual(['[spica] window: page process gone (crashed, exit code 34); reloading']);
  });

  it('the third loss within a minute asks instead of reloading, once while the box is open', async () => {
    const r = setup('never');
    for (let i = 0; i < AUTO_RELOADS; i++) r.gone();
    r.gone();
    r.gone();
    expect(r.calls).toEqual(['reload', 'reload', 'ask']);
    expect(r.lines).toHaveLength(3);
    r.pending[0]!(true);
    await tick();
    expect(r.calls.at(-1)).toBe('reload');
    // Asked for by the user: the count starts again.
    r.gone();
    expect(r.calls.at(-1)).toBe('reload');
  });

  it('退出 in the box quits', async () => {
    const r = setup(false);
    r.gone();
    r.gone();
    r.gone();
    await tick();
    expect(r.calls).toEqual(['reload', 'reload', 'ask', 'quit']);
  });

  it('losses more than a minute apart each reload by themselves', () => {
    const r = setup();
    for (let i = 0; i < 5; i++) {
      r.gone();
      r.advance(LOSS_WINDOW_MS);
    }
    expect(r.calls).toEqual(['reload', 'reload', 'reload', 'reload', 'reload']);
  });

  it('a page closing with the app is not brought back', () => {
    const r = setup();
    r.gone('clean-exit', 0);
    r.quit();
    r.gone('killed', 1);
    expect(r.calls).toEqual([]);
    expect(r.lines).toEqual([]);
  });
});

describe('sending to the window', () => {
  const win = (destroyed: boolean, wcDestroyed: boolean, crashed: boolean) => ({
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => wcDestroyed, isCrashed: () => crashed },
  });

  it('only while the window and its page are there', () => {
    expect(pageAlive(win(false, false, false))).toBe(true);
    expect(pageAlive(win(false, false, true))).toBe(false);
    expect(pageAlive(win(false, true, false))).toBe(false);
    expect(pageAlive(win(true, false, false))).toBe(false);
    expect(pageAlive(undefined)).toBe(false);
  });
});
