// Commands that run in the background (run_command with run_in_background): the call returns at once with an id;
// command_output reads what it wrote since the last read (or waits for it to end), stop_command stops it and
// everything it started. The user sees which are running and can stop them (AgentApi listCommandJobs /
// stopCommandJob, event command.job).
//
// How they end:
// - on their own, or stopped by the agent (stop_command) or the user;
// - a sub-agent's when its run ends (nobody would read them any more);
// - a conversation's when it is deleted;
// - all of them when the app quits (Runtime.close).
// A top-level conversation's keep running between its turns and when the user interrupts a run (as in Claude
// Code), until one of the above.
//
// Each one's record is kept in <dir>/jobs.json and its whole output in <dir>/<id>.log, so after a restart the
// conversation still shows how each ended. A record still marked running at start means the app did not get to
// stop it (it crashed): that process is stopped then, if it is still there and started when the record says (a
// pid alone may be another program's by now).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, type WriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { CommandJob, CommandJobEnd, FileCardMeta } from '../types.ts';
import { changeCards, changeLine, folderChanges, notTrackedLine, snapshotFolder, type FolderSnapshot } from './file-changes.ts';
import type { Tool } from './types.ts';

/** What the jobs need from the runtime. */
export interface CommandJobsHost {
  /** Tell the window (event command.job on the job's session). */
  changed(job: CommandJob): void;
  /** The files the command made or changed, as cards on its run_command call. */
  fileCards(job: CommandJob, cards: FileCardMeta[]): void;
  /** A note for the session's model that the command ended (unless it was reading it then). */
  ended(job: CommandJob, text: string): void;
}

interface Live {
  child: ChildProcess;
  out: WriteStream;
  before: FolderSnapshot;
  /** Bytes written to the log (the rest was not kept). */
  written: number;
  dropped: number;
  /** command_output calls waiting for it to end. */
  waiters: Set<() => void>;
  stopping?: CommandJobEnd;
  t0: number;
}

const MAX_LOG_BYTES = 20_000_000;
const MAX_RECORDS = 300;

export class CommandJobs {
  readonly #dir: string;
  readonly #host: CommandJobsHost;
  readonly #jobs = new Map<string, CommandJob>();
  readonly #live = new Map<string, Live>();
  /** How far the model has read each log (bytes), with the decoder that keeps a character cut in two for the next read. */
  readonly #cursor = new Map<string, { bytes: number; decoder: StringDecoder }>();
  /** Bytes a job wrote beyond what its log keeps. */
  readonly #dropped = new Map<string, number>();
  /** The folder-change line of a job that ended (for command_output). */
  readonly #changes = new Map<string, string>();
  #seq = 0;

  constructor(dir: string, host: CommandJobsHost) {
    this.#dir = dir;
    this.#host = host;
    this.#load();
  }

