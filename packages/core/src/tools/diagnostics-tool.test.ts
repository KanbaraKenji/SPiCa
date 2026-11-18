import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../store/memory.ts';
import { tempDir } from '../testing/helpers.ts';
import { Tracer } from '../trace.ts';
import { createDiagnosticsTool, eslintLinted, parseEslint, parseMypy, parseNodeCheck, parsePyright, parseRuff, parseTsc, pyrightAnalyzed, tscListed } from './diagnostics-tool.ts';
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

describe('what the checkers looked at', () => {
  it('tsc --listFiles: the absolute paths among the diagnostics', () => {
    expect(tscListed("src/a.ts(1,7): error TS2322: x\nC:/p/node_modules/typescript/lib/lib.d.ts\nC:/p/src/a.ts\n")).toEqual(['C:/p/node_modules/typescript/lib/lib.d.ts', 'C:/p/src/a.ts']);
  });
  it('eslint: a file that came back only with “File ignored” was not linted', () => {
    const out = JSON.stringify([
      { filePath: 'D:/p/a.js', messages: [] },
      { filePath: 'D:/p/out/b.js', messages: [{ severity: 1, message: 'File ignored because of a matching ignore pattern. Use "--no-ignore" to override.' }] },
    ]);
    expect(eslintLinted(out)).toEqual(['D:/p/a.js']);
    expect(parseEslint(out)).toEqual([]);
  });
  it('pyright: how many files it analysed', () => {
    expect(pyrightAnalyzed(JSON.stringify({ generalDiagnostics: [], summary: { filesAnalyzed: 0 } }))).toBe(0);
    expect(pyrightAnalyzed('nothing')).toBeUndefined();
  });
});

/** A stand-in checker: prints `out` (with $CWD replaced by where it runs, as the real one names files), exits `code`. */
const standIn = (out: string, code: number) => `const o = ${JSON.stringify(out)}.split('$CWD').join(process.cwd().split(String.fromCharCode(92)).join('/'));\nconsole.log(o);\nprocess.exit(${code});\n`;

async function install(root: string, name: 'typescript' | 'eslint', script: string) {
  const bin = join(root, 'node_modules', name, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: name === 'eslint' ? '9.9.9' : '5.5.5' }));
  await writeFile(join(bin, name === 'eslint' ? 'eslint.js' : 'tsc'), script);
}

