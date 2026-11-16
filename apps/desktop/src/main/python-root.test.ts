// The app's own Python lives in %LOCALAPPDATA%\<name>\python on an installed copy, and the uninstaller removes
// that folder and nothing else: the two places must name the same folder.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const desktop = join(import.meta.dirname, '..', '..');

describe('where the app’s Python goes, and what uninstalling removes', () => {
  it('main/index.ts and the uninstaller name the same folder under %LOCALAPPDATA%', () => {
    const main = readFileSync(join(desktop, 'src', 'main', 'index.ts'), 'utf8');
    expect(main).toContain("join(process.env.LOCALAPPDATA, APP_NAME, 'python')");
    const nsh = readFileSync(join(desktop, 'resources', 'installer', 'finish-options.nsh'), 'utf8');
    const un = nsh.slice(nsh.indexOf('!macro customUnInstall'));
    expect(un).toContain(String.raw`RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}\python"`);
    // only that folder: no other RMDir in the uninstaller (settings and conversations stay)
    expect(un.match(/RMDir/g)).toHaveLength(1);
    // and not when an update runs the old uninstaller
    expect(un.indexOf('RMDir')).toBeGreaterThan(un.indexOf('${ifNot} ${isUpdated}'));
  });
});
