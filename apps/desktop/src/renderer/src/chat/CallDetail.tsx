// What a tool call shows opened, as in the Claude app: what was done (the command in its box, or the arguments laid
// out; a file written or edited as a change with green and red lines), how it ended when it failed (one red line:
// Exit code 2, HTTP 404 …, 已拒绝), and what came out (as printed, no box; JSON indented and coloured). Any of these
// longer than 20 lines is 20 lines high and scrolls inside (styles.css --detail-lines). Only what people see: the
// model's copy keeps its fence and notes (resultBody in store/transcript.ts takes them off).
// Plain text only: nothing in a result is rendered as HTML or Markdown.
import { useMemo, type ReactNode } from 'react';
import type { FileCardMeta, FileChangeMeta } from '@spica/protocol';
import { highlightCode } from './highlight';
import { resultBody, type Block } from '../store/transcript';
import { clipboard } from '../ui/clipboard';
import { CopyButton } from '../ui/CopyButton';

type ToolBlock = Extract<Block, { type: 'tool' }>;

/** At most this many lines of a change or an output are drawn (a file of thousands of lines stays quick); ⋯ after. */
export const DRAWN_LINES = 2000;
/** Past this many old × new lines the change is not matched line by line: the old lines out, the new ones in. */
const MATCH_MAX = 4_000_000;

const arg = (b: ToolBlock, key: string): unknown => (b.input as Record<string, unknown> | undefined)?.[key];
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * What runs the command, named over its box as in the Claude app: the core runs Windows PowerShell on Windows
 * (packages/core tools/command-tool.ts); elsewhere a POSIX shell, which is not always Bash, so just Command.
 */
export const SHELL_LABEL = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent) ? 'PowerShell' : 'Command';

/**
 * A command as written, as in the Claude app: a small label naming the shell, then the box: $ and the command,
 * coloured as PowerShell; long ones wrap, the wrapped lines in line with the command after the $. Copy floats at
 * the box's top right, on the first line's row, shown while the pointer is over the box (or the key focus is on it);
 * it takes no line of its own. `marks` (where the dangerous words are): those words on a red ground in place of the
 * colours. `bare`: no edge of its own (the card it is in is the box).
 */
export function CommandBox({ command, marks, bare }: { command: string; marks?: [number, number][] | undefined; bare?: boolean }) {
  const red = marks && marks.length ? marks : null;
  const coloured = useMemo(() => (red ? null : highlightCode('powershell', command)), [command, red]);
  let body: ReactNode = coloured ?? command;
  if (red) {
    const parts: ReactNode[] = [];
    let at = 0;
    red.forEach(([a, b], i) => {
      if (a < at) return;
      parts.push(command.slice(at, a), <mark key={i} className="cmd-danger">{command.slice(a, b)}</mark>);
      at = b;
    });
    parts.push(command.slice(at));
    body = parts;
  }
  return (
    <div className={bare ? 'tool-command is-bare' : 'tool-command'}>
      <p className="tool-command-label">{SHELL_LABEL}</p>
      <div className="tool-command-box">
        <pre>
          <code>
            <span className="tool-prompt">$ </span>
            {body}
          </code>
        </pre>
        <CopyButton className="icon-btn md-tool tool-command-copy" copy={() => clipboard.write(command)} />
      </div>
    </div>
  );
}

/** How a failed call ended, in one line, and what it printed after that. Null: it did not fail (nothing to say). */
export function callEnd(block: ToolBlock, raw: string): { status: string | null; output: string } {
  const body = resultBody(raw);
  if (block.name === 'run_command') {
    const nl = body.indexOf('\n');
    const first = nl < 0 ? body : body.slice(0, nl);
    const rest = (nl < 0 ? '' : body.slice(nl + 1)).replace(/^\n+/, '');
    const output = rest.trim() === '(no output)' ? '' : rest;
    const exit = /^exit code (\S+), [\d.]+ s$/.exec(first);
    if (exit) return { status: exit[1] === '0' ? null : `Exit code ${exit[1]}`, output };
    if (/^timed out after/.test(first)) return { status: '已超时', output };
    if (/^stopped: the user interrupted/.test(first)) return { status: '已中断', output };
  }
  const failed = block.state === 'error' || block.state === 'timeout' || block.state === 'unavailable' || block.state === 'repeated';
  if (!failed) return { status: null, output: body };
  const nl = body.indexOf('\n');
  const first = (nl < 0 ? body : body.slice(0, nl)).trim();
  const rest = nl < 0 ? '' : body.slice(nl + 1).replace(/^\n+/, '');
  if (/declined|用户拒绝|已拒绝/i.test(first)) return { status: '已拒绝', output: rest };
  if (/^(Aborted|Cancelled)\b|interrupted/i.test(first)) return { status: '已中断', output: rest };
  if (block.state === 'timeout') return { status: '已超时', output: body };
  return { status: first.replace(/^Tool failed:\s*/, '') || 'Failed', output: rest };
}

