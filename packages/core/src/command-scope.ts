// Where a command (run_command) writes, read off its text by a few fixed rules, for approval mode Auto: a command
// that writes outside the conversation's folders is confirmed like a write_file there (GuardCause 'outside_folder').
// Manual asks for every command anyway. No model judges it (he: 「先用写死的吧」); nothing of it is in the prompt.
//
// The rules, all on the command as written:
// 1. It runs in a folder outside (its `cwd`, or a `cd` / Set-Location to one before something that writes).
// 2. A write names an absolute path outside: a redirection (> >>), or a command that writes or removes what it
//    names (Set-Content, Out-File, Remove-Item, del, rm, mkdir, …); for a copy (Copy-Item, copy, cp, robocopy, …)
//    only where it copies to. `~`, $HOME, $env:USERPROFILE and %USERPROFILE% count as the home folder; a relative
//    path with `..` is taken from where the command runs.
// 3. A recursive delete of a drive's root or the home folder (it is also outside, as rule 2; said here so that a
//    root or the home folder is never remembered as allowed).
//
// What it cannot see, on purpose (more rules would ask about ordinary commands without closing these): a script
// file that writes (python x.py, .\x.ps1), a path built in a variable ($p = 'D:\x'; Set-Content $p), an
// interpreter's one-liner (python -c, node -e, powershell -Command "…"), and tools that write where their own
// settings say. Better to miss one than to ask about every command.
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { inScope, realPath } from './write-scope.ts';

export interface CommandOutside {
  /** The folder it writes in (as the card shows it and 始终允许 keeps it). */
  folder: string;
  /** The path as written in the command (or the folder it runs in), for the card. */
  path: string;
  rule: 'cwd' | 'write' | 'sweep';
}

// Commands that write or remove whatever they name (PowerShell, its aliases, cmd, bash).
const WRITE_ANY = new Set([
  'set-content', 'add-content', 'out-file', 'new-item', 'remove-item', 'move-item', 'rename-item', 'clear-content', 'tee-object', 'clear-item',
  'sc', 'ac', 'ni', 'ri', 'mi', 'rni', 'del', 'erase', 'rm', 'rmdir', 'rd', 'mv', 'move', 'ren', 'rename', 'md', 'mkdir',
  'touch', 'tee', 'truncate', 'ln', 'shred',
]);
// Commands that copy: only where they copy to is written.
const COPY = new Set(['copy-item', 'cpi', 'copy', 'cp', 'xcopy', 'robocopy', 'rsync', 'install', 'expand-archive', 'compress-archive']);
const CD = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location']);
const DELETE = new Set(['remove-item', 'ri', 'del', 'erase', 'rm', 'rmdir', 'rd']);
const NULL_TARGET = /^(\$null|nul|\/dev\/null|&\d)$/i;

/** One command of a line: its words (quotes taken off) and where its output is sent. */
interface Part {
  words: string[];
  redirects: string[];
}

/** Splits the command into its parts (; && || | and line breaks, outside quotes) and words. */
function parts(command: string): Part[] {
  const out: Part[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let word = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  let toRedirect = false;
  const endWord = () => {
    if (!has) return;
    if (toRedirect) redirects.push(word);
    else words.push(word);
    toRedirect = false;
    word = '';
    has = false;
  };
  const endPart = () => {
    endWord();
    if (words.length || redirects.length) out.push({ words, redirects });
    words = [];
    redirects = [];
    toRedirect = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === '\n' || c === '\r' || c === ';' || c === '|' || (c === '&' && command[i + 1] === '&')) {
      endPart();
      if (command[i + 1] === c) i++;
      continue;
    }
    if (c === '>') {
      // 2>&1, *>, 1>>: the stream number before it is not a word
      if (/^[*\d]$/.test(word)) {
        word = '';
        has = false;
      }
      endWord();
      if (command[i + 1] === '>') i++;
      toRedirect = true;
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      continue;
    }
    word += c;
    has = true;
  }
  endPart();
  return out;
}

/** The home folder for ~, $HOME, $env:USERPROFILE, %USERPROFILE% at the start of a word. */
function expandHome(word: string): string {
  const m = /^(~|\$HOME|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=$|[\\/])/i.exec(word);
  return m ? homedir() + word.slice(m[0].length) : word;
}

