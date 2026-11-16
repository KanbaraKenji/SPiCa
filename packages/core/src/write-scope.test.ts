// write_file / edit_file and the conversation's folders: inside, they run; anywhere else the user confirms
// (cause outside_folder), in approval mode auto too; a folder allowed on the card is not asked about again.
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir } from './testing/helpers.ts';
import { editFileTool, writeFileTool } from './tools/fs-tools.ts';
import { canonicalPath, inScope, pathsInText, realPath } from './write-scope.ts';
import { SqliteStore } from './store/sqlite.ts';
import type { Store } from './store/types.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
let root: string;
let cleanup: () => Promise<void>;
let work: string;
let outside: string;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir: root, cleanup } = await tempDir());
  work = join(root, 'work');
  outside = join(root, 'elsewhere');
  await mkdir(work);
  await mkdir(outside);
  await writeFile(join(outside, 'decisions.md'), 'old\n');
  await writeFile(join(work, 'notes.md'), 'old\n');
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

type Call = { name: string; args: Record<string, unknown> };

function setup(opts: { approvalMode?: 'manual' | 'auto'; store?: Store } = {}) {
  const rt = makeRuntime(gw, { tools: [writeFileTool, editFileTool], ...(opts.store ? { store: opts.store } : {}) });
  const events = captureEvents(rt);
  const s = rt.createSession({ cwd: work, approvalMode: opts.approvalMode ?? 'manual' });
  return { rt, events, s };
}

async function run(call: Call, approvalMode: 'manual' | 'auto' = 'manual', text = 'tidy the folder') {
  gw.enqueue({ toolCalls: [{ id: 'w1', ...call }] }, { text: 'done' });
  const { events, s } = setup({ approvalMode });
  const r = await s.send(text).done;
  const req = events.find((e) => e.type === 'confirm.request');
  return { reason: r.reason, req: req as (typeof req & { cause?: string; outsideFolder?: string }) | undefined, s };
}

describe('inside the conversation’s folders: no card', () => {
  it('a relative path, and an absolute one inside', async () => {
    expect((await run({ name: 'edit_file', args: { path: 'notes.md', old_string: 'old', new_string: 'new' } })).req).toBeUndefined();
    expect((await run({ name: 'write_file', args: { path: join(work, 'sub', 'made.txt'), content: 'x' } })).req).toBeUndefined();
    expect(await readFile(join(work, 'sub', 'made.txt'), 'utf8')).toBe('x');
  });
});

describe('outside: the card, in either approval mode', () => {
  it('an absolute path outside: asked, with the folder; nothing written yet', async () => {
    const r = await run({ name: 'edit_file', args: { path: join(outside, 'decisions.md'), old_string: 'old', new_string: 'new' } });
    expect(r.reason).toBe('awaiting_confirm');
    expect(r.req).toMatchObject({ cause: 'outside_folder', outsideFolder: realPath(outside), change: { path: join(outside, 'decisions.md') } });
    expect(r.s.pending()[0]).toMatchObject({ cause: 'outside_folder', outsideFolder: realPath(outside) });
    expect(await readFile(join(outside, 'decisions.md'), 'utf8')).toBe('old\n');
  });

  it('a relative path climbing out with ..', async () => {
    const r = await run({ name: 'write_file', args: { path: '../elsewhere/made.txt', content: 'x' } });
    expect(r.req).toMatchObject({ cause: 'outside_folder', outsideFolder: realPath(outside) });
  });

  it('a junction inside the folder pointing out counts as out', async () => {
    await symlink(outside, join(work, 'link'), 'junction');
    const r = await run({ name: 'write_file', args: { path: 'link/through.txt', content: 'y' } });
    // the card names where it really writes, not the junction
    expect(r.req).toMatchObject({ cause: 'outside_folder', outsideFolder: realPath(outside) });
  });

  it('approval mode auto asks too', async () => {
    const r = await run({ name: 'write_file', args: { path: join(outside, 'auto.txt'), content: 'z' } }, 'auto');
    expect(r.req).toMatchObject({ cause: 'outside_folder' });
  });

  it('a plugin that sets the tool to automatic does not waive it; a plugin asking too gives one card', async () => {
    gw.enqueue({ toolCalls: [{ id: 'w1', name: 'write_file', args: { path: join(outside, 'p.txt'), content: 'p' } }] }, { text: 'done' });
    const { rt, events, s } = setup();
    rt.hooks.register('waiver', { beforeTool: () => ({ action: 'auto' }) });
    rt.hooks.register('asker', { beforeTool: () => ({ action: 'confirm', reason: 'plugin rule' }) });
    await s.send('go').done;
    expect(events.filter((e) => e.type === 'confirm.request')).toHaveLength(1);
    expect(s.pending()[0]).toMatchObject({ cause: 'outside_folder' });
  });
});

