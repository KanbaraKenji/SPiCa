// get_diagnostics: the errors and type errors of a file or a whole project, from the checkers the project has
// installed itself, as one list (file:line:col severity message [code] (checker)).
//
// Spica has no editor, so no language server is running (Claude Code's LSP tool and Copilot's problems read one). It
// runs, once per call, what the project would run itself:
// - TypeScript / JavaScript: the project's typescript (tsc --noEmit -p <nearest tsconfig.json>) and eslint (when it has
//   a configuration), with the app's Node;
// - Python: pyright (its own or the npm one), else mypy, in the project's .venv / venv, else the Python run_command
//   finds; and ruff when it is there.
// Checkers are looked for from the target up to the root of the repository the working folder is in (a repository's
// checkers sit at its root while one works in a sub-folder), never above it; outside a repository only up to the
// working folder. The result names each checker used and where it was found. A file a checker left out (its
// configuration ignores it: eslint's "File ignored", a file no tsconfig includes, pyright / mypy / ruff excluding it)
// is said to be so, never counted as clean: such files, and all files when there is no checker, are only checked to
// parse (node --check, Python's compile), and the result says so. It installs nothing. Like run_command: in the
// working folder, the same environment, a timeout, killed on interrupt. It changes no files, so it is not confirmed.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Tool } from './types.ts';
import { bundledNode, findOnPath, type BundledNode, type Runtimes } from '../runtimes.ts';
import { commandEnv } from './command-tool.ts';
import { killTree } from './background-commands.ts';
import { IGNORED_DIRS } from './file-changes.ts';

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  code?: string;
  source: string;
}

export interface DiagnosticsToolOptions {
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  nodeShimDir?: string;
  nodeLibsDir?: string;
  runtimes?(): Runtimes | undefined;
  node?: BundledNode;
  /** Diagnostics listed before the rest is only counted. Default 200. */
  maxShown?: number;
}

const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx']);
const TS_EXT = new Set(['.ts', '.mts', '.cts', '.tsx']);
const PY_EXT = new Set(['.py', '.pyi']);
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'];
const MAX_FILES = 2000;
/** JavaScript files checked one by one with node --check when there is no checker. */
const MAX_SYNTAX_FILES = 300;

/** What `test` finds in the first folder from `start` up, not above `stop` (when given). */
function findUp(start: string, test: (dir: string) => string | undefined, stop?: string): string | undefined {
  let dir = start;
  for (;;) {
    const hit = test(dir);
    if (hit) return hit;
    if (stop && samePath(dir, stop)) return undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

const samePath = (a: string, b: string) => {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/** Whether `p` is `root` or inside it. */
const within = (p: string, root: string) => {
  const r = relative(root, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

const exists = (p: string) => existsSync(p);

/** The source files under a folder by language (skipping node_modules, .git, .venv and the like), at most MAX_FILES. */
function filesUnder(root: string): { js: string[]; ts: string[]; py: string[] } {
  const out = { js: [] as string[], ts: [] as string[], py: [] as string[] };
  let n = 0;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (n >= MAX_FILES) return;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(name) && name !== 'dist' && name !== 'build' && !name.startsWith('.')) walk(p);
        continue;
      }
      const ext = extname(name).toLowerCase();
      if (JS_EXT.has(ext)) out.js.push(p);
      else if (TS_EXT.has(ext) && !name.endsWith('.d.ts')) out.ts.push(p);
      else if (PY_EXT.has(ext)) out.py.push(p);
      else continue;
      n++;
    }
  };
  walk(root);
  return out;
}

interface Ran {
  code: number | null;
  out: string;
  timedOut: boolean;
  aborted: boolean;
  error?: string;
}

function runProcess(file: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number, signal: AbortSignal, input?: string): Promise<Ran> {
  return new Promise((resolveRun) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    const take = (d: Buffer) => {
      if (size < 20_000_000) chunks.push(d);
      size += d.length;
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    if (input !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input, 'utf8');
    }
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const done = (r: Omit<Ran, 'out' | 'timedOut' | 'aborted'>) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolveRun({ ...r, out: Buffer.concat(chunks).toString('utf8'), timedOut, aborted });
    };
    child.once('error', (e) => done({ code: null, error: e.message }));
    child.once('close', (code) => done({ code }));
  });
}

