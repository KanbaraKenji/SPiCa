// The model catalog: which providers the settings form offers, their API
// address and kind, and a short list of models with context windows and
// prices. One source for the form, the price table (cost.ts) and the known
// context windows. Ships with the version (builtin.ts); a newer one can come
// from the update source (configure({ catalog })); a company adds its own
// connections (the packaging's deploy.json) as presets.
import type { ModelPrice, PriceTable } from '../cost.ts';

export type CatalogKind = 'openai-compatible' | 'anthropic' | 'wso2';

/**
 * How to ask the provider for its models (listProviderModels):
 * openai = GET {base}/models; openai-chat = the same with ?sub_type=chat;
 * anthropic = GET {base}/models, paged; ollama / lmstudio = their local APIs;
 * none = not documented: tried like openai once, else "not supported".
 */
export type ListStyle = 'openai' | 'openai-chat' | 'anthropic' | 'ollama' | 'lmstudio' | 'none';

export interface CatalogPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  currency: 'USD' | 'CNY';
  longContext?: { above: number; input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

export interface CatalogModel {
  /** As the API takes it. */
  id: string;
  label?: string;
  contextWindow: number;
  maxOutput?: number;
  /** What the form preselects: default, the one for heavy work, the cheap one. */
  role?: 'default' | 'strong' | 'cheap';
  /** Official list price; absent when none was found (the budget then counts a high fallback, which is not this model's price). */
  price?: CatalogPrice;
  /** Where the facts come from (official page) and when they were checked (YYYY-MM-DD). Presets of a company need neither. */
  source?: string;
  checked?: string;
  /** Takes images (true) or text only (false), per the official page `visionSource`; absent: not known (images are sent, a refusal is told apart). */
  vision?: boolean;
  visionSource?: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  /** company = a preset from the packaging's deploy.json. */
  group: 'company' | 'cn' | 'intl' | 'local';
  kind: CatalogKind;
  baseUrl: string;
  /** wso2 only. */
  tokenUrl?: string;
  scope?: string;
  docsUrl?: string;
  listModels: ListStyle;
  needsKey: boolean;
  models: CatalogModel[];
  source?: string;
  checked?: string;
  /** Presets: the one the form preselects; limits for the connection. */
  default?: boolean;
  maxConcurrent?: number;
  requestsPerMinute?: number;
}

export interface ModelCatalog {
  schema: 'spica.model-catalog';
  /** YYYY-MM-DD (later ones replace earlier ones). */
  version: string;
  /** Budgets only: CNY prices count at this rate. */
  fx: { usdPerCny: number; source: string; checked: string };
  providers: CatalogProvider[];
}

/** A company's model connection from deploy.json (no keys ever). */
export interface CatalogPreset {
  id: string;
  name: string;
  kind: CatalogKind;
  baseUrl: string;
  tokenUrl?: string;
  scope?: string;
  models: { id: string; label?: string; contextWindow: number; maxOutput?: number; role?: 'default' | 'strong' | 'cheap' }[];
  default?: boolean;
  maxConcurrent?: number;
  requestsPerMinute?: number;
}

const KINDS: CatalogKind[] = ['openai-compatible', 'anthropic', 'wso2'];
const STYLES: ListStyle[] = ['openai', 'openai-chat', 'anthropic', 'ollama', 'lmstudio', 'none'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^https?:\/\/[^\s/]+/i;
const posInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

/**
 * Check a catalog (the built-in one in tests, an update before it is used).
 * Every provider and model needs an official `source` and a `checked` date.
 * Returns the problems in plain English; empty = good.
 */
export function catalogProblems(raw: unknown): string[] {
  const out: string[] = [];
  const c = raw as Partial<ModelCatalog> | null;
  if (!c || typeof c !== 'object') return ['not an object'];
  if (c.schema !== 'spica.model-catalog') out.push('schema must be "spica.model-catalog"');
  if (!text(c.version) || !DAY.test(String(c.version))) out.push('version must be a date (YYYY-MM-DD)');
  if (!c.fx || !(typeof c.fx.usdPerCny === 'number' && c.fx.usdPerCny > 0) || !text(c.fx.source) || !DAY.test(String(c.fx.checked ?? ''))) {
    out.push('fx needs usdPerCny, source and checked');
  }
  if (!Array.isArray(c.providers)) return [...out, 'providers must be a list'];
  const ids = new Set<string>();
  for (const [i, p] of c.providers.entries()) {
    const at = `providers[${i}]${p && text(p.id) ? ` (${p.id})` : ''}`;
    if (!p || typeof p !== 'object') {
      out.push(`${at}: not an object`);
      continue;
    }
    if (!text(p.id)) out.push(`${at}: id missing`);
    else if (ids.has(p.id)) out.push(`${at}: id used twice`);
    else ids.add(p.id);
    if (!text(p.name)) out.push(`${at}: name missing`);
    if (!['cn', 'intl', 'local'].includes(p.group)) out.push(`${at}: group must be cn, intl or local`);
    if (!KINDS.includes(p.kind)) out.push(`${at}: kind must be one of ${KINDS.join(', ')}`);
    if (!URL_RE.test(String(p.baseUrl ?? ''))) out.push(`${at}: baseUrl must be an http(s) address`);
    if (!STYLES.includes(p.listModels)) out.push(`${at}: listModels must be one of ${STYLES.join(', ')}`);
    if (typeof p.needsKey !== 'boolean') out.push(`${at}: needsKey must be true or false`);
    if (!URL_RE.test(String(p.source ?? ''))) out.push(`${at}: source (an official page) missing`);
    if (!DAY.test(String(p.checked ?? ''))) out.push(`${at}: checked (YYYY-MM-DD) missing`);
    if (!Array.isArray(p.models)) {
      out.push(`${at}: models must be a list`);
      continue;
    }
    for (const [j, m] of p.models.entries()) {
      const mt = `${at}.models[${j}]${m && text(m.id) ? ` (${m.id})` : ''}`;
      if (!m || !text(m.id)) out.push(`${mt}: id missing`);
      if (!m || !posInt(m.contextWindow)) out.push(`${mt}: contextWindow must be a positive whole number`);
      if (m?.maxOutput !== undefined && !posInt(m.maxOutput)) out.push(`${mt}: maxOutput must be a positive whole number`);
      if (!m || !URL_RE.test(String(m.source ?? ''))) out.push(`${mt}: source (an official page) missing`);
      if (!m || !DAY.test(String(m.checked ?? ''))) out.push(`${mt}: checked (YYYY-MM-DD) missing`);
      if (m?.vision !== undefined && !URL_RE.test(String(m.visionSource ?? ''))) out.push(`${mt}: visionSource (an official page) missing`);
      if (m?.price && !(m.price.input >= 0 && m.price.output >= 0 && (m.price.currency === 'USD' || m.price.currency === 'CNY'))) {
        out.push(`${mt}: price needs input, output and currency USD or CNY`);
      }
    }
  }
  return out;
}

/** Check a company's presets (deploy.json); problems in plain English. */
export function presetProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return ['models must be a list of model connections'];
  const out: string[] = [];
  const ids = new Set<string>();
  for (const [i, p] of (raw as Partial<CatalogPreset>[]).entries()) {
    const at = `models[${i}]${p && text(p.id) ? ` (${p.id})` : ''}`;
    if (!p || typeof p !== 'object') {
      out.push(`${at}: not an object`);
      continue;
    }
    if (!text(p.id)) out.push(`${at}: id missing`);
    else if (ids.has(p.id!)) out.push(`${at}: id used twice`);
    else ids.add(p.id!);
    if (!text(p.name)) out.push(`${at}: name missing`);
    if (!KINDS.includes(p.kind as CatalogKind)) out.push(`${at}: kind must be one of ${KINDS.join(', ')}`);
    if (!URL_RE.test(String(p.baseUrl ?? ''))) out.push(`${at}: baseUrl must be an http(s) address`);
    if (p.kind === 'wso2' && !URL_RE.test(String(p.tokenUrl ?? ''))) out.push(`${at}: tokenUrl (an http(s) address) is needed for wso2`);
    for (const k of ['apiKey', 'secret', 'consumerSecret', 'clientSecret', 'consumerKey', 'clientId'] as const) {
      if (k in p) out.push(`${at}: ${k} must not be in the packaging (each person types their own)`);
    }
    if (!Array.isArray(p.models) || p.models.length === 0) {
      out.push(`${at}: models needs at least one model`);
      continue;
    }
    for (const [j, m] of p.models.entries()) {
      const mt = `${at}.models[${j}]${m && text(m.id) ? ` (${m.id})` : ''}`;
      if (!m || !text(m.id)) out.push(`${mt}: id missing`);
      if (!m || !posInt(m.contextWindow)) out.push(`${mt}: contextWindow must be a positive whole number`);
    }
    for (const k of ['maxConcurrent', 'requestsPerMinute'] as const) if (p[k] !== undefined && !posInt(p[k])) out.push(`${at}: ${k} must be a positive whole number`);
  }
  return out;
}

/**
 * The catalog the form and the price table use: a valid update if it is newer
 * than the built-in one, with the company's presets first (group company).
 */
export function effectiveCatalog(builtin: ModelCatalog, update?: ModelCatalog, presets: CatalogPreset[] = []): ModelCatalog {
  const base = update && update.version > builtin.version ? update : builtin;
  const company: CatalogProvider[] = presets.map((p) => ({
    id: p.id,
    name: p.name,
    group: 'company',
    kind: p.kind,
    baseUrl: p.baseUrl,
    ...(p.tokenUrl ? { tokenUrl: p.tokenUrl } : {}),
    ...(p.scope ? { scope: p.scope } : {}),
    listModels: 'none',
    needsKey: true,
    models: p.models.map((m) => ({ ...m })),
    ...(p.default ? { default: true } : {}),
    ...(p.maxConcurrent ? { maxConcurrent: p.maxConcurrent } : {}),
    ...(p.requestsPerMinute ? { requestsPerMinute: p.requestsPerMinute } : {}),
  }));
  const taken = new Set(company.map((p) => p.id));
  return { ...base, providers: [...company, ...base.providers.filter((p) => !taken.has(p.id))] };
}

/** A catalog price in USD per million tokens (CNY converted at the catalog's rate). */
function usd(p: CatalogPrice, fx: number): ModelPrice {
  const k = p.currency === 'CNY' ? fx : 1;
  const r = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * k * 1e6) / 1e6);
  return {
    input: r(p.input)!,
    output: r(p.output)!,
    ...(p.cacheRead !== undefined ? { cacheRead: r(p.cacheRead)! } : {}),
    ...(p.cacheWrite !== undefined ? { cacheWrite: r(p.cacheWrite)! } : {}),
    ...(p.longContext
      ? {
          longContext: {
            above: p.longContext.above,
            input: r(p.longContext.input)!,
            output: r(p.longContext.output)!,
            ...(p.longContext.cacheRead !== undefined ? { cacheRead: r(p.longContext.cacheRead)! } : {}),
            ...(p.longContext.cacheWrite !== undefined ? { cacheWrite: r(p.longContext.cacheWrite)! } : {}),
          },
        }
      : {}),
  };
}

