// Test helpers: a real @spica/core runtime (no built-in tools, no model calls
// unless a gateway is given), a plugin manager on a temp root, tool calls.
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleProvider, Runtime } from '@spica/core';
import { runtimeHost } from '../host.ts';
import { PluginManager, type PluginEvent } from '../manager.ts';

export const OUTLOOK_PLUGIN = fileURLToPath(new URL('../../../../plugins/outlook-mail', import.meta.url));
export const EXAMPLE_PLUGIN = fileURLToPath(new URL('../../../../plugins/example-notes', import.meta.url));

export function makeRuntime(baseUrl = 'http://127.0.0.1:9/v1', opts: { cwd?: string } = {}): Runtime {
  return new Runtime({
    providers: [new OpenAICompatibleProvider({ id: 'fake', baseUrl, apiKey: 'test-key-123456', retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } })],
    defaults: { providerId: 'fake', model: 'fake-model', maxTokens: 256 },
    tools: [],
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
}

export interface Rig {
  rt: Runtime;
  pm: PluginManager;
  root: string;
  events: PluginEvent[];
  cleanup(): Promise<void>;
}

/** `endTree`: stopping a server also ends what it started (off unless asked: each stop lists the machine's processes). */
export async function rig(rt = makeRuntime(), opts: { endTree?: boolean } = {}): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'spica-plugins-'));
  const pm = new PluginManager({ host: runtimeHost(rt), root, ...(opts.endTree ? { endTree: true } : {}) });
  const events: PluginEvent[] = [];
  pm.on((e) => events.push(e));
  return {
    rt,
    pm,
    root,
    events,
    async cleanup() {
      await pm.shutdown();
      // Windows: a stopped server's processes can hold the folder a moment longer.
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
}

export function toolNames(rt: Runtime): string[] {
  return rt.tools.list({ providerId: 'fake', serverWebSearch: false }).map((t) => t.spec.name);
}

/** Call a registered tool directly, the way the agent loop would. */
export async function callTool(rt: Runtime, name: string, input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
  const tool = rt.tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.execute(input, {
    sessionId: 'test',
    parentChain: [],
    cwd: tmpdir(),
    signal: new AbortController().signal,
    tracer: rt.tracer,
    extractors: [],
    services: {},
    callId: 'call-1',
    emit() {},
  });
}

export const hookCtx = { session: { id: 'test', role: 'top', title: '' }, runId: 'r1', turn: 1 } as never;

/** Write a small plugin into a temp folder: files maps relative path → content (objects become JSON). */
export async function writePlugin(files: Record<string, string | object>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'spica-src-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

/** Copy the example plugin with a different version (for update tests). */
export async function exampleAt(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'spica-src-'));
  await cp(EXAMPLE_PLUGIN, dir, { recursive: true, filter: (s) => !s.includes('node_modules') });
  const { readFile } = await import('node:fs/promises');
  const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  m.version = version;
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

export function manifest(name: string, extra: Record<string, unknown> = {}): object {
  return { manifest_version: 1, name, version: '1.0.0', description: `${name} test plugin`, author: { name: 'test' }, license: 'MIT', compatibility: { spica: '>=0.1.0' }, ...extra };
}

export async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
