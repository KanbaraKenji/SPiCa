// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { Plugins, pluginBadge, type PluginsApi } from './Plugins';
import { FakePluginService } from '../../../main/plugins/fake';
import { dropAllDrafts } from './drafts';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import type { PluginsState, PluginView } from '../../../shared/plugins';

afterEach(() => {
  cleanup();
  dropAllDrafts();
});

function api(): PluginsApi {
  const svc = new FakePluginService('C:\\Users\\me\\AppData\\Roaming\\Spica\\plugins');
  return { run: (cmd) => svc.run(cmd), onChanged: () => () => {} };
}

/** The demo's plugins with changes, for the list's groups, marks and filters. */
function apiWith(change: (plugins: PluginView[]) => PluginView[]): PluginsApi {
  const base = api();
  return {
    ...base,
    run: async (cmd) => {
      const r = await base.run(cmd);
      const st: PluginsState = { ...r.state, plugins: change(r.state.plugins) };
      return { ...r, state: st };
    },
  };
}

const list = () => screen.getByRole('navigation', { name: '插件列表' });
const pick = (name: string) => fireEvent.click(within(list()).getByRole('button', { name: new RegExp(name) }));
const groupOf = (name: string) => within(list()).getByRole('button', { name: new RegExp(name) }).closest('.plugins-group')?.querySelector('.plugins-group-title')?.textContent;

