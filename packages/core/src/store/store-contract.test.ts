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
