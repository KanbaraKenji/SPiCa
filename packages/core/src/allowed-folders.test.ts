// The folders allowed on a card (始终允许): taken back by the agent with allowed_folders when the user asks, after
// which the next write there asks again; a drive's root or the home folder is never kept, and its card says so.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir } from './testing/helpers.ts';
import { allowedFoldersTool } from './tools/folder-tools.ts';
import { editFileTool, writeFileTool } from './tools/fs-tools.ts';
import { realPath } from './write-scope.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
let root: string;
let cleanup: () => Promise<void>;
let work: string;
let outside: string;
let other: string;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir: root, cleanup } = await tempDir());
  work = join(root, 'work');
  outside = join(root, 'minutes');
  other = join(root, 'drafts');
  for (const d of [work, outside, other]) await mkdir(d);
  await writeFile(join(outside, 'a.md'), 'old\n');
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

function setup() {
  const rt = makeRuntime(gw, { tools: [writeFileTool, editFileTool, allowedFoldersTool] });
  const events = captureEvents(rt);
  const s = rt.createSession({ cwd: work, approvalMode: 'auto' });
  return { rt, events, s };
}

/** Writes `file`, allowing its folder for good on the card (始终允许). */
async function allowFor(s: ReturnType<typeof setup>['s'], file: string, id: string) {
  gw.enqueue({ toolCalls: [{ id, name: 'write_file', args: { path: file, content: id } }] });
  expect((await s.send('write it').done).reason).toBe('awaiting_confirm');
  gw.enqueue({ text: 'ok' });
  await (await s.confirm(id, true, { allowFolder: true }))!;
  expect(await readFile(file, 'utf8')).toBe(id);
}

const lastResult = (s: ReturnType<typeof setup>['s'], id: string): string => {
  for (const m of s.messages())
    for (const b of m.content) if (b.type === 'tool_result' && b.toolUseId === id) return b.content;
  return '';
};

