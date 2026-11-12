// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PluginFrame, type PluginFrameProps } from './PluginFrame';
import type { PluginView, PluginViewResult } from '../../../shared/plugin-view';

afterEach(cleanup);

const view = { plugin: 'notes', id: 'board', title: 'Notebook', pluginTitle: 'Notes', entry: 'views/board.html' } as PluginView;

function setup(over: Partial<PluginFrameProps> = {}) {
  // Each call stays open until the test settles it, like a long-running tool.
  const open: { callId: string; tool: string; confirmed: boolean; settle(r: PluginViewResult): void }[] = [];
  const props: PluginFrameProps = {
    view,
    theme: { mode: 'light', vars: {} },
    changed: 0,
    call: vi.fn((tool: string, _args: unknown, confirmed: boolean, callId: string) => new Promise<PluginViewResult>((settle) => open.push({ callId, tool, confirmed, settle }))),
    cancel: vi.fn(),
    confirm: vi.fn(async () => true),
    openFile: vi.fn(async () => null),
    notify: vi.fn(),
    ...over,
  };
  const r = render(<PluginFrame {...props} />);
  const frame = r.container.querySelector('iframe') as HTMLIFrameElement;
  const posted: { reply?: number; result?: PluginViewResult; error?: string }[] = [];
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((m: { reply?: number }) => void posted.push(m)) as never);
  // What the page's window.spica sends.
  const say = async (call: string, id: number, args: object = {}) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { __spica: 1, call, id, args }, source: frame.contentWindow }));
      await Promise.resolve();
    });
  };
  const settle = async (i: number, result: PluginViewResult) => {
    await act(async () => {
      open[i]!.settle(result);
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const replies = () => posted.filter((m) => m.reply !== undefined);
  return { props, open, say, settle, replies, unmount: r.unmount };
}

describe('a plugin page’s tool calls can be stopped', () => {
  it('each call goes out with its own id; one that comes back is answered and nothing is stopped', async () => {
    const t = setup();
    await t.say('ready', 0);
    await t.say('callTool', 1, { tool: 'list_notes', args: {} });
    await t.say('callTool', 2, { tool: 'list_notes', args: {} });
    expect(t.open).toHaveLength(2);
    expect(t.open[0]!.callId).toMatch(/^[\w-]{1,64}$/);
    expect(t.open[0]!.callId).not.toBe(t.open[1]!.callId);
    await t.settle(0, { content: 'ok', isError: false });
    expect(t.replies()).toEqual([{ __spica: 1, reply: 1, result: { content: 'ok', isError: false } }]);
    expect(t.props.cancel).not.toHaveBeenCalled();
  });

  it('closing the page stops the calls still running, and only those', async () => {
    const t = setup();
    await t.say('ready', 0);
    await t.say('callTool', 1, { tool: 'slow', args: {} });
    await t.say('callTool', 2, { tool: 'slow', args: {} });
    await t.settle(0, { content: 'done', isError: false });
    t.unmount();
    expect(vi.mocked(t.props.cancel).mock.calls).toEqual([[t.open[1]!.callId]]);
  });

  it('the page loading again stops what the page before it started; a late answer is not handed to the new page', async () => {
    const t = setup();
    await t.say('ready', 0);
    await t.say('callTool', 1, { tool: 'slow', args: {} });
    await t.say('ready', 0);
    expect(vi.mocked(t.props.cancel).mock.calls).toEqual([[t.open[0]!.callId]]);
    // The new page numbers its calls from the start: its call 1 must not get the old call's answer.
    await t.say('callTool', 1, { tool: 'quick', args: {} });
    await t.settle(0, { content: '[CANCELLED] stopped', isError: true });
    expect(t.replies()).toEqual([]);
    await t.settle(1, { content: 'new', isError: false });
    expect(t.replies()).toEqual([{ __spica: 1, reply: 1, result: { content: 'new', isError: false } }]);
    expect(t.props.cancel).toHaveBeenCalledTimes(1);
  });

  it('an irreversible tool asks first and then runs as a second call with its own id; closed while the question is open, nothing runs', async () => {
    let answer!: (ok: boolean) => void;
    const t = setup({ confirm: vi.fn(() => new Promise<boolean>((r) => (answer = r))) });
    await t.say('ready', 0);
    await t.say('callTool', 1, { tool: 'delete_note', args: { id: 'n-7' } });
    await t.settle(0, { content: '[CONFIRM_REQUIRED] delete_note', isError: true });
    // With what it would run with, so the question can show it.
    expect(t.props.confirm).toHaveBeenCalledWith('delete_note', { id: 'n-7' });
    await act(async () => {
      answer(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(t.open).toHaveLength(2);
    expect(t.open[1]).toMatchObject({ tool: 'delete_note', confirmed: true });
    expect(t.open[1]!.callId).not.toBe(t.open[0]!.callId);

    const u = setup({ confirm: vi.fn(() => new Promise<boolean>((r) => (answer = r))) });
    await u.say('ready', 0);
    await u.say('callTool', 1, { tool: 'delete_note', args: {} });
    await u.settle(0, { content: '[CONFIRM_REQUIRED] delete_note', isError: true });
    u.unmount();
    await act(async () => {
      answer(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(u.open).toHaveLength(1);
  });
});

describe('a page asks for the system’s pickers (window.spica.pickFolder / pickFile)', () => {
  it('the path picked goes back to the page, null when cancelled; the plugin’s name goes with the ask', async () => {
    const answers: (string | null)[] = ['D:/Notes', null, 'D:/a.md'];
    const pick = vi.fn(async () => answers.shift() ?? null);
    const t = setup({ pick });
    await t.say('ready', 0);
    await t.say('pickFolder', 1, { title: '选择笔记文件夹', defaultPath: 'D:/Old', other: 1 });
    await t.say('pickFolder', 2, {});
    await t.say('pickFile', 3, { extensions: ['.md', 4] });
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });
    expect(pick.mock.calls).toEqual([
      [{ kind: 'folder', plugin: 'Notes', title: '选择笔记文件夹', defaultPath: 'D:/Old' }],
      [{ kind: 'folder', plugin: 'Notes' }],
      [{ kind: 'file', plugin: 'Notes', extensions: ['.md'] }],
    ]);
    expect(t.replies()).toEqual([
      { __spica: 1, reply: 1, result: 'D:/Notes' },
      { __spica: 1, reply: 2, result: null },
      { __spica: 1, reply: 3, result: 'D:/a.md' },
    ]);
  });

  it('a preview page may not pick; a window that offers no picker says so', async () => {
    const pick = vi.fn(async () => 'D:/x');
    const preview = { fileKey: 'a', file: vi.fn(), ready: vi.fn(), fail: vi.fn(), error: vi.fn(), loaded: vi.fn() };
    const p = setup({ pick, preview });
    await p.say('ready', 0);
    await p.say('pickFolder', 1);
    expect(p.replies()).toEqual([{ __spica: 1, reply: 1, error: '预览页不能选择文件或文件夹。' }]);
    expect(pick).not.toHaveBeenCalled();
    cleanup();
    const none = setup();
    await none.say('ready', 0);
    await none.say('pickFile', 1);
    expect(none.replies()).toEqual([{ __spica: 1, reply: 1, error: '不支持的调用：pickFile' }]);
  });
});
