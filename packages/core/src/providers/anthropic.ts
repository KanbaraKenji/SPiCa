// Anthropic Messages API provider (native streaming, tool use, prompt caching,
// optional model-hosted web search). Raw HTTP so the core owns retries,
// credentials and stream handling.
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

export interface AnthropicOptions {
  id: string;
  apiKey?: string;
  auth?: AuthSource;
  /** Default https://api.anthropic.com/v1 */
  baseUrl?: string;
  apiVersion?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  retry?: RetryPolicy;
  /** Mark system prompt, tool list and latest message as cacheable. Default true. */
  promptCache?: boolean;
  /** Server tool type string used for web search. */
  webSearchToolType?: string;
  /** Enables model-hosted web search when requested. Default true. */
  webSearch?: boolean;
  /** Fields merged into every request body (thinking, output_config, ...). */
  bodyDefaults?: Record<string, unknown>;
  /** Record the endpoint host name in traces instead of the provider id. Default false. */
  traceHost?: boolean;
  fetchImpl?: typeof fetch;
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly kind = 'anthropic';
  readonly traceTarget: string;
  readonly capabilities: { serverWebSearch: boolean };
  readonly #opts: AnthropicOptions;
  readonly #auth: AuthSource | undefined;
  readonly #baseUrl: string;

  constructor(opts: AnthropicOptions) {
    this.id = opts.id;
    this.#opts = opts;
    this.#baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    this.traceTarget = opts.traceHost ? hostOf(this.#baseUrl) : opts.id;
    this.capabilities = { serverWebSearch: opts.webSearch ?? true };
    this.#auth = opts.auth ?? (opts.apiKey ? staticAuth({ 'x-api-key': opts.apiKey }) : undefined);
  }
  buildBody(req: ModelRequest): Record<string, unknown> {
    const cache = this.#opts.promptCache ?? true;
    const messages = toAnthropicMessages(req.messages, this.id);
    if (cache && messages.length > 0) markLastBlockCacheable(messages[messages.length - 1]!);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      stream: true,
      messages,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    if (req.system) {
      body.system = [{ type: 'text', text: req.system, ...(cache ? { cache_control: { type: 'ephemeral' } } : {}) }];
    }
    const tools: Record<string, unknown>[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    for (const st of req.serverTools ?? []) {
      if (st.kind === 'web_search' && this.capabilities.serverWebSearch) {
        tools.push({
          type: this.#opts.webSearchToolType ?? 'web_search_20250305',
          name: 'web_search',
          ...(st.maxUses ? { max_uses: st.maxUses } : {}),
        });
      }
    }
    if (tools.length > 0) {
      if (cache) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } };
      body.tools = tools;
    }
    Object.assign(body, this.#opts.bodyDefaults, req.extra);
    return body;
  }

