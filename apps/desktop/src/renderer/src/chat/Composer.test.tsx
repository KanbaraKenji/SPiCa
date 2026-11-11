// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer, contextText, tokenText } from './Composer';

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
          model: { label: 'deepseek-chat', options: [{ label: 'deepseek-chat', group: 'DeepSeek · sk-0****3f9a', marks: '默认', current: true, onPick: vi.fn() }, { label: 'deepseek-reasoner', group: 'DeepSeek · sk-0****3f9a', current: false, onPick: pickB }] },
          context: { tokens: 23_400, window: 128_000 },
        }}
      />,
    );
    // The ring alone; the numbers are in its hover text.
    expect(screen.getByRole('img', { name: '上下文占用 23.4k / 128k 18%' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /deepseek-chat/ }));
    // One heading per connection. The model in use has the tick, not a word; the tag only says which is the default.
    expect(screen.getAllByText('DeepSeek · sk-0****3f9a')).toHaveLength(1);
    const inUse = screen.getByRole('menuitemradio', { name: /^deepseek-chat/ });
    expect(inUse.textContent).toBe('deepseek-chat默认');
    expect(inUse.getAttribute('aria-checked')).toBe('true');
    expect(inUse.querySelector('.context-item-check svg')).toBeTruthy();
    const other = screen.getByRole('menuitemradio', { name: 'deepseek-reasoner' });
    expect(other.getAttribute('aria-checked')).toBe('false');
    // The other keeps the tick's place, empty, so the two names line up.
    expect(other.querySelector('.context-item-check')).toBeTruthy();
    expect(other.querySelector('.context-item-check svg')).toBeNull();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'deepseek-reasoner' }));
    expect(pickB).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
    // Each item says what it does, the same sentence as on hover.
    expect(screen.getByRole('menuitemradio', { name: /^Manual/ }).textContent).toBe('Manual不可逆操作先确认');
    // The mode in force has the tick.
    expect(screen.getByRole('menuitemradio', { name: /^Manual/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: /^Auto/ }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('menuitemradio', { name: /^Auto/ }).textContent).toBe('Auto不可逆操作直接执行；处理外部内容后的操作仍需确认');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Auto/ }));
    expect(onApproval).toHaveBeenCalledWith('auto');
  });

  it('the menus under the box sit 4px over their button, by the size they are drawn at; the same button again closes', () => {
    const options = ['a', 'b', 'c', 'd'].map((label, i) => ({ label, group: i < 2 ? '甲' : '乙', current: i === 0, onPick: vi.fn() }));
    render(<Composer running={false} onSend={vi.fn()} onStop={vi.fn()} sessionKey="place" tools={{ approval: { mode: 'manual', onChange: vi.fn() }, model: { label: 'a', options } }} />);
    const rect = (top: number, height: number) => ({ left: 500, top, right: 700, bottom: top + height, width: 200, height, x: 500, y: top, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('context-menu') ? rect(0, 172) : this.classList.contains('composer-chip') ? rect(700, 28) : rect(0, 0);
    });
    const model = screen.getByRole('button', { name: /^a/ });
    fireEvent.click(model);
    expect(screen.getByRole('menu').style.top).toBe(`${700 - 4 - 172}px`);
    expect(screen.getByRole('menu').style.left).toBe('500px');
    fireEvent.click(model);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
    expect(screen.getByRole('menu').style.top).toBe(`${700 - 4 - 172}px`);
    spy.mockRestore();
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
    expect(screen.queryByRole('img', { name: /上下文占用/ })).toBeNull();
    expect(screen.queryByTitle(/工作文件夹/)).toBeNull();
  });
});

