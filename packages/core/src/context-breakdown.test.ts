// The detail under the context ring: what the context is made of, estimated
// from the text, scaled to the total the provider reported, no model call.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentApi } from './api.ts';
import { encodePng } from './images.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway, tempDir } from './testing/helpers.ts';

// gateways, child processes and local servers start slowly when several full runs share the machine
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

const sum = (parts: { tokens: number }[]) => parts.reduce((a, p) => a + p.tokens, 0);

describe('context breakdown', () => {
  it('before any message: the estimate of the first request, not measured; no window known, so no free part', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    const s = rt.createSession();
    const b = s.contextBreakdown();
    expect(b).toMatchObject({ measured: false, window: null, free: null, outputReserve: 512 });
    expect(b.parts.map((p) => p.key)).toEqual(['system', 'tools', 'messages']);
    expect(b.parts.find((p) => p.key === 'messages')).toEqual({ key: 'messages', tokens: 0, estimated: true });
    expect(b.parts.find((p) => p.key === 'system')!.children!.map((c) => c.key)).toEqual(['system.base', 'system.rules']);
    expect(sum(b.parts)).toBe(b.total);
    expect(b.total).toBeGreaterThan(100); // the system prompt and the tool list
    expect(gw.requests).toHaveLength(0); // nothing was asked of the model
    await rt.close();
  });

  it('after a call: the total is what the provider reported, the parts add up to it, one level down where it splits', async () => {
    gw.enqueue({ toolCalls: [{ id: 'l1', name: 'list_dir', args: {} }], usage: { input: 3000, output: 40 } }, { text: 'There are two files.', usage: { input: 3400, output: 60 } });
    const rt = makeRuntime(gw, { cwd: dir, mediaDir: join(dir, 'media'), prices: { 'fake-openai': { 'fake-model': { input: 1, output: 1, contextWindow: 100_000 } } } });
    const api = createAgentApi(rt);
    const s = rt.createSession();
    const shot = join(dir, 'shot.png');
    writeFileSync(shot, encodePng({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(200) }));
    await api.send(s.id, 'What is in this folder?', { attachments: [{ path: shot }] });
    await s.idle();
    const b = s.contextBreakdown();
    expect(b).toMatchObject({ measured: true, total: 3460, window: 100_000, outputReserve: 512, free: 100_000 - 3460 - 512 });
    expect(sum(b.parts)).toBe(3460);
    const messages = b.parts.find((p) => p.key === 'messages')!;
    expect(messages.children!.map((c) => c.key)).toEqual(['messages.user', 'messages.assistant', 'messages.tool_results', 'messages.images']);
    expect(sum(messages.children!)).toBe(messages.tokens);
    const system = b.parts.find((p) => p.key === 'system')!;
    expect(sum(system.children!)).toBe(system.tokens);
    expect(b.parts.every((p) => p.estimated)).toBe(true);
    // asking again costs nothing
    const n = gw.requests.length;
    s.contextBreakdown();
    expect(gw.requests.length).toBe(n);
    await rt.close();
  });
});
