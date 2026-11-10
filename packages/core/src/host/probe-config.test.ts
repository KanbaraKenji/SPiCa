// Test connection with an address that lacks /v1: a gateway answering 404 gets
// one more try with /v1 added; the form (or the agent's save) takes the address
// that worked. Conversations never change the address on their own.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { listenFetchable } from '../net.ts';
import { probeConfig } from './backend.ts';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

/** A made-up gateway that answers chat only under `prefix` (404 elsewhere); counts the paths asked for. */
async function gateway(prefix: string | null): Promise<{ base: string; paths: string[] }> {
  const paths: string[] = [];
  const s = createServer((req, res) => {
    req.resume();
    paths.push(req.url ?? '');
    if (prefix !== null && req.url === `${prefix}/chat/completions`) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return void res.end(
        'data: {"id":"c","model":"m","choices":[{"index":0,"delta":{"content":"pong"}}]}\n\n' +
          'data: {"id":"c","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
      );
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not found"}}');
  });
  servers.push(s);
  return { base: `http://127.0.0.1:${await listenFetchable(s)}`, paths };
}

const config = (baseUrl: string) => ({ id: 'gw', kind: 'openai-compatible' as const, baseUrl, apiKey: 'sk-probe-test-123456' });

describe('test connection and a missing /v1', () => {
  it('an address without /v1 that works once /v1 is added: ok, with the address to use and a plain hint', async () => {
    const g = await gateway('/api/v1');
    const r = await probeConfig(config(`${g.base}/api`), 'm');
    expect(r).toMatchObject({ ok: true, suggestedBaseUrl: `${g.base}/api/v1`, code: 'address.v1_added', hint: '已在 接口地址 末尾补上 /v1，连接成功。' });
    expect(g.paths).toEqual(['/api/chat/completions', '/api/v1/chat/completions']);
    // a trailing slash is not a different address
    expect(await probeConfig(config(`${g.base}/api/`), 'm')).toMatchObject({ ok: true, suggestedBaseUrl: `${g.base}/api/v1` });
  });

  it('an address that already ends in a version is left alone', async () => {
    const g = await gateway('/api/v1');
    const r = await probeConfig(config(`${g.base}/api/v1`), 'm');
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty('suggestedBaseUrl');
    expect(g.paths).toEqual(['/api/v1/chat/completions']);
    // a 404 at a versioned address: no second try, the usual hint
    const v2 = await probeConfig(config(`${g.base}/api/v2`), 'm');
    expect(v2).toMatchObject({ ok: false, httpStatus: 404, code: 'gateway.not_found', hint: '模型调用失败：路径无效（HTTP 404），请检查接口地址和模型名。' });
    expect(g.paths).toEqual(['/api/v1/chat/completions', '/api/v2/chat/completions']);
  });

  it('still 404 with /v1 added: the first 404, with a hint to check the ending of the address', async () => {
    const g = await gateway(null);
    const r = await probeConfig(config(`${g.base}/api`), 'm');
    expect(r).toMatchObject({ ok: false, httpStatus: 404, code: 'gateway.not_found_version', hint: '模型调用失败：路径无效（HTTP 404），请检查 接口地址 是否需要以 /v1 结尾。' });
    expect(r).not.toHaveProperty('suggestedBaseUrl');
    expect(g.paths).toEqual(['/api/chat/completions', '/api/v1/chat/completions']);
    expect(JSON.stringify(r)).not.toContain('sk-probe-test-123456');
  });

  it('the same for a company gateway (WSO2): the token step is not retried, the model step is', async () => {
    const paths: string[] = [];
    const s = createServer((req, res) => {
      req.resume();
      paths.push(req.url ?? '');
      if (req.url === '/oauth2/token') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"access_token":"t","expires_in":3600}');
      if (req.url === '/llm/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return void res.end('data: {"id":"c","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
      }
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    });
    servers.push(s);
    const base = `http://127.0.0.1:${await listenFetchable(s)}`;
    const r = await probeConfig({ id: 'w', kind: 'wso2', baseUrl: `${base}/llm`, oauth: { tokenUrl: `${base}/oauth2/token`, clientId: 'ck-test-1', clientSecret: 'cs-test-1' } }, 'm');
    expect(r).toMatchObject({ ok: true, suggestedBaseUrl: `${base}/llm/v1` });
    expect(paths.filter((p) => p.includes('chat'))).toEqual(['/llm/chat/completions', '/llm/v1/chat/completions']);
  });
});