describe('token counts under the box', () => {
  it('are written in k, the share as a whole percent', () => {
    expect(tokenText(980)).toBe('980');
    expect(tokenText(28_200)).toBe('28.2k');
    expect(tokenText(160_000)).toBe('160k');
    expect(tokenText(1_000)).toBe('1k');
    expect(contextText(28_200, 160_000)).toBe('28.2k / 160k 18%');
    // The same abbreviation as the model list: a window of 1048576 reads 1M, not 1049k.
    expect(tokenText(1_048_576)).toBe('1M');
    expect(tokenText(131_072)).toBe('128k');
    expect(contextText(3_200, 1_048_576)).toBe('3.2k / 1M 0%');
  });

  it('shows the provider beside the model name, both in the hover text', () => {
    render(
      <Composer
        running={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
        sessionKey="prov"
        tools={{ model: { label: 'deepseek-flash', provider: 'DeepSeek', options: [{ label: 'a', current: true, onPick: vi.fn() }, { label: 'b', current: false, onPick: vi.fn() }] } }}
      />,
    );
    const chip = screen.getByRole('button', { name: 'DeepSeek · deepseek-flash' });
    expect(chip.textContent).toBe('DeepSeek · deepseek-flash');
    // Provider, separator and name are separate pieces, so the provider can be cut first and the name kept.
    expect(chip.querySelector('.composer-model-provider')?.textContent).toBe('DeepSeek');
    expect(chip.querySelector('.composer-model-sep')?.textContent).toBe(' · ');
    expect(chip.querySelector('.composer-model-name')?.textContent).toBe('deepseek-flash');
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
    expect(await screen.findByText('当前模型不支持图片')).toBeTruthy();
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '切换模型' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'qwen-vl' }));
    expect(pick).toHaveBeenCalled();
  });

  it('切换模型: an eye after the models that take pictures, always; none on text-only or unknown ones', () => {
    const options = [
      { label: 'deepseek-v4-pro', current: true, images: false, onPick: vi.fn() },
      { label: 'qwen-vl', current: false, images: true, onPick: vi.fn() },
      { label: 'm1', current: false, images: null, onPick: vi.fn() },
    ];
    render(<Composer running={false} onSend={vi.fn()} onStop={vi.fn()} sessionKey="eye1" tools={{ model: { label: 'deepseek-v4-pro', options } }} />);
    fireEvent.click(screen.getByRole('button', { name: /deepseek-v4-pro/ }));
    const eyeOf = (name: RegExp) => screen.getByRole('menuitemradio', { name }).querySelector('.image-mark');
    expect(eyeOf(/^qwen-vl/)?.getAttribute('title')).toBe('支持图片');
    expect(eyeOf(/^deepseek-v4-pro/)).toBeNull();
    expect(eyeOf(/^m1/)).toBeNull();
    expect(screen.queryByText(/不支持图片/)).toBeNull();
  });

  it('切换模型 with a picture waiting: models that take none cannot be picked and say why on hover; without one the menu is as usual', async () => {
    const pickFlash = vi.fn();
    const options = [
      { label: 'deepseek-v4-pro', current: true, images: false, onPick: vi.fn() },
      { label: 'deepseek-flash', current: false, images: false, onPick: pickFlash },
      { label: 'qwen-vl', current: false, images: true, onPick: vi.fn() },
      { label: 'm1', current: false, images: null, onPick: vi.fn() },
    ];
    const off = (name: RegExp) => screen.getByRole('menuitemradio', { name }).getAttribute('aria-disabled') === 'true';
    const { unmount } = render(<Composer running={false} onSend={vi.fn()} onStop={vi.fn()} sessionKey="pic4" tools={{ images: images(false), model: { label: 'deepseek-v4-pro', options } }} />);
    fireEvent.click(screen.getByRole('button', { name: /deepseek-v4-pro/ }));
    expect(off(/^deepseek-flash/)).toBe(false);
    fireEvent.keyDown(window, { key: 'Escape' });
    pasteImage(screen.getByRole('textbox', { name: '消息' }));
    await screen.findByText('当前模型不支持图片');
    fireEvent.click(screen.getByRole('button', { name: '切换模型' }));
    const flash = screen.getByRole('menuitemradio', { name: /^deepseek-flash/ });
    // No words on the item: it cannot be picked, and hovering it says why.
    expect(flash.textContent).toBe('deepseek-flash');
    expect(off(/^deepseek-flash/)).toBe(true);
    expect(flash.getAttribute('title')).toBe('不支持图片');
    fireEvent.click(flash);
    expect(pickFlash).not.toHaveBeenCalled();
    // The one in use stays as it is (the line above the box already says it takes none); unknown ones are offered.
    expect(screen.getByRole('menuitemradio', { name: /^deepseek-v4-pro/ }).textContent).toBe('deepseek-v4-pro');
    expect(off(/^qwen-vl/)).toBe(false);
    expect(off(/^m1/)).toBe(false);
    unmount();
    // Pictures already in the conversation count too.
    render(<Composer running={false} onSend={vi.fn()} onStop={vi.fn()} sessionKey="pic5" tools={{ model: { label: 'deepseek-v4-pro', hasPictures: true, options } }} />);
    fireEvent.click(screen.getByRole('button', { name: /deepseek-v4-pro/ }));
    expect(off(/^deepseek-flash/)).toBe(true);
  });
});

describe('the working folder', () => {
  it('none picked: only the folder button; picked: its name', () => {
    const onPick = vi.fn();
    const { rerender } = render(<Composer running={false} onSend={vi.fn()} onStop={vi.fn()} sessionKey="f1" tools={{ folder: { path: '', name: '', onPick } }} />);
    fireEvent.click(screen.getByRole('button', { name: '选择工作文件夹' }));
    expect(onPick).toHaveBeenCalled();
    rerender(<Composer running={false} onSend={vi.fn()} onStop={vi.fn()} sessionKey="f1" tools={{ folder: { path: 'D:/资料/报价', name: '报价', onPick } }} />);
    expect(screen.getByText('报价')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '选择工作文件夹' })).toBeNull();
  });

  it('a conversation that has not chosen one: 选择工作文件夹 in words, greyed while it runs; once chosen, nothing under the box', () => {
    const onPick = vi.fn();
    const { rerender } = render(<Composer running={false} onSend={vi.fn()} onStop={vi.fn()} sessionKey="f2" tools={{ folder: { path: '', name: '', onPick } }} />);
    const pick = screen.getByRole('button', { name: '选择工作文件夹' });
    expect(pick.textContent).toBe('选择工作文件夹');
    rerender(<Composer running onSend={vi.fn()} onStop={vi.fn()} sessionKey="f2" tools={{ folder: { path: '', name: '', onPick, busy: true } }} />);
    const busy = screen.getByRole('button', { name: '选择工作文件夹' });
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(busy);
    expect(onPick).not.toHaveBeenCalled();
    rerender(<Composer running={false} onSend={vi.fn()} onStop={vi.fn()} sessionKey="f2" tools={{}} />);
    expect(screen.queryByText('报价')).toBeNull();
    expect(screen.queryByTitle(/工作文件夹/)).toBeNull();
    expect(screen.queryByRole('button', { name: '选择工作文件夹' })).toBeNull();
  });
});
