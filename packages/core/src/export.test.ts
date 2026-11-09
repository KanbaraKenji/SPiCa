// Usage log export: JSON Lines with a header, filtered by project and time,
// with model keys, endpoint addresses and key-looking strings removed.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USAGE_LOG_SCHEMA, USAGE_LOG_VERSION } from './export.ts';
import { spicaMcpTools } from './mcp/server.ts';
import type { Runtime } from './runtime.ts';
import { SqliteStore } from './store/sqlite.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway, tempDir } from './testing/helpers.ts';
import type { MailItem } from './types.ts';

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
let rt: Runtime;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir, cleanup } = await tempDir());
  await writeFile(join(dir, 'notes.txt'), 'hello\n');
});
afterEach(async () => {
  await rt?.close();
  await gw.stop();
  await cleanup();
});

type Line = Record<string, unknown> & { type: string };
const parse = (jsonl: string) => jsonl.split('\n').map((l) => JSON.parse(l) as Line);
const mail = (id: string, projectId: string, subject: string): MailItem => ({
  id: `box:${id}`,
  sourceId: 'box',
  messageId: id,
  fromAddress: 'a@example.com',
  subject,
  preview: 'password: hunter2hunter2',
  status: 'routed',
  triage: { decision: 'project', projectId, reason: 'test', confidence: 1, by: 'model', at: '2026-11-09T10:00:00.000+08:00' },
  createdAt: '2026-11-09T10:00:00.000+08:00',
  updatedAt: '2026-11-09T10:00:00.000+08:00',
});

async function seed() {
  rt = makeRuntime(gw, { cwd: dir, store: new SqliteStore(join(dir, 'db', 'spica.db')) });
  const a = rt.createProject({ name: 'Alpha' });
  const b = rt.createProject({ name: 'Beta' });
  const pmA = rt.session(a.managerSessionId)!;
  const pmB = rt.session(b.managerSessionId)!;
  const secretText =
    `my key is sk-abcdefghijklmnop, header Bearer abcdefghijkl0123, {"api_key": "zzzzsecretzzzz"}, ` +
    `the gateway ${gw.baseUrl}/v1 and the provider key test-key-123456`;
  gw.enqueue(
    { text: 'Reading.', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'notes.txt' } }], usage: { input: 100, output: 5 } },
    { text: `Done. ${secretText}`, usage: { input: 120, output: 5 } },
  );
  await pmA.send(`Check notes. ${secretText}`).done;
  const worker = rt.createSession({ parentId: pmA.id, title: 'helper' });
  gw.enqueue({ text: 'helper done' });
  await worker.send('help').done;
  gw.enqueue({ text: 'beta answer' });
  await pmB.send('Beta work').done;
  rt.logProjectActivity(pmA, 'note', 'Asked the supplier', 'supplier', 'token=abcd1234abcd1234');
  rt.store.upsertMail(mail('m1', a.id, 'For alpha'));
  rt.store.upsertMail(mail('m2', b.id, 'For beta'));
  return { a, b, pmA, pmB, worker };
}

