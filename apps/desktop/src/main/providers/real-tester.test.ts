import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyDraft } from '../../shared/providers';
import { createRealTester } from './real-tester';

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
  const test = createRealTester();

  it('says the key is wrong on 401', async () => {
    expect(await test(draft('made-up'), undefined)).toEqual({ ok: false, message: '模型密钥不对或已失效，请检查模型设置。' });
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
