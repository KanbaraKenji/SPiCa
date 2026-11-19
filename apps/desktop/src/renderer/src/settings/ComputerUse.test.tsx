// @vitest-environment jsdom
// 设置 › 常规 › 操作电脑.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SETTINGS, type ShellSettings } from '../../../shared/settings';
import { ComputerUse } from './ComputerUse';

afterEach(cleanup);

const with_ = (c: Partial<ShellSettings['computerUse']>): ShellSettings => ({ ...DEFAULT_SETTINGS, computerUse: { ...DEFAULT_SETTINGS.computerUse, ...c } });
const titles = () => [...document.querySelectorAll('.group-head, .setting-title')].map((e) => e.textContent);

describe('操作电脑 settings', () => {
  it('off by default: only the switch', () => {
    const onChange = vi.fn();
    render(<ComputerUse settings={DEFAULT_SETTINGS} onChange={onChange} />);
    expect(titles()).toEqual(['操作电脑', '允许 Agent 操作电脑']);
    fireEvent.click(screen.getByRole('switch', { name: '允许 Agent 操作电脑' }));
    expect(onChange).toHaveBeenCalledWith({ computerUse: { enabled: true, always: [], denied: [] } });
  });

  it('on: the programs always allowed (each removable), the restricted ones (fixed, and added by exe name)', async () => {
    const onChange = vi.fn();
    const pickFiles = vi.fn(async () => ['D:\\Games\\Game.EXE', 'D:\\notes.txt']);
    render(<ComputerUse settings={with_({ enabled: true, always: [{ exe: 'C:\\Windows\\System32\\notepad.exe', name: '记事本' }], denied: ['old.exe'] })} onChange={onChange} pickFiles={pickFiles} />);
    expect(titles()).toEqual([
      '操作电脑',
      '允许 Agent 操作电脑',
      '始终允许的程序',
      '记事本',
      '受限的程序添加',
      'Spica 自己',
      '证券、交易、加密货币客户端',
      '以管理员身份运行的程序',
      '浏览器',
      '终端、代码编辑器',
      '文件资源管理器、系统设置',
      'old.exe',
    ]);
    fireEvent.click(screen.getByRole('button', { name: '移除 记事本' }));
    expect(onChange).toHaveBeenLastCalledWith({ computerUse: { enabled: true, always: [], denied: ['old.exe'] } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ computerUse: { enabled: true, always: [{ exe: 'C:\\Windows\\System32\\notepad.exe', name: '记事本' }], denied: ['old.exe', 'game.exe'] } }));
  });
});