describe('usage log export', () => {
  it('writes a header and every kind of record, with secrets removed', async () => {
    const { a, pmA, worker } = await seed();
    const jsonl = rt.exportUsageLog();
    const lines = parse(jsonl);
    expect(lines[0]).toMatchObject({ type: 'header', schema: USAGE_LOG_SCHEMA, schemaVersion: USAGE_LOG_VERSION, filter: { projectId: null, from: null, to: null } });
    const types = new Set(lines.map((l) => l.type));
    for (const t of ['session', 'message', 'tool_call', 'trace', 'project', 'project_log', 'mail']) expect(types).toContain(t);
    const counts = lines[0]!.counts as Record<string, number>;
    expect(counts.message).toBe(lines.filter((l) => l.type === 'message').length);
    expect(lines.find((l) => l.type === 'session' && l.id === worker.id)).toMatchObject({ parentId: pmA.id, role: 'worker', projectId: a.id });
    expect(lines.find((l) => l.type === 'tool_call')).toMatchObject({ name: 'read_file', input: { path: 'notes.txt' }, startedAt: expect.any(String) });
    expect(lines.find((l) => l.type === 'trace')).toMatchObject({ kind: 'model', target: 'fake-openai' });
    expect(lines.find((l) => l.type === 'message' && l.sessionId === pmA.id)).toMatchObject({ author: 'user', kind: 'user' });

    // nothing that could open the model endpoint, nor anything that looks like a key
    for (const s of ['test-key-123456', gw.baseUrl, gw.baseUrl.replace('http://', ''), 'sk-abcdefghijklmnop', 'abcdefghijkl0123', 'zzzzsecretzzzz', 'hunter2hunter2', 'abcd1234abcd1234']) {
      expect(jsonl).not.toContain(s);
    }
    expect(jsonl).toContain('[redacted]');
    expect(jsonl).toContain('Check notes.'); // the rest of the text stays
  });

  it('filters by project (manager and everything under it) and by time range', async () => {
    const { a, b, pmA, pmB, worker } = await seed();
    const lines = parse(rt.exportUsageLog({ projectId: a.id }));
    const sessions = lines.filter((l) => l.type === 'session').map((l) => l.id);
    expect(sessions.sort()).toEqual([pmA.id, worker.id].sort());
    expect(lines.some((l) => l.sessionId === pmB.id)).toBe(false);
    expect(lines.filter((l) => l.type === 'project').map((l) => l.id)).toEqual([a.id]);
    expect(lines.filter((l) => l.type === 'mail').map((l) => l.subject)).toEqual(['For alpha']);
    expect(lines.some((l) => l.type === 'project_log' && l.projectId === b.id)).toBe(false);

    // time: a range after everything happened leaves only the header (the dates can use any offset)
    const later = new Date(Date.now() + 3_600_000).toISOString();
    expect(parse(rt.exportUsageLog({ from: later }))).toHaveLength(1);
    const lines2 = parse(rt.exportUsageLog({ to: '2026-11-09T02:30:00Z' })); // 10:30 +08:00: only the mail
    expect(lines2.filter((l) => l.type !== 'header').map((l) => l.type)).toEqual(['mail', 'mail']);
    expect(() => rt.exportUsageLog({ projectId: 'nope' })).toThrow(/unknown project/);
    expect(() => rt.exportUsageLog({ from: 'yesterday' })).toThrow(/ISO 8601/);
  });

  it('is on the MCP service and on a command that reads the database while the app runs', async () => {
    const { a } = await seed();
    const tool = spicaMcpTools(rt, []).find((t) => t.name === 'spica_export_usage_log')!;
    const viaMcp = parse((await tool.run({ project_id: a.id })) as string);
    expect(viaMcp[0]).toMatchObject({ type: 'header', filter: { projectId: a.id } });

    // the runtime still has the database open
    const script = fileURLToPath(new URL('../scripts/export-log.ts', import.meta.url));
    const out = execFileSync(process.execPath, [script, '--db', join(dir, 'db', 'spica.db'), '--project', a.id], {
      encoding: 'utf8',
      env: { ...process.env, SPICA_TEST_BASE_URL: `${gw.baseUrl}/v1`, SPICA_TEST_API_KEY: 'test-key-123456', SPICA_TEST_MODEL: 'fake-model' },
    });
    const viaCli = parse(out.trim());
    expect(viaCli.length).toBe(viaMcp.length);
    expect(out).not.toContain('test-key-123456');
    expect(out).not.toContain(gw.baseUrl.replace('http://', ''));
    expect(out).toContain('"model":"fake-model"'); // a model name is not a secret

    const ro = new SqliteStore(join(dir, 'db', 'spica.db'), { readOnly: true });
    try {
      expect(ro.listSessions().length).toBeGreaterThan(0);
      expect(() => ro.upsertMail(mail('m3', a.id, 'x'))).toThrow();
    } finally {
      ro.close();
    }
  });
});
