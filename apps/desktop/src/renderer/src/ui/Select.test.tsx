// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Select } from './Select';

afterEach(cleanup);

const options = [
  { value: 'a', label: 'demo-chat-large', group: '演示网关（东区）', groupKey: 'east' },
  { value: 'b', label: 'demo-chat-small', group: '演示网关（东区）', groupKey: 'east' },
  { value: 'c', label: 'demo-sonnet', group: '演示模型（本地）', groupKey: 'local' },
  { value: 'gone', label: '插件不可用', disabled: true },
];

describe('the app’s drop-down', () => {
  it('a box with the chosen words and a drawn arrow; open, the app’s menu under it, as wide, grouped, the chosen one ticked and focused', () => {
    render(<Select value="b" options={options} onChange={vi.fn()} label="默认模型" />);
    const box = screen.getByRole('combobox', { name: '默认模型' });
    expect(box.tagName).toBe('BUTTON');
    expect(box.querySelector('.select-value')?.textContent).toBe('demo-chat-small');
    expect(box.querySelector('svg.select-arrow')).toBeTruthy();
    expect(box.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(box);
    const menu = screen.getByRole('menu');
    expect(box.getAttribute('aria-expanded')).toBe('true');
    expect(menu.classList.contains('context-menu')).toBe(true);
    expect([...menu.querySelectorAll('.context-group')].map((g) => g.textContent)).toEqual(['演示网关（东区）', '演示模型（本地）']);
    expect(menu.querySelector('[aria-checked="true"]')?.textContent).toBe('demo-chat-small');
    expect(document.activeElement?.textContent).toBe('demo-chat-small');
    expect(screen.getByRole('menuitemradio', { name: '插件不可用' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('keys: Down on the box opens it; Down and Enter pick; Esc closes the list only, the focus back on the box', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Select value="a" options={options} onChange={onChange} label="默认模型" />);
    const box = screen.getByRole('combobox', { name: '默认模型' });
    act(() => box.focus());
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    act(() => vi.runAllTimers());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(box);
    fireEvent.click(box);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('demo-chat-small');
    fireEvent.click(document.activeElement!);
    act(() => vi.runAllTimers());
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(box);
    vi.useRealTimers();
  });

  it('picking the one already chosen changes nothing; a value that is none of the options shows the placeholder', () => {
    const onChange = vi.fn();
    render(<Select value="" options={options} onChange={onChange} label="服务商" placeholder="选择服务商" />);
    const box = screen.getByRole('combobox', { name: '服务商' });
    expect(box.querySelector('.select-value.is-placeholder')?.textContent).toBe('选择服务商');
    cleanup();
    render(<Select value="a" options={options} onChange={onChange} label="默认模型" />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'demo-chat-large' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

