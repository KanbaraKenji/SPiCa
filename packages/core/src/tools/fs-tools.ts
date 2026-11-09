// Built-in file tools: read_file, write_file, edit_file, list_dir, glob, grep.
import { glob as fsGlob, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, dirname } from 'node:path';
import type { Tool, ToolContext } from './types.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'out', '.venv', '__pycache__']);
const MAX_READ_LINES = 2000;
const MAX_READ_CHARS = 200_000;
const MAX_LINE_CHARS = 2000;

function resolvePath(ctx: ToolContext, p: unknown): string {
  const s = String(p ?? '.');
  return isAbsolute(s) ? resolve(s) : resolve(ctx.cwd, s);
}

function display(ctx: ToolContext, abs: string): string {
  const rel = relative(ctx.cwd, abs);
  return rel === '' ? '.' : rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
}

const BOM = String.fromCharCode(0xfeff);

function stripBom(s: string): string {
  return s.startsWith(BOM) ? s.slice(1) : s;
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const readFileTool: Tool = {
  spec: {
    name: 'read_file',
    description:
      'Read a text file. Returns lines prefixed with line numbers. Use offset/limit (1-based line numbers) for large files. ' +
      'Non-text formats are converted to text when an extractor for the file type is installed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the working folder.' },
        offset: { type: 'integer', description: 'First line to return (1-based). Default 1.' },
        limit: { type: 'integer', description: `Max lines to return. Default ${MAX_READ_LINES}.` },
      },
      required: ['path'],
    },
  },
  async execute(input, ctx) {
    const abs = resolvePath(ctx, input.path);
    const info = await stat(abs).catch(() => undefined);
    if (!info) return { content: `File not found: ${display(ctx, abs)}`, isError: true };
    if (info.isDirectory()) return { content: `${display(ctx, abs)} is a folder; use list_dir.`, isError: true };
    let text: string;
    const extractor = ctx.extractors.find((e) => e.extensions.includes(extname(abs).toLowerCase()));
    if (extractor) {
      text = await extractor.extract(abs, ctx.signal);
    } else {
      const buf = await readFile(abs);
      if (isBinary(buf)) {
        return {
          content: `${display(ctx, abs)} is a binary file (${info.size} bytes) and no extractor is installed for "${extname(abs) || 'no extension'}".`,
          isError: true,
        };
      }
      text = stripBom(buf.toString('utf8'));
    }
    const lines = text.split(/\r?\n/);
    const offset = Math.max(1, Number(input.offset ?? 1) || 1);
    const limit = Math.max(1, Number(input.limit ?? MAX_READ_LINES) || MAX_READ_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    let out = '';
    let shown = 0;
    for (let i = 0; i < slice.length; i++) {
      let line = slice[i]!;
      if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}…`;
      const next = `${String(offset + i).padStart(6)}\t${line}\n`;
      if (out.length + next.length > MAX_READ_CHARS) break;
      out += next;
      shown++;
    }
    const total = lines.length;
    const end = offset - 1 + shown;
    const header = `${display(ctx, abs)} (${total} lines, ${info.size} bytes, modified ${info.mtime.toISOString()})`;
    const more = end < total ? `\n[showing lines ${offset}-${end} of ${total}; use offset=${end + 1} to continue]` : '';
    return { content: `${header}\n${out}${more}` };
  },
};

export const writeFileTool: Tool = {
  spec: {
    name: 'write_file',
    description: 'Create or overwrite a text file with the given content. Parent folders are created as needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the working folder.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
    },
  },
  async execute(input, ctx) {
    const abs = resolvePath(ctx, input.path);
    const existed = await stat(abs).then(
      () => true,
      () => false,
    );
    await mkdir(dirname(abs), { recursive: true });
    const content = String(input.content ?? '');
    await writeFile(abs, content, 'utf8');
    return {
      content: `${existed ? 'Overwrote' : 'Created'} ${display(ctx, abs)} (${Buffer.byteLength(content)} bytes).`,
    };
  },
};

export const editFileTool: Tool = {
  spec: {
    name: 'edit_file',
    description:
      'Replace exact text in a file. old_string must match the file exactly (including whitespace) and be unique, ' +
      'unless replace_all is true. Read the file first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  async execute(input, ctx) {
    const abs = resolvePath(ctx, input.path);
    const original = await readFile(abs, 'utf8').catch(() => undefined);
    if (original === undefined) return { content: `File not found: ${display(ctx, abs)}`, isError: true };
    const oldS = String(input.old_string ?? '');
    const newS = String(input.new_string ?? '');
    if (oldS === '') return { content: 'old_string must not be empty; use write_file to create a file.', isError: true };
    if (oldS === newS) return { content: 'old_string and new_string are identical.', isError: true };
    // Files with CRLF line endings: accept LF in the arguments.
    const crlf = original.includes('\r\n') && !oldS.includes('\r\n');
    const target = crlf ? oldS.replace(/\n/g, '\r\n') : oldS;
    const replacement = crlf ? newS.replace(/\n/g, '\r\n') : newS;
    const count = original.split(target).length - 1;
    if (count === 0) return { content: `old_string not found in ${display(ctx, abs)}.`, isError: true };
    if (count > 1 && input.replace_all !== true) {
      return {
        content: `old_string occurs ${count} times in ${display(ctx, abs)}; add more context to make it unique or set replace_all.`,
        isError: true,
      };
    }
    const updated = input.replace_all === true ? original.split(target).join(replacement) : original.replace(target, () => replacement);
    await writeFile(abs, updated, 'utf8');
    return { content: `Edited ${display(ctx, abs)}: ${input.replace_all === true ? count : 1} replacement(s).` };
  },
};

export const listDirTool: Tool = {
  spec: {
    name: 'list_dir',
    description: 'List the entries of a folder (name, type, size, modified time).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Folder path. Default: the working folder.' } },
    },
  },
  async execute(input, ctx) {
    const abs = resolvePath(ctx, input.path ?? '.');
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => undefined);
    if (!entries) return { content: `Folder not found: ${display(ctx, abs)}`, isError: true };
    const rows: string[] = [];
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries.slice(0, 1000)) {
      if (e.isDirectory()) {
        rows.push(`${e.name}/`);
      } else {
        const s = await stat(join(abs, e.name)).catch(() => undefined);
        rows.push(s ? `${e.name}\t${s.size} bytes\t${s.mtime.toISOString()}` : e.name);
      }
    }
    const more = entries.length > 1000 ? `\n[${entries.length - 1000} more entries not shown]` : '';
    return { content: `${display(ctx, abs)} (${entries.length} entries)\n${rows.join('\n')}${more}` };
  },
};

const MAX_GLOB = 500;

export const globTool: Tool = {
  spec: {
    name: 'glob',
    description:
      'Find files by glob pattern (e.g. "**/*.md", "src/**/*.{ts,tsx}"). Skips node_modules and VCS folders. Newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Folder to search in. Default: the working folder.' },
      },
      required: ['pattern'],
    },
  },
  async execute(input, ctx) {
    const base = resolvePath(ctx, input.path ?? '.');
    const found: { path: string; mtime: number }[] = [];
    let truncated = false;
    for await (const rel of fsGlob(String(input.pattern), {
      cwd: base,
      exclude: (name: string) => SKIP_DIRS.has(name.split(/[\\/]/).pop() ?? ''),
    })) {
      if (ctx.signal.aborted) break;
      const abs = join(base, rel);
      const s = await stat(abs).catch(() => undefined);
      if (!s || !s.isFile()) continue;
      found.push({ path: abs, mtime: s.mtimeMs });
      if (found.length >= MAX_GLOB * 4) {
        truncated = true;
        break;
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    const shown = found.slice(0, MAX_GLOB).map((f) => display(ctx, f.path));
    if (shown.length === 0) return { content: `No files match "${String(input.pattern)}" in ${display(ctx, base)}.` };
    const more = found.length > MAX_GLOB || truncated ? `\n[results truncated at ${MAX_GLOB}]` : '';
    return { content: `${shown.length} file(s):\n${shown.join('\n')}${more}` };
  },
};

const MAX_GREP = 200;
const MAX_GREP_FILE_BYTES = 5_000_000;

export const grepTool: Tool = {
  spec: {
    name: 'grep',
    description:
      'Search file contents with a regular expression (JavaScript syntax). Returns path:line: text. ' +
      'Use glob to limit which files are searched (default: all text files).',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression.' },
        path: { type: 'string', description: 'File or folder to search. Default: the working folder.' },
        glob: { type: 'string', description: 'File filter, e.g. "**/*.ts". Default "**/*".' },
        ignore_case: { type: 'boolean' },
        max_results: { type: 'integer', description: `Default ${MAX_GREP}.` },
      },
      required: ['pattern'],
    },
  },
  async execute(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(String(input.pattern), input.ignore_case === true ? 'i' : '');
    } catch (err) {
      return { content: `Invalid regular expression: ${(err as Error).message}`, isError: true };
    }
    const max = Math.max(1, Math.min(2000, Number(input.max_results ?? MAX_GREP) || MAX_GREP));
    const target = resolvePath(ctx, input.path ?? '.');
    const info = await stat(target).catch(() => undefined);
    if (!info) return { content: `Not found: ${display(ctx, target)}`, isError: true };
    const files: string[] = [];
    if (info.isFile()) {
      files.push(target);
    } else {
      for await (const rel of fsGlob(String(input.glob ?? '**/*'), {
        cwd: target,
        exclude: (name: string) => SKIP_DIRS.has(name.split(/[\\/]/).pop() ?? ''),
      })) {
        files.push(join(target, rel));
        if (files.length > 50_000) break;
      }
    }
    const hits: string[] = [];
    let filesWithHits = 0;
    for (const file of files) {
      if (ctx.signal.aborted || hits.length >= max) break;
      const s = await stat(file).catch(() => undefined);
      if (!s || !s.isFile() || s.size > MAX_GREP_FILE_BYTES) continue;
      const buf = await readFile(file).catch(() => undefined);
      if (!buf || isBinary(buf)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      let any = false;
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (re.test(lines[i]!)) {
          any = true;
          const line = lines[i]!.length > 300 ? `${lines[i]!.slice(0, 300)}…` : lines[i]!;
          hits.push(`${display(ctx, file)}:${i + 1}: ${line}`);
        }
      }
      if (any) filesWithHits++;
    }
    if (hits.length === 0) return { content: `No matches for /${String(input.pattern)}/ in ${display(ctx, target)}.` };
    const more = hits.length >= max ? `\n[stopped at ${max} matches]` : '';
    return { content: `${hits.length} match(es) in ${filesWithHits} file(s):\n${hits.join('\n')}${more}` };
  },
};

export const fileTools: Tool[] = [readFileTool, writeFileTool, editFileTool, listDirTool, globTool, grepTool];
