// Choosing the working folder of a conversation that had none: once, the files
// it made move along (all or nothing, nothing overwritten), the model is told.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentApi } from './api.ts';
import { moveFile, moveFolderContents } from './move-folder.ts';
import { SqliteStore } from './store/sqlite.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir, until } from './testing/helpers.ts';

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

describe('moving a folder’s contents', () => {
  it('keeps relative paths, brings empty folders, and renames instead of overwriting', () => {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    put(join(src, 'report.md'), 'mine');
    put(join(src, 'data', 'a.csv'), '1,2');
    put(join(src, 'notes.txt'), 'n');
    mkdirSync(join(src, 'empty'), { recursive: true });
    put(join(dest, 'report.md'), 'theirs');
    put(join(dest, 'report (1).md'), 'theirs too');
    const res = moveFolderContents(src, dest);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.renamed).toEqual([{ from: 'report.md', to: 'report (2).md' }]);
    expect(res.moved.map((m) => m.to).sort()).toEqual([join('data', 'a.csv'), 'notes.txt', 'report (2).md'].sort());
    expect(readFileSync(join(dest, 'report.md'), 'utf8')).toBe('theirs'); // nothing overwritten
    expect(readFileSync(join(dest, 'report (2).md'), 'utf8')).toBe('mine');
    expect(readFileSync(join(dest, 'data', 'a.csv'), 'utf8')).toBe('1,2');
    expect(existsSync(join(dest, 'empty'))).toBe(true);
    expect(readdirSync(join(src, 'data'))).toEqual([]);
  });

  it('when a move fails, the moved files go back and the folders made for them are removed', () => {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    put(join(src, 'a.txt'), 'a');
    put(join(src, 'b', 'c.txt'), 'c');
    put(join(src, 'd.txt'), 'd');
    let n = 0;
    const res = moveFolderContents(src, dest, (from, to) => {
      if (++n === 3) throw new Error('disk full');
      moveFile(from, to);
    });
    expect(res).toMatchObject({ ok: false, message: 'disk full', notRestored: [] });
    expect(res.ok ? '' : res.file).toBeTruthy();
    expect(readFileSync(join(src, 'a.txt'), 'utf8')).toBe('a');
    expect(readFileSync(join(src, 'b', 'c.txt'), 'utf8')).toBe('c');
    expect(readFileSync(join(src, 'd.txt'), 'utf8')).toBe('d');
    expect(existsSync(dest)).toBe(false); // the folder it made is gone again
  });
});

