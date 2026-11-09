// run_command: PowerShell on Windows (sh elsewhere), never opens a console
// window, has a timeout, is killed with its child processes on abort, and
// spills long output to a file.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Tool } from './types.ts';

export interface CommandToolOptions {
  /** Default: powershell on Windows, sh elsewhere. */
  shell?: 'powershell' | 'sh';
  /** Folder for full outputs that were too long to return. */
  spillDir?: string;
  /** Characters returned to the model before spilling (head + tail). Default 30 000. */
  maxOutputChars?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
}

const MAX_CAPTURE_BYTES = 20_000_000;

export function createRunCommandTool(opts: CommandToolOptions = {}): Tool {
  const shell = opts.shell ?? (process.platform === 'win32' ? 'powershell' : 'sh');
  const spillDir = opts.spillDir ?? join(tmpdir(), 'spica', 'command-output');
  const maxChars = opts.maxOutputChars ?? 30_000;
  const defTimeout = opts.defaultTimeoutMs ?? 120_000;
  const maxTimeout = opts.maxTimeoutMs ?? 600_000;
  return {
    spec: {
      name: 'run_command',
      description:
        `Run a ${shell === 'powershell' ? 'Windows PowerShell' : 'POSIX shell'} command in the working folder and return its exit code and output ` +
        `(stdout and stderr together). Default timeout ${defTimeout / 1000} s, max ${maxTimeout / 1000} s. ` +
        'Not interactive: commands that wait for input will time out. Long output is saved to a file and summarized.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_seconds: { type: 'integer' },
          cwd: { type: 'string', description: 'Folder to run in (default: the working folder).' },
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
      const t0 = performance.now();
      const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
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
      return {
        content: `${status}, ${secs} s\n${output || '(no output)'}${note}`,
        isError: stopped !== undefined || exit.code !== 0,
      };
    },
  };
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

/** Kill a process and everything it started. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export const runCommandTool = createRunCommandTool();
