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
});
