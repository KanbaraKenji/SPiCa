// The model settings as the core's MCP tools see them (models.list / save /
// setDefault, called by the core on this process). Same store and checks as the
// settings page; only the kind is spelled the core's way.
import type { HostModel, HostModelDraft } from '@spica/core';
import { coreKind, type ProviderDraft, type ProviderKind, type ProviderView } from '../../shared/providers';

const SHELL_KIND: Record<HostModel['kind'], ProviderKind> = { 'openai-compatible': 'openai', anthropic: 'anthropic', wso2: 'wso2' };

export function toHostModel(p: ProviderView): HostModel {
  return {
    id: p.id,
    kind: coreKind(p.kind),
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    strongModel: p.strongModel,
    tokenUrl: p.tokenUrl,
    clientId: p.clientId,
    scope: p.scope,
    contextWindow: p.contextWindow ?? null,
    maxConcurrent: p.maxConcurrent,
    requestsPerMinute: p.requestsPerMinute,
    hasSecret: p.hasSecret,
    isDefault: p.isDefault,
    ...(p.readOnly ? { readOnly: true } : {}),
    ...(p.catalogId ? { catalogId: p.catalogId } : {}),
  };
}

/** A draft from the core in the settings page's shape; throws (in plain words) when it cannot be used. */
export function fromHostDraft(d: HostModelDraft, existing: readonly ProviderView[]): ProviderDraft {
  const kind = SHELL_KIND[d.kind];
  if (!kind) throw Object.assign(new Error(`不认识的模型类型「${String(d.kind)}」。`), { code: 'invalid_kind' });
  if (d.id) {
    const cur = existing.find((p) => p.id === d.id);
    if (!cur) throw Object.assign(new Error('找不到这个模型配置。'), { code: 'not_found' });
    if (cur.readOnly) throw Object.assign(new Error('这一项来自开发配置文件，在这里改不了。'), { code: 'read_only' });
  }
  return {
    ...(d.id ? { id: d.id } : {}),
    kind,
    name: d.name ?? '',
    baseUrl: d.baseUrl ?? '',
    model: d.model ?? '',
    strongModel: d.strongModel ?? '',
    tokenUrl: d.tokenUrl ?? '',
    clientId: d.clientId ?? '',
    scope: d.scope ?? '',
    contextWindow: d.contextWindow ?? null,
    maxConcurrent: d.maxConcurrent ?? null,
    requestsPerMinute: d.requestsPerMinute ?? null,
    catalogId: d.catalogId ?? null,
    ...(d.secret !== undefined ? { secret: d.secret } : {}),
  };
}
