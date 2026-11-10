import { describe, expect, it } from 'vitest';
import type { AgentApi, CoreEvent } from '@spica/protocol';
import { FakeBackend } from './fake';
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
};

describe('FakeBackend', () => {
  it('has every method of the core API, so screenshots never hit a missing one', () => {
    const backend = new FakeBackend({ speed: 0 });
    const missing = Object.keys(API).filter((k) => typeof (backend as unknown as Record<string, unknown>)[k] !== 'function');
    expect(missing).toEqual([]);
    backend.dispose();
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
});
