// Usage log export: everything that happened, as JSON Lines, filtered by
// project and time range. Raw material for evaluation and, later, for the
// members' memory. Field reference: docs/design/agent-core.md §10a.
import type { ContentBlock, Message, UsageLogFilter } from './types.ts';
import type { SessionRecord, Store } from './store/types.ts';
import { isoNow } from './events.ts';
import { redactDeep } from './util.ts';

export const USAGE_LOG_SCHEMA = 'spica.usage-log';
/** Bump when a field changes meaning or disappears; adding fields keeps the version. */
export const USAGE_LOG_VERSION = 1;

export type { UsageLogFilter };

/** Text longer than this (tool results, file contents) is cut, with the original length noted. */
const MAX_TEXT = 20_000;

export function exportUsageLog(store: Store, filter: UsageLogFilter = {}, opts: { secrets?: readonly string[]; now?: string } = {}): string {
  return usageLogLines(store, filter, opts).join('\n');
}

export function usageLogLines(store: Store, filter: UsageLogFilter = {}, opts: { secrets?: readonly string[]; now?: string } = {}): string[] {
  const secrets = [...new Set(opts.secrets ?? [])].filter((s) => s.length >= 6).sort((a, b) => b.length - a.length);
  const clean = (v: unknown): unknown => redactDeep(v, secrets);
  const from = filter.from ? Date.parse(filter.from) : -Infinity;
  const to = filter.to ? Date.parse(filter.to) : Infinity;
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error('from / to must be ISO 8601 dates');
  const inRange = (at: string | undefined) => {
    if (!at) return true;
    const t = Date.parse(at);
    return Number.isNaN(t) || (t >= from && t <= to);
  };

  const all = store.listSessions();
  let sessions: SessionRecord[] = all;
  const project = filter.projectId ? store.getProject(filter.projectId) : undefined;
  if (filter.projectId) {
    if (!project) throw new Error(`unknown project: ${filter.projectId}`);
    const ids = new Set(all.filter((s) => s.config.projectId === project.id || s.id === project.managerSessionId).map((s) => s.id));
    // everything under the project's sessions belongs to it too
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of all) {
        if (s.parentId && ids.has(s.parentId) && !ids.has(s.id)) {
          ids.add(s.id);
          grew = true;
        }
      }
    }
    sessions = all.filter((s) => ids.has(s.id));
  }
  sessions = sessions.filter((s) => Date.parse(s.createdAt) <= to && Date.parse(s.updatedAt) >= from);

  const out: Record<string, unknown>[] = [];
  for (const s of sessions) {
    out.push({
      type: 'session',
      id: s.id,
      parentId: s.parentId,
      role: s.role,
      title: s.title,
      status: s.status,
      templateId: s.config.templateId ?? null,
      projectId: s.config.projectId ?? null,
      providerId: s.config.providerId,
      model: s.config.model,
      locale: s.config.locale ?? null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
    for (const m of store.listMessages(s.id)) if (inRange(m.createdAt)) out.push(messageRecord(m));
    for (const c of store.listToolCalls(s.id)) {
      if (!inRange(c.startedAt)) continue;
      out.push({
        type: 'tool_call',
        sessionId: c.sessionId,
        messageId: c.messageId,
        id: c.id,
        name: c.name,
        input: c.input,
        status: c.status,
        result: c.result === undefined ? null : cut(c.result),
        startedAt: c.startedAt,
        endedAt: c.endedAt ?? null,
        durationMs: c.endedAt ? Math.max(0, Date.parse(c.endedAt) - Date.parse(c.startedAt)) : null,
      });
    }
    for (const t of store.listTraces({ sessionId: s.id })) if (inRange(t.startedAt)) out.push({ type: 'trace', ...t });
    for (const r of store.listRelays(s.id)) if (inRange(r.createdAt)) out.push({ type: 'relay', ...r });
  }
  if (!filter.projectId) {
    // requests that belong to no session (token requests, mail polling)
    for (const t of store.listTraces()) if (t.sessionId === null && inRange(t.startedAt)) out.push({ type: 'trace', ...t });
  }

  const projects = project ? [project] : store.listProjects();
  for (const p of projects) {
    if (inRange(p.createdAt) || inRange(p.updatedAt)) out.push({ type: 'project', ...p });
    for (const e of store.listProjectLog(p.id, 1_000_000).reverse()) if (inRange(e.at)) out.push({ type: 'project_log', ...e });
  }
  for (const m of store.listMail(project ? { projectId: project.id } : {})) {
    if (inRange(m.receivedAt ?? m.createdAt)) out.push({ type: 'mail', ...m });
  }

  const counts: Record<string, number> = {};
  for (const r of out) counts[String(r.type)] = (counts[String(r.type)] ?? 0) + 1;
  const header = {
    type: 'header',
    schema: USAGE_LOG_SCHEMA,
    schemaVersion: USAGE_LOG_VERSION,
    exportedAt: opts.now ?? isoNow(),
    filter: { projectId: filter.projectId ?? null, from: filter.from ?? null, to: filter.to ?? null },
    counts,
  };
  // redact field values before serializing: a pattern like "api_key": "…" would not match once escaped inside a JSON string
  return [header, ...out].map((r) => JSON.stringify(clean(r)));
}

function messageRecord(m: Message): Record<string, unknown> {
  const meta = m.meta ?? {};
  return {
    type: 'message',
    id: m.id,
    sessionId: m.sessionId,
    seq: m.seq,
    role: m.role,
    kind: m.kind,
    author: meta.author ?? (m.role === 'user' ? 'user' : 'agent'),
    createdAt: m.createdAt,
    text: m.content.map((b) => (b.type === 'text' ? b.text : '')).join('') || null,
    content: m.content.flatMap(block),
    meta: Object.keys(meta).length ? meta : null,
  };
}

/** Content blocks without provider internals (signatures, opaque blocks). */
function block(b: ContentBlock): Record<string, unknown>[] {
  switch (b.type) {
    case 'text':
      return [{ type: 'text', text: cut(b.text) }];
    case 'thinking':
      return [{ type: 'thinking', text: cut(b.text) }];
    case 'tool_use':
      return [{ type: 'tool_use', id: b.id, name: b.name, input: b.input }];
    case 'tool_result':
      return [{ type: 'tool_result', toolUseId: b.toolUseId, isError: !!b.isError, content: cut(b.content) }];
    default:
      return [];
  }
}

function cut(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}\n…[cut: ${text.length} chars in total]`;
}