describe('Plugins', () => {
  it('lists the plugins by 已启用 / 已停用 and shows the one picked on the right, its switch on top', async () => {
    render(<Plugins api={api()} />);
    const detail = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    // The groups say what they are; the counts are only in the filter.
    expect(within(list()).getByRole('heading', { name: '已启用' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '已启用 2' })).toBeTruthy();
    expect(within(detail).getByRole('switch', { name: '停用「笔记（示例）」' })).toBeTruthy();
    // The tools are listed in the detail, no folding.
    expect(within(detail).getByText('工具')).toBeTruthy();
    pick('来信摘要');
    expect(await screen.findByRole('region', { name: '来信摘要（示例）' })).toBeTruthy();
  });

  it('each row in the list has the version after the name, in the same small secondary style as the detail', async () => {
    render(<Plugins api={api()} />);
    await screen.findByRole('region', { name: '笔记（示例）' });
    const row = within(list()).getByRole('button', { name: /笔记/ });
    const version = row.querySelector('.plugin-row-version');
    expect(version?.textContent).toBe('0.2.0');
    expect(version?.className).toContain('plugin-version');
    expect(version?.previousElementSibling?.className).toBe('plugin-row-name');
    // The detail's title uses the same class.
    expect(screen.getByRole('region', { name: '笔记（示例）' }).querySelector('.plugin-title .plugin-version')?.textContent).toBe('0.2.0');
  });

  it('a plugin turned off stays where it is while the page is open; it moves to 已停用 the next time', async () => {
    const a = api();
    const first = render(<Plugins api={a} />);
    fireEvent.click(await screen.findByRole('switch', { name: '停用「笔记（示例）」' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: '启用「笔记（示例）」' }).getAttribute('aria-checked')).toBe('false'));
    // Still in 已启用, shown as off.
    expect(groupOf('笔记')).toBe('已启用');
    expect(within(list()).getByRole('button', { name: /笔记/ }).className).toContain('is-off');
    expect(within(screen.getByRole('region', { name: '笔记（示例）' })).getByText('已停用')).toBeTruthy();
    // The filter counts what is so now.
    expect(screen.getByRole('radio', { name: '已启用 1' })).toBeTruthy();
    first.unmount();
    render(<Plugins api={a} />);
    await waitFor(() => expect(groupOf('笔记')).toBe('已停用'));
    expect(groupOf('来信摘要')).toBe('已启用');
  });

  it('marks an update in the list; the detail offers it; the mock switch is at the bottom', async () => {
    render(<Plugins api={api()} />);
    expect(await within(await screen.findByRole('navigation', { name: '插件列表' })).findByRole('img', { name: '有更新：1.1.0' })).toBeTruthy();
    pick('来信摘要');
    expect(await screen.findByRole('button', { name: '更新到 1.1.0' })).toBeTruthy();
    const mock = screen.getByRole('switch', { name: '模拟模式' });
    fireEvent.click(mock);
    await waitFor(() => expect(mock.getAttribute('aria-checked')).toBe('true'));
  });

  it('search and the status filter narrow the list, and say so when nothing is left', async () => {
    render(<Plugins api={apiWith((ps) => ps.map((p, i) => (i === 0 ? { ...p, issues: ['manifest.json 缺少 version'] } : p)))} />);
    fireEvent.change(await screen.findByLabelText('搜索插件'), { target: { value: '摘要' } });
    expect(within(list()).queryByRole('button', { name: /笔记/ })).toBeNull();
    expect(within(list()).getByRole('button', { name: /来信摘要/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('搜索插件'), { target: { value: '没有这个' } });
    expect(screen.getByText('没有匹配的插件')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('搜索插件'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('radio', { name: '有问题 1' }));
    expect(within(list()).getByRole('button', { name: /笔记/ })).toBeTruthy();
    expect(within(list()).queryByRole('button', { name: /来信摘要/ })).toBeNull();
    // The problem in the detail, with the error mark.
    expect(within(screen.getByRole('region', { name: '笔记（示例）' })).getByText('manifest.json 缺少 version')).toBeTruthy();
  });

  it('检查更新 and 安装插件 are the same square buttons as 检查更新 in 关于', async () => {
    render(<Plugins api={api()} />);
    await screen.findByRole('navigation', { name: '插件列表' });
    expect(screen.getByRole('button', { name: '检查更新' }).className).toContain('btn-square');
    expect(screen.getByRole('button', { name: '安装插件' }).className).toContain('btn-square');
  });

  it('检查更新: while it runs it says so, then the result', async () => {
    const base = api();
    let finish: () => void = () => {};
    const slow: PluginsApi = {
      ...base,
      run: async (cmd) => {
        if (cmd.op === 'checkUpdates') await new Promise<void>((r) => (finish = r));
        return base.run(cmd);
      },
    };
    render(<Plugins api={slow} />);
    await screen.findByRole('navigation', { name: '插件列表' });
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    expect(screen.getByRole('status').textContent).toBe('正在检查更新…');
    finish();
    await waitFor(() => expect(screen.queryByText('正在检查更新…')).toBeNull());
  });

  it('检查更新 result line: a notice is plain (no mark, no colour); a result has the done mark; a failure the error mark', async () => {
    const base = api();
    let reply: { ok: boolean; info?: boolean; message: string } = { ok: true, info: true, message: '没有插件来源，无法检查更新。' };
    const answering: PluginsApi = {
      ...base,
      run: async (cmd) => {
        const r = await base.run(cmd);
        return cmd.op === 'checkUpdates' ? { ...r, ...reply } : r;
      },
    };
    render(<Plugins api={answering} />);
    await screen.findByRole('navigation', { name: '插件列表' });
    const check = async (text: string) => {
      fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
      return waitFor(() => {
        const line = screen.getByRole('status');
        expect(line.textContent).toBe(text);
        return line;
      });
    };

    let line = await check('没有插件来源，无法检查更新。');
    expect(line.className).toBe('provider-result plugin-note');
    expect(line.querySelector('svg')).toBeNull();

    reply = { ok: true, message: '已是最新版本。' };
    line = await check('已是最新版本。');
    expect(line.className).toContain('is-ok');
    expect(line.querySelector('svg')).not.toBeNull();

    reply = { ok: false, message: '1 个插件来源连接失败，无法检查更新。' };
    line = await check('1 个插件来源连接失败，无法检查更新。');
    expect(line.className).toContain('is-bad');
    expect(line.querySelector('svg')).not.toBeNull();
  });

  it('模拟模式: says what it does on hover; while on, a tag says the data is demo data', async () => {
    render(<Plugins api={api()} />);
    await screen.findByRole('navigation', { name: '插件列表' });
    expect(screen.getByRole('img', { name: '模拟模式：插件改用演示数据，不连接真实系统。' }).getAttribute('data-tip')).toBe('插件改用演示数据，不连接真实系统。');
    const on = screen.getByRole('switch', { name: '模拟模式' }).getAttribute('aria-checked') === 'true';
    expect(Boolean(screen.queryByText('模拟数据'))).toBe(on);
    fireEvent.click(screen.getByRole('switch', { name: '模拟模式' }));
    await waitFor(() => expect(Boolean(screen.queryByText('模拟数据'))).toBe(!on));
  });

  it('no plugins: 安装插件 open on top, 未安装插件 where the list would be', async () => {
    render(<Plugins api={apiWith(() => [])} />);
    const none = await screen.findByText('未安装插件');
    const heading = screen.getByRole('heading', { name: '安装插件' });
    const field = screen.getByLabelText('插件位置');
    // In the page's order: the heading, the field, then 未安装插件.
    expect(heading.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(field.compareDocumentPosition(none) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByLabelText('搜索插件')).toBeNull();
  });

  it('插件位置: a folder button opens the system picker and fills the field', async () => {
    const pickFolder = vi.fn(async () => 'D:/插件/outlook-mail');
    render(<Plugins api={{ ...apiWith(() => []), pickFolder }} />);
    fireEvent.click(await screen.findByRole('button', { name: '选择文件夹' }));
    await waitFor(() => expect((screen.getByLabelText('插件位置') as HTMLInputElement).value).toBe('D:/插件/outlook-mail'));
    expect(pickFolder).toHaveBeenCalledTimes(1);
  });

  it('deletes only after confirming', async () => {
    render(<Plugins api={api()} />);
    const detail = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    fireEvent.click(within(detail).getByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('删除插件「笔记（示例）」？');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: '笔记（示例）' })).toBeNull());
  });

  it('install opens from the + at the top; the location typed but not installed is still there when you come back', async () => {
    const a = api();
    const first = render(<Plugins api={a} />);
    expect(await screen.findByRole('region', { name: '笔记（示例）' })).toBeTruthy();
    expect(screen.queryByLabelText('插件位置')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '安装插件' }));
    fireEvent.change(screen.getByLabelText('插件位置'), { target: { value: 'D:\\plugins\\notes-0.1.0.zip' } });
    first.unmount();
    render(<Plugins api={a} />);
    fireEvent.click(await screen.findByRole('button', { name: '安装插件' }));
    expect((screen.getByLabelText('插件位置') as HTMLInputElement).value).toBe('D:\\plugins\\notes-0.1.0.zip');
  });

  it('a plugin that uses models says so, with its reason, today’s spending and a limit to lower', async () => {
    render(<Plugins api={api()} />);
    const card = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    expect(within(card).getByText(/使用模型 · 每日上限 \$0\.20/)).toBeTruthy();
    expect(within(card).getByText(/今日 \$0\.03/)).toBeTruthy();
    expect(within(card).getByText('用途：把一篇长笔记缩成几句话时，要用模型。')).toBeTruthy();
    const input = within(card).getByLabelText('「笔记（示例）」每日上限（美元）');
    fireEvent.change(input, { target: { value: '0.5' } });
    expect(within(card).getByText('不能高于 $0.20')).toBeTruthy();
    expect((within(card).getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '0.1' } });
    fireEvent.click(within(card).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(within(card).getByText(/使用模型 · 每日上限 \$0\.10/)).toBeTruthy());
    fireEvent.click(within(card).getByRole('button', { name: '恢复默认（$0.20）' }));
    await waitFor(() => expect(within(card).getByText(/使用模型 · 每日上限 \$0\.20/)).toBeTruthy());
    fireEvent.click(within(card).getByRole('button', { name: '禁止使用模型' }));
    await waitFor(() => expect(within(card).getByText('使用模型 · 已禁止')).toBeTruthy());
  });
});

