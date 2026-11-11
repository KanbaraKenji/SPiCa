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

  it('a sidebar row shows 更多 only under the pointer, when current, with the focus inside or with its menu open; its place is always kept, so nothing moves', () => {
    expect(block('.tree-more')).toContain('visibility: hidden');
    expect(block('.tree-more')).not.toContain('display: none');
    expect(block('.tree-row:hover .tree-more,\n.tree-row:focus-within .tree-more,\n.tree-row.is-active .tree-more,\n.tree-row.is-menu-open .tree-more')).toContain('visibility: visible');
    expect(block('.tree-more-space')).toContain('width: 24px');
  });

  it('a sidebar row: the name is only as wide as its text (the arrow follows it), the status place is pushed to the end, the whole row opens', () => {
    expect(block('.tree-title')).toContain('flex: 0 1 auto');
    expect(block('.tree-open')).toContain('flex: 0 1 auto');
    expect(block('.status-slot')).toContain('margin: 0 4px 0 auto');
    expect(block('.tree-open::after')).toContain('inset: 0');
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
