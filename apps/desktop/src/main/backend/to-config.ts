// Settings-page models in the shape the core's backend takes.
import type { PriceTable, ProviderConfig } from '@spica/core';
import type { ResolvedProvider } from '../../shared/providers';

/** A settings-page model as the core's backend expects it. */
export function toProviderConfig(p: ResolvedProvider): ProviderConfig {
  const limits = {
    ...(p.maxConcurrent ? { maxConcurrent: p.maxConcurrent } : {}),
    ...(p.requestsPerMinute ? { requestsPerMinute: p.requestsPerMinute } : {}),
  };
  const base = {
    id: p.id,
    ...(Object.keys(limits).length ? { limits } : {}),
    // One model per entry here; the core falls back to what it knows for any other name.
    ...(p.contextWindow && p.model ? { contextWindows: { [p.model]: p.contextWindow } } : {}),
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
