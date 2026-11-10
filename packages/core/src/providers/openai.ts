// OpenAI-compatible chat completions provider (/v1/chat/completions, SSE).
// Used for any gateway that speaks this protocol (hosted APIs, LiteLLM, ...).
import { imageBase64 } from '../images.ts';
import { DEFAULT_RETRY, hostOf, postWithRetry, staticAuth, type RetryPolicy } from './http.ts';
import { parseSse } from './sse.ts';
import {
  ProviderError,
  type AuthSource,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type ProviderCallContext,
  type ProviderEvent,
} from './types.ts';
import type { ContentBlock, Message, StopReason, Usage } from '../types.ts';
import { netErrorCode } from '../net.ts';
import { isAbortError, newId } from '../util.ts';

export interface OpenAICompatibleOptions {
  id: string;
  /** Base URL up to and including the API version segment, e.g. https://host/v1 */
  baseUrl: string;
  apiKey?: string;
  /** Custom credential source; overrides apiKey (used by the WSO2 provider). */
  auth?: AuthSource;
  headers?: Record<string, string>;
  /** Path appended to baseUrl. Default /chat/completions. */
  path?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  retry?: RetryPolicy;
  /**
   * Reasoning text returned by some servers in a separate delta field.
   * `field` names it; `echo` decides when it is sent back on later turns.
   */
  reasoning?: { field?: string; echo?: 'never' | 'tool_turns' | 'always' };
  /** Fields merged into every request body (e.g. vendor options). */
  bodyDefaults?: Record<string, unknown>;
  /** Name of the max-tokens body field. Default max_tokens. */
  maxTokensField?: string;
  /** Record the endpoint host name in traces instead of the provider id. Default false. */
  traceHost?: boolean;
  fetchImpl?: typeof fetch;
}

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly kind: string = 'openai-compatible';
  readonly traceTarget: string;
  readonly capabilities = { serverWebSearch: false };
  readonly #opts: OpenAICompatibleOptions;
  readonly #auth: AuthSource | undefined;
  /** The server refused stream: true (a gateway that cannot stream): ask without streaming from now on. */
  #noStream = false;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.#opts = opts;
    this.traceTarget = opts.traceHost ? hostOf(opts.baseUrl) : opts.id;
    this.#auth = opts.auth ?? (opts.apiKey ? staticAuth({ authorization: `Bearer ${opts.apiKey}` }) : undefined);
  }

  /** Build the wire body (exported for tests and hooks that want to inspect it). */
  buildBody(req: ModelRequest): Record<string, unknown> {
    const reasoningField = this.#opts.reasoning?.field ?? 'reasoning_content';
    const echo = this.#opts.reasoning?.echo ?? 'tool_turns';
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages, this.id, reasoningField, echo),
      stream: true,
      stream_options: { include_usage: true },
      [this.#opts.maxTokensField ?? 'max_tokens']: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...this.#opts.bodyDefaults,
      ...req.extra,
    };
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }
    return body;
  }

  async *stream(req: ModelRequest, ctx: ProviderCallContext): AsyncGenerator<ProviderEvent, void> {
    const url = this.#opts.baseUrl.replace(/\/+$/, '') + (this.#opts.path ?? '/chat/completions');
    const send = (streaming: boolean) => this.#post(url, req, ctx, streaming);
    let res: Response;
    if (this.#noStream) res = await send(false);
    else {
      try {
        res = await send(true);
      } catch (err) {
        // a gateway that cannot stream says so with a 400: ask again without streaming, and from now on
        if (!(err instanceof ProviderError && err.status === 400 && /\bstream/i.test(err.message))) throw err;
        this.#noStream = true;
        res = await send(false);
      }
    }
    if (!res.body) throw new ProviderError('empty response body', { retryable: true });
    const type = res.headers.get('content-type') ?? '';
    if (/application\/json/i.test(type) && !/event-stream/i.test(type)) {
      // the whole answer at once: a gateway that does not stream (or ignores stream: true)
      yield* fromCompletion(await res.text(), { providerId: this.id, reasoningField: this.#opts.reasoning?.field ?? 'reasoning_content', fallbackModel: req.model });
      return;
    }
    try {
      yield* parseOpenAIStream(res.body, {
        providerId: this.id,
        reasoningField: this.#opts.reasoning?.field ?? 'reasoning_content',
        idleTimeoutMs: this.#opts.idleTimeoutMs ?? 90_000,
        signal: ctx.signal,
        fallbackModel: req.model,
      });
    } catch (err) {
      throw streamError(err, ctx.signal);
    }
  }

  #post(url: string, req: ModelRequest, ctx: ProviderCallContext, streaming: boolean): Promise<Response> {
    const body = this.buildBody(req);
    if (!streaming) {
      body.stream = false;
      delete body.stream_options;
    }
    return postWithRetry({
      url,
      body: JSON.stringify(body),
      headers: { accept: streaming ? 'text/event-stream' : 'application/json', ...this.#opts.headers },
      ...(this.#auth ? { auth: this.#auth } : {}),
      signal: ctx.signal,
      timeoutMs: this.#opts.timeoutMs ?? 120_000,
      retry: this.#opts.retry ?? DEFAULT_RETRY,
      secrets: this.#opts.apiKey ? [this.#opts.apiKey] : [],
      ...(ctx.info ? { info: ctx.info } : {}),
      ...(ctx.onRetry ? { onRetry: ctx.onRetry } : {}),
      ...(this.#opts.fetchImpl ? { fetchImpl: this.#opts.fetchImpl } : {}),
      // a saved address without /v1 (it is added only by test connection, not here): a 404 says to check its ending
      ...(!this.#opts.path && !/\/v\d+$/i.test(this.#opts.baseUrl.replace(/\/+$/, '')) ? { unversionedBase: true } : {}),
    });
  }
}

/** A stream that broke off or went quiet: a coded error the window can word (not a bare "terminated"). */
function streamError(err: unknown, signal: AbortSignal): unknown {
  if (signal.aborted || isAbortError(err) || err instanceof ProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if ((err as { name?: unknown })?.name === 'StreamIdleError') {
    return new ProviderError(`no data from the model for too long [gateway.stream_idle] (${message})`, { retryable: false, code: 'gateway.stream_idle' });
  }
  const code = netErrorCode(err);
  return new ProviderError(`the answer broke off [${code}] (${message})`, { retryable: false, code });
}

interface OpenAICompletion {
  model?: string;
  error?: { message?: unknown };
  usage?: OpenAIUsage | null;
  choices?: {
    message?: {
      content?: string | { type?: string; text?: string }[] | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
      [k: string]: unknown;
    };
    finish_reason?: string | null;
  }[];
}

/** A complete (not streamed) chat completion, as the same events a stream gives. */
export async function* fromCompletion(raw: string, opts: { providerId: string; reasoningField: string; fallbackModel: string }): AsyncGenerator<ProviderEvent, void> {
  let c: OpenAICompletion;
  try {
    c = JSON.parse(raw) as OpenAICompletion;
  } catch {
    throw new ProviderError(`the answer is not JSON [gateway.bad_response]: ${raw.slice(0, 200)}`, { retryable: false, code: 'gateway.bad_response' });
  }
  if (c.error) throw new ProviderError(`error: ${String(c.error.message ?? 'unknown').slice(0, 300)}`, { retryable: false });
  const choice = c.choices?.[0];
  if (!choice?.message) throw new ProviderError(`the answer has no message [gateway.bad_response]: ${raw.slice(0, 200)}`, { retryable: false, code: 'gateway.bad_response' });
  const m = choice.message;
  const text = typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  const reasoning = typeof m[opts.reasoningField] === 'string' ? (m[opts.reasoningField] as string) : '';
  const content: ContentBlock[] = [];
  if (reasoning) {
    yield { type: 'thinking', delta: reasoning };
    content.push({ type: 'thinking', text: reasoning, provider: opts.providerId });
  }
  if (text) {
    yield { type: 'text', delta: text };
    content.push({ type: 'text', text });
  }
  for (const tc of m.tool_calls ?? []) {
    const id = tc.id ?? newId('call');
    const name = tc.function?.name ?? '';
    yield { type: 'tool_call', id, name };
    content.push({ type: 'tool_use', id, name, input: parseArgs(tc.function?.arguments ?? '') });
  }
  const finish = choice.finish_reason ?? undefined;
  yield {
    type: 'response',
    response: {
      content,
      stopReason: mapFinish(finish, (m.tool_calls ?? []).length > 0),
      ...(finish ? { rawStopReason: finish } : {}),
      usage: c.usage ? parseUsage(c.usage) : { inputTokens: 0, outputTokens: 0 },
      model: c.model ?? opts.fallbackModel,
    },
  };
}

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
}

/** Parse an OpenAI-style chat completion SSE stream. */
export async function* parseOpenAIStream(
  body: ReadableStream<Uint8Array>,
  opts: { providerId: string; reasoningField: string; idleTimeoutMs?: number; signal?: AbortSignal; fallbackModel: string },
): AsyncGenerator<ProviderEvent, void> {
  let text = '';
  let reasoning = '';
  const calls = new Map<number, ToolCallAcc>();
  let finish: string | undefined;
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let model = opts.fallbackModel;
  for await (const ev of parseSse(body, {
    ...(opts.idleTimeoutMs ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })) {
    const data = ev.data.trim();
    if (data === '[DONE]') break;
    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(data) as OpenAIChunk;
    } catch {
      continue;
    }
    if (chunk.error) {
      throw new ProviderError(`stream error: ${String(chunk.error.message ?? 'unknown').slice(0, 300)}`, {
        retryable: false,
      });
    }
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = parseUsage(chunk.usage);
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      const r = delta[opts.reasoningField];
      if (typeof r === 'string' && r !== '') {
        reasoning += r;
        yield { type: 'thinking', delta: r };
      }
      if (typeof delta.content === 'string' && delta.content !== '') {
        text += delta.content;
        yield { type: 'text', delta: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        let acc = calls.get(idx);
        if (!acc) {
          acc = { id: tc.id ?? newId('call'), name: '', args: '' };
          calls.set(idx, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) {
          const first = acc.name === '';
          acc.name += tc.function.name;
          if (first) yield { type: 'tool_call', id: acc.id, name: acc.name };
        }
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  const content: ContentBlock[] = [];
  if (reasoning) content.push({ type: 'thinking', text: reasoning, provider: opts.providerId });
  if (text) content.push({ type: 'text', text });
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    content.push({ type: 'tool_use', id: c.id, name: c.name, input: parseArgs(c.args) });
  }
  const response: ModelResponse = {
    content,
    stopReason: mapFinish(finish, calls.size > 0),
    ...(finish ? { rawStopReason: finish } : {}),
    usage,
    model,
  };
  yield { type: 'response', response };
}

/** Tool arguments that fail to parse are passed on so the tool can report the problem. */
function parseArgs(raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalid_json__: raw };
  }
}

function mapFinish(reason: string | undefined, hasCalls: boolean): StopReason {
  if (hasCalls) return 'tool_use';
  switch (reason) {
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    case undefined:
      return 'end';
    default:
      return 'other';
  }
}

function parseUsage(u: OpenAIUsage): Usage {
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
  };
}

/** Convert Spica messages to OpenAI chat messages. */
export function toOpenAIMessages(
  system: string,
  messages: Message[],
  providerId: string,
  reasoningField: string,
  echo: 'never' | 'tool_turns' | 'always',
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content
        .map((b) => (b.type === 'text' ? b.text : b.type === 'opaque' && b.text ? b.text : ''))
        .filter(Boolean)
        .join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use');
      const msg: Record<string, unknown> = { role: 'assistant', content: text || null };
      if (calls.length > 0) {
        msg.tool_calls = calls.map((b) =>
          b.type === 'tool_use'
            ? { id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }
            : null,
        );
      }
      if (echo === 'always' || (echo === 'tool_turns' && calls.length > 0)) {
        const reasoning = m.content
          .filter((b) => b.type === 'thinking' && b.provider === providerId)
          .map((b) => (b.type === 'thinking' ? b.text : ''))
          .join('');
        if (reasoning) msg[reasoningField] = reasoning;
      }
      if (msg.content === null && !msg.tool_calls) msg.content = '';
      out.push(msg);
      continue;
    }
    // user side: tool results become role=tool messages, placed first
    for (const b of m.content) {
      if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
    }
    const text = m.content
      .map((b) => (b.type === 'text' ? b.text : b.type === 'opaque' && b.text ? b.text : ''))
      .filter(Boolean)
      .join('\n');
    const images = m.content.filter((b) => b.type === 'image');
    if (images.length === 0) {
      if (text) out.push({ role: 'user', content: text });
      continue;
    }
    // with images: content parts (text first, then each image as a data URL)
    const parts: Record<string, unknown>[] = text ? [{ type: 'text', text }] : [];
    for (const b of images) {
      if (b.type !== 'image') continue;
      const data = imageBase64(b.path);
      parts.push(data ? { type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${data}` } } : { type: 'text', text: `[image ${b.name ?? ''}: no longer available]` });
    }
    out.push({ role: 'user', content: parts });
  }
  return out;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
}

interface OpenAIChunk {
  model?: string;
  error?: { message?: unknown };
  usage?: OpenAIUsage | null;
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
      [k: string]: unknown;
    };
    finish_reason?: string | null;
  }[];
}
