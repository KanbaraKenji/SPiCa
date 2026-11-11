// Layout rules that a quick look at the screen would catch, kept by a test so they do not slip back.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../renderer/src/styles.css'), 'utf8');
const block = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
};

describe('styles', () => {
  it('over the icon column the brand sits right after the sidebar toggle, not at the far end', () => {
    expect(block('.rail-head,\n.sidebar-head.is-over-rail')).toContain('justify-content: flex-start');
  });

  it('a note line in the conversation breaks a long path instead of running past the window', () => {
    expect(block('.turn-note')).toContain('overflow-wrap: anywhere');
  });

  it('nothing is underlined (links and text buttons are told by colour and the pointer, not a line)', () => {
    expect(css).not.toMatch(/text-decoration(-line)?:\s*underline/);
    expect(css).not.toMatch(/text-underline/);
    expect(block('.history-link:hover')).toContain('color: var(--spica-accent)');
  });

  it('更多 stands in the status place (the same box at the row end) and never appears on hover, so nothing moves', () => {
    for (const box of ['.tree-more', '.status-slot']) {
      expect(block(box)).toContain('width: 24px');
      expect(block(box)).toContain('height: 24px');
      expect(block(box)).toContain('margin-left: auto');
    }
    expect(css).not.toMatch(/:hover .tree-more/);
    expect(css).not.toMatch(/tree-more-space/);
  });

  it('on a light skin the waiting dot is a plain yellow with a fine darker edge; elsewhere the warning colour', () => {
    expect(block('.status-slot.is-waiting .slot-dot')).toContain('background: var(--spica-warning)');
    const light = block(":root[data-scheme='light'] .status-slot.is-waiting .slot-dot");
    expect(light).toContain('background: #f7c31a');
    expect(light).toContain('box-shadow: inset 0 0 0 1px #c9980a');
  });

  it('a sidebar row: the name is only as wide as its text (the arrow follows it), the status place is pushed to the end, the whole row opens', () => {
    expect(block('.tree-title')).toContain('flex: 0 1 auto');
    expect(block('.tree-open')).toContain('flex: 0 1 auto');
    expect(block('.tree-open::after')).toContain('inset: 0');
    expect(block('.tree-open:focus-visible::after')).toContain('outline: 2px solid var(--spica-accent)');
    for (const above of ['.tree-twisty', '.tree-more', '.status-slot', '.tree-pin']) expect(block(above)).toContain('z-index: 1');
  });
});

describe('sidebar tabs', () => {
  it('the tabs and the space kept for them on the icon column are one rule: same height, same margins', () => {
    const rule = block('.side-tabs,\n.side-tabs-space');
    expect(rule).toContain('height: 36px');
    expect(rule).toContain('margin: 4px 8px 2px');
    expect(rule).toContain('flex: none');
  });
});

describe('the model under the message box', () => {
  it('short of room the provider is cut long before the name; the separator is never cut', () => {
    expect(block('.composer-model-text')).toContain('display: flex');
    expect(block('.composer-model-provider')).toContain('flex: 0 1000 auto');
    expect(block('.composer-model-provider')).toContain('text-overflow: ellipsis');
    expect(block('.composer-model-name')).toContain('flex: 0 1 auto');
    expect(block('.composer-model-sep')).toContain('flex: none');
    // The narrow box still swaps the words for the icon: that rule comes after these.
    expect(css.indexOf('.composer-model-text {\n  display: flex')).toBeLessThan(css.indexOf('.composer-model-text {\n    display: none'));
  });
});