// --- what each checker says ---------------------------------------------------------------------------------------

/** tsc --pretty false: `file(line,col): error TS2322: message` (more lines of a message start with spaces). */
export function parseTsc(out: string, cwd: string): Diagnostic[] {
  const list: Diagnostic[] = [];
  for (const line of out.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line);
    if (m) list.push({ file: resolve(cwd, m[1]!), line: Number(m[2]), column: Number(m[3]), severity: m[4] === 'warning' ? 'warning' : 'error', code: m[5]!, message: m[6]!, source: 'tsc' });
    else if (/^\s+\S/.test(line) && list.length) list[list.length - 1]!.message += `\n${line.trim()}`;
  }
  return list;
}

/** eslint --format json. */
export function parseEslint(out: string): Diagnostic[] {
  const start = out.indexOf('[');
  if (start < 0) return [];
  let files: { filePath: string; messages: { line?: number; column?: number; severity: number; message: string; ruleId?: string | null }[] }[];
  try {
    files = JSON.parse(out.slice(start)) as typeof files;
  } catch {
    return [];
  }
  return files.flatMap((f) =>
    f.messages.filter((m) => !IGNORED_MESSAGE.test(m.message)).map((m) => ({ file: f.filePath, line: m.line ?? 1, column: m.column ?? 1, severity: m.severity === 2 ? ('error' as const) : ('warning' as const), message: m.message, ...(m.ruleId ? { code: m.ruleId } : {}), source: 'eslint' })),
  );
}

/** pyright --outputjson (lines and characters from 0). */
export function parsePyright(out: string): Diagnostic[] {
  const start = out.indexOf('{');
  if (start < 0) return [];
  let r: { generalDiagnostics?: { file: string; severity: string; message: string; rule?: string; range?: { start: { line: number; character: number } } }[] };
  try {
    r = JSON.parse(out.slice(start)) as typeof r;
  } catch {
    return [];
  }
  return (r.generalDiagnostics ?? [])
    .filter((d) => d.severity === 'error' || d.severity === 'warning')
    .map((d) => ({ file: d.file, line: (d.range?.start.line ?? 0) + 1, column: (d.range?.start.character ?? 0) + 1, severity: d.severity === 'error' ? ('error' as const) : ('warning' as const), message: d.message, ...(d.rule ? { code: d.rule } : {}), source: 'pyright' }));
}

/** mypy --show-column-numbers: `file:line:col: error: message  [code]`. */
export function parseMypy(out: string, cwd: string): Diagnostic[] {
  const list: Diagnostic[] = [];
  for (const line of out.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^(.+?):(\d+):(?:(\d+):)? (error|warning): (.*?)(?:\s+\[([\w-]+)\])?$/.exec(line);
    if (m) list.push({ file: resolve(cwd, m[1]!), line: Number(m[2]), column: Number(m[3] ?? 1), severity: m[4] === 'warning' ? 'warning' : 'error', message: m[5]!, ...(m[6] ? { code: m[6] } : {}), source: 'mypy' });
  }
  return list;
}

/** ruff check --output-format json: lint findings are warnings, a file that does not parse an error. */
export function parseRuff(out: string): Diagnostic[] {
  const start = out.indexOf('[');
  if (start < 0) return [];
  let list: { filename: string; code: string | null; message: string; location: { row: number; column: number } }[];
  try {
    list = JSON.parse(out.slice(start)) as typeof list;
  } catch {
    return [];
  }
  return list.map((d) => ({
    file: d.filename,
    line: d.location.row,
    column: d.location.column,
    severity: !d.code || d.code === 'E999' || /^SyntaxError/i.test(d.message) ? ('error' as const) : ('warning' as const),
    message: d.message,
    ...(d.code ? { code: d.code } : {}),
    source: 'ruff',
  }));
}

