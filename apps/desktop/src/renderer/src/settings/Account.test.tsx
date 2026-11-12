// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import { Account, type AccountProps } from './Account';

afterEach(cleanup);

function setup(over: Partial<AccountProps> = {}) {
  const props: AccountProps = { settings: DEFAULT_SETTINGS, onChange: vi.fn(), ...over };
  render(<Account {...props} />);
  return props;
}

describe('账号', () => {
  it('the automatic account shows in grey; what is typed is kept on leaving the box, in capitals; the automatic one again is none', () => {
    const p = setup({ autoAccount: 'ALEX.CHEN' });
    const box = screen.getByRole('textbox', { name: '账号' }) as HTMLInputElement;
    expect(box.value).toBe('');
    expect(box.placeholder).toBe('ALEX.CHEN');
    expect(screen.getByText(/取自 Windows 用户文件夹名/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '恢复自动' })).toBeNull();
    fireEvent.change(box, { target: { value: ' chen.a ' } });
    // not at each key: plugin processes restart with a new account
    expect(p.onChange).not.toHaveBeenCalled();
    fireEvent.blur(box);
    expect(p.onChange).toHaveBeenCalledWith({ account: 'CHEN.A' });
    expect(box.value).toBe('CHEN.A');
    fireEvent.change(box, { target: { value: 'alex.chen' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    // the same as the automatic one: nothing typed (DEFAULT_SETTINGS has none, so no change)
    expect(p.onChange).toHaveBeenCalledTimes(1);
    expect(box.value).toBe('');
  });

  it('a typed account says what the automatic one is, and 恢复自动 goes back to it', () => {
    const p = setup({ autoAccount: 'ALEX.CHEN', settings: { ...DEFAULT_SETTINGS, account: 'CHEN.A' } });
    expect((screen.getByRole('textbox', { name: '账号' }) as HTMLInputElement).value).toBe('CHEN.A');
    expect(screen.getByText(/自动取到的是 ALEX\.CHEN/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复自动' }));
    expect(p.onChange).toHaveBeenCalledWith({ account: '' });
  });

  it('none found: says so, and can be typed', () => {
    setup();
    expect((screen.getByRole('textbox', { name: '账号' }) as HTMLInputElement).placeholder).toBe('未取到');
    expect(screen.getByText(/没有取到 Windows 用户文件夹名/)).toBeTruthy();
  });
});

describe('称呼', () => {
  it('from the account in grey; what is typed is kept as typed; 恢复默认 goes back', () => {
    const p = setup({ autoAccount: 'ALEX.CHEN' });
    const box = screen.getByRole('textbox', { name: '称呼' }) as HTMLInputElement;
    expect(box.placeholder).toBe('Alex');
    expect(screen.getByText(/不提供给插件/)).toBeTruthy();
    fireEvent.change(box, { target: { value: ' 小陈 ' } });
    fireEvent.blur(box);
    expect(p.onChange).toHaveBeenCalledWith({ callName: '小陈' });
  });

  it('a typed one says what the account gives; 恢复默认 clears it', () => {
    const p = setup({ autoAccount: 'ALEX.CHEN', settings: { ...DEFAULT_SETTINGS, callName: '小陈' } });
    expect(screen.getByText(/不填就用账号里的 Alex/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(p.onChange).toHaveBeenCalledWith({ callName: '' });
  });

  it('follows a typed account; none at all: no name', () => {
    setup({ autoAccount: 'ALEX.CHEN', settings: { ...DEFAULT_SETTINGS, account: 'CHEN.A' } });
    expect((screen.getByRole('textbox', { name: '称呼' }) as HTMLInputElement).placeholder).toBe('Chen');
    cleanup();
    setup();
    expect((screen.getByRole('textbox', { name: '称呼' }) as HTMLInputElement).placeholder).toBe('不带称呼');
  });
});

