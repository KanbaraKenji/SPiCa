// Test helpers: a runtime wired to a fake gateway, event capture, temp folders.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicProvider } from '../providers/anthropic.ts';
import { OpenAICompatibleProvider } from '../providers/openai.ts';
import { Runtime, type RuntimeOptions } from '../runtime.ts';
import type { CoreEvent } from '../types.ts';
import { FakeGateway, type FakeGatewayOptions } from './fake-gateway.ts';

export const FAST_RETRY = { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 20 };

export async function startGateway(opts?: FakeGatewayOptions): Promise<FakeGateway> {
  return new FakeGateway(opts).start();
}

export function openaiProvider(gw: FakeGateway, id = 'fake-openai'): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({ id, baseUrl: `${gw.baseUrl}/v1`, apiKey: 'test-key-123456', retry: FAST_RETRY });
}

export function anthropicProvider(gw: FakeGateway, id = 'fake-anthropic'): AnthropicProvider {
  return new AnthropicProvider({ id, baseUrl: `${gw.baseUrl}/v1`, apiKey: 'test-key-123456', retry: FAST_RETRY });
}

export function makeRuntime(gw: FakeGateway, opts: Partial<RuntimeOptions> = {}): Runtime {
  return new Runtime({
    providers: opts.providers ?? [openaiProvider(gw)],
    defaults: opts.defaults ?? { providerId: 'fake-openai', model: 'fake-model', maxTokens: 512 },
    ...opts,
    // what a deployment registers from its provider configuration (startBackend does this)
    redactions: ['test-key-123456', `${gw.baseUrl}/v1`, ...(opts.redactions ?? [])],
  });
}

/** Record every event the runtime emits. */
export function captureEvents(rt: Runtime): CoreEvent[] {
  const events: CoreEvent[] = [];
  rt.events.on((e) => events.push(e));
  return events;
}

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'spica-core-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Wait until `pred` is true (polling), or fail after `ms`. */
export async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}
