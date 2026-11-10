// A conversation whose saved address lacks /v1 (saved without testing): the
// first 404 says to check the address's ending, as test connection does.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { NET_HINTS } from './net.ts';
import { OpenAICompatibleProvider } from './providers/openai.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, FAST_RETRY, makeRuntime, startGateway, tempDir } from './testing/helpers.ts';

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

const codeOf = async (baseUrl: string): Promise<string | undefined> => {
  gw.onRequest(() => ({ status: 404, errorBody: '{"error":{"message":"Not Found"}}' }));
  const provider = new OpenAICompatibleProvider({ id: 'p', baseUrl, apiKey: 'test-key-123456', retry: FAST_RETRY });
  const rt = makeRuntime(gw, { cwd: dir, providers: [provider], defaults: { providerId: 'p', model: 'm', maxTokens: 64 } });
  const events = captureEvents(rt);
  await rt.createSession().send('hi').done;
  await rt.close();
  return (events.find((e) => e.type === 'error') as { code?: string } | undefined)?.code;
};

it('a 404 at an address without a version says to check for /v1; with /v1 it says to check the address and model', async () => {
  expect(await codeOf(gw.baseUrl)).toBe('gateway.not_found_version');
  expect(await codeOf(`${gw.baseUrl}/`)).toBe('gateway.not_found_version');
  expect(NET_HINTS['gateway.not_found_version']).toMatch(/是否需要以 \/v1 结尾/);
  expect(await codeOf(`${gw.baseUrl}/v1`)).toBe('gateway.not_found');
  expect(await codeOf(`${gw.baseUrl}/api/v2`)).toBe('gateway.not_found');
});