  /** Start a command in the background. `file` and `args` are what to spawn (the shell and the command). */
  async start(spec: {
    sessionId: string;
    callId: string;
    command: string;
    description?: string;
    cwd: string;
    file: string;
    args: string[];
    env: Record<string, string>;
  }): Promise<CommandJob> {
    mkdirSync(this.#dir, { recursive: true });
    const id = this.#newId();
    const outputPath = join(this.#dir, `${id}.log`);
    const before = await snapshotFolder(spec.cwd);
    // its own process group elsewhere than Windows, so stopping it stops what it started (taskkill /T on Windows)
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spec.env,
    });
    const job: CommandJob = {
      id,
      sessionId: spec.sessionId,
      callId: spec.callId,
      command: spec.command,
      ...(spec.description ? { description: spec.description } : {}),
      cwd: spec.cwd,
      startedAt: new Date().toISOString(),
      outputPath,
      ...(child.pid ? { pid: child.pid } : {}),
    };
    const out = createWriteStream(outputPath);
    const live: Live = { child, out, before, written: 0, dropped: 0, waiters: new Set(), t0: performance.now() };
    const take = (d: Buffer) => {
      if (live.written + d.length <= MAX_LOG_BYTES) {
        out.write(d);
        live.written += d.length;
      } else live.dropped += d.length;
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    this.#jobs.set(id, job);
    this.#live.set(id, live);
    const started = await new Promise<Error | undefined>((r) => {
      child.once('spawn', () => r(undefined));
      child.once('error', (e) => r(e));
    });
    if (started) {
      this.#live.delete(id);
      out.end();
      this.#jobs.set(id, { ...job, endedAt: new Date().toISOString(), end: 'failed', exitCode: null });
      this.#save();
      throw new Error(`Could not start ${spec.file}: ${started.message}`);
    }
    child.once('close', (code) => void this.#finish(id, code));
    this.#save();
    this.#host.changed(job);
    return job;
  }

  get(id: string): CommandJob | undefined {
    return this.#jobs.get(id);
  }

  /** A session's jobs, oldest first. */
  list(sessionId: string): CommandJob[] {
    return [...this.#jobs.values()].filter((j) => j.sessionId === sessionId);
  }

  running(sessionId?: string): CommandJob[] {
    return [...this.#jobs.values()].filter((j) => !j.end && (!sessionId || j.sessionId === sessionId));
  }

  /**
   * What the job wrote since the last read. With `waitMs`, first wait until it ends or that long has passed
   * (`signal` cuts the wait short).
   */
  async read(id: string, waitMs = 0, signal?: AbortSignal): Promise<{ job: CommandJob; text: string; dropped: number }> {
    let job = this.#jobs.get(id);
    if (!job) throw new Error(`unknown background command: ${id}`);
    const live = this.#live.get(id);
    if (live && waitMs > 0 && !job.end) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          live.waiters.delete(done);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        live.waiters.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });
      job = this.#jobs.get(id)!;
    }
    const text = await this.#readNew(job);
    return { job, text, dropped: this.#live.get(id)?.dropped ?? this.#dropped.get(id) ?? 0 };
  }

  /** Stop a job and everything it started; resolves when it has ended. */
  async stop(id: string, by: Exclude<CommandJobEnd, 'exited' | 'failed'>): Promise<CommandJob> {
    const job = this.#jobs.get(id);
    if (!job) throw new Error(`unknown background command: ${id}`);
    const live = this.#live.get(id);
    if (!live || job.end) return job;
    live.stopping ??= by;
    const ended = new Promise<void>((r) => live.waiters.add(r));
    killTree(live.child.pid, true);
    await Promise.race([ended, new Promise((r) => setTimeout(r, 5000))]);
    return this.#jobs.get(id)!;
  }

  /** Stop the running jobs of these sessions. */
  async stopSessions(ids: Iterable<string>, by: Exclude<CommandJobEnd, 'exited' | 'failed'>): Promise<void> {
    const set = new Set(ids);
    await Promise.all(this.running().filter((j) => set.has(j.sessionId)).map((j) => this.stop(j.id, by)));
  }

  /** Forget deleted sessions' jobs and their logs (stop them first). */
  drop(ids: Iterable<string>): void {
    const set = new Set(ids);
    let changed = false;
    for (const j of [...this.#jobs.values()]) {
      if (!set.has(j.sessionId) || !j.end) continue;
      this.#jobs.delete(j.id);
      rmSync(j.outputPath, { force: true });
      changed = true;
    }
    if (changed) this.#save();
  }

  /** The app quits: stop every running job (marked app_quit). */
  async close(): Promise<void> {
    await Promise.all(this.running().map((j) => this.stop(j.id, 'app_quit')));
    this.#save();
  }

  /** The folder-change line of a job that ended. */
  changeLineOf(id: string): string {
    return this.#changes.get(id) ?? '';
  }

  // -------------------------------------------------------------------------

  async #readNew(job: CommandJob): Promise<string> {
    let cur = this.#cursor.get(job.id);
    if (!cur) this.#cursor.set(job.id, (cur = { bytes: 0, decoder: new StringDecoder('utf8') }));
    let fh;
    try {
      fh = await open(job.outputPath, 'r');
    } catch {
      return '';
    }
    try {
      const size = (await fh.stat()).size;
      let text = '';
      if (size > cur.bytes) {
        const buf = Buffer.alloc(size - cur.bytes);
        const { bytesRead } = await fh.read(buf, 0, buf.length, cur.bytes);
        cur.bytes += bytesRead;
        text = cur.decoder.write(buf.subarray(0, bytesRead));
      }
      return job.end ? text + cur.decoder.end() : text;
    } finally {
      await fh.close();
    }
  }

  async #finish(id: string, code: number | null): Promise<void> {
    const live = this.#live.get(id);
    const job = this.#jobs.get(id);
    if (!live || !job) return;
    await new Promise<void>((r) => live.out.end(r));
    const end: CommandJobEnd = live.stopping ?? 'exited';
    let done: CommandJob = { ...job, endedAt: new Date().toISOString(), end, exitCode: code };
    // what changed in the folder while it ran
    let changed = '';
    const after = live.before.skipped ? undefined : await snapshotFolder(job.cwd);
    if (live.before.skipped) changed = notTrackedLine(live.before.skipped, 'before');
    else if (after?.skipped) changed = notTrackedLine(after.skipped, 'after');
    else if (after) {
      const changes = folderChanges(live.before, after);
      const cards = await changeCards(changes);
      if (cards.length > 0) {
        done = { ...done, files: cards };
        this.#host.fileCards(done, cards);
      }
      changed = changeLine(changes, (abs) => {
        const rel = relative(job.cwd, abs);
        return rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
      });
    }
    this.#jobs.set(id, done);
    this.#changes.set(id, changed);
    if (live.dropped) this.#dropped.set(id, live.dropped);
    this.#live.delete(id);
    const reading = live.waiters.size > 0;
    for (const w of [...live.waiters]) w();
    this.#save();
    this.#host.changed(done);
    const secs = ((performance.now() - live.t0) / 1000).toFixed(1);
    // the model hears that it ended, unless it was waiting for it or stopped it itself
    if (!reading && end !== 'agent') {
      this.#host.ended(done, `[Background command ${id} ${endWords(done)} after ${secs} s. Read the rest of its output with command_output.]${changed ? `\n${changed}` : ''}`);
    }
  }

  #newId(): string {
    let id: string;
    do id = `cmd${++this.#seq}`;
    while (this.#jobs.has(id));
    return id;
  }

  get #file(): string {
    return join(this.#dir, 'jobs.json');
  }

  #load(): void {
    let records: CommandJob[] = [];
    try {
      records = JSON.parse(readFileSync(this.#file, 'utf8')) as typeof records;
    } catch {
      return;
    }
    let crashed = false;
    for (const r of Array.isArray(records) ? records : []) {
      if (!r || typeof r.id !== 'string') continue;
      if (!r.end) {
        // the app did not get to stop it: stop it now if it is still the process we started
        if (r.pid && sameProcess(r.pid, r.startedAt)) killTree(r.pid, true);
        r.end = 'app_crashed';
        r.endedAt = new Date().toISOString();
        r.exitCode = null;
        crashed = true;
      }
      this.#jobs.set(r.id, r);
      const n = Number(/^cmd(\d+)$/.exec(r.id)?.[1] ?? 0);
      if (n > this.#seq) this.#seq = n;
    }
    if (crashed) this.#save();
  }

  #save(): void {
    let all = [...this.#jobs.values()];
    if (all.length > MAX_RECORDS) {
      const old = all.filter((j) => j.end).slice(0, all.length - MAX_RECORDS);
      for (const j of old) {
        this.#jobs.delete(j.id);
        rmSync(j.outputPath, { force: true });
      }
      all = [...this.#jobs.values()];
    }
    try {
      mkdirSync(this.#dir, { recursive: true });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(all), 'utf8');
      renameSync(tmp, this.#file);
    } catch {
      // the records are only for showing how they ended after a restart
    }
  }
}

/** How a job ended, for the model. */
export function endWords(job: CommandJob): string {
  switch (job.end) {
    case undefined:
      return 'is still running';
    case 'exited':
      return `exited with code ${job.exitCode ?? 'unknown'}`;
    case 'agent':
      return 'was stopped with stop_command';
    case 'user':
      return 'was stopped by the user';
    case 'conversation_deleted':
      return 'was stopped: the conversation was deleted';
    case 'sub_agent_done':
      return 'was stopped: the sub-agent that started it finished';
    case 'app_quit':
      return 'was stopped: the app quit';
    case 'app_crashed':
      return 'was stopped: the app closed unexpectedly';
    case 'failed':
      return 'could not start';
  }
}

/** Kill a process and everything it started (`group`: it leads its own process group, outside Windows). */
export function killTree(pid: number | undefined, group = false): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(group ? -pid : pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Whether `pid` is still the process that started at `startedAt` (within a few seconds). */
function sameProcess(pid: number, startedAt: string): boolean {
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return false;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10_000,
      });
      const at = Date.parse(r.stdout.trim());
      return r.status === 0 && Number.isFinite(at) && Math.abs(at - t) < 5000;
    }
    const r = spawnSync('ps', ['-o', 'etimes=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    const secs = Number(r.stdout.trim());
    return r.status === 0 && Number.isFinite(secs) && Math.abs(Date.now() - secs * 1000 - t) < 5000;
  } catch {
    return false;
  }
}

/** Head and tail of a long text, the whole in the log. */
function clip(text: string, max: number, path: string, dropped: number): string {
  if (text.length <= max && !dropped) return text;
  if (text.length <= max) return `${text}\n[${dropped} more bytes were not kept]`;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…[${text.length - 2 * half} characters omitted]…\n${text.slice(-half)}\n[whole output in ${path}; use read_file with offset/limit or grep to inspect it]`;
}

export interface CommandJobToolsOptions {
  /** Characters returned per read before the middle is left out. Default 30 000. */
  maxOutputChars?: number;
  /** The longest command_output waits. Default 600 s. */
  maxWaitMs?: number;
}

/** command_output and stop_command, for the jobs run_command starts with run_in_background. */
export function createCommandJobTools(jobs: CommandJobs, opts: CommandJobToolsOptions = {}): Tool[] {
  const maxChars = opts.maxOutputChars ?? 30_000;
  const maxWait = opts.maxWaitMs ?? 600_000;
  const own = (id: unknown, sessionId: string): CommandJob | undefined => {
    const job = typeof id === 'string' ? jobs.get(id.trim()) : undefined;
    return job && job.sessionId === sessionId ? job : undefined;
  };
  const unknown = (id: unknown, sessionId: string) => {
    const mine = jobs.list(sessionId).map((j) => j.id);
    return { content: `no background command ${String(id)} in this conversation${mine.length ? ` (its background commands: ${mine.slice(-10).join(', ')})` : ''}`, isError: true };
  };
  return [
    {
      category: 'command',
      readOnly: true,
      spec: {
        name: 'command_output',
        description:
          'Read what a background command (run_command with run_in_background) wrote since the last read, and whether it is still running. ' +
          `With wait_seconds, first wait until it ends or that many seconds pass (max ${maxWait / 1000}).`,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The id run_command returned.' },
            wait_seconds: { type: 'integer' },
          },
          required: ['id'],
        },
      },
      async execute(input, ctx) {
        if (!own(input.id, ctx.sessionId)) return unknown(input.id, ctx.sessionId);
        const id = String(input.id).trim();
        const waitMs = Math.min(maxWait, Math.max(0, Number(input.wait_seconds ?? 0) * 1000 || 0));
        const { job, text, dropped } = await jobs.read(id, waitMs, ctx.signal);
        const out = text.replace(/\r\n/g, '\n');
        const status = job.end ? endWords(job) : 'is still running';
        const changed = job.end ? jobs.changeLineOf(id) : '';
        return {
          content: `${id} ${status}\n${out ? clip(out, maxChars, job.outputPath, job.end ? dropped : 0) : '(no new output)'}${changed ? `\n${changed}` : ''}`,
          ...(job.end === 'exited' && job.exitCode !== 0 ? { isError: true } : {}),
        };
      },
    },
    {
      category: 'command',
      spec: {
        name: 'stop_command',
        description: 'Stop a background command (run_command with run_in_background) and every process it started.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'The id run_command returned.' } },
          required: ['id'],
        },
      },
      async execute(input, ctx) {
        if (!own(input.id, ctx.sessionId)) return unknown(input.id, ctx.sessionId);
        const id = String(input.id).trim();
        const before = jobs.get(id)!;
        if (before.end) return { content: `${id} ${endWords(before)}` };
        const job = await jobs.stop(id, 'agent');
        return { content: job.end ? `${id} stopped` : `${id} was told to stop but has not ended yet`, ...(job.end ? {} : { isError: true }) };
      },
    },
  ];
}
