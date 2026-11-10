// "Get the models from the provider": ask the provider which models it has now,
// so the form offers models the catalog does not list. Never required: when it
// fails (no such endpoint, wrong key, network) the form keeps the catalog list
// and lets the user type a name.
import { htmlTitle, httpErrorCode, looksLikeHtml, netErrorCode, netFetch, netHint } from '../net.ts';
import { joinUrl } from '../providers/http.ts';
import { OAuthClientCredentials } from '../providers/wso2.ts';
import { redact } from '../util.ts';
import type { CatalogProvider, ListStyle, ModelCatalog } from './catalog.ts';

export interface ListedModel {
  id: string;
  label?: string;
  /** From the provider's answer when it says, else from the catalog. */
  contextWindow?: number;
  maxOutput?: number;
  /** In the catalog's short list for this provider. */
  inCatalog: boolean;
  /** False for embedding, speech, image, moderation or rerank models (the form hides them by default). */
  chat: boolean;
}

export type ListModelsResult =
  | { ok: true; models: ListedModel[] }
  /** code: list.unsupported (the provider has no model list), list.bad_response, or a net.* / tls.* / proxy.* / gateway.* / wso2.* code; hint in Chinese. */
  | { ok: false; code: string; hint?: string; httpStatus?: number; message: string };

/** What is needed to ask: the connection as configured (the key is used for this request only). */
export interface ListModelsRequest {
  kind: 'openai-compatible' | 'anthropic' | 'wso2';
  baseUrl?: string;
  apiKey?: string;
  oauth?: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string };
  headers?: Record<string, string>;
  /** The catalog provider it was set up from (how to ask, what the short list knows). */
  catalogId?: string;
}

const NOT_CHAT = /(embed|tts|whisper|transcri|speech|audio|dall-e|image|moderation|rerank|realtime)/i;
const ANTHROPIC_VERSION = '2023-06-01';

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

