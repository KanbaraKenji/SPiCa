// Settings-page models in the shape the core's backend takes.
import type { ProviderConfig } from '@spica/core';
import type { ResolvedProvider } from '../../shared/providers';

/** A settings-page model as the core's backend expects it. */
export function toProviderConfig(p: ResolvedProvider): ProviderConfig {
  const limits = {
    ...(p.maxConcurrent ? { maxConcurrent: p.maxConcurrent } : {}),
    ...(p.requestsPerMinute ? { requestsPerMinute: p.requestsPerMinute } : {}),
  };
  const base = { id: p.id, ...(Object.keys(limits).length ? { limits } : {}) };
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
