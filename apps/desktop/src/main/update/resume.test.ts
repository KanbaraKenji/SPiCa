import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readResume, RESUME_FOR_MS, writeResume } from './resume';

const file = () => join(mkdtempSync(join(tmpdir(), 'spica-resume-')), 'update-resume.json');

describe('resume after an update', () => {
  it('gives back the conversation once, then the note is gone', () => {
    const f = file();
    writeResume(f, { sessionId: 's-1' }, 1000);
    expect(readResume(f, 2000)).toEqual({ sessionId: 's-1' });
    expect(existsSync(f)).toBe(false);
    expect(readResume(f, 2000)).toBeNull();
  });

  it('no conversation open: the new version still opens on what it was (null), not 新对话', () => {
    const f = file();
    writeResume(f, { sessionId: null }, 1000);
    expect(readResume(f, 1000)).toEqual({ sessionId: null });
  });

  it('too old, from the future, or not a note: not used, and removed', () => {
    const old = file();
    writeResume(old, { sessionId: 's-1' }, 0);
    expect(readResume(old, RESUME_FOR_MS + 1)).toBeNull();
    expect(existsSync(old)).toBe(false);
    const ahead = file();
    writeResume(ahead, { sessionId: 's-1' }, 5000);
    expect(readResume(ahead, 1000)).toBeNull();
    const junk = file();
    writeFileSync(junk, '{ nope');
    expect(readResume(junk)).toBeNull();
    expect(existsSync(junk)).toBe(false);
  });
});