/** A model entry from any of the list formats. */
function entry(m: Record<string, unknown>): { id: string; label?: string; contextWindow?: number; maxOutput?: number } | undefined {
  const id = [m.id, m.key, m.model, m.name].find((v) => typeof v === 'string' && v) as string | undefined;
  if (!id) return undefined;
  const top = (m.top_provider ?? {}) as Record<string, unknown>;
  const contextWindow = num(m.context_window) ?? num(m.context_length) ?? num(m.max_input_tokens) ?? num(m.max_context_length) ?? num(top.context_length) ?? num(m.inputTokenLimit);
  const maxOutput = num(m.max_output_tokens) ?? num(m.max_tokens) ?? num(top.max_completion_tokens) ?? num(m.outputTokenLimit);
  const label = [m.display_name, m.displayName].find((v) => typeof v === 'string' && v) as string | undefined;
  return { id: id.replace(/^models\//, ''), ...(label && label !== id ? { label } : {}), ...(contextWindow ? { contextWindow } : {}), ...(maxOutput ? { maxOutput } : {}) };
}

/** The list inside an answer: `data`, `models`, or the answer itself. */
function listOf(body: unknown): Record<string, unknown>[] | undefined {
  const b = body as { data?: unknown; models?: unknown } | null;
  const arr = Array.isArray(body) ? body : Array.isArray(b?.data) ? b!.data : Array.isArray(b?.models) ? b!.models : undefined;
  return arr?.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
}

/**
 * Ask a provider for its models. Times out after `timeoutMs` (default 15 s).
 * Secrets never appear in the result (messages are redacted with them).
 */
export async function listProviderModels(req: ListModelsRequest, catalog: ModelCatalog, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<ListModelsResult> {
  const provider: CatalogProvider | undefined = req.catalogId ? catalog.providers.find((p) => p.id === req.catalogId) : undefined;
  const style: ListStyle = provider?.listModels ?? (req.kind === 'anthropic' ? 'anthropic' : 'none');
  const base = (req.baseUrl || provider?.baseUrl || (req.kind === 'anthropic' ? 'https://api.anthropic.com/v1' : '')).replace(/\/+$/, '');
  const secrets = [req.apiKey, req.oauth?.clientSecret, req.oauth?.clientId].filter((s): s is string => !!s);
  const fail = (code: string, message: string, httpStatus?: number): ListModelsResult => ({
    ok: false,
    code,
    ...(netHint(code, req.kind) ? { hint: netHint(code, req.kind) } : {}),
    ...(httpStatus ? { httpStatus } : {}),
    message: redact(message, secrets).slice(0, 300),
  });
  if (!/^https?:\/\//i.test(base)) return fail('list.unsupported', 'no API address to ask');
  const doFetch = opts.fetchImpl ?? netFetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  let auth: Record<string, string> = {};
  try {
    if (req.kind === 'wso2' && req.oauth) auth = await new OAuthClientCredentials(req.oauth).headers(signal);
    else if (req.kind === 'anthropic' && req.apiKey) auth = { 'x-api-key': req.apiKey, 'anthropic-version': ANTHROPIC_VERSION };
    else if (req.apiKey) auth = { authorization: `Bearer ${req.apiKey}` };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    return fail(typeof code === 'string' ? code : 'wso2.token_rejected', err instanceof Error ? err.message : String(err));
  }
  const headers = { accept: 'application/json', ...(req.headers ?? {}), ...auth };
  const getJson = async (url: string): Promise<{ ok: true; body: unknown } | { ok: false; result: ListModelsResult }> => {
    let res: Response;
    try {
      res = await doFetch(url, { headers, signal });
    } catch (err) {
      return { ok: false, result: fail(signal.aborted ? 'net.timeout' : netErrorCode(err), err instanceof Error ? err.message : String(err)) };
    }
    const textBody = await res.text().catch(() => '');
    const type = res.headers.get('content-type');
    if (!res.ok) {
      // no such endpoint: the provider has no model list
      if ([404, 405, 501].includes(res.status) && !looksLikeHtml(type, textBody)) return { ok: false, result: fail('list.unsupported', `HTTP ${res.status}`, res.status) };
      const code = httpErrorCode(res.status, type, textBody);
      const detail = looksLikeHtml(type, textBody) ? `an HTML page${htmlTitle(textBody) ? ` "${htmlTitle(textBody)}"` : ''}` : textBody.slice(0, 200);
      return { ok: false, result: fail(code === 'gateway.not_found' ? 'list.unsupported' : code, `HTTP ${res.status}: ${detail}`, res.status) };
    }
    try {
      return { ok: true, body: JSON.parse(textBody) as unknown };
    } catch {
      return { ok: false, result: fail(looksLikeHtml(type, textBody) ? 'gateway.html' : 'list.bad_response', 'the answer is not JSON') };
    }
  };

  const found: ReturnType<typeof entry>[] = [];
  if (style === 'anthropic') {
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await getJson(joinUrl(base, `/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`));
      if (!r.ok) return r.result;
      const list = listOf(r.body);
      if (!list) return fail('list.bad_response', 'no model list in the answer');
      found.push(...list.map(entry));
      const b = r.body as { has_more?: boolean; last_id?: string };
      if (!b.has_more || !b.last_id) break;
      after = b.last_id;
    }
  } else if (style === 'lmstudio') {
    // its own API has the context window; the OpenAI-compatible list does not
    const origin = base.replace(/\/v1$/, '');
    let r = await getJson(`${origin}/api/v1/models`);
    if (!r.ok) r = await getJson(joinUrl(base, '/models'));
    if (!r.ok) return r.result;
    const list = listOf(r.body);
    if (!list) return fail('list.bad_response', 'no model list in the answer');
    found.push(...list.map(entry));
  } else {
    const r = await getJson(joinUrl(base, `/models${style === 'openai-chat' ? '?sub_type=chat' : ''}`));
    if (!r.ok) return r.result;
    const list = listOf(r.body);
    if (!list) return fail('list.bad_response', 'no model list in the answer');
    found.push(...list.map(entry));
    if (style === 'ollama') {
      // context windows from /api/show (a few at a time, best effort)
      const origin = base.replace(/\/v1$/, '');
      const items = found.filter((m): m is NonNullable<typeof m> => !!m && !m.contextWindow).slice(0, 50);
      for (let i = 0; i < items.length; i += 4) {
        await Promise.all(
          items.slice(i, i + 4).map(async (m) => {
            try {
              const res = await doFetch(`${origin}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.id }), signal });
              const info = ((await res.json()) as { model_info?: Record<string, unknown> }).model_info ?? {};
              const arch = String(info['general.architecture'] ?? '');
              const n = num(info[`${arch}.context_length`]);
              if (n) m.contextWindow = n;
            } catch {
              // keep it without
            }
          }),
        );
      }
    }
  }

  const short = new Map((provider?.models ?? []).map((m) => [m.id, m]));
  const seen = new Set<string>();
  const models: ListedModel[] = [];
  for (const m of found) {
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    const known = short.get(m.id);
    const contextWindow = m.contextWindow ?? known?.contextWindow;
    const maxOutput = m.maxOutput ?? known?.maxOutput;
    models.push({
      id: m.id,
      ...(m.label ? { label: m.label } : known?.label ? { label: known.label } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutput ? { maxOutput } : {}),
      inCatalog: !!known,
      chat: !NOT_CHAT.test(m.id),
    });
  }
  // the short list's models first, then the rest by name
  models.sort((a, b) => Number(b.inCatalog) - Number(a.inCatalog) || a.id.localeCompare(b.id));
  return { ok: true, models };
}
