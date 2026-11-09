import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../store/memory.ts';
import { tempDir } from '../testing/helpers.ts';
import { Tracer } from '../trace.ts';
import { createRunCommandTool } from './command-tool.ts';
import type { ToolContext } from './types.ts';

const win = process.platform === 'win32';
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

describe('run_command', () => {
  const tool = createRunCommandTool({ maxOutputChars: 2000 });
  const cmd = (ps: string, sh: string) => (win ? ps : sh);

  it('is marked irreversible so it needs confirmation by default', () => {
    expect(tool.irreversible).toBe(true);
  });

  it('runs in the working folder and returns UTF-8 output with the exit code', async () => {
    const r = await tool.execute({ command: cmd("Write-Output 'hello'; Write-Output '中文输出'; (Get-Location).Path", "echo hello; echo 中文输出; pwd") }, ctx());
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/^exit code 0, [\d.]+ s\n/);
    expect(r.content).toContain('hello');
    expect(r.content).toContain('中文输出');
    expect(r.content.toLowerCase()).toContain(dir.toLowerCase().split(/[\\/]/).pop()!);
  }, 20_000);

  it('reports a non-zero exit code as an error and includes stderr', async () => {
    const r = await tool.execute({ command: cmd("Write-Error 'boom'; exit 3", 'echo boom >&2; exit 3') }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^exit code [13]/);
    expect(r.content).toContain('boom');
  }, 20_000);

  it('kills the command at the timeout', async () => {
    const t0 = Date.now();
    const r = await tool.execute({ command: cmd('Start-Sleep -Seconds 30', 'sleep 30'), timeout_seconds: 1 }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^timed out after 1 s/);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it('is killed when the user interrupts', async () => {
    const ac = new AbortController();
    const p = tool.execute({ command: cmd('Start-Sleep -Seconds 30', 'sleep 30') }, ctx(ac.signal));
    setTimeout(() => ac.abort(), 800);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^stopped: the user interrupted it/);
  }, 20_000);

  it('spills long output to a file and returns head and tail', async () => {
    const spill = join(dir, 'spill');
    const t = createRunCommandTool({ maxOutputChars: 2000, spillDir: spill });
    const r = await t.execute({ command: cmd('1..5000 | ForEach-Object { "line $_" }', 'seq 1 5000 | sed "s/^/line /"') }, ctx());
    expect(r.content).toContain('line 1\n');
    expect(r.content).toContain('line 5000');
    expect(r.content).toMatch(/characters omitted/);
    const path = /saved to (.+?);/.exec(r.content)![1]!;
    const full = await readFile(path, 'utf8');
    expect(full.split('\n').filter(Boolean)).toHaveLength(5000);
  }, 20_000);
});
