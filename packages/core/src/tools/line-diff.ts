// Where a write or an edit changed a file, for the window only (FileCardMeta.change): the changed lines with three
// unchanged ones around them, as unified-diff hunks with line numbers. Nothing here goes to the model.
import type { FileChangeMeta } from '../types.ts';

/** Unchanged lines shown before and after each change. */
export const CHANGE_CONTEXT = 3;
/** At most this many lines in all the hunks of one call; past it the rest are left out (`truncated`). */
export const CHANGE_MAX_LINES = 2000;
/** Past this many old × new lines (between the first and the last change) the lines are not matched one by one. */
const MATCH_MAX = 4_000_000;

function lines(text: string): string[] {
  if (text === '') return [];
  const all = text.replace(/\r\n/g, '\n').split('\n');
  if (all.at(-1) === '') all.pop(); // a final newline does not start another line
  return all;
}

type Op = ' ' | '-' | '+';

/** The middle of two texts (what differs between their common start and end), line by line: longest common run. */
function middleOps(a: string[], b: string[]): Op[] {
  if (a.length * b.length > MATCH_MAX || a.length === 0 || b.length === 0) return [...a.map((): Op => '-'), ...b.map((): Op => '+')];
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push(' ');
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
      ops.push('-');
      i++;
    } else {
      ops.push('+');
      j++;
    }
  }
  return ops;
}

/** The change from `before` to `after` as hunks, or undefined when no line changed. */
export function fileChange(before: string, after: string): FileChangeMeta | undefined {
  const a = lines(before);
  const b = lines(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (p === a.length && p === b.length) return undefined;
  const ops: Op[] = [...a.slice(0, p).map((): Op => ' '), ...middleOps(a.slice(p, a.length - s), b.slice(p, b.length - s)), ...a.slice(a.length - s).map((): Op => ' ')];
  // Old and new line index before each op.
  const at: { i: number; j: number }[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    at.push({ i, j });
    if (op !== '+') i++;
    if (op !== '-') j++;
  }
  const changed = ops.flatMap((op, k) => (op === ' ' ? [] : [k]));
  const hunks: FileChangeMeta['hunks'] = [];
  let total = 0;
  let truncated = false;
  for (let c = 0; c < changed.length; ) {
    // Changes whose unchanged lines between them would be shown anyway go in one hunk.
    let end = c;
    while (end + 1 < changed.length && changed[end + 1]! - changed[end]! <= 2 * CHANGE_CONTEXT + 1) end++;
    const from = Math.max(0, changed[c]! - CHANGE_CONTEXT);
    const to = Math.min(ops.length, changed[end]! + CHANGE_CONTEXT + 1);
    const body: string[] = [];
    for (let k = from; k < to; k++) {
      const op = ops[k]!;
      const { i: oi, j: nj } = at[k]!;
      body.push(op + (op === '+' ? b[nj]! : a[oi]!));
    }
    if (total + body.length > CHANGE_MAX_LINES) {
      // The hunk that crosses the limit is cut there (a large rewrite still shows its start); the rest are left out.
      const room = CHANGE_MAX_LINES - total;
      if (room > 0) hunks.push({ oldStart: at[from]!.i + 1, newStart: at[from]!.j + 1, lines: body.slice(0, room) });
      truncated = true;
      break;
    }
    total += body.length;
    hunks.push({ oldStart: at[from]!.i + 1, newStart: at[from]!.j + 1, lines: body });
    c = end + 1;
  }
  return truncated ? { hunks, truncated } : { hunks };
}
