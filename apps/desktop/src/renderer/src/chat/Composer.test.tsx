// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from './Composer';

afterEach(cleanup);

function setup(running = false) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  render(<Composer running={running} onSend={onSend} onStop={onStop} sessionKey={`s-${Math.random()}`} />);
  const box = screen.getByRole('textbox', { name: '消息' });
  return { box, onSend, onStop };
}

describe('Composer', () => {
  it('sends on Enter and clears the box', () => {
    const { box, onSend } = setup();
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('你好', []);
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('does not send while an input method is composing', () => {
    const { box, onSend } = setup();
    fireEvent.change(box, { target: { value: 'nihao' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps Shift+Enter for a new line and ignores blank input', () => {
    const { box, onSend } = setup();
    fireEvent.change(box, { target: { value: '第一行' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '发送' })).toHaveProperty('disabled', true);
  });

  it('shows a stop button while running', () => {
    const { onStop } = setup(true);
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(onStop).toHaveBeenCalled();
  });
});

describe('Composer controls', () => {
  it('attaches picked files, shows them, lets one go, and sends the rest', async () => {
    const onSend = vi.fn();
    render(<Composer running={false} onSend={onSend} onStop={vi.fn()} sessionKey="att" tools={{ pickFiles: async () => ['D:/资料/报价.xlsx', 'D:/资料/纪要.docx'] }} />);
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    expect(await screen.findByText('报价.xlsx')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '移除 纪要.docx' }));
    fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '看看这份报价' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: '消息' }), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('看看这份报价', ['D:/资料/报价.xlsx']);
    expect(screen.queryByText('报价.xlsx')).toBeNull();
  });

  it('switches model and approval from small menus; shows how full the context is', () => {
    const pickB = vi.fn();
    const onApproval = vi.fn();
    render(
      <Composer
        running={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
        sessionKey="ctl"
        tools={{
          approval: { mode: 'manual', onChange: onApproval },
          model: { label: 'deepseek-chat', options: [{ label: 'deepseek-chat', group: 'DeepSeek · 尾号 3f9a', marks: '默认', current: true, onPick: vi.fn() }, { label: 'deepseek-reasoner', group: 'DeepSeek · 尾号 3f9a', current: false, onPick: pickB }] },
          context: { tokens: 23_400, window: 128_000 },
        }}
      />,
    );
    expect(screen.getByRole('img', { name: '上下文已用 2.3 万 / 12.8 万（18%）' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /deepseek-chat/ }));
    // One heading per connection; the tag says which is in use and which is the default.
    expect(screen.getAllByText('DeepSeek · 尾号 3f9a')).toHaveLength(1);
    expect(screen.getByRole('menuitem', { name: /^deepseek-chat/ }).textContent).toBe('deepseek-chat当前 · 默认');
    fireEvent.click(screen.getByRole('menuitem', { name: 'deepseek-reasoner' }));
    expect(pickB).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /每次确认/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '自动批准' }));
    expect(onApproval).toHaveBeenCalledWith('auto');
  });

  it('a single model is plain text; no ring without a context window; no folder once a conversation exists', () => {
    render(
      <Composer
        running={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
        sessionKey="one"
        tools={{ model: { label: 'gpt-mini', options: [{ label: '公司网关 · gpt-mini', current: true, onPick: vi.fn() }] }, }}
      />,
    );
    expect(screen.queryByRole('button', { name: /gpt-mini/ })).toBeNull();
    expect(screen.getByText('gpt-mini')).toBeTruthy();
    expect(screen.queryByRole('img', { name: /上下文已用/ })).toBeNull();
    expect(screen.queryByTitle(/工作文件夹/)).toBeNull();
  });
});

describe('pictures in the input box', () => {
  const pasteImage = (el: HTMLElement, withText = false) =>
    fireEvent.paste(el, {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ arrayBuffer: async () => new ArrayBuffer(4) }) }],
        types: withText ? ['Files', 'text/plain'] : ['Files'],
      },
    });
  const images = (accepted: boolean | null = true) => ({
    fromPaste: vi.fn(async () => ({ path: 'C:/tmp/a.png', url: 'spica-file://f/1' })),
    prepare: vi.fn(async (p: string) => (p.endsWith('.png') ? { path: p, url: 'spica-file://f/2' } : null)),
    accepted,
  });

  it('Ctrl+V with a picture attaches it as a thumbnail; it can be removed; a picture alone can be sent', async () => {
    const onSend = vi.fn();
    const img = images();
    render(<Composer running={false} onSend={onSend} onStop={vi.fn()} sessionKey="pic1" tools={{ images: img }} />);
    pasteImage(screen.getByRole('textbox', { name: '消息' }));
    expect(await screen.findByRole('button', { name: '查看 a.png' })).toBeTruthy();
    expect(img.fromPaste).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).toHaveBeenCalledWith('', ['C:/tmp/a.png']);
    expect(screen.queryByRole('button', { name: '查看 a.png' })).toBeNull();
    pasteImage(screen.getByRole('textbox', { name: '消息' }));
    fireEvent.click(await screen.findByRole('button', { name: '移除 a.png' }));
    expect(screen.queryByRole('button', { name: '查看 a.png' })).toBeNull();
  });

  it('text on the clipboard is pasted as text, the picture left alone', () => {
    const img = images();
    render(<Composer running={false} onSend={vi.fn()} onStop={vi.fn()} sessionKey="pic2" tools={{ images: img }} />);
    pasteImage(screen.getByRole('textbox', { name: '消息' }), true);
    expect(img.fromPaste).not.toHaveBeenCalled();
  });

  it('a model that takes no pictures: one line, a way to switch, and sending waits', async () => {
    const onSend = vi.fn();
    const pick = vi.fn();
    render(
      <Composer
        running={false}
        onSend={onSend}
        onStop={vi.fn()}
        sessionKey="pic3"
        tools={{
          images: images(false),
          model: { label: 'deepseek-v4-pro', options: [{ label: 'deepseek-v4-pro', current: true, onPick: vi.fn() }, { label: 'qwen-vl', current: false, onPick: pick }] },
        }}
      />,
    );
    pasteImage(screen.getByRole('textbox', { name: '消息' }));
    expect(await screen.findByText('当前模型不支持图片，请切换模型。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '切换模型' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'qwen-vl' }));
    expect(pick).toHaveBeenCalled();
  });
});
