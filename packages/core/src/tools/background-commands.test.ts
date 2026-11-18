import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../store/memory.ts';
import { tempDir } from '../testing/helpers.ts';
import { Tracer } from '../trace.ts';
import type { CommandJob } from '../types.ts';
import { CommandJobs, createCommandJobTools } from './background-commands.ts';
import { createRunCommandTool } from './command-tool.ts';
import type { Tool, ToolContext } from './types.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const win = process.platform === 'win32';
const cmd = (ps: string, sh: string) => (win ? ps : sh);
let dir: string;
let cleanup: () => Promise<void>;
let jobs: CommandJobs;
let changed: CommandJob[];
let notes: { job: CommandJob; text: string }[];
let run: Tool;
let output: Tool;
let stop: Tool;

const ctx = (sessionId = 's1', signal = new AbortController().signal): ToolContext => ({
  sessionId,
  parentChain: [],
  cwd: dir,
  signal,
  tracer: new Tracer(new MemoryStore()),
  extractors: [],
  services: {},
  callId: `call-${Math.random().toString(36).slice(2)}`,
  emit: () => {},
});

const make = () =>
  new CommandJobs(join(dir, 'jobs'), {
    changed: (j) => changed.push(j),
    fileCards: () => {},
    ended: (job, text) => notes.push({ job, text }),
  });

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  changed = [];
  notes = [];
  jobs = make();
  run = createRunCommandTool({ jobs });
  [output, stop] = createCommandJobTools(jobs) as [Tool, Tool];
});
afterEach(async () => {
  await jobs.close();
  await cleanup();
});

const idOf = (content: string) => /as (cmd\d+)/.exec(content)![1]!;

