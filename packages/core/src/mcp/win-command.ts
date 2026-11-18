// Windows: a command such as `npx` is really `npx.cmd`. Node cannot start a .cmd or .bat without a shell (since
// the April 2024 security release spawn() refuses with EINVAL), and passing the arguments to a shell as they are
// is the hole that release closed. So the command is looked up as Windows would (PATH × PATHEXT), and a batch
// file is started through cmd.exe with every argument quoted and cmd's special characters escaped, the way the
// cross-spawn package does it; anything else is started directly, as before.
import { statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

export interface Launch {
  command: string;
  args: string[];
  /** cmd.exe gets its command line as written (the quoting below is already cmd's). */
  windowsVerbatimArguments?: boolean;
}

/** cmd.exe's special characters, each escaped with ^ (as cross-spawn). */
const META = /([()\][%!^"`<>&|;, *?])/g;

const isFile = (p: string): boolean => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * The variable named `name` in `env`, whatever its case (Windows names are not case-sensitive). With two spellings
 * (Path and PATH), the one the started program gets: Node sorts the names and keeps the first that matches.
 */
export function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env)
    .filter((k) => k.toUpperCase() === name)
    .sort()[0];
  return key ? env[key] : undefined;
}

/**
 * Where Windows would find `command`: a path (relative to `cwd`) as it is or with an extension from PATHEXT;
 * a bare name in each folder of PATH. Undefined when not found (spawn then reports it as before).
 */
export function findCommand(command: string, env: Record<string, string | undefined>, cwd?: string): string | undefined {
  const exts = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  const withExt = (base: string): string | undefined => {
    // off Windows a program has no extension; on Windows a bare `npx` next to npx.cmd is a shell script, not runnable
    if ((extname(base) || process.platform !== 'win32') && isFile(base)) return base;
    for (const e of exts) if (isFile(base + e)) return base + e;
    return undefined;
  };
  if (/[\\/]/.test(command) || isAbsolute(command)) return withExt(resolve(cwd ?? process.cwd(), command));
  for (const dir of (envValue(env, 'PATH') ?? '').split(delimiter)) {
    if (!dir.trim()) continue;
    const hit = withExt(join(dir.replace(/^"(.*)"$/, '$1'), command));
    if (hit) return hit;
  }
  return undefined;
}

/** One argument for cmd.exe /s /c: quoted as a program reads it, then cmd's characters escaped (twice for npm's .cmd shims). */
export function escapeArgument(arg: string, twice: boolean): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  a = `"${a}"`.replace(META, '^$1');
  return twice ? a.replace(META, '^$1') : a;
}

/** How to start `command` with `args` on this computer. Off Windows, or not a batch file: as given. */
export function windowsLaunch(command: string, args: readonly string[], env: Record<string, string | undefined>, cwd?: string, platform: NodeJS.Platform = process.platform): Launch {
  if (platform !== 'win32') return { command, args: [...args] };
  const found = findCommand(command, env, cwd);
  if (!found || !/\.(cmd|bat)$/i.test(found)) return { command: found ?? command, args: [...args] };
  // npm's shims in node_modules\.bin run the arguments through cmd once more
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(found);
  const line = [found.replace(META, '^$1'), ...args.map((a) => escapeArgument(a, twice))].join(' ');
  return { command: envValue(env, 'COMSPEC') ?? process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}
