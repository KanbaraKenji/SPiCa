// run_javascript: run a piece of JavaScript with the app's own Node and get back what it printed and the value of
// its last expression, without writing a file first.
//
// Closest to Claude in Chrome's javascript_tool (top-level await, the last expression is the result, no `return`)
// and Codex's retired js_repl (a Node kernel; `await import()` for modules), but each call is a new Node process
// that keeps nothing, as run_command. It is held to run_command's rules: the same environment (the user's, without
// secret-looking variables; the app's libraries on NODE_PATH), the working folder, the same timeouts, killed with
// what it started on timeout or interrupt, files it changed become cards, confirmed like a command (irreversible).
// It can read and write files and use the network as a command can.
//
// The code goes to the process on stdin and is evaluated by Node's own REPL evaluator (what lets top-level await
// keep the last expression's value); the result comes back on a pipe of its own (fd 3), so what the code prints
// stays apart from it.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { Tool } from './types.ts';
import { bundledNode, type BundledNode, type Runtimes } from '../runtimes.ts';
import { commandEnv, folderChangeNote } from './command-tool.ts';
import { killTree } from './background-commands.ts';
import { snapshotFolder } from './file-changes.ts';

export interface JavaScriptToolOptions {
  spillDir?: string;
  maxOutputChars?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  nodeShimDir?: string;
  nodeLibsDir?: string;
  runtimes?(): Runtimes | undefined;
  /** The Node to run it with. Default: the app's own (runtimes.ts bundledNode). */
  node?: BundledNode;
}

const MAX_CAPTURE_BYTES = 20_000_000;

// Runs in the child: read the code from stdin, evaluate it as the REPL would, report on fd 3, then let the process
// end when what the code started is done (timers, servers keep it alive until the timeout).
const RUNNER = String.raw`
const repl = require('node:repl');
const util = require('node:util');
const fs = require('node:fs');
const { PassThrough } = require('node:stream');
const report = (o) => { try { fs.writeSync(3, JSON.stringify(o)); } catch {} };
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const code = Buffer.concat(chunks).toString('utf8');
  const input = new PassThrough();
  const r = repl.start({ input, output: new PassThrough(), terminal: false, useGlobal: true, prompt: '', ignoreUndefined: true });
  let done = false;
  const finish = (err, value) => {
    if (done) return;
    done = true;
    if (err) {
      let message = err && err.stack ? String(err.stack) : String(err);
      if (err && err.name === 'SyntaxError' && !err.message) {
        try { new (require('node:vm').Script)('(async () => {\n' + code + '\n})'); } catch (e) { message = 'SyntaxError: ' + e.message; }
      }
      // the REPL's own frames say nothing about the code
      message = message.split('\n').filter((l) => !/node:(repl|internal|domain|events)|REPLServer|\(node:|\[eval\]/.test(l)).join('\n');
      report({ error: message });
      process.exitCode = 1;
    } else {
      report(value === undefined ? {} : { value: util.inspect(value, { depth: 4, maxArrayLength: 200, maxStringLength: 20000, breakLength: 120 }) });
    }
    try { fs.closeSync(3); } catch {}
    r.close();
    input.end();
  };
  // errors thrown by the code (also after an await) reach the REPL's domain, not the callback
  if (r._domain) {
    r._domain.removeAllListeners('error');
    r._domain.on('error', (e) => { if (done) { console.error('Uncaught', e); process.exitCode = 1; } else finish(e); });
  } else process.on('uncaughtException', (e) => { if (done) { console.error('Uncaught', e); process.exitCode = 1; } else finish(e); });
  r.eval(code, r.context, 'snippet.js', finish);
});
`;

