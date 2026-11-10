// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import { General, rangeStart, type GeneralProps } from './General';
import { dropAllDrafts } from './drafts';

afterEach(() => {
  cleanup();
  dropAllDrafts();
});

const now = new Date('2026-11-09T15:30:00+08:00');

function setup(over: Partial<GeneralProps> = {}) {
  const props: GeneralProps = {
    settings: DEFAULT_SETTINGS,
    onChange: vi.fn(),
    workflows: { run: vi.fn(async () => ({ dir: 'C:\\Spica\\workflows', names: [], problems: [] })) },
    pickFolder: vi.fn(async () => null),
    onBackendRestarted: () => () => {},
    projects: [
      { id: 'p-review', name: '新品样机评审' },
      { id: 'p-budget', name: '年度预算' },
    ],
    exportUsageLog: vi.fn(async () => ({ file: 'C:\\Users\\me\\Documents\\Spica\\使用日志-20261109.jsonl', records: 1234 })),
    showInFolder: vi.fn(),
    now,
    ...over,
  };
  render(<General {...props} />);
  return props;
}

describe('导出使用日志', () => {
  it('exports one project for a time range and says how many records went where', async () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /全部项目/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '年度预算' }));
    fireEvent.click(screen.getByRole('radio', { name: '最近 7 天' }));
    fireEvent.click(screen.getByRole('button', { name: '导出…' }));
    expect(p.exportUsageLog).toHaveBeenCalledWith({ projectId: 'p-budget', from: rangeStart('week', now) });
    expect(await screen.findByText('已导出 1,234 条记录')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '在文件夹中显示' }));
    expect(p.showInFolder).toHaveBeenCalledWith('C:\\Users\\me\\Documents\\Spica\\使用日志-20261109.jsonl');
  });

  it('exports everything by default, says nothing when the save dialog is cancelled, and shows errors in words', async () => {
    const exportUsageLog = vi.fn<GeneralProps['exportUsageLog']>(async () => null);
    setup({ exportUsageLog, projects: [] });
    // No projects yet: no project picker.
    expect(screen.queryByRole('button', { name: /全部项目/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '导出…' }));
    expect(exportUsageLog).toHaveBeenCalledWith({});
    await vi.waitFor(() => expect(screen.getByRole('button', { name: '导出…' }).hasAttribute('disabled')).toBe(false));
    expect(screen.queryByText(/已导出/)).toBeNull();
    exportUsageLog.mockResolvedValueOnce({ error: '无法写入该位置，请选择其他文件夹。' });
    fireEvent.click(screen.getByRole('button', { name: '导出…' }));
    expect(await screen.findByText(/无法写入该位置/)).toBeTruthy();
  });

  it('starts ranges at local midnight', () => {
    expect(rangeStart('all', now)).toBeUndefined();
    const today = new Date(rangeStart('today', now)!);
    expect([today.getHours(), today.getMinutes(), today.getDate()]).toEqual([0, 0, now.getDate()]);
    const month = new Date(rangeStart('month', now)!);
    expect(Math.round((today.getTime() - month.getTime()) / 86_400_000)).toBe(29);
  });
});

describe('turning mail sorting on', () => {
  it('asks first, naming the model the mail goes to; agreeing records when', () => {
    const p = setup({ mailModel: 'DeepSeek · deepseek-chat' });
    fireEvent.click(screen.getByRole('switch', { name: '邮件分类' }));
    expect(p.onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/将发送给「DeepSeek · deepseek-chat」进行分类/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '开启' }));
    const patch = (p.onChange as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { mail: { enabled: boolean; consentedAt: string } };
    expect(patch.mail.enabled).toBe(true);
    expect(Number.isNaN(Date.parse(patch.mail.consentedAt))).toBe(false);
  });

  it('cancelling leaves it off', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('switch', { name: '邮件分类' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(p.onChange).not.toHaveBeenCalled();
  });
});

describe('填一半离开', () => {
  it('a proxy typed but not saved is still there when you come back', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/^代理地址/), { target: { value: 'http://proxy.example.com:8080' } });
    cleanup();
    const p = setup();
    expect((screen.getByLabelText(/^代理地址/) as HTMLInputElement).value).toBe('http://proxy.example.com:8080');
    // The network group's 保存 (the mail rules above have their own).
    const net = screen.getByRole('heading', { name: '网络' }).closest('.settings-group') as HTMLElement;
    fireEvent.click(within(net).getByRole('button', { name: '保存' }));
    expect(p.onChange).toHaveBeenCalled();
    cleanup();
    setup();
    // Saved (the settings in this test do not change), so the draft is gone.
    expect((screen.getByLabelText(/^代理地址/) as HTMLInputElement).value).toBe('');
  });
});
