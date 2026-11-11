// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { watchScrim } from './dim';

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

describe('the caption buttons dim with a scrim', () => {
  it('on when a dialog opens, off when it closes', async () => {
    const said: boolean[] = [];
    const stop = watchScrim(document, (on) => said.push(on));
    const dialog = add('scrim');
    await settle();
    dialog.remove();
    await settle();
    expect(said).toEqual([true, false]);
    stop();
  });

  it('two layers: closing the top one keeps it dimmed; a picture at full size counts too', async () => {
    const said: boolean[] = [];
    const stop = watchScrim(document, (on) => said.push(on));
    const first = add('scrim');
    const second = add('image-viewer');
    await settle();
    second.remove();
    await settle();
    expect(said).toEqual([true]);
    first.remove();
    await settle();
    expect(said).toEqual([true, false]);
    stop();
  });

  it('already covered when it starts; stopping while covered undims', () => {
    add('scrim');
    const said: boolean[] = [];
    const stop = watchScrim(document, (on) => said.push(on));
    stop();
    expect(said).toEqual([true, false]);
  });
});