  async *stream(req: ModelRequest, ctx: ProviderCallContext): AsyncGenerator<ProviderEvent, void> {
    const res = await postWithRetry({
      url: `${this.#baseUrl}/messages`,
      body: JSON.stringify(this.buildBody(req)),
      headers: {
        accept: 'text/event-stream',
        'anthropic-version': this.#opts.apiVersion ?? '2023-06-01',
        ...this.#opts.headers,
      },
      ...(this.#auth ? { auth: this.#auth } : {}),
      signal: ctx.signal,
      timeoutMs: this.#opts.timeoutMs ?? 120_000,
      retry: this.#opts.retry ?? DEFAULT_RETRY,
      secrets: this.#opts.apiKey ? [this.#opts.apiKey] : [],
      ...(ctx.info ? { info: ctx.info } : {}),
      ...(ctx.onRetry ? { onRetry: ctx.onRetry } : {}),
      ...(this.#opts.fetchImpl ? { fetchImpl: this.#opts.fetchImpl } : {}),
    });
    if (!res.body) throw new ProviderError('empty response body', { retryable: true });
    yield* parseAnthropicStream(res.body, {
      providerId: this.id,
      idleTimeoutMs: this.#opts.idleTimeoutMs ?? 90_000,
      signal: ctx.signal,
      fallbackModel: req.model,
    });
  }
}

interface BlockAcc {
  type: string;
  text: string;
  json: string;
  signature: string;
  raw: Record<string, unknown>;
}

/** Parse an Anthropic Messages SSE stream. */
export async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
  opts: { providerId: string; idleTimeoutMs?: number; signal?: AbortSignal; fallbackModel: string },
): AsyncGenerator<ProviderEvent, void> {
  const blocks = new Map<number, BlockAcc>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stop: string | undefined;
  let model = opts.fallbackModel;
  for await (const ev of parseSse(body, {
    ...(opts.idleTimeoutMs ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })) {
    let data: AnyRecord;
    try {
      data = JSON.parse(ev.data) as AnyRecord;
    } catch {
      continue;
    }
    switch (data.type) {
      case 'message_start': {
        const msg = (data.message ?? {}) as AnyRecord;
        if (typeof msg.model === 'string') model = msg.model;
        applyUsage(usage, msg.usage as AnyRecord | undefined);
        break;
      }
      case 'content_block_start': {
        const cb = (data.content_block ?? {}) as AnyRecord;
        const acc: BlockAcc = {
          type: String(cb.type),
          text: typeof cb.text === 'string' ? cb.text : typeof cb.thinking === 'string' ? cb.thinking : '',
          json: '',
          signature: typeof cb.signature === 'string' ? cb.signature : '',
          raw: cb,
        };
        blocks.set(Number(data.index), acc);
        if (acc.type === 'tool_use') yield { type: 'tool_call', id: String(cb.id), name: String(cb.name) };
        if (acc.type === 'text' && acc.text) yield { type: 'text', delta: acc.text };
        break;
      }
      case 'content_block_delta': {
        const acc = blocks.get(Number(data.index));
        const d = (data.delta ?? {}) as AnyRecord;
        if (!acc) break;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          acc.text += d.text;
          yield { type: 'text', delta: d.text };
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          acc.text += d.thinking;
          yield { type: 'thinking', delta: d.thinking };
        } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
          acc.signature += d.signature;
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          acc.json += d.partial_json;
        } else if (d.type === 'citations_delta') {
          const list = (acc.raw.citations as unknown[] | undefined) ?? [];
          list.push(d.citation);
          acc.raw.citations = list;
        }
        break;
      }
      case 'message_delta': {
        const d = (data.delta ?? {}) as AnyRecord;
        if (typeof d.stop_reason === 'string') stop = d.stop_reason;
        applyUsage(usage, data.usage as AnyRecord | undefined);
        break;
      }
      case 'error': {
        const err = (data.error ?? {}) as AnyRecord;
        const type = String(err.type ?? 'error');
        throw new ProviderError(`stream error (${type}): ${String(err.message ?? '').slice(0, 300)}`, {
          retryable: type === 'overloaded_error' || type === 'api_error',
        });
      }
      default:
        break;
    }
  }
  const content: ContentBlock[] = [];
  for (const [, b] of [...blocks.entries()].sort((a, c) => a[0] - c[0])) {
    content.push(finishBlock(b, opts.providerId));
  }
  const response: ModelResponse = {
    content,
    stopReason: mapStop(stop),
    ...(stop ? { rawStopReason: stop } : {}),
    usage,
    model,
  };
  yield { type: 'response', response };
}

function finishBlock(b: BlockAcc, providerId: string): ContentBlock {
  switch (b.type) {
    case 'text': {
      const raw = b.raw;
      if (Array.isArray(raw.citations) && raw.citations.length > 0) {
        return { type: 'opaque', provider: providerId, data: { ...raw, text: b.text }, text: b.text };
      }
      return { type: 'text', text: b.text };
    }
    case 'thinking':
      return { type: 'thinking', text: b.text, signature: b.signature, provider: providerId };
    case 'redacted_thinking':
      return { type: 'thinking', text: '', redacted: true, signature: String(b.raw.data ?? ''), provider: providerId };
    case 'tool_use': {
      let input: unknown = {};
      if (b.json.trim() !== '') {
        try {
          input = JSON.parse(b.json);
        } catch {
          input = { __invalid_json__: b.json };
        }
      } else if (b.raw.input && typeof b.raw.input === 'object') {
        input = b.raw.input;
      }
      return { type: 'tool_use', id: String(b.raw.id), name: String(b.raw.name), input };
    }
    default: {
      // server_tool_use, web_search_tool_result, ... carried verbatim.
      const data: AnyRecord = { ...b.raw };
      if (b.json.trim() !== '') {
        try {
          data.input = JSON.parse(b.json);
        } catch {
          // keep as is
        }
      }
      return { type: 'opaque', provider: providerId, data, text: describeServerBlock(data) };
    }
  }
}

