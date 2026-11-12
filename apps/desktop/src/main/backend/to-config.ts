// Settings-page models in the shape the core's backend takes.
import type { PriceTable, ProviderConfig } from '@spica/core';
import type { ConnectionModel, ProviderFields } from '../../shared/providers';

/** A connection (or the form being tested) with its key: the connection's models when it has them. */
export type ConfigSource = ProviderFields & { id: string; secret: string; models?: readonly ConnectionModel[] };

/** Model name -> context window, for every ticked model that has one. */
function windowsOf(p: ConfigSource): Record<string, number> {
  const list = p.models ?? (p.model ? [{ id: p.model, contextWindow: p.contextWindow }] : []);
  return Object.fromEntries(list.filter((m) => m.contextWindow).map((m) => [m.id, m.contextWindow as number]));
}

/** Model name -> most output tokens, for ticked models whose provider listed it (the core knows the catalog's). */
function outputsOf(p: ConfigSource): Record<string, number> {
  return Object.fromEntries((p.models ?? []).filter((m) => m.maxOutput).map((m) => [m.id, m.maxOutput as number]));
}

/** Model name -> 花费上限 for one run, for models in use that have one. */
function runLimitsOf(p: ConfigSource): Record<string, number> {
  return Object.fromEntries((p.models ?? []).filter((m) => m.enabled !== false && m.runLimitUsd !== undefined && Number.isFinite(m.runLimitUsd)).map((m) => [m.id, m.runLimitUsd as number]));
}

/** A settings-page connection as the core's backend expects it. */
export function toProviderConfig(p: ConfigSource): ProviderConfig {
  const windows = windowsOf(p);
  const outputs = outputsOf(p);
  const runLimits = runLimitsOf(p);
  const limits = {
    ...(p.maxConcurrent ? { maxConcurrent: p.maxConcurrent } : {}),
    ...(p.requestsPerMinute ? { requestsPerMinute: p.requestsPerMinute } : {}),
  };
  const base = {
    id: p.id,
    ...(Object.keys(limits).length ? { limits } : {}),
    // Every ticked model's window; the core falls back to what it knows for any other name.
    ...(Object.keys(windows).length ? { contextWindows: windows } : {}),
    ...(Object.keys(outputs).length ? { maxOutputs: outputs } : {}),
    ...(Object.keys(runLimits).length ? { runLimits } : {}),
    ...(p.catalogId ? { catalogId: p.catalogId } : {}),
  };
  switch (p.kind) {
    case 'openai':
      return { ...base, kind: 'openai-compatible', baseUrl: p.baseUrl, apiKey: p.secret };
    case 'anthropic':
      return { ...base, kind: 'anthropic', apiKey: p.secret, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}) };
    case 'wso2':
      return {
        ...base,
        kind: 'wso2',
        baseUrl: p.baseUrl,
        oauth: { tokenUrl: p.tokenUrl, clientId: p.clientId, clientSecret: p.secret, ...(p.scope ? { scope: p.scope } : {}) },
      };
  }
}

/**
 * A model name matched the way the core matches it (for the demo backend): the
 * catalog id's table, the kind's, then any; exact, then ignoring case, then
 * without a vendor/ prefix. The real core answers this itself.
 */
export function matchWindowIn(prices: PriceTable, kind: string, model: string, catalogId?: string): { contextWindow: number; matched: string; how: 'exact' | 'name' } | null {
  const tables = [catalogId ? prices[catalogId] : undefined, prices[kind], ...Object.values(prices)];
  for (const t of tables) {
    const w = t?.[model]?.contextWindow;
    if (w) return { contextWindow: w, matched: model, how: 'exact' };
  }
  const norm = (s: string) => s.toLowerCase().trim();
  const bare = (s: string) => norm(s).replace(/^.*\//, '');
  for (const same of [(a: string, b: string) => norm(a) === norm(b), (a: string, b: string) => bare(a) === bare(b)]) {
    for (const t of tables) {
      for (const [id, row] of Object.entries(t ?? {})) if (id !== '*' && row.contextWindow && same(id, model)) return { contextWindow: row.contextWindow, matched: id, how: 'name' };
    }
  }
  return null;
}

/**
 * The context window a price table knows for a model, the way the core looks it
 * up: the kind's exact entry, then an exact entry under any kind; never a `*` row.
 * For the demo backend; the real core answers this itself.
 */
export function knownContextWindow(prices: PriceTable, kind: string, model: string): number | null {
  const own = prices[kind]?.[model]?.contextWindow;
  if (own) return own;
  for (const table of Object.values(prices)) {
    const w = table[model]?.contextWindow;
    if (w) return w;
  }
  return null;
}
