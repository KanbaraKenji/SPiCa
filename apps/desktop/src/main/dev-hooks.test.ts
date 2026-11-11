import { describe, expect, it } from 'vitest';
import { devSwitch, documentsFolder, makeWorkflowsDirAtStart, pickedFiles, pickedFolder, recordShellTo, shellRecord, SHOTS_WORKFLOWS_DIR } from './dev-hooks';

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

describe('Explorer recorded for test scripts', () => {
  it('records instead of opening in a development build when set', () => {
    expect(recordShellTo({ SPICA_RECORD_SHELL: 'C:/rec.jsonl' }, false)).toBe('C:/rec.jsonl');
    expect(recordShellTo({}, false)).toBeNull();
    expect(shellRecord('openFolder', 'D:\\工作\\')).toBe('{"op":"openFolder","path":"D:\\\\工作\\\\"}\n');
  });

  it('never in an installed build: Explorer opens', () => {
    expect(recordShellTo({ SPICA_RECORD_SHELL: 'C:/rec.jsonl' }, true)).toBeNull();
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

describe('the demo backend and screenshot switches', () => {
  const env = { SPICA_BACKEND: 'fake', SPICA_CAPTURE: 'C:/x.png', SPICA_SHOTS: 'C:/shots' };
  it('work in a development build', () => {
    expect(devSwitch(env, false, 'SPICA_BACKEND')).toBe('fake');
    expect(devSwitch(env, false, 'SPICA_CAPTURE')).toBe('C:/x.png');
    expect(devSwitch(env, false, 'SPICA_SHOTS')).toBe('C:/shots');
    expect(devSwitch({}, false, 'SPICA_SHOTS')).toBeUndefined();
  });

  it('do nothing in an installed build: real data, no screenshot, no quitting', () => {
    expect(devSwitch(env, true, 'SPICA_BACKEND')).toBeUndefined();
    expect(devSwitch(env, true, 'SPICA_CAPTURE')).toBeUndefined();
    expect(devSwitch(env, true, 'SPICA_SHOTS')).toBeUndefined();
  });
});

describe('the workflow folder the screenshots show', () => {
  it('is a neutral one, with no user name in it', () => {
    expect(SHOTS_WORKFLOWS_DIR).not.toMatch(/Users|AppData|Temp/i);
    expect(SHOTS_WORKFLOWS_DIR).toMatch(/workflows$/);
  });
});
