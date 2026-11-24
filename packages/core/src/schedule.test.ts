// Scheduled tasks: when they run, how a run ends (done, waiting for the user, failed), runs missed while the app was
// closed, a run skipped while the previous one waits, turning off after failing in a row, and the agent's tools.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { nextRun, Scheduler, scheduleProblem } from './schedule.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway, tempDir, until } from './testing/helpers.ts';
import { SqliteStore } from './store/sqlite.ts';
import { isoNow } from './events.ts';
import type { ScheduleInput } from './types.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

const iso = (d: Date) => isoNow(d);
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);
const daily = (time: string, extra: Partial<ScheduleInput> = {}): ScheduleInput => ({ title: '每日报表', prompt: 'Sum up the orders.', trigger: { type: 'time', repeat: { kind: 'daily', time } }, ...extra });

/** A scheduler on its own clock (the runtime's own one is not started). */
function setUp(now: { t: Date }, opts: { store?: SqliteStore } = {}) {
  const rt = makeRuntime(gw, opts.store ? { store: opts.store } : {});
  const sch = new Scheduler(rt, { now: () => now.t });
  sch.start();
  return { rt, sch };
}

describe('when a task runs next', () => {
  it('works it out in this computer’s time', () => {
    const now = at(2026, 11, 22, 15, 0); // a Sunday
    expect(nextRun({ kind: 'daily', time: '09:00' }, now)).toEqual(at(2026, 11, 23, 9));
    expect(nextRun({ kind: 'daily', time: '17:30' }, now)).toEqual(at(2026, 11, 22, 17, 30));
    expect(nextRun({ kind: 'weekly', days: [5], time: '17:30' }, now)).toEqual(at(2026, 11, 27, 17, 30));
    expect(nextRun({ kind: 'weekly', days: [0], time: '15:00' }, now)).toEqual(at(2026, 11, 29, 15));
    expect(nextRun({ kind: 'interval', minutes: 120 }, now)).toEqual(at(2026, 11, 22, 17));
    expect(nextRun({ kind: 'once', at: iso(at(2026, 11, 28, 10)) }, now)).toEqual(at(2026, 11, 28, 10));
    expect(nextRun({ kind: 'once', at: iso(at(2026, 11, 20, 10)) }, now)).toBeNull();
  });

  it('refuses a task that could not run, with what is wrong', () => {
    expect(scheduleProblem(daily('9am'))).toMatch(/HH:MM/);
    expect(scheduleProblem({ ...daily('09:00'), prompt: ' ' })).toMatch(/prompt/);
    expect(scheduleProblem({ ...daily('09:00'), trigger: { type: 'time', repeat: { kind: 'weekly', days: [7], time: '09:00' } } })).toMatch(/days/);
    expect(scheduleProblem(daily('09:00'))).toBeNull();
  });
});

