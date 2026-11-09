// SQLite store and recovery after a normal close or a hard kill.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './store/sqlite.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway, tempDir, until } from './testing/helpers.ts';
import { askUserTool } from './tools/agent-tools.ts';
import type { Tool } from './tools/types.ts';
import type { Message } from './types.ts';

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

const textOf = (m: Message) => m.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? `<result:${b.content.split('\n')[1]}>` : b.type === 'tool_use' ? `<call:${b.name}>` : '')).join('');

describe('SqliteStore', () => {
  it('round-trips every table and survives reopening', () => {
    const path = join(dir, 'db', 'spica.db');
    const a = new SqliteStore(path);
    a.upsertSession({ id: 's1', parentId: null, role: 'top', title: 'T', status: 'idle', config: { system: 'x', providerId: 'p', model: 'm', maxTokens: 1, cwd: dir, maxTurns: 3 }, createdAt: '1', updatedAt: '1' });
    a.upsertSession({ id: 's1', parentId: null, role: 'top', title: 'T2', status: 'done', config: { system: 'x', providerId: 'p', model: 'm', maxTokens: 1, cwd: dir, maxTurns: 3 }, createdAt: '1', updatedAt: '2' });
    const msg: Message = { id: 'm1', sessionId: 's1', seq: 1, role: 'user', kind: 'user', content: [{ type: 'text', text: '你好' }], createdAt: 't', meta: { author: 'user' } };
    a.appendMessage(msg);
    a.upsertToolCall({ id: 'call_0', sessionId: 's1', messageId: 'm2', name: 'n', input: { a: 1 }, status: 'running', startedAt: 't' });
    a.upsertToolCall({ id: 'call_0', sessionId: 's1', messageId: 'm4', name: 'n', input: { a: 2 }, status: 'ok', result: 'r', startedAt: 't', endedAt: 'u' });
    a.putQueued({ ...msg, id: 'q1', kind: 'steer' });
    a.putQueued({ ...msg, id: 'q2', kind: 'steer' });
    a.putPending({ sessionId: 's1', callId: 'c', messageId: 'm2', item: { kind: 'ask', callId: 'c', question: '?', createdAt: 't' } });
    a.appendRelay({ id: 'r1', parentId: 'p', childId: 's1', kind: 'user_message', text: 'hi', createdAt: 't' });
    a.appendTrace({ id: 't1', kind: 'model', startedAt: 't', durationMs: 5, sessionId: 's1', parentChain: [], initiator: 'model', target: 'p', status: 'ok', costUsd: 0.5 });
    a.close();

    const b = new SqliteStore(path);
    expect(b.getSession('s1')).toMatchObject({ title: 'T2', status: 'done', config: { maxTurns: 3 } });
    expect(b.listMessages('s1')).toEqual([msg]);
    expect(b.listToolCalls('s1')).toHaveLength(2); // same call id in two turns: both kept
    expect(b.listToolCalls('s1', 'm4')[0]).toMatchObject({ input: { a: 2 }, result: 'r', endedAt: 'u' });
    expect(b.listQueued('s1').map((m) => m.id)).toEqual(['q1', 'q2']);
    b.deleteQueued('s1', 'q1');
    b.putQueued({ ...msg, id: 'q3', kind: 'steer' });
    expect(b.listQueued('s1').map((m) => m.id)).toEqual(['q2', 'q3']);
    expect(b.listPending('s1')[0]!.item).toMatchObject({ kind: 'ask', question: '?' });
    expect(b.listRelays('p')).toHaveLength(1);
    expect(b.listTraces({ sessionId: 's1' })[0]).toMatchObject({ id: 't1', costUsd: 0.5 });
    b.close();
  });
});