function describeServerBlock(data: AnyRecord): string {
  if (data.type === 'server_tool_use') return `[hosted tool ${String(data.name)} called: ${JSON.stringify(data.input ?? {})}]`;
  if (data.type === 'web_search_tool_result' && Array.isArray(data.content)) {
    const lines = (data.content as AnyRecord[]).map((r) => `- ${String(r.title ?? '')} ${String(r.url ?? '')}`);
    return `[web search results]\n${lines.join('\n')}`;
  }
  return `[${String(data.type)}]`;
}

function applyUsage(u: Usage, src: AnyRecord | undefined): void {
  if (!src) return;
  if (typeof src.input_tokens === 'number') u.inputTokens = src.input_tokens;
  if (typeof src.output_tokens === 'number') u.outputTokens = src.output_tokens;
  if (typeof src.cache_read_input_tokens === 'number') u.cacheReadTokens = src.cache_read_input_tokens;
  if (typeof src.cache_creation_input_tokens === 'number') u.cacheWriteTokens = src.cache_creation_input_tokens;
}

function mapStop(s: string | undefined): StopReason {
  switch (s) {
    case 'end_turn':
    case 'stop_sequence':
    case undefined:
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause';
    default:
      return 'other';
  }
}

/** Convert Spica messages to Anthropic messages, merging consecutive same-role turns. */
export function toAnthropicMessages(messages: Message[], providerId: string): AnyRecord[] {
  const out: { role: 'user' | 'assistant'; content: AnyRecord[] }[] = [];
  for (const m of messages) {
    const blocks: AnyRecord[] = [];
    for (const b of m.content) {
      switch (b.type) {
        case 'text':
          if (b.text) blocks.push({ type: 'text', text: b.text });
          break;
        case 'thinking':
          if (b.provider !== providerId || !b.signature) break; // only the producer can read it
          blocks.push(
            b.redacted
              ? { type: 'redacted_thinking', data: b.signature }
              : { type: 'thinking', thinking: b.text, signature: b.signature },
          );
          break;
        case 'tool_use':
          blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
          break;
        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            tool_use_id: b.toolUseId,
            content: b.content,
            ...(b.isError ? { is_error: true } : {}),
          });
          break;
        case 'opaque':
          if (b.provider === providerId) blocks.push(b.data as AnyRecord);
          else if (b.text) blocks.push({ type: 'text', text: b.text });
          break;
        case 'image': {
          const data = imageBase64(b.path);
          blocks.push(data ? { type: 'image', source: { type: 'base64', media_type: b.mediaType, data } } : { type: 'text', text: `[image ${b.name ?? ''}: no longer available]` });
          break;
        }
      }
    }
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...blocks);
    else out.push({ role: m.role, content: blocks });
  }
  // tool_result blocks must lead a user turn
  for (const turn of out) {
    if (turn.role !== 'user') continue;
    const results = turn.content.filter((b) => b.type === 'tool_result');
    if (results.length > 0) turn.content = [...results, ...turn.content.filter((b) => b.type !== 'tool_result')];
  }
  return out;
}

function markLastBlockCacheable(turn: AnyRecord): void {
  const content = turn.content as AnyRecord[] | undefined;
  if (!content || content.length === 0) return;
  const last = content[content.length - 1]!;
  if (last.type === 'thinking' || last.type === 'redacted_thinking') return;
  content[content.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
}

type AnyRecord = Record<string, unknown>;
