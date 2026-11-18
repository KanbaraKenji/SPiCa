import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../store/memory.ts';
import { tempDir } from '../testing/helpers.ts';
import { Tracer } from '../trace.ts';
import { createDiagnosticsTool, parseEslint, parseMypy, parseNodeCheck, parsePyright, parseRuff, parseTsc } from './diagnostics-tool.ts';
import type { ToolContext } from './types.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let dir: string;
let cleanup: () => Promise<void>;
const ctx = (signal = new AbortController().signal): ToolContext => ({
  sessionId: 's',
  parentChain: [],
  cwd: dir,
  signal,
  tracer: new Tracer(new MemoryStore()),
  extractors: [],
  services: {},
  callId: 'call-1',
  emit: () => {},
});

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

describe('what each checker says', () => {
  it('tsc, with a message over several lines', () => {
    const out = "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n  The expected type comes from here.\nsrc/b.ts(1,1): error TS1005: ';' expected.\n";
    const d = parseTsc(out, 'D:/p');
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ line: 3, column: 7, severity: 'error', code: 'TS2322', source: 'tsc' });
    expect(d[0]!.message).toContain('The expected type comes from here.');
    expect(d[0]!.file.replace(/\\/g, '/')).toBe('D:/p/src/a.ts');
  });
  it('eslint json: severity 2 is an error, 1 a warning', () => {
    const d = parseEslint(JSON.stringify([{ filePath: 'D:/p/a.js', messages: [{ line: 2, column: 5, severity: 2, message: "'x' is not defined.", ruleId: 'no-undef' }, { line: 4, column: 1, severity: 1, message: 'Unexpected console', ruleId: 'no-console' }] }]));
    expect(d.map((x) => [x.severity, x.code])).toEqual([['error', 'no-undef'], ['warning', 'no-console']]);
  });
  it('pyright json: lines from 0, information left out', () => {
    const d = parsePyright(JSON.stringify({ generalDiagnostics: [{ file: 'a.py', severity: 'error', message: 'x is not defined', rule: 'reportUndefinedVariable', range: { start: { line: 4, character: 2 } } }, { file: 'a.py', severity: 'information', message: 'i' }] }));
    expect(d).toEqual([{ file: 'a.py', line: 5, column: 3, severity: 'error', message: 'x is not defined', code: 'reportUndefinedVariable', source: 'pyright' }]);
  });
  it('mypy with and without a column and a code', () => {
    const d = parseMypy('a.py:3:5: error: Incompatible types in assignment  [assignment]\nb.py:7: warning: unused "type: ignore" comment\n', 'D:/p');
    expect(d.map((x) => [x.line, x.column, x.severity, x.code])).toEqual([[3, 5, 'error', 'assignment'], [7, 1, 'warning', undefined]]);
  });
  it('ruff json: lint findings are warnings, a file that does not parse an error', () => {
    const d = parseRuff(JSON.stringify([{ filename: 'a.py', code: 'F401', message: '`os` imported but unused', location: { row: 1, column: 8 } }, { filename: 'b.py', code: null, message: 'SyntaxError: Expected an expression', location: { row: 2, column: 4 } }]));
    expect(d.map((x) => [x.severity, x.code])).toEqual([['warning', 'F401'], ['error', undefined]]);
  });
  it('node --check', () => {
    const d = parseNodeCheck("D:\\p\\a.js:3\nconst = 1;\n      ^\n\nSyntaxError: Unexpected token '='\n    at wrapSafe", 'D:\\p\\a.js');
    expect(d).toMatchObject({ line: 3, column: 7, severity: 'error', message: "SyntaxError: Unexpected token '='" });
  });
});

