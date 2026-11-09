import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyDraft } from '../../shared/providers';
import { createProvider, probeProvider } from '@spica/core';
import { createRealTester, probeMessage } from './real-tester';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    if (!auth.includes('good-key')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
  server.close();
});

const draft = (secret: string, baseUrl = base) => ({ ...emptyDraft('openai'), name: 'local', baseUrl, model: 'm', secret });

describe('real connection tester', () => {
  // The app probes through the backend process; here the core runs in the test process.
  const test = createRealTester((config, model, timeoutMs) => probeProvider(createProvider(config), { model, timeoutMs }));

  it('says the key is wrong on 401 (the core cause first, then which field to check)', async () => {
    const r = await test(draft('made-up'), undefined);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^调模型失败：.*401/);
    expect(r.message.endsWith('请检查「API Key」。')).toBe(true);
    expect(r.message).not.toContain('密钥不对或已失效：');
  });

  it('passes when the model answers', async () => {
    expect(await test(draft('good-key'), undefined)).toMatchObject({ ok: true });
  });

  it('says it cannot connect when nothing listens', async () => {
    const r = await test(draft('good-key', 'http://127.0.0.1:1/v1'), undefined);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('连不上');
  });

  it('checks the form before calling anything', async () => {
    expect(await test({ ...draft('k'), model: '' }, undefined)).toEqual({ ok: false, message: '填要用的模型名' });
  });
});

describe('probeMessage', () => {
  it('points at the field to fix for each kind of failure', () => {
    const openai = { kind: 'openai' as const, model: 'm1' };
    const wso2 = { kind: 'wso2' as const, model: 'm1' };
    expect(probeMessage({ ok: false, latencyMs: 5, errorCode: 'auth' }, wso2)).toContain('Client Secret');
    expect(probeMessage({ ok: false, latencyMs: 5, errorCode: 'not_found' }, openai)).toBe('找不到模型「m1」或这个地址：请检查「模型」和「接口地址」。');
    expect(probeMessage({ ok: false, latencyMs: 5, errorCode: 'network' }, wso2)).toContain('取 token 地址');
    expect(probeMessage({ ok: false, latencyMs: 5, errorCode: 'rate_limited' }, openai)).toContain('同时请求');
    expect(probeMessage({ ok: true, latencyMs: 900, firstByteMs: 420, model: 'm1-2026' }, openai)).toBe('连得上，模型「m1」可以用（420 毫秒开始回应，服务端回报的型号是「m1-2026」）。');
    expect(probeMessage({ ok: true, latencyMs: 900, firstByteMs: 420, model: 'm1' }, openai)).toBe('连得上，模型「m1」可以用（420 毫秒开始回应）。');
  });
});
