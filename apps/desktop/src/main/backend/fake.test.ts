import { describe, expect, it } from 'vitest';
import { REPEAT_REMINDER_MARK, type AgentApi, type CoreEvent } from '@spica/protocol';
import { FAKE_BATCH_FILES, FAKE_PHOTO_DATA, fakePhotoAnswer, FAKE_BOM_ANSWER, FAKE_BOM_FILES, FAKE_EXPORT_FILES, FAKE_FLOW_ANSWER, FAKE_LONG_COMMAND, FAKE_MINUTES_ANSWER, FAKE_SEARCH_RESULTS, FAKE_SUMMARY_ANSWER, FAKE_SUMMARY_FILE, FakeBackend } from './fake';
import { SEED_IDS } from './fake-seed';

function collect(backend: FakeBackend) {
  const events: CoreEvent[] = [];
  backend.onEvent((e) => events.push(e));
  const until = (pred: (e: CoreEvent) => boolean) =>
    new Promise<CoreEvent>((resolve) => {
      const found = events.find(pred);
      if (found) return resolve(found);
      const off = backend.onEvent((e) => {
        if (pred(e)) {
          off();
          resolve(e);
        }
      });
    });
  return { events, until };
}

// Every method of the core's API. Typed as a record, so a method added to AgentApi
// fails the typecheck here until it is listed (and the fake gets it).
const API: Record<keyof AgentApi, true> = {
  createSession: true,
  listSessions: true,
  getSession: true,
  getMessages: true,
  getPending: true,
  send: true,
  steer: true,
  answer: true,
  renameSession: true,
  setSessionModel: true,
  setApprovalMode: true,
  setSessionCwd: true,
  resume: true,
  regenerate: true,
  confirm: true,
  abort: true,
  exportTraces: true,
  getTopSession: true,
  createProject: true,
  listProjects: true,
  getProject: true,
  renameProject: true,
  deleteProject: true,
  deleteSession: true,
  callPluginTool: true,
  listMail: true,
  pollMail: true,
  mailFeedback: true,
  listMemories: true,
  addMemory: true,
  editMemory: true,
  forgetMemory: true,
  clearMemories: true,
  undoMemory: true,
  tidyMemories: true,
  listMemoryTidies: true,
  undoMemoryTidy: true,
};

