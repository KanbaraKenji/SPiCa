// Deleting a conversation: its records and those of the sub-agents under it go,
// the files it made stay, running ones are stopped first, a project manager
// only goes with its project.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentApi } from './api.ts';
import { encodePng } from './images.ts';
import { SqliteStore } from './store/sqlite.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir, until } from './testing/helpers.ts';

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

const ctx = (rt: ReturnType<typeof makeRuntime>, sessionId: string) => ({
  sessionId,
  parentChain: [],
  cwd: dir,
  signal: new AbortController().signal,
  tracer: rt.tracer,
  extractors: [],
  services: rt.services(),
  callId: 'c',
  emit: () => {},
});

describe('deleting a conversation', () => {
  it('removes it and its sub-agents with their records and image copies; the files it made stay; traces stay', async () => {
    gw.onRequest(() => ({ text: 'ok' }));
    const path = join(dir, 'db', 'spica.db');
    const opts = { cwd: dir, sessionFilesDir: join(dir, 'data', 'sessions'), mediaDir: join(dir, 'media'), store: new SqliteStore(path) };
    const rt = makeRuntime(gw, opts);
    const api = createAgentApi(rt);
    const events = captureEvents(rt);
    const keep = rt.createSession();
    await keep.send('stays').done;
    const chat = rt.createSession();
    const shot = join(dir, 'shot.png');
    writeFileSync(shot, encodePng({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(100) }));
    await api.send(chat.id, 'look at this', { attachments: [{ path: shot }] });
    await chat.idle();
    const child = rt.createSession({ parentId: chat.id });
    await child.send('sub task').done;
    const made = join(chat.config.cwd, 'report.md'); // a file the conversation made in its own folder
    writeFileSync(made, 'result');
    expect(existsSync(rt.mediaDir(chat.id))).toBe(true);

    await api.deleteSession!(chat.id);
    expect(rt.session(chat.id)).toBeUndefined();
    expect(rt.session(child.id)).toBeUndefined();
    expect(rt.store.getSession(chat.id)).toBeUndefined();
    expect(rt.store.listMessages(child.id)).toEqual([]);
    expect(rt.store.listToolCalls(chat.id)).toEqual([]);
    expect(events.filter((e) => e.type === 'session.deleted').map((e) => e.sessionId).sort()).toEqual([chat.id, child.id].sort());
    expect(existsSync(rt.mediaDir(chat.id))).toBe(false); // the copy of the attached image
    expect(existsSync(made)).toBe(true); // what it made stays
    expect(existsSync(shot)).toBe(true); // the user's original too
    expect((await api.exportTraces({ sessionId: chat.id })).length).toBeGreaterThan(0); // spending history stays
    expect((await api.listSessions()).map((s) => s.id)).toEqual([keep.id]);
    expect(rt.top().id).toBe(keep.id);
    await rt.close();

    const again = makeRuntime(gw, { ...opts, store: new SqliteStore(path) });
    again.restore();
    expect(again.sessions().map((s) => s.id)).toEqual([keep.id]); // gone after reopening too
    await again.close();
  });

  it('stops a running conversation and its running sub-agent first', async () => {
    gw.onRequest((req) => (JSON.stringify(req.body.messages).includes('slow') ? { text: 'late', delayMs: 3000 } : { text: 'ok' }));
    const rt = makeRuntime(gw, { cwd: dir });
    const chat = rt.createSession();
    const child = rt.createSession({ parentId: chat.id });
    void chat.send('slow one');
    void child.send('slow too');
    await until(() => chat.running && child.running);
    const t0 = Date.now();
    await createAgentApi(rt).deleteSession!(chat.id);
    expect(Date.now() - t0).toBeLessThan(2500); // stopped, not waited out
    expect(rt.session(chat.id)).toBeUndefined();
    expect(rt.store.getSession(child.id)).toBeUndefined();
    await rt.close();
  });

  it('a project manager cannot be deleted on its own; an unknown id is an error', async () => {
    const rt = makeRuntime(gw, { cwd: dir, projectsRoot: join(dir, 'p') });
    const p = rt.createProject({ name: 'Keep' });
    const api = createAgentApi(rt);
    await expect(api.deleteSession!(p.managerSessionId)).rejects.toThrow(/project manager of "Keep": delete the project instead/);
    expect(rt.session(p.managerSessionId)).toBeDefined();
    expect(rt.listProjects().map((x) => x.id)).toEqual([p.id]);
    await expect(api.deleteSession!('ses_nope')).rejects.toThrow(/unknown session/);
    await rt.close();
  });

  it('a project manager the deleted conversation was waiting on reports to the project instead (an unread update)', async () => {
    gw.onRequest((req) => (JSON.stringify(req.body.messages).includes('PM-JOB') ? { text: 'PM done', delayMs: 300 } : { text: 'ok' }));
    const rt = makeRuntime(gw, { cwd: dir, projectsRoot: join(dir, 'p') });
    const p = rt.createProject({ name: 'Asked' });
    const pm = rt.session(p.managerSessionId)!;
    const chat = rt.createSession();
    await rt.tools.get('message_agent')!.execute({ id: pm.id, text: 'PM-JOB' }, ctx(rt, chat.id));
    await rt.deleteSession(chat.id);
    await pm.idle();
    await until(() => (rt.store.getProject(p.id)!.unread ?? 0) === 1);
    expect(rt.getProject(p.id)!.recentLog[0]).toMatchObject({ action: 'manager.report', detail: 'PM done' });
    await rt.close();
  });

  it('is not found by the history tools any more; a number pointing at it says so', async () => {
    gw.onRequest(() => ({ text: 'ok' }));
    const rt = makeRuntime(gw, { cwd: dir });
    const old = rt.createSession();
    await old.send('ORANGE-PIN budget').done;
    const now = rt.createSession();
    const found = await rt.tools.get('search_history')!.execute({ query: 'orange-pin' }, ctx(rt, now.id));
    const ref = Number(/\[(\d+)\]/.exec(found.content)![1]);
    await rt.deleteSession(old.id);
    expect((await rt.tools.get('search_history')!.execute({ query: 'orange-pin' }, ctx(rt, now.id))).content).toMatch(/^Nothing found/);
    expect((await rt.tools.get('read_history')!.execute({ ref }, ctx(rt, now.id))).isError).toBe(true);
    await rt.close();
  });
});
