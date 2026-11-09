// SQLite store on Node's built-in node:sqlite (no native module to compile,
// so it also runs inside Electron's main process).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Message, TraceRecord } from '../types.ts';
import type { PendingRecord, RelayRecord, SessionRecord, Store, ToolCallRecord } from './types.ts';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, parent_id TEXT, role TEXT NOT NULL, title TEXT, status TEXT NOT NULL,
  config TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL,
  content TEXT NOT NULL, meta TEXT, provider_extras TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
CREATE TABLE IF NOT EXISTS tool_calls (
  session_id TEXT NOT NULL, message_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, input TEXT,
  status TEXT NOT NULL, result TEXT, started_at TEXT NOT NULL, ended_at TEXT, cards TEXT,
  PRIMARY KEY (session_id, message_id, id)
);
CREATE TABLE IF NOT EXISTS queued (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, pos INTEGER NOT NULL, message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS queued_session ON queued(session_id, pos);
CREATE TABLE IF NOT EXISTS pending (
  session_id TEXT NOT NULL, call_id TEXT NOT NULL, message_id TEXT NOT NULL, item TEXT NOT NULL,
  PRIMARY KEY (session_id, call_id)
);
CREATE TABLE IF NOT EXISTS relays (
  id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, child_id TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS relays_parent ON relays(parent_id, created_at);
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, session_id TEXT, started_at TEXT NOT NULL, kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_session ON traces(session_id, seq);
`;

type Row = Record<string, unknown>;

const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(v: unknown): T => JSON.parse(String(v)) as T;
const opt = <T>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : parse<T>(v));

export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  readonly #stmt = new Map<string, StatementSync>();
  #traceSeq = 0;
  #queueSeq = 0;

  /** `path` is a file path, or ':memory:'. */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;');
    this.#db.exec(SCHEMA);
    this.#migrate();
    const v = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as Row | undefined;
    if (!v) this.#db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    else if (Number(v.value) > SCHEMA_VERSION) throw new Error(`database schema ${String(v.value)} is newer than this build (${SCHEMA_VERSION})`);
    this.#traceSeq = Number((this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM traces').get() as Row).m);
    this.#queueSeq = Number((this.#db.prepare('SELECT COALESCE(MAX(pos), 0) AS m FROM queued').get() as Row).m);
  }

  /** Additive migrations for databases created by earlier builds. */
  #migrate(): void {
    const cols = (this.#db.prepare('PRAGMA table_info(tool_calls)').all() as Row[]).map((r) => String(r.name));
    if (!cols.includes('cards')) this.#db.exec('ALTER TABLE tool_calls ADD COLUMN cards TEXT');
  }

  #q(sql: string): StatementSync {
    let s = this.#stmt.get(sql);
    if (!s) {
      s = this.#db.prepare(sql);
      this.#stmt.set(sql, s);
    }
    return s;
  }

  // sessions -------------------------------------------------------------------
  upsertSession(r: SessionRecord): void {
    this.#q(
      `INSERT INTO sessions (id, parent_id, role, title, status, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, role = excluded.role, title = excluded.title,
         status = excluded.status, config = excluded.config, updated_at = excluded.updated_at`,
    ).run(r.id, r.parentId, r.role, r.title, r.status, json(r.config), r.createdAt, r.updatedAt);
  }
  getSession(id: string): SessionRecord | undefined {
    const row = this.#q('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return row && toSession(row);
  }
  listSessions(): SessionRecord[] {
    return (this.#q('SELECT * FROM sessions ORDER BY created_at, rowid').all() as Row[]).map(toSession);
  }

  // messages -------------------------------------------------------------------
  appendMessage(m: Message): void {
    this.#q(
      `INSERT INTO messages (id, session_id, seq, role, kind, content, meta, provider_extras, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.id, m.sessionId, m.seq, m.role, m.kind, json(m.content), m.meta ? json(m.meta) : null, m.providerExtras ? json(m.providerExtras) : null, m.createdAt);
  }
  updateMessage(m: Message): void {
    this.#q('UPDATE messages SET content = ?, meta = ?, provider_extras = ? WHERE id = ?').run(
      json(m.content),
      m.meta ? json(m.meta) : null,
      m.providerExtras ? json(m.providerExtras) : null,
      m.id,
    );
  }
  listMessages(sessionId: string): Message[] {
    return (this.#q('SELECT * FROM messages WHERE session_id = ? ORDER BY seq').all(sessionId) as Row[]).map(toMessage);
  }

  // tool calls -----------------------------------------------------------------
  upsertToolCall(r: ToolCallRecord): void {
    this.#q(
      `INSERT INTO tool_calls (session_id, message_id, id, name, input, status, result, started_at, ended_at, cards)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, message_id, id) DO UPDATE SET name = excluded.name, input = excluded.input,
         status = excluded.status, result = excluded.result, started_at = excluded.started_at, ended_at = excluded.ended_at,
         cards = excluded.cards`,
    ).run(r.sessionId, r.messageId, r.id, r.name, json(r.input ?? null), r.status, r.result ?? null, r.startedAt, r.endedAt ?? null, r.cards ? json(r.cards) : null);
  }
  listToolCalls(sessionId: string, messageId?: string): ToolCallRecord[] {
    const rows = messageId
      ? (this.#q('SELECT * FROM tool_calls WHERE session_id = ? AND message_id = ? ORDER BY rowid').all(sessionId, messageId) as Row[])
      : (this.#q('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY rowid').all(sessionId) as Row[]);
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      messageId: String(row.message_id),
      name: String(row.name),
      input: opt(row.input) ?? null,
      status: String(row.status) as ToolCallRecord['status'],
      ...(row.result !== null ? { result: String(row.result) } : {}),
      ...(row.cards !== null && row.cards !== undefined ? { cards: parse<NonNullable<ToolCallRecord['cards']>>(row.cards) } : {}),
      startedAt: String(row.started_at),
      ...(row.ended_at !== null ? { endedAt: String(row.ended_at) } : {}),
    }));
  }

  // queued messages ------------------------------------------------------------
  putQueued(m: Message): void {
    this.#q('INSERT OR REPLACE INTO queued (id, session_id, pos, message) VALUES (?, ?, ?, ?)').run(m.id, m.sessionId, ++this.#queueSeq, json(m));
  }
  deleteQueued(sessionId: string, messageId: string): void {
    this.#q('DELETE FROM queued WHERE session_id = ? AND id = ?').run(sessionId, messageId);
  }
  listQueued(sessionId: string): Message[] {
    return (this.#q('SELECT message FROM queued WHERE session_id = ? ORDER BY pos').all(sessionId) as Row[]).map((r) => parse<Message>(r.message));
  }

  // pending --------------------------------------------------------------------
  putPending(r: PendingRecord): void {
    this.#q('INSERT OR REPLACE INTO pending (session_id, call_id, message_id, item) VALUES (?, ?, ?, ?)').run(r.sessionId, r.callId, r.messageId, json(r.item));
  }
  deletePending(sessionId: string, callId: string): void {
    this.#q('DELETE FROM pending WHERE session_id = ? AND call_id = ?').run(sessionId, callId);
  }
  listPending(sessionId?: string): PendingRecord[] {
    const rows = sessionId
      ? (this.#q('SELECT * FROM pending WHERE session_id = ? ORDER BY rowid').all(sessionId) as Row[])
      : (this.#q('SELECT * FROM pending ORDER BY rowid').all() as Row[]);
    return rows.map((r) => ({ sessionId: String(r.session_id), callId: String(r.call_id), messageId: String(r.message_id), item: parse(r.item) }));
  }

  // relays ---------------------------------------------------------------------
  appendRelay(r: RelayRecord): void {
    this.#q('INSERT INTO relays (id, parent_id, child_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, r.parentId, r.childId, r.kind, r.text, r.createdAt);
  }
  listRelays(parentId: string): RelayRecord[] {
    return (this.#q('SELECT * FROM relays WHERE parent_id = ? ORDER BY rowid').all(parentId) as Row[]).map((r) => ({
      id: String(r.id),
      parentId: String(r.parent_id),
      childId: String(r.child_id),
      kind: String(r.kind) as RelayRecord['kind'],
      text: String(r.text),
      createdAt: String(r.created_at),
    }));
  }

  // traces ---------------------------------------------------------------------
  appendTrace(t: TraceRecord): void {
    this.#q('INSERT INTO traces (id, seq, session_id, started_at, kind, data) VALUES (?, ?, ?, ?, ?, ?)').run(t.id, ++this.#traceSeq, t.sessionId, t.startedAt, t.kind, json(t));
  }
  listTraces(filter?: { sessionId?: string }): TraceRecord[] {
    const rows = filter?.sessionId
      ? (this.#q('SELECT data FROM traces WHERE session_id = ? ORDER BY seq').all(filter.sessionId) as Row[])
      : (this.#q('SELECT data FROM traces ORDER BY seq').all() as Row[]);
    return rows.map((r) => parse<TraceRecord>(r.data));
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}

function toSession(r: Row): SessionRecord {
  return {
    id: String(r.id),
    parentId: r.parent_id === null ? null : String(r.parent_id),
    role: String(r.role) as SessionRecord['role'],
    title: r.title === null ? null : String(r.title),
    status: String(r.status) as SessionRecord['status'],
    config: parse(r.config),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toMessage(r: Row): Message {
  const meta = opt<Record<string, unknown>>(r.meta);
  const extras = opt<Record<string, unknown>>(r.provider_extras);
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    seq: Number(r.seq),
    role: String(r.role) as Message['role'],
    kind: String(r.kind) as Message['kind'],
    content: parse(r.content),
    createdAt: String(r.created_at),
    ...(meta ? { meta } : {}),
    ...(extras ? { providerExtras: extras } : {}),
  };
}
