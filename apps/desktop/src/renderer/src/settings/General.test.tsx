// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import type { PluginView } from '../../../shared/plugin-view';
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

const page = (plugin: string, id: string, title: string, extensions: string[]): PluginView => ({ plugin, pluginTitle: plugin === 'office-preview' ? 'Office 预览' : '另一个', id, title, placement: 'preview', entry: `ui/${id}.html`, tools: [], preview: { extensions, maxBytes: 30 * 1024 * 1024 } });

describe('文件预览', () => {
  it('not there without a preview page or a kept choice', () => {
    setup();
    expect(screen.queryByText('文件预览')).toBeNull();
  });

  it('per kind of file: 自带预览 or the pages that can show it; choosing one keeps it, 自带预览 drops it', () => {
    const pages = [page('office-preview', 'docx', 'Word 原样预览', ['.docx', '.docm']), page('office-preview', 'xlsx', 'Excel 原样预览', ['.xlsx'])];
    const p = setup({ previewPages: pages, settings: { ...DEFAULT_SETTINGS, previewers: { '.xlsx': 'office-preview/xlsx' } } });
    expect(screen.getAllByRole('combobox').map((c) => c.getAttribute('aria-label'))).toEqual(['.docm 文件预览', '.docx 文件预览', '.xlsx 文件预览']);
    const docx = screen.getByRole('combobox', { name: '.docx 文件预览' }) as HTMLSelectElement;
    expect([...docx.options].map((o) => o.textContent)).toEqual(['自带预览', 'Word 原样预览']);
    expect(docx.value).toBe('');
    fireEvent.change(docx, { target: { value: 'office-preview/docx' } });
    expect(p.onChange).toHaveBeenCalledWith({ previewers: { '.xlsx': 'office-preview/xlsx', '.docx': 'office-preview/docx' } });
    const xlsx = screen.getByRole('combobox', { name: '.xlsx 文件预览' }) as HTMLSelectElement;
    expect(xlsx.value).toBe('office-preview/xlsx');
    fireEvent.change(xlsx, { target: { value: '' } });
    expect(p.onChange).toHaveBeenLastCalledWith({ previewers: {} });
  });

  it('a kept choice whose plugin is gone says so; two pages with one name say whose', () => {
    const pages = [page('office-preview', 'docx', 'Word 预览', ['.docx']), page('other', 'docx', 'Word 预览', ['.docx'])];
    setup({ previewPages: pages, settings: { ...DEFAULT_SETTINGS, previewers: { '.pptx': 'slides/pptx' } } });
    const pptx = screen.getByRole('combobox', { name: '.pptx 文件预览' }) as HTMLSelectElement;
    expect(pptx.value).toBe('slides/pptx');
    expect(pptx.selectedOptions[0]?.textContent).toBe('插件不可用');
    expect([...(screen.getByRole('combobox', { name: '.docx 文件预览' }) as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['自带预览', 'Word 预览（Office 预览）', 'Word 预览（另一个）']);
  });
});

describe('导出使用日志', () => {
  it('exports one project for a time range and says how many records went where', async () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /全部项目/ }));
    // The project in force (全部项目 to begin with) has the tick.
    expect(screen.getByRole('menuitemradio', { name: '全部项目' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: '年度预算' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('menuitemradio', { name: '年度预算' }));
    fireEvent.click(screen.getByRole('radio', { name: '最近 7 天' }));
    fireEvent.click(screen.getByRole('button', { name: '导出…' }));
    expect(p.exportUsageLog).toHaveBeenCalledWith({ projectId: 'p-budget', from: rangeStart('week', now) });
    expect(await screen.findByText('已导出 1,234 条记录')).toBeTruthy();
    // The file's path is the way to it (no separate button): shown in its folder.
    expect(screen.queryByRole('button', { name: '在文件夹中显示' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^在文件夹中显示：.*使用日志-20261109\.jsonl$/ }));
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

describe('填一半离开', () => {
  it('a proxy typed but not saved is still there when you come back', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/^代理地址/), { target: { value: 'http://proxy.example.com:8080' } });
    cleanup();
    const p = setup();
    expect((screen.getByLabelText(/^代理地址/) as HTMLInputElement).value).toBe('http://proxy.example.com:8080');
    // The network group's 保存.
    const net = screen.getByRole('heading', { name: '网络' }).closest('.settings-group') as HTMLElement;
    fireEvent.click(within(net).getByRole('button', { name: '保存' }));
    expect(p.onChange).toHaveBeenCalled();
    cleanup();
    setup();
    // Saved (the settings in this test do not change), so the draft is gone.
    expect((screen.getByLabelText(/^代理地址/) as HTMLInputElement).value).toBe('');
  });
});

describe('信任的证书文件', () => {
  it('the picker is an icon button named 选择文件; the file it returns is saved', async () => {
    const pickFiles = vi.fn(async () => ['D:\\工作\\certs\\corp-root.pem']);
    const p = setup({ pickFiles });
    const pick = screen.getByRole('button', { name: '选择文件' });
    expect(pick.className).toBe('btn btn-square');
    expect(pick.getAttribute('title')).toBe('选择文件');
    expect(pick.textContent).toBe('');
    fireEvent.click(pick);
    await vi.waitFor(() => expect(p.onChange).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(p.onChange).mock.calls[0])).toContain('corp-root.pem');
  });
});