describe('get_diagnostics', () => {
  const tool = createDiagnosticsTool();

  it('reads only, so it is not confirmed', () => {
    expect(tool.readOnly).toBe(true);
    expect(tool.irreversible).toBeFalsy();
  });

  it('runs the project’s own tsc and eslint (stand-ins here) and lists what they say, paths from the working folder', async () => {
    await mkdir(join(dir, 'node_modules', 'typescript', 'bin'), { recursive: true });
    await mkdir(join(dir, 'node_modules', 'eslint', 'bin'), { recursive: true });
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'tsconfig.json'), '{}');
    await writeFile(join(dir, 'eslint.config.js'), 'module.exports = [];');
    await writeFile(join(dir, 'src', 'a.ts'), 'const n: number = "x";\n');
    await writeFile(join(dir, 'src', 'b.js'), 'console.log(x);\n');
    // the stand-ins print what the real ones would, and check what they were asked
    await writeFile(join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), "if (!process.argv.includes('--noEmit')) process.exit(9);\nconsole.log(\"src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\");\nprocess.exit(2);\n");
    await writeFile(
      join(dir, 'node_modules', 'eslint', 'bin', 'eslint.js'),
      `const path = require('path');\nconsole.log(JSON.stringify([{ filePath: path.join(process.cwd(), 'src', 'b.js'), messages: [{ line: 1, column: 13, severity: 2, message: "'x' is not defined.", ruleId: 'no-undef' }, { line: 1, column: 1, severity: 1, message: 'Unexpected console statement.', ruleId: 'no-console' }] }]));\nprocess.exit(1);\n`,
    );
    const r = await tool.execute({}, ctx());
    expect(r.isError).toBeFalsy();
    const lines = r.content.replace(/\\/g, '/').split('\n');
    expect(lines[0]).toBe('2 error(s), 1 warning(s), checked with tsc (tsconfig.json), eslint');
    expect(lines).toContain("src/a.ts:1:7 error Type 'string' is not assignable to type 'number'. [TS2322] (tsc)");
    expect(lines).toContain("src/b.js:1:13 error 'x' is not defined. [no-undef] (eslint)");
    const only = await tool.execute({ only_errors: true }, ctx());
    expect(only.content).not.toContain('no-console');
    // one file: only what is in it
    const one = await tool.execute({ path: 'src/a.ts' }, ctx());
    expect(one.content).toContain('TS2322');
    expect(one.content).not.toContain('no-undef');
  });

  it('without a checker: only checks that JavaScript parses, and says so; TypeScript not checked', async () => {
    await writeFile(join(dir, 'good.js'), 'const a = 1;\nconsole.log(a);\n');
    await writeFile(join(dir, 'bad.mjs'), 'import fs from "fs";\nconst = 2;\n');
    await writeFile(join(dir, 'c.ts'), 'const a: number = 1;\n');
    const r = await tool.execute({}, ctx());
    expect(r.content.split('\n')[0]).toBe('1 error(s), 0 warning(s)');
    expect(r.content).toMatch(/bad\.mjs:2:\d+ error SyntaxError/);
    expect(r.content).toContain('only checked that 2 file(s) parse');
    expect(r.content).toContain('1 .ts file(s) not checked');
  });

  it('a checker installed above the working folder is not used (it belongs to another project)', async () => {
    await mkdir(join(dir, 'node_modules', 'eslint', 'bin'), { recursive: true });
    await writeFile(join(dir, 'eslint.config.js'), 'module.exports = [];');
    await writeFile(join(dir, 'node_modules', 'eslint', 'bin', 'eslint.js'), 'console.log("[]");');
    const proj = join(dir, 'proj');
    await mkdir(proj);
    await writeFile(join(proj, 'total.js'), 'function f(a) {\n  return a.reduce((s, x) => s + x, 0\n}\n');
    const r = await tool.execute({}, { ...ctx(), cwd: proj });
    expect(r.content).not.toContain('eslint');
    expect(r.content).toMatch(/^1 error\(s\)/);
    expect(r.content).toMatch(/total\.js:\d+:\d+ error SyntaxError/);
  });

  it('nothing to check, and a path that is not there', async () => {
    await writeFile(join(dir, 'notes.md'), '# x');
    expect((await tool.execute({}, ctx())).content).toBe('No TypeScript, JavaScript or Python files at ..');
    expect((await tool.execute({ path: 'nope.ts' }, ctx())).isError).toBe(true);
  });

  it('Python without a checker: compiles each file (when this computer has Python)', async () => {
    await writeFile(join(dir, 'ok.py'), 'x = 1\n');
    await writeFile(join(dir, 'broken.py'), 'def f(:\n    pass\n');
    const r = await tool.execute({}, ctx());
    if (r.content.includes('there is no Python on this computer')) return;
    if (/checked with .*(pyright|mypy|ruff)/.test(r.content)) return; // this computer has a checker on PATH
    expect(r.content).toMatch(/broken\.py:1:\d+ error SyntaxError/);
    expect(r.content).toContain('only checked that 2 file(s) parse');
  });
});
