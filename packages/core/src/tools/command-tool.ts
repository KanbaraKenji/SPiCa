// run_command: PowerShell on Windows (sh elsewhere), never opens a console
// window, has a timeout, is killed with its child processes on abort, and
// spills long output to a file. With run_in_background it returns at once and
// runs on (background-commands.ts).
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Tool, ToolContext } from './types.ts';
import { changeCards, changeLine, folderChanges, notTrackedLine, snapshotFolder, type FolderSnapshot } from './file-changes.ts';
import { childEnv } from '../util.ts';
import { withAppPython, withNode, withNodeLibs, type Runtimes } from '../runtimes.ts';
import { killTree, type CommandJobs } from './background-commands.ts';

export interface CommandToolOptions {
  /** Default: powershell on Windows, sh elsewhere. */
  shell?: 'powershell' | 'sh';
  /** Folder for full outputs that were too long to return. */
  spillDir?: string;
  /** Characters returned to the model before spilling (head + tail). Default 30 000. */
  maxOutputChars?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  /** Where the `node` stand-in goes when the command's PATH has no node (runtimes.ts). Default: a temp folder. */
  nodeShimDir?: string;
  /** The libraries the app carries for scripts (<dir>/<name>), last on NODE_PATH (runtimes.ts). */
  nodeLibsDir?: string;
  /** What the computer can run now (the app's Python goes first on PATH when the computer has none; runtimes.ts). */
  runtimes?(): Runtimes | undefined;
  /** Where commands run with run_in_background are kept; without it there is no run_in_background. */
  jobs?: CommandJobs;
}

const MAX_CAPTURE_BYTES = 20_000_000;

export function createRunCommandTool(opts: CommandToolOptions = {}): Tool {
  const shell = opts.shell ?? (process.platform === 'win32' ? 'powershell' : 'sh');
  const spillDir = opts.spillDir ?? join(tmpdir(), 'spica', 'command-output');
  const maxChars = opts.maxOutputChars ?? 30_000;
  const defTimeout = opts.defaultTimeoutMs ?? 120_000;
  const maxTimeout = opts.maxTimeoutMs ?? 600_000;
  const shimDir = opts.nodeShimDir ?? join(tmpdir(), 'spica', 'node-shim');
  return {
    category: 'command',
    summaryParam: 'description',
    spec: {
      name: 'run_command',
      description:
        `Run a ${shell === 'powershell' ? 'Windows PowerShell' : 'POSIX shell'} command in the working folder and return its exit code and output ` +
        `(stdout and stderr together). Default timeout ${defTimeout / 1000} s, max ${maxTimeout / 1000} s. ` +
        'Not interactive: commands that wait for input will time out. Long output is saved to a file and summarized.' +
        (opts.jobs
          ? ' With run_in_background it returns an id at once and the command runs on with no timeout (servers, watchers, long builds): ' +
            'read its output with command_output, stop it with stop_command; you are told when it ends.'
          : ''),
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_seconds: { type: 'integer' },
          cwd: { type: 'string', description: 'Folder to run in (default: the working folder).' },
          ...(opts.jobs ? { run_in_background: { type: 'boolean' } } : {}),
          description: {
            type: 'string',
            description: "What this command does for the task, in one short sentence in the user's language (shown to the user instead of the command).",
          },
        },
        required: ['command'],
      },
    },
    // Commands can do anything (send mail, change external systems): confirm by default.
    irreversible: true,
    async execute(input, ctx) {
      const command = String(input.command ?? '');
      if (command.trim() === '') return { content: 'command is empty', isError: true };
      const timeoutMs = Math.min(maxTimeout, Math.max(1000, Number(input.timeout_seconds ?? defTimeout / 1000) * 1000 || defTimeout));
      const cwd = typeof input.cwd === 'string' ? (isAbsolute(input.cwd) ? input.cwd : resolve(ctx.cwd, input.cwd)) : ctx.cwd;
      const [file, args] = shellArgs(shell, command);
      // The user's environment, minus model keys and other secret-looking variables; `node` always works (the
      // computer's own first, else the app's), and scripts can require the app's libraries (runtimes.ts).
      const env = commandEnv(shimDir, opts.nodeLibsDir, opts.runtimes?.());
      if (input.run_in_background === true && opts.jobs) {
        const said = typeof input.description === 'string' ? input.description.trim().slice(0, 200) : '';
        try {
          const job = await opts.jobs.start({ sessionId: ctx.sessionId, callId: ctx.callId, command, ...(said ? { description: said } : {}), cwd, file, args, env });
          return { content: `running in the background as ${job.id}; read its output with command_output, stop it with stop_command` };
        } catch (e) {
          return { content: (e as Error).message, isError: true };
        }
      }
      // what changes in the folder while it runs becomes file cards (not when the folder is too big to walk quickly)
      const before = await snapshotFolder(cwd);
      const t0 = performance.now();
      const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
      const chunks: Buffer[] = [];
      let captured = 0;
      let dropped = 0;
      const take = (d: Buffer) => {
        if (captured + d.length <= MAX_CAPTURE_BYTES) {
          chunks.push(d);
          captured += d.length;
        } else dropped += d.length;
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      let stopped: 'timeout' | 'aborted' | undefined;
      const stop = (why: 'timeout' | 'aborted') => {
        if (stopped || child.exitCode !== null) return;
        stopped = why;
        killTree(child.pid);
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const onAbort = () => stop('aborted');
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      const exit = await new Promise<{ code: number | null; error?: Error }>((r) => {
        child.once('error', (error) => r({ code: null, error }));
        child.once('close', (code) => r({ code }));
      });
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (exit.error) return { content: `Could not start ${file}: ${exit.error.message}`, isError: true };

      let output = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n');
      let note = '';
      if (output.length > maxChars || dropped > 0) {
        await mkdir(spillDir, { recursive: true });
        const path = join(spillDir, `${ctx.callId.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}.txt`);
        await writeFile(path, output, 'utf8');
        const half = Math.floor(maxChars / 2);
        output = `${output.slice(0, half)}\n…[${output.length - 2 * half} characters omitted]…\n${output.slice(-half)}`;
        note = `\n[full output (${captured} bytes${dropped ? `, ${dropped} more bytes not captured` : ''}) saved to ${path}; use read_file with offset/limit or grep to inspect it]`;
      }
      const status =
        stopped === 'timeout'
          ? `timed out after ${timeoutMs / 1000} s (process killed)`
          : stopped === 'aborted'
            ? 'stopped: the user interrupted it (process killed)'
            : `exit code ${exit.code ?? 'unknown'}`;
      const changed = await folderChangeNote(before, cwd, ctx);
      return {
        content: `${status}, ${secs} s\n${output || '(no output)'}${note}${changed}`,
        isError: stopped !== undefined || exit.code !== 0,
      };
    },
  };
}