describe('FakeBackend', () => {
  it('has every method of the core API, so screenshots never hit a missing one', () => {
    const backend = new FakeBackend({ speed: 0 });
    const missing = Object.keys(API).filter((k) => typeof (backend as unknown as Record<string, unknown>)[k] !== 'function');
    expect(missing).toEqual([]);
    backend.dispose();
  });

  it('memory: a demo message saves with its line, a change replaces, 别记了 forgets, undo takes each back; not in projects or when off', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { events, until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '记住：回答尽量简短，先给结论再说理由。');
    await until((e) => e.type === 'run.end' && e.sessionId === chat.id);
    const saved = events.find((e) => e.type === 'memory.changed' && e.sessionId === chat.id);
    expect(saved).toMatchObject({ callId: expect.any(String), card: { action: 'saved', item: { id: 1, text: '回答尽量简短，先给结论再说理由。', sessionId: chat.id } } });
    // kept with the result, so the line is there when the conversation is opened again
    const stored = (await b.getMessages(chat.id)).find((m) => m.kind === 'tool_results');
    expect(Object.values(stored?.meta?.memoryCards ?? {})).toMatchObject([{ action: 'saved' }]);

    await b.send(chat.id, '记住：数据处理主要用 Python。');
    await until(() => events.filter((x) => x.type === 'run.end' && x.sessionId === chat.id).length >= 2);
    await b.send(chat.id, '数据处理以后改用 Julia，Python 用得少了。');
    await until(() => events.filter((x) => x.type === 'run.end' && x.sessionId === chat.id).length >= 3);
    const replaced = events.filter((e) => e.type === 'memory.changed' && e.sessionId === chat.id).at(-1);
    expect(replaced).toMatchObject({ card: { action: 'replaced', previous: { text: '数据处理主要用 Python。', status: 'replaced' } } });
    const newId = (replaced as Extract<CoreEvent, { type: 'memory.changed' }>).card.item!.id;
    expect(await b.undoMemory(newId)).toMatchObject({ action: 'undone', item: { undone: true }, previous: { status: 'active' } });
    expect(events.at(-1)).toMatchObject({ type: 'memory.changed', sessionId: '', card: { action: 'undone' } });

    expect(await b.addMemory('邮箱密码是 hunter2')).toEqual({ refused: 'secret' });
    expect(await b.addMemory('周报每周五下午发')).toMatchObject({ action: 'saved', item: { by: 'user' } });
    expect(await b.editMemory(1, '   ')).toEqual({ refused: 'empty' });
    expect(await b.forgetMemory(1)).toMatchObject({ action: 'forgotten', item: { status: 'forgotten' } });
    expect((await b.listMemories({ all: true })).find((m) => m.id === 1)?.undone).toBeUndefined();
    const before = (await b.listMemories()).length;
    expect(await b.clearMemories()).toBe(before);
    expect(await b.listMemories()).toEqual([]);

    // a project's manager, and memory switched off: no line
    const runs = () => events.filter((e) => e.type === 'run.end').length;
    let n = runs();
    await b.send(SEED_IDS.pm, '记住：报告用 A4 竖版。');
    await until(() => runs() > n);
    b.setMemoryEnabled(false);
    n = runs();
    await b.send(chat.id, '记住：报告用 A4 竖版。');
    await until(() => runs() > n);
    expect(await b.listMemories()).toEqual([]);
    b.dispose();
  });

  it('memory: 立即整理 merges notes that say the same and adds a standing remark not noted; the tidy or one change can be undone', async () => {
    const b = new FakeBackend({ speed: 0, seed: false });
    const { events, until } = collect(b);
    const chat = await b.createSession({});
    const runs = () => events.filter((e) => e.type === 'run.end').length;
    for (const t of ['记住：回答尽量简短，先给结论。', '记住：回答简短一点，先给结论。', '我一般晚上十一点后不看消息。']) {
      const n = runs();
      await b.send(chat.id, t);
      await until(() => runs() > n);
    }
    expect(await b.tidyMemories()).toMatchObject({ started: true, id: 1 });
    const run = (await until((e) => e.type === 'memory.tidy' && e.run.status === 'done')) as Extract<CoreEvent, { type: 'memory.tidy' }>;
    expect(run.run.changes.map((c) => c.action)).toEqual(['merged', 'added']);
    expect((await b.listMemories()).map((m) => m.text)).toEqual(['回答尽量简短，先给结论。', '一般晚上十一点后不看消息。']);
    expect((await b.undoMemoryTidy(1, 1))!.changes[1]!.undone).toBe(true);
    await b.undoMemoryTidy(1);
    expect((await b.listMemories()).map((m) => m.text)).toEqual(['回答尽量简短，先给结论。', '回答简短一点，先给结论。']);
    // nothing new since: the next one changes nothing
    await b.tidyMemories();
    expect(((await until((e) => e.type === 'memory.tidy' && e.run.id === 2 && e.run.status === 'done')) as Extract<CoreEvent, { type: 'memory.tidy' }>).run.changes).toEqual([]);
    b.setMemoryEnabled(false);
    expect(await b.tidyMemories()).toEqual({ started: false, reason: 'off' });
    b.dispose();
  });

  it('lists the seed projects and makes new ones with a manager', async () => {
    const backend = new FakeBackend({ speed: 0 });
    const { until } = collect(backend);
    expect((await backend.getTopSession()).id).toBe(SEED_IDS.chat);
    expect((await backend.listProjects()).map((p) => p.name)).toEqual(['新品样机评审', '年度预算']);
    const detail = await backend.getProject('p-review');
    expect(detail?.manager.id).toBe(SEED_IDS.pm);
    expect(detail?.agents.map((a) => a.id)).toContain(SEED_IDS.quotes);
    const p = await backend.createProject({ name: '办公室搬迁' });
    expect((await until((e) => e.type === 'project.created')).sessionId).toBe(p.managerSessionId);
    expect((await backend.getSession(p.managerSessionId))?.projectId).toBe(p.id);
    // Mail can be moved into the new project.
    const moved = await backend.mailFeedback('demo:m1', { action: 'reassign', projectId: p.id });
    expect(moved.routedTo).toBe(p.managerSessionId);
    backend.dispose();
  });

  it('renaming, switching model or Manual / Auto keeps updatedAt, so the sidebar order stays (as in the core)', async () => {
    let t = Date.parse('2026-01-01T00:00:00Z');
    const b = new FakeBackend({ speed: 0, now: () => new Date(t) });
    const before = (await b.getSession(SEED_IDS.chat))!.updatedAt;
    t += 60_000;
    await b.renameSession(SEED_IDS.chat, 'named');
    await b.setSessionModel(SEED_IDS.chat, 'p', 'm');
    expect((await b.setApprovalMode(SEED_IDS.chat, 'auto')).updatedAt).toBe(before);
    b.dispose();
  });

  it('a conversation without a folder chooses one once, its sub-agents along; not a project manager', async () => {
    const b = new FakeBackend({ speed: 0 });
    const chat = await b.createSession({});
    const child = await b.createSession({ parentId: chat.id, role: 'worker' });
    expect(chat.canChooseCwd).toBe(true);
    expect((await b.createSession({ cwd: 'D:\\x' })).canChooseCwd).toBe(false);
    expect(await b.setSessionCwd(chat.id, 'relative')).toMatchObject({ ok: false, code: 'cwd.bad_folder' });
    const res = await b.setSessionCwd(chat.id, 'D:\\工作\\报价');
    expect(res).toMatchObject({ ok: true, info: { cwd: 'D:\\工作\\报价', canChooseCwd: false } });
    expect((await b.getSession(child.id))!.cwd).toBe('D:\\工作\\报价');
    expect(await b.setSessionCwd(chat.id, 'D:\\other')).toMatchObject({ ok: false, code: 'cwd.not_changeable' });
    expect(await b.setSessionCwd(SEED_IDS.pm, 'D:\\other')).toMatchObject({ ok: false, code: 'cwd.not_changeable' });
    b.dispose();
  });

  it('a conversation in the folder older versions shared chooses one once and its files stay; one in another folder does not', async () => {
    const shared = 'C:\\Users\\me\\Documents\\Spica';
    const b = new FakeBackend({ speed: 0, seed: false, legacyDefaultCwd: shared });
    const old = await b.createSession({ cwd: shared });
    const picked = await b.createSession({ cwd: 'D:\\picked' });
    expect([old.canChooseCwd, picked.canChooseCwd]).toEqual([true, false]);
    expect(await b.setSessionCwd(old.id, 'D:\\工作')).toMatchObject({ ok: true, moved: [], renamed: [], filesStayIn: shared, info: { cwd: 'D:\\工作', canChooseCwd: false } });
    expect(await b.setSessionCwd(picked.id, 'D:\\工作')).toMatchObject({ ok: false, code: 'cwd.not_changeable' });
    const fresh = await b.createSession({});
    expect((await b.setSessionCwd(fresh.id, 'D:\\新')) as { filesStayIn?: string }).not.toHaveProperty('filesStayIn');
    b.dispose();
  });

  it('deletes a conversation with its sub-agents; a project manager only with its project', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { events } = collect(b);
    const chat = await b.createSession({ title: 'to go' });
    const child = await b.createSession({ parentId: chat.id, role: 'worker' });
    await b.deleteSession(chat.id);
    expect(events.filter((e) => e.type === 'session.deleted').map((e) => e.sessionId).sort()).toEqual([chat.id, child.id].sort());
    expect(await b.getSession(chat.id)).toBeUndefined();
    expect(await b.getSession(child.id)).toBeUndefined();
    await expect(b.deleteSession(SEED_IDS.pm)).rejects.toThrow(/project manager/);
    b.dispose();
  });

  it('seeds a project tree with every status the UI draws', async () => {
    const b = new FakeBackend({ speed: 0 });
    const sessions = await b.listSessions();
    const statuses = new Set(sessions.map((s) => s.status));
    for (const s of ['idle', 'thinking', 'tool', 'queued', 'awaiting_answer', 'done'] as const) expect(statuses).toContain(s);
    expect(sessions.find((s) => s.id === SEED_IDS.quotes)?.parentChain).toEqual([SEED_IDS.pm]);
    expect(await b.getPending(SEED_IDS.minutes)).toHaveLength(1);
  });

  it('streams a full answer with ordered, gapless sequence numbers', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { events, until } = collect(b);
    const chat = await b.createSession({ title: '新对话' });
    await b.send(chat.id, '看看资料');
    await until((e) => e.type === 'run.end');
    const types = events.map((e) => e.type);
    expect(types).toContain('thinking.delta');
    expect(types).toContain('text.delta');
    expect(types.indexOf('tool.start')).toBeLessThan(types.indexOf('tool.end'));
    expect(events.at(-1)).toMatchObject({ type: 'run.end', reason: 'completed' });
    events.forEach((e, i) => {
      if (i > 0) expect(e.seq).toBe(events[i - 1]!.seq + 1);
    });
    const messages = await b.getMessages(chat.id);
    expect(messages.map((m) => m.kind)).toEqual(['user', 'assistant', 'tool_results', 'assistant', 'tool_results']);
  });

  it('纪要 answers with headings, a list, inline code and a code block (for screenshots of the text)', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '把这些要点整理成评审纪要');
    await until((e) => e.type === 'run.end');
    const text = (await b.getMessages(chat.id)).flatMap((m) => m.content).filter((c) => c.type === 'text').map((c) => (c as { text: string }).text);
    expect(text).toContain(FAKE_MINUTES_ANSWER);
    expect(FAKE_MINUTES_ANSWER).toMatch(/^## /);
    expect(FAKE_MINUTES_ANSWER).toContain('\n### ');
    expect(FAKE_MINUTES_ANSWER).toContain('```text');
  });

  it('照片 answers with three pictures (the demo chart and two drawn ones), for going through them full size', async () => {
    const b = new FakeBackend({ speed: 0, demoImage: () => 'D:\\demo\\chart.png' });
    const { until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '看几张样机照片');
    await until((e) => e.type === 'run.end');
    const text = (await b.getMessages(chat.id)).flatMap((m) => m.content).filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
    expect(text).toContain(fakePhotoAnswer('D:\\demo\\chart.png'));
    expect(text.match(/!\[/g)).toHaveLength(3);
    for (const d of FAKE_PHOTO_DATA) expect(d).toMatch(/^data:image\/png;base64,/);
  });

  it('批量 leaves fourteen files from one command and hands over two of them (the list in place of cards)', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { events, until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '批量下载这十份规格书');
    await until((e) => e.type === 'run.end');
    const cards = events.filter((e): e is Extract<CoreEvent, { type: 'file.card' }> => e.type === 'file.card');
    const paths = new Set(cards.flatMap((e) => (e.files ?? [e.file]).map((f) => f.path)));
    expect(FAKE_BATCH_FILES).toHaveLength(14);
    // (With the file every demo answer reads first.)
    expect([...paths]).toEqual(expect.arrayContaining(FAKE_BATCH_FILES));
  });

  it('BOM hands over two files and answers with their long full paths (for screenshots)', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { events, until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '把图纸和 BOM 整理一下');
    await until((e) => e.type === 'run.end');
    const cards = events.filter((e): e is Extract<CoreEvent, { type: 'file.card' }> => e.type === 'file.card');
    expect(cards.flatMap((e) => (e.files ?? [e.file]).map((f) => f.path))).toEqual(expect.arrayContaining(FAKE_BOM_FILES));
    const text = (await b.getMessages(chat.id))
      .flatMap((m) => m.content)
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
    expect(text).toContain(FAKE_BOM_ANSWER);
    for (const f of FAKE_BOM_FILES) expect(FAKE_BOM_ANSWER).toContain(`\`${f}\``);
    expect(FAKE_BOM_ANSWER).toMatch(/`[A-Z]:\\[^`]+\\`/);
  });

  it('汇总 writes a file and answers with paths, a table and a code block (for screenshots)', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { events, until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '把报价汇总一下');
    await until((e) => e.type === 'run.end');
    expect(events.find((e) => e.type === 'tool.start' && e.name === 'write_file')).toMatchObject({ input: { path: FAKE_SUMMARY_FILE } });
    const text = (await b.getMessages(chat.id))
      .flatMap((m) => m.content)
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
    expect(text).toContain(FAKE_SUMMARY_ANSWER);
    expect(FAKE_SUMMARY_ANSWER).toMatch(/`[A-Z]:\\[^`]+\\`/);
    expect(FAKE_SUMMARY_ANSWER).toContain('```powershell');
    expect(FAKE_SUMMARY_ANSWER).toContain('| 供应商 |');
    // As the core does: the kind of each step, and cards for what was made (a command's several, then present_files).
    const starts = events.filter((e): e is Extract<CoreEvent, { type: 'tool.start' }> => e.type === 'tool.start').map((e) => [e.name, e.category]);
    expect(starts).toEqual(expect.arrayContaining([['write_file', 'write'], ['run_command', 'command'], ['present_files', 'present']]));
    const cards = events.filter((e): e is Extract<CoreEvent, { type: 'file.card' }> => e.type === 'file.card');
    const command = cards.find((e) => e.files?.length === FAKE_EXPORT_FILES.length);
    expect(command?.files?.map((f) => [f.path, f.origin])).toEqual(FAKE_EXPORT_FILES.map((p, i) => [p, i === 0 ? 'modified' : 'created']));
    expect(cards.find((e) => e.file.path === FAKE_SUMMARY_FILE && e.file.lines)?.file).toMatchObject({ origin: 'created', lines: { added: 5, removed: 0 } });
    // Stored with the results, as the core stores them: a reopened conversation shows the same.
    const meta = (await b.getMessages(chat.id)).filter((m) => m.kind === 'tool_results').map((m) => m.meta ?? {});
    const toolInfo = Object.assign({}, ...meta.map((m) => m.toolInfo ?? {})) as Record<string, { category: string; summary?: string }>;
    expect(Object.values(toolInfo)).toEqual(expect.arrayContaining([{ category: 'command', summary: '导出各家报价' }, { category: 'present' }]));
    const lists = Object.assign({}, ...meta.map((m) => m.fileCardLists ?? {})) as Record<string, unknown[]>;
    expect(Object.values(lists).some((l) => l.length === FAKE_EXPORT_FILES.length)).toBe(true);
  });

  it('画个图: a plugin tool hands back a picture (written by the hook main passes) as a produced card', async () => {
    const b = new FakeBackend({ speed: 0, demoImage: () => 'C:\\demo\\报价对比图.png' });
    const { events, until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '画个图');
    await until((e) => e.type === 'run.end');
    const start = events.find((e): e is Extract<CoreEvent, { type: 'tool.start' }> => e.type === 'tool.start' && e.name === 'charts__render');
    expect(start?.category).toBe('plugin');
    const card = events.find((e): e is Extract<CoreEvent, { type: 'file.card' }> => e.type === 'file.card' && e.file.origin === 'produced');
    expect(card?.file).toMatchObject({ path: 'C:\\demo\\报价对比图.png', name: '报价对比图.png', kind: 'other' });
  });

  it('对比图 answers with three pictures: the demo’s local chart, one on the web, one on a network share', async () => {
    const b = new FakeBackend({ speed: 0, demoImage: () => 'C:\\demo\\报价对比图.png' });
    const { until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '做一张报价对比图');
    await until((e) => e.type === 'run.end');
    const text = (await b.getMessages(chat.id)).flatMap((m) => m.content).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('![四家报价对比](<C:\\demo\\报价对比图.png>)');
    expect(text).toContain('](https://example.com/mold-quote.png)');
    expect(text).toContain('](<\\\\files\\proj\\old.png>)');
  });

  it('流程 answers with a flowchart and an HTML page', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '画一下评审流程');
    await until((e) => e.type === 'run.end');
    const text = (await b.getMessages(chat.id)).flatMap((m) => m.content).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain(FAKE_FLOW_ANSWER);
    expect(FAKE_FLOW_ANSWER).toMatch(/```mermaid\n[\s\S]+```\n\n[\s\S]*```html\n[\s\S]+<script>/);
  });

  it('查一下 searches the web and opens a page, with source cards sent and stored like the core', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { events, until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '查一下模具报价');
    await until((e) => e.type === 'run.end');
    const cards = events.filter((e): e is Extract<CoreEvent, { type: 'source.card' }> => e.type === 'source.card').map((e) => [e.card.tool, e.card.sources.length]);
    expect(cards).toEqual([
      ['web_search', FAKE_SEARCH_RESULTS.length],
      ['web_fetch', 1],
      ['web_fetch', 1],
    ]);
    const stored = (await b.getMessages(chat.id)).filter((m) => m.kind === 'tool_results').flatMap((m) => Object.values((m.meta?.sourceCards ?? {}) as Record<string, unknown>));
    expect(stored).toHaveLength(3);
  });

  it('删除 asks to confirm a long command (for screenshots of the confirmation card)', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '删除旧报价');
    const req = await until((e) => e.type === 'confirm.request');
    expect(req).toMatchObject({ name: 'run_command', input: { command: FAKE_LONG_COMMAND } });
    expect(FAKE_LONG_COMMAND.length).toBeGreaterThan(200);
    if (req.type !== 'confirm.request') throw new Error('unreachable');
    await b.confirm(chat.id, req.callId, false);
    expect(await until((e) => e.type === 'run.end')).toMatchObject({ reason: 'completed' });
  });

  it('waits for confirmation and continues after the decision', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '把通知发送给项目组');
    const req = await until((e) => e.type === 'confirm.request');
    expect((await b.getSession(chat.id))?.status).toBe('awaiting_confirm');
    if (req.type !== 'confirm.request') throw new Error('unreachable');
    await b.confirm(chat.id, req.callId, false);
    const end = await until((e) => e.type === 'run.end');
    expect(end).toMatchObject({ reason: 'completed' });
    expect(await b.getPending(chat.id)).toEqual([]);
  });

  it('answers a pending question left over in history', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { until } = collect(b);
    await b.answer(SEED_IDS.minutes, 'seed-ask-1', '只写结论');
    await until((e) => e.type === 'run.end' && e.sessionId === SEED_IDS.minutes);
    const last = (await b.getMessages(SEED_IDS.minutes)).at(-1);
    expect(JSON.stringify(last?.content)).toContain('只写结论');
  });

  it('「卡住」 keeps reading the file running (the Running … line) until 停止', async () => {
    const b = new FakeBackend({ speed: 1 });
    const { events, until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '看看资料，卡住也没关系');
    await until((e) => e.type === 'tool.start' && e.name === 'read_file');
    await new Promise((r) => setTimeout(r, 1000));
    expect(events.some((e) => e.type === 'tool.end' && e.name === 'read_file')).toBe(false);
    await b.abort(chat.id);
    expect(await until((e) => e.type === 'run.end')).toMatchObject({ reason: 'aborted' });
    b.dispose();
  });

  it('stopped while a question waits, as the core: the question kept with a cancelled result; answering it is refused', async () => {
    const b = new FakeBackend({ speed: 1 });
    const { until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '帮我问问纪要怎么写');
    const ask = await until((e) => e.type === 'ask.request');
    const callId = (ask as { callId: string }).callId;
    await b.abort(chat.id);
    await until((e) => e.type === 'run.end');
    const messages = await b.getMessages(chat.id);
    expect(messages.some((m) => m.content.some((c) => c.type === 'tool_use' && c.id === callId && c.name === 'ask_user'))).toBe(true);
    expect(messages.at(-1)).toMatchObject({ kind: 'tool_results', content: [{ type: 'tool_result', toolUseId: callId, isError: true, content: 'Cancelled: aborted by user.' }] });
    expect(await b.getPending(chat.id)).toEqual([]);
    await expect(b.answer(chat.id, callId, '只写结论')).rejects.toThrow(`no pending ask with id ${callId}`);
    await expect(b.confirm(chat.id, callId, true)).rejects.toThrow(`no pending confirm with id ${callId}`);
    b.dispose();
  });

  it('stops on abort and keeps what was already said', async () => {
    const b = new FakeBackend({ speed: 1 });
    const { until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '看看资料');
    await until((e) => e.type === 'text.delta');
    await b.abort(chat.id);
    const end = await until((e) => e.type === 'run.end');
    expect(end).toMatchObject({ reason: 'aborted' });
    const last = (await b.getMessages(chat.id)).at(-1);
    expect(last?.meta?.interrupted).toBe(true);
    b.dispose();
  });

  it('queues a message sent while running as a steer', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '把通知发送给项目组');
    const req = await until((e) => e.type === 'confirm.request');
    const r = await b.send(chat.id, '改成周五');
    expect(r.started).toBe(false);
    if (req.type === 'confirm.request') await b.confirm(chat.id, req.callId, true);
    await until((e) => e.type === 'steer.applied');
  });

  it('regenerates the last answer like the core: the old one becomes version 1, the new one streams in', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { events, until } = collect(b);
    const chat = await b.createSession({});
    expect((await b.getSession(chat.id))?.regenerate).toMatchObject({ ok: false, code: 'regenerate.no_turn' });
    await b.send(chat.id, '看看资料');
    await until((e) => e.type === 'run.end');
    const first = await b.getMessages(chat.id);
    const anchorId = first[0]!.id;
    expect((await b.getSession(chat.id))?.regenerate).toEqual({ anchorId, ok: true });
    const from = events.length;
    expect(await b.regenerate(chat.id, first.at(-1)!.id)).toEqual({ ok: true, anchorId, version: 2 });
    await until((e) => e.type === 'run.end' && e.seq > events[from]!.seq);
    const types = events.slice(from).map((e) => e.type);
    expect(types[0]).toBe('messages.superseded');
    expect(types.at(-1)).toBe('run.end');
    // current: the question and the new answer; with superseded: the old answer too, as version 1
    const now = await b.getMessages(chat.id);
    expect(now.filter((m) => m.superseded)).toEqual([]);
    expect(JSON.stringify(now)).toContain('第 2 版');
    const all = await b.getMessages(chat.id, { superseded: true });
    expect(all.filter((m) => m.superseded).map((m) => m.superseded!.version)).toEqual(first.slice(1).map(() => 1));
    expect(new Set(all.map((m) => m.seq)).size).toBe(all.length); // numbers are not reused
    // an earlier answer is not the last round any more
    await b.send(chat.id, '再看看');
    await until((e) => e.type === 'run.end' && e.seq > events.at(-2)!.seq);
    expect(await b.regenerate(chat.id, now.at(-1)!.id)).toMatchObject({ ok: false, code: 'regenerate.not_last' });
  });

  it('a round that sent mail cannot be regenerated; a declined one can; project managers cannot', async () => {
    const b = new FakeBackend({ speed: 0 });
    const { events, until } = collect(b);
    for (const approved of [true, false]) {
      const chat = await b.createSession({});
      const from = events.length;
      await b.send(chat.id, '把通知发送给项目组');
      const req = await until((e) => e.type === 'confirm.request' && e.sessionId === chat.id && e.seq > (events[from - 1]?.seq ?? 0));
      if (req.type !== 'confirm.request') throw new Error('unreachable');
      expect((await b.getSession(chat.id))?.regenerate).toMatchObject({ ok: false, code: 'regenerate.waiting' });
      await b.confirm(chat.id, req.callId, approved);
      await until((e) => e.type === 'run.end' && e.sessionId === chat.id);
      expect((await b.getSession(chat.id))?.regenerate).toMatchObject(approved ? { ok: false, code: 'regenerate.acted' } : { ok: true });
    }
    expect((await b.getSession(SEED_IDS.pm))?.regenerate).toMatchObject({ ok: false, code: 'regenerate.role' });
  });
});

describe('spending as the core counts it (a provider’s 花费上限, 未计价, 欠费)', () => {
  it('no limit by default; a limit on all the provider has cost stops the next call once it is reached, over conversations; a model without a price never stops', async () => {
    const b = new FakeBackend({ speed: 0, seed: false });
    const { events, until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '花费上限 试一下');
    await until((e) => e.type === 'run.end' && e.sessionId === chat.id);
    expect(events.some((e) => e.type === 'budget.stop')).toBe(false);
    const before = b.spentUsd();
    expect(before).toBeGreaterThan(1);

    // each call costs about 0.85: the first goes (under the limit), the second finds it reached
    b.setSpendLimit('p-1', before + 0.5);
    events.length = 0;
    const next = await b.createSession({});
    await b.send(next.id, '花费上限 再来');
    expect(await until((e) => e.type === 'run.end' && e.sessionId === next.id)).toMatchObject({ reason: 'budget' });
    const stop = events.find((e) => e.type === 'budget.stop');
    expect(stop).toMatchObject({ scope: 'p-1:global', limitUsd: before + 0.5 });
    if (stop?.type !== 'budget.stop') throw new Error('no stop');
    expect(stop.spentUsd).toBeGreaterThanOrEqual(before + 0.5);

    events.length = 0;
    b.setSpendLimit('p-1', 0.0001);
    const gw = await b.createSession({});
    await b.send(gw.id, '未计价 公司网关');
    expect(await until((e) => e.type === 'run.end' && e.sessionId === gw.id)).toMatchObject({ reason: 'completed' });
    expect(events.filter((e) => e.type === 'usage').every((e) => e.type === 'usage' && e.unpriced === true && e.costUsd === 0)).toBe(true);
  });

  it('「欠费」: the provider says the account is out of money (HTTP 402)', async () => {
    const b = new FakeBackend({ speed: 0, seed: false });
    const { events, until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '欠费');
    expect(await until((e) => e.type === 'run.end' && e.sessionId === chat.id)).toMatchObject({ reason: 'error' });
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/^HTTP 402/) });
  });
});

describe('an answer cut at the most the model may write (「写长一点」)', () => {
  it('is stored with stopReason max_tokens, as the core stores it', async () => {
    const b = new FakeBackend({ speed: 0, seed: false });
    const { until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '写长一点');
    await until((e) => e.type === 'run.end' && e.sessionId === chat.id);
    const last = (await b.getMessages(chat.id)).filter((m) => m.role === 'assistant').at(-1)!;
    expect(last.meta).toMatchObject({ stopReason: 'max_tokens' });
  });
});

describe('messaging a sub-agent past 代理互发消息上限 (「互发」)', () => {
  it('the call past the limit is refused as the core refuses it; no limit: none refused', async () => {
    const b = new FakeBackend({ speed: 0, seed: false });
    const { events, until } = collect(b);
    b.setAgentMessages(2);
    const chat = await b.createSession({});
    await b.send(chat.id, '互发');
    await until((e) => e.type === 'run.end' && e.sessionId === chat.id);
    const ends = events.filter((e) => e.type === 'tool.end' && e.name === 'message_agent');
    expect(ends.map((e) => e.type === 'tool.end' && e.isError)).toEqual([false, false, true]);
    b.setAgentMessages(null);
    events.length = 0;
    await b.send(chat.id, '互发');
    await until((e) => e.type === 'run.end' && e.sessionId === chat.id);
    expect(events.filter((e) => e.type === 'tool.end' && e.name === 'message_agent' && e.isError)).toEqual([]);
  });
});

describe('the same call again and again (「重复」)', () => {
  it('stops as the core stops: 7 calls run, the 8th not, run.end repeated; the reminder is only in what the model reads', async () => {
    const b = new FakeBackend({ speed: 0, seed: false });
    const { events, until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '重复');
    expect(await until((e) => e.type === 'run.end' && e.sessionId === chat.id)).toMatchObject({ reason: 'repeated' });
    const ends = events.filter((e) => e.type === 'tool.end').slice(-8); // after the steps every demo run starts with
    expect(ends.map((e) => e.type === 'tool.end' && e.isError)).toEqual([false, false, false, false, false, false, false, true]);
    expect(ends.every((e) => e.type === 'tool.end' && !e.preview.includes(REPEAT_REMINDER_MARK))).toBe(true);
    const results = (await b.getMessages(chat.id)).flatMap((m) => m.content).filter((x) => x.type === 'tool_result');
    expect(results.filter((x) => x.type === 'tool_result' && x.content.includes(REPEAT_REMINDER_MARK))).toHaveLength(5);
  });
});

describe('a plain error and an interrupted conversation (「超时」, 「断电」)', () => {
  it('「超时」 ends in an error the window words as 模型接口超时; 「断电」 leaves the conversation interrupted, and resume goes on', async () => {
    const b = new FakeBackend({ speed: 0, seed: false });
    const { events, until } = collect(b);
    const chat = await b.createSession({});
    await b.send(chat.id, '超时');
    expect(await until((e) => e.type === 'run.end' && e.sessionId === chat.id)).toMatchObject({ reason: 'error' });
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/timed out/) });
    events.length = 0;
    await b.send(chat.id, '断电');
    await until((e) => e.type === 'run.end' && e.sessionId === chat.id);
    expect((await b.getSession(chat.id))?.status).toBe('interrupted');
    events.length = 0;
    await b.resume(chat.id);
    expect(await until((e) => e.type === 'run.end' && e.sessionId === chat.id)).toMatchObject({ reason: 'completed' });
  });
});

describe('the demo request log (设置 › 用量, the monitor)', () => {
  const now = new Date('2026-11-13T12:00:00Z');

  it('has two weeks over several providers and models, with 429 answers and other failures', async () => {
    const b = new FakeBackend({ speed: 0, now: () => now });
    const s = await b.usageSummary({ from: '2026-10-01T00:00:00Z', to: now.toISOString(), bucket: 'day', tzOffsetMinutes: 480 });
    expect(new Set(s.rows.map((r) => r.providerId)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(s.rows.map((r) => r.model)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(s.rows.map((r) => r.bucket)).size).toBeGreaterThanOrEqual(12);
    expect(s.rateLimited.length).toBeGreaterThan(5);
    expect(s.rows.some((r) => r.failed > r.rateLimited)).toBe(true);
    expect(s.rows.some((r) => r.unpriced)).toBe(true);
    expect(s.since).not.toBeNull();
    b.dispose();
  });

  it('a demo call adds a request record and sends it', async () => {
    const b = new FakeBackend({ speed: 0, now: () => now, seed: false });
    const { until } = collect(b);
    const info = await b.createSession({});
    await b.send(info.id, 'hi');
    const e = await until((x) => x.type === 'request');
    expect(e.type === 'request' && e.record).toMatchObject({ sessionId: info.id, status: 'ok', providerId: 'fake', attempt: 1 });
    expect((await b.recentRequests(10)).length).toBeGreaterThan(0);
    b.dispose();
  });
});
