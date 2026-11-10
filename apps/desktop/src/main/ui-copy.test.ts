// Interface wording stays standard (2026-11-10 copy pass): no colloquial words in
// any string a person can see. Scans the strings and JSX text of the shell's
// source; comments, tests and the demo data (sample mail, chats, plugins) are not
// interface wording and are skipped.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

export const BANNED = ['重活', '日常', '挪', '装多少', '对不上', '勾上', '这家', '自己填', '管理员给的', '多半', '先不等了', '不让它', '拿到', '点开补上', '填了一半', '看不懂', '不认识', '读不了', '没能'];

const ROOT = join(__dirname, '..');
const DEMO = /(^|\/)(fake-seed|fake|fake-mail)\.ts$/;
const STOP = /[<>{}'"`/]/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [p] : [];
  });
}

/** Strings, template text and JSX text of a source file, each with its line. */
export function visibleText(src: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let line = 1;
  let i = 0;
  let jsx = '';
  const flushJsx = () => {
    if (/[一-鿿]/.test(jsx)) out.push({ line, text: jsx.trim() });
    jsx = '';
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') line++;
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
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          text += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (src[j] === '\n') {
          if (c !== '`') break;
          line++;
        }
        text += src[j];
        j++;
      }
      if (/[一-鿿]/.test(text)) out.push({ line: start, text });
      i = j + 1;
      continue;
    }
    // JSX text: between > and < (or {), with Chinese in it.
    if (c === '>') {
      let j = i + 1;
      // Stops at quotes and slashes too: after an arrow or a comparison this is code, whose strings are read above.
      while (j < src.length && !STOP.test(src[j]!)) j++;
      jsx = src.slice(i + 1, j);
      if (src[j] === '<' || src[j] === '{') flushJsx();
      jsx = '';
    }
    i++;
  }
  return out;
}

describe('interface wording', () => {
  it('uses no colloquial words', () => {
    const hits: string[] = [];
    const all = files(ROOT);
    expect(all.length).toBeGreaterThan(50);
    for (const file of all) {
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      if (DEMO.test(rel)) continue;
      for (const { line, text } of visibleText(readFileSync(file, 'utf8'))) {
        const word = BANNED.find((w) => text.includes(w));
        if (word) hits.push(`${rel}:${line} 「${word}」 ${text}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('finds a banned word in a string and in JSX text, not in a comment', () => {
    const src = ["// 重活 in a comment", "const a = '交给重活用的模型';", '<p>这家服务商</p>'].join('\n');
    const words = visibleText(src).map((t) => BANNED.find((w) => t.text.includes(w)));
    expect(words).toEqual(['重活', '这家']);
  });
});
