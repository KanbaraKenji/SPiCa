// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { PreviewFile } from '../../../shared/bridge';
import type { PluginView } from '../../../shared/plugin-view';
import { PluginFrame, type PluginFrameProps, type PreviewHooks } from './PluginFrame';
import { PluginPreview, type PluginPreviewProps } from './PluginPreview';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const view: PluginView = { plugin: 'office-preview', pluginTitle: 'Office 预览', id: 'docx', title: 'Word 原样预览', placement: 'preview', entry: 'ui/docx.html', tools: [], preview: { extensions: ['.docx'], maxBytes: 30 * 1024 * 1024 } };
const base = { theme: { mode: 'light' as const, vars: {} }, changed: 0, call: vi.fn(), cancel: vi.fn(), confirm: vi.fn(async () => true), notify: vi.fn() };

type Posted = { msg: { reply?: number; result?: unknown; error?: string; event?: { type: string } }; transfer: Transferable[] };

/** What the page says through window.spica, and what the window posts back to it. */
function talk(frame: HTMLIFrameElement) {
  const posted: Posted[] = [];
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((msg: Posted['msg'], _o: string, transfer: Transferable[] = []) => void posted.push({ msg, transfer })) as never);
  const say = async (call: string, id: number, args: object = {}) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { __spica: 1, call, id, args }, source: frame.contentWindow }));
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });
  };
  return { posted, say, replies: () => posted.filter((p) => p.msg.reply !== undefined).map((p) => p.msg) };
}

describe('a preview page’s calls (PluginFrame)', () => {
  const frameWith = (over: Partial<PluginFrameProps> = {}) => {
    const props: PluginFrameProps = { ...base, view, openFile: vi.fn(async () => null), ...over };
    const r = render(<PluginFrame {...props} />);
    return { ...talk(r.container.querySelector('iframe')!), props, rerender: (p: Partial<PluginFrameProps>) => r.rerender(<PluginFrame {...props} {...p} />) };
  };

  it('another page gets no file and may still open its plugin’s files', async () => {
    const t = frameWith();
    await t.say('ready', 0);
    await t.say('previewFile', 1);
    await t.say('openFile', 2, { path: 'notes/a.md' });
    expect(t.replies()).toEqual([
      { __spica: 1, reply: 1, error: '不支持的调用：previewFile' },
      { __spica: 1, reply: 2, result: null },
    ]);
  });

  it('a preview page: its file with the bytes handed over (not copied), ready, fail, an error before drawing; no other files', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const hooks: PreviewHooks = { fileKey: 'a', file: vi.fn(async () => ({ name: '需求说明.docx', size: 3, modifiedAt: '2026-11-11T08:00:00.000Z', extension: '.docx', bytes })), ready: vi.fn(), fail: vi.fn(), error: vi.fn(), loaded: vi.fn() };
    const t = frameWith({ preview: hooks });
    await t.say('ready', 0);
    expect(hooks.loaded).toHaveBeenCalledTimes(1);
    await t.say('previewFile', 1);
    const file = t.posted.find((p) => p.msg.reply === 1)!;
    expect(file.msg.result).toMatchObject({ name: '需求说明.docx', extension: '.docx', bytes });
    expect(file.msg.result).not.toHaveProperty('path');
    expect(file.transfer).toEqual([bytes]);
    await t.say('previewReady', 2);
    expect(hooks.ready).toHaveBeenCalledTimes(1);
    await t.say('previewFail', 3, { text: '这个 Word 文件打不开' });
    await t.say('previewError', 0, { text: 'x is not defined' });
    expect(vi.mocked(hooks.fail).mock.calls).toEqual([['这个 Word 文件打不开']]);
    expect(vi.mocked(hooks.error).mock.calls).toEqual([['x is not defined']]);
    await t.say('openFile', 4, { path: 'D:/工作/a.docx' });
    expect(t.replies().find((r) => r.reply === 4)).toEqual({ __spica: 1, reply: 4, error: '预览页不能打开其他文件。' });
    expect(t.props.openFile).not.toHaveBeenCalled();
  });

  it('another file: the page that is up is told (preview.file)', async () => {
    const hooks: PreviewHooks = { fileKey: 'a', file: vi.fn(), ready: vi.fn(), fail: vi.fn(), error: vi.fn(), loaded: vi.fn() };
    const t = frameWith({ preview: hooks });
    await t.say('ready', 0);
    act(() => t.rerender({ preview: { ...hooks, fileKey: 'b' } }));
    expect(t.posted.filter((p) => p.msg.event?.type === 'preview.file')).toHaveLength(1);
  });
});

