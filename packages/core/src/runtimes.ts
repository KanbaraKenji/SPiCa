// What run_command can run on this computer, and the app's own Node for when the computer has none.
//
// The core runs inside the app's Electron (the backend process) or under Node (tests, scripts). Either way
// `process.execPath` with ELECTRON_RUN_AS_NODE=1 is a Node.js: plugin servers already run on it. run_command
// gets `node` from it when the command's PATH has no node: a small node.cmd (sh script elsewhere) at the END of
// PATH, so a Node the user installed always comes first and behaves as before; the app's only fills the gap.
//
// The model is told, once per conversation (it is part of the system prompt), which runtimes there are: Node
// (always), Python (if any, which version) and PowerShell (Windows), as facts.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The Node the app carries: its executable, and whether it needs ELECTRON_RUN_AS_NODE=1 to act as Node. */
export interface BundledNode {
  exe: string;
  asNode: boolean;
  /** Its Node.js version (without the v). */
  version: string;
}

/** The app's own Node: this process's executable. */
export function bundledNode(): BundledNode {
  return { exe: process.execPath, asNode: Boolean(process.versions.electron), version: process.versions.node };
}

/** The value of PATH in an environment (Windows spells it Path; names ignore case there). */
export function pathOf(env: Record<string, string | undefined>): { key: string; value: string } {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { key, value: env[key] ?? '' };
}

/** The first `name` program on a PATH (Windows: with the PATHEXT endings), or undefined. */
export function findOnPath(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of pathOf(env).value.split(delimiter)) {
    if (!dir.trim()) continue;
    for (const ext of exts) {
      const p = join(dir.replace(/^"|"$/g, ''), name + ext.toLowerCase());
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/**
 * Write the `node` stand-in into `dir` (node.cmd on Windows, a node script elsewhere), pointing at the app's
 * Node. Written only when missing or different. Returns the folder to put on PATH.
 */
export function writeNodeShim(dir: string, node: BundledNode = bundledNode()): string {
  mkdirSync(dir, { recursive: true });
  const win = process.platform === 'win32';
  const file = join(dir, win ? 'node.cmd' : 'node');
  const text = win
    ? `@echo off\r\n${node.asNode ? 'set ELECTRON_RUN_AS_NODE=1\r\n' : ''}"${node.exe}" %*\r\n`
    : `#!/bin/sh\n${node.asNode ? 'ELECTRON_RUN_AS_NODE=1 exec' : 'exec'} "${node.exe}" "$@"\n`;
  const old = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (old !== text) {
    writeFileSync(file, text, 'utf8');
    if (!win) chmodSync(file, 0o755);
  }
  return dir;
}

/**
 * A command's environment with `node` sure to work: unchanged when its PATH finds one, else the stand-in's folder
 * appended to PATH. `bundled` says which happened.
 */
export function withNode(env: Record<string, string>, shimDir: string, node: BundledNode = bundledNode()): { env: Record<string, string>; bundled: boolean } {
  if (findOnPath('node', env)) return { env, bundled: false };
  const dir = writeNodeShim(shimDir, node);
  const { key, value } = pathOf(env);
  return { env: { ...env, [key]: value ? `${value}${delimiter}${dir}` : dir }, bundled: true };
}

/** The runtimes the model is told about. */
export interface Runtimes {
  node: { version: string; source: 'system' | 'bundled' };
  /** undefined: none on PATH (a Windows Store stand-in that only offers to install it does not count). */
  python?: { version: string; command: string };
  /** Windows PowerShell / PowerShell version (Windows). */
  powershell?: string;
}

function run(file: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; out: string }> {
  // a .cmd / .bat (pyenv-win, nvm shims) runs through cmd.exe: Node will not start one directly
  const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  const [cmd, argv] = batch ? ['cmd.exe', ['/d', '/s', '/c', `"${file}" ${args.join(' ')}`]] : [file, args];
  return new Promise((resolve) => {
    execFile(cmd, argv, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', windowsVerbatimArguments: batch }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });
}

/** Ask the computer once (a few seconds at most). `env`: the environment commands run in. */
export async function probeRuntimes(env: Record<string, string | undefined> = process.env, node: BundledNode = bundledNode()): Promise<Runtimes> {
  const sysNode = findOnPath('node', env);
  const nodeVersion = sysNode ? /v?(\d+\.\d+\.\d+)/.exec((await run(sysNode, ['--version'])).out)?.[1] : undefined;
  const out: Runtimes = { node: nodeVersion ? { version: nodeVersion, source: 'system' } : { version: node.version, source: 'bundled' } };
  for (const cmd of process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    const exe = findOnPath(cmd, env);
    if (!exe) continue;
    const r = await run(exe, ['--version']);
    const v = r.ok ? /Python (\d+\.\d+(?:\.\d+)?)/.exec(r.out)?.[1] : undefined;
    if (v) {
      out.python = { version: v, command: cmd };
      break;
    }
  }
  if (process.platform === 'win32') {
    const r = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    const v = r.ok ? /(\d+\.\d+(?:\.\d+)*)/.exec(r.out)?.[1] : undefined;
    if (v) out.powershell = v;
  }
  return out;
}

/** The facts for the system prompt (English: it is for the model). */
export function runtimesLine(r: Runtimes): string {
  const node =
    r.node.source === 'bundled'
      ? `Node.js ${r.node.version} (the app's own; \`node\` works in run_command)`
      : `Node.js ${r.node.version} (installed on this computer)`;
  const python = r.python
    ? `Python ${r.python.version} (\`${r.python.command}\`; which packages it has depends on this computer)`
    : 'no Python (scripts for data work can be written for Node.js, which is always there)';
  const parts = [node, python, ...(r.powershell ? [`Windows PowerShell ${r.powershell}`] : [])];
  return `Runtimes on this computer for run_command: ${parts.join('; ')}.`;
}