describe('a run', () => {
  it('starts a new conversation at its time with the prompt, and is done when the conversation is', async () => {
    const now = { t: at(2026, 11, 22, 8, 59) };
    const { rt, sch } = setUp(now);
    gw.enqueue({ text: 'Done: 38 orders.' });
    const s = sch.save(daily('09:00', { cwd: dir }));
    expect(s.nextAt).toBe(iso(at(2026, 11, 22, 9)));
    await sch.check();
    expect(sch.runs()).toEqual([]);
    now.t = at(2026, 11, 22, 9, 0);
    await sch.check();
    const run = sch.runs()[0]!;
    expect(run).toMatchObject({ scheduleId: s.id, status: 'running', dueAt: iso(at(2026, 11, 22, 9)) });
    expect(run.late).toBeUndefined();
    await until(() => sch.runs()[0]?.status === 'done');
    const conv = rt.session(run.sessionId!)!;
    expect(conv.info()).toMatchObject({ title: '每日报表', cwd: dir });
    const first = rt.store.listMessages(conv.id)[0]!;
    expect(first.meta).toMatchObject({ author: 'runtime', scheduleRun: { scheduleId: s.id, runId: run.id, title: '每日报表' } });
    expect(sch.get(s.id)).toMatchObject({ nextAt: iso(at(2026, 11, 23, 9)), failures: 0, lastRun: { status: 'done' } });
    sch.stop();
  });

  it('missed while the app was closed: runs once when back, marked late', async () => {
    const now = { t: at(2026, 11, 20, 8, 0) };
    const { sch } = setUp(now);
    gw.enqueue({ text: 'ok' });
    const s = sch.save(daily('09:00'));
    now.t = at(2026, 11, 22, 14, 0); // two runs missed
    await sch.check();
    await until(() => sch.runs()[0]?.status === 'done');
    expect(sch.runs()).toHaveLength(1);
    expect(sch.runs()[0]).toMatchObject({ late: true, dueAt: iso(at(2026, 11, 20, 9)) });
    expect(sch.get(s.id)?.nextAt).toBe(iso(at(2026, 11, 23, 9)));
    sch.stop();
  });

  it('stops at a confirmation and waits; the next time is skipped while it waits; done once the user answers', async () => {
    const now = { t: at(2026, 11, 22, 8, 59) };
    const { rt, sch } = setUp(now);
    gw.enqueue({ toolCalls: [{ id: 'c1', name: 'run_command', args: { command: 'echo hi' } }] }, { text: 'Ran it.' });
    const s = sch.save({ ...daily('09:00', { cwd: dir }), trigger: { type: 'time', repeat: { kind: 'interval', minutes: 1 } } });
    now.t = at(2026, 11, 22, 9, 0);
    await sch.check();
    await until(() => sch.runs()[0]?.status === 'waiting');
    const waiting = sch.runs()[0]!;
    now.t = at(2026, 11, 22, 9, 1);
    await sch.check();
    expect(sch.runs()[0]).toMatchObject({ status: 'skipped', reason: 'previous_waiting' });
    await rt.session(waiting.sessionId!)!.confirm('c1', true);
    await until(() => sch.runs({ status: 'done' }).length === 1);
    expect(sch.runs({ status: 'done' })[0]?.id).toBe(waiting.id);
    expect(sch.get(s.id)?.failures).toBe(0);
    sch.stop();
  });

  it('turns the task off after failing three times in a row', async () => {
    const now = { t: at(2026, 11, 22, 8, 0) };
    const { sch } = setUp(now);
    gw.onRequest(() => ({ status: 400, errorBody: '{"error":{"message":"bad request"}}' }));
    const s = sch.save({ ...daily('09:00'), trigger: { type: 'time', repeat: { kind: 'interval', minutes: 10 } } });
    for (let i = 1; i <= 3; i++) {
      now.t = new Date(now.t.getTime() + 10 * 60_000);
      await sch.check();
      await until(() => sch.runs({ status: 'failed' }).length === i);
    }
    expect(sch.get(s.id)).toMatchObject({ enabled: false, nextAt: null, failures: 3, pausedAfterFailures: true });
    expect(sch.runs()[0]?.reason).toBe('error');
    const back = sch.setEnabled(s.id, true);
    expect(back).toMatchObject({ enabled: true, failures: 0 });
    expect(back.pausedAfterFailures).toBeUndefined();
    sch.stop();
  });

  it('set up to run back in a conversation: each run is in that conversation', async () => {
    const now = { t: at(2026, 11, 22, 16, 59) };
    const { rt, sch } = setUp(now);
    const conv = rt.createSession({ cwd: dir });
    gw.enqueue({ text: 'sorted' }, { text: 'sorted again' });
    sch.save(daily('17:00', { sessionId: conv.id }));
    now.t = at(2026, 11, 22, 17, 0);
    await sch.check();
    await until(() => sch.runs()[0]?.status === 'done');
    expect(sch.runs()[0]?.sessionId).toBe(conv.id);
    expect(rt.sessions().length).toBe(1);
    sch.stop();
  });

  it('runs once for a one-off and then is off; 立即运行 leaves the times as they were', async () => {
    const now = { t: at(2026, 11, 22, 9, 0) };
    const { sch } = setUp(now);
    gw.enqueue({ text: 'a' }, { text: 'b' });
    const once = sch.save({ ...daily('09:00'), trigger: { type: 'time', repeat: { kind: 'once', at: at(2026, 11, 22, 10).toISOString() } } });
    const day = sch.save(daily('18:00'));
    sch.runNow(day.id);
    expect(sch.get(day.id)?.nextAt).toBe(iso(at(2026, 11, 22, 18)));
    now.t = at(2026, 11, 22, 10, 0);
    await sch.check();
    await until(() => sch.runs({ status: 'done' }).length === 2);
    expect(sch.get(once.id)).toMatchObject({ enabled: false, nextAt: null });
    sch.stop();
  });

  it('a run going when the app quit is over at the next start', async () => {
    const store = new SqliteStore(join(dir, 'spica.db'));
    store.upsertSchedule({ id: 'sch_a', title: 't', prompt: 'p', trigger: { type: 'time', repeat: { kind: 'daily', time: '09:00' } }, enabled: true, nextAt: null, failures: 0, createdBy: 'user', createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z' });
    store.upsertScheduleRun({ id: 'run_a', scheduleId: 'sch_a', dueAt: '2026-11-22T01:00:00.000Z', startedAt: '2026-11-22T01:00:00.000Z', status: 'running', sessionId: 's_x' });
    const { sch } = setUp({ t: at(2026, 11, 22, 12) }, { store });
    expect(sch.runs()[0]).toMatchObject({ status: 'failed', reason: 'interrupted' });
    expect(sch.get('sch_a')?.failures).toBe(1);
    sch.stop();
  });
});

describe('the agent’s tools', () => {
  it('schedule_task asks first, in auto mode too; list_schedules lists what is set up', async () => {
    const rt = makeRuntime(gw);
    const s = rt.createSession({ cwd: dir, approvalMode: 'auto' });
    gw.enqueue(
      { toolCalls: [{ id: 't1', name: 'schedule_task', args: { title: '周报', prompt: 'Write the weekly report.', repeat: { kind: 'weekly', days: [5], time: '17:30' }, folder: dir } }] },
    );
    await s.send('every Friday 17:30 write the weekly report').done;
    expect(rt.store.listPending(s.id)[0]?.item).toMatchObject({ kind: 'confirm', toolName: 'schedule_task', reason: 'set up a scheduled task' });
    expect(rt.schedules.list()).toEqual([]);
    gw.enqueue({ toolCalls: [{ id: 't2', name: 'list_schedules', args: {} }] }, { text: 'Set up.' });
    await s.confirm('t1', true);
    await until(() => rt.schedules.list().length === 1);
    expect(rt.schedules.list()[0]).toMatchObject({ title: '周报', createdBy: 'agent', cwd: dir, enabled: true });
    await s.settled();
    const listed = rt.store.listMessages(s.id).flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.toolUseId === 't2');
    expect(listed && 'content' in listed ? String(listed.content) : '').toMatch(/周报 \(sch[_-]\w+\): every Fri at 17:30/);
  });
});
