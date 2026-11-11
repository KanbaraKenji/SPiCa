// Layout rules that a quick look at the screen would catch, kept by a test so they do not slip back.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPLASH_INK } from '../shared/skin';

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

describe('settings › 插件 fills the window', () => {
  it('the page is the window tall (a floor past which it scrolls again); list and detail stretch and scroll on their own', () => {
    const page = block('.settings-column.is-fill');
    expect(page).toContain('height: 100%');
    expect(page).toMatch(/min-height: \d+px/);
    expect(block('.is-fill .plugins-two')).toContain('align-items: stretch');
    expect(block('.is-fill .plugins-two')).toContain('flex: 1');
    expect(block('.is-fill .plugins-list,\n.is-fill .plugin-detail')).toContain('overflow-y: auto');
  });
});

describe('settings › 插件 list rows', () => {
  it('a long name is cut before the version is (the version never shrinks)', () => {
    expect(block('.plugin-row-name')).toContain('flex: 0 1 auto');
    expect(block('.plugin-row-name')).toContain('text-overflow: ellipsis');
    expect(block('.plugin-row-version')).toContain('flex: none');
    // Right after the name: the 8px gap of the row and of the detail's title, less 4.
    expect(block('.plugin-row')).toContain('gap: 8px');
    expect(block('.plugin-title')).toContain('gap: 8px');
    expect(block('.plugin-row .plugin-version,\n.plugin-title .plugin-version')).toContain('margin-left: -4px');
  });
});

describe('renaming in place', () => {
  it('in the sidebar the field is the row itself: full height, to both ends of the row, its corners; the name stays put (10px in: 1 border + 9)', () => {
    const f = block('.input.tree-rename');
    expect(block('.tree-row')).toContain('height: 32px');
    expect(f).toContain('height: 32px');
    expect(f).toContain('margin: 0 -4px 0 0');
    expect(block('.tree-row')).toContain('padding-right: 4px');
    expect(f).toContain('padding: 0 8px 0 9px');
    expect(f).toContain('border-radius: var(--radius-m)');
  });

  it('in the title bar the field is the name’s own box (24 high, same left edge, text 6px in: 1 border + 5) and wins over .input', () => {
    const f = block('.input.titlebar-rename');
    expect(f).toContain('height: 24px');
    expect(f).toContain('margin-left: -6px');
    expect(f).toContain('padding: 0 6px 0 5px');
    expect(block('.titlebar-name')).toContain('padding: 2px 6px');
    expect(f).toContain('color: var(--spica-ink)');
  });
});

describe('sidebar status place', () => {
  it('stopped has the error’s red dot', () => {
    expect(block('.status-slot.is-error .slot-dot,\n.status-slot.is-stopped .slot-dot')).toContain('background: var(--spica-danger)');
  });
});

describe('settings › 插件 list texts', () => {
  it('a line in the list (nothing found, sources not reached) keeps the group titles’ inset from the box edge', () => {
    expect(block('.plugins-group-title')).toContain('padding: 6px 12px 4px');
    expect(block('.plugins-list .plugins-none')).toContain('padding: 0 12px');
  });
});

describe('the sidebar in a short window', () => {
  it('is the panel’s height, not its content’s: the list scrolls, the top, the plugin pages and 设置 keep their place', () => {
    expect(block('.sidebar')).toContain('min-height: 0');
    expect(block('.sidebar-scroll')).toContain('overflow-y: auto');
    expect(block('.sidebar-scroll')).toContain('min-height: 0');
    for (const kept of ['.sidebar-top', '.sidebar-bottom', '.side-plugins']) expect(block(kept)).toContain('flex: none');
  });
});

describe('the caption symbols over the opening animation', () => {
  it('take the animation’s own text colours (the ones its style sheet uses)', () => {
    const splash = readFileSync(join(__dirname, '../../../../packages/brand/src/styles/splash.css'), 'utf8');
    expect(splash).toMatch(new RegExp(`\\[data-theme='dark'\\] \\{[^}]*--spica-splash-ink: ${SPLASH_INK.dark};`));
    expect(splash).toMatch(new RegExp(`\\[data-theme='light'\\] \\{[^}]*--spica-splash-ink: ${SPLASH_INK.light};`));
  });
});

describe('a plugin’s icon for each skin', () => {
  it('only the one for the skin in force shows (it changes with the skin, no reload)', () => {
    expect(block(":root[data-scheme='dark'] .plugin-icon.is-light,\n:root:not([data-scheme='dark']) .plugin-icon.is-dark")).toContain('display: none');
  });
});
