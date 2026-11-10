// A conversation whose saved address lacks /v1 (saved without testing): the
// first 404 says to check the address's ending, as test connection does.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NET_HINTS } from './net.ts';
import { probeConfig } from './host/backend.ts';
import { OpenAICompatibleProvider } from './providers/openai.ts';
import { Wso2Provider } from './providers/wso2.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, FAST_RETRY, makeRuntime, startGateway, tempDir } from './testing/helpers.ts';

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

it('a WSO2 gateway names its own field: 网关地址, in the conversation and in test connection (one place: netHint)', async () => {
  const g = await startGateway({ oauth: { clientId: 'id-1', clientSecret: 'secret-1' } });
  try {
    g.onRequest(() => ({ status: 404, errorBody: '{"error":"no such resource"}' }));
    const oauth = { tokenUrl: `${g.baseUrl}/oauth2/token`, clientId: 'id-1', clientSecret: 'secret-1' };
    const provider = new Wso2Provider({ id: 'gw', baseUrl: `${g.baseUrl}/llm`, oauth, retry: FAST_RETRY });
    const rt = makeRuntime(g, { cwd: dir, providers: [provider], defaults: { providerId: 'gw', model: 'm', maxTokens: 64 } });
    const events = captureEvents(rt);
    await rt.createSession().send('hi').done;
    await rt.close();
    const error = events.find((e) => e.type === 'error') as { code?: string; hint?: string };
    expect(error).toMatchObject({ code: 'gateway.not_found_version', hint: '路径无效（HTTP 404），请检查网关地址是否需要以 /v1 结尾。' });
    const tested = await probeConfig({ id: 'form', kind: 'wso2', baseUrl: `${g.baseUrl}/llm`, oauth }, 'm');
    expect(tested.hint).toBe('模型调用失败：路径无效（HTTP 404），请检查网关地址是否需要以 /v1 结尾。');
  } finally {
    await g.stop();
  }
  // an OpenAI-compatible connection keeps 接口地址, in the event too
  gw.onRequest(() => ({ status: 404, errorBody: '{}' }));
  const rt = makeRuntime(gw, { cwd: dir, providers: [new OpenAICompatibleProvider({ id: 'p', baseUrl: gw.baseUrl, apiKey: 'test-key-123456', retry: FAST_RETRY })], defaults: { providerId: 'p', model: 'm', maxTokens: 64 } });
  const events = captureEvents(rt);
  await rt.createSession().send('hi').done;
  await rt.close();
  expect(events.find((e) => e.type === 'error')).toMatchObject({ hint: '路径无效（HTTP 404），请检查接口地址是否需要以 /v1 结尾。' });
});
