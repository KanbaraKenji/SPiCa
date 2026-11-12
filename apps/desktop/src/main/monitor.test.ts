import { describe, expect, it } from 'vitest';
import type { CoreEvent, RequestRecord } from '@spica/protocol';
import { MonitorHub, monitorSecretsFrom, requestText, scrub } from './monitor';
import { monitorLine } from '../shared/monitor';

const KEY = 'sk-live-0123456789abcdef';
const SECRET = 'company-client-secret-xyz';
const PROXY_PASS = 'pr0xyP4ss!';

function hub(cap?: number) {
  return new MonitorHub({ secrets: () => [KEY, SECRET, PROXY_PASS], ...(cap ? { cap } : {}), now: () => new Date('2026-11-13T10:00:00Z') });
}

const ev = (body: Record<string, unknown>, sessionId = 's1'): CoreEvent => ({ seq: 1, at: '', sessionId, parentChain: [], ...body }) as unknown as CoreEvent;

const req = (over: Partial<RequestRecord> = {}): RequestRecord => ({ id: 'rq', traceId: 'tr', startedAt: '2026-11-13T10:00:00Z', durationMs: 312, sessionId: 's1', initiator: 'model', providerId: 'deepseek', model: 'deepseek-chat', attempt: 1, status: 'ok', httpStatus: 200, inputTokens: 1200, outputTokens: 80, ...over });

// Every way a credential could arrive, from every source the monitor takes lines from.
const LEAKS = [
  `Authorization: Bearer ${KEY}`,
  'authorization: Basic dXNlcjpwYXNzd29yZDEyMw==',
  'Proxy-Authorization: Basic YWxpY2U6c2VjcmV0cGFzcw==',
  'x-api-key: abcdefghijklmnopqrstuvwxyz012345',
  `connecting through http://alice:${PROXY_PASS}@proxy.example.com:8080`,
  `{"api_key":"${KEY}","client_secret":"${SECRET}"}`,
  `token=${SECRET}`,
  'header Cookie: session=abcdef0123456789',
];

describe('monitor: secrets never get in', () => {
  it.each(LEAKS)('scrubs %s', (line) => {
    const out = scrub(line, [KEY, SECRET, PROXY_PASS]);
    for (const s of [KEY, SECRET, PROXY_PASS, 'dXNlcjpwYXNzd29yZDEyMw==', 'YWxpY2U6c2VjcmV0cGFzcw==', 'abcdefghijklmnopqrstuvwxyz012345', 'abcdef0123456789']) expect(out).not.toContain(s);
    expect(out).toContain('[redacted]');
  });

  it('from the core’s output, a plugin’s output, events, requests, and so in copies and exports', () => {
    const h = hub();
    h.output('core-out', 'core', 'info', `${LEAKS[0]}\n${LEAKS[4]}\n`);
    h.output('plugin-x', 'plugin', 'info', `[mail] ${LEAKS[5]}\n`);
    h.event(ev({ type: 'error', message: `HTTP 401 for key ${KEY}`, retryable: false }));
    h.event(ev({ type: 'tool.start', callId: 'c', name: 'run_command', input: { command: `curl -H "Authorization: Bearer ${KEY}" https://example.com` } }));
    h.event(ev({ type: 'tool.end', callId: 'c', name: 'run_command', isError: true, preview: `x-api-key: ${SECRET}`, durationMs: 5 }));
    h.event(ev({ type: 'request', record: req({ status: 'error', httpStatus: 401, error: `bad key ${KEY}` }) }));
    const all = h.list().map(monitorLine).join('\n');
    expect(h.list().length).toBe(7);
    for (const s of [KEY, SECRET, PROXY_PASS]) expect(all).not.toContain(s);
  });
});