// The syntax-only checks when a project has no checker: Python compiles each file, failures as JSON lines; JavaScript
// is `node --check` a file at a time (it knows modules from scripts as Node does).
const PY_SYNTAX = [
  'import json, sys',
  'for f in json.load(sys.stdin):',
  '    try:',
  "        compile(open(f, encoding='utf-8', errors='replace').read(), f, 'exec')",
  '    except SyntaxError as e:',
  "        print(json.dumps({'file': f, 'line': e.lineno or 1, 'column': e.offset or 1, 'message': 'SyntaxError: ' + str(e.msg)}))",
].join('\n');

/** node --check's report of a file that does not parse: `file:line`, the line, a caret, then `SyntaxError: …`. */
export function parseNodeCheck(out: string, file: string): Diagnostic | undefined {
  const lines = out.split(/\r?\n/);
  const message = lines.find((l) => /^\w*Error: /.test(l));
  if (!message) return undefined;
  const at = /:(\d+)\s*$/.exec(lines[0] ?? '');
  const caret = lines.findIndex((l) => /^\s*\^/.test(l));
  return { file, line: at ? Number(at[1]) : 1, column: caret >= 0 ? lines[caret]!.indexOf('^') + 1 : 1, severity: 'error', message, source: 'syntax' };
}

function parseSyntax(out: string, source: string): Diagnostic[] {
  const list: Diagnostic[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      const d = JSON.parse(line) as { file: string; line?: number; column?: number; message: string };
      list.push({ file: d.file, line: d.line ?? 1, column: d.column ?? 1, severity: 'error', message: d.message, source });
    } catch {
      // not one of ours
    }
  }
  return list;
}

// --------------------------------------------------------------------------------------------------------------------

/** The root of the git repository a folder is in (the folder with .git, a folder or a worktree's file), or undefined. */
function repoRoot(dir: string): string | undefined {
  return findUp(dir, (d) => (exists(join(d, '.git')) ? d : undefined));
}