export function createJavaScriptTool(opts: JavaScriptToolOptions = {}): Tool {
  const spillDir = opts.spillDir ?? join(tmpdir(), 'spica', 'command-output');
  const maxChars = opts.maxOutputChars ?? 30_000;
  const defTimeout = opts.defaultTimeoutMs ?? 120_000;
  const maxTimeout = opts.maxTimeoutMs ?? 600_000;
  const shimDir = opts.nodeShimDir ?? join(tmpdir(), 'spica', 'node-shim');
  const node = opts.node ?? bundledNode();
  return {
    category: 'command',
    summaryParam: 'description',
    spec: {
      name: 'run_javascript',
      description:
        `Run JavaScript with Node.js ${node.version} in the working folder and return what it printed and the value of its last expression. ` +
        'Top-level await works; require() works (node: modules, the libraries on NODE_PATH, a node_modules of the folder), load ES modules with await import(). ' +
        `Each call is a new process: nothing is kept between calls. Default timeout ${defTimeout / 1000} s, max ${maxTimeout / 1000} s.`,
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          timeout_seconds: { type: 'integer' },
          cwd: { type: 'string', description: 'Folder to run in (default: the working folder).' },
          description: {
            type: 'string',
            description: "What this code does for the task, in one short sentence in the user's language (shown to the user instead of the code).",
          },
        },
        required: ['code'],
      },
    },
    // what it does is as open as a command: confirmed as run_command is
    irreversible: true,
    async execute(input, ctx) {
      const code = String(input.code ?? '');
      if (code.trim() === '') return { content: 'code is empty', isError: true };
      const timeoutMs = Math.min(maxTimeout, Math.max(1000, Number(input.timeout_seconds ?? defTimeout / 1000) * 1000 || defTimeout));
      const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? (isAbsolute(input.cwd) ? input.cwd : resolve(ctx.cwd, input.cwd)) : ctx.cwd;
      const env = commandEnv(shimDir, opts.nodeLibsDir, opts.runtimes?.());
      if (node.asNode) env.ELECTRON_RUN_AS_NODE = '1';
      const before = await snapshotFolder(cwd);
      const t0 = performance.now();
      const child = spawn(node.exe, ['-e', RUNNER], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env });
      const chunks: Buffer[] = [];
      let captured = 0;
      let dropped = 0;
      const take = (d: Buffer) => {
        if (captured + d.length <= MAX_CAPTURE_BYTES) {
          chunks.push(d);
          captured += d.length;
        } else dropped += d.length;
      };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      const resultChunks: Buffer[] = [];
      (child.stdio[3] as Readable | null)?.on('data', (d: Buffer) => resultChunks.push(d));
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(code, 'utf8');
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
      if (exit.error) return { content: `Could not start Node.js: ${exit.error.message}`, isError: true };

      let result: { value?: string; error?: string } | undefined;
      try {
        const raw = Buffer.concat(resultChunks).toString('utf8');
        if (raw) result = JSON.parse(raw) as typeof result;
      } catch {
        // cut off by the timeout
      }
      let printed = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n');
      let note = '';
      if (printed.length > maxChars || dropped > 0) {
        await mkdir(spillDir, { recursive: true });
        const path = join(spillDir, `${ctx.callId.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}.txt`);
        await writeFile(path, printed, 'utf8');
        const half = Math.floor(maxChars / 2);
        printed = `${printed.slice(0, half)}\n…[${printed.length - 2 * half} characters omitted]…\n${printed.slice(-half)}`;
        note = `\n[full output (${captured} bytes${dropped ? `, ${dropped} more bytes not captured` : ''}) saved to ${path}; use read_file with offset/limit or grep to inspect it]`;
      }
      let value = result?.value;
      if (value !== undefined && value.length > maxChars) value = `${value.slice(0, maxChars)}…[${value.length - maxChars} characters omitted]`;
      const status =
        stopped === 'timeout'
          ? `timed out after ${timeoutMs / 1000} s (process killed)`
          : stopped === 'aborted'
            ? 'stopped: the user interrupted it (process killed)'
            : `exit code ${exit.code ?? 'unknown'}`;
      const parts = [`${status}, ${secs} s`];
      if (printed) parts.push(`Output:\n${printed}${note}`);
      if (result?.error) parts.push(`Error:\n${result.error}`);
      else if (value !== undefined) parts.push(`Result:\n${value}`);
      else if (!printed) parts.push('(no output)');
      const changed = await folderChangeNote(before, cwd, ctx);
      return { content: parts.join('\n') + changed, isError: stopped !== undefined || exit.code !== 0 || !!result?.error };
    },
  };
}
