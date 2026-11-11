// Regenerating the last answer: the old answer is kept but marked replaced,
// the model never sees it again (also after a restart and in the history
// tools), and a round that changed something cannot be regenerated.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGENERATE_HINTS } from '@spica/protocol';
import { createAgentApi } from './api.ts';
import { SqliteStore } from './store/sqlite.ts';
import type { FakeGateway, ReceivedRequest } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir, until } from './testing/helpers.ts';
import type { Tool } from './tools/types.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

const sent = (r: ReceivedRequest | undefined) => JSON.stringify(r?.body.messages ?? []);
const text = (m: { content: { type: string; text?: string }[] }) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

function tool(name: string, opts: Partial<Tool> = {}): Tool {
  return {
    spec: { name, description: name, inputSchema: { type: 'object', properties: {} } },
    async execute() {
      return { content: `${name} done` };
    },
    ...opts,
  };
}

describe('regenerating the last answer', () => {
  it('replaces the answer everywhere: the model, getMessages, the store, and after a restart', async () => {
    const path = join(dir, 'spica.db');
    const opts = { cwd: dir, sessionFilesDir: join(dir, 'sessions'), store: new SqliteStore(path) };
    const rt = makeRuntime(gw, opts);
    const api = createAgentApi(rt);
    const chat = rt.createSession();
    gw.enqueue({ text: 'first answer A1' });
    await chat.send('question A').done;
    const [question, a1] = chat.messages();
    expect(chat.info().regenerate).toEqual({ anchorId: question!.id, ok: true });

    const events = captureEvents(rt);
    gw.enqueue({ text: 'second answer A2' });
    const res = await api.regenerate!(chat.id, a1!.id);
    expect(res).toEqual({ ok: true, anchorId: question!.id, version: 2 });
    await until(() => chat.status === 'idle' && !chat.running);
    await chat.idle();

    // the request for the new answer carries the question, not the old answer
    expect(sent(gw.requests.at(-1))).toContain('question A');
    expect(sent(gw.requests.at(-1))).not.toContain('first answer A1');
    // events: replaced first, then a normal run, then the button state
    const types = events.filter((e) => e.sessionId === chat.id).map((e) => e.type);
    expect(types[0]).toBe('messages.superseded');
    expect(types.indexOf('messages.superseded')).toBeLessThan(types.indexOf('text.delta'));
    // the button state goes out with the last status, so run.end stays the last event
    expect(types.lastIndexOf('session.updated')).toBeGreaterThan(types.lastIndexOf('text.delta'));
    expect(types.at(-1)).toBe('run.end');
    expect(events.find((e) => e.type === 'messages.superseded')).toMatchObject({ anchorId: question!.id, messageIds: [a1!.id], version: 1 });
    const lastInfo = events.filter((e) => e.type === 'session.updated').at(-1);
    expect(lastInfo && 'info' in lastInfo && lastInfo.info.regenerate).toEqual({ anchorId: question!.id, ok: true });

    // getMessages: current only by default; all versions on request
    expect((await api.getMessages(chat.id)).map(text)).toEqual(['question A', 'second answer A2']);
    const all = await api.getMessages(chat.id, { superseded: true });
    expect(all.map(text)).toEqual(['question A', 'first answer A1', 'second answer A2']);
    expect(all[1]!.superseded).toMatchObject({ of: question!.id, version: 1 });
    expect(all[2]!.superseded).toBeUndefined();
    expect(all[2]!.seq).toBeGreaterThan(all[1]!.seq); // numbers are not reused

    // a follow-up refers to the new answer only
    gw.enqueue({ text: 'about A2' });
    await chat.send('question B').done;
    expect(sent(gw.requests.at(-1))).toContain('second answer A2');
    expect(sent(gw.requests.at(-1))).not.toContain('first answer A1');
    // the earlier round is not the last one any more
    expect(await api.regenerate!(chat.id, all[2]!.id)).toEqual({ ok: false, code: 'regenerate.not_last', hint: REGENERATE_HINTS['regenerate.not_last'] });
    await rt.close();

    // after a restart: the same three views
    const again = makeRuntime(gw, { ...opts, store: new SqliteStore(path) });
    again.restore();
    const back = again.session(chat.id)!;
    expect(back.messages().map(text)).toEqual(['question A', 'second answer A2', 'question B', 'about A2']);
    expect(back.messages({ superseded: true }).map(text)).toContain('first answer A1');
    gw.enqueue({ text: 'about B again' });
    await back.send('question C').done;
    expect(sent(gw.requests.at(-1))).not.toContain('first answer A1');
    await again.close();
  });

  it('counts versions: regenerating twice leaves answers 1 and 2 and shows the third', async () => {
    const rt = makeRuntime(gw);
    const chat = rt.createSession();
    gw.enqueue({ text: 'one' }, { text: 'two' }, { text: 'three' });
    await chat.send('q').done;
    expect(chat.regenerate()).toMatchObject({ ok: true, version: 2 });
    await until(() => !chat.running);
    await chat.idle();
    expect(chat.regenerate()).toMatchObject({ ok: true, version: 3 });
    await until(() => !chat.running);
    await chat.idle();
    const all = chat.messages({ superseded: true });
    expect(all.map((m) => [text(m), m.superseded?.version ?? null])).toEqual([
      ['q', null],
      ['one', 1],
      ['two', 2],
      ['three', null],
    ]);
    await rt.close();
  });

  it('replaces the whole answer (tool calls and their results) but leaves notes where they are', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const chat = rt.createSession({ cwd: dir });
    gw.enqueue({ toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }] }, { text: 'it says hello' });
    await chat.send('read a.txt').done;
    chat.addNote('note', '[System note] a note after the answer', { author: 'runtime' });
    expect(chat.info().regenerate?.ok).toBe(true); // read_file only reads
    gw.enqueue({ text: 'fresh answer' });
    chat.regenerate();
    await until(() => !chat.running);
    await chat.idle();
    const now = chat.messages();
    expect(now.map((m) => m.kind)).toEqual(['user', 'note', 'assistant']);
    expect(chat.messages({ superseded: true }).filter((m) => m.superseded).map((m) => m.kind)).toEqual(['assistant', 'tool_results', 'assistant']);
    expect(sent(gw.requests.at(-1))).toContain('a note after the answer');
    expect(sent(gw.requests.at(-1))).not.toContain('it says hello');
    await rt.close();
  });

  it('a round that wrote files, ran a tool not declared read-only or started sub-agents cannot be regenerated', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    rt.tools.register(tool('lookup', { readOnly: true }), 'p');
    rt.tools.register(tool('poke'), 'p');
    const cases: [string, string | undefined][] = [
      ['write_file', 'regenerate.wrote_files'],
      ['spawn_agent', 'regenerate.spawned'],
      ['poke', 'regenerate.acted'],
      ['lookup', undefined],
    ];
    for (const [name, code] of cases) {
      const chat = rt.createSession({ cwd: dir });
      const args = name === 'write_file' ? { path: 'out.txt', content: 'x' } : name === 'spawn_agent' ? { title: 't', task: 'do' } : {};
      // only the conversation's first request calls the tool (not a sub-agent's, not after the result)
      gw.onRequest((req) => (sent(req).includes('use ') && !sent(req).includes('"role":"tool"') ? { toolCalls: [{ name, args }] } : { text: 'done' }));
      await chat.send(`use ${name}`).done;
      const state = chat.info().regenerate!;
      if (code) {
        expect(state).toEqual({ anchorId: chat.messages()[0]!.id, ok: false, code, hint: REGENERATE_HINTS[code as keyof typeof REGENERATE_HINTS] });
        expect(chat.regenerate()).toMatchObject({ ok: false, code });
      } else expect(state.ok).toBe(true);
    }
    await rt.close();
  });

  it('a declined action did nothing: the round can be regenerated; while it waits it cannot', async () => {
    const rt = makeRuntime(gw);
    rt.tools.register(tool('send_mail', { irreversible: true }), 'p');
    const chat = rt.createSession();
    gw.enqueue({ toolCalls: [{ id: 'c1', name: 'send_mail', args: {} }] }, { text: 'not sent' });
    await chat.send('mail them').done;
    expect(chat.info().regenerate).toMatchObject({ ok: false, code: 'regenerate.waiting' });
    await (await chat.confirm('c1', false));
    await until(() => !chat.running);
    await chat.idle();
    expect(chat.info().regenerate).toMatchObject({ ok: true });
    await rt.close();
  });

  it('while it runs, in project managers and sub-agents, and with nothing to answer, it cannot', async () => {
    const rt = makeRuntime(gw);
    const chat = rt.createSession();
    expect(chat.info().regenerate).toMatchObject({ anchorId: null, ok: false, code: 'regenerate.no_turn' });
    gw.enqueue({ text: ['slow', ' answer'], chunkDelayMs: 300 });
    const h = chat.send('q');
    await until(() => chat.running);
    expect(chat.regenerate()).toMatchObject({ ok: false, code: 'regenerate.running' });
    await h.done;
    const child = rt.createSession({ parentId: chat.id });
    gw.enqueue({ text: 'sub' });
    await child.send('task').done;
    expect(child.info().regenerate).toMatchObject({ ok: false, code: 'regenerate.role' });
    const mail = rt.createSession({ templateId: 'mail-triage' });
    expect(mail.info().regenerate).toMatchObject({ code: 'regenerate.role' });
    await rt.close();
  });

  it('a round that failed can be regenerated (a real retry), and an empty one is not counted as a version', async () => {
    const rt = makeRuntime(gw);
    const chat = rt.createSession();
    gw.enqueue({ status: 400, errorBody: JSON.stringify({ error: { message: 'bad' } }) });
    await chat.send('q').done;
    expect(chat.status).toBe('error');
    expect(chat.info().regenerate?.ok).toBe(true);
    gw.enqueue({ text: 'works now' });
    expect(chat.regenerate()).toMatchObject({ ok: true, version: 1 });
    await until(() => !chat.running);
    await chat.idle();
    expect(chat.messages({ superseded: true }).map(text)).toEqual(['q', 'works now']);
    await rt.close();
  });

  it('the history tools do not find a replaced answer', async () => {
    const rt = makeRuntime(gw);
    const old = rt.createSession();
    gw.enqueue({ text: 'zebracorn first version' }, { text: 'plain second version' });
    await old.send('tell me').done;
    old.regenerate();
    await until(() => !old.running);
    await old.idle();
    const asker = rt.createSession();
    gw.enqueue({ toolCalls: [{ name: 'search_history', args: { query: 'zebracorn' } }] }, { text: 'ok' });
    await asker.send('search').done;
    const results = rt.store.listToolCalls(asker.id).find((c) => c.name === 'search_history');
    expect(results?.result ?? '').not.toContain('zebracorn first version');
    await rt.close();
  });

  it('find_history_files does not list a file only a replaced answer read', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    writeFileSync(join(dir, 'only-old.txt'), 'x');
    const old = rt.createSession({ cwd: dir });
    gw.enqueue({ toolCalls: [{ name: 'read_file', args: { path: 'only-old.txt' } }] }, { text: 'read it' }, { text: 'did not read anything' });
    await old.send('look').done;
    old.regenerate();
    await until(() => !old.running);
    await old.idle();
    const asker = rt.createSession();
    gw.enqueue({ toolCalls: [{ name: 'find_history_files', args: {} }] }, { text: 'ok' });
    await asker.send('files?').done;
    const found = rt.store.listToolCalls(asker.id).find((c) => c.name === 'find_history_files');
    expect(found?.status).toBe('ok');
    expect(found?.result ?? '').not.toContain('only-old.txt');
    await rt.close();
  });

  it('a steer sent during the round goes with the old answer', async () => {
    const rt = makeRuntime(gw);
    const chat = rt.createSession();
    gw.enqueue({ text: ['slow', ' first'], chunkDelayMs: 200 }, { text: 'after the steer' }, { text: 'fresh' });
    const h = chat.send('q');
    await until(() => chat.running && gw.requests.length > 0);
    chat.steer('also this', 'next');
    await h.done;
    await chat.idle();
    expect(chat.messages().map((m) => m.kind)).toEqual(['user', 'assistant', 'steer', 'assistant']);
    expect(chat.regenerate()).toMatchObject({ ok: true, version: 2 });
    await until(() => !chat.running);
    await chat.idle();
    expect(chat.messages().map(text)).toEqual(['q', 'fresh']);
    expect(chat.messages({ superseded: true }).filter((m) => m.superseded).map((m) => m.kind)).toEqual(['assistant', 'steer', 'assistant']);
    expect(sent(gw.requests.at(-1))).not.toContain('also this');
    await rt.close();
  });
});
