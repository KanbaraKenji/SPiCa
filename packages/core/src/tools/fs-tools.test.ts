import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../store/memory.ts';
import { tempDir } from '../testing/helpers.ts';
import { Tracer } from '../trace.ts';
import { editFileTool, globTool, grepTool, listDirTool, readFileTool, writeFileTool } from './fs-tools.ts';
import { validateInput, type ToolContext } from './types.ts';

let dir: string;
let cleanup: () => Promise<void>;
let ctx: ToolContext;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  ctx = {
    sessionId: 's',
    parentChain: [],
    cwd: dir,
    signal: new AbortController().signal,
    tracer: new Tracer(new MemoryStore()),
    extractors: [],
    services: {},
    callId: 'c',
    emit: () => {},
  };
  await mkdir(join(dir, 'src', 'deep'), { recursive: true });
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(dir, 'notes.txt'), 'alpha\nbeta\ngamma\n');
  await writeFile(join(dir, 'src', 'a.ts'), 'export const x = 1;\n// TODO fix\n');
  await writeFile(join(dir, 'src', 'deep', 'b.ts'), 'const todo = "todo";\n');
  await writeFile(join(dir, 'node_modules', 'pkg', 'c.ts'), 'TODO in deps\n');
  await writeFile(join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
});
afterEach(async () => {
  await cleanup();
});

describe('read_file', () => {
  it('returns numbered lines and supports offset/limit', async () => {
    const r = await readFileTool.execute({ path: 'notes.txt', offset: 2, limit: 1 }, ctx);
    expect(r.content).toContain('     2\tbeta');
    expect(r.content).not.toContain('alpha');
    expect(r.content).toContain('use offset=3 to continue');
  });

  it('refuses binary files without an extractor, uses an extractor when present', async () => {
    expect((await readFileTool.execute({ path: 'bin.dat' }, ctx)).isError).toBe(true);
    ctx.extractors.push({ extensions: ['.dat'], extract: async () => 'extracted text' });
    expect((await readFileTool.execute({ path: 'bin.dat' }, ctx)).content).toContain('extracted text');
  });

  it('strips a UTF-8 byte order mark', async () => {
    await writeFile(join(dir, 'bom.txt'), `${String.fromCharCode(0xfeff)}first line\n`);
    const r = await readFileTool.execute({ path: 'bom.txt' }, ctx);
    expect(r.content).toContain('     1\tfirst line');
    expect(r.content).not.toContain(String.fromCharCode(0xfeff));
  });

  it('reports missing files as errors', async () => {
    expect((await readFileTool.execute({ path: 'nope.txt' }, ctx)).isError).toBe(true);
  });
});

describe('write_file / edit_file', () => {
  it('creates parent folders and overwrites', async () => {
    const r1 = await writeFileTool.execute({ path: 'out/new.txt', content: 'one' }, ctx);
    expect(r1.content).toMatch(/^Created/);
    const r2 = await writeFileTool.execute({ path: 'out/new.txt', content: 'two' }, ctx);
    expect(r2.content).toMatch(/^Overwrote/);
    expect(await readFile(join(dir, 'out', 'new.txt'), 'utf8')).toBe('two');
  });

  it('replaces a unique string, rejects ambiguous ones unless replace_all', async () => {
    await writeFile(join(dir, 'e.txt'), 'a b a');
    expect((await editFileTool.execute({ path: 'e.txt', old_string: 'b', new_string: 'B' }, ctx)).isError).toBeFalsy();
    expect((await editFileTool.execute({ path: 'e.txt', old_string: 'a', new_string: 'A' }, ctx)).isError).toBe(true);
    await editFileTool.execute({ path: 'e.txt', old_string: 'a', new_string: 'A', replace_all: true }, ctx);
    expect(await readFile(join(dir, 'e.txt'), 'utf8')).toBe('A B A');
    expect((await editFileTool.execute({ path: 'e.txt', old_string: 'zzz', new_string: 'y' }, ctx)).isError).toBe(true);
  });

  it('matches LF arguments against CRLF files', async () => {
    await writeFile(join(dir, 'crlf.txt'), 'one\r\ntwo\r\n');
    await editFileTool.execute({ path: 'crlf.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' }, ctx);
    expect(await readFile(join(dir, 'crlf.txt'), 'utf8')).toBe('uno\r\ndos\r\n');
  });

  it('treats $ in the replacement literally', async () => {
    await writeFile(join(dir, 'd.txt'), 'price');
    await editFileTool.execute({ path: 'd.txt', old_string: 'price', new_string: "$& $1 $'" }, ctx);
    expect(await readFile(join(dir, 'd.txt'), 'utf8')).toBe("$& $1 $'");
  });
});

describe('list_dir / glob / grep', () => {
  it('lists folders first', async () => {
    const r = await listDirTool.execute({}, ctx);
    const lines = r.content.split('\n').slice(1);
    expect(lines[0]).toBe('node_modules/');
    expect(r.content).toContain('notes.txt');
  });

  it('globs recursively and skips node_modules', async () => {
    const r = await globTool.execute({ pattern: '**/*.ts' }, ctx);
    expect(r.content).toContain(join('src', 'a.ts'));
    expect(r.content).toContain(join('src', 'deep', 'b.ts'));
    expect(r.content).not.toContain('node_modules');
  });

  it('greps with regex, ignore_case and file filter', async () => {
    const r = await grepTool.execute({ pattern: 'todo', ignore_case: true }, ctx);
    expect(r.content).toContain(`${join('src', 'a.ts')}:2: // TODO fix`);
    expect(r.content).toContain(join('src', 'deep', 'b.ts'));
    expect(r.content).not.toContain('node_modules');
    const only = await grepTool.execute({ pattern: 'TODO', glob: 'src/*.ts' }, ctx);
    expect(only.content).toContain('1 match(es) in 1 file(s)');
    expect((await grepTool.execute({ pattern: '(' }, ctx)).isError).toBe(true);
  });
});

describe('validateInput', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' }, n: { type: 'integer' } }, required: ['path'] };
  it('checks required fields and primitive types', () => {
    expect(validateInput(schema, { path: 'a' })).toBeUndefined();
    expect(validateInput(schema, {})).toMatch(/missing required/);
    expect(validateInput(schema, { path: 1 })).toMatch(/should be string/);
    expect(validateInput(schema, { path: 'a', n: 1.5 })).toMatch(/should be integer/);
    expect(validateInput(schema, { __invalid_json__: 'x' })).toMatch(/not valid JSON/);
  });
});