describe('choosing the working folder later', () => {
  const opts = () => ({ cwd: join(dir, 'Documents'), sessionFilesDir: join(dir, 'data', 'sessions'), projectsRoot: join(dir, 'p') });

  it('a conversation without a folder chooses one after messages; its files and sub-agents move along; the model is told; only once', async () => {
    gw.onRequest(() => ({ text: 'ok' }));
    const path = join(dir, 'db', 'spica.db');
    const rt = makeRuntime(gw, { ...opts(), store: new SqliteStore(path) });
    const api = createAgentApi(rt);
    const events = captureEvents(rt);
    const chat = rt.createSession();
    await chat.send('make a report').done;
    const own = chat.config.cwd;
    put(join(own, 'report.md'), 'mine');
    put(join(own, 'out', 'table.csv'), 't');
    const child = rt.createSession({ parentId: chat.id });
    expect(child.config.cwd).toBe(own);
    expect(chat.info().canChooseCwd).toBe(true);
    expect(child.info().canChooseCwd).toBe(false); // a sub-agent goes where its parent goes

    const target = join(dir, 'Work', 'Quotes');
    put(join(target, 'report.md'), 'already there');
    const before = chat.info().updatedAt;
    const res = await api.setSessionCwd!(chat.id, target);
    expect(res).toMatchObject({ ok: true, renamed: [{ from: 'report.md', to: 'report (1).md' }], info: { cwd: target, canChooseCwd: false } });
    expect(res.ok && res.moved.length).toBe(2);
    expect(readFileSync(join(target, 'report (1).md'), 'utf8')).toBe('mine');
    expect(readFileSync(join(target, 'report.md'), 'utf8')).toBe('already there');
    expect(readFileSync(join(target, 'out', 'table.csv'), 'utf8')).toBe('t');
    expect(existsSync(own)).toBe(false); // the emptied own folder is cleaned up
    expect(child.config.cwd).toBe(target);
    expect(chat.info().updatedAt).toBe(before); // a setting, not use
    expect(events.filter((e) => e.type === 'session.updated' && e.sessionId === chat.id).at(-1)).toMatchObject({ info: { cwd: target } });
    const note = chat.messages().at(-1)!;
    expect(note).toMatchObject({ kind: 'note', meta: { cwdChange: { from: own, to: target } } });
    // the model reads it with the next message
    await chat.send('go on').done;
    const sent = JSON.stringify(gw.requests.at(-1)!.body.messages);
    expect(sent).toContain(`working folder for this conversation: ${target.replace(/\\/g, '\\\\')}`);
    expect(sent).toContain('report.md → report (1).md');
    // only once
    expect(await api.setSessionCwd!(chat.id, join(dir, 'Other'))).toMatchObject({ ok: false, code: 'cwd.not_changeable' });
    await rt.close();

    const again = makeRuntime(gw, { ...opts(), store: new SqliteStore(path) });
    again.restore();
    expect(again.session(chat.id)!.info()).toMatchObject({ cwd: target, canChooseCwd: false });
    await again.close();
  });

  it('not for a conversation with a chosen folder, a project manager, a sub-agent, or without own folders', async () => {
    const rt = makeRuntime(gw, opts());
    const api = createAgentApi(rt);
    const chosen = rt.createSession({ cwd: join(dir, 'chosen') });
    const p = rt.createProject({ name: 'Fixed' });
    const sub = rt.createSession({ parentId: rt.createSession().id });
    for (const id of [chosen.id, p.managerSessionId, sub.id]) {
      expect(rt.session(id)!.info().canChooseCwd).toBe(false);
      expect(await api.setSessionCwd!(id, join(dir, 'x'))).toMatchObject({ ok: false, code: 'cwd.not_changeable' });
    }
    await rt.close();
    const plain = makeRuntime(gw, { cwd: dir }); // no own folders (sessionFilesDir unset)
    expect(plain.createSession().info().canChooseCwd).toBe(false);
    await plain.close();
  });

  it('refused while it runs; refused for a bad folder; nothing moves', async () => {
    gw.onRequest(() => ({ text: 'slow', delayMs: 400 }));
    const rt = makeRuntime(gw, opts());
    const chat = rt.createSession();
    put(join(chat.config.cwd, 'a.txt'), 'a');
    const run = chat.send('work');
    await until(() => chat.running);
    expect(rt.setSessionCwd(chat.id, join(dir, 'x'))).toMatchObject({ ok: false, code: 'cwd.busy' });
    await run.done;
    put(join(dir, 'afile'), 'f');
    expect(rt.setSessionCwd(chat.id, 'relative\\path')).toMatchObject({ ok: false, code: 'cwd.bad_folder' });
    expect(rt.setSessionCwd(chat.id, join(dir, 'afile'))).toMatchObject({ ok: false, code: 'cwd.bad_folder' });
    expect(rt.setSessionCwd(chat.id, join(chat.config.cwd, 'inner'))).toMatchObject({ ok: false, code: 'cwd.bad_folder' });
    expect(readFileSync(join(chat.config.cwd, 'a.txt'), 'utf8')).toBe('a');
    expect(chat.info().canChooseCwd).toBe(true);
    await rt.close();
  });

  it('when a file cannot be moved, everything goes back, the folder stays as it was, and the window learns which file', async () => {
    const rt = makeRuntime(gw, opts());
    const chat = rt.createSession();
    const own = chat.config.cwd;
    put(join(own, 'a.txt'), 'a');
    put(join(own, 'sub', 'x.txt'), 'x');
    const target = join(dir, 'Target');
    put(join(target, 'sub'), 'a file where the folder would go');
    const res = rt.setSessionCwd(chat.id, target);
    expect(res).toMatchObject({ ok: false, code: 'cwd.move_failed', file: join('sub', 'x.txt') });
    expect(chat.config.cwd).toBe(own);
    expect(chat.info().canChooseCwd).toBe(true);
    expect(readFileSync(join(own, 'a.txt'), 'utf8')).toBe('a');
    expect(readFileSync(join(own, 'sub', 'x.txt'), 'utf8')).toBe('x');
    expect(readdirSync(target)).toEqual(['sub']); // only what was there
    expect(chat.messages()).toEqual([]); // no note
    await rt.close();
  });
});