/** The word as a path, when it is one this checks: absolute (after the home folder), or relative with `..`. */
function pathOf(word: string, cwd: string): string | undefined {
  // -Path:D:\x, -Destination=D:\x
  const w = expandHome(word.replace(/^-[A-Za-z]+[:=]/, ''));
  if (process.platform === 'win32' ? /^([A-Za-z]:[\\/]|\\\\[^\\/])/.test(w) || /^[A-Za-z]:$/.test(w) : w.startsWith('/')) return resolve(w.length === 2 ? w + '\\' : w);
  if (/(^|[\\/])\.\.([\\/]|$)/.test(w) && !isAbsolute(w)) return resolve(cwd, w);
  return undefined;
}

/** The folder a target is in: the target itself when it is a folder that exists, else the one holding it. */
function folderOf(target: string): string {
  const real = realPath(target);
  try {
    if (existsSync(real) && statSync(real).isDirectory()) return real;
  } catch {
    /* as a file */
  }
  return dirname(real);
}

function isRootOrHome(p: string): boolean {
  const r = resolve(p);
  return parse(r).root === r || r.toLowerCase() === resolve(homedir()).toLowerCase();
}

/** A folder never kept as allowed on a card: a drive's root, the home folder. */
export function tooWideToAllow(folder: string): boolean {
  return isRootOrHome(folder);
}

/**
 * Whether `command`, run in `cwd` (where run_command runs it), writes outside `roots` by the rules above; the first
 * place it does, or undefined. `hasCwd`: the call named its folder (rule 1 asks for it whether or not it writes).
 */
export function commandOutside(command: string, cwd: string, roots: readonly string[], hasCwd = false): CommandOutside | undefined {
  if (hasCwd && !inScope(cwd, roots)) return { folder: realPath(cwd), path: cwd, rule: 'cwd' };
  const list = parts(command);
  let at = cwd;
  let movedOut: string | undefined;
  for (const p of list) {
    let words = p.words;
    // cmd /c …, & 'tool.exe' …: the command after them
    if (/^cmd(\.exe)?$/i.test(words[0] ?? '') && /^\/[ck]$/i.test(words[1] ?? '')) words = words.slice(2);
    if (words[0] === '&' || words[0] === '.') words = words.slice(1);
    const verb = (words[0] ?? '').toLowerCase().replace(/\.exe$/, '');
    const args = words.slice(1);
    // 3. a recursive delete of a drive's root or the home folder
    if (DELETE.has(verb) && args.some((a) => /^(-r|-rf|-fr|-recurse|\/s)$/i.test(a))) {
      for (const a of args) {
        const t = pathOf(a.replace(/[\\/]\*?$/, '') || a, at);
        if (t && isRootOrHome(t)) return { folder: resolve(t), path: a, rule: 'sweep' };
      }
    }
    const targets: { word: string; path: string }[] = [];
    for (const r of p.redirects) {
      if (NULL_TARGET.test(r)) continue;
      const t = pathOf(r, at);
      if (t) targets.push({ word: r, path: t });
    }
    if (WRITE_ANY.has(verb) || (verb === 'sed' && args.some((a) => /^-i/.test(a)))) {
      for (const a of args) {
        const t = pathOf(a, at);
        if (t) targets.push({ word: a, path: t });
      }
    } else if (COPY.has(verb)) {
      const named = args.findIndex((a) => /^-(destination|destinationpath|target)$/i.test(a));
      const inline = args.find((a) => /^-(destination|destinationpath)[:=]/i.test(a));
      const positional = args.filter((a) => !/^-/.test(a) && !(process.platform === 'win32' && /^\/[A-Za-z]+(:\S*)?$/.test(a)));
      const dest = inline ?? (named >= 0 ? args[named + 1] : positional.length >= 2 ? (verb === 'robocopy' ? positional[1] : positional.at(-1)) : undefined);
      const t = dest !== undefined ? pathOf(dest, at) : undefined;
      if (dest !== undefined && t) targets.push({ word: dest, path: t });
    }
    for (const t of targets) {
      if (!inScope(t.path, roots)) return { folder: folderOf(t.path), path: t.word, rule: 'write' };
    }
    // 1. moved to a folder outside before something that writes (its relative paths land there)
    if (CD.has(verb) && args[0]) {
      const t = pathOf(args[0], at) ?? resolve(at, args[0]);
      at = t;
      movedOut = inScope(t, roots) ? undefined : t;
    } else if (movedOut && (p.redirects.some((r) => !NULL_TARGET.test(r)) || WRITE_ANY.has(verb) || COPY.has(verb))) {
      return { folder: realPath(movedOut), path: movedOut, rule: 'cwd' };
    }
  }
  return undefined;
}
