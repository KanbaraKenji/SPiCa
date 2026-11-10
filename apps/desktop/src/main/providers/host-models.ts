// The model settings as the core's MCP tools see them (models.list / save /
// setDefault / setStrong, called by the core on this process). Same store and
// checks as the settings page; a connection is one provider, one key and the
// models ticked under it; only the kind is spelled the core's way.
import type { HostConnection, HostConnectionDraft, HostModelList } from '@spica/core';
import { coreKind, legacyModelFields, type ModelRef, type ProviderDraft, type ProviderKind, type ProviderView } from '../../shared/providers';

const SHELL_KIND: Record<HostConnection['kind'], ProviderKind> = { 'openai-compatible': 'openai', anthropic: 'anthropic', wso2: 'wso2' };

export function toHostConnection(p: ProviderView): HostConnection {
  return {
    id: p.id,
    kind: coreKind(p.kind),
    name: p.name,
    baseUrl: p.baseUrl,
    tokenUrl: p.tokenUrl,
    clientId: p.clientId,
    scope: p.scope,
    ...(p.catalogId ? { catalogId: p.catalogId } : {}),
    maxConcurrent: p.maxConcurrent,
    requestsPerMinute: p.requestsPerMinute,
    hasSecret: p.hasSecret,
    ...(p.readOnly ? { readOnly: true } : {}),
    // A model saved before 上下文上限 existed has none yet (0: the agent is told it is missing).
    models: p.models.map((m) => ({ id: m.id, contextWindow: m.contextWindow ?? 0, contextFrom: m.contextFrom })),
  };
}

export function toHostModelList(items: readonly ProviderView[], def: ModelRef | null, strong: ModelRef | null): HostModelList {
  return { connections: items.map(toHostConnection), default: def, strong };
}

/** A draft from the core in the settings page's shape; throws (in plain words) when it cannot be used. */
export function fromHostDraft(d: HostConnectionDraft, existing: readonly ProviderView[]): ProviderDraft {
  const kind = SHELL_KIND[d.kind];
  if (!kind) throw Object.assign(new Error(`不支持的模型类型「${String(d.kind)}」。`), { code: 'invalid_kind' });
  if (d.id) {
    const cur = existing.find((p) => p.id === d.id);
    if (!cur) throw Object.assign(new Error('找不到该模型配置。'), { code: 'not_found' });
    if (cur.readOnly) throw Object.assign(new Error('此项来自开发配置文件，无法修改。'), { code: 'read_only' });
  }
  const models = (d.models ?? []).map((m) => ({ id: String(m.id ?? '').trim(), contextWindow: typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : null, contextFrom: m.contextFrom ?? 'user' }));
  return {
    ...(d.id ? { id: d.id } : {}),
    kind,
    name: d.name ?? '',
    baseUrl: d.baseUrl ?? '',
    tokenUrl: d.tokenUrl ?? '',
    clientId: d.clientId ?? '',
    scope: d.scope ?? '',
    maxConcurrent: d.maxConcurrent ?? null,
    requestsPerMinute: d.requestsPerMinute ?? null,
    catalogId: d.catalogId ?? null,
    models,
    ...legacyModelFields(models),
    ...(d.secret !== undefined ? { secret: d.secret } : {}),
  };
}
