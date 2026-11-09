// outlook.ps1 on Windows PowerShell 5.1: parses cleanly, and every operation
// runs against a stand-in Outlook object model (test/fake-outlook.ps1). The
// last test talks to whatever Outlook this machine really has.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapWorkerError } from '../server/errors.js';
import { OutlookBackend, powershellPath, runWorker } from '../server/outlook-backend.js';
import { runFake } from './fake-runner.mjs';

const SCRIPT = fileURLToPath(new URL('../server/outlook.ps1', import.meta.url));
const win = process.platform === 'win32';

describe.skipIf(!win)('outlook.ps1', () => {
  let dir;
  let run;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spica-outlook-ps-'));
    run = runFake([
      { op: 'listFolders', args: {} },
      { op: 'listMessages', args: { folder: 'inbox', limit: 2, offset: 0 } },
      { op: 'listMessages', args: { folder: 'inbox', limit: 2, offset: 2 } },
      { op: 'listMessages', args: { folder: 'Inbox', unread_only: true, from: "O'Brien", query: 'quote', has_attachments: true, limit: 20, offset: 0 } },
      { op: 'listMessages', args: { folder: 'inbox', since: '2026-11-05T00:00:00.000Z', until: '2026-11-09T00:00:00.000Z', limit: 20, offset: 0 } },
      { op: 'readMessage', args: { id: '$quote', format: 'text', max_chars: 8000 } },
      { op: 'readMessage', args: { id: '$agenda', format: 'html', max_chars: 200 } },
      { op: 'markRead', args: { ids: ['$quote', '$lunch'], unread: false } },
      { op: 'moveMessages', args: { ids: ['$sitemap'], folder: 'inbox/projects/../Projects' } },
      { op: 'moveMessages', args: { ids: ['$lunch'], folder: 'Inbox/Projects' } },
      { op: 'saveAttachments', args: { id: '$quote', dest_folder: dir, names: null, overwrite: false } },
      { op: 'saveAttachments', args: { id: '$quote', dest_folder: dir, names: ['QUOTE-Q-7.csv'], overwrite: false } },
      { op: 'saveAttachments', args: { id: '$quote', dest_folder: dir, names: ['missing.pdf'], overwrite: false } },
      { op: 'createDraft', args: { reply_to: '$quote', reply_all: true, to: [], cc: ['boss@example.test'], body: 'Thanks <b>Priya</b>\nSee you', open_window: false } },
      { op: 'createDraft', args: { to: ['new@example.test'], cc: [], subject: 'Hello', body: 'Plain', open_window: true } },
      { op: 'readMessage', args: { id: 'guarded', format: 'text', max_chars: 100 } },
      { op: 'readMessage', args: { id: 'busy', format: 'text', max_chars: 100 } },
      { op: 'readMessage', args: { id: 'E999', format: 'text', max_chars: 100 } },
      { op: 'listMessages', args: { folder: 'Inbox/Nope', limit: 5, offset: 0 } },
      { op: 'listFolders', args: { mailbox: 'Someone Else' } },
      { op: 'sendMail', args: {} },
    ]);
  }, 90_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  const res = (i) => run.results[i];

  it('has no parse errors and never sends', async () => {
    const src = await readFile(SCRIPT, 'utf8');
    expect(/[^ -~\t\r\n]/.test(src), 'outlook.ps1 must stay plain ASCII').toBe(false);
    expect(src).not.toMatch(/\.Send\s*\(/i);
    const r = spawnSync(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT}', [ref]$null, [ref]$e); $e.Count`],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    );
    expect(r.stdout.trim()).toBe('0');
  });

  it('lists mail folders with aliases and counts', () => {
    expect(res(0).ok).toBe(true);
    expect(res(0).result.folders).toEqual([
      { path: 'Inbox', alias: 'inbox', unread: 2, total: 3 },
      { path: 'Inbox/Projects', unread: 0, total: 1 },
      { path: 'Drafts', alias: 'drafts', unread: 0, total: 0 },
      { path: 'Sent Items', alias: 'sent', unread: 0, total: 0 },
    ]);
  });

  it('lists newest first with paging, SMTP addresses for Exchange senders', () => {
    const p1 = res(1).result;
    expect(p1.total).toBe(3);
    expect(p1.next_offset).toBe(2);
    expect(p1.messages.map((m) => m.subject)).toEqual(['Kickoff agenda', 'Quote Q-7 for flyers']);
    expect(p1.messages[0]).toMatchObject({ kind: 'meeting', from_address: 'jordan@example.test', unread: true, has_attachments: false, received: expect.stringMatching(/^2026-11-09T09:00:00[+-]\d\d:\d\d$/) });
    expect(p1.messages[1]).toMatchObject({ importance: 'high', categories: ['Open House', 'Quotes'], has_attachments: true });
    expect(p1.messages[0].preview.length).toBeLessThanOrEqual(120);
    const p2 = res(2).result;
    expect(p2.messages.map((m) => m.subject)).toEqual(["Lunch on Friday? It's on me"]);
    expect(p2.next_offset).toBeNull();
  });

  it('builds one DASL filter and escapes quotes', () => {
    expect(res(3).ok).toBe(true);
    // inbox tables in request order: two plain lists, the filtered one, the date one
    expect(run.filters.inbox).toEqual([
      '',
      '',
      '@SQL="urn:schemas:httpmail:read" = 0 AND "urn:schemas:httpmail:hasattachment" = 1 AND ' +
        `("urn:schemas:httpmail:fromname" LIKE '%O''Brien%' OR "urn:schemas:httpmail:fromemail" LIKE '%O''Brien%') AND ` +
        `("urn:schemas:httpmail:subject" LIKE '%quote%' OR "urn:schemas:httpmail:fromname" LIKE '%quote%' OR "urn:schemas:httpmail:textdescription" LIKE '%quote%')`,
      '',
    ]);
  });

  it('compares dates itself (locale-free)', () => {
    const r = res(4).result;
    expect(r.messages.map((m) => m.subject)).toEqual(['Quote Q-7 for flyers']);
    expect(r.total).toBe(1);
  });

  it('reads headers, recipients, body and attachments', () => {
    const m = res(5).result;
    expect(m).toMatchObject({ subject: 'Quote Q-7 for flyers', from_address: 'priya@print.example.test', body: 'Quote attached. Valid 14 days.', truncated: false, folder: 'Inbox' });
    expect(m.to).toEqual(['Alex Chen <alex@example.test>']);
    expect(m.cc).toEqual(['Mei Lin <mei@example.test>']);
    expect(m.attachments).toEqual([
      { index: 1, name: 'quote-Q-7.csv', size: 20, inline: false },
      { index: 2, name: 'image001.png', size: 3, inline: true },
    ]);
    const h = res(6).result;
    expect(h.format).toBe('html');
    expect(h.body.length).toBe(200);
    expect(h.truncated).toBe(true);
  });

  it('marks read, moves and reports new ids', () => {
    expect(res(7).result).toEqual({ changed: 1, unread: false });
    expect(res(8).ok).toBe(false);
    expect(res(8).error.code).toBe('FOLDER_NOT_FOUND');
    const mv = res(9).result;
    expect(mv.folder).toBe('Inbox/Projects');
    expect(mv.moved[0].id).not.toBe(mv.moved[0].old_id);
  });

  it('saves attachments with unique names', async () => {
    expect(res(10).result.saved.map((s) => s.name)).toEqual(['quote-Q-7.csv', 'image001.png']);
    expect(res(11).result.saved[0].path).toBe(join(dir, 'quote-Q-7 (1).csv'));
    expect((await readdir(dir)).sort()).toEqual(['image001.png', 'quote-Q-7 (1).csv', 'quote-Q-7.csv']);
    expect(await readFile(join(dir, 'quote-Q-7.csv'), 'utf8')).toContain('flyer,10');
    expect(res(12).error).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND', detail: 'missing.pdf' });
  });

  it('drafts a reply above the quoted HTML and a new mail, opens only when asked', () => {
    const reply = res(13).result;
    expect(reply).toMatchObject({ folder: 'Drafts', subject: 'RE: Quote Q-7 for flyers', sent: false, opened_window: false });
    expect(reply.to).toEqual(['Priya Nair']);
    expect(reply.cc).toEqual(['Mei Lin', 'boss@example.test']);
    const [d1, d2] = run.drafts;
    expect(d1.html).toMatch(/^<html><head><\/head><body lang=EN><div>Thanks &lt;b&gt;Priya&lt;\/b&gt;<br>See you<\/div><br><p>From: Priya Nair<\/p>/);
    expect(d1.displayed).toBe(false);
    expect(res(14).result).toMatchObject({ subject: 'Hello', to: ['new@example.test'], opened_window: true });
    expect(d2.displayed).toBe(true);
  });

  it('reports COM failures with HRESULTs that map to codes', () => {
    expect(res(15).error.hresult).toBe('0x80004004');
    expect(mapWorkerError(res(15).error).code).toBe('OUTLOOK_SECURITY_BLOCKED');
    expect(mapWorkerError(res(16).error).code).toBe('OUTLOOK_BUSY');
    expect(res(17).error.code).toBe('MESSAGE_NOT_FOUND');
    expect(res(18).error).toMatchObject({ code: 'FOLDER_NOT_FOUND', detail: 'Inbox/Nope' });
    expect(res(19).error.code).toBe('FOLDER_NOT_FOUND');
    expect(res(20).error.code).toBe('INVALID_ARGUMENT');
  });

  it('answers status from this machine without starting Outlook', async () => {
    const before = spawnSync('tasklist', ['/FI', 'IMAGENAME eq OUTLOOK.EXE', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout.includes('OUTLOOK.EXE');
    const first = await runWorker(SCRIPT, 'status', {});
    // either an answer, or (32-bit Office with a broken 64-bit entry) the request to switch
    expect(first.ok || first.error?.code === 'NEED_32BIT_POWERSHELL').toBe(true);
    const st = await new OutlookBackend({ script: SCRIPT }).status();
    expect(st.mode).toBe('real');
    expect(['ready', 'restricted', 'not_installed', 'new_outlook_only', 'no_profile', 'not_running']).toContain(st.outlook.state);
    expect(typeof st.outlook.classic_installed).toBe('boolean');
    expect(typeof st.outlook.new_outlook_installed).toBe('boolean');
    expect(st.outlook.hint.length).toBeGreaterThan(5);
    if (st.outlook.classic_installed) expect(existsSync(st.outlook.classic_path)).toBe(true);
    const after = spawnSync('tasklist', ['/FI', 'IMAGENAME eq OUTLOOK.EXE', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout.includes('OUTLOOK.EXE');
    expect(after).toBe(before);
  }, 60_000);
});

describe.skipIf(!win)('outlook.ps1 environment checks', () => {
  const E64 = 'C:\\Program Files\\Office\\OUTLOOK.EXE';
  const E32 = 'C:\\Program Files (x86)\\Office\\OUTLOOK.EXE';
  const base = { p64: null, p32: null, files: [], new: false, profile: false, running: false };
  const cases = [
    ['nothing installed', {}, 'not_installed', 'OUTLOOK_NOT_INSTALLED'],
    ['only the new Outlook', { new: true }, 'new_outlook_only', 'OUTLOOK_NEW_ONLY'],
    ['COM left over from an uninstall, new Outlook present', { p64: E64, p32: E32, new: true }, 'new_outlook_only', 'OUTLOOK_NEW_ONLY'],
    ['COM left over from an uninstall', { p64: E64 }, 'not_installed', 'OUTLOOK_NOT_INSTALLED'],
    ['classic, no profile', { p64: E64, files: [E64] }, 'no_profile', 'OUTLOOK_NO_PROFILE'],
    ['32-bit Office, broken 64-bit entry', { p64: E64, p32: E32, files: [E32], profile: true, running: true }, 'needs_32bit', 'NEED_32BIT_POWERSHELL'],
    ['classic, profile, closed', { p64: E64, files: [E64], profile: true }, 'not_running', 'OUTLOOK_NOT_RUNNING'],
  ];
  let out;
  beforeAll(() => {
    const r = spawnSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./prereq.ps1', import.meta.url))], {
      input: JSON.stringify(cases.map(([, c]) => ({ ...base, ...c }))),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      env: { ...process.env, SPICA_OUTLOOK_SCRIPT: SCRIPT },
    });
    out = JSON.parse(r.stdout);
  }, 90_000);

  it.each(cases.map((c, i) => [c[0], i, c[2], c[3]]))('%s', (_name, i, state, code) => {
    expect(out[i].state).toBe(state);
    expect(out[i].code).toBe(code);
  });

  it('reports the real program path, not the leftover entry', () => {
    expect(out[4]).toMatchObject({ classic: true, path: E64 });
    expect(out[3]).toMatchObject({ classic: false, path: null });
  });
});
