// What a tool call shows opened, as in the Claude app: what was done (the command in its box, or the arguments laid
// out; a file written or edited as a change with green and red lines), how it ended when it failed (one red line:
// Exit code 2, HTTP 404 …, 已拒绝), and what came out (as printed, no box; JSON indented and coloured). Only what
// people see: the model's copy keeps its fence and notes (resultBody in store/transcript.ts takes them off).
// Plain text only: nothing in a result is rendered as HTML or Markdown.
import { useMemo, useState, type ReactNode } from 'react';
import type { FileCardMeta } from '@spica/protocol';
import { highlightCode } from './highlight';
import { resultBody, type Block } from '../store/transcript';
import { clipboard } from '../ui/clipboard';
import { CopyButton } from '../ui/CopyButton';

type ToolBlock = Extract<Block, { type: 'tool' }>;

/** Output longer than this many lines shows its start, then 显示更多. */
export const OUTPUT_LINES = 30;
/** A change of more lines than this shows its start, then 显示更多 (a file of thousands of lines stays quick). */
export const CHANGE_LINES = 400;
/** Past this many old × new lines the change is not matched line by line: the old lines out, the new ones in. */
const MATCH_MAX = 4_000_000;

const arg = (b: ToolBlock, key: string): unknown => (b.input as Record<string, unknown> | undefined)?.[key];
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * A command as written: $ and the command, coloured as PowerShell, in a box of its own; long ones wrap. `marks`
 * (where the dangerous words are): those words on a red ground in place of the colours. Copy is at the box's top
 * right, wherever it is (a step opened, a card to confirm). `bare`: no edge of its own (the card it is in is the box).
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
      <div className="code-head">
        <span className="code-lang" />
        <CopyButton className="icon-btn md-tool" copy={() => clipboard.write(command)} />
      </div>
      <pre>
        <code>
          <span className="tool-prompt">$ </span>
          {body}
        </code>
      </pre>
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

/** Long text: its first `n` lines, then 显示更多 for the rest (and 收起). */
function useFold(lines: number, n: number) {
  const [all, setAll] = useState(false);
  const cut = lines > n && !all;
  const button =
    lines > n ? (
      <button type="button" className="btn btn-small tool-more" onClick={() => setAll((v) => !v)}>
        {all ? '收起' : '显示更多'}
      </button>
    ) : null;
  return { cut, button };
}

/** What came out: as printed, in the code font, no box; JSON indented and coloured. */
export function CallOutput({ text: out }: { text: string }) {
  const json = useMemo(() => jsonLaidOut(out), [out]);
  const shown = json ?? out;
  const lines = shown.split('\n');
  const { cut, button } = useFold(lines.length, OUTPUT_LINES);
  const visible = cut ? lines.slice(0, OUTPUT_LINES).join('\n') : shown;
  const coloured = useMemo(() => (json ? highlightCode('json', visible) : null), [json, visible]);
  return (
    <div className="tool-output-wrap">
      <pre className={json ? 'tool-output is-json' : 'tool-output'}>{coloured ?? visible}</pre>
      {button}
    </div>
  );
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
  kind: 'same' | 'in' | 'out';
  text: string;
  /** Line number in the file, when it is known (a whole file written). */
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
  // Each run of removed lines followed by added ones: the k-th of each paired, the part between their common
  // start and end marked as changed.
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
  if (block.name === 'write_file') {
    const content = text(arg(block, 'content'));
    if (!content && arg(block, 'content') === undefined) return null;
    // Created: every line is new. Written over a file whose old content the window was not given: the lines as
    // they are now, not coloured.
    const created = card?.origin === 'created' || /^Created\b/.test(resultBody(block.result ?? block.preview ?? ''));
    return { path, numbered: true, lines: content.split('\n').map((t, i) => ({ kind: created ? 'in' : 'same', text: t, n: i + 1 })) };
  }
  if (block.name === 'edit_file') {
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
  const { cut, button } = useFold(lines.length, CHANGE_LINES);
  const shown = cut ? lines.slice(0, CHANGE_LINES) : lines;
  return (
    <div className="file-change-wrap">
      {path ? <p className="file-change-path">{path}</p> : null}
      {/* A pre, as every block of code (the code colours are set for code in one). */}
      <pre className="file-change" aria-label={path}>
        {shown.map((l, i) => (
          <span key={i} className={`change-line is-${l.kind}`}>
            <span className="change-gutter">{numbered ? l.n : l.kind === 'in' ? '+' : l.kind === 'out' ? '−' : ''}</span>
            <span className="change-text">
              <LineText line={l} language={language} />
            </span>
          </span>
        ))}
      </pre>
      {button}
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
