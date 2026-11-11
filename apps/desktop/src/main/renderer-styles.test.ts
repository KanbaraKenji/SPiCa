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
  it('is the panel’s height, not its content’s: the list scrolls with 新对话 and 收件箱, the plugin pages and 设置 keep their place', () => {
    expect(block('.sidebar')).toContain('min-height: 0');
    expect(block('.sidebar-scroll')).toContain('overflow-y: auto');
    expect(block('.sidebar-scroll')).toContain('min-height: 0');
    for (const kept of ['.sidebar-bottom', '.side-plugins']) expect(block(kept)).toContain('flex: none');
    // 新对话 and 收件箱 sit inside the scroller, so their rows keep the same inset as before (no jump).
    expect(block('.sidebar-scroll > .sidebar-top')).toContain('padding: 4px 0 6px');
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

describe('the row under every message', () => {
  it('is always there: no rule hides it until the pointer comes', () => {
    expect(block('.msg-actions')).not.toContain('visibility');
    expect(css).not.toMatch(/:hover > \.msg-actions/);
  });
});

describe('the type scale (the Claude app’s, comfortable density)', () => {
  const root = block(':root');

  it('six sizes, each with its line: caption 12/17, footnote 13/17, body 14/20, heading 15/20, prose 16/24, title 22/28', () => {
    for (const [name, size, line] of [
      ['caption', 12, 17],
      ['footnote', 13, 17],
      ['body', 14, 20],
      ['heading', 15, 20],
      ['prose', 16, 24],
      ['title', 22, 28],
    ] as const) {
      expect(root, name).toContain(`--fs-${name}: ${size}px;\n  --lh-${name}: ${line}px;`);
    }
    expect(block('body')).toContain('font-size: var(--fs-body);\n  line-height: var(--lh-body)');
  });

  it('body has the compact density’s 19px line too (rows, the right panel’s lists, what opens under a row)', () => {
    expect(root).toContain('--lh-body-compact: 19px;');
  });

  it('no size or line height off the scale: only the variables, code in a sentence (0.9em) and the two badges drawn in a fixed box', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: m[2]! }));
    const offScale = rules
      .filter((r) => !r.sel.startsWith(':root'))
      .flatMap((r) => [...r.body.matchAll(/(font-size|line-height): ([^;]+);/g)].filter((m) => !m[2]!.startsWith('var(')).map((m) => `${r.sel} ${m[1]}: ${m[2]}`));
    expect(offScale).toEqual([
      '.md code font-size: 0.9em',
      '.file-card-icon.is-typed font-size: 10px',
      '.rail-badge font-size: 10px',
      '.rail-badge line-height: 15px',
    ]);
  });
});

describe('the conversation’s sizes', () => {
  it('text 16 on 24: answers, your messages, the input box, and the rows that stand in an answer', () => {
    expect(block(':root')).toContain('--chat-text: var(--fs-prose);\n  --chat-line: var(--lh-prose)');
    for (const sel of ['.turn-response .md', '.turn-user-text', '.composer-input', '.fold-head']) expect(block(sel), sel).toContain('line-height: var(--chat-line)');
    for (const sel of ['.turn-user-text', '.composer-input', '.fold-head', '.turn-response .md']) expect(block(sel), sel).toContain('font-size: var(--chat-text)');
  });

  it('an answer’s headings are never smaller than its text: h1 22/28, h2 18/27, h3–h6 the text (bold)', () => {
    expect(block(':root')).toContain('--chat-h2: 18px;\n  --chat-h2-line: 27px;\n  --chat-h1: var(--fs-title);\n  --chat-h1-line: var(--lh-title)');
    expect(block('.md h1')).toContain('font-size: var(--chat-h1)');
    expect(block('.md h2')).toContain('font-size: var(--chat-h2)');
    expect(css).toMatch(/\}\n\n\.md h3,\n\.md h4,\n\.md h5,\n\.md h6 \{\n {2}font-size: var\(--chat-text\);/);
  });

  it('secondary lines 14 on 20: the steps under a group and what opens under a row, notes, a confirmation’s labels', () => {
    expect(block(':root')).toContain('--chat-small: var(--fs-body);\n  --chat-small-line: var(--lh-body)');
    for (const sel of ['.tool-item-head', '.fold-body', '.thinking-text', '.turn-note', '\n.confirm-args', '\n.conversation'])
      expect(block(sel), sel).toContain('font-size: var(--chat-small)');
    for (const sel of ['\n.confirm-args', '\n.conversation']) expect(block(sel), sel).toContain('line-height: var(--chat-small-line)');
  });

  it('rows on the compact line (14 on 19): a group’s steps, what opens under a row, notes; same space above and below', () => {
    expect(block(':root')).toContain('--chat-row-line: var(--lh-body-compact);');
    for (const sel of ['.tool-item-head', '.fold-body', '.thinking-text', '.turn-note']) expect(block(sel), sel).toContain('line-height: var(--chat-row-line)');
    expect(block('.tool-item-head')).toContain('min-height: calc(var(--chat-row-line) + 12px)');
    expect(block('.detail-list')).toContain('line-height: var(--lh-body-compact)');
    // The detail panel is not the conversation; the time at the end of a row stays a caption.
    expect(block('.detail-list')).toContain('font-size: var(--fs-body)');
    expect(block('.fold-meta')).toContain('font-size: var(--fs-caption)');
  });

  it('文字大小 小 / 大 move the conversation’s tiers one step (the input box is in it), nothing outside it', () => {
    expect(block(":root[data-text-size='sm'] .conversation")).toContain('--chat-text: 15px;\n  --chat-line: 22px;\n  --chat-small: 13px;\n  --chat-small-line: 19px;\n  --chat-row-line: 18px;\n  --chat-h2: 16px;\n  --chat-h2-line: 24px;\n  --chat-h1: 18px;\n  --chat-h1-line: 27px;');
    expect(block(":root[data-text-size='lg'] .conversation")).toContain('--chat-text: 18px;\n  --chat-line: 27px;\n  --chat-small: 15px;\n  --chat-small-line: 22px;\n  --chat-row-line: 21px;\n  --chat-h2: 22px;\n  --chat-h2-line: 28px;\n  --chat-h1: 22px;\n  --chat-h1-line: 28px;');
    expect(css.match(/data-text-size/g)).toHaveLength(2);
  });

  it('everything in the code font that shows code follows 外观 › 代码 › 字号, on lines in proportion to 13 on 19', () => {
    expect(block(':root')).toContain('--code-size: 13px');
    expect(block(':root')).toContain('--code-line: calc(var(--code-size) * 19 / 13)');
    for (const sel of ['.md pre code', '.tool-command pre', '.tool-args', '.tool-result', '.confirm-args dd', '.preview-code', '.code-theme-preview'])
      expect(block(sel), sel).toContain('font-size: var(--code-size);\n  line-height: var(--code-line)');
  });
});

describe('the input box', () => {
  it('corners of 12px (as on the cards); the row under it starts and ends where the bottom edge starts to turn', () => {
    expect(block('.composer-wrap')).toContain('--composer-radius: var(--radius-l)');
    expect(block(':root')).toContain('--radius-l: 12px');
    expect(block('.composer')).toContain('border-radius: var(--composer-radius)');
    expect(block('.composer-below')).toContain('margin: 4px calc(var(--composer-radius) - 7px) 0 calc(var(--composer-radius) - 8px)');
  });
});
