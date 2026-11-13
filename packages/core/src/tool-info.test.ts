// What kind of step each tool call is (for the window's summaries) and the
// model's one-line description of a command: on tool.start, kept in the
// tool_results message (so a reopened conversation shows the same), and in
// the exported usage log.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { captureEvents, makeRuntime, startGateway, tempDir } from './testing/helpers.ts';
import type { Tool } from './tools/types.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

const pluginTool: Tool = {
  spec: { name: 'notes__list', description: 'list notes', inputSchema: { type: 'object', properties: { description: { type: 'string' } } } },
  title: 'List notes',
  readOnly: true,
  async execute() {
    return { content: 'two notes' };
  },
};

describe('tool call info', () => {
  it('gives each call its category, the command description, and a plugin tool its title', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    rt.tools.register(pluginTool, 'plugin:notes');
    const events = captureEvents(rt);
    const s = rt.createSession({ cwd: dir, approvalMode: 'auto' });
    gw.enqueue(
      {
        toolCalls: [
          { id: 'c1', name: 'list_dir', args: {} },
          { id: 'c2', name: 'run_command', args: { command: 'echo hi', description: '  看一下命令能不能跑  ' } },
          { id: 'c3', name: 'notes__list', args: { description: 'not a summary: a parameter of the plugin' } },
          { id: 'c4', name: 'no_such_tool', args: {} },
        ],
      },
      { text: 'done' },
    );
    await s.send('go').done;
    const starts = events.filter((e) => e.type === 'tool.start');
    expect(starts.map((e) => e.type === 'tool.start' && [e.callId, e.category, e.summary, e.title])).toEqual([
      ['c1', 'read', undefined, undefined],
      ['c2', 'command', '看一下命令能不能跑', undefined],
      ['c3', 'plugin', undefined, 'List notes'],
    ]);
    const results = s.messages().find((m) => m.kind === 'tool_results')!;
    expect(results.meta?.toolInfo).toEqual({
      c1: { category: 'read' },
      c2: { category: 'command', summary: '看一下命令能不能跑' },
      c3: { category: 'plugin', title: 'List notes' },
      c4: { category: 'other' }, // never ran: still listed, so the group adds up
    });
    const log = await rt.exportUsageLog({});
    expect(log).toContain('"toolInfo"');
    await rt.close();
  });

  it('file cards of what the round made reach the message: written, then handed over with present_files', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    const s = rt.createSession({ cwd: dir });
    gw.enqueue(
      { toolCalls: [{ id: 'w', name: 'write_file', args: { path: 'out.md', content: 'a\nb\n' } }] },
      { toolCalls: [{ id: 'p', name: 'present_files', args: { paths: ['out.md'] } }] },
      { text: 'done' },
    );
    await s.send('make it').done;
    const results = s.messages().filter((m) => m.kind === 'tool_results');
    expect(results[0]!.meta?.fileCards?.w).toMatchObject({ name: 'out.md', origin: 'created', lines: { added: 2, removed: 0 } });
    expect(results[1]!.meta?.fileCardLists?.p?.map((c) => c.origin)).toEqual(['created']); // the round's start came from the session
    expect(results[1]!.meta?.toolInfo?.p).toEqual({ category: 'present' });
    expect(s.info().regenerate?.code).toBe('regenerate.wrote_files'); // present_files changes nothing; the write still counts
    await rt.close();
  });

  it('where an edit changed the file (its line numbers and the lines around it) is kept for the window, never sent to the model, before or after reopening', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { MemoryStore } = await import('./store/memory.ts');
    // The line next to the edit holds a marker the model never saw: only the window's change data could carry it.
    await writeFile(join(dir, 'notes.md'), 'one\nNEIGHBOUR-MARKER-7f3a\nprice: 10\nfour\n');
    const store = new MemoryStore();
    const rt = makeRuntime(gw, { cwd: dir, store });
    const s = rt.createSession({ cwd: dir, approvalMode: 'auto' });
    gw.enqueue({ toolCalls: [{ id: 'e', name: 'edit_file', args: { path: 'notes.md', old_string: 'price: 10', new_string: 'price: 12' } }] }, { text: 'done' }, { text: 'again' });
    await s.send('change the price').done;
    const card = s.messages().find((m) => m.kind === 'tool_results')!.meta?.fileCards?.e;
    expect(card?.change?.hunks[0]).toEqual({ oldStart: 1, newStart: 1, lines: [' one', ' NEIGHBOUR-MARKER-7f3a', '-price: 10', '+price: 12', ' four'] });
    await s.send('and now').done;
    expect(gw.requests.length).toBe(3);
    for (const r of gw.requests) expect(JSON.stringify(r.body)).not.toContain('NEIGHBOUR-MARKER');
    await rt.close();

    const rt2 = makeRuntime(gw, { cwd: dir, store });
    rt2.restore();
    const again = rt2.session(s.id)!;
    expect(again.messages().find((m) => m.kind === 'tool_results')!.meta?.fileCards?.e?.change?.hunks).toHaveLength(1);
    gw.enqueue({ text: 'reopened' });
    await again.send('one more').done;
    expect(JSON.stringify(gw.requests.at(-1)!.body)).not.toContain('NEIGHBOUR-MARKER');
    expect(JSON.stringify(gw.requests.at(-1)!.body)).toContain('Edited notes.md: 1 replacement(s).');
    await rt2.close();
  });

  it('a removed plugin tool still counts as a plugin step', () => {
    const rt = makeRuntime(gw);
    const off = rt.tools.register(pluginTool, 'plugin:notes');
    off();
    expect(rt.tools.categoryOf('notes__list')).toBe('plugin');
    expect(rt.tools.categoryOf('write_file')).toBe('write');
    expect(rt.tools.categoryOf('never_there')).toBe('other');
  });
});