describe('background commands', () => {
  it('returns an id at once; command_output waits for the end and returns what it wrote', async () => {
    const t0 = Date.now();
    const r = await run.execute({ command: cmd("Write-Output 'first'; Start-Sleep -Milliseconds 1500; Write-Output 'second'", 'echo first; sleep 1.5; echo second'), run_in_background: true }, ctx());
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.isError).toBeFalsy();
    const id = idOf(r.content);
    expect(jobs.running('s1').map((j) => j.id)).toEqual([id]);
    const o = await output.execute({ id, wait_seconds: 20 }, ctx());
    expect(o.content).toContain(`${id} exited with code 0`);
    expect(o.content).toContain('first');
    expect(o.content).toContain('second');
    // read again: nothing new
    const again = await output.execute({ id }, ctx());
    expect(again.content).toContain('(no new output)');
    // it was waiting for it: no end note
    expect(notes).toEqual([]);
    expect(changed.map((j) => !!j.end)).toEqual([false, true]);
  });

  it('reads only what is new while it runs', async () => {
    const r = await run.execute({ command: cmd("Write-Output 'a1'; Start-Sleep -Seconds 30", 'echo a1; sleep 30'), run_in_background: true }, ctx());
    const id = idOf(r.content);
    await vi.waitFor(async () => expect(readFileSync(jobs.get(id)!.outputPath, 'utf8')).toContain('a1'), { timeout: 15_000 });
    const o = await output.execute({ id }, ctx());
    expect(o.content).toContain(`${id} is still running`);
    expect(o.content).toContain('a1');
    const o2 = await output.execute({ id, wait_seconds: 1 }, ctx());
    expect(o2.content).toContain('is still running');
    expect(o2.content).toContain('(no new output)');
  });

  it('stop_command stops it and what it started; the model is not told again', async () => {
    const r = await run.execute({ command: cmd('Start-Sleep -Seconds 60', 'sleep 60'), run_in_background: true }, ctx());
    const id = idOf(r.content);
    const s = await stop.execute({ id }, ctx());
    expect(s.content).toBe(`${id} stopped`);
    expect(jobs.get(id)!.end).toBe('agent');
    expect(jobs.running()).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('the model hears when the user stopped one, and when the app quit', async () => {
    const a = idOf((await run.execute({ command: cmd('Start-Sleep -Seconds 60', 'sleep 60'), run_in_background: true }, ctx())).content);
    const b = idOf((await run.execute({ command: cmd('Start-Sleep -Seconds 60', 'sleep 60'), run_in_background: true }, ctx())).content);
    await jobs.stop(a, 'user');
    expect(notes.map((n) => n.text)).toEqual([expect.stringContaining(`${a} was stopped by the user`)]);
    await jobs.close();
    expect(notes[1]!.text).toContain(`${b} was stopped: the app quit`);
  });

  it('tells the session when one ends on its own', async () => {
    const r = await run.execute({ command: cmd("Write-Output 'x'; exit 3", 'echo x; exit 3'), run_in_background: true }, ctx());
    const id = idOf(r.content);
    await vi.waitFor(() => expect(notes.length).toBe(1), { timeout: 15_000 });
    expect(notes[0]!.text).toContain(`${id} exited with code 3`);
    const o = await output.execute({ id }, ctx());
    expect(o.isError).toBe(true);
    expect(o.content).toContain('x');
  });

  it("another conversation cannot read or stop it", async () => {
    const r = await run.execute({ command: cmd('Start-Sleep -Seconds 30', 'sleep 30'), run_in_background: true }, ctx('s1'));
    const id = idOf(r.content);
    expect((await output.execute({ id }, ctx('s2'))).isError).toBe(true);
    expect((await stop.execute({ id }, ctx('s2'))).isError).toBe(true);
    expect(jobs.running('s1').length).toBe(1);
  });

  it('stopSessions and close stop them with their reason; a restart still shows how each ended', async () => {
    const a = idOf((await run.execute({ command: cmd('Start-Sleep -Seconds 30', 'sleep 30'), run_in_background: true }, ctx('s1'))).content);
    const b = idOf((await run.execute({ command: cmd('Start-Sleep -Seconds 30', 'sleep 30'), run_in_background: true }, ctx('s2'))).content);
    await jobs.stopSessions(['s1'], 'conversation_deleted');
    expect(jobs.get(a)!.end).toBe('conversation_deleted');
    expect(jobs.get(b)!.end).toBeUndefined();
    await jobs.close();
    expect(jobs.get(b)!.end).toBe('app_quit');
    const again = make();
    expect(again.get(a)!.end).toBe('conversation_deleted');
    expect(again.get(b)!.end).toBe('app_quit');
    // new ids go on from the old ones
    const c = idOf((await createRunCommandTool({ jobs: again }).execute({ command: cmd("Write-Output 'c'", 'echo c'), run_in_background: true }, ctx())).content);
    expect([a, b]).not.toContain(c);
    await again.close();
  });

  it('a record left running by a crash reads as stopped after the restart', async () => {
    const file = join(dir, 'jobs', 'jobs.json');
    const rec: CommandJob = { id: 'cmd7', sessionId: 's1', callId: 'c', command: 'x', cwd: dir, startedAt: '2020-01-01T00:00:00.000Z', outputPath: join(dir, 'jobs', 'cmd7.log'), pid: 999_999 };
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    writeFileSync(file, JSON.stringify([rec]));
    const again = make();
    expect(again.get('cmd7')!.end).toBe('app_crashed');
    expect(JSON.parse(readFileSync(file, 'utf8'))[0].end).toBe('app_crashed');
    expect(notes).toEqual([]);
    again.announceCrashed();
    expect(notes.map((n) => n.text)).toEqual([expect.stringContaining('cmd7 was stopped: the app closed unexpectedly')]);
  });

  it('drop forgets a deleted conversation with its logs', async () => {
    const id = idOf((await run.execute({ command: cmd("Write-Output 'z'", 'echo z'), run_in_background: true }, ctx('s1'))).content);
    await vi.waitFor(() => expect(jobs.get(id)!.end).toBe('exited'), { timeout: 15_000 });
    const log = jobs.get(id)!.outputPath;
    expect(existsSync(log)).toBe(true);
    jobs.drop(['s1']);
    expect(jobs.get(id)).toBeUndefined();
    expect(existsSync(log)).toBe(false);
  });

  it('without jobs run_command has no run_in_background', () => {
    const plain = createRunCommandTool();
    expect((plain.spec.inputSchema as { properties: Record<string, unknown> }).properties.run_in_background).toBeUndefined();
    expect((run.spec.inputSchema as { properties: Record<string, unknown> }).properties.run_in_background).toBeDefined();
  });
});
