// What a command will do, said by the app from the command itself (not by the model, whose description may not
// match): the common kinds of change a confirmation is about. Only what is recognised is said; anything else
// falls back to 运行命令, and the command itself is always shown in full.

export type FactKind = 'delete' | 'move' | 'copy' | 'write' | 'net' | 'install' | 'process' | 'registry';

export interface CommandFact {
  kind: FactKind;
  /** One plain line, e.g. 删除 D:\工作\样机评审（含其中所有内容）. */
  text: string;
  /** Cannot be taken back (deleting, overwriting, stopping a program, the registry). */
  danger: boolean;
}

/** A verb counts only where a command starts: the line's start, after | ; & ( { or a quote, or after cmd /c. */
const AT_START = String.raw`(?<=(?:^|[|;&({\n"]|\bcmd(?:\.exe)?\s+\/[ck])\s*)`;
/** What follows a verb up to the end of its command. */
const ARGS = String.raw`(?=$|[\s|;&)}"])([^|;&\n]*)`;

const verb = (names: string) => new RegExp(`${AT_START}(${names})${ARGS}`, 'gi');

/** The flags that make a delete take everything under the target. */
const RECURSE = /(?:^|\s)(-Recurse|-rf|-fr|-r|\/s)(?=\s|$)/gi;
/** The flags marked in a dangerous command: recursing, forcing, not asking. */
const DANGER_FLAGS = /(?:^|\s)(-Recurse|-Force|-rf|-fr|-r|-f|\/s|\/q|\/f)(?=\s|$)/gi;

const VERBS: { kind: FactKind; re: RegExp; say: (target: string, args: string) => string; danger: boolean }[] = [
  {
    kind: 'delete',
    re: verb('Remove-Item|rm|del|erase|rmdir|rd|ri'),
    say: (t, a) => `删除 ${t || '文件'}${new RegExp(RECURSE.source, 'i').test(a) ? '（含其中所有内容）' : ''}`,
    danger: true,
  },
  { kind: 'move', re: verb('Move-Item|mv|move|Rename-Item|ren'), say: (t) => `移动或改名 ${t || '文件'}`, danger: false },
  { kind: 'copy', re: verb('Copy-Item|cp|copy|xcopy|robocopy'), say: (t) => `复制 ${t || '文件'}`, danger: false },
  { kind: 'write', re: verb('Set-Content|Out-File|Clear-Content'), say: (t) => `覆盖 ${t || '文件'}`, danger: true },
  { kind: 'write', re: verb('Add-Content'), say: (t) => `写入 ${t || '文件'}`, danger: false },
  { kind: 'net', re: verb('Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget|Start-BitsTransfer'), say: (t) => `访问网络 ${t}`.trim(), danger: false },
  { kind: 'install', re: verb(String.raw`npm\s+(?:i|install)|pip\s+install|winget\s+install|choco\s+install|Install-Module|Install-Package`), say: (t) => `安装 ${t}`.trim(), danger: false },
  { kind: 'process', re: verb('Stop-Process|taskkill|kill'), say: (t) => `结束程序 ${t}`.trim(), danger: true },
  { kind: 'registry', re: verb(String.raw`reg\s+(?:add|delete)|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty`), say: () => '修改注册表', danger: true },
];

/** > and >> into a file (not 2>&1, not into $null). */
const REDIRECT = /(^|[^>])(>>?)\s*('[^']*'|"[^"]*"|[^\s|;&]+)/g;

/** The first path-like or address-like argument of what follows a verb, without its flags and quotes. */
function targetOf(args: string): string {
  const words = args.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  for (const w of words) {
    if (/^-|^\//.test(w) && !/^\/[\w.-]+\//.test(w)) continue;
    const t = w.replace(/^['"]|['"]$/g, '');
    if (t) return t;
  }
  return '';
}

interface Found {
  at: number;
  fact: CommandFact;
  /** Where its dangerous words are ([start, end)), when it is dangerous. */
  marks: [number, number][];
}

function scan(command: string): Found[] {
  const found: Found[] = [];
  for (const v of VERBS) {
    for (const m of command.matchAll(v.re)) {
      const at = m.index ?? 0;
      const name = m[1] ?? '';
      const args = m[2] ?? '';
      const marks: [number, number][] = [];
      if (v.danger) {
        marks.push([at, at + name.length]);
        const argsAt = at + m[0].length - args.length;
        for (const f of args.matchAll(DANGER_FLAGS)) {
          const start = argsAt + (f.index ?? 0) + f[0].length - f[1]!.length;
          marks.push([start, start + f[1]!.length]);
        }
      }
      found.push({ at, fact: { kind: v.kind, text: v.say(targetOf(args), args), danger: v.danger }, marks });
    }
  }
  for (const m of command.matchAll(REDIRECT)) {
    const target = m[3]!.replace(/^['"]|['"]$/g, '');
    if (!target || /^&\d$/.test(target) || /^\$null$/i.test(target)) continue;
    const at = (m.index ?? 0) + m[1]!.length;
    const overwrite = m[2] === '>';
    found.push({
      at,
      fact: { kind: 'write', text: `${overwrite ? '覆盖' : '写入'} ${target}`, danger: overwrite },
      marks: overwrite ? [[at, at + 1]] : [],
    });
  }
  return found.sort((a, b) => a.at - b.at);
}

/** What the command will do, in order, as far as it can be told; nothing recognised gives []. */
export function commandFacts(command: string): CommandFact[] {
  return scan(command).map((f) => f.fact);
}

/**
 * Where the dangerous words are in the command ([start, end) pairs, in order): the verb that deletes, overwrites,
 * stops a program or changes the registry, its -Recurse / -Force and the like, and a > that overwrites a file.
 * A command with nothing dangerous in it has none.
 */
export function dangerSpans(command: string): [number, number][] {
  return scan(command)
    .flatMap((f) => f.marks)
    .sort((a, b) => a[0] - b[0]);
}
