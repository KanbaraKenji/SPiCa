// Reading in another project's folder (a sub-project's too) asks, with 始终允许 / 允许一次 as a write outside does;
// the conversation's own project, its sub-projects and its own folders are read as before; allowed_folders lists
// and takes back what was allowed for reading.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir } from './testing/helpers.ts';
import { allowedFoldersTool } from './tools/folder-tools.ts';
import { fileTools } from './tools/fs-tools.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
let root: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir: root, cleanup } = await tempDir());
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

async function setup() {
  const rt = makeRuntime(gw, { cwd: root, tools: [...fileTools, allowedFoldersTool] });
  const events = captureEvents(rt);
  const models = rt.createProject({ name: 'Models', manager: false });
  const t1 = rt.createProject({ name: 'T1', parentId: models.id });
  const t10 = rt.createProject({ name: 'T10', parentId: models.id });
  const lamp = rt.createProject({ name: 'Lamp' });
  const part = rt.createProject({ name: 'Part', parentId: lamp.id });
  for (const p of [models, t1, t10, lamp, part]) await writeFile(join(p.folder, 'notes.md'), `${p.name}\n`);
  await mkdir(join(root, 'plain'));
  await writeFile(join(root, 'plain', 'x.md'), 'x\n');
  return { rt, events, models, t1, t10, lamp, part };
}

const asks = (events: ReturnType<typeof captureEvents>) => events.filter((e) => e.type === 'confirm.request') as unknown as { cause?: string; outsideFolder?: string; callId: string }[];

async function read(s: { send(t: string): { done: Promise<{ reason: string }> } }, path: string, id: string, name = 'read_file') {
  gw.enqueue({ toolCalls: [{ id, name, args: name === 'grep' ? { path, pattern: '.' } : name === 'glob' ? { path, pattern: '**/*.md' } : { path } }] }, { text: 'read' });
  return (await s.send(`read ${id}`).done).reason;
}

describe('reading in another project’s folder', () => {
  it('a sub-project reading its sibling, or its project above, asks; its own folder does not; T1 is not T10', async () => {
    const { rt, events, t1, t10, models } = await setup();
    const pm = rt.session(t1.managerSessionId)!;
    expect(await read(pm, join(t1.folder, 'notes.md'), 'own')).toBe('completed');
    expect(asks(events)).toHaveLength(0);
    expect(await read(pm, join(t10.folder, 'notes.md'), 'sib')).toBe('awaiting_confirm');
    expect(asks(events).at(-1)).toMatchObject({ cause: 'other_project', outsideFolder: t10.folder });
    await (await pm.confirm('sib', false))!;
    expect(await read(pm, join(models.folder, 'notes.md'), 'up', 'list_dir')).toBe('awaiting_confirm');
    expect(asks(events).at(-1)).toMatchObject({ cause: 'other_project', outsideFolder: models.folder });
    await (await pm.confirm('up', true))!;
    // a path in no project's folder is read as before
    expect(await read(pm, join(root, 'plain', 'x.md'), 'plain')).toBe('completed');
    expect(asks(events)).toHaveLength(2);
    // glob in a sibling's folder asks too
    expect(await read(pm, t10.folder, 'gl', 'glob')).toBe('awaiting_confirm');
    expect(asks(events).at(-1)).toMatchObject({ cause: 'other_project', outsideFolder: t10.folder });
  });

  it('a project reading its sub-project does not ask; another project, or a plain conversation, does', async () => {
    const { rt, events, lamp, part, t1 } = await setup();
    const pm = rt.session(lamp.managerSessionId)!;
    expect(await read(pm, join(part.folder, 'notes.md'), 'child')).toBe('completed');
    expect(asks(events)).toHaveLength(0);
    expect(await read(pm, join(t1.folder, 'notes.md'), 'other', 'grep')).toBe('awaiting_confirm');
    await (await pm.confirm('other', false))!;
    const chat = rt.createSession({ cwd: join(root, 'plain') });
    // in another case and through .., as the file system sees it
    expect(await read(chat, join(t1.folder, '..', 'T1', 'NOTES.md').toUpperCase(), 'chat')).toBe('awaiting_confirm');
    expect(asks(events).at(-1)).toMatchObject({ cause: 'other_project' });
  });

  it('始终允许 keeps it for the conversation and its sub-agents; allowed_folders lists and takes it back', async () => {
    const { rt, events, t1, t10 } = await setup();
    const pm = rt.session(t1.managerSessionId)!;
    expect(await read(pm, join(t10.folder, 'notes.md'), 'r1')).toBe('awaiting_confirm');
    await (await pm.confirm('r1', true, { allowFolder: true }))!;
    expect(pm.allowedReadFolders()).toEqual([t10.folder]);
    // allowed for reading only: a write there still asks (as a write outside)
    expect(pm.mayWriteIn(t10.folder)).toBe(false);
    expect(await read(pm, join(t10.folder, 'notes.md'), 'r2')).toBe('completed');
    const worker = rt.createSession({ parentId: pm.id });
    expect(await read(worker, join(t10.folder, 'notes.md'), 'r3')).toBe('completed');
    expect(asks(events)).toHaveLength(1);
    gw.enqueue({ toolCalls: [{ id: 'l1', name: 'allowed_folders', args: { action: 'list' } }] }, { text: 'listed' });
    await pm.send('which?').done;
    const listed = pm.messages().flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.toolUseId === 'l1');
    expect(listed && 'content' in listed ? listed.content : '').toContain(`allowed for reading`);
    gw.enqueue({ toolCalls: [{ id: 'v1', name: 'allowed_folders', args: { action: 'revoke', folder: t10.folder } }] }, { text: 'taken back' });
    await pm.send('ask me again before reading there').done;
    expect(pm.allowedReadFolders()).toEqual([]);
    expect(await read(pm, join(t10.folder, 'notes.md'), 'r4')).toBe('awaiting_confirm');
  });

  it('a path the user typed in their own message is read without asking', async () => {
    const { rt, events, t1, t10 } = await setup();
    const pm = rt.session(t1.managerSessionId)!;
    gw.enqueue({ toolCalls: [{ id: 'g1', name: 'read_file', args: { path: join(t10.folder, 'notes.md') } }] }, { text: 'read' });
    expect((await pm.send(`look at ${t10.folder}`).done).reason).toBe('completed');
    expect(asks(events)).toHaveLength(0);
  });
});
