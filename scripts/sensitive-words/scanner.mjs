// Sensitive-word scanner: pure functions plus a file walker, no dependencies.
// Matching is case-insensitive substring matching. Reports never echo the
// matched word itself (only its list and line number), so private word lists
// do not leak into CI logs.
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

/**
 * Parse a word list. One word per line; blank lines and lines starting
 * with '#' are ignored.
 * @param {string} text
 * @returns {{ word: string, line: number }[]}
 */
export function parseWordList(text) {
  const words = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const word = raw.trim();
    if (word && !word.startsWith('#')) words.push({ word: word.toLowerCase(), line: i + 1 });
  });
  return words;
}

/**
 * @typedef {{ list: string, word: string, line: number }} Entry
 * @typedef {{ line: number, list: string, entryLine: number }} TextHit
 */

/**
 * Find every line of `text` that contains a word.
 * @param {string} text
 * @param {Entry[]} entries
 * @returns {TextHit[]}
 */
export function scanText(text, entries) {
  const hits = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.toLowerCase();
    for (const e of entries) {
      if (line.includes(e.word)) hits.push({ line: i + 1, list: e.list, entryLine: e.line });
    }
  });
  return hits;
}

/** True when the buffer looks binary (contains a NUL byte in the first 8 KiB). */
export function isBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

/**
 * Load word lists from files.
 * @param {string[]} paths
 * @returns {Entry[]}
 */
export function loadLists(paths) {
  const entries = [];
  for (const p of paths) {
    const name = basename(p);
    for (const w of parseWordList(readFileSync(p, 'utf8'))) {
      entries.push({ list: name, word: w.word, line: w.line });
    }
  }
  return entries;
}

/**
 * Scan files (paths relative to `root`). Word-list files themselves are skipped.
 * @param {{ root: string, files: string[], listPaths: string[], entries: Entry[] }} opts
 * @returns {{ file: string, line: number, list: string, entryLine: number }[]}
 */
export function scanFiles({ root, files, listPaths, entries }) {
  const skip = new Set(listPaths.map((p) => resolve(p).toLowerCase()));
  const hits = [];
  for (const file of files) {
    const abs = resolve(root, file);
    if (skip.has(abs.toLowerCase())) continue;
    let buf;
    try {
      buf = readFileSync(abs);
    } catch {
      continue; // deleted or unreadable: not our concern here
    }
    if (isBinary(buf)) continue;
    for (const h of scanText(buf.toString('utf8'), entries)) hits.push({ file, ...h });
  }
  return hits;
}
