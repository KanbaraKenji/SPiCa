import { describe, expect, it } from 'vitest';
import { pickedFiles, pickedFolder } from './dev-hooks';

describe('picker answers for test scripts', () => {
  const env = { SPICA_PICK_FOLDER: 'C:/demo', SPICA_PICK_FILES: 'C:/a.png;C:/b.png;' };

  it('answer in a development build when set', () => {
    expect(pickedFolder(env, false)).toBe('C:/demo');
    expect(pickedFiles(env, false)).toEqual(['C:/a.png', 'C:/b.png']);
    expect(pickedFolder({}, false)).toBeNull();
    expect(pickedFiles({}, false)).toBeNull();
  });

  it('never in an installed build, even when the environment sets them', () => {
    expect(pickedFolder(env, true)).toBeNull();
    expect(pickedFiles(env, true)).toBeNull();
  });
});