describe('recovery', () => {
  it('normal close mid-run → interrupted → restore → resume finishes the job', async () => {
    const path = join(dir, 'spica.db');
    let release!: () => void;
    const slow: Tool = {
      spec: { name: 'slow', description: 'slow', inputSchema: { type: 'object' } },
      execute: (_i, ctx) =>
        new Promise((resolve, reject) => {
          release = () => resolve({ content: 'never' });
          ctx.signal.addEventListener('abort', () => reject(new Error('stopped')));
        }),
    };
    gw.enqueue({ toolCalls: [{ id: 'c1', name: 'slow', args: {} }], usage: { input: 1000, output: 10 } }, { text: 'resumed and done' });
    const rt1 = makeRuntime(gw, { store: new SqliteStore(path), tools: [slow], cwd: dir });
    const s1 = rt1.createSession({ title: 'job' });
    s1.send('do it');
    await until(() => typeof release === 'function');
    await rt1.close();

    const rt2 = makeRuntime(gw, { store: new SqliteStore(path), tools: [slow], cwd: dir });
    const restored = rt2.restore();
    expect(restored).toMatchObject({ sessions: 1, interrupted: [s1.id] });
    const s2 = rt2.session(s1.id)!;
    expect(s2.status).toBe('interrupted');
    expect(rt2.ledger.sessionUsd(s1.id)).toBeGreaterThan(0); // costs re-seeded
    const r = await s2.resume()!;
    expect(r.text).toBe('resumed and done');
    expect(s2.messages().map((m) => m.kind)).toEqual(['user', 'assistant', 'tool_results', 'assistant']);
    await rt2.close();
  });

  it('a pending question survives a restart and the answer continues the run', async () => {
    const path = join(dir, 'spica.db');
    gw.enqueue({ toolCalls: [{ id: 'q1', name: 'ask_user', args: { question: 'Which color?' } }] }, { text: 'Blue it is.' });
    const rt1 = makeRuntime(gw, { store: new SqliteStore(path), tools: [askUserTool] });
    const s1 = rt1.createSession();
    expect((await s1.send('paint').done).reason).toBe('awaiting_answer');
    await rt1.close();

    const rt2 = makeRuntime(gw, { store: new SqliteStore(path), tools: [askUserTool] });
    expect(rt2.restore()).toMatchObject({ awaiting: [s1.id], interrupted: [] });
    const s2 = rt2.session(s1.id)!;
    expect(s2.status).toBe('awaiting_answer');
    expect(s2.pending()).toMatchObject([{ kind: 'ask', question: 'Which color?' }]);
    expect((await s2.answer('q1', 'blue')!).text).toBe('Blue it is.');
    await rt2.close();
  });

  it('the session tree and relays come back', async () => {
    const path = join(dir, 'spica.db');
    gw.onRequest(() => ({ text: 'ok' }));
    const rt1 = makeRuntime(gw, { store: new SqliteStore(path) });
    const top = rt1.createSession({ role: 'top' });
    const pm = rt1.createSession({ parentId: top.id, role: 'manager', title: 'PM' });
    const worker = rt1.createSession({ parentId: pm.id, title: 'W' });
    await worker.send('user talks to worker').done;
    await rt1.close();

    const rt2 = makeRuntime(gw, { store: new SqliteStore(path) });
    rt2.restore();
    expect(rt2.session(worker.id)!.parentChain).toEqual([pm.id, top.id]);
    expect(rt2.children(pm.id).map((s) => s.id)).toEqual([worker.id]);
    expect(rt2.session(worker.id)!.status).toBe('done');
    expect(rt2.session(pm.id)!.messages().map((m) => m.kind)).toEqual(['relay', 'report']);
    expect(rt2.lastReport(worker.id)).toBe('ok');
    await rt2.close();
  });

  it('hard kill mid-stream: the text already shown survives and is marked interrupted', async () => {
    const path = join(dir, 'spica.db');
    gw.enqueue({ text: ['Here is the first half of the answer', ' and the rest'], hangAfterChunks: 1 }, { text: 'continued' });
    const script = fileURLToPath(new URL('./testing/crash-child.ts', import.meta.url));
    const child = spawn(process.execPath, [script, path, gw.baseUrl, dir, 'stream'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    await until(() => out.includes('READY') || child.exitCode !== null, 15_000);
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;

    const rt = makeRuntime(gw, { store: new SqliteStore(path), cwd: dir });
    const { interrupted } = rt.restore();
    const s = rt.session(interrupted[0]!)!;
    const msgs = s.messages();
    expect(msgs.map(textOf)).toEqual(['start the long job', 'Here is the first half of the answer']);
    expect(msgs[1]!.meta).toMatchObject({ partial: true, interrupted: true });
    expect((await s.resume()!).text).toBe('continued');
    await rt.close();
  }, 30_000);

  it('hard kill mid-tool: restore keeps the transcript and the queued message, resume continues', async () => {
    const path = join(dir, 'spica.db');
    gw.enqueue({ toolCalls: [{ id: 'h1', name: 'hang', args: {} }], usage: { input: 500, output: 5 } }, { text: 'picked up after the crash' });
    const script = fileURLToPath(new URL('./testing/crash-child.ts', import.meta.url));
    const child = spawn(process.execPath, [script, path, gw.baseUrl, dir], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    try {
      await until(() => out.includes('READY') || child.exitCode !== null, 15_000);
    } catch (e) {
      throw new Error(`child did not get ready: ${err}`, { cause: e });
    }
    expect(out).toContain('READY');
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;

    const rt = makeRuntime(gw, { store: new SqliteStore(path), cwd: dir });
    const restored = rt.restore();
    expect(restored.interrupted).toHaveLength(1);
    const s = rt.session(restored.interrupted[0]!)!;
    expect(s.messages().map(textOf)).toEqual(['start the long job', '<call:hang>']);
    expect(rt.store.listQueued(s.id).map(textOf)).toEqual(['message typed before the crash']);
    expect(rt.ledger.globalUsd).toBeGreaterThan(0);

    const r = await s.resume()!;
    expect(r.text).toBe('picked up after the crash');
    expect(s.messages().map((m) => `${m.kind}:${textOf(m)}`)).toEqual([
      'user:start the long job',
      'assistant:<call:hang>',
      'tool_results:<result:The previous run stopped before this tool call finished.>',
      'steer:message typed before the crash',
      'assistant:picked up after the crash',
    ]);
    expect(rt.store.listQueued(s.id)).toEqual([]);
    await rt.close();
  }, 30_000);
});
