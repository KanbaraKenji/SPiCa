// Both stores keep the same things: whatever goes in comes back the same from
// the memory store and from SQLite (also after reopening the file). A field the
// SQLite store forgets to write shows up here.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message, ProjectInfo, ProjectLogEntry, WorkObject } from '../types.ts';
import { tempDir } from '../testing/helpers.ts';
import { MemoryStore } from './memory.ts';
import { SqliteStore } from './sqlite.ts';
import type { SessionRecord, Store, ToolCallRecord } from './types.ts';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

const session: SessionRecord = {
  id: 'ses_1',
  parentId: null,
  role: 'top',
  title: 'A title',
  status: 'idle',
  config: { system: 'S', providerId: 'p', model: 'm', maxTokens: 64, cwd: '/x', maxTurns: 5, locale: 'zh-CN', serverWebSearch: false, templateId: 'top', approvalMode: 'manual' },
  createdAt: '2026-01-01T00:00:00.000+08:00',
  updatedAt: '2026-01-01T00:00:01.000+08:00',
};
const project: ProjectInfo = {
  id: 'prj_1',
  name: 'P',
  folder: '/p',
  managerSessionId: 'ses_m',
  workflowId: 'wf',
  stage: 'one',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000+08:00',
  updatedAt: '2026-01-01T00:00:02.000+08:00',
  unread: 3,
};
const message: Message = {
  id: 'msg_1',
  sessionId: 'ses_1',
  seq: 1,
  role: 'user',
  kind: 'user',
  content: [{ type: 'text', text: 'hi' }, { type: 'image', path: '/m/a.png', mediaType: 'image/png', width: 2, height: 3, bytes: 40, name: 'a.png' }],
  createdAt: '2026-01-01T00:00:03.000+08:00',
  meta: { author: 'user', attachments: [{ path: 'a.png', name: 'a.png', block: 1, image: { path: '/m/a.png', mediaType: 'image/png', width: 2, height: 3, bytes: 40, resized: false } }] },
  providerExtras: { reasoning: 'r' },
};
const call: ToolCallRecord = {
  id: 'call_1',
  sessionId: 'ses_1',
  messageId: 'msg_2',
  name: 'read_file',
  input: { path: 'a.txt' },
  status: 'ok',
  result: 'text',
  cards: { file: { name: 'a.txt' } } as unknown as ToolCallRecord['cards'],
  startedAt: '2026-01-01T00:00:04.000+08:00',
  endedAt: '2026-01-01T00:00:05.000+08:00',
};
const logEntry: ProjectLogEntry = { id: 'plog_1', projectId: 'prj_1', sessionId: 'ses_m', at: '2026-01-01T00:00:06.000+08:00', action: 'manager.report', summary: 'S', target: 'T', detail: 'D' };
const work: WorkObject = { id: 'wo_1', projectId: 'prj_1', level: 'product', name: 'W', parentId: null, data: { k: 1 }, createdAt: '2026-01-01T00:00:07.000+08:00' };

function fill(s: Store): void {
  s.upsertSession(session);
  s.upsertProject(project);
  s.appendMessage(message);
  s.upsertToolCall(call);
  s.appendProjectLog(logEntry);
  s.upsertWorkObject(work);
  s.appendRelay({ id: 'rel_1', parentId: 'ses_1', childId: 'ses_m', kind: 'report', text: 'done', createdAt: '2026-01-01T00:00:08.000+08:00' });
}

function read(s: Store) {
  return {
    session: s.getSession('ses_1'),
    sessions: s.listSessions(),
    project: s.getProject('prj_1'),
    projects: s.listProjects(),
    messages: s.listMessages('ses_1'),
    calls: s.listToolCalls('ses_1'),
    log: s.listProjectLog('prj_1'),
    work: s.listWorkObjects('prj_1'),
    relays: s.listRelays('ses_1'),
  };
}

