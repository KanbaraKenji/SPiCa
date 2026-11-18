import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../store/memory.ts';
import { tempDir } from '../testing/helpers.ts';
import { Tracer } from '../trace.ts';
import { createJavaScriptTool } from './javascript-tool.ts';
import type { ToolContext } from './types.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let dir: string;
let cleanup: () => Promise<void>;
let cards: unknown[];
const ctx = (signal = new AbortController().signal): ToolContext => ({
  sessionId: 's',
  parentChain: [],
  cwd: dir,
  signal,
  tracer: new Tracer(new MemoryStore()),
  extractors: [],
  services: {},
  callId: 'call-1',
  emit: (e) => cards.push(e),
});

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  cards = [];
});
afterEach(async () => {
  await cleanup();
});

describe('run_javascript', () => {
  const tool = createJavaScriptTool({ maxOutputChars: 2000 });

  it('is confirmed like a command', () => {
    expect(tool.irreversible).toBe(true);
    expect(tool.summaryParam).toBe('description');
  });

  it('returns the last expression, what it printed, with top-level await', async () => {
    const r = await tool.execute({ code: "console.log('中文', 1 + 1);\nconst x = await Promise.resolve(20);\n({ total: x + 1, list: [1, 2] })" }, ctx());
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/^exit code 0, [\d.]+ s\n/);
    expect(r.content).toContain('Output:\n中文 2');
    expect(r.content).toContain('Result:\n{ total: 21, list: [ 1, 2 ] }');
  });

  it('runs in the working folder; require and await import work', async () => {
    await writeFile(join(dir, 'data.json'), '{"n": 5}');
    const r = await tool.execute({ code: "const p = await import('node:path');\nrequire('./data.json').n + p.basename(process.cwd()).length * 0" }, ctx());
    expect(r.content).toContain('Result:\n5');
  });

  it('reports a thrown error, also after an await, without the evaluator frames', async () => {
    const r = await tool.execute({ code: "console.log('before');\nthrow new TypeError('bad input')" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('before');
    expect(r.content).toContain('Error:\nTypeError: bad input');
    expect(r.content).not.toMatch(/node:repl|REPLServer/);
    const a = await tool.execute({ code: "await new Promise((_, no) => setTimeout(() => no(new Error('later')), 10))" }, ctx());
    expect(a.isError).toBe(true);
    expect(a.content).toContain('Error: later');
  });

  it('reports a syntax error with its message', async () => {
    const r = await tool.execute({ code: 'const a = ;' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('SyntaxError');
    expect(r.content).toMatch(/SyntaxError: \S/);
  });

  it('keeps nothing between calls', async () => {
    await tool.execute({ code: 'globalThis.kept = 1; var y = 2' }, ctx());
    const r = await tool.execute({ code: 'typeof kept + " " + typeof y' }, ctx());
    expect(r.content).toContain("'undefined undefined'");
  });

  it('waits for what the code started, and is killed at the timeout', async () => {
    const r = await tool.execute({ code: "setTimeout(() => console.log('late'), 300); 'now'" }, ctx());
    expect(r.content).toContain('late');
    expect(r.content).toContain("'now'");
    const t0 = Date.now();
    const t = await tool.execute({ code: 'setInterval(() => {}, 1000); 1', timeout_seconds: 1 }, ctx());
    expect(t.isError).toBe(true);
    expect(t.content).toMatch(/^timed out after 1 s/);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it('is stopped when the user interrupts', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const r = await tool.execute({ code: 'while (true) {}' }, ctx(ac.signal));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^stopped: the user interrupted it/);
  });

  it('files it writes become cards', async () => {
    const r = await tool.execute({ code: "require('fs').writeFileSync('out.txt', 'hi'); 'ok'" }, ctx());
    expect(existsSync(join(dir, 'out.txt'))).toBe(true);
    expect(r.content).toContain('out.txt');
    expect(cards.some((c) => (c as { type: string }).type === 'file.card')).toBe(true);
  });

  it('runs in a sub-folder given as cwd', async () => {
    await mkdir(join(dir, 'sub'));
    const r = await tool.execute({ code: "require('path').basename(process.cwd())", cwd: 'sub' }, ctx());
    expect(r.content).toContain("'sub'");
  });

  it('does not see secret-looking variables', async () => {
    process.env.SPICA_TEST_API_KEY = 'nope';
    try {
      const r = await tool.execute({ code: 'String(process.env.SPICA_TEST_API_KEY)' }, ctx());
      expect(r.content).toContain("'undefined'");
    } finally {
      delete process.env.SPICA_TEST_API_KEY;
    }
  });
});
