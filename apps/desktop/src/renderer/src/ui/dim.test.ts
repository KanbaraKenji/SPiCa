// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { watchCover } from './dim';
import type { WindowCover } from '../../../shared/skin';

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
});

function add(cls: string): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  document.body.appendChild(el);
  return el;
}

describe('the caption symbols follow what covers the page', () => {
  it('a scrim when a dialog opens, nothing when it closes', async () => {
    const said: WindowCover[] = [];
    const stop = watchCover(document, (c) => said.push(c));
    const dialog = add('scrim');
    await settle();
    dialog.remove();
    await settle();
    expect(said).toEqual([null, 'scrim', null]);
    stop();
  });

  it('two layers: closing the top one keeps it covered; a picture at full size counts too', async () => {
    const said: WindowCover[] = [];
    const stop = watchCover(document, (c) => said.push(c));
    const first = add('scrim');
    const second = add('image-viewer');
    await settle();
    second.remove();
    await settle();
    expect(said).toEqual([null, 'scrim']);
    first.remove();
    await settle();
    expect(said).toEqual([null, 'scrim', null]);
    stop();
  });

  it('the opening animation: said while it shows, and not once it starts to fade away', async () => {
    const splash = add('splash-layer');
    const said: WindowCover[] = [];
    const stop = watchCover(document, (c) => said.push(c));
    splash.className = 'splash-layer is-skipping';
    await settle();
    splash.remove();
    await settle();
    expect(said).toEqual(['splash', null]);
    stop();
  });

  it('says how it starts even when nothing covers the page, so a reload under a dialog does not leave the symbols dim', () => {
    const said: WindowCover[] = [];
    const stop = watchCover(document, (c) => said.push(c));
    expect(said).toEqual([null]);
    stop();
    expect(said).toEqual([null]);
  });

  it('already covered when it starts; stopping while covered says nothing covers it', () => {
    add('scrim');
    const said: WindowCover[] = [];
    const stop = watchCover(document, (c) => said.push(c));
    stop();
    expect(said).toEqual(['scrim', null]);
  });
});