describe('get_diagnostics', () => {
  const tool = createDiagnosticsTool();

  it('reads only, so it is not confirmed', () => {
    expect(tool.readOnly).toBe(true);
    expect(tool.irreversible).toBeFalsy();
  });

  it('runs the project’s own tsc and eslint, says which and where, and lists what they say', async () => {
    await mkdir(join(dir, '.git'));
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'tsconfig.json'), '{}');
    await writeFile(join(dir, 'eslint.config.js'), 'module.exports = [];');
    await writeFile(join(dir, 'src', 'a.ts'), 'const n: number = "x";\n');
    await writeFile(join(dir, 'src', 'b.js'), 'console.log(x);\n');
    await install(dir, 'typescript', standIn("src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n$CWD/src/a.ts", 2));
    await install(
      dir,
      'eslint',
      standIn(JSON.stringify([{ filePath: '$CWD/eslint.config.js', messages: [] }, { filePath: '$CWD/src/b.js', messages: [{ line: 1, column: 13, severity: 2, message: "'x' is not defined.", ruleId: 'no-undef' }, { line: 1, column: 1, severity: 1, message: 'Unexpected console statement.', ruleId: 'no-console' }] }]), 1),
    );
    const r = await tool.execute({}, ctx());
    expect(r.isError).toBeFalsy();
    const lines = r.content.replace(/\\/g, '/').split('\n');
    expect(lines[0]).toBe('2 error(s), 1 warning(s)');
    expect(lines[1]).toBe('Checkers: tsc 5.5.5 from node_modules/typescript with tsconfig.json; eslint 9.9.9 from node_modules/eslint with eslint.config.js');
    expect(lines).toContain("src/a.ts:1:7 error Type 'string' is not assignable to type 'number'. [TS2322] (tsc)");
    expect(lines).toContain("src/b.js:1:13 error 'x' is not defined. [no-undef] (eslint)");
    expect(r.content).not.toContain('not checked');
    expect((await tool.execute({ only_errors: true }, ctx())).content).not.toContain('no-console');
    // one file: only what is in it
    const one = await tool.execute({ path: 'src/a.ts' }, ctx());
    expect(one.content).toContain('TS2322');
    expect(one.content).not.toContain('no-undef');
  });

  it('working in a sub-folder of a repository: the checkers at the repository’s root are found', async () => {
    await mkdir(join(dir, '.git'));
    const app = join(dir, 'packages', 'app');
    await mkdir(app, { recursive: true });
    await writeFile(join(dir, 'eslint.config.js'), 'module.exports = [];');
    await writeFile(join(app, 'b.js'), 'console.log(x);\n');
    await install(dir, 'eslint', standIn(JSON.stringify([{ filePath: '$CWD/packages/app/b.js', messages: [{ line: 1, column: 13, severity: 2, message: "'x' is not defined.", ruleId: 'no-undef' }] }]), 1));
    const r = await tool.execute({}, { ...ctx(), cwd: app });
    const text = r.content.replace(/\\/g, '/');
    expect(text.split('\n')[1]).toBe('Checkers: eslint 9.9.9 from ../../node_modules/eslint with ../../eslint.config.js');
    expect(text).toContain("b.js:1:13 error 'x' is not defined. [no-undef] (eslint)");
  });

  it('never above the repository’s root, and outside a repository never above the working folder', async () => {
    // checkers in the folder above: another project's
    await writeFile(join(dir, 'eslint.config.js'), 'module.exports = [];');
    await install(dir, 'eslint', standIn('[]', 0));
    const proj = join(dir, 'proj');
    await mkdir(join(proj, '.git'), { recursive: true });
    await writeFile(join(proj, 'total.js'), 'function f(a) {\n  return a.reduce((s, x) => s + x, 0\n}\n');
    const inRepo = await tool.execute({}, { ...ctx(), cwd: proj });
    expect(inRepo.content.split('\n')[0]).toBe('1 error(s), 0 warning(s)');
    expect(inRepo.content).not.toContain('Checkers:');
    expect(inRepo.content).toMatch(/total\.js:\d+:\d+ error SyntaxError/);
    const plain = join(dir, 'plain');
    await mkdir(plain);
    await writeFile(join(plain, 'total.js'), 'function f(a) {\n  return a.reduce((s, x) => s + x, 0\n}\n');
    const outside = await tool.execute({}, { ...ctx(), cwd: plain });
    expect(outside.content).not.toContain('Checkers:');
    expect(outside.content).toContain('only checked that 1 file(s) parse');
  });

  it('files the checker’s configuration ignores: said so and only checked to parse, never counted as clean', async () => {
    await mkdir(join(dir, '.git'));
    await mkdir(join(dir, 'out'));
    await writeFile(join(dir, 'eslint.config.js'), 'module.exports = [{ ignores: ["out/"] }];');
    await writeFile(join(dir, 'a.js'), 'const a = 1;\n');
    await writeFile(join(dir, 'out', 'total.js'), 'function f(a) {\n  return a.reduce((s, x) => s + x, 0\n}\n');
    // the folder: eslint leaves out/ out of its list; the file itself: it answers “File ignored”
    await install(dir, 'eslint', standIn(JSON.stringify([{ filePath: '$CWD/a.js', messages: [] }, { filePath: '$CWD/eslint.config.js', messages: [] }]), 0));
    const r = await tool.execute({}, ctx());
    expect(r.content.split('\n')[0]).toBe('1 error(s), 0 warning(s)');
    expect(r.content.replace(/\\/g, '/')).toContain('1 JavaScript file(s) not checked by eslint (ignored by its configuration or outside what it lints); only checked that they parse: out/total.js');
    expect(r.content).toMatch(/total\.js:2:\d+ error SyntaxError/);
    await install(dir, 'eslint', standIn(JSON.stringify([{ filePath: '$CWD/out/total.js', messages: [{ severity: 1, message: 'File ignored because of a matching ignore pattern.' }] }]), 0));
    const one = await tool.execute({ path: 'out/total.js' }, ctx());
    expect(one.content.split('\n')[0]).toBe('1 error(s), 0 warning(s)');
    expect(one.content).toContain('not checked by eslint');
  });

  it('a .ts file no tsconfig includes is said so', async () => {
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, 'tsconfig.json'), '{"include":["src"]}');
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(dir, 'loose.ts'), 'export const b = 2;\n');
    await install(dir, 'typescript', standIn('$CWD/src/a.ts', 0));
    const r = await tool.execute({}, ctx());
    expect(r.content.split('\n')[0]).toBe('0 error(s), 0 warning(s)');
    expect(r.content).toContain('1 .ts file(s) not checked by tsc (not included by tsconfig.json): loose.ts');
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
    if (r.content.includes('Checkers:')) return; // this computer has a checker on PATH
    expect(r.content).toMatch(/broken\.py:1:\d+ error SyntaxError/);
    expect(r.content).toContain('only checked that 2 file(s) parse');
  });
});
