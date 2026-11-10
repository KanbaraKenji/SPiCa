// Fake model gateway for deterministic tests.
// Speaks OpenAI-compatible chat completions (SSE), Anthropic Messages (SSE)
// and an OAuth2 client-credentials token endpoint (WSO2-style), with
// scripted replies, failures, delays and token expiry.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { listenFetchable } from '../net.ts';

export interface ScriptedToolCall {
  id?: string;
  name: string;
  /** Object (serialized for you) or a raw argument string. */
  args: unknown;
}

export interface ScriptedReply {
  /** Return this HTTP status with `errorBody` instead of a stream. */
  status?: number;
  /** Answer 200 with this JSON body instead of a stream (a gateway that does not stream). */
  json?: string;
  errorBody?: string;
  headers?: Record<string, string>;
  /** Answer text; an array is sent as separate deltas. */
  text?: string | string[];
  reasoning?: string | string[];
  toolCalls?: ScriptedToolCall[];
  usage?: { input: number; output: number; cacheRead?: number };
  /** Delay before the response headers. */
  delayMs?: number;
  /** Delay between stream chunks. */
  chunkDelayMs?: number;
  /** Stop after this many text chunks and keep the connection open until the client aborts. */
  hangAfterChunks?: number;
  /** Override the finish / stop reason. */
  finish?: string;
}

export interface ReceivedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  at: number;
}

export interface FakeGatewayOptions {
  /** Static API key accepted as Bearer / x-api-key. If unset and oauth unset, auth is not checked. */
  apiKey?: string;
  oauth?: { clientId: string; clientSecret: string; tokenTtlMs?: number };
  /** Like gateways that stream but do not know stream_options: a request with it gets a 400 naming it. */
  rejectStreamOptions?: boolean;
}

export class FakeGateway {
  readonly requests: ReceivedRequest[] = [];
  readonly tokenRequests: { at: number; grantType: string }[] = [];
  #queue: ScriptedReply[] = [];
  #handler: ((req: ReceivedRequest) => ScriptedReply) | undefined;
  #server: Server | undefined;
  #tokens = new Map<string, number>(); // token -> expiry
  #open = new Set<ServerResponse>();
  readonly #opts: FakeGatewayOptions;
  inFlight = 0;
  maxInFlight = 0;
  /** Run before the server goes away (makeRuntime registers its runtime's close here). */
  readonly #beforeStop: (() => Promise<void>)[] = [];

  constructor(opts: FakeGatewayOptions = {}) {
    this.#opts = opts;
  }

  get baseUrl(): string {
    const addr = this.#server?.address() as AddressInfo | undefined;
    if (!addr) throw new Error('gateway not started');
    return `http://127.0.0.1:${addr.port}`;
  }

  async start(): Promise<this> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await listenFetchable(this.#server); // never a port fetch refuses (Windows hands out ports from 1024 up)
    return this;
  }

  /**
   * Call `fn` first when the gateway stops. Runtimes made for this gateway are
   * closed this way before their streams are cut: cutting a live stream is what
   * occasionally crashes Node 24.15 on Windows natively (see scripts/diag), and
   * a runtime left running would keep calling into the next test.
   */
  closeBeforeStop(fn: () => Promise<void>): void {
    this.#beforeStop.push(fn);
  }

  async stop(): Promise<void> {
    for (const fn of this.#beforeStop.splice(0)) {
      try {
        await fn();
      } catch {
        // a runtime that cannot close cleanly must not keep the gateway up
      }
    }
    for (const res of this.#open) res.destroy();
    await new Promise<void>((r) => {
      if (!this.#server) return r();
      this.#server.close(() => r());
      this.#server.closeAllConnections(); // do not wait for keep-alive sockets
    });
  }

  enqueue(...replies: ScriptedReply[]): this {
    this.#queue.push(...replies);
    return this;
  }

  /** Compute replies dynamically (used when the queue is empty). */
  onRequest(fn: (req: ReceivedRequest) => ScriptedReply): this {
    this.#handler = fn;
    return this;
  }

  /** Make every issued OAuth token invalid (simulates expiry). */
  expireTokens(): void {
    for (const k of this.#tokens.keys()) this.#tokens.set(k, 0);
  }

  get pending(): number {
    return this.#queue.length;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.endsWith('/oauth2/token')) return this.#token(req, res, raw);
    if (url.pathname === '/health') return void res.end('ok');
    if (!this.#authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: { message: 'invalid or expired credentials' } }));
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // keep empty
    }
    const received: ReceivedRequest = { path: url.pathname, headers: req.headers, body, at: Date.now() };
    this.requests.push(received);
    const reply = this.#queue.shift() ?? this.#handler?.(received) ?? { text: 'ok' };
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.#open.add(res);
    res.on('close', () => {
      this.inFlight--;
      this.#open.delete(res);
    });
    if (reply.delayMs) await wait(reply.delayMs);
    if (this.#opts.rejectStreamOptions && body.stream_options !== undefined) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options', type: 'invalid_request_error' } }));
    }
    if (reply.json !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json', ...reply.headers });
      return void res.end(reply.json);
    }
    if (reply.status && reply.status >= 400) {
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      return void res.end(reply.errorBody ?? JSON.stringify({ error: { message: `scripted ${reply.status}` } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...reply.headers });
    if (url.pathname.endsWith('/messages')) await this.#anthropic(res, body, reply);
    else await this.#openai(res, body, reply);
  }

  #authorized(req: IncomingMessage): boolean {
    const { apiKey, oauth } = this.#opts;
    if (!apiKey && !oauth) return true;
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const xKey = req.headers['x-api-key'];
    if (apiKey && (bearer === apiKey || xKey === apiKey)) return true;
    if (oauth && bearer) {
      const exp = this.#tokens.get(bearer);
      return exp !== undefined && exp > Date.now();
    }
    return false;
  }

  #token(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const form = new URLSearchParams(raw);
    let id = form.get('client_id');
    let secret = form.get('client_secret');
    const basic = /^Basic (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    if (basic) [id, secret] = Buffer.from(basic, 'base64').toString('utf8').split(':') as [string, string];
    this.tokenRequests.push({ at: Date.now(), grantType: form.get('grant_type') ?? '' });
    const o = this.#opts.oauth;
    if (!o || form.get('grant_type') !== 'client_credentials' || id !== o.clientId || secret !== o.clientSecret) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: 'invalid_client' }));
    }
    const ttl = o.tokenTtlMs ?? 3_600_000;
    const token = randomUUID();
    this.#tokens.set(token, Date.now() + ttl);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: Math.round(ttl / 1000) }));
  }