describe('allowed_folders', () => {
  it('lists the folders allowed on a card, and nothing else (not the working folder)', async () => {
    const { s } = setup();
    gw.enqueue({ toolCalls: [{ id: 'l0', name: 'allowed_folders', args: { action: 'list' } }] }, { text: 'none' });
    await s.send('which folders?').done;
    expect(lastResult(s, 'l0')).toContain('No folder has been allowed');
    await allowFor(s, join(outside, 'b.md'), 'w1');
    gw.enqueue({ toolCalls: [{ id: 'l1', name: 'allowed_folders', args: { action: 'list' } }] }, { text: 'one' });
    await s.send('which folders?').done;
    expect(lastResult(s, 'l1')).toContain(realPath(outside));
    expect(lastResult(s, 'l1')).not.toContain(realPath(work));
  });

  it('revoke: taken back without a card; the next write there asks again', async () => {
    const { events, s } = setup();
    await allowFor(s, join(outside, 'b.md'), 'w1');
    // allowed: the next write runs without asking
    gw.enqueue({ toolCalls: [{ id: 'w2', name: 'write_file', args: { path: join(outside, 'c.md'), content: 'c' } }] }, { text: 'done' });
    expect((await s.send('again').done).reason).toBe('completed');
    const asked = events.filter((e) => e.type === 'confirm.request').length;
    // taken back (named as the user might, other case and a trailing separator): no card for that
    const named = `${outside.toUpperCase()}\\`;
    gw.enqueue({ toolCalls: [{ id: 'r1', name: 'allowed_folders', args: { action: 'revoke', folder: named } }] }, { text: 'taken back' });
    expect((await s.send('ask me before writing there').done).reason).toBe('completed');
    expect(events.filter((e) => e.type === 'confirm.request')).toHaveLength(asked);
    expect(lastResult(s, 'r1')).toContain('will ask the user again');
    expect(s.allowedWriteFolders()).toEqual([]);
    // the next write there: the card again, and nothing written
    gw.enqueue({ toolCalls: [{ id: 'w3', name: 'write_file', args: { path: join(outside, 'd.md'), content: 'd' } }] });
    expect((await s.send('write once more').done).reason).toBe('awaiting_confirm');
    expect(events.filter((e) => e.type === 'confirm.request').at(-1)).toMatchObject({ cause: 'outside_folder', outsideFolder: realPath(outside) });
    await expect(readFile(join(outside, 'd.md'), 'utf8')).rejects.toThrow();
  });

  it('revoke all: every allowed folder taken back', async () => {
    const { s } = setup();
    await allowFor(s, join(outside, 'b.md'), 'w1');
    await allowFor(s, join(other, 'x.md'), 'w2');
    expect(s.allowedWriteFolders()).toHaveLength(2);
    gw.enqueue({ toolCalls: [{ id: 'r1', name: 'allowed_folders', args: { action: 'revoke', all: true } }] }, { text: 'ok' });
    await s.send('undo every always-allow').done;
    expect(s.allowedWriteFolders()).toEqual([]);
    expect(lastResult(s, 'r1')).toContain(realPath(outside));
    expect(lastResult(s, 'r1')).toContain(realPath(other));
  });

  it('a folder that was not allowed: an error that lists the allowed ones; nothing changes', async () => {
    const { s } = setup();
    await allowFor(s, join(outside, 'b.md'), 'w1');
    gw.enqueue({ toolCalls: [{ id: 'r1', name: 'allowed_folders', args: { action: 'revoke', folder: other } }] }, { text: 'ok' });
    await s.send('take back drafts').done;
    expect(lastResult(s, 'r1')).toContain('is not one of the folders allowed');
    expect(s.allowedWriteFolders()).toEqual([realPath(outside)]);
  });

  it('cannot allow: an unknown action is an error and nothing is added', async () => {
    const { s } = setup();
    gw.enqueue({ toolCalls: [{ id: 'r1', name: 'allowed_folders', args: { action: 'allow', folder: other } }] }, { text: 'ok' });
    await s.send('allow drafts').done;
    expect(lastResult(s, 'r1')).toContain('action must be');
    expect(s.allowedWriteFolders()).toEqual([]);
  });

  it('a sub-agent takes back for the whole conversation', async () => {
    const { rt, s } = setup();
    await allowFor(s, join(outside, 'b.md'), 'w1');
    const child = rt.createSession({ parentId: s.id, cwd: work, approvalMode: 'auto' });
    expect(child.allowedWriteFolders()).toEqual([realPath(outside)]);
    gw.enqueue({ toolCalls: [{ id: 'r1', name: 'allowed_folders', args: { action: 'revoke', all: true } }] }, { text: 'ok' });
    await child.send('undo it').done;
    expect(s.allowedWriteFolders()).toEqual([]);
  });

  it('still writable for another reason (a path the user typed): taken back, and the result says it still is', async () => {
    const { s } = setup();
    await allowFor(s, join(outside, 'b.md'), 'w1');
    gw.enqueue({ text: 'noted' });
    await s.send(`the minutes are in ${outside}`).done;
    gw.enqueue({ toolCalls: [{ id: 'r1', name: 'allowed_folders', args: { action: 'revoke', folder: outside } }] }, { text: 'ok' });
    await s.send('undo it').done;
    expect(lastResult(s, 'r1')).toContain('still writable without asking');
  });
});

describe('a drive’s root or the home folder', () => {
  it('the card says the folder cannot be kept; an ordinary folder’s card does not', async () => {
    const { events, s } = setup();
    gw.enqueue({ toolCalls: [{ id: 'h1', name: 'write_file', args: { path: join(homedir(), 'spica-test-never-written.txt'), content: 'x' } }] });
    await s.send('write to home').done;
    expect(events.find((e) => e.type === 'confirm.request')).toMatchObject({ outsideFolder: realPath(homedir()), folderTooWide: true });
    expect(s.pending()[0]).toMatchObject({ folderTooWide: true });
    gw.enqueue({ text: 'ok' });
    await (await s.confirm('h1', false))!;
    gw.enqueue({ toolCalls: [{ id: 'w1', name: 'write_file', args: { path: join(outside, 'b.md'), content: 'b' } }] });
    await s.send('write there').done;
    const req = events.filter((e) => e.type === 'confirm.request').at(-1) as { folderTooWide?: boolean };
    expect(req.folderTooWide).toBeUndefined();
  });
});