/** What changed in the folder since `before`: file cards on the call, and a line for the model ('' when nothing did). */
export async function folderChangeNote(before: FolderSnapshot, cwd: string, ctx: ToolContext): Promise<string> {
  if (before.skipped) return `
${notTrackedLine(before.skipped, 'before')}`;
  const after = await snapshotFolder(cwd);
  if (after.skipped) return `
${notTrackedLine(after.skipped, 'after')}`;
  const changes = folderChanges(before, after);
  const cards = await changeCards(changes);
  if (cards.length > 0) ctx.emit({ type: 'file.card', callId: ctx.callId, file: cards[0]!, files: cards });
  const line = changeLine(changes, (abs) => {
    const rel = relative(cwd, abs);
    return rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
  });
  return line ? `
${line}` : '';
}

/** A command's environment (run_command, run_javascript): the user's, without secret-looking variables, with `node`, the app's libraries and Python. */
export function commandEnv(shimDir: string, nodeLibsDir: string | undefined, runtimes: Runtimes | undefined): Record<string, string> {
  return withAppPython(withNodeLibs(withNode(childEnv('all'), shimDir).env, nodeLibsDir), runtimes);
}

function shellArgs(shell: 'powershell' | 'sh', command: string): [string, string[]] {
  if (shell === 'sh') return ['/bin/sh', ['-c', command]];
  // UTF-8 output, no progress bars, and the native exit code passed through.
  const script =
    "$ProgressPreference = 'SilentlyContinue'\n" +
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' +
    '$OutputEncoding = [System.Text.Encoding]::UTF8\n' +
    '$global:LASTEXITCODE = 0\n' +
    `${command}\n` +
    'if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }\n' +
    'exit $LASTEXITCODE\n';
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]];
}

export const runCommandTool = createRunCommandTool();
