// Every tool in mock mode, through the real MCP server process.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './mcp-client.mjs';

const MOCK_LINE = '[sample data — mock mode]';
let s;
let dir;

beforeAll(async () => {
  s = startServer({ SPICA_MOCK: '1' });
  await s.init();
  dir = await mkdtemp(join(tmpdir(), 'spica-outlook-'));
}, 30_000);

afterAll(async () => {
  s?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('mock mode', () => {
  it('lists the eight tools with read-only hints on the readers', async () => {
    const tools = await s.tools();
    expect(tools.map((t) => t.name)).toEqual(['status', 'list_folders', 'list_messages', 'read_message', 'mark_read', 'move_messages', 'save_attachments', 'create_draft']);
    const ro = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(ro).toEqual(['status', 'list_folders', 'list_messages', 'read_message']);
    expect(tools.some((t) => t.annotations?.destructiveHint)).toBe(false);
  });

  it('status says mock', async () => {
    const r = await s.call('status');
    expect(r.isError).toBe(false);
    expect(r.text.startsWith(MOCK_LINE)).toBe(true);
    expect(r.json.mode).toBe('mock');
  });

  it('has 30 sample messages across the folders', async () => {
    const r = await s.call('list_folders');
    const total = r.json.folders.reduce((n, f) => n + f.total, 0);
    expect(total).toBe(30);
    expect(r.json.folders.find((f) => f.alias === 'inbox')).toMatchObject({ path: 'Inbox' });
    let seen = 0;
    for (const f of r.json.folders) {
      const page = await s.call('list_messages', { folder: f.path, limit: 50 });
      expect(page.json.messages.length).toBe(f.total);
      seen += page.json.messages.length;
    }
    expect(seen).toBe(30);
  });

  it('lists newest first, pages, and filters', async () => {
    const all = await s.call('list_messages', { limit: 50 });
    const times = all.json.messages.map((m) => m.received);
    expect([...times].sort().reverse()).toEqual(times);
    expect(all.json.messages[0]).toHaveProperty('preview');
    expect(all.json.messages[0]).not.toHaveProperty('body');

    const p1 = await s.call('list_messages', { limit: 5 });
    const p2 = await s.call('list_messages', { limit: 5, offset: p1.json.next_offset });
    expect(p1.json.next_offset).toBe(5);
    expect(p2.json.messages[0].id).toBe(all.json.messages[5].id);

    const unread = await s.call('list_messages', { unread_only: true, limit: 50 });
    expect(unread.json.messages.every((m) => m.unread)).toBe(true);
    expect(unread.json.total).toBeLessThan(all.json.total);

    const from = await s.call('list_messages', { from: 'brightprint', limit: 50 });
    expect(from.json.messages.map((m) => m.id).sort()).toEqual(['mock-002', 'mock-021']);

    const q = await s.call('list_messages', { query: '报价', limit: 50 });
    expect(q.json.messages.some((m) => m.id === 'mock-003')).toBe(true);

    const att = await s.call('list_messages', { has_attachments: true, limit: 50 });
    expect(att.json.messages.every((m) => m.has_attachments)).toBe(true);

    const day = all.json.messages[0].received.slice(0, 10);
    const today = await s.call('list_messages', { since: day, until: day, limit: 50 });
    expect(today.json.total).toBeGreaterThan(0);
    expect(today.json.messages.every((m) => m.received.startsWith(day))).toBe(true);
  });

  it('reads text, html and truncates', async () => {
    const t = await s.call('read_message', { id: 'mock-003' });
    expect(t.json).toMatchObject({ subject: '办公室搬迁报价（SM-3306）', format: 'text', truncated: false, unread: true });
    expect(t.json.attachments).toEqual([{ index: 1, name: 'quote-SM-3306.txt', size: expect.any(Number) }]);
    const h = await s.call('read_message', { id: 'mock-003', format: 'html' });
    expect(h.json.body).toMatch(/^<html><body><p>/);
    const cut = await s.call('read_message', { id: 'mock-003', max_chars: 200 });
    expect(cut.json.body.length).toBeLessThanOrEqual(200);
    // reading does not mark as read
    const again = await s.call('read_message', { id: 'mock-003' });
    expect(again.json.unread).toBe(true);
  });

  it('marks read and unread again', async () => {
    const r = await s.call('mark_read', { ids: ['mock-001', 'mock-002'] });
    expect(r.json).toEqual({ changed: 2, unread: false });
    expect((await s.call('read_message', { id: 'mock-001' })).json.unread).toBe(false);
    const back = await s.call('mark_read', { ids: ['mock-001'], unread: true });
    expect(back.json.changed).toBe(1);
    expect((await s.call('read_message', { id: 'mock-001' })).json.unread).toBe(true);
  });

  it('moves messages and returns their ids', async () => {
    const r = await s.call('move_messages', { ids: ['mock-022'], folder: 'Inbox/Website Refresh' });
    expect(r.json).toEqual({ folder: 'Inbox/Website Refresh', moved: [{ old_id: 'mock-022', id: 'mock-022' }] });
    const there = await s.call('list_messages', { folder: 'inbox/website refresh' });
    expect(there.json.messages.map((m) => m.id)).toContain('mock-022');
  });

  it('saves attachments without overwriting', async () => {
    const a = await s.call('save_attachments', { id: 'mock-002', dest_folder: dir });
    expect(a.isError).toBe(false);
    expect(a.json.saved[0].path).toBe(join(dir, 'quote-BP-1180.csv'));
    expect(await readFile(join(dir, 'quote-BP-1180.csv'), 'utf8')).toContain('A5 flyer');
    const b = await s.call('save_attachments', { id: 'mock-002', dest_folder: dir, names: ['QUOTE-BP-1180.csv'] });
    expect(b.json.saved[0].path).toBe(join(dir, 'quote-BP-1180 (1).csv'));
    await writeFile(join(dir, 'quote-BP-1180.csv'), 'old');
    const c = await s.call('save_attachments', { id: 'mock-002', dest_folder: dir, overwrite: true });
    expect(c.json.saved[0].path).toBe(join(dir, 'quote-BP-1180.csv'));
    expect(await readFile(join(dir, 'quote-BP-1180.csv'), 'utf8')).toContain('A5 flyer');
    expect((await readdir(dir)).sort()).toEqual(['quote-BP-1180 (1).csv', 'quote-BP-1180.csv']);
  });

  it('refuses attachment names and folders it cannot use', async () => {
    const missing = await s.call('save_attachments', { id: 'mock-002', dest_folder: dir, names: ['nope.pdf'] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('[ATTACHMENT_NOT_FOUND]');
    const rel = await s.call('save_attachments', { id: 'mock-002', dest_folder: 'attachments' });
    expect(rel.text).toContain('[PATH_NOT_ALLOWED]');
  });

  it('creates reply and new drafts, never sends', async () => {
    const r = await s.call('create_draft', { reply_to: 'mock-008', body: '您好，可以团体报名。' });
    expect(r.json).toMatchObject({ folder: 'Drafts', subject: 'RE: 咨询：春季开放日的工作坊能团体报名吗？', to: ['xiaoyu.zhao@mail.example'], sent: false });
    const n = await s.call('create_draft', { to: ['jordan.lee@maplelane.example'], subject: 'Timeline', body: 'Draft timeline.' });
    expect(n.json.sent).toBe(false);
    const drafts = await s.call('list_messages', { folder: 'drafts' });
    expect(drafts.json.messages.map((m) => m.id)).toEqual(expect.arrayContaining([r.json.id, n.json.id]));
    const body = await s.call('read_message', { id: r.json.id });
    expect(body.json.body).toMatch(/^您好，可以团体报名。\n\n-----Original Message-----/);
    const all = await s.call('create_draft', { reply_to: 'mock-010', reply_all: true, body: 'ok' });
    expect(all.json.cc).toEqual(['jordan.lee@maplelane.example']);
  });

  it('answers bad input with readable error codes', async () => {
    const cases = [
      [{ name: 'read_message', args: {} }, '[INVALID_ARGUMENT]'],
      [{ name: 'read_message', args: { id: 'mock-999' } }, '[MESSAGE_NOT_FOUND]'],
      [{ name: 'list_messages', args: { folder: 'Nowhere' } }, '[FOLDER_NOT_FOUND]'],
      [{ name: 'list_messages', args: { limit: 500 } }, '[INVALID_ARGUMENT]'],
      [{ name: 'list_messages', args: { since: 'last week' } }, '[INVALID_ARGUMENT]'],
      [{ name: 'create_draft', args: { body: 'x' } }, '[INVALID_ARGUMENT]'],
      [{ name: 'mark_read', args: { ids: [] } }, '[INVALID_ARGUMENT]'],
    ];
    for (const [c, code] of cases) {
      const r = await s.call(c.name, c.args);
      expect(r.isError, c.name).toBe(true);
      expect(r.text, JSON.stringify(c)).toContain(code);
    }
    const unknown = await s.rpc('tools/call', { name: 'send_mail', arguments: {} });
    expect(unknown.error?.code).toBe(-32602);
  });

  it('keeps mail content out of the log', async () => {
    const text = s.logs.join('\n');
    expect(s.logs.length).toBeGreaterThan(10);
    for (const secret of ['报价', 'BrightPrint', 'quote-BP', 'maplelane', '团体报名', 'xiaoyu']) expect(text).not.toContain(secret);
  });
});