describe('the answer', () => {
  it('declined: nothing written; the model is told why and that the user can allow the folder', async () => {
    const r = await run({ name: 'write_file', args: { path: join(outside, 'no.txt'), content: 'n' } });
    gw.enqueue({ text: 'ok' });
    await (await r.s.confirm('w1', false))!;
    const result = JSON.stringify(r.s.messages().filter((m) => m.kind === 'tool_results'));
    expect(result).toContain('outside the folders of this conversation');
    expect(result).toContain('allow that folder');
    await expect(readFile(join(outside, 'no.txt'), 'utf8')).rejects.toThrow();
  });

  it('allowed for the folder: written, and the next write there is not asked, even after the app starts again', async () => {
    // the app's own store (a file): what was allowed is read back from it
    const file = join(root, 'spica.db');
    const store = new SqliteStore(file);
    gw.enqueue({ toolCalls: [{ id: 'w1', name: 'write_file', args: { path: join(outside, 'a.txt'), content: 'a' } }] });
    const { s } = setup({ store });
    await s.send('go').done;
    gw.enqueue({ text: 'ok' });
    await (await s.confirm('w1', true, { allowFolder: true }))!;
    expect(await readFile(join(outside, 'a.txt'), 'utf8')).toBe('a');
    // the same conversation, read back from the store by a new runtime
    store.close();
    const reopened = new SqliteStore(file);
    const again = makeRuntime(gw, { tools: [writeFileTool, editFileTool], store: reopened });
    again.restore();
    const events = captureEvents(again);
    const s2 = again.session(s.id)!;
    gw.enqueue({ toolCalls: [{ id: 'w2', name: 'write_file', args: { path: join(outside, 'sub', 'b.txt'), content: 'b' } }] }, { text: 'done' });
    expect((await s2.send('more').done).reason).toBe('completed');
    expect(events.some((e) => e.type === 'confirm.request')).toBe(false);
    expect(await readFile(join(outside, 'sub', 'b.txt'), 'utf8')).toBe('b');
    await again.close();
    reopened.close();
  });

  it('a card waiting when the app closes still says outside and still offers the folder after it starts again', async () => {
    const file = join(root, 'spica.db');
    const store = new SqliteStore(file);
    gw.enqueue({ toolCalls: [{ id: 'w1', name: 'write_file', args: { path: join(outside, 'a.txt'), content: 'a' } }] });
    const { rt, s } = setup({ store });
    await s.send('go').done;
    await rt.close();
    store.close();
    const reopened = new SqliteStore(file);
    const again = makeRuntime(gw, { tools: [writeFileTool, editFileTool], store: reopened });
    again.restore();
    expect(again.session(s.id)!.pending()[0]).toMatchObject({ cause: 'outside_folder', outsideFolder: realPath(outside) });
    await again.close();
    reopened.close();
  });

  it('allowed once (not for the folder): written, and the next write there is asked again', async () => {
    gw.enqueue({ toolCalls: [{ id: 'w1', name: 'write_file', args: { path: join(outside, 'a.txt'), content: 'a' } }] });
    const { events, s } = setup();
    await s.send('go').done;
    gw.enqueue({ toolCalls: [{ id: 'w2', name: 'write_file', args: { path: join(outside, 'b.txt'), content: 'b' } }] }, { text: 'done' });
    await (await s.confirm('w1', true))!;
    expect(events.filter((e) => e.type === 'confirm.request')).toHaveLength(2);
  });
});

