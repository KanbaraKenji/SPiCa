// Reads the interface's words out of the source (for i18n.test.ts and scripts/i18n-left.mjs): every string, template
// and JSX text with Chinese in it (or full-width punctuation), and whether it is the key of t / tc / tn / N_. Not
// imported by the app.

/** Chinese characters and full-width punctuation (（）「」，：), the parts of a text that must not show untranslated. */
export const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;

export interface Found {
  line: number;
  text: string;
  /** The key of a t / tc / tn / N_ call (a plain literal there). */
  key?: string;
  /** For tc: its context. */
  ctx?: string;
}

/** A line with this comment (or the line after it) is not interface wording: words for the model, a pattern read from input. */
export const SKIP_MARK = 'i18n-skip';

const CALL = /(?:^|[^\w.$])(t|tn|N_|tc)\(\s*$/;

function readString(src: string, i: number): { text: string; end: number; hasExpr: boolean; lines: number } {
  const q = src[i]!;
  let j = i + 1;
  let text = '';
  let hasExpr = false;
  let lines = 0;
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') {
      const n = src[j + 1] ?? '';
      text += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      j += 2;
      continue;
    }
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
      hasExpr = true;
      // skip to the matching brace, strings inside included
      let depth = 1;
      j += 2;
      text += '${';
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        else if (src[j] === '\n') lines++;
        if (depth > 0) text += src[j];
        j++;
      }
      text += '}';
      continue;
    }
    if (src[j] === '\n') {
      if (q !== '`') break;
      lines++;
    }
    text += src[j];
    j++;
  }
  return { text, end: j + 1, hasExpr, lines };
}

/** Every text with Chinese in a source file, with its line and the key it is (when it is one). */
export function scanSource(src: string): Found[] {
  const out: Found[] = [];
  const skipped = new Set<number>();
  src.split('\n').forEach((l, n) => {
    if (l.includes(SKIP_MARK)) {
      skipped.add(n + 1);
      // a comment alone on its line covers the next line
      if (/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)) skipped.add(n + 2);
    }
  });
  let line = 1;
  let i = 0;
  // The last call's name and the literal before a comma (tc's context).
  let pendingCtx: { ctx: string; at: number } | null = null;
  const push = (f: Found) => {
    if (!skipped.has(f.line)) out.push(f);
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (src.startsWith('//', i) && src[i - 1] !== ':') {
      const j = src.indexOf('\n', i);
      i = j < 0 ? src.length : j;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const j = src.indexOf('*/', i + 2);
      const end = j < 0 ? src.length : j + 2;
      line += (src.slice(i, end).match(/\n/g) ?? []).length;
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = line;
      const s = readString(src, i);
      const before = src.slice(Math.max(0, i - 40), i);
      const call = CALL.exec(before)?.[1];
      // tc('ctx', '键'): the second literal, after the context and a comma
      const afterCtx = pendingCtx && /^\s*,\s*$/.test(src.slice(pendingCtx.at, i)) ? pendingCtx.ctx : undefined;
      pendingCtx = null;
      if (call === 'tc') pendingCtx = { ctx: s.text, at: s.end };
      const isKey = !s.hasExpr && ((call && call !== 'tc') || afterCtx !== undefined);
      if (CJK.test(s.text)) push({ line: start, text: s.text, ...(isKey ? { key: afterCtx !== undefined ? `${s.text}|${afterCtx}` : s.text } : {}), ...(afterCtx !== undefined ? { ctx: afterCtx } : {}) });
      line += s.lines;
      i = s.end;
      continue;
    }
    // JSX text: between > and < or {.
    if (c === '>') {
      let j = i + 1;
      while (j < src.length && !/[<>{}'"`/]/.test(src[j]!)) j++;
      const text = src.slice(i + 1, j);
      if ((src[j] === '<' || src[j] === '{') && CJK.test(text)) push({ line, text: text.trim() });
    }
    i++;
  }
  return out;
}

/** The {name} variables of a text. */
export function varsOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
}
