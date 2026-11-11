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

/** Above this a block stays plain: colouring it would hold up the page (measured: see the test). */
export const HIGHLIGHT_MAX_CHARS = 100_000;

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

/** highlight.js class names (hljs-keyword, hljs-title function_) as the page's own (hl-keyword, hl-title). */
function classOf(className: unknown): string | undefined {
  const names = (Array.isArray(className) ? className : []).filter((n): n is string => typeof n === 'string' && n.startsWith('hljs-'));
  return names.length ? names.map((n) => `hl-${n.slice(5)}`).join(' ') : undefined;
}

function toReact(nodes: HNode[] | undefined, key: string): ReactNode[] {
  return (nodes ?? []).map((n, i) => {
    if (n.type === 'text') return n.value ?? '';
    if (n.type === 'element') return createElement('span', { key: `${key}.${i}`, className: classOf(n.properties?.className) }, ...toReact(n.children, `${key}.${i}`));
    return null;
  });
}

/** The code coloured, as React nodes; null when it stays plain (not a registered language, or too long). */
export function highlightCode(language: string, code: string): ReactNode[] | null {
  if (code.length > HIGHLIGHT_MAX_CHARS || !lowlight.registered(language)) return null;
  return toReact(lowlight.highlight(language, code).children as HNode[], 'h');
}
