// SQLite store on Node's built-in node:sqlite (no native module to compile,
// so it also runs inside Electron's main process).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { MailItem, Message, ProjectInfo, ProjectLogEntry, TraceRecord, WorkObject } from '../types.ts';
import type { PendingRecord, RelayRecord, SenderDecision, SessionRecord, Store, ToolCallRecord } from './types.ts';

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
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL, manager_session_id TEXT NOT NULL,
  workflow_id TEXT, stage TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_log (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
  summary TEXT NOT NULL, path TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS project_log_project ON project_log(project_id, at);
CREATE TABLE IF NOT EXISTS work_objects (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, level TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT,
  data TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_objects_project ON work_objects(project_id);
CREATE TABLE IF NOT EXISTS mail_items (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, status TEXT NOT NULL, project_id TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_items_status ON mail_items(status, created_at);
CREATE TABLE IF NOT EXISTS mail_senders (
  address TEXT PRIMARY KEY, project_id TEXT, updated_at TEXT NOT NULL, decision TEXT NOT NULL DEFAULT 'project'
);
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

  /**
   * `path` is a file path, or ':memory:'. `readOnly` opens an existing
   * database for reading only (e.g. exporting while the app runs): no schema
   * changes, every write throws.
   */
  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    if (opts.readOnly) {
      this.#db = new DatabaseSync(path, { readOnly: true });
      const v = this.#db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
      if (v && Number(v.value) > SCHEMA_VERSION) throw new Error(`database schema ${String(v.value)} is newer than this build (${SCHEMA_VERSION})`);
      return;
    }
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
    const logCols = (this.#db.prepare('PRAGMA table_info(project_log)').all() as Row[]).map((r) => String(r.name));
    if (!logCols.includes('detail')) this.#db.exec('ALTER TABLE project_log ADD COLUMN detail TEXT');
    const senderCols = (this.#db.prepare('PRAGMA table_info(mail_senders)').all() as Row[]).map((r) => String(r.name));
    if (!senderCols.includes('decision')) this.#db.exec("ALTER TABLE mail_senders ADD COLUMN decision TEXT NOT NULL DEFAULT 'project'");
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

  // projects -------------------------------------------------------------------
  upsertProject(p: ProjectInfo): void {
    this.#q(
      `INSERT INTO projects (id, name, folder, manager_session_id, workflow_id, stage, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, folder = excluded.folder, manager_session_id = excluded.manager_session_id,
         workflow_id = excluded.workflow_id, stage = excluded.stage, status = excluded.status, updated_at = excluded.updated_at`,
    ).run(p.id, p.name, p.folder, p.managerSessionId, p.workflowId, p.stage, p.status, p.createdAt, p.updatedAt);
  }
  getProject(id: string): ProjectInfo | undefined {
    const row = this.#q('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row && toProject(row);
  }
  listProjects(): ProjectInfo[] {
    return (this.#q('SELECT * FROM projects ORDER BY created_at, rowid').all() as Row[]).map(toProject);
  }
  appendProjectLog(e: ProjectLogEntry): void {
    // column `path` holds the entry's target
    this.#q('INSERT INTO project_log (id, project_id, session_id, at, kind, summary, path, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      e.id,
      e.projectId,
      e.sessionId,
      e.at,
      e.action,
      e.summary,
      e.target ?? null,
      e.detail ?? null,
    );
  }
  listProjectLog(projectId: string, limit = 50): ProjectLogEntry[] {
    return (this.#q('SELECT * FROM project_log WHERE project_id = ? ORDER BY rowid DESC LIMIT ?').all(projectId, limit) as Row[]).map(
      (r): ProjectLogEntry => ({
        id: String(r.id),
        projectId: String(r.project_id),
        sessionId: String(r.session_id),
        at: String(r.at),
        // the `kind` column holds the action; early entries used underscores
        action: String(r.kind).replace('file_write', 'file.write').replace('file_edit', 'file.edit') as ProjectLogEntry['action'],
        summary: String(r.summary),
        ...(r.path !== null ? { target: String(r.path) } : {}),
        ...(r.detail !== null && r.detail !== undefined ? { detail: String(r.detail) } : {}),
      }),
    );
  }
  upsertWorkObject(o: WorkObject): void {
    this.#q(
      `INSERT INTO work_objects (id, project_id, level, name, parent_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET level = excluded.level, name = excluded.name, parent_id = excluded.parent_id, data = excluded.data`,
    ).run(o.id, o.projectId, o.level, o.name, o.parentId, o.data ? json(o.data) : null, o.createdAt);
  }
  listWorkObjects(projectId: string): WorkObject[] {
    return (this.#q('SELECT * FROM work_objects WHERE project_id = ? ORDER BY rowid').all(projectId) as Row[]).map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      level: String(r.level),
      name: String(r.name),
      parentId: r.parent_id === null ? null : String(r.parent_id),
      ...(r.data !== null ? { data: parse<Record<string, unknown>>(r.data) } : {}),
      createdAt: String(r.created_at),
    }));
  }

  // mail ------------------------------------------------------------------------
  upsertMail(m: MailItem): void {
    this.#q(
      `INSERT INTO mail_items (id, source_id, status, project_id, created_at, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, project_id = excluded.project_id, data = excluded.data`,
    ).run(m.id, m.sourceId, m.status, m.triage?.projectId ?? null, m.createdAt, json(m));
  }
  getMail(id: string): MailItem | undefined {
    const row = this.#q('SELECT data FROM mail_items WHERE id = ?').get(id) as Row | undefined;
    return row && parse<MailItem>(row.data);
  }
  listMail(filter: { status?: MailItem['status']; projectId?: string; limit?: number } = {}): MailItem[] {
    const rows = this.#q(
      `SELECT data FROM mail_items WHERE (? IS NULL OR status = ?) AND (? IS NULL OR project_id = ?) ORDER BY created_at, rowid LIMIT ?`,
    ).all(filter.status ?? null, filter.status ?? null, filter.projectId ?? null, filter.projectId ?? null, filter.limit ?? 1000) as Row[];
    return rows.map((r) => parse<MailItem>(r.data));
  }
  setSenderDecision(address: string, d: SenderDecision): void {
    this.#q(
      `INSERT INTO mail_senders (address, project_id, decision, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET project_id = excluded.project_id, decision = excluded.decision, updated_at = excluded.updated_at`,
    ).run(address.toLowerCase(), d.decision === 'project' ? d.projectId : null, d.decision, new Date().toISOString());
  }
  deleteProject(id: string): void {
    this.#db.exec('BEGIN');
    try {
      this.#q('DELETE FROM projects WHERE id = ?').run(id);
      this.#q('DELETE FROM project_log WHERE project_id = ?').run(id);
      this.#q('DELETE FROM work_objects WHERE project_id = ?').run(id);
      this.#q("DELETE FROM mail_senders WHERE decision = 'project' AND project_id = ?").run(id);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }
  deleteSession(id: string): void {
    this.#db.exec('BEGIN');
    try {
      this.#q('DELETE FROM sessions WHERE id = ?').run(id);
      this.#q('DELETE FROM messages WHERE session_id = ?').run(id);
      this.#q('DELETE FROM tool_calls WHERE session_id = ?').run(id);
      this.#q('DELETE FROM queued WHERE session_id = ?').run(id);
      this.#q('DELETE FROM pending WHERE session_id = ?').run(id);
      this.#q('DELETE FROM relays WHERE parent_id = ? OR child_id = ?').run(id, id);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }
  getSenderDecision(address: string): SenderDecision | undefined {
    const row = this.#q('SELECT project_id, decision FROM mail_senders WHERE address = ?').get(address.toLowerCase()) as Row | undefined;
    if (!row) return undefined;
    return row.decision === 'ignore' ? { decision: 'ignore' } : { decision: 'project', projectId: String(row.project_id) };
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

function toProject(r: Row): ProjectInfo {
  return {
    id: String(r.id),
    name: String(r.name),
    folder: String(r.folder),
    managerSessionId: String(r.manager_session_id),
    workflowId: r.workflow_id === null ? null : String(r.workflow_id),
    stage: r.stage === null ? null : String(r.stage),
    status: String(r.status) as ProjectInfo['status'],
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