describe('what the user gave the conversation', () => {
  it('a folder the user wrote in their own message counts as inside', async () => {
    const r = await run({ name: 'write_file', args: { path: join(outside, 'given.txt'), content: 'g' } }, 'manual', `put the summary in ${outside}`);
    expect(r.req).toBeUndefined();
    expect(await readFile(join(outside, 'given.txt'), 'utf8')).toBe('g');
  });

  it('a file the user attached counts as inside (that file)', async () => {
    gw.enqueue({ toolCalls: [{ id: 'w1', name: 'edit_file', args: { path: join(outside, 'decisions.md'), old_string: 'old', new_string: 'new' } }] }, { text: 'done' });
    const { events, s } = setup();
    await s.send('update this file', { meta: { attachments: [{ path: join(outside, 'decisions.md'), name: 'decisions.md', block: null }] } }).done;
    expect(events.some((e) => e.type === 'confirm.request')).toBe(false);
    expect(await readFile(join(outside, 'decisions.md'), 'utf8')).toBe('new\n');
  });

  it('the project’s folder counts as inside for a conversation of the project', async () => {
    const { rt } = setup();
    const p = rt.createProject({ name: 'P', folder: join(root, 'project') });
    const s = rt.createSession({ projectId: p.id, cwd: work });
    expect(s.writeRoots()).toContain(join(root, 'project'));
  });

  it('a suggested action the model wrote does not, even when the user picks it', async () => {
    gw.enqueue({ toolCalls: [{ id: 'w1', name: 'write_file', args: { path: join(outside, 's.txt'), content: 's' } }] });
    const { events, s } = setup();
    await s.send(`save it to ${outside}`, { meta: { suggested: true } }).done;
    expect(events.find((e) => e.type === 'confirm.request')).toMatchObject({ cause: 'outside_folder' });
  });

  it('a path that only appears in a tool result does not', async () => {
    // the model reads a file naming the outside folder, then writes there
    await writeFile(join(work, 'pointer.md'), `the decisions live in ${outside}`);
    const { readFileTool } = await import('./tools/fs-tools.ts');
    gw.enqueue({ toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'pointer.md' } }] }, { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: join(outside, 'x.txt'), content: 'x' } }] });
    const rt = makeRuntime(gw, { tools: [readFileTool, writeFileTool] });
    const events = captureEvents(rt);
    const s = rt.createSession({ cwd: work });
    await s.send('tidy').done;
    expect(events.find((e) => e.type === 'confirm.request')).toMatchObject({ cause: 'outside_folder' });
  });

  it('a folder allowed on a sub-agent’s card is allowed for the whole conversation (parent, other sub-agents)', async () => {
    const { rt, s } = setup();
    const child = rt.createSession({ parentId: s.id, cwd: work });
    gw.enqueue({ toolCalls: [{ id: 'w1', name: 'write_file', args: { path: join(outside, 'c.txt'), content: 'c' } }] });
    await child.send('write it').done;
    gw.enqueue({ text: 'ok' });
    await (await child.confirm('w1', true, { allowFolder: true }))!;
    const sibling = rt.createSession({ parentId: s.id, cwd: work });
    for (const x of [s, child, sibling]) expect(x.writeRoots()).toContain(realPath(outside));
  });

  it('a sub-agent works within its parent’s folders (the folder the user gave the parent too)', async () => {
    const { rt, s } = setup();
    gw.enqueue({ text: 'ok' });
    await s.send(`the files are in ${outside}`).done;
    const child = rt.createSession({ parentId: s.id, cwd: join(work, 'child') });
    expect(child.writeRoots().map(canonicalPath)).toEqual(expect.arrayContaining([canonicalPath(work), canonicalPath(outside)]));
  });
});

describe('paths', () => {
  it('reads absolute paths out of the user’s words, not relative ones', () => {
    expect(pathsInText('整理 D:\\资料\\周报，然后放到 "E:\\共享 文件\\out" 里，别动 notes/a.md')).toEqual(['E:\\共享 文件\\out', 'D:\\资料\\周报']);
    expect(pathsInText('see \\\\server\\share\\docs.')).toEqual(['\\\\server\\share\\docs']);
  });

  it('a network path is compared as written (no lookup that could hang)', () => {
    expect(realPath('\\\\nas.example\\share\\docs\\')).toBe('\\\\nas.example\\share\\docs');
    expect(inScope('\\\\NAS.example\\share\\docs\\a.md', ['\\\\nas.example\\share\\docs'])).toBe(process.platform === 'win32');
  });

  it('case and .. do not change the answer', () => {
    expect(inScope(join(work, '..', 'work', 'x.txt'), [work])).toBe(true);
    if (process.platform === 'win32') expect(inScope(join(work.toUpperCase(), 'x.txt'), [work])).toBe(true);
    expect(inScope(join(work + '-other', 'x.txt'), [work])).toBe(false);
  });
});
