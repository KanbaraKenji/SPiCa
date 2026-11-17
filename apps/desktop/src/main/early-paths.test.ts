// Nothing in the main process takes a folder from Electron (app.getPath) before the settings folder is final.
// main/index.ts moves it with app.setPath('userData', …) for SPICA_USER_DATA and for a screenshot run's temp folder;
// a path worked out before that line points into the installed Spica's folder instead (it happened: the app's own
// Python went to %APPDATA%\Spica\python in a development run with SPICA_USER_DATA). Paths are worked out after it,
// or inside functions, which run when they are used.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const main = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');

/**
 * The file's top-level statements that run before `marker` (function bodies are left out: they run when called).
 * A statement starts at column 0 and ends at the line that closes it (a `;` at the end, brackets balanced).
 */
export function topLevelBefore(source: string, marker: string): string[] {
  const lines = source.slice(0, source.indexOf(marker)).split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!/^[A-Za-z_$]/.test(line)) {
      i++;
      continue;
    }
    // a function declaration (or a class): skip to its closing brace at column 0
    if (/^(export\s+)?(async\s+)?(function|class)\b/.test(line)) {
      while (i < lines.length && !/^\}/.test(lines[i]!)) i++;
      i++;
      continue;
    }
    if (/^import\b/.test(line)) {
      while (i < lines.length && !/;\s*$/.test(lines[i]!)) i++;
      i++;
      continue;
    }
    const stmt: string[] = [];
    let depth = 0;
    for (; i < lines.length; i++) {
      stmt.push(lines[i]!);
      for (const ch of lines[i]!) depth += ch === '(' || ch === '{' || ch === '[' ? 1 : ch === ')' || ch === '}' || ch === ']' ? -1 : 0;
      if (depth <= 0 && /;\s*$/.test(lines[i]!)) break;
    }
    i++;
    out.push(stmt.join('\n'));
  }
  return out;
}

const SET_USER_DATA = "app.setPath('userData', process.env.SPICA_USER_DATA)";

describe('folders are taken after the settings folder is final', () => {
  it('main/index.ts: no top-level statement before setPath(userData) calls app.getPath', () => {
    expect(main).toContain(SET_USER_DATA);
    const early = topLevelBefore(main, SET_USER_DATA).filter((s) => /\bapp\.getPath\(/.test(s));
    expect(early).toEqual([]);
  });

  it('the check catches the way it went wrong (a constant worked out at load) and lets a function through', () => {
    const before = [
      'const UV = 1;',
      'const PYTHON_ROOT =',
      "  isPackaged ? 'x' : join(app.getPath('userData'), 'python');",
      'function pythonRoot(): string {',
      "  return join(app.getPath('userData'), 'python');",
      '}',
      `if (process.env.SPICA_USER_DATA) ${SET_USER_DATA};`,
    ].join('\n');
    const early = topLevelBefore(before, SET_USER_DATA).filter((s) => /\bapp\.getPath\(/.test(s));
    expect(early).toHaveLength(1);
    expect(early[0]).toContain('PYTHON_ROOT');
  });

  it('the app’s Python folder is worked out when it is used', () => {
    expect(main).toMatch(/function pythonRoot\(\): string \{/);
    expect(main).toContain('root: pythonRoot(),');
  });
});