/** A path as a key that compares the same however it was written (tsc writes / on Windows, cases differ). */
const key = (p: string) => {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** The version in a package folder's package.json ('' when it cannot be read). */
function pkgVersion(dir: string): string {
  try {
    return String((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version ?? '');
  } catch {
    return '';
  }
}

/** tsc --listFiles: the files of the program, one absolute path a line among the diagnostics. */
export function tscListed(out: string): string[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && isAbsolute(l) && !/\(\d+,\d+\): /.test(l));
}

/** eslint --format json: the files it linted (a file its configuration ignores comes back with only that warning). */
export function eslintLinted(out: string): string[] {
  const start = out.indexOf('[');
  if (start < 0) return [];
  try {
    const files = JSON.parse(out.slice(start)) as { filePath: string; messages: { message: string }[] }[];
    return files.filter((f) => !f.messages.some((m) => IGNORED_MESSAGE.test(m.message))).map((f) => f.filePath);
  } catch {
    return [];
  }
}

/** eslint's warning for a file it was given but its configuration ignores. */
const IGNORED_MESSAGE = /^File ignored/i;

/** pyright --outputjson: how many files it analysed (undefined when it does not say). */
export function pyrightAnalyzed(out: string): number | undefined {
  const start = out.indexOf('{');
  if (start < 0) return undefined;
  try {
    const n = (JSON.parse(out.slice(start)) as { summary?: { filesAnalyzed?: number } }).summary?.filesAnalyzed;
    return typeof n === 'number' ? n : undefined;
  } catch {
    return undefined;
  }
}

export function createDiagnosticsTool(opts: DiagnosticsToolOptions = {}): Tool {
  const defTimeout = opts.defaultTimeoutMs ?? 120_000;
  const maxTimeout = opts.maxTimeoutMs ?? 600_000;
  const shimDir = opts.nodeShimDir ?? join(tmpdir(), 'spica', 'node-shim');
  const node = opts.node ?? bundledNode();
  const maxShown = opts.maxShown ?? 200;
  return {
    category: 'read',
    readOnly: true,
    spec: {
      name: 'get_diagnostics',
      description:
        "Get the current errors and type errors of a file or a whole project from the checkers the project has installed (looked for up to the root of the working folder's repository): " +
        'TypeScript / JavaScript with its tsc (nearest tsconfig.json) and eslint, Python with pyright or mypy and ruff (its .venv first). ' +
        'It says which checkers it used and where it found them; files a checker left out (its configuration ignores them) and files without a checker are only checked to parse, and it says so. ' +
        `Default timeout ${defTimeout / 1000} s, max ${maxTimeout / 1000} s.`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'A file or folder (default: the working folder).' },
          only_errors: { type: 'boolean', description: 'Leave out warnings.' },
          timeout_seconds: { type: 'integer' },
        },
      },
    },
    targetPath: (input) => (typeof input.path === 'string' ? input.path : undefined),
    async execute(input, ctx) {
      const asked = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '.';
      const target = isAbsolute(asked) ? asked : resolve(ctx.cwd, asked);
      let isFile: boolean;
      try {
        isFile = statSync(target).isFile();
      } catch {
        return { content: `${asked} does not exist`, isError: true };
      }
      const timeoutMs = Math.min(maxTimeout, Math.max(1000, Number(input.timeout_seconds ?? defTimeout / 1000) * 1000 || defTimeout));
      const folder = isFile ? dirname(target) : target;
      // Checkers are looked for from the target up to the root of the repository the working folder is in (the
      // folder with .git), not above it; outside a repository, up to the working folder. A target outside the working
      // folder: the same from the target.
      const base = within(folder, ctx.cwd) ? ctx.cwd : folder;
      const stop = repoRoot(base) ?? base;
      const files = isFile
        ? (() => {
            const ext = extname(target).toLowerCase();
            return { js: JS_EXT.has(ext) ? [target] : [], ts: TS_EXT.has(ext) ? [target] : [], py: PY_EXT.has(ext) ? [target] : [] };
          })()
        : filesUnder(target);
      const env = commandEnv(shimDir, opts.nodeLibsDir, opts.runtimes?.());
      const nodeEnv = node.asNode ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env;
      const diags: Diagnostic[] = [];
      const used: string[] = [];
      const notes: string[] = [];
      const shown = (p: string) => {
        const r = relative(ctx.cwd, p);
        return r === '' ? '.' : r.startsWith('..') && !within(p, stop) ? p : r;
      };
      const some = (list: string[]) => `${list.slice(0, 5).map(shown).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}`;
      const ran = (r: Ran) => !r.error && !r.timedOut && !r.aborted;
      const run = async (label: string, file: string, args: string[], cwd: string, envFor: Record<string, string>, stdin?: string) => {
        const r = await runProcess(file, args, cwd, envFor, timeoutMs, ctx.signal, stdin);
        if (r.error) notes.push(`${label} could not start: ${r.error}`);
        else if (r.timedOut) notes.push(`${label} timed out after ${timeoutMs / 1000} s`);
        else if (r.aborted) notes.push(`${label} was stopped`);
        return r;
      };
      const inTarget = (d: Diagnostic) => (isFile ? samePath(d.file, target) : true);
      const syntaxCheck = async (list: string[]) => {
        const some2 = list.slice(0, MAX_SYNTAX_FILES);
        let next = 0;
        const worker = async () => {
          while (next < some2.length && !ctx.signal.aborted) {
            const f = some2[next++]!;
            const r = await runProcess(node.exe, ['--check', f], folder, nodeEnv, timeoutMs, ctx.signal);
            const d = r.code === 0 ? undefined : parseNodeCheck(r.out, f);
            if (d) diags.push(d);
          }
        };
        await Promise.all(Array.from({ length: 6 }, worker));
        return list.length > some2.length ? ` (the first ${some2.length} of ${list.length})` : '';
      };

      // TypeScript / JavaScript
      if (files.ts.length || files.js.length) {
        const tsc = findUp(folder, (d) => (exists(join(d, 'node_modules', 'typescript', 'bin', 'tsc')) ? join(d, 'node_modules', 'typescript') : undefined), stop);
        const tsconfig = findUp(folder, (d) => (exists(join(d, 'tsconfig.json')) ? join(d, 'tsconfig.json') : undefined), stop);
        // what each checker looked at (when it ran), to tell the files it left out
        let tscSaw: Set<string> | undefined;
        let eslintSaw: Set<string> | undefined;
        if (tsc && tsconfig && (files.ts.length || isFile)) {
          const cwd = dirname(tsconfig);
          const r = await run('tsc', node.exe, [join(tsc, 'bin', 'tsc'), '--noEmit', '--pretty', 'false', '--listFiles', '-p', tsconfig], cwd, nodeEnv);
          if (ran(r)) {
            diags.push(...parseTsc(r.out, cwd).filter(inTarget));
            tscSaw = new Set(tscListed(r.out).map(key));
            used.push(`tsc ${pkgVersion(tsc)} from ${shown(tsc)} with ${shown(tsconfig)}`);
          }
        }
        const eslint = findUp(folder, (d) => (exists(join(d, 'node_modules', 'eslint', 'bin', 'eslint.js')) ? join(d, 'node_modules', 'eslint') : undefined), stop);
        const eslintConfig = eslint ? findUp(folder, (d) => ESLINT_CONFIGS.map((n) => join(d, n)).find(exists), stop) : undefined;
        if (eslint && eslintConfig) {
          const r = await run('eslint', node.exe, [join(eslint, 'bin', 'eslint.js'), '--format', 'json', target], dirname(eslintConfig), nodeEnv);
          if (ran(r)) {
            diags.push(...parseEslint(r.out).filter(inTarget));
            eslintSaw = new Set(eslintLinted(r.out).map(key));
            used.push(`eslint ${pkgVersion(eslint)} from ${shown(eslint)} with ${shown(eslintConfig)}`);
          }
        }
        const tsLeft = files.ts.filter((f) => !tscSaw?.has(key(f)));
        const jsLeft = files.js.filter((f) => !tscSaw?.has(key(f)) && !eslintSaw?.has(key(f)));
        if (!tscSaw && !eslintSaw) {
          if (files.js.length) notes.push(`JavaScript: the project has no typescript or eslint installed; only checked that ${files.js.length} file(s) parse${await syntaxCheck(files.js)}`);
          if (files.ts.length) notes.push(`TypeScript: the project has no typescript installed (node_modules/typescript) or no tsconfig.json; ${files.ts.length} .ts file(s) not checked: ${some(files.ts)}`);
        } else {
          if (jsLeft.length) {
            const by = [eslintSaw ? 'eslint (ignored by its configuration or outside what it lints)' : '', tscSaw ? `tsc (not included by ${shown(tsconfig!)})` : ''].filter(Boolean).join(' or ');
            const cut = await syntaxCheck(jsLeft);
            notes.push(`${jsLeft.length} JavaScript file(s) not checked by ${by}; only checked that they parse${cut}: ${some(jsLeft)}`);
          }
          if (tsLeft.length) notes.push(tscSaw ? `${tsLeft.length} .ts file(s) not checked by tsc (not included by ${shown(tsconfig!)}): ${some(tsLeft)}` : `TypeScript: no tsc with a tsconfig.json for these files; ${tsLeft.length} .ts file(s) not checked for type errors`);
        }
      }

      // Python
      if (files.py.length) {
        const venvBin = findUp(folder, (d) => {
          for (const v of ['.venv', 'venv', 'env']) {
            const bin = join(d, v, process.platform === 'win32' ? 'Scripts' : 'bin');
            if (exists(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'))) return bin;
          }
          return undefined;
        }, stop);
        const exe = (name: string) => (venvBin ? [join(venvBin, process.platform === 'win32' ? `${name}.exe` : name)].find(exists) : undefined) ?? findOnPath(name, env);
        const python = venvBin ? join(venvBin, process.platform === 'win32' ? 'python.exe' : 'python') : (findOnPath('python', env) ?? findOnPath('python3', env));
        const root = findUp(folder, (d) => ['pyproject.toml', 'setup.cfg', 'setup.py', 'pyrightconfig.json', 'mypy.ini'].map((n) => join(d, n)).find(exists), stop);
        const cwd = root ? dirname(root) : folder;
        const pyEnv = venvBin ? { ...env, PATH: `${venvBin}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? env.Path ?? ''}` } : env;
        // a checker that ran but left the files out (its configuration excludes them) is said so, not counted as clean
        const excluded: string[] = [];
        let typed = false;
        const pyright = exe('pyright');
        const npmPyright = findUp(folder, (d) => (exists(join(d, 'node_modules', 'pyright', 'index.js')) ? join(d, 'node_modules', 'pyright', 'index.js') : undefined), stop);
        if (pyright || npmPyright) {
          const r = pyright ? await run('pyright', pyright, ['--outputjson', target], cwd, pyEnv) : await run('pyright', node.exe, [npmPyright!, '--outputjson', target], cwd, { ...nodeEnv, ...(venvBin ? { PATH: pyEnv.PATH! } : {}) });
          if (ran(r)) {
            if (pyrightAnalyzed(r.out) === 0) excluded.push('pyright');
            else {
              diags.push(...parsePyright(r.out).filter(inTarget));
              used.push(`pyright from ${shown(pyright ?? dirname(npmPyright!))}`);
              typed = true;
            }
          }
        }
        if (!typed && python) {
          const mypy = exe('mypy') ? true : (await runProcess(python, ['-c', 'import mypy'], cwd, pyEnv, 20_000, ctx.signal)).code === 0;
          if (mypy) {
            const r = await run('mypy', python, ['-m', 'mypy', '--no-color-output', '--no-error-summary', '--show-column-numbers', '--hide-error-context', target], cwd, pyEnv);
            if (ran(r)) {
              if (/There are no \.py\[i\] files|No \.py\[i\] files|is excluded/i.test(r.out)) excluded.push('mypy');
              else {
                diags.push(...parseMypy(r.out, cwd).filter(inTarget));
                used.push(`mypy with ${shown(python)}`);
                typed = true;
              }
            }
          }
        }
        let linted = false;
        const ruff = exe('ruff');
        if (ruff) {
          const r = await run('ruff', ruff, ['check', '--output-format', 'json', '--no-fix', target], cwd, pyEnv);
          if (ran(r)) {
            if (/No Python files found/i.test(r.out)) excluded.push('ruff');
            else {
              diags.push(...parseRuff(r.out).filter(inTarget));
              used.push(`ruff from ${shown(ruff)}`);
              linted = true;
            }
          }
        }
        if (excluded.length) notes.push(`Python: not checked by ${excluded.join(', ')} (excluded by its configuration)`);
        if (!typed && !linted) {
          if (python) {
            const r = await run('python', python, ['-c', PY_SYNTAX], cwd, pyEnv, JSON.stringify(files.py));
            diags.push(...parseSyntax(r.out, 'syntax'));
            notes.push(`Python: ${excluded.length ? 'no checker looked at these files' : 'the project has no pyright, mypy or ruff installed'}; only checked that ${files.py.length} file(s) parse`);
          } else notes.push(`Python: there is no Python on this computer; ${files.py.length} .py file(s) not checked`);
        } else if (!typed) notes.push('Python: no pyright or mypy for these files; type errors not checked');
      }

      if (!files.js.length && !files.ts.length && !files.py.length) {
        return { content: `No TypeScript, JavaScript or Python files at ${asked}.` };
      }
      const listed = input.only_errors === true ? diags.filter((d) => d.severity === 'error') : diags;
      const errors = diags.filter((d) => d.severity === 'error').length;
      const warnings = diags.length - errors;
      const lines = listed.slice(0, maxShown).map((d) => `${shown(d.file)}:${d.line}:${d.column} ${d.severity} ${d.message}${d.code ? ` [${d.code}]` : ''} (${d.source})`);
      const head = `${errors} error(s), ${warnings} warning(s)`;
      const checkers = used.length ? `\nCheckers: ${used.join('; ')}` : '';
      const more = listed.length > maxShown ? `\n…and ${listed.length - maxShown} more` : '';
      const said = notes.length ? `\n${notes.map((n) => `[${n}]`).join('\n')}` : '';
      return { content: `${head}${checkers}${lines.length ? `\n${lines.join('\n')}` : ''}${more}${said}` };
    },
  };
}
