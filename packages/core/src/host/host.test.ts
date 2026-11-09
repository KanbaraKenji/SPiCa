// Backend over a port: requests, events, replay, errors.
import { MessageChannel } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeGateway } from '../testing/fake-gateway.ts';
import { makeRuntime, startGateway, until } from '../testing/helpers.ts';
import type { CoreEvent } from '../types.ts';
import { connectBackend } from './client.ts';
import { BackendServer } from './server.ts';
import { nodePort } from './wire.ts';

let gw: FakeGateway;
beforeEach(async () => {
  gw = await startGateway();
});
afterEach(async () => {
  await gw.stop();
});

function pair(bufferSize?: number) {
  const rt = makeRuntime(gw);
  const server = new BackendServer(rt, bufferSize ? { bufferSize } : {});
  const ch = new MessageChannel();
  server.attach(nodePort(ch.port1), { restored: { sessions: 0, interrupted: [], awaiting: [] }, warnings: [] });
  const client = connectBackend(nodePort(ch.port2));
  const close = () => {
    server.close();
    ch.port1.close();
    ch.port2.close();
  };
  return { rt, server, client, close };
}

describe('backend over a port', () => {
  it('serves the AgentApi and pushes events in order', async () => {
    gw.onRequest(() => ({ text: ['hel', 'lo'] }));
    const { client, close } = pair();
    try {
      expect(await client.ready).toMatchObject({ restored: { sessions: 0 } });
      const events: CoreEvent[] = [];
      client.onEvent((e) => events.push(e));
      const s = await client.api.createSession({});
      expect(s.role).toBe('top');
      await client.api.send(s.id, 'hi');
      await until(() => events.some((e) => e.type === 'run.end'));
      const msgs = await client.api.getMessages(s.id);
      expect(msgs.map((m) => m.kind)).toEqual(['user', 'assistant']);
      expect(events.filter((e) => e.type === 'text.delta').map((e) => (e.type === 'text.delta' ? e.delta : ''))).toEqual(['hel', 'lo']);
      expect(events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq)).toBe(true);
      expect((await client.api.getTopSession!()).id).toBe(s.id);
    } finally {
      close();
    }
  });

  it('replays missed events and says when the buffer no longer reaches back', async () => {
    gw.onRequest(() => ({ text: 'x' }));
    const { client, rt, close } = pair(5);
    try {
      await client.ready;
      const s = rt.createSession();
      await s.send('a').done;
      const all = await client.call<{ events: CoreEvent[]; complete: boolean }>('eventsSince', 0);
      expect(all.events).toHaveLength(5);
      expect(all.complete).toBe(false); // older events were dropped: reload state instead
      const last = all.events.at(-1)!.seq;
      expect(await client.call('eventsSince', last)).toEqual({ events: [], complete: true });
    } finally {
      close();
    }
  });

  it('errors come back as BackendError with a code', async () => {
    const { client, close } = pair();
    try {
      await expect(client.api.getMessages('ses_nope')).rejects.toMatchObject({ name: 'BackendError', code: 'failed', message: 'unknown session: ses_nope' });
      await expect(client.call('dropDatabase')).rejects.toMatchObject({ code: 'unknown_method' });
    } finally {
      close();
    }
  });

  it('pending calls fail cleanly when the backend goes away', async () => {
    const ch = new MessageChannel();
    const client = connectBackend(nodePort(ch.port2));
    const p = client.api.listSessions(); // nobody answers
    client.fail('backend process exited');
    await expect(p).rejects.toMatchObject({ code: 'backend_gone' });
    ch.port1.close();
    ch.port2.close();
  });
});
