// Colours for code blocks in answers: highlight.js grammars through lowlight, which returns plain nodes (no HTML
// strings, no eval, nothing the page's content security policy blocks). Only these languages are registered;
// a block without a language, or with one not here, stays plain text (nothing guesses). The colours come from
// the skin's tokens (styles.css, .hl-*), not from a highlight.js theme.
import { createElement, type ReactNode } from 'react';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dos from 'highlight.js/lib/languages/dos';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import vbnet from 'highlight.js/lib/languages/vbnet';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const lowlight = createLowlight({ bash, c, cpp, csharp, css, diff, dos, go, ini, java, javascript, json, markdown, plaintext, powershell, python, rust, shell, sql, typescript, vbnet, xml, yaml });

/** Code files' languages by their extension: a written or edited file's change, a file in the preview panel. */
const LANGUAGES: Record<string, string> = {
  py: 'python', pyw: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  mts: 'typescript', cts: 'typescript', json: 'json', jsonc: 'json', md: 'markdown', css: 'css', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  xaml: 'xml', csproj: 'xml', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
  yaml: 'yaml', yml: 'yaml', ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cs: 'csharp',
  go: 'go', rs: 'rust', java: 'java', bat: 'dos', cmd: 'dos', vb: 'vbnet', diff: 'diff', patch: 'diff',
};
/** The language of a file by its name's extension; null when not one coloured here. */
export const languageOf = (path: string): string | null => LANGUAGES[path.split('.').pop()?.toLowerCase() ?? ''] ?? null;

/** Above this a block stays plain: colouring it would hold up the page (measured: see the test). */
export const HIGHLIGHT_MAX_CHARS = 100_000;

/**
 * While a block is still streaming in, its finished lines are coloured as they come, up to this many; past it the
 * coloured part stops growing until the block is closed (each new line colours the whole part again).
 */
export const LIVE_MAX_LINES = 300;

/**
 * Which part of a block to colour now: all of it once closed (within HIGHLIGHT_MAX_CHARS); while it streams in,
 * its finished lines (not the one being written), at most LIVE_MAX_LINES. The coloured part only ever grows, so
 * a line once coloured never turns plain again.
 */
export function colourSplit(code: string, closed: boolean): { done: string; rest: string } {
  if (closed && code.length <= HIGHLIGHT_MAX_CHARS) return { done: code, rest: '' };
  let end = 0;
  for (let n = 0; n < LIVE_MAX_LINES; n++) {
    const nl = code.indexOf('\n', end);
    if (nl < 0) break;
    end = nl + 1;
  }
  return { done: code.slice(0, end), rest: code.slice(end) };
}

/** The language a block names (its `language-…` class) as written, registered here or not; '' when none. */
export function blockLanguageName(className: unknown): string {
  const names = Array.isArray(className) ? className : typeof className === 'string' ? className.split(/\s+/) : [];
  for (const n of names) {
    const m = typeof n === 'string' ? /^language-(.+)$/.exec(n) : null;
    if (m) return m[1]!;
  }
  return '';
}

/** The language a code block names (its `language-…` class), when it is one registered here. */
export function blockLanguage(className: unknown): string | null {
  const names = Array.isArray(className) ? className : typeof className === 'string' ? className.split(/\s+/) : [];
  for (const n of names) {
    const m = typeof n === 'string' ? /^language-(.+)$/.exec(n) : null;
    if (m && lowlight.registered(m[1]!.toLowerCase())) return m[1]!.toLowerCase();
  }
  return null;
}

interface HNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HNode[];
}

/**
 * highlight.js class names as the page's own: hljs-keyword as hl-keyword, and a scope's narrower part with it
 * (hljs-title function_ as hl-title hl-function_, hljs-variable language_ for `this` as hl-variable hl-language_).
 */
function classOf(className: unknown): string | undefined {
  const names = (Array.isArray(className) ? className : []).filter((n): n is string => typeof n === 'string');
  const own = names.filter((n) => n.startsWith('hljs-')).map((n) => `hl-${n.slice(5)}`);
  if (!own.length) return undefined;
  return [...own, ...names.filter((n) => /^[a-z]+_+$/.test(n)).map((n) => `hl-${n}`)].join(' ');
}

function toReact(nodes: HNode[] | undefined, key: string): ReactNode[] {
  return (nodes ?? []).map((n, i) => {
    if (n.type === 'text') return n.value ?? '';
    if (n.type === 'element') return createElement('span', { key: `${key}.${i}`, className: classOf(n.properties?.className) }, ...toReact(n.children, `${key}.${i}`));
    return null;
  });
}

/**
 * A whole file coloured line by line (the preview panel numbers its lines): coloured as one, so a string or a
 * comment over several lines keeps its colour, then cut at each line break (a part over a break is in each line).
 * Up to this many characters; the panel reads at most 512 KB of a file. Null when it stays plain.
 */
export const LINES_MAX_CHARS = 600_000;
export function highlightLines(language: string, code: string): ReactNode[][] | null {
  if (code.length > LINES_MAX_CHARS || !lowlight.registered(language)) return null;
  const lines: ReactNode[][] = [[]];
  let key = 0;
  const walk = (nodes: HNode[] | undefined, classes: string[]) => {
    for (const n of nodes ?? []) {
      if (n.type === 'element') {
        const own = classOf(n.properties?.className);
        walk(n.children, own ? [...classes, own] : classes);
      } else if (n.type === 'text') {
        (n.value ?? '').split('\n').forEach((part, i) => {
          if (i > 0) lines.push([]);
          if (!part) return;
          const k = key++;
          lines[lines.length - 1]!.push(classes.reduceRight<ReactNode>((inner, c, j) => createElement('span', j === 0 ? { key: k, className: c } : { className: c }, inner), part));
        });
      }
    }
  };
  walk(lowlight.highlight(language, code).children as HNode[], []);
  return lines;
}

/** The code coloured, as React nodes; null when it stays plain (not a registered language, or too long). */
export function highlightCode(language: string, code: string): ReactNode[] | null {
  if (code.length > HIGHLIGHT_MAX_CHARS || !lowlight.registered(language)) return null;
  return toReact(lowlight.highlight(language, code).children as HNode[], 'h');
}
