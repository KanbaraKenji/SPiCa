// How long one answer may be: each model's own most output (defaults.outputByModel, the desktop app), else maxTokens.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostLedger } from './cost.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway } from './testing/helpers.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const sent = (gw: FakeGateway, i = -1) => (gw.requests.at(i)?.body as { max_tokens?: number }).max_tokens;

describe('the most output of a model', () => {
  it('what the provider said for it first, then the catalog; never guessed', () => {
    const l = new CostLedger({ 'openai-compatible': { known: { input: 1, output: 1, maxOutput: 64_000 }, '*': { input: 1, output: 1, maxOutput: 999 } } });
    expect(l.maxOutput('p', 'openai-compatible', 'known')).toBe(64_000);
    expect(l.maxOutput('p', 'openai-compatible', 'other')).toBeNull(); // not from a `*` row
    l.setMaxOutputs('p', { other: 8_000, known: 32_000, bad: 0 });
    expect(l.maxOutput('p', 'openai-compatible', 'other')).toBe(8_000);
    expect(l.maxOutput('p', 'openai-compatible', 'known')).toBe(32_000);
    expect(l.maxOutput('p', 'openai-compatible', 'bad')).toBeNull();
    l.setMaxOutputs('p', {});
    expect(l.maxOutput('p', 'openai-compatible', 'known')).toBe(64_000);
    // the built-in catalog carries it
    expect(new CostLedger().maxOutput('x', 'openai-compatible', 'deepseek-flash')).toBe(384_000);
  });
});

describe('a call asks for its model’s most output', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await startGateway();
    gw.onRequest(() => ({ text: 'ok' }));
  });
  afterEach(async () => {
    await gw.stop();
  });

  const byModel = (model: string) => ({ providerId: 'fake-openai', model, maxTokens: 4096, outputByModel: true });

  it('the catalog’s number for a known model, 4096 for one nobody knows; another model in the same conversation gets its own', async () => {
    const rt = makeRuntime(gw, { defaults: byModel('deepseek-flash') });
    const s = rt.createSession();
    await s.send('a').done;
    expect(sent(gw)).toBe(384_000);
    s.setModel('fake-openai', 'fake-model');
    await s.send('b').done;
    expect(sent(gw)).toBe(4096);
    expect(rt.outputLimit(undefined, 'fake-openai', 'openai-compatible', 'gpt-6-astra')).toBe(128_000);
  });

  it('without outputByModel (scripts, the MCP service): maxTokens as before; a session that asked for its own keeps it', async () => {
    const rt = makeRuntime(gw, { defaults: { providerId: 'fake-openai', model: 'deepseek-flash', maxTokens: 512 } });
    await rt.createSession().send('a').done;
    expect(sent(gw)).toBe(512);
    const own = makeRuntime(gw, { defaults: byModel('deepseek-flash') }).createSession({ maxTokens: 300 });
    await own.send('b').done;
    expect(sent(gw)).toBe(300);
  });

  it('a long conversation asks for less, so input and answer fit in the context window', async () => {
    const rt = makeRuntime(gw, { defaults: byModel('fake-model') });
    rt.ledger.setContextWindows('fake-openai', { 'fake-model': 6000 });
    const s = rt.createSession();
    await s.send('x'.repeat(9000)).done; // about 6000 tokens by the estimate, near the window
    const asked = sent(gw)!;
    expect(asked).toBeGreaterThanOrEqual(1);
    expect(asked).toBeLessThan(4096);
  });
});
