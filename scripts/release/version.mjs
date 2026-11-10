// Work out the next release version for release:prepare.
//
// An exact target (0.1.0-rc.3, 0.1.0, v0.2.0) is taken as given, whatever the
// current version looks like: prerelease to prerelease and prerelease to final
// both work. patch / minor / major count up from the current version and need
// it to be a plain x.y.z, because "the next patch" of 0.1.0-rc.2 is ambiguous;
// give the exact version instead.

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const KEYWORDS = new Set(['major', 'minor', 'patch']);

/**
 * @param {string} current version now in apps/desktop/package.json
 * @param {string} wanted the command-line argument
 * @returns {{ next: string } | { error: string }}
 */
export function nextVersion(current, wanted) {
  let next;
  if (KEYWORDS.has(wanted)) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
    if (!m) {
      return {
        error: `"${wanted}" counts up from a plain x.y.z, but the current version is "${current}"; give the exact version instead (for example 0.2.0).`,
      };
    }
    const [maj, min, pat] = m.slice(1).map(Number);
    next =
      wanted === 'major' ? `${maj + 1}.0.0` : wanted === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
  } else {
    next = wanted.replace(/^v/, '');
    if (!VERSION.test(next)) return { error: `"${wanted}" is not a version like 0.2.0 or 0.2.0-rc.1.` };
  }
  if (next === current) return { error: `version is already ${current}.` };
  return { next };
}
