import { describe, expect, it } from 'vitest';
import type { CoreEvent } from '@spica/protocol';
import { FakeBackend } from './fake';
import { SEED_IDS } from './fake-seed';

function collect(backend: FakeBackend) {
  const events: CoreEvent[] = [];
  backend.onEvent((e) => events.push(e));
  const until = (pred: (e: CoreEvent) => boolean) =>
    new Promise<CoreEvent>((resolve) => {
      const found = events.find(pred);
      if (found) return resolve(found);
      const off = backend.onEvent((e) => {
        if (pred(e)) {
          off();
          resolve(e);
        }
      });
    });
  return { events, until };
}

describe('FakeBackend', () => {
  it('seeds a project tree with every status the UI draws', async () => {
    const b = new FakeBackend({ speed: 0 });
    const sessions = await b.listSessions();
    const statuses = new Set(sessions.map((s) => s.status));
    for (const s of ['idle', 'thinking', 'tool', 'queued', 'awaiting_answer', 'done'] as const) expect(statuses).toContain(s);
    expect(sessions.find((s) => s.id === SEED_IDS.quotes)?.parentChain).toEqual([SEED_IDS.pm]);
    expect(await b.getPending(SEED_IDS.minutes)).toHaveLength(1);
  });

  it('streams a full answer with ordered, gapless sequence numbers', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { events, until } = collect(b);
    const chat = await b.createSession({ title: '新对话' });
    await b.send(chat.id, '看看资料');
    await until((e) => e.type === 'run.end');
    const types = events.map((e) => e.type);
    expect(types).toContain('thinking.delta');
    expect(types).toContain('text.delta');
    expect(types.indexOf('tool.start')).toBeLessThan(types.indexOf('tool.end'));
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
    events.forEach((e, i) => {
      if (i > 0) expect(e.seq).toBe(events[i - 1]!.seq + 1);
    });
    const messages = await b.getMessages(chat.id);
    expect(messages.map((m) => m.kind)).toEqual(['user', 'assistant', 'tool_results', 'assistant', 'tool_results']);
  });

  it('waits for confirmation and continues after the decision', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '把通知发送给项目组');
    const req = await until((e) => e.type === 'confirm.request');
    expect((await b.getSession(chat.id))?.status).toBe('awaiting_confirm');
    if (req.type !== 'confirm.request') throw new Error('unreachable');
    await b.confirm(chat.id, req.callId, false);
    const end = await until((e) => e.type === 'run.end');
    expect(end).toMatchObject({ reason: 'completed' });
    expect(await b.getPending(chat.id)).toEqual([]);
  });

  it('answers a pending question left over in history', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { until } = collect(b);
    await b.answer(SEED_IDS.minutes, 'seed-ask-1', '只写结论');
    await until((e) => e.type === 'run.end' && e.sessionId === SEED_IDS.minutes);
    const last = (await b.getMessages(SEED_IDS.minutes)).at(-1);
    expect(JSON.stringify(last?.content)).toContain('只写结论');
  });

  it('stops on abort and keeps what was already said', async () => {
    const b = new FakeBackend({ speed: 1 });
    const { until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '看看资料');
    await until((e) => e.type === 'text.delta');
    await b.abort(chat.id);
    const end = await until((e) => e.type === 'run.end');
    expect(end).toMatchObject({ reason: 'aborted' });
    const last = (await b.getMessages(chat.id)).at(-1);
    expect(last?.meta?.interrupted).toBe(true);
    b.dispose();
  });

  it('queues a message sent while running as a steer', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '把通知发送给项目组');
    const req = await until((e) => e.type === 'confirm.request');
    const r = await b.send(chat.id, '改成周五');
    expect(r.started).toBe(false);
    if (req.type === 'confirm.request') await b.confirm(chat.id, req.callId, true);
    await until((e) => e.type === 'steer.applied');
  });
});