describe('使用日志: where the project menu sits', () => {
  it('near the bottom of the window the menu goes over the button instead of covering it; the button again closes it', () => {
    setup();
    const pick = screen.getByRole('button', { name: /全部项目/ });
    const rect = (top: number, height: number) => ({ left: 300, top, right: 420, bottom: top + height, width: 120, height, x: 300, y: top, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('context-menu') ? rect(0, 200) : this.classList.contains('btn') ? rect(window.innerHeight - 40, 28) : rect(0, 0);
    });
    fireEvent.click(pick);
    expect(screen.getByRole('menu').style.top).toBe(`${window.innerHeight - 40 - 4 - 200}px`);
    expect(screen.getByRole('menu').style.left).toBe('300px');
    fireEvent.click(pick);
    expect(screen.queryByRole('menu')).toBeNull();
    spy.mockRestore();
  });
});

describe('启动与托盘', () => {
  it('开机时启动 is off by default and turns on; 关闭窗口时 starts at 每次询问 and can be changed back', () => {
    const p = setup({ autostart: 'ok' });
    const login = screen.getByRole('switch', { name: '开机时启动' });
    expect(login.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(login);
    expect(p.onChange).toHaveBeenLastCalledWith({ openAtLogin: true });
    expect(screen.getByText('登录 Windows 后自动启动。')).toBeTruthy();
    const group = screen.getByRole('radiogroup', { name: '关闭窗口时' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['每次询问', '最小化到托盘', '退出 Spica']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    fireEvent.click(radios[1]!);
    expect(p.onChange).toHaveBeenLastCalledWith({ closeWindow: 'tray' });
    cleanup();
    const q = setup({ autostart: 'ok', settings: { ...DEFAULT_SETTINGS, closeWindow: 'quit' } });
    const again = within(screen.getByRole('radiogroup', { name: '关闭窗口时' })).getAllByRole('radio');
    expect(again[2]!.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(again[0]!);
    expect(q.onChange).toHaveBeenLastCalledWith({ closeWindow: 'ask' });
  });

  it('a development run or a portable copy shows 开机时启动 disabled, saying only the installed one can', () => {
    setup({ autostart: 'dev', settings: { ...DEFAULT_SETTINGS, openAtLogin: true } });
    const login = screen.getByRole('switch', { name: '开机时启动' }) as HTMLButtonElement;
    expect(login.disabled).toBe(true);
    expect(login.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('开发版不能开机启动，只有安装版能用。')).toBeTruthy();
    cleanup();
    setup({ autostart: 'portable' });
    expect(screen.getByText('便携版不能开机启动，只有安装版能用。')).toBeTruthy();
  });
});

describe('工作流', () => {
  it('the path of the folder opens it (no folder button); the pencil changes it, the arrow reads it again', async () => {
    const p = setup();
    const link = await screen.findByRole('button', { name: '打开文件夹：C:\\Spica\\workflows' });
    expect(link.textContent).toBe('C:\\Spica\\workflows');
    expect(screen.queryByRole('button', { name: '打开文件夹' })).toBeNull();
    fireEvent.click(link);
    expect(p.workflows.run).toHaveBeenCalledWith('open');
    expect(screen.getByRole('button', { name: '更改' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新读取' })).toBeTruthy();
  });
});
