import { describe, expect, it } from 'vitest';
import { pageZoom, zoomKey, zoomSite, type ZoomGuest, type ZoomKey } from './page-zoom';

type Listener = (...args: unknown[]) => void;

function fakePage(id: number, url: string) {
  const on = new Map<string, Listener>();
  const page = {
    id,
    url,
    factor: 1,
    gone: false,
    getURL: () => page.url,
    isDestroyed: () => page.gone,
    setZoomFactor: (f: number) => {
      page.factor = f;
    },
    on: (event: string, listener: Listener) => {
      on.set(event, listener);
    },
    fire: (event: string, ...args: unknown[]) => on.get(event)?.(...args),
  };
  return page;
}

const key = (k: Partial<ZoomKey>): ZoomKey => ({ type: 'keyDown', key: '', code: '', control: true, meta: false, alt: false, ...k });

function setup(app = 1) {
  const told: Array<[number, number]> = [];
  // a notch every 100 ms unless a test says otherwise
  const state = { app, at: 0, gap: 100 };
  const zoom = pageZoom({ appZoom: () => state.app, notify: (id, z) => told.push([id, z]), now: () => (state.at += state.gap) });
  return { zoom, told, state };
}

describe('zoomKey', () => {
  it('Ctrl with plus, minus, 0 (and the number pad); not alone, not with Alt, not on key up', () => {
    expect(zoomKey(key({ key: '=' }))).toBe('in');
    expect(zoomKey(key({ key: '+' }))).toBe('in');
    expect(zoomKey(key({ code: 'NumpadAdd' }))).toBe('in');
    expect(zoomKey(key({ key: '-' }))).toBe('out');
    expect(zoomKey(key({ code: 'NumpadSubtract' }))).toBe('out');
    expect(zoomKey(key({ key: '0' }))).toBe('reset');
    expect(zoomKey(key({ code: 'Numpad0' }))).toBe('reset');
    expect(zoomKey(key({ key: '0', control: false, meta: true }))).toBe('reset');
    expect(zoomKey(key({ key: '=', control: false }))).toBeNull();
    expect(zoomKey(key({ key: '=', alt: true }))).toBeNull();
    expect(zoomKey(key({ key: '=', type: 'keyUp' }))).toBeNull();
    expect(zoomKey(key({ key: 'a' }))).toBeNull();
  });
});

describe('zoomSite', () => {
  it('the origin; nothing for an empty page', () => {
    expect(zoomSite('https://example.com/a?b')).toBe('https://example.com');
    expect(zoomSite('spica-page://ab12cd/report.html')).toBe('spica-page://ab12cd');
    expect(zoomSite('about:blank')).toBe('');
    expect(zoomSite('')).toBe('');
  });
});

describe('page zoom', () => {
  it('the wheel zooms that page only, in the app\'s steps, and says so', () => {
    const { zoom, told } = setup();
    const a = fakePage(1, 'https://example.com/a');
    const b = fakePage(2, 'https://other.example/');
    zoom.wire(a as unknown as ZoomGuest);
    zoom.wire(b as unknown as ZoomGuest);
    a.fire('zoom-changed', {}, 'in');
    a.fire('zoom-changed', {}, 'in');
    expect(a.factor).toBe(1.25);
    expect(b.factor).toBe(1);
    expect(zoom.zoomOf(1)).toBe(1.25);
    expect(zoom.zoomOf(2)).toBe(1);
    expect(told.at(-1)).toEqual([1, 1.25]);
    a.fire('zoom-changed', {}, 'out');
    expect(a.factor).toBe(1.1);
  });

  it('one notch said twice at once (as Electron does for a page) is one step; two notches are two', () => {
    const { zoom, state } = setup();
    const a = fakePage(1, 'https://example.com/');
    zoom.wire(a as unknown as ZoomGuest);
    state.gap = 0.4;
    a.fire('zoom-changed', {}, 'in');
    a.fire('zoom-changed', {}, 'in');
    expect(zoom.zoomOf(1)).toBe(1.1);
    state.gap = 40;
    a.fire('zoom-changed', {}, 'in');
    a.fire('zoom-changed', {}, 'in');
    expect(zoom.zoomOf(1)).toBe(1.5);
    state.gap = 0.4;
    a.fire('zoom-changed', {}, 'out');
    expect(zoom.zoomOf(1)).toBe(1.25);
  });

  it('keys: Ctrl + plus / minus step, Ctrl + 0 back to 100%; the key goes no further', () => {
    const { zoom } = setup();
    const a = fakePage(1, 'https://example.com/');
    zoom.wire(a as unknown as ZoomGuest);
    let stopped = 0;
    const e = { preventDefault: () => stopped++ };
    a.fire('before-input-event', e, key({ key: '=' }));
    a.fire('before-input-event', e, key({ key: '=' }));
    expect(a.factor).toBe(1.25);
    a.fire('before-input-event', e, key({ key: '-' }));
    expect(a.factor).toBe(1.1);
    a.fire('before-input-event', e, key({ key: '0' }));
    expect(a.factor).toBe(1);
    expect(stopped).toBe(4);
    a.fire('before-input-event', e, key({ key: 'x' }));
    expect(stopped).toBe(4);
  });

  it('kept per site: another tab of the same site follows, a page that goes to another site has that one\'s', () => {
    const { zoom } = setup();
    const a = fakePage(1, 'https://example.com/a');
    const b = fakePage(2, 'https://example.com/b');
    zoom.wire(a as unknown as ZoomGuest);
    zoom.wire(b as unknown as ZoomGuest);
    a.fire('zoom-changed', {}, 'in');
    expect(b.factor).toBe(1.1);
    b.url = 'https://other.example/';
    b.fire('did-navigate');
    expect(b.factor).toBe(1);
    b.url = 'https://example.com/c';
    b.fire('did-navigate');
    expect(b.factor).toBe(1.1);
  });

  it('drawn at the app\'s zoom times its own, again after the app\'s changes', () => {
    const { zoom, state } = setup(1.1);
    const a = fakePage(1, 'https://example.com/');
    zoom.wire(a as unknown as ZoomGuest);
    zoom.step(1, 'in');
    expect(a.factor).toBeCloseTo(1.21);
    state.app = 1.5;
    a.factor = 1.5; // what Electron does to a page when the app's zoom changes
    zoom.appZoomChanged();
    expect(a.factor).toBeCloseTo(1.65);
    expect(zoom.zoomOf(1)).toBe(1.1);
  });

  it('the mark puts it back to 100%; an empty page and a closed one are left alone', () => {
    const { zoom } = setup();
    const a = fakePage(1, 'https://example.com/');
    const blank = fakePage(2, 'about:blank');
    zoom.wire(a as unknown as ZoomGuest);
    zoom.wire(blank as unknown as ZoomGuest);
    zoom.step(1, 'in');
    zoom.step(1, 'reset');
    expect(a.factor).toBe(1);
    blank.fire('zoom-changed', {}, 'in');
    expect(blank.factor).toBe(1);
    expect(zoom.zoomOf(2)).toBe(1);
    a.gone = true;
    a.fire('destroyed');
    zoom.step(1, 'in');
    expect(zoom.zoomOf(1)).toBe(1);
  });
});