  async #openai(res: ServerResponse, body: Record<string, unknown>, r: ScriptedReply): Promise<void> {
    const model = String(body.model ?? 'fake-model');
    const send = async (obj: unknown) => {
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (r.chunkDelayMs) await wait(r.chunkDelayMs);
    };
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    for (const piece of toArray(r.reasoning)) await send(chunk({ reasoning_content: piece }));
    let n = 0;
    for (const piece of toArray(r.text)) {
      await send(chunk({ content: piece }));
      if (r.hangAfterChunks !== undefined && ++n >= r.hangAfterChunks) return; // leave open
    }
    const calls = r.toolCalls ?? [];
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i]!;
      const args = typeof c.args === 'string' ? c.args : JSON.stringify(c.args);
      const half = Math.ceil(args.length / 2);
      await send(chunk({ tool_calls: [{ index: i, id: c.id ?? `call_${i}_${randomUUID().slice(0, 6)}`, type: 'function', function: { name: c.name, arguments: '' } }] }));
      await send(chunk({ tool_calls: [{ index: i, function: { arguments: args.slice(0, half) } }] }));
      await send(chunk({ tool_calls: [{ index: i, function: { arguments: args.slice(half) } }] }));
    }
    await send(chunk({}, r.finish ?? (calls.length > 0 ? 'tool_calls' : 'stop')));
    const u = r.usage ?? { input: 100, output: 20 };
    await send({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      model,
      choices: [],
      usage: {
        prompt_tokens: u.input,
        completion_tokens: u.output,
        total_tokens: u.input + u.output,
        ...(u.cacheRead !== undefined ? { prompt_tokens_details: { cached_tokens: u.cacheRead } } : {}),
      },
    });
    if (!res.destroyed) res.end('data: [DONE]\n\n');
  }

  async #anthropic(res: ServerResponse, body: Record<string, unknown>, r: ScriptedReply): Promise<void> {
    const model = String(body.model ?? 'fake-claude');
    const send = async (event: string, obj: Record<string, unknown>) => {
      if (res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...obj })}\n\n`);
      if (r.chunkDelayMs) await wait(r.chunkDelayMs);
    };
    const u = r.usage ?? { input: 100, output: 20 };
    await send('message_start', {
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        usage: { input_tokens: u.input, output_tokens: 1, ...(u.cacheRead !== undefined ? { cache_read_input_tokens: u.cacheRead } : {}) },
      },
    });
    let index = 0;
    const reasoning = toArray(r.reasoning);
    if (reasoning.length > 0) {
      await send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      for (const piece of reasoning) await send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: piece } });
      await send('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'sig-fake' } });
      await send('content_block_stop', { index });
      index++;
    }
    const text = toArray(r.text);
    if (text.length > 0) {
      await send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      let n = 0;
      for (const piece of text) {
        await send('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
        if (r.hangAfterChunks !== undefined && ++n >= r.hangAfterChunks) return;
      }
      await send('content_block_stop', { index });
      index++;
    }
    for (const c of r.toolCalls ?? []) {
      const args = typeof c.args === 'string' ? c.args : JSON.stringify(c.args);
      const half = Math.ceil(args.length / 2);
      await send('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: c.id ?? `toolu_${randomUUID().slice(0, 8)}`, name: c.name, input: {} },
      });
      await send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: args.slice(0, half) } });
      await send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: args.slice(half) } });
      await send('content_block_stop', { index });
      index++;
    }
    await send('message_delta', {
      delta: { stop_reason: r.finish ?? ((r.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn') },
      usage: { output_tokens: u.output },
    });
    await send('message_stop', {});
    if (!res.destroyed) res.end();
  }
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