/** A value as JSON, two spaces a level; a list or an object that fits in 60 characters stays on one line. */
export function layJson(v: unknown, indent = ''): string {
  const flat = JSON.stringify(v);
  if (v === null || typeof v !== 'object' || flat.length <= 60) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + layJson(x, inner)).join(',\n')}\n${indent}]`;
  const rows = Object.entries(v as Record<string, unknown>).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${layJson(x, inner)}`);
  return `{\n${rows.join(',\n')}\n${indent}}`;
}

/** JSON laid out when the whole text is JSON; null otherwise. */
export function jsonLaidOut(t: string): string | null {
  const s = t.trim();
  if (!/^[[{]/.test(s)) return null;
  try {
    return layJson(JSON.parse(s));
  } catch {
    return null;
  }
}

/** What came out: as printed, in the code font, no box; JSON indented and coloured. */
export function CallOutput({ text: out }: { text: string }) {
  const json = useMemo(() => jsonLaidOut(out), [out]);
  const shown = json ?? out;
  const lines = shown.split('\n');
  const visible = lines.length > DRAWN_LINES ? `${lines.slice(0, DRAWN_LINES).join('\n')}\n⋯` : shown;
  const coloured = useMemo(() => (json ? highlightCode('json', visible) : null), [json, visible]);
  return <pre className={json ? 'tool-output is-json' : 'tool-output'}>{coloured ?? visible}</pre>;
}

/** Fits after its key: a number, a yes or no, a short line, or a short list or object written on one line. */
const scalar = (v: unknown): boolean =>
  v === null || ['number', 'boolean'].includes(typeof v) || (typeof v === 'string' ? !v.includes('\n') && v.length <= 80 : JSON.stringify(v).length <= 60);

/** The arguments of a call that is not a command: short ones `key  value`, long text and lists laid out under their key. */
export function CallArgs({ input }: { input: unknown }) {
  if (!input || typeof input !== 'object' || !Object.keys(input).length) return null;
  return (
    <div className="tool-args">
      {Object.entries(input as Record<string, unknown>).map(([k, v]) =>
        scalar(v) ? (
          <div key={k} className="tool-arg">
            <span className="tool-arg-key">{k}</span>
            <span className="tool-arg-value">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
          </div>
        ) : (
          <div key={k} className="tool-arg is-block">
            <span className="tool-arg-key">{k}</span>
            <ArgBlock value={v} />
          </div>
        ),
      )}
    </div>
  );
}

function ArgBlock({ value }: { value: unknown }) {
  const laid = typeof value === 'string' ? value : layJson(value);
  const coloured = useMemo(() => (typeof value === 'string' ? null : highlightCode('json', laid)), [value, laid]);
  return <pre className="tool-arg-block">{coloured ?? laid}</pre>;
}

// ---- A file written or edited, as a change (green in, red out) ----

const LANGUAGES: Record<string, string> = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json',
  md: 'markdown', css: 'css', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', ps1: 'powershell', psm1: 'powershell', sh: 'bash', bash: 'bash',
  sql: 'sql', yaml: 'yaml', yml: 'yaml', ini: 'ini', toml: 'ini', cfg: 'ini', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', go: 'go',
  rs: 'rust', java: 'java', bat: 'dos', cmd: 'dos', vb: 'vbnet',
};
export const languageOf = (path: string): string | null => LANGUAGES[path.split('.').pop()?.toLowerCase() ?? ''] ?? null;

export interface ChangeLine {
  /** `gap`: lines left out between two places that changed (or past the last one drawn): ⋯. */
  kind: 'same' | 'in' | 'out' | 'gap';
  text: string;
  /** Line number in the file, when it is known: the old file's for a removed line, the new file's for the others. */
  n?: number;
  /** The part of the line that changed (paired with a line on the other side): [start, end). */
  changed?: [number, number];
}

/** Old lines against new, line by line (longest common run); a removed line and the added one in its place are paired. */
export function lineChange(before: string, after: string): ChangeLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: ChangeLine[] = [];
  if (a.length * b.length > MATCH_MAX) {
    for (const t of a) out.push({ kind: 'out', text: t });
    for (const t of b) out.push({ kind: 'in', text: t });
    return out;
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ kind: 'out', text: a[i++]! });
    else out.push({ kind: 'in', text: b[j++]! });
  }
  return markChanged(out);
}

/** The core's hunks (FileCardMeta.change) as lines, numbered in one column as in the Claude app; ⋯ where lines are left out. */
export function hunkLines(change: FileChangeMeta): ChangeLine[] {
  const out: ChangeLine[] = [];
  change.hunks.forEach((h, k) => {
    if (k > 0) out.push({ kind: 'gap', text: '' });
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines) {
      const t = l.slice(1);
      if (l[0] === '-') out.push({ kind: 'out', text: t, n: o++ });
      else if (l[0] === '+') out.push({ kind: 'in', text: t, n: n++ });
      else {
        out.push({ kind: 'same', text: t, n: n++ });
        o++;
      }
    }
  });
  if (change.truncated) out.push({ kind: 'gap', text: '' });
  return markChanged(out);
}

