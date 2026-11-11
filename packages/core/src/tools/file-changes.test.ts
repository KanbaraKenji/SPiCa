// File cards for what a call made: run_command (what changed in the folder
// while it ran), write_file / edit_file (created or modified, lines added and
// removed) and present_files (the model hands files over; made or read is
// told from the file's times).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../store/memory.ts';
import { tempDir } from '../testing/helpers.ts';
import { Tracer } from '../trace.ts';
import type { CoreEventBody, FileCardMeta } from '../types.ts';
import { createRunCommandTool } from './command-tool.ts';
import { changeLine, folderChanges, IGNORED_DIRS, ignoredFile, lineDelta, notTrackedLine, snapshotFolder } from './file-changes.ts';
import { editFileTool, presentFilesTool, writeFileTool } from './fs-tools.ts';
import type { ToolContext } from './types.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const win = process.platform === 'win32';
let dir: string;
let cleanup: () => Promise<void>;
let seen: CoreEventBody[];
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  sessionId: 's',
  parentChain: [],
  cwd: dir,
  signal: new AbortController().signal,
  tracer: new Tracer(new MemoryStore()),
  extractors: [],
  services: {},
  callId: 'c1',
  emit: (b) => void seen.push(b),
  ...extra,
});
const cards = (): FileCardMeta[] => seen.flatMap((b) => (b.type === 'file.card' ? (b.files ?? [b.file]) : []));

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  seen = [];
});
afterEach(async () => {
  await cleanup();
});