/** Deliberately high prices for models without a catalog price (never shown as a model's price). */
export const FALLBACK_ROWS: PriceTable = {
  anthropic: { '*': { input: 10, output: 50, unverified: true, unpriced: true } }, // unknown Claude model: assume the top tier
  'openai-compatible': { '*': { input: 5, output: 20, unverified: true, unpriced: true } },
};

/**
 * The price table from the catalog: per catalog provider id, and per kind (so a
 * connection typed in by hand still finds a known model by its name; the first
 * provider listing a model wins). Context windows ride along. Models without a
 * price get only their context window over the kind's high fallback.
 */
export function pricesFromCatalog(c: ModelCatalog): PriceTable {
  const table: PriceTable = { anthropic: { ...FALLBACK_ROWS.anthropic }, 'openai-compatible': { ...FALLBACK_ROWS['openai-compatible'] } };
  for (const p of c.providers) {
    const rows: Record<string, ModelPrice> = (table[p.id] ??= {});
    const kindRows: Record<string, ModelPrice> = (table[p.kind] ??= {});
    for (const m of p.models) {
      const fallback = (kindRows['*'] ?? { input: 10, output: 50, unverified: true, unpriced: true }) as ModelPrice;
      const row: ModelPrice = m.price ? { ...usd(m.price, c.fx.usdPerCny), contextWindow: m.contextWindow } : { ...fallback, contextWindow: m.contextWindow };
      rows[m.id] = row;
      if (!kindRows[m.id]) kindRows[m.id] = row;
    }
  }
  return table;
}

/** A catalog provider (or preset) by id. */
export function catalogProvider(c: ModelCatalog, id: string | undefined): CatalogProvider | undefined {
  return id ? c.providers.find((p) => p.id === id) : undefined;
}

/** Entries checked longer ago than `days` (to re-check before a release). */
export function staleEntries(c: ModelCatalog, days: number, today = new Date()): { provider: string; model?: string; checked: string; source: string }[] {
  const limit = today.getTime() - days * 86_400_000;
  const old = (d: string | undefined) => !d || Date.parse(`${d}T00:00:00Z`) < limit;
  const out: { provider: string; model?: string; checked: string; source: string }[] = [];
  for (const p of c.providers) {
    if (p.group === 'company') continue;
    if (old(p.checked)) out.push({ provider: p.id, checked: p.checked ?? '', source: p.source ?? '' });
    for (const m of p.models) if (old(m.checked)) out.push({ provider: p.id, model: m.id, checked: m.checked ?? '', source: m.source ?? '' });
  }
  if (old(c.fx.checked)) out.push({ provider: 'fx', checked: c.fx.checked, source: c.fx.source });
  return out;
}
