// Background commands in the runtime: deleting a conversation stops them, quitting stops the rest, the AgentApi
// lists and stops them, and the window hears each change.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentApi } from './api.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir } from './testing/helpers.ts';

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

const sleepy = process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60';

describe('background commands in the runtime', () => {
  it('without commandJobsDir there is no run_in_background and no command_output', () => {
    const rt = makeRuntime(gw, { cwd: dir });
    expect(rt.tools.get('command_output')).toBeUndefined();
    expect(rt.tools.get('run_javascript')).toBeDefined();
  });

  it('the API lists and stops them; deleting the conversation stops its own; close stops the rest', async () => {
    const rt = makeRuntime(gw, { cwd: dir, commandJobsDir: join(dir, 'jobs') });
    const api = createAgentApi(rt);
    const events = captureEvents(rt);
    const a = rt.createSession();
    const b = rt.createSession();
    const run = rt.tools.get('run_command')!;
    const ctx = (sessionId: string) => ({ sessionId, parentChain: [], cwd: dir, signal: new AbortController().signal, tracer: rt.tracer, extractors: [], services: rt.services(), callId: `c-${sessionId}`, emit: () => {} });
    await run.execute({ command: sleepy, run_in_background: true }, ctx(a.id));
    await run.execute({ command: sleepy, run_in_background: true }, ctx(b.id));
    await run.execute({ command: sleepy, run_in_background: true }, ctx(b.id));
    const [ja] = await api.listCommandJobs!(a.id);
    const jobsB = await api.listCommandJobs!(b.id);
    expect(ja!.end).toBeUndefined();
    expect(jobsB).toHaveLength(2);
    await api.stopCommandJob!(jobsB[0]!.id);
    expect((await api.listCommandJobs!(b.id))[0]!.end).toBe('user');
    await rt.deleteSession(a.id);
    expect(await api.listCommandJobs!(a.id)).toEqual([]);
    expect(events.some((e) => e.type === 'command.job' && e.sessionId === a.id && e.job.end === 'conversation_deleted')).toBe(true);
    await rt.close();
    expect(events.some((e) => e.type === 'command.job' && e.job.id === jobsB[1]!.id && e.job.end === 'app_quit')).toBe(true);
  });
});
