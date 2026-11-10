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

  it('a plugin that uses models says so, with its reason, today’s spending and a limit to lower', async () => {
    render(<Plugins api={api()} />);
    const card = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    expect(within(card).getByText(/会用你配好的模型，花费记在你的额度里，每天最多 \$0\.20。/)).toBeTruthy();
    expect(within(card).getByText(/今天花了 \$0\.03。/)).toBeTruthy();
    expect(within(card).getByText('它说：把一篇长笔记缩成几句话时，要用模型。')).toBeTruthy();
    const input = within(card).getByLabelText('「笔记（示例）」每天最多花多少美元');
    fireEvent.change(input, { target: { value: '0.5' } });
    expect(within(card).getByText('不能高于 $0.20')).toBeTruthy();
    expect((within(card).getByRole('button', { name: '保存上限' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '0.1' } });
    fireEvent.click(within(card).getByRole('button', { name: '保存上限' }));
    await waitFor(() => expect(within(card).getByText(/每天最多 \$0\.10。/)).toBeTruthy());
    fireEvent.click(within(card).getByRole('button', { name: '恢复成插件写的 $0.20' }));
    await waitFor(() => expect(within(card).getByText(/每天最多 \$0\.20。/)).toBeTruthy());
    fireEvent.click(within(card).getByRole('button', { name: '不让它用模型' }));
    await waitFor(() => expect(within(card).getByText('它想用你配好的模型，现在不让它用。')).toBeTruthy());
  });
});