describe('a file shown by a plugin page (PluginPreview)', () => {
  const ok: PreviewFile = { ok: true, name: '需求说明.docx', size: 3, modifiedAt: '2026-11-11T08:00:00.000Z', extension: '.docx', bytes: new Uint8Array([1, 2, 3]) };
  const show = async (over: Partial<PluginPreviewProps> = {}) => {
    const props: PluginPreviewProps = { ...base, view, file: { sessionId: 's1', path: 'D:/工作/需求说明.docx' }, loadFile: vi.fn(async () => ok), exists: vi.fn(async () => true), onFallback: vi.fn(), ...over };
    const r = render(<PluginPreview {...props} />);
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    const frame = r.container.querySelector('iframe');
    return { props, frame, ...(frame ? talk(frame) : { posted: [], say: async () => {}, replies: () => [] }) };
  };

  it('too big for the page: not opened, the app’s own with a line saying so; the file is not read', async () => {
    const loadFile = vi.fn(async (): Promise<PreviewFile> => ({ ok: false, problem: 'too-large', size: 40 * 1024 * 1024 }));
    const t = await show({ loadFile });
    expect(t.frame).toBeNull();
    expect(loadFile.mock.calls).toEqual([['s1', 'D:/工作/需求说明.docx', 30 * 1024 * 1024, true]]);
    expect(t.props.onFallback).toHaveBeenCalledWith({ text: '文件超过 30 MB', retry: false });
  });

  it('the page is gone (plugin removed): the app’s own, nothing said', async () => {
    const t = await show({ exists: vi.fn(async () => false) });
    expect(t.frame).toBeNull();
    expect(t.props.onFallback).toHaveBeenCalledWith({ text: null, retry: false });
  });

  it('the page gets the file’s bytes and says it is drawn: nothing else happens, even after 15 seconds', async () => {
    vi.useFakeTimers();
    const t = await show();
    await t.say('ready', 0);
    await t.say('previewFile', 1);
    expect(t.replies()[0]).toMatchObject({ reply: 1, result: { name: '需求说明.docx', size: 3 } });
    expect(new Uint8Array((t.replies()[0]!.result as { bytes: ArrayBuffer }).bytes)).toEqual(new Uint8Array([1, 2, 3]));
    await t.say('previewReady', 2);
    act(() => void vi.advanceTimersByTime(20_000));
    expect(t.props.onFallback).not.toHaveBeenCalled();
  });

  it('not drawn within 15 seconds of loading: the app’s own, with 重试', async () => {
    vi.useFakeTimers();
    const t = await show();
    await t.say('ready', 0);
    act(() => void vi.advanceTimersByTime(14_000));
    // The page loads again (location.reload after preview.file): it gets its 15 seconds again.
    await t.say('ready', 0);
    act(() => void vi.advanceTimersByTime(14_000));
    expect(t.props.onFallback).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(2_000));
    expect(t.props.onFallback).toHaveBeenCalledWith({ text: '「Word 原样预览」打开超时', retry: true });
  });

  it('the page says it cannot: the app’s own with its words, once', async () => {
    const t = await show();
    await t.say('ready', 0);
    await t.say('previewFail', 1, { text: '这个 Word 文件打不开：zip 损坏' });
    await t.say('previewError', 0, { text: 'later' });
    expect(vi.mocked(t.props.onFallback).mock.calls).toEqual([[{ text: '「Word 原样预览」：这个 Word 文件打不开：zip 损坏', retry: true }]]);
  });

  it('its script errs before drawing: the app’s own, saying the page failed (the browser hides the details)', async () => {
    const t = await show();
    await t.say('ready', 0);
    await t.say('previewError', 0, { text: 'Script error.' });
    expect(t.props.onFallback).toHaveBeenCalledWith({ text: '「Word 原样预览」出错', retry: true });
  });
});
