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
  it('the avatar row shows the account; the automatic one shows in grey in the box; what is typed is kept on leaving the box, in capitals; the automatic one again is none', () => {
    const p = setup({ autoAccount: 'ALEX.CHEN' });
    const box = screen.getByRole('textbox', { name: '账号' }) as HTMLInputElement;
    expect(box.value).toBe('');
    expect(box.placeholder).toBe('ALEX.CHEN');
    // the avatar row: the account, its letter on the sidebar's colour
    expect(screen.getAllByText('ALEX.CHEN').length).toBe(1);
    expect(screen.getByText('A').classList.contains('account-avatar')).toBe(true);
    // the account alone on the left: no grey line
    expect(document.querySelector('.setting-row .settings-hint')).toBeNull();
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

  it('a typed account shows in the avatar row; the button tip says what comes back, and 恢复自动 goes back to it', () => {
    const p = setup({ autoAccount: 'ALEX.CHEN', settings: { ...DEFAULT_SETTINGS, account: 'CHEN.A' } });
    expect((screen.getByRole('textbox', { name: '账号' }) as HTMLInputElement).value).toBe('CHEN.A');
    expect(screen.getByText('CHEN.A')).toBeTruthy();
    expect(screen.getByRole('button', { name: '恢复自动' }).title).toBe('恢复为 ALEX.CHEN');
    fireEvent.click(screen.getByRole('button', { name: '恢复自动' }));
    expect(p.onChange).toHaveBeenCalledWith({ account: '' });
  });

  it('none found: says so, no avatar, and can be typed', () => {
    setup();
    expect((screen.getByRole('textbox', { name: '账号' }) as HTMLInputElement).placeholder).toBe('未取到');
    expect(screen.getByText('未取到账号')).toBeTruthy();
    expect(document.querySelector('.account-avatar')).toBeNull();
  });
});

describe('昵称', () => {
  it('from the account in grey; what is typed is kept as typed; 恢复默认 goes back', () => {
    const p = setup({ autoAccount: 'ALEX.CHEN' });
    const box = screen.getByRole('textbox', { name: '昵称' }) as HTMLInputElement;
    expect(box.placeholder).toBe('Alex');
    fireEvent.change(box, { target: { value: ' 小陈 ' } });
    fireEvent.blur(box);
    expect(p.onChange).toHaveBeenCalledWith({ callName: '小陈' });
  });

  it('a typed one: 恢复默认 (its tip says what comes back) clears it', () => {
    const p = setup({ autoAccount: 'ALEX.CHEN', settings: { ...DEFAULT_SETTINGS, callName: '小陈' } });
    expect(screen.getByRole('button', { name: '恢复默认' }).title).toBe('恢复为 Alex');
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(p.onChange).toHaveBeenCalledWith({ callName: '' });
  });

  it('follows a typed account; none at all: no name', () => {
    setup({ autoAccount: 'ALEX.CHEN', settings: { ...DEFAULT_SETTINGS, account: 'CHEN.A' } });
    expect((screen.getByRole('textbox', { name: '昵称' }) as HTMLInputElement).placeholder).toBe('Chen');
    cleanup();
    setup();
    expect((screen.getByRole('textbox', { name: '昵称' }) as HTMLInputElement).placeholder).toBe('不带昵称');
  });
});