describe('monitor: lines', () => {
  it('joins output split across chunks and finds warnings and errors in it', () => {
    const h = hub();
    h.output('core-err', 'core', 'info', 'first li');
    h.output('core-err', 'core', 'info', 'ne\nWarning: something old\nUnhandled error at x\npart');
    expect(h.list().map((e) => [e.text, e.level])).toEqual([
      ['first line', 'info'],
      ['Warning: something old', 'warn'],
      ['Unhandled error at x', 'error'],
    ]);
    h.flush();
    expect(h.list().at(-1)!.text).toBe('part');
  });

  it('keeps the last lines only, and gives what came after a line', () => {
    const h = hub(3);
    for (let i = 1; i <= 5; i++) h.add('core', 'info', `line ${i}`);
    expect(h.list().map((e) => e.text)).toEqual(['line 3', 'line 4', 'line 5']);
    expect(h.list(4).map((e) => e.text)).toEqual(['line 5']);
    expect(h.list(99)).toEqual([]);
  });

  it('a 429 that was retried is a warning; a failure with nothing after it an error', () => {
    const h = hub();
    h.event(ev({ type: 'request', record: req({ status: 'error', httpStatus: 429, errorCode: 'gateway.rate_limited', retried: true, inputTokens: undefined, outputTokens: undefined }) }));
    h.event(ev({ type: 'request', record: req({ status: 'error', httpStatus: 500, errorCode: 'gateway.server', inputTokens: undefined, outputTokens: undefined }) }));
    h.event(ev({ type: 'request', record: req({ attempt: 2 }) }));
    expect(h.list().map((e) => e.level)).toEqual(['warn', 'error', 'info']);
    expect(h.list()[0]!.text).toBe('deepseek/deepseek-chat #1 429 gateway.rate_limited 312ms retried');
    expect(requestText(req({ attempt: 2 }))).toBe('deepseek/deepseek-chat #2 200 312ms in 1200 · out 80');
  });

  it('keeps tags and Markdown as they are (the page shows them as text)', () => {
    const h = hub();
    h.event(ev({ type: 'tool.end', callId: 'c', name: 'web_fetch', isError: false, preview: '<img src=x onerror=alert(1)> **bold** [a](javascript:alert(1))', durationMs: 3 }));
    expect(h.list()[0]!.text).toContain('<img src=x onerror=alert(1)> **bold** [a](javascript:alert(1))');
  });
});

describe('monitor: the values to remove', () => {
  const providers = [{ apiKey: 'sk-live-0123456789abcdef', headers: { 'x-company-token': 'abcdefghijkl' }, oauth: { clientSecret: 'consumer-secret-123', clientId: 'consumer-id-456' } }, { apiKey: '' }];

  it('keys, header values and client secrets; the proxy password plain and as written', () => {
    const v = monitorSecretsFrom(providers, 'http://alice:p%40ss%25word@proxy.example.com:8080');
    expect(v).toEqual(expect.arrayContaining(['sk-live-0123456789abcdef', 'abcdefghijkl', 'consumer-secret-123', 'consumer-id-456', 'p@ss%word', 'p%40ss%25word']));
  });

  it('a proxy that does not parse costs only its own password, never the keys', () => {
    for (const proxy of ['http://bob:50%off@proxy.example.com', 'proxy example.com:8080', 'http://[bad', 'carol:hunter2!@proxy.example.com']) {
      const v = monitorSecretsFrom(providers, proxy);
      expect(v).toEqual(expect.arrayContaining(['sk-live-0123456789abcdef', 'consumer-secret-123']));
    }
    expect(monitorSecretsFrom(providers, 'http://bob:50%off@proxy.example.com')).toContain('50%off');
    const h = new MonitorHub({ secrets: () => monitorSecretsFrom(providers, 'http://[bad') });
    h.add('plugin', 'info', 'token header x-company-token=abcdefghijkl and consumer-secret-123');
    expect(h.list()[0]!.text).not.toMatch(/abcdefghijkl|consumer-secret-123/);
  });

  it('lines carry the local time with its offset (as the page shows it)', () => {
    const h = new MonitorHub({ secrets: () => [] });
    const e = h.add('core', 'info', 'x')!;
    expect(e.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
  });
});