describe('daily limit typed but not saved', () => {
  it('says 未保存, and is still there after leaving the page and coming back', async () => {
    const a = api();
    const first = render(<Plugins api={a} />);
    const input = (await screen.findByLabelText('「笔记（示例）」每日上限（美元）')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.05' } });
    expect(within(screen.getByRole('region', { name: '笔记（示例）' })).getByText('未保存')).toBeTruthy();
    first.unmount();
    render(<Plugins api={a} />);
    expect(((await screen.findByLabelText('「笔记（示例）」每日上限（美元）')) as HTMLInputElement).value).toBe('0.05');
    // Saved: the draft is gone, the field shows what is saved.
    fireEvent.click(within(screen.getByRole('region', { name: '笔记（示例）' })).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByText(/使用模型 · 每日上限 \$0\.05/)).toBeTruthy());
    expect(screen.queryByText('未保存')).toBeNull();
  });
});

describe('what deleting does, said in the confirm box', () => {
  it('a plugin: its tools and pages', async () => {
    render(<Plugins api={api()} />);
    fireEvent.click(within((await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement).getByRole('button', { name: '删除' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('该插件的工具和页面将不再可用。');
  });
});

describe('mail sorting, with the plugin that provides mail', () => {
  const mail = (over: { model?: string } = {}) => ({ prefs: DEFAULT_SETTINGS.mail, onChange: vi.fn(), ...over });

  it('sits in that plugin’s detail; turning it on asks first, naming the model; agreeing records when', async () => {
    const m = mail({ model: 'DeepSeek · deepseek-chat' });
    render(<Plugins api={api()} mail={m} />);
    // Not with the other plugin.
    expect(within((await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement).queryByRole('switch', { name: '邮件分类' })).toBeNull();
    pick('来信摘要');
    const card = (await screen.findByRole('region', { name: '来信摘要（示例）' })) as HTMLElement;
    fireEvent.click(within(card).getByRole('switch', { name: '邮件分类' }));
    expect(m.onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/将发送给「DeepSeek · deepseek-chat」进行分类/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '开启' }));
    const patch = m.onChange.mock.calls[0]?.[0] as { enabled: boolean; consentedAt: string };
    expect(patch.enabled).toBe(true);
    expect(Number.isNaN(Date.parse(patch.consentedAt))).toBe(false);
  });

  it('saving the ignore rules says 已保存, until they are edited again', async () => {
    const onChange = vi.fn();
    const a = api();
    // Like the app: what is saved comes back as the new settings.
    function Page() {
      const [prefs, setPrefs] = useState(DEFAULT_SETTINGS.mail);
      return (
        <Plugins
          api={a}
          mail={{
            prefs,
            onChange: (patch) => {
              onChange(patch);
              setPrefs({ ...prefs, ...patch });
            },
          }}
        />
      );
    }
    render(<Page />);
    await screen.findByRole('navigation', { name: '插件列表' });
    pick('来信摘要');
    fireEvent.change(await screen.findByLabelText('发件人包含'), { target: { value: 'noreply@' } });
    expect(screen.getByText('未保存')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('region', { name: '来信摘要（示例）' })).getAllByRole('button', { name: '保存' }).at(-1)!);
    expect(onChange).toHaveBeenCalledWith({ ignore: { from: ['noreply@'], subject: [] } });
    expect(screen.getByText('已保存')).toBeTruthy();
  });

  it('cancelling leaves it off', async () => {
    const m = mail();
    render(<Plugins api={api()} mail={m} />);
    await screen.findByRole('navigation', { name: '插件列表' });
    pick('来信摘要');
    fireEvent.click(await screen.findByRole('switch', { name: '邮件分类' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(m.onChange).not.toHaveBeenCalled();
  });

  it('is gone while no plugin provides mail', async () => {
    render(<Plugins api={api()} mail={mail()} />);
    await screen.findByRole('navigation', { name: '插件列表' });
    pick('来信摘要');
    fireEvent.click(await screen.findByRole('switch', { name: '停用「来信摘要（示例）」' }));
    await waitFor(() => expect(screen.queryByRole('switch', { name: '邮件分类' })).toBeNull());
  });

  it('with two mail plugins: once, above the list, naming both', async () => {
    render(<Plugins api={apiWith((ps) => ps.map((p) => ({ ...p, enabled: true, mail: true })))} mail={mail()} />);
    await waitFor(() => expect(screen.getAllByRole('switch', { name: '邮件分类' })).toHaveLength(1));
    expect(screen.getByText('笔记（示例）、来信摘要（示例）')).toBeTruthy();
  });
});

describe('plugin badges', () => {
  it('the first character (letters in upper case) on a colour the plugin always gets', () => {
    expect(pluginBadge({ name: 'outlook', displayName: 'Outlook mail' }).letter).toBe('O');
    expect(pluginBadge({ name: 'notes', displayName: '笔记（示例）' }).letter).toBe('笔');
    expect(pluginBadge({ name: 'erp', displayName: 'erp 查询' }).letter).toBe('E');
    expect(pluginBadge({ name: 'notes', displayName: '笔记' }).colour).toBe(pluginBadge({ name: 'notes', displayName: '另一个名字' }).colour);
    expect(pluginBadge({ name: 'notes', displayName: '笔记' }).colour).toMatch(/^#[0-9a-f]{6}$/);
  });
});
