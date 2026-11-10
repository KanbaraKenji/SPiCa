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

  it('a collapsed project row: the name first (it does not shrink, up to room left for a few characters of the summary); the summary gives way', () => {
    const title = block('.tree-open:has(> .tree-summary) > .tree-title');
    expect(title).toContain('flex: 1 0 auto');
    expect(title).toContain('max-width: calc(100% - 84px)');
    expect(block('.tree-summary')).toContain('flex: 0 1 auto');
    expect(block('.tree-summary')).toContain('text-overflow: ellipsis');
  });

  it('nothing is underlined (links and text buttons are told by colour and the pointer, not a line)', () => {
    expect(css).not.toMatch(/text-decoration(-line)?:\s*underline/);
    expect(css).not.toMatch(/text-underline/);
    expect(block('.history-link:hover')).toContain('color: var(--spica-accent)');
  });

  it('a sidebar row shows 更多 only under the pointer, when current, with the focus inside or with its menu open', () => {
    expect(block('.tree-more')).toContain('display: none');
    expect(block('.tree-row:hover .tree-more,\n.tree-row:focus-within .tree-more,\n.tree-row.is-active .tree-more,\n.tree-row.is-menu-open .tree-more')).toContain('display: inline-flex');
  });
});
