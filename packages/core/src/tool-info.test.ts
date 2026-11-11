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

  it('a removed plugin tool still counts as a plugin step', () => {
    const rt = makeRuntime(gw);
    const off = rt.tools.register(pluginTool, 'plugin:notes');
    off();
    expect(rt.tools.categoryOf('notes__list')).toBe('plugin');
    expect(rt.tools.categoryOf('write_file')).toBe('write');
    expect(rt.tools.categoryOf('never_there')).toBe('other');
  });
});
