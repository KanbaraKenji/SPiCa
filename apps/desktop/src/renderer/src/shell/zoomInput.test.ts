// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { installZoomInput, zoomKey } from './zoomInput';

describe('zoom input', () => {
  it('maps the usual keys', () => {
    const k = (key: string, extra: Partial<KeyboardEvent> = {}) => zoomKey({ ctrlKey: true, metaKey: false, altKey: false, key, code: '', ...extra });
    expect(k('=')).toBe('in');
    expect(k('+')).toBe('in');
    expect(k('-')).toBe('out');
    expect(k('0')).toBe('reset');
    expect(k('0', { ctrlKey: false })).toBeNull();
    expect(k('0', { altKey: true })).toBeNull();
    expect(k('a')).toBeNull();
  });

  it('turns Ctrl+wheel into one step per notch and leaves plain scrolling alone', () => {
    const zoom = vi.fn();
    const off = installZoomInput(zoom);
    const wheel = (deltaY: number, ctrlKey: boolean) => {
      const e = new WheelEvent('wheel', { deltaY, ctrlKey, cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(wheel(-120, true)).toBe(true);
    expect(wheel(300, true)).toBe(true);
    expect(wheel(-20, true)).toBe(true); // small trackpad delta: no step yet
    expect(wheel(100, false)).toBe(false);
    expect(zoom.mock.calls).toEqual([['in'], ['out']]);
    off();
  });

  it('leaves the editing keys to the page: Ctrl+C on words selected in the conversation copies them', () => {
    const zoom = vi.fn();
    const off = installZoomInput(zoom);
    for (const [key, code] of [['c', 'KeyC'], ['x', 'KeyX'], ['v', 'KeyV'], ['a', 'KeyA'], ['z', 'KeyZ']]) {
      const e = new KeyboardEvent('keydown', { key, code, ctrlKey: true, cancelable: true });
      window.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(zoom).not.toHaveBeenCalled();
    off();
  });
});
