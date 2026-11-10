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

it('a WSO2 gateway names its own field and its own kind of version (context + version, like /llm/1.0), in the conversation and in test connection (one place: netHint)', async () => {
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
    expect(error).toMatchObject({ code: 'gateway.not_found_version', hint: '路径无效（HTTP 404），请检查「网关地址」是否包含 API 的上下文和版本（如 /llm/1.0）。' });
    const tested = await probeConfig({ id: 'form', kind: 'wso2', baseUrl: `${g.baseUrl}/llm`, oauth }, 'm');
    expect(tested.hint).toBe('模型调用失败：路径无效（HTTP 404），请检查「网关地址」是否包含 API 的上下文和版本（如 /llm/1.0）。');
  } finally {
    await g.stop();
  }
  // an OpenAI-compatible connection keeps 接口地址, in the event too
  gw.onRequest(() => ({ status: 404, errorBody: '{}' }));
  const rt = makeRuntime(gw, { cwd: dir, providers: [new OpenAICompatibleProvider({ id: 'p', baseUrl: gw.baseUrl, apiKey: 'test-key-123456', retry: FAST_RETRY })], defaults: { providerId: 'p', model: 'm', maxTokens: 64 } });
  const events = captureEvents(rt);
  await rt.createSession().send('hi').done;
  await rt.close();
  expect(events.find((e) => e.type === 'error')).toMatchObject({ hint: '路径无效（HTTP 404），请检查「接口地址」是否需要以 /v1 结尾。' });
});

it('an address with a query keeps it (the path goes before it), and a version like /1.0 or /v1.0 counts as a version', async () => {
  const { endsInVersion, joinUrl } = await import('./providers/http.ts');
  expect(joinUrl('https://gw.example.com/azure/openai/deployments/gpt4o?api-version=2024-10-21', '/chat/completions')).toBe(
    'https://gw.example.com/azure/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21',
  );
  expect(joinUrl('https://gw.example.com/llm/1.0/', '/models?limit=10')).toBe('https://gw.example.com/llm/1.0/models?limit=10');
  expect(joinUrl('https://gw.example.com/x?api-version=1', '/models?limit=10')).toBe('https://gw.example.com/x/models?api-version=1&limit=10');
  expect(['/v1', '/llm/1.0', '/llm/v1.0', '/api/v2/'].map((p) => endsInVersion(`https://gw.example.com${p}`))).toEqual([true, true, true, true]);
  expect(['', '/llm', '/openai/deployments/gpt4o?api-version=2024-10-21'].map((p) => endsInVersion(`https://gw.example.com${p}`))).toEqual([false, false, false]);
  // a conversation over such an address: the request goes to the path with the query kept
  gw.onRequest(() => ({ text: 'ok' }));
  const provider = new OpenAICompatibleProvider({ id: 'p', baseUrl: `${gw.baseUrl}/openai/deployments/gpt4o?api-version=2024-10-21`, apiKey: 'test-key-123456', retry: FAST_RETRY });
  const rt = makeRuntime(gw, { cwd: dir, providers: [provider], defaults: { providerId: 'p', model: 'm', maxTokens: 64 } });
  expect((await rt.createSession().send('hi').done).reason).toBe('completed');
  await rt.close();
  expect(gw.requests.at(-1)!.path).toBe('/openai/deployments/gpt4o/chat/completions');
});

it('hints that read differently for a WSO2 gateway: a key besides the token, no model list', async () => {
  const { netHint, NET_HINTS } = await import('./net.ts');
  expect(netHint('wso2.missing_credentials', 'wso2')).toBe('请求缺少凭据（WSO2 900902），网关可能还要求在请求头中带 API Key，请向网关管理员确认。');
  expect(netHint('wso2.missing_credentials', 'openai-compatible')).toBe(NET_HINTS['wso2.missing_credentials']); // others: switch to the gateway kind
  expect(netHint('list.unsupported', 'wso2')).toBe('网关未提供模型列表，请手动输入模型。');
  expect(netHint('list.unsupported', 'openai-compatible')).toBe(NET_HINTS['list.unsupported']);
  const { listProviderModels } = await import('./catalog/list-models.ts');
  const { BUILTIN_CATALOG } = await import('./catalog/builtin.ts');
  const g = await startGateway({ oauth: { clientId: 'id-1', clientSecret: 'secret-1' } });
  try {
    g.onRequest(() => ({ status: 404, errorBody: '{"code":"404","description":"No matching resource found"}' }));
    const r = await listProviderModels({ kind: 'wso2', baseUrl: `${g.baseUrl}/llm/1.0`, oauth: { tokenUrl: `${g.baseUrl}/oauth2/token`, clientId: 'id-1', clientSecret: 'secret-1' } }, BUILTIN_CATALOG);
    expect(r).toMatchObject({ ok: false, code: 'list.unsupported', hint: '网关未提供模型列表，请手动输入模型。' });
  } finally {
    await g.stop();
  }
});
