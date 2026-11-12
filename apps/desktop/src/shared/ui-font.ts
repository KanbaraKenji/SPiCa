// The interface font, in one place for the window (styles.css), the small dialog window (renderer/dialog/dialog.css)
// and plugin pages (main/plugin-views.ts themeCss). styles.css and dialog.css carry UI_FONT_FACES word for word
// (renderer-styles.test.ts checks), the plugin pages get it injected with their theme.
//
// Why: Segoe UI's line box is 1.08 of the size above the baseline and 0.25 below (room for accents over capitals),
// so anything centred by its line box drew its capitals, digits and Chinese (YaHei's glyphs on Segoe's baseline)
// about 0.065 of the size low: 1-1.75px at 14-16px, measured in out/settings-modal/13-centre-audit.md. The same
// fonts are wrapped here with their ascent and descent set so that ascent − descent is the capitals' height (0.70):
// 101.5% + 31.5% = 133%, the same total as before, so no line gets taller or shorter; only where the glyphs sit in
// it moves, about 1px up, and they come out on the middle line of whatever they are centred in.
//
// 'Spica UI' is Windows 11's Segoe UI Variable (one face, every weight); where it is not installed that family has
// no font and the next one, 'Spica UI Static', is the classic Segoe UI's own faces (Windows 10). Where neither is
// there the stack goes on to the plain names, exactly as before the fix.

const METRICS = 'ascent-override: 101.5%; descent-override: 31.5%;';

const face = (family: string, src: string, weight: string) =>
  `@font-face { font-family: '${family}'; src: ${src}; font-weight: ${weight}; ${METRICS} }`;

export const UI_FONT_FACES = [
  face('Spica UI', "local('Segoe UI Variable Text')", '100 900'),
  face('Spica UI Static', "local('Segoe UI Light')", '300'),
  face('Spica UI Static', "local('Segoe UI')", '400'),
  face('Spica UI Static', "local('Segoe UI Semibold')", '600'),
  face('Spica UI Static', "local('Segoe UI Bold')", '700'),
].join('\n');

export const UI_FONT_FAMILY =
  "'Spica UI', 'Spica UI Static', 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif";
