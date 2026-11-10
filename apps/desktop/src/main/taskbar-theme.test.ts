import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followTaskbarTheme, parseSystemUsesLightTheme, THEME_SETTLE_MS } from './taskbar-theme';

// A stand-in for Electron's nativeTheme value and the registry value, which the tests move independently.
function world(start: { native: boolean; system: boolean | null }) {
  const state = { ...start };
  const applied: boolean[] = [];
  const follower = followTaskbarTheme({
    readTaskbarDark: async () => state.system,
    nativeDark: () => state.native,
    apply: (dark) => applied.push(dark),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(THEME_SETTLE_MS + 10);
  };
  return { state, applied, follower, settle };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('taskbar icon colour', () => {
  it('reads the registry value Windows keeps for the taskbar', () => {
    expect(parseSystemUsesLightTheme('    SystemUsesLightTheme    REG_DWORD    0x0\r\n')).toBe(true);
    expect(parseSystemUsesLightTheme('    SystemUsesLightTheme    REG_DWORD    0x1\r\n')).toBe(false);
    expect(parseSystemUsesLightTheme('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
  });

  it('system switches dark → light while running, nativeTheme still says dark when the event arrives: the icon turns black', async () => {
    const w = world({ native: true, system: true });
    await w.settle();
    expect(w.applied).toEqual([true]);
    // Windows has switched; Electron's value is still the old one when 'updated' fires.
    w.state.system = false;
    w.follower.onUpdated();
    // The old handler drew the icon right here from nativeTheme: white on a light taskbar.
    expect(w.applied).toEqual([true]);
    await w.settle();
    expect(w.applied).toEqual([true, false]);
  });

  it('and back light → dark: the icon turns white', async () => {
    const w = world({ native: false, system: false });
    await w.settle();
    w.state.system = true;
    w.follower.onUpdated();
    await w.settle();
    expect(w.applied).toEqual([false, true]);
  });

  it('a light skin on a dark taskbar: themeSource sways nativeTheme for a moment, the icon stays white', async () => {
    // Window created on a dark taskbar: white.
    const w = world({ native: true, system: true });
    // The light skin sets themeSource = 'light'; for a moment nativeTheme answers light.
    w.state.native = false;
    w.follower.onUpdated();
    await w.settle();
    expect(w.applied).toEqual([true]);
  });

  it('a burst of events is one check and at most one redraw', async () => {
    const w = world({ native: true, system: true });
    await w.settle();
    w.state.system = false;
    for (let i = 0; i < 5; i++) {
      w.follower.onUpdated();
      await vi.advanceTimersByTimeAsync(100);
    }
    await w.settle();
    expect(w.applied).toEqual([true, false]);
  });

  it('nothing changed: no redraw (the shortcuts are not touched again)', async () => {
    const w = world({ native: true, system: true });
    await w.settle();
    w.follower.onUpdated();
    await w.settle();
    expect(w.applied).toEqual([true]);
  });

  it('when the registry cannot be read, nativeTheme is asked after the settle time, not at the event', async () => {
    const w = world({ native: true, system: null });
    await w.settle();
    w.follower.onUpdated();
    // Electron catches up during the settle time.
    w.state.native = false;
    await w.settle();
    expect(w.applied).toEqual([true, false]);
  });
});