describe('what changed in a folder', () => {
  it('the ignore list: caches, version control, byte code, lock files, thumbnails', () => {
    for (const d of ['node_modules', '.git', '__pycache__', '.venv']) expect(IGNORED_DIRS.has(d)).toBe(true);
    for (const f of ['a.pyc', '~$报价.xlsx', '.~lock.a.odt#', 'Thumbs.db', 'desktop.ini', '.DS_Store', 'x.tmp']) expect(ignoredFile(f)).toBe(true);
    for (const f of ['报价.xlsx', 'run.log', 'out.csv', 'dist.zip']) expect(ignoredFile(f)).toBe(false);
  });

  it('finds new and changed files, leaves ignored ones out, and gives up on folders over the limit', async () => {
    await writeFile(join(dir, 'keep.txt'), 'a');
    await writeFile(join(dir, 'change.txt'), 'a');
    const before = await snapshotFolder(dir);
    await mkdir(join(dir, 'sub', 'node_modules'), { recursive: true });
    await writeFile(join(dir, 'sub', 'new.csv'), 'x,y');
    await writeFile(join(dir, 'sub', 'node_modules', 'lib.js'), '');
    await writeFile(join(dir, 'b.pyc'), '');
    await writeFile(join(dir, 'change.txt'), 'abc');
    const changes = folderChanges(before, await snapshotFolder(dir));
    expect(changes).toEqual({ created: [join(dir, 'sub', 'new.csv')], modified: [join(dir, 'change.txt')] });
    expect(changeLine(changes, (p) => p.slice(dir.length + 1))).toBe(
      `[changed in the folder while the command ran (other programs may have changed some too): created ${join('sub', 'new.csv')}; modified change.txt]`,
    );
    expect((await snapshotFolder(dir, { maxFiles: 2 })).skipped).toBe('too_many');
  });

  it('gives up on a folder that is slow to list, and says which of the two it was', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    let t = 0;
    const slow = await snapshotFolder(dir, { maxMs: 1000, now: () => (t += 600) }); // every look at the clock: 0.6 s later
    expect(slow).toMatchObject({ skipped: 'too_slow', files: new Map() });
    expect((await snapshotFolder(dir)).skipped).toBeUndefined();
    expect(notTrackedLine('too_slow', 'before')).toBe('[changes in the folder not tracked: listing the folder took more than 1 s]');
    expect(notTrackedLine('too_slow', 'after')).toBe('[changes in the folder not tracked: listing the folder after the command took more than 1 s]');
    expect(notTrackedLine('too_many', 'before')).toBe('[changes in the folder not tracked: the folder has more than 20000 files]');
    expect(notTrackedLine('too_many', 'after')).toBe('[changes in the folder not tracked: the folder has more than 20000 files now]');
  });

  it('counts lines added and removed, order ignored', () => {
    expect(lineDelta('', 'a\nb\n')).toEqual({ added: 2, removed: 0 });
    expect(lineDelta('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 });
    expect(lineDelta('a\r\nb\r\n', 'a\nb\n')).toEqual({ added: 0, removed: 0 });
  });
});

describe('cards for files a call made', () => {
  it('run_command: what appeared or changed while it ran, also told to the model', async () => {
    await writeFile(join(dir, 'old.txt'), 'a');
    const tool = createRunCommandTool();
    const r = await tool.execute(
      { command: win ? "Set-Content -Path out.txt -Value 'hi'; Add-Content -Path old.txt -Value 'more'" : "printf hi > out.txt; printf more >> old.txt" },
      ctx(),
    );
    expect(r.isError).toBe(false);
    expect(cards().map((c) => [c.name, c.origin])).toEqual([
      ['out.txt', 'created'],
      ['old.txt', 'modified'],
    ]);
    expect(r.content).toContain('created out.txt; modified old.txt');
  });

  it('run_command that only reads: no cards and no changed line', async () => {
    await writeFile(join(dir, 'chart.png'), 'x');
    await writeFile(join(dir, 'notes.txt'), 'line');
    const tool = createRunCommandTool();
    const r = await tool.execute(
      {
        command: win
          ? "Get-Content notes.txt; [IO.File]::ReadAllBytes((Join-Path (Get-Location) 'chart.png')).Length; Get-ChildItem | Out-String"
          : 'cat notes.txt; wc -c chart.png; ls -l',
      },
      ctx(),
    );
    expect(r.isError).toBe(false);
    expect(cards()).toEqual([]);
    expect(r.content).not.toContain('changed in the folder');
  });

  it('run_command: a folder that grows past the limit while it runs is said to be not tracked', async () => {
    const tool = createRunCommandTool();
    const r = await tool.execute(
      { command: win ? '1..20050 | ForEach-Object { New-Item -ItemType File -Path "f$_.txt" | Out-Null }' : 'for i in $(seq 1 20050); do : > "f$i.txt"; done' },
      ctx(),
    );
    expect(r.content).toContain('changes in the folder not tracked: the folder has more than 20000 files now');
    expect(cards()).toEqual([]);
  }, 120_000);

  it('write_file and edit_file: created or modified, with lines added and removed', async () => {
    await writeFileTool.execute({ path: 'a.md', content: 'one\ntwo\n' }, ctx());
    await writeFileTool.execute({ path: 'a.md', content: 'one\nthree\nfour\n' }, ctx());
    await editFileTool.execute({ path: 'a.md', old_string: 'four', new_string: 'four\nfive' }, ctx());
    expect(cards().map((c) => [c.origin, c.lines, c.kind])).toEqual([
      ['created', { added: 2, removed: 0 }, 'text'],
      ['modified', { added: 2, removed: 1 }, 'text'],
      ['modified', { added: 1, removed: 0 }, 'text'],
    ]);
    expect(cards()[0]!.path).toBe(join(dir, 'a.md'));
  });

  it('present_files: made in this round, changed in this round, or only read; missing ones are told', async () => {
    await writeFile(join(dir, 'old.pdf'), 'x');
    await writeFile(join(dir, 'touched.xlsx'), 'x');
    await new Promise((r) => setTimeout(r, 30));
    const roundStartedAt = new Date().toISOString(); // the user writes now; the two files are older
    await new Promise((r) => setTimeout(r, 30));
    await writeFile(join(dir, 'new.png'), 'x');
    await writeFile(join(dir, 'touched.xlsx'), 'xy');
    const r = await presentFilesTool.execute({ paths: ['new.png', 'old.pdf', join(dir, 'touched.xlsx'), 'gone.txt', 'new.png'] }, ctx({ roundStartedAt }));
    const got = Object.fromEntries(cards().map((c) => [c.name, [c.origin, c.kind]]));
    expect(got['new.png']).toEqual(['created', 'other']);
    expect(got['touched.xlsx']).toEqual(['modified', 'xlsx']);
    expect(got['old.pdf']).toEqual(['read', 'pdf']); // only read: never shown as made
    expect(cards()).toHaveLength(3); // the same file twice is one card
    expect(r.content).toContain('Not found: gone.txt');
    expect(presentFilesTool.readOnly).toBe(true);
    expect((await presentFilesTool.execute({ paths: ['gone.txt'] }, ctx({ roundStartedAt }))).isError).toBe(true);
    const folder = await presentFilesTool.execute({ paths: ['.'] }, ctx({ roundStartedAt }));
    expect(folder).toMatchObject({ isError: true, content: expect.stringContaining('Not files (folders') });
  });
});
