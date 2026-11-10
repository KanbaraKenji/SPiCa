// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Plugins, type PluginsApi } from './Plugins';
import { FakePluginService } from '../../../main/plugins/fake';
import { dropAllDrafts } from './drafts';

afterEach(() => {
  cleanup();
  dropAllDrafts();
});

function api(): PluginsApi {
  const svc = new FakePluginService('C:\\Users\\me\\AppData\\Roaming\\Spica\\plugins');
  return { run: (cmd) => svc.run(cmd), onChanged: () => () => {} };
}

describe('Plugins', () => {
  it('turning a plugin off takes its tools away at once', async () => {
    render(<Plugins api={api()} />);
    const toggle = await screen.findByRole('switch', { name: '停用「笔记（示例）」' });
    expect(screen.getByText('能用的工具 4 个')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole('switch', { name: '启用「笔记（示例）」' }).getAttribute('aria-checked')).toBe('false'));
    expect(screen.getAllByText('已停用，工具不可用').length).toBeGreaterThan(0);
  });

  it('shows an available update and the mock switch', async () => {
    render(<Plugins api={api()} />);
    expect(await screen.findByRole('button', { name: '更新到 1.1.0' })).toBeTruthy();
    const mock = screen.getByRole('switch', { name: '模拟模式' });
    fireEvent.click(mock);
    await waitFor(() => expect(mock.getAttribute('aria-checked')).toBe('true'));
  });

  it('deletes only after confirming', async () => {
    render(<Plugins api={api()} />);
    const card = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /能用的工具/ }));
    fireEvent.click(within(card).getByRole('button', { name: /删除/ }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('删除插件「笔记（示例）」？');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: '笔记（示例）' })).toBeNull());
  });

  it('the install location typed but not installed is still there when you come back', async () => {
    const a = api();
    const first = render(<Plugins api={a} />);
    fireEvent.change(await screen.findByLabelText('插件在哪里'), { target: { value: 'D:\\plugins\\notes-0.1.0.zip' } });
    first.unmount();
    render(<Plugins api={a} />);
    expect(((await screen.findByLabelText('插件在哪里')) as HTMLInputElement).value).toBe('D:\\plugins\\notes-0.1.0.zip');
  });
});