describe('both stores keep the same', () => {
  it('sessions, projects (with unread), messages, tool calls, project log, work objects and relays', () => {
    const mem = new MemoryStore();
    fill(mem);
    const path = join(dir, 'db', 'spica.db');
    mkdirSync(join(dir, 'db'), { recursive: true });
    const sql = new SqliteStore(path);
    fill(sql);
    expect(read(sql)).toEqual(read(mem));
    expect(read(mem).project).toEqual(project); // nothing lost on the way
    sql.close();
    const reopened = new SqliteStore(path);
    expect(read(reopened)).toEqual(read(mem)); // and after reopening the file
    // an update keeps the new values
    mem.upsertProject({ ...project, unread: 0, stage: 'two' });
    reopened.upsertProject({ ...project, unread: 0, stage: 'two' });
    expect(reopened.getProject('prj_1')).toEqual(mem.getProject('prj_1'));
    reopened.close();
  });

  it('a project without an unread count reads back as 0 from both', () => {
    const { unread: _u, ...bare } = project;
    void _u;
    const mem = new MemoryStore();
    mem.upsertProject(bare);
    const sql = new SqliteStore(join(dir, 'b.db'));
    sql.upsertProject(bare);
    expect([mem.getProject('prj_1')!.unread, sql.getProject('prj_1')!.unread]).toEqual([0, 0]);
    sql.close();
  });

  it('a database from an earlier build gets the unread column (0) on opening', () => {
    const path = join(dir, 'old.db');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL, manager_session_id TEXT NOT NULL,
      workflow_id TEXT, stage TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('prj_old', 'Old', '/o', 'ses_m', null, null, 'active', 't0', 't1');
    db.close();
    const store = new SqliteStore(path);
    expect(store.getProject('prj_old')).toMatchObject({ name: 'Old', unread: 0 });
    store.upsertProject({ ...store.getProject('prj_old')!, unread: 2 });
    expect(store.getProject('prj_old')!.unread).toBe(2);
    store.close();
  });
});

describe('replaced answers (regenerate)', () => {
  const msg = (n: number, kind: Message['kind'] = 'assistant'): Message => ({
    id: `msg_r${n}`,
    sessionId: 'ses_1',
    seq: n,
    role: kind === 'user' ? 'user' : 'assistant',
    kind,
    content: [{ type: 'text', text: `t${n}` }],
    createdAt: `2026-01-01T00:00:0${n}.000+08:00`,
  });
  const mark = { at: '2026-01-01T00:01:00.000+08:00', of: 'msg_r1', version: 1 };
  const both = (): [string, Store][] => [
    ['memory', new MemoryStore()],
    ['sqlite', new SqliteStore(join(dir, 'r.db'))],
  ];

  it('marks only the given messages of that session, all together, and both stores read the same back', () => {
    const results = both().map(([, s]) => {
      s.upsertSession(session);
      for (const m of [msg(1, 'user'), msg(2), msg(3, 'tool_results'), msg(4)]) s.appendMessage(m);
      s.supersedeMessages('ses_1', ['msg_r2', 'msg_r3', 'msg_unknown'], mark);
      s.supersedeMessages('ses_other', ['msg_r4'], mark); // another session's id: nothing happens
      const out = s.listMessages('ses_1');
      s.close();
      return out;
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[0]!.map((m) => m.superseded ?? null)).toEqual([null, mark, mark, null]);
  });

  it('the mark survives reopening, a later version gets its own number, and updateMessage keeps it', () => {
    const path = join(dir, 'r2.db');
    const s = new SqliteStore(path);
    s.upsertSession(session);
    for (const m of [msg(1, 'user'), msg(2), msg(3)]) s.appendMessage(m);
    s.supersedeMessages('ses_1', ['msg_r2'], mark);
    s.supersedeMessages('ses_1', ['msg_r3'], { ...mark, version: 2 });
    s.close();
    const again = new SqliteStore(path);
    const [, two, three] = again.listMessages('ses_1');
    expect(two!.superseded).toEqual(mark);
    expect(three!.superseded).toEqual({ ...mark, version: 2 });
    again.updateMessage({ ...two!, content: [{ type: 'text', text: 'changed' }] });
    expect(again.listMessages('ses_1')[1]).toMatchObject({ content: [{ type: 'text', text: 'changed' }], superseded: mark });
    again.close();
  });

  it('a database from an earlier build gets the column: its messages are all current, and can be marked', () => {
    const path = join(dir, 'old-messages.db');
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '1');");
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL,
      content TEXT NOT NULL, meta TEXT, provider_extras TEXT, created_at TEXT NOT NULL)`);
    const ins = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run('msg_o1', 'ses_1', 1, 'user', 'user', JSON.stringify([{ type: 'text', text: 'q' }]), null, null, 't1');
    ins.run('msg_o2', 'ses_1', 2, 'assistant', 'assistant', JSON.stringify([{ type: 'text', text: 'a' }]), null, null, 't2');
    db.close();
    // read-only (the export script on a database the app has not opened yet): no column, nothing replaced
    const ro = new SqliteStore(path, { readOnly: true });
    expect(ro.listMessages('ses_1').map((m) => m.superseded)).toEqual([undefined, undefined]);
    ro.close();
    const store = new SqliteStore(path);
    expect(store.listMessages('ses_1').map((m) => 'superseded' in m)).toEqual([false, false]);
    store.supersedeMessages('ses_1', ['msg_o2'], { ...mark, of: 'msg_o1' });
    expect(store.listMessages('ses_1')[1]!.superseded).toEqual({ ...mark, of: 'msg_o1' });
    store.close();
  });
});
