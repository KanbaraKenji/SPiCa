// Layout rules that a quick look at the screen would catch, kept by a test so they do not slip back.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPLASH_INK } from '../shared/skin';
import { UI_FONT_FACES, UI_FONT_FAMILY } from '../shared/ui-font';
import { FONT_UI } from '../shared/plugin-view';
import { themeCss } from './plugin-views';
import { COLUMN_GUTTER, COLUMN_WIDTH, RAIL_WIDTH } from '../renderer/src/shell/layout';

const css = readFileSync(join(__dirname, '../renderer/src/styles.css'), 'utf8');
const block = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
};

describe('styles', () => {
  it('over the icon column the brand sits right after the sidebar toggle, not at the far end', () => {
    expect(block('.rail-head,\n.sidebar-head.is-over-rail')).toContain('justify-content: flex-start');
  });

  it('a long conversation scrolls inside its row: the row under the title bar and the conversation may be shorter than their content', () => {
    expect(block('.body')).toContain('min-height: 0');
    expect(block('.main')).toContain('min-height: 0');
  });

  it('the scrollbar runs to the window’s bottom edge: the input area sits at the foot of the scrolling box, over what scrolls under it, as wide as before', () => {
    for (const p of ['overflow-y: auto', 'display: flex', 'flex-direction: column']) expect(block('.transcript'), p).toContain(p);
    for (const p of ['position: sticky', 'bottom: 0', 'flex: none', 'background: var(--spica-bg)']) expect(block('.transcript-foot'), p).toContain(p);
    // The box keeps the scrollbar's 10 on both sides, so the input area's own 24 is 14 in here.
    expect(block('::-webkit-scrollbar')).toContain('width: 10px');
    expect(block('.transcript-foot > .composer-wrap')).toContain('padding-left: 14px;\n  padding-right: 14px');
    expect(block('.composer-wrap')).toContain('padding: 0 24px 18px');
  });

  it('a card waiting on the user has the neutral edge of the others; only a dangerous step’s is coloured (red)', () => {
    expect(block('.ask-card,\n.confirm-card')).toContain('border-color: var(--spica-border-strong)');
    expect(css).not.toMatch(/\.(ask|confirm)-card:not\(\.is-done\)(,|\s*\{)[^}]*border-color/);
    expect(block('.confirm-card:not(.is-done).is-danger')).toContain('border-color: var(--spica-danger)');
  });

  it('a note line in the conversation breaks a long path instead of running past the window', () => {
    expect(block('.turn-note')).toContain('overflow-wrap: anywhere');
  });

  it('stopped while it waited is red: 已中断 on a card (its mark too) and the answer’s （中断）, the colour of 无法撤销', () => {
    const rule = block('.card-answer.is-stopped,\n.card-answer.is-stopped .spica-status-icon,\n.turn-note.is-stopped');
    expect(rule).toContain('color: var(--spica-danger)');
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

describe('the panels around the conversation (shell/layout.ts counts on these)', () => {
  it('the column of icons left when the sidebar is not docked is RAIL_WIDTH wide', () => {
    expect(block('.panel-rail')).toContain(`width: ${RAIL_WIDTH}px`);
  });

  it('each docked right panel (preview, details) draws the line on its left; laid over the conversation it has none', () => {
    expect(block('.panel-right.is-docked')).toContain('border-left: 1px solid var(--spica-divider)');
    expect(block('.panel.panel-right.is-max')).toContain('border-left: 0');
    expect(css).not.toContain("data-right='docked'");
  });

  it('one title bar across the conversation and the right panels; each right panel’s head is its own first row under it', () => {
    const bar = block('.titlebar');
    expect(bar).toContain('height: var(--spica-titlebar-h)');
    expect(bar).toContain('padding-left: 16px');
    expect(bar).toContain('border-bottom: 1px solid var(--spica-divider)');
    expect(bar).toContain('env(titlebar-area-width');
    expect(bar).toContain('-webkit-app-region: drag');
    const head = block('.panel-head');
    expect(head).toContain('height: var(--spica-titlebar-h)');
    expect(head).toContain('padding: 0 8px 0 16px');
    // Not part of the window's top row any more: no line, colour, drag area or system-button room of its own.
    for (const gone of ['border-bottom', 'background', 'app-region', 'titlebar-area']) expect(head).not.toContain(gone);
    expect(css).not.toContain('.titlebar.is-inner');
    expect(css).not.toContain('.is-edge .panel-head');
    expect(block('.preview-head')).not.toContain('height');
    expect(css).not.toContain('.detail-head {');
  });

  it('a right panel has the conversation’s background: only the line on its left sets it apart', () => {
    expect(block('.panel-right')).toContain('background: var(--spica-bg)');
    expect(block('.main')).toContain('background: var(--spica-bg)');
  });

  it('the content column is COLUMN_WIDTH wide and moves by --centre-shift (messages, input box, queue, notices, inbox, welcome, demo line, to-bottom)', () => {
    expect(block('.transcript-column,\n.composer-stack,\n.inbox-column,\n.queued,\n.run-notices')).toContain('translate: var(--centre-shift, 0px) 0');
    for (const col of ['.transcript-column', '.composer', '.inbox-column']) expect(block(col)).toContain(`max-width: ${COLUMN_WIDTH}px`);
    // the notices above the box are as wide as it: the column's width less the box's gutters on both sides
    expect(css.replace(/\r\n/g, '\n')).toContain(`.run-notices {\n  flex: none;\n  max-width: ${COLUMN_WIDTH}px;\n  width: calc(100% - ${2 * COLUMN_GUTTER}px);`);
    expect(block('.composer-wrap')).toContain(`padding: 0 ${COLUMN_GUTTER}px`);
    for (const line of ['.empty-chat', '.composer-note']) expect(block(line)).toContain('calc(24px + 2 * var(--centre-shift, 0px))');
    expect(block('.to-bottom')).toContain('left: calc(50% + var(--centre-shift, 0px))');
  });

  it('a line across the sidebar above its bottom row (the account)', () => {
    expect(block('.sidebar-bottom')).toContain('border-top: 1px solid var(--spica-divider)');
  });

  it('a button that cannot be pressed now is greyed but still says why on hover (aria-disabled, as .btn)', () => {
    expect(block(".icon-btn:disabled,\n.icon-btn[aria-disabled='true']")).toContain('opacity: 0.4');
    expect(css).toContain(".icon-btn:hover:not(:disabled):not([aria-disabled='true'])");
  });

  it('in the details: one line between groups; amounts and folders stand right; a file’s folder is cut before its name', () => {
    expect(block('.detail-section + .detail-section')).toContain('border-top: 1px solid var(--spica-divider)');
    expect(block('.detail-facts dd.num')).toContain('text-align: right');
    expect(block('.detail-file .detail-item-sub')).toContain('text-align: right');
    expect(block('.detail-file .detail-item-sub')).toContain('flex: 1 1 0');
    expect(block('.detail-file-name')).toContain('flex: 0 1 auto');
    expect(block('.detail-file')).toContain('width: calc(100% + 12px)');
  });
});

describe('sidebar tabs', () => {
  it('the tabs and the space kept for them on the icon column are one rule: same height, same margins', () => {
    const rule = block('.side-tabs,\n.side-tabs-space');
    expect(rule).toContain('height: var(--tab-h)');
    expect(rule).toContain('margin: 4px 8px 2px');
    expect(rule).toContain('flex: none');
  });
});

describe('control sizes: one place (out/settings-modal/10-controls.md)', () => {
  it('buttons, fields, icon buttons and segments are --control-h (28, as Claude’s); a tab --tab-h', () => {
    const root = block(':root');
    expect(root).toContain('--control-h: 28px');
    expect(root).toContain('--tab-h: 28px');
    expect(root).not.toContain('--tabs-pad');
    for (const sel of ['\n.btn', '\n.btn-small', '\n.input', '\n.icon-btn', '\n.btn-quiet-danger', '\n.segment,\n.side-tabs .tab', '\n.back-link'])
      expect(block(sel)).toContain('height: var(--control-h)');
    expect(block('\n.btn')).toContain('padding: 0 var(--control-pad-x)');
    expect(block('\n.btn.btn-square')).toContain('width: var(--control-h)');
    expect(block('\n.tab')).toContain('height: var(--tab-h)');
  });
});

describe('an icon beside words has the words colour (sidebar rows, the settings column)', () => {
  it('taken from the words, so hover, chosen and off follow; the icons standing alone stay grey', () => {
    expect(block('\n.side-action svg')).toContain('color: currentColor');
    expect(block('\n.settings-nav-icon')).toContain('color: currentColor');
    expect(css).not.toContain('.settings-nav-item.is-on .settings-nav-icon');
    expect(block('.side-action.side-gear:not(.has-word) svg,\n.sidebar.is-rail .side-action svg')).toContain('color: var(--spica-muted)');
  });
});

describe('words on the middle line of what they sit in: one fix, in the font (shared/ui-font.ts, out/settings-modal/13-centre-audit.md)', () => {
  const dialogCss = readFileSync(join(__dirname, '../renderer/dialog/dialog.css'), 'utf8');

  it('the interface font has its ascent and descent moved towards each other (the measured 105.5 / 27.5), the same total as before', () => {
    expect(UI_FONT_FACES).toContain("font-family: 'Spica UI'; src: local('Segoe UI Variable Text')");
    for (const w of ["local('Segoe UI Light'); font-weight: 300", "local('Segoe UI'); font-weight: 400", "local('Segoe UI Semibold'); font-weight: 600", "local('Segoe UI Bold'); font-weight: 700"])
      expect(UI_FONT_FACES).toContain(w);
    const faces = UI_FONT_FACES.split('\n');
    expect(faces).toHaveLength(5);
    for (const f of faces) expect(f).toContain('ascent-override: 105.5%; descent-override: 27.5%;');
    expect(UI_FONT_FAMILY.startsWith("'Spica UI', 'Spica UI Static', 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI'")).toBe(true);
  });

  it('the window, the small dialog window and plugin pages all use it, word for word', () => {
    for (const sheet of [css, dialogCss]) for (const f of UI_FONT_FACES.split('\n')) expect(sheet).toContain(f);
    expect(css).toContain(`--font-ui: ${UI_FONT_FAMILY};`);
    // the small dialog window: 外观 › 界面字体's stack when main passes one (shared/app-dialog.ts font), the default otherwise
    expect(dialogCss).toContain(`font-family: var(--font-ui, ${UI_FONT_FAMILY});`);
    expect(FONT_UI).toBe(UI_FONT_FAMILY);
    expect(themeCss({ '--spica-font': FONT_UI }, 'dark').startsWith(UI_FONT_FACES)).toBe(true);
  });

  it('no small fixed nudges up or down to make up for where glyphs sit (that is the font’s job now): none of them, and no text-box trims either', () => {
    const nudge = /translateY\(\s*-?(?:[0-3](?:\.\d+)?px|0?\.[0-2]\d*em)\s*\)|translate:\s*0\s+-?(?:[0-3](?:\.\d+)?px|0?\.[0-2]\d*em)/;
    expect(css).not.toMatch(nudge);
    expect(css).not.toMatch(/text-box(?:-trim|-edge)?:/);
  });
});

describe('tabs and segments: never a box in a box (out/ref/tabs-1, tabs-4; not tabs-3)', () => {
  it('a tab row is words over a thin line; the open tab has its own line along its bottom edge, not a text underline nor a pill', () => {
    const row = block('\n.tabs');
    expect(row).toContain('box-shadow: inset 0 -1px 0 var(--spica-divider)');
    expect(row).not.toMatch(/background|border-radius|padding/);
    expect(block('\n.tab')).toContain('border-bottom: 2px solid transparent');
    const on = block('\n.tab.is-on');
    expect(on).toContain('border-bottom-color: var(--spica-ink)');
    expect(on).not.toMatch(/background|text-decoration|box-shadow/);
    // In a bar with buttons beside it the row has no line of its own.
    expect(block('.tabs.plugins-tabs,\n.right-head .tabs')).toContain('box-shadow: none');
  });

  it('a segmented row (and 对话 / 项目) is one fill with no space inside it; the chosen block fills it to its edges, the same corners', () => {
    const row = block('\n.segmented,\n.tabs.side-tabs');
    expect(row).toContain('background: var(--spica-hover)');
    expect(row).toContain('border-radius: var(--radius-m)');
    expect(row).toContain('gap: 0');
    expect(row).not.toMatch(/padding|border:/);
    expect(block('\n.segment,\n.side-tabs .tab')).toContain('border-radius: var(--radius-m)');
    const on = block('\n.segment.is-on,\n.side-tabs .tab.is-on');
    expect(on).toContain('background: var(--spica-raised)');
    expect(on).toContain('border-color: var(--spica-border-strong)');
  });

  it('a way back is an arrow and words in the text colour, a block of colour on hover (as Claude’s 「← Your plugins」)', () => {
    expect(block('\n.back-link')).toContain('color: var(--spica-ink)');
    expect(block('\n.back-link:hover')).toContain('background: var(--spica-hover)');
    expect(block('\n.back-link')).not.toMatch(/border:|text-decoration/);
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

describe('settings: one group, one box (settings/Group.tsx)', () => {
  it('the rows in a box are split by a thin line, and a row draws no card of its own', () => {
    expect(block('.group-box > * + *,\n.group-list > * + *')).toContain('border-top: 1px solid var(--spica-divider)');
    expect(block('\n.group-box')).toContain('border-radius: var(--radius-l)');
    expect(block('\n.setting-row')).not.toMatch(/border|background/);
  });
});

describe('settings: sized as Claude’s (out/settings-modal/9-measure.md)', () => {
  it('the dialog is at most 1024 x 800, 16 clear of the window; a 48 title line, a 208 column of sections', () => {
    expect(block('\n.settings-scrim')).toContain('padding: 16px');
    expect(block('\n.settings-dialog')).toContain('width: min(1024px, 100%)');
    expect(block('\n.settings-dialog')).toContain('height: min(800px, 100%)');
    expect(block('\n.settings-titlebar')).toContain('height: 48px');
    expect(block('\n.settings-nav')).toContain('width: 208px');
    expect(block('\n.settings-nav-item')).toContain('height: 32px');
  });

  it('a row’s grey line is its name’s size, 4 under it, the row 12 above and below', () => {
    expect(block('\n.settings-dialog .setting-row')).toContain('padding: 12px 16px');
    expect(block('\n.settings-dialog .setting-text')).toContain('gap: 4px');
    expect(block('.settings-dialog .setting-text > .settings-hint,\n.settings-dialog .plugin-item-desc,\n.settings-dialog .plugin-card-desc')).toContain(
      'font-size: var(--fs-body)',
    );
  });
});

describe('settings › 插件 fills the window', () => {
  it('the page is the window tall (a floor past which it scrolls again) and scrolls as a whole; a plugin’s own settings page fills the rest and scrolls itself', () => {
    const page = block('.settings-column.is-fill');
    expect(page).toContain('height: 100%');
    expect(page).toMatch(/min-height: \d+px/);
    expect(block('\n.is-fill .plugins-page')).toContain('overflow-y: auto');
    expect(block('.is-fill .plugin-detail.is-page')).toContain('flex: 1');
    expect(block('.is-fill .plugin-detail.is-page')).toContain('min-height: 0');
  });
});

describe('settings › 插件 list rows', () => {
  it('a long name is cut before the version is (the version never shrinks); the line under it is cut at its end, a card’s after two lines', () => {
    expect(block('\n.plugin-row-name')).toContain('flex: 0 1 auto');
    expect(block('\n.plugin-row-name')).toContain('text-overflow: ellipsis');
    expect(block('.plugin-item-title .plugin-version')).toContain('flex: none');
    expect(block('.plugin-item-desc')).toContain('text-overflow: ellipsis');
    expect(block('\n.plugin-card-desc')).toContain('-webkit-line-clamp: 2');
  });

  it('市场: two cards a row, one when narrow', () => {
    expect(block('.plugin-grid')).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(block('.plugins-page.is-narrow .plugin-grid')).toContain('grid-template-columns: minmax(0, 1fr)');
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
    // The detail panel is not the conversation (文字大小 does not move it).
    expect(block('.detail-list')).toContain('font-size: var(--fs-body)');
  });

  it('what a row says after its words (Failed, 已超时, the time, the clock) is the row’s size: a smaller one sits on another baseline', () => {
    // A 12 beside a 16, each centred in its own box, sits 1.5px higher at 100% and reads as off the middle.
    for (const sel of ['.fold-meta', '.detail-item-meta', 'follows. */\n.status-clock', '.confirm-undo'])
      for (const prop of ['font-size', 'line-height', 'font:']) expect(block(sel), `${sel} ${prop}`).not.toContain(prop);
    for (const sel of ['.fold-meta', '.detail-item-meta', 'follows. */\n.status-clock']) expect(block(sel), sel).toContain('color: var(--spica-faint)');
  });

  it('a row’s words centre on the icons by the font (no trim of their own); cut at the end only', () => {
    // Cut sideways only, so nothing above or below the words' box is cut.
    for (const sel of ['.fold-label', '\n.tool-text']) expect(block(sel), sel).toContain('overflow: clip visible');
    expect(block('.fold-meta')).toContain('display: block');
  });

  it('a run’s clock is one rule, after the words, in the status line and the Running … line; the words give way, not the clock', () => {
    // Its own rule (the one after its comment), not the list of a row's words it is also in.
    expect(block('follows. */\n.status-clock')).toContain('flex: none;\n  color: var(--spica-faint);\n  font-variant-numeric: tabular-nums;');
    expect(block('\n.status-text')).toContain('text-overflow: ellipsis');
    expect(block('\n.status-text')).toContain('min-width: 0');
    expect(block('.status-line')).toContain('gap: 8px');
    expect(block('.fold-head')).toContain('gap: 8px');
  });

  it('the turning mark of the row the run is on: 18 in its 14 place, in the text’s colour, not the row’s quieter one', () => {
    expect(block('.fold-icon > .fold-mark')).toContain('margin: -2px');
    expect(block('.fold-icon > .fold-mark')).toContain('color: var(--spica-ink)');
  });

  it('the time under a message and its version count are footnotes (13 on 17), one step up from a caption', () => {
    expect(block('.msg-time')).toContain('font-size: var(--fs-footnote);\n  line-height: var(--lh-footnote)');
    // How long ago (59 minutes ago) stays on one line and is never squeezed by the icons beside it.
    expect(block('.msg-time')).toContain('flex: none');
    expect(block('.msg-time')).toContain('white-space: nowrap');
    // Its own rule, not the one that lists it with the other words of a row.
    expect(css).toMatch(/\n\.msg-versions-text \{\n {2}padding: 0 2px;\n {2}font-size: var\(--fs-footnote\);\n {2}line-height: var\(--lh-footnote\);/);
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

  it('the row under it in the footnote size (13 on 17): the folder, the model, Manual / Auto', () => {
    for (const sel of ['\n.composer-chip', '\n.composer-label']) {
      expect(block(sel), sel).toContain('font-size: var(--fs-footnote)');
      expect(block(sel), sel).toContain('line-height: var(--lh-footnote)');
    }
  });
});

describe('the picture viewer', () => {
  it('‹ N of M › sits on a fade along the bottom, as in the Claude app: no panel, border or shadow under it', () => {
    expect(block('.image-viewer.has-nav::after')).toContain('linear-gradient(to bottom, transparent');
    expect(block('.image-viewer.has-nav::after')).toContain('pointer-events: none');
    for (const p of ['background', 'border', 'box-shadow']) expect(block('.image-viewer-nav'), p).not.toContain(`${p}:`);
  });
});

/**
 * Rules opened inside another rule (not inside @media / @supports / @container / @layer / @keyframes), each
 * with its line: a rule pasted into the middle of another leaves the second half of the outer one dead.
 */
function nestedRules(text: string): string[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const open: boolean[] = []; // per open block: is it an at-rule
  const found: string[] = [];
  let head = '';
  let line = 1;
  for (const ch of src) {
    if (ch === '\n') line++;
    if (ch === '{') {
      const name = head.trim();
      const atRule = name.startsWith('@');
      if (open.length > 0 && !open[open.length - 1] && !atRule) found.push(`${line}: ${name.split('\n').pop()}`);
      open.push(atRule);
      head = '';
    } else if (ch === '}') {
      open.pop();
      head = '';
    } else if (ch === ';') head = '';
    else head += ch;
  }
  return found;
}

describe('the style sheet holds together', () => {
  it('no rule is opened inside another rule', () => {
    expect(nestedRules(css)).toEqual([]);
  });

  it('the check catches a rule pasted into the middle of another, and lets @media and @keyframes through', () => {
    expect(nestedRules('.a {\n  min-width: 0;\n.b {\n  width: 1px;\n}\n  overflow: hidden;\n}\n')).toEqual(['3: .b']);
    expect(nestedRules('@media (max-width: 1px) {\n  .a { width: 1px; }\n}\n@keyframes k {\n  from { opacity: 0; }\n}\n')).toEqual([]);
  });
});
