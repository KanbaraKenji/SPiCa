import { describe, expect, it } from 'vitest';
import { documentsFolder, makeWorkflowsDirAtStart, pickedFiles, pickedFolder } from './dev-hooks';

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

describe('文档 for a development run on another settings folder', () => {
  const ud = 'C:\\temp\\spica-test';
  it('moves into that folder (SPICA_USER_DATA, or the screenshots’ own)', () => {
    expect(documentsFolder({ SPICA_USER_DATA: ud }, false, false, ud)).toBe('C:\\temp\\spica-test\\Documents');
    expect(documentsFolder({}, false, true, '/tmp/spica-shots-1/')).toBe('/tmp/spica-shots-1/Documents');
  });

  it('stays the system’s otherwise, and always in an installed build', () => {
    expect(documentsFolder({}, false, false, ud)).toBeNull();
    expect(documentsFolder({ SPICA_USER_DATA: ud }, true, false, ud)).toBeNull();
  });
});

describe('the default workflow folder at start', () => {
  it('made by an installed build while no other folder is set; never by a development run', () => {
    expect(makeWorkflowsDirAtStart(true, '')).toBe(true);
    expect(makeWorkflowsDirAtStart(true, 'D:\\流程')).toBe(false);
    expect(makeWorkflowsDirAtStart(false, '')).toBe(false);
  });
});
