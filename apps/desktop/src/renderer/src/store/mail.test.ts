import { describe, expect, it } from 'vitest';
import { FakeBackend } from '../../../main/backend/fake';
import { SEED_IDS } from '../../../main/backend/fake-seed';
import { MailStore } from './mail';

function setup() {
  const backend = new FakeBackend({ speed: 0 });
  const store = new MailStore({ agent: backend, onAgentEvent: (l) => backend.onEvent(l) });
  return { backend, store };
}

describe('MailStore', () => {
  it('loads the sorted mail and follows the pipeline events', async () => {
    const { backend, store } = setup();
    await store.reload();
    expect(store.state.get().items).toHaveLength(6);
    await store.pollNow();
    const v = store.state.get();
    expect(v.items).toHaveLength(7);
    const fresh = v.items.find((m) => m.id === 'demo:poll-1');
    expect(fresh?.status).toBe('routed');
    expect(fresh?.routedTo).toBe(SEED_IDS.pm);
    expect(v.threadId).toBe('s-mail');
    expect(v.lastPolledAt).not.toBeNull();
    expect(v.polling).toBe(false);
    backend.dispose();
  });

  it('records accept, ignore and moving to another project', async () => {
    const { backend, store } = setup();
    await store.reload();
    await store.feedback('demo:m1', 'accept');
    expect(store.state.get().items.find((m) => m.id === 'demo:m1')?.feedback?.action).toBe('accept');
    await store.feedback('demo:m3', 'ignore');
    expect(store.state.get().items.find((m) => m.id === 'demo:m3')?.status).toBe('ignored');
    await store.feedback('demo:m4', 'reassign', 'p-budget');
    const moved = store.state.get().items.find((m) => m.id === 'demo:m4');
    expect(moved?.triage?.projectId).toBe('p-budget');
    expect(moved?.routedTo).toBe(SEED_IDS.pm2);
    backend.dispose();
  });

  it('says so in words when an action fails', async () => {
    const { backend, store } = setup();
    await store.feedback('demo:m4', 'reassign', 'nowhere');
    expect(store.state.get().problem).not.toBe('');
    expect(store.state.get().problem).not.toMatch(/reassign/);
    backend.dispose();
  });
});