/** Each run of removed lines followed by added ones: the k-th of each paired, the part that differs marked. */
function markChanged(out: ChangeLine[]): ChangeLine[] {
  // The part between their common start and end is what changed.
  for (let k = 0; k < out.length; ) {
    if (out[k]!.kind !== 'out') {
      k++;
      continue;
    }
    let o = k;
    while (o < out.length && out[o]!.kind === 'out') o++;
    let p = o;
    while (p < out.length && out[p]!.kind === 'in') p++;
    for (let x = 0; x < Math.min(o - k, p - o); x++) {
      const del = out[k + x]!;
      const add = out[o + x]!;
      let s = 0;
      while (s < del.text.length && s < add.text.length && del.text[s] === add.text[s]) s++;
      let e = 0;
      while (e < del.text.length - s && e < add.text.length - s && del.text[del.text.length - 1 - e] === add.text[add.text.length - 1 - e]) e++;
      // Only lines that are mostly the same get their changed words marked; two different lines are just red and green.
      const kept = s + e;
      if (kept < Math.max(del.text.length, add.text.length) && kept >= 0.5 * Math.max(del.text.trim().length, add.text.trim().length) + (del.text.length - del.text.trimStart().length)) {
        del.changed = [s, del.text.length - e];
        add.changed = [s, add.text.length - e];
      }
    }
    k = p;
  }
  return out;
}

/** The lines of a write or an edit, or null when the call is neither (or says nothing to draw). */
export function callChange(block: ToolBlock, card?: FileCardMeta): { path: string; lines: ChangeLine[]; numbered: boolean } | null {
  const path = card?.path ?? text(arg(block, 'path'));
  // Where the file changed, as the core worked it out (line numbers, three unchanged lines around each change).
  if ((block.name === 'write_file' || block.name === 'edit_file') && card?.change?.hunks.length) return { path, numbered: true, lines: hunkLines(card.change) };
  if (block.name === 'write_file') {
    const content = text(arg(block, 'content'));
    if (!content && arg(block, 'content') === undefined) return null;
    // Created: every line is new. Written over a file without the change (a conversation from before, a file over
    // 2 MB): the lines as they are now, not coloured.
    const created = card?.origin === 'created' || /^Created\b/.test(resultBody(block.result ?? block.preview ?? ''));
    return { path, numbered: true, lines: content.split('\n').map((t, i) => ({ kind: created ? 'in' : 'same', text: t, n: i + 1 })) };
  }
  if (block.name === 'edit_file') {
    // No change from the core (a conversation from before): the two strings against each other, − and +.
    const oldS = text(arg(block, 'old_string'));
    const newS = text(arg(block, 'new_string'));
    if (!oldS && !newS) return null;
    return { path, numbered: false, lines: lineChange(oldS, newS) };
  }
  return null;
}

function LineText({ line, language }: { line: ChangeLine; language: string | null }) {
  const coloured = useMemo(() => (language && !line.changed ? highlightCode(language, line.text) : null), [language, line]);
  if (line.changed) {
    const [s, e] = line.changed;
    return (
      <>
        {line.text.slice(0, s)}
        <span className="change-word">{line.text.slice(s, e)}</span>
        {line.text.slice(e)}
      </>
    );
  }
  return <>{coloured ?? (line.text || ' ')}</>;
}

/** A write or an edit as a change: the file's path, then its lines, green in and red out, numbered when known. */
export function FileChange({ path, lines, numbered }: { path: string; lines: ChangeLine[]; numbered: boolean }) {
  const language = languageOf(path);
  const shown: ChangeLine[] = lines.length > DRAWN_LINES ? [...lines.slice(0, DRAWN_LINES), { kind: 'gap', text: '' }] : lines;
  return (
    <div className="file-change-wrap">
      {path ? <p className="file-change-path">{path}</p> : null}
      {/* A pre, as every block of code (the code colours are set for code in one). */}
      <pre className="file-change" aria-label={path}>
        {shown.map((l, i) => (
          <span key={i} className={`change-line is-${l.kind}`}>
            <span className="change-gutter">{l.kind === 'gap' ? '⋯' : numbered ? l.n : l.kind === 'in' ? '+' : l.kind === 'out' ? '−' : ''}</span>
            <span className="change-text">{l.kind === 'gap' ? null : <LineText line={l} language={language} />}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

/** The whole of a call opened: what was done, how it ended when it failed, what came out. */
export function CallDetail({ block, card }: { block: ToolBlock; card?: FileCardMeta | undefined }) {
  const raw = block.result ?? block.preview ?? '';
  const { status, output } = callEnd(block, raw);
  const change = callChange(block, card);
  const command = block.name === 'run_command' ? text(arg(block, 'command')) : '';
  // A write or an edit that worked: its change says it all (the result line only repeats it).
  const out = change && !status ? '' : output;
  const input = change ? <FileChange {...change} /> : command ? <CommandBox command={command} /> : <CallArgs input={block.input} />;
  const empty = !change && !command && !(block.input && typeof block.input === 'object' && Object.keys(block.input).length);
  return (
    <div className="tool-detail">
      {input}
      {status ? <p className="tool-status">{status}</p> : null}
      {out ? <CallOutput text={out} /> : null}
      {empty && !status && !out ? <p className="tool-empty">—</p> : null}
    </div>
  );
}
