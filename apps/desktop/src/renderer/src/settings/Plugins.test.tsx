// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { Plugins, pluginBadge, type PluginsApi, type SettingsPages } from './Plugins';
import type { PluginView as PageView } from '../../../shared/plugin-view';
import { FakePluginService } from '../../../main/plugins/fake';
import { dropAllDrafts } from './drafts';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import type { PluginsProgress, PluginsState, PluginView } from '../../../shared/plugins';

/** The window's width (jsdom's own is 1024): 市场 › 插件来源 starts open from 1280. */
const windowWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
beforeEach(() => windowWidth(1280));

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

  it('已安装: 检查更新 is the same square button as 检查更新 in 关于; the box searches the installed plugins only', async () => {
    render(<Plugins api={{ ...api(), pickFolder: async () => null }} />);
    await screen.findByRole('navigation', { name: '插件列表' });
    expect(screen.getByRole('tab', { name: /^已安装/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: '检查更新' }).className).toContain('btn-square');
    // Adding plugins is under 市场 now: no folder picker, no place typed here.
    expect(screen.queryByRole('button', { name: '选择文件夹' })).toBeNull();
    const box = screen.getByLabelText('搜索插件') as HTMLInputElement;
    expect(box.placeholder).toBe('搜索已安装的插件');
    fireEvent.change(box, { target: { value: 'D:\\插件\\note-box-1.0.0.zip' } });
    expect(await screen.findByText('没有匹配的插件')).toBeTruthy();
  });

  it('nothing installed: 未安装插件 under the tabs, no list', async () => {
    const empty: PluginsApi = {
      run: async (cmd) => {
        const r = await api().run(cmd);
        return { ...r, state: { ...r.state, plugins: [] } };
      },
      onChanged: () => () => {},
    };
    render(<Plugins api={empty} />);
    const none = await screen.findByText('未安装插件');
    expect(screen.getByRole('tablist', { name: '插件' }).compareDocumentPosition(none) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '插件列表' })).toBeNull();
  });

  it('市场: the sources, the official one first (marked, no 移除), each with how it went last time, 检查更新 and 移除; then what they offer and is not installed', async () => {
    render(<Plugins api={api()} tab="market" />);
    const sources = await screen.findByRole('list', { name: '插件来源' });
    const rows = within(sources).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.setting-title')?.textContent)).toEqual(['官方插件官方', '\\\\fileserver\\spica-plugins', 'https://plugins.example.com/index.json']);
    expect(within(rows[0]!).getByText('官方').className).toContain('provider-default');
    expect(within(rows[0]!).getAllByRole('button').map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['检查更新']);
    expect(rows[1]!.textContent).toMatch(/上次读取 \d\d:\d\d · 2 个插件/);
    expect(within(rows[2]!).getByText('连接失败').getAttribute('title')).toMatch(/HTTP 503/);
    expect(within(rows[1]!).getAllByRole('button').map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['检查更新', '移除来源']);
    expect(screen.getByRole('button', { name: '全部检查更新' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加来源' })).toBeTruthy();
    // By source, the official one first; every plugin of it with its state: 已安装, 可更新, or nothing (not installed).
    expect(within(list()).getAllByRole('heading').map((h) => h.textContent)).toEqual(['官方插件官方', '\\\\fileserver\\spica-plugins']);
    const state = (name: string) => within(list()).getByRole('button', { name: new RegExp(name) }).querySelector('.plugin-row-state')?.textContent ?? '';
    expect(['笔记', '来信摘要', '周报助手', '术语表'].map(state)).toEqual(['已安装', '可更新', '', '']);
    // The installed plugins and their search are under 已安装.
    expect(screen.queryByLabelText('搜索插件')).toBeNull();
    expect(screen.queryByRole('switch', { name: '模拟模式' })).toBeNull();
  });

  it('a package picked: its detail has 安装 on a row of its own under the name; installing says each step and how long, then it is installed, on and shown under 已安装', async () => {
    const svc = new FakePluginService('C:\\Users\\me\\AppData\\Roaming\\Spica\\plugins');
    const listeners = new Set<(p: PluginsProgress) => void>();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a: PluginsApi = {
      run: async (cmd) => {
        if (cmd.op === 'installAvailable') {
          // Say two steps, then wait to be let go: the page is looked at in between.
          for (const l of listeners) l({ job: cmd.job!, step: 'download', received: 3 * 1024 * 1024, total: 8 * 1024 * 1024 });
          await gate;
        }
        return svc.run(cmd);
      },
      onChanged: () => () => {},
      onProgress: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    render(<Plugins api={a} />);
    await screen.findByRole('region', { name: '笔记（示例）' });
    fireEvent.click(screen.getByRole('tab', { name: '市场' }));
    pick('周报助手');
    const detail = (await screen.findByRole('region', { name: '周报助手' })) as HTMLElement;
    const actions = detail.querySelector('.plugin-actions') as HTMLElement;
    // Right under the name, before the description.
    expect(detail.querySelector('.plugin-head')?.nextElementSibling).toBe(actions);
    expect(within(detail).getByText('\\\\fileserver\\spica-plugins\\weekly-report-1.2.0.zip')).toBeTruthy();
    fireEvent.click(within(actions).getByRole('button', { name: '安装' }));
    await waitFor(() => expect(within(detail).getByRole('status').textContent).toMatch(/^正在下载 3\.0 MB \/ 8\.0 MB\d+s$/));
    expect((detail.querySelector('.plugin-progress-bar > span') as HTMLElement).style.width).toBe('38%');
    release();
    // Now the installed plugin's own detail under 已安装: its switch beside the name, on.
    await waitFor(() => expect(within(screen.getByRole('region', { name: '周报助手' })).getByRole('switch', { name: '停用「周报助手」' })).toBeTruthy());
    expect(screen.getByRole('tab', { name: /^已安装/ }).getAttribute('aria-selected')).toBe('true');
    expect(groupOf('周报助手')).toBe('已启用');
    expect(screen.getByText('已安装「周报助手」1.2.0。')).toBeTruthy();
  });

  it('添加来源: a place typed (in quotes, as Explorer copies it) is added and read, and what it offers is listed; a place with nothing is not added and says why', async () => {
    render(<Plugins api={api()} tab="market" />);
    await screen.findByRole('list', { name: '插件来源' });
    fireEvent.click(screen.getByRole('button', { name: '添加来源' }));
    const box = screen.getByLabelText('插件来源的位置') as HTMLInputElement;
    const add = screen.getByRole('button', { name: '添加' }) as HTMLButtonElement;
    // Not a place yet: nothing to add.
    fireEvent.change(box, { target: { value: '周报' } });
    expect(add.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '"D:\\插件\\note-box"' } });
    fireEvent.submit(box.closest('form')!);
    expect(await screen.findByText('已添加来源：1 个插件。')).toBeTruthy();
    // Added: the box closes, the source is a row, what it offers is in the list.
    expect(screen.queryByLabelText('插件来源的位置')).toBeNull();
    expect(within(screen.getByRole('list', { name: '插件来源' })).getByText('D:\\插件\\note-box')).toBeTruthy();
    expect(within(list()).getByRole('button', { name: /note-box/ })).toBeTruthy();
    // Nothing there: not added, the box stays open with what was typed, the reason in the result line.
    fireEvent.click(screen.getByRole('button', { name: '添加来源' }));
    fireEvent.change(screen.getByLabelText('插件来源的位置'), { target: { value: 'D:\\插件\\不存在' } });
    fireEvent.submit(screen.getByLabelText('插件来源的位置').closest('form')!);
    expect(await screen.findByText('找不到该文件夹或文件。')).toBeTruthy();
    expect((screen.getByLabelText('插件来源的位置') as HTMLInputElement).value).toBe('D:\\插件\\不存在');
    expect(within(screen.getByRole('list', { name: '插件来源' })).getAllByRole('listitem')).toHaveLength(4);
  });

  it('添加来源 › 选择文件夹: the folder picked is added at once', async () => {
    const pickFolder = vi.fn(async () => 'D:/插件/outlook-mail');
    render(<Plugins api={{ ...api(), pickFolder }} tab="market" />);
    fireEvent.click(await screen.findByRole('button', { name: '添加来源' }));
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
    expect(await within(screen.getByRole('list', { name: '插件来源' })).findByText('D:/插件/outlook-mail')).toBeTruthy();
    expect(within(list()).getByRole('button', { name: /outlook-mail/ })).toBeTruthy();
    expect(pickFolder).toHaveBeenCalledTimes(1);
  });

  it('a single package on the web cannot be a source: said so, and it is listed to install', async () => {
    render(<Plugins api={api()} tab="market" />);
    fireEvent.click(await screen.findByRole('button', { name: '添加来源' }));
    fireEvent.change(screen.getByLabelText('插件来源的位置'), { target: { value: 'https://plugins.example.com/files/report-tool-2.0.0.zip' } });
    fireEvent.submit(screen.getByLabelText('插件来源的位置').closest('form')!);
    expect(await screen.findByText('单个插件包的网址不能作为来源，可在下方安装。')).toBeTruthy();
    expect(within(list()).getByRole('button', { name: /report-tool/ })).toBeTruthy();
    expect(within(screen.getByRole('list', { name: '插件来源' })).getAllByRole('listitem')).toHaveLength(3);
  });

  it('检查更新 of one source reads that one; 全部检查更新 reads all and says how many were not reached', async () => {
    const svc = new FakePluginService('C:\\Users\\me\\AppData\\Roaming\\Spica\\plugins');
    const sent: unknown[] = [];
    render(<Plugins api={{ run: (cmd) => (sent.push(cmd), svc.run(cmd)), onChanged: () => () => {} }} tab="market" />);
    const rows = within(await screen.findByRole('list', { name: '插件来源' })).getAllByRole('listitem');
    fireEvent.click(within(rows[1]!).getByRole('button', { name: '检查更新' }));
    expect(await screen.findByText('1 个插件可更新。')).toBeTruthy();
    expect(sent).toContainEqual({ op: 'checkSources', location: '\\\\fileserver\\spica-plugins' });
    fireEvent.click(screen.getByRole('button', { name: '全部检查更新' }));
    expect(await screen.findByText('已检查 2 个插件来源：1 个插件可更新；1 个连接失败。')).toBeTruthy();
    expect(sent).toContainEqual({ op: 'checkSources' });
  });

  it('插件来源 on a window under 1280 starts folded: its title line says how many and how many failed; 添加来源 opens it with the box', async () => {
    windowWidth(1000);
    render(<Plugins api={api()} tab="market" />);
    const fold = await screen.findByRole('button', { name: /^插件来源/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    // The official source is counted too.
    expect(fold.textContent).toBe('插件来源3 个来源 · 1 个连接失败');
    expect(screen.queryByRole('list', { name: '插件来源' })).toBeNull();
    // What the sources offer is right there.
    expect(within(list()).getAllByRole('heading').map((h) => h.textContent)).toEqual(['官方插件官方', '\\\\fileserver\\spica-plugins']);
    fireEvent.click(fold);
    expect(screen.getByRole('list', { name: '插件来源' })).toBeTruthy();
    fireEvent.click(fold);
    fireEvent.click(screen.getByRole('button', { name: '添加来源' }));
    expect(screen.getByLabelText('插件来源的位置')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^插件来源/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('移除来源 asks first; removed, what it offered leaves the list', async () => {
    render(<Plugins api={api()} tab="market" />);
    const rows = within(await screen.findByRole('list', { name: '插件来源' })).getAllByRole('listitem');
    fireEvent.click(within(rows[1]!).getByRole('button', { name: '移除来源' }));
    const box = screen.getByRole('alertdialog');
    expect(within(box).getByText('移除来源「\\\\fileserver\\spica-plugins」？')).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: '移除' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: '插件来源' })).getAllByRole('listitem')).toHaveLength(2));
    // Its plugins went with it; the official source's stay.
    expect(within(list()).getAllByRole('heading').map((h) => h.textContent)).toEqual(['官方插件官方']);
  });

  it('市场: one installed as it is says so and goes to 已安装; one with a newer version offers 更新到', async () => {
    // The tab kept by the caller, as the settings dialog keeps it.
    function Kept() {
      const [tab, setTab] = useState<'installed' | 'market'>('market');
      return <Plugins api={api()} tab={tab} onTab={setTab} />;
    }
    render(<Kept />);
    await screen.findByRole('list', { name: '插件来源' });
    pick('来信摘要');
    const newer = (await screen.findByRole('region', { name: '来信摘要（示例）' })) as HTMLElement;
    expect(within(newer).getByRole('button', { name: '更新到 1.1.0' })).toBeTruthy();
    pick('笔记');
    const here = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    expect(here.querySelector('.plugin-actions .plugin-here')?.textContent).toBe('已安装');
    expect(within(here).queryByRole('button', { name: /^(重新)?安装/ })).toBeNull();
    fireEvent.click(within(here).getByRole('button', { name: '在已安装中查看' }));
    expect(screen.getByRole('tab', { name: /^已安装/ }).getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('region', { name: '笔记（示例）' })).getByRole('switch', { name: '停用「笔记（示例）」' })).toBeTruthy();
  });

  it('市场 without an official source says so and where it is set', async () => {
    const svc = new FakePluginService('D:/Spica/plugins');
    const none: PluginsApi = {
      run: async (cmd) => {
        const r = await svc.run(cmd);
        return { ...r, state: { ...r.state, sources: (r.state.sources ?? []).filter((x) => !x.official) } };
      },
      onChanged: () => () => {},
    };
    render(<Plugins api={none} tab="market" />);
    expect(await screen.findByText('没有配置官方来源。官方来源在打包时写进 deploy.json 的 pluginSources。')).toBeTruthy();
  });

  it('the plugin picked: 更新到, 回退到 and 删除 are on the row right under its name', async () => {
    render(<Plugins api={api()} />);
    const detail = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    const actions = detail.querySelector('.plugin-head')?.nextElementSibling as HTMLElement;
    expect(actions.className).toBe('plugin-actions');
    expect(within(actions).getAllByRole('button').map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['回退到 0.1.0', '删除']);
    pick('来信摘要');
    const mailDetail = (await screen.findByRole('region', { name: '来信摘要（示例）' })) as HTMLElement;
    expect(within(mailDetail.querySelector('.plugin-actions') as HTMLElement).getAllByRole('button').map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['更新到 1.1.0', '删除']);
  });
  it('检查更新: while it runs it says so, then the result', async () => {
    const base = api();
    let finish: () => void = () => {};
    const slow: PluginsApi = {
      ...base,
      run: async (cmd) => {
        if (cmd.op === 'checkSources') await new Promise<void>((r) => (finish = r));
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
        return cmd.op === 'checkSources' ? { state: r.state, ...reply } : r;
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

  it('deletes only after confirming', async () => {
    render(<Plugins api={api()} />);
    const detail = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    fireEvent.click(within(detail).getByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('删除插件「笔记（示例）」？');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: '笔记（示例）' })).toBeNull());
  });

  it('today’s spending says 未计价 for calls of a model without a price, never 0 (「+ 未计价」 beside what was counted)', async () => {
    const unpriced = (spent: number) => apiWith((ps) => ps.map((p) => (p.model ? { ...p, model: { ...p.model, spentTodayUsd: spent, unpricedToday: true as const } } : p)));
    render(<Plugins api={unpriced(0)} />);
    let card = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    expect(within(card).getByText(/今日 未计价$/)).toBeTruthy();
    cleanup();
    render(<Plugins api={unpriced(0.03)} />);
    card = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    expect(within(card).getByText(/今日 \$0\.03 \+ 未计价$/)).toBeTruthy();
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

describe('a plugin’s own settings page (a view with placement settings)', () => {
  const page = (plugin: string, id: string, placement: PageView['placement']): PageView => ({ plugin, pluginTitle: plugin, id, title: '设置', placement, entry: `ui/${id}.html`, tools: [] });
  const pages = (views: PageView[]): SettingsPages => ({
    views,
    props: (v) => ({
      view: v,
      theme: { mode: 'light', vars: { '--spica-bg': '#fff', '--spica-surface': '#f6f6f6' } },
      changed: 0,
      call: vi.fn(),
      cancel: vi.fn(),
      confirm: vi.fn(async () => true),
      openFile: vi.fn(async () => null),
      notify: vi.fn(),
      pick: vi.fn(async () => null),
      exists: async () => true,
    }),
  });

  it('an enabled plugin with settings pages: a row of tabs, 详情 first; a page loads on its tab, fills the rest and is kept while 详情 is shown', async () => {
    render(<Plugins api={api()} pages={pages([page('notes', 'settings', 'settings'), page('notes', 'board', 'sidebar'), page('mail-digest', 'panel', 'panel')])} />);
    const detail = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    const tabs = within(detail).getByRole('tablist');
    expect(within(tabs).getAllByRole('tab').map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['详情', 'true'],
      ['设置', 'false'],
    ]);
    // Not loaded until its tab is picked; 详情 shows what it always showed.
    expect(detail.querySelector('iframe')).toBeNull();
    expect(within(detail).getByText('工具')).toBeTruthy();
    fireEvent.click(within(tabs).getByRole('tab', { name: '设置' }));
    await waitFor(() => expect(detail.querySelector('iframe')).not.toBeNull());
    const frame = detail.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('spica-plugin://notes/ui/settings.html');
    expect(detail.classList.contains('is-page')).toBe(true);
    expect((detail.querySelector('.plugin-detail-body') as HTMLElement).hidden).toBe(true);
    // The name row and the row of what can be done stay.
    expect(within(detail).getByRole('switch', { name: '停用「笔记（示例）」' })).toBeTruthy();
    // Back on 详情 the page stays, hidden (what was typed in it is still there); again on its tab, the same frame.
    fireEvent.click(within(tabs).getByRole('tab', { name: '详情' }));
    expect((detail.querySelector('.plugin-tab-page') as HTMLElement).hidden).toBe(true);
    expect(detail.classList.contains('is-page')).toBe(false);
    fireEvent.click(within(tabs).getByRole('tab', { name: '设置' }));
    expect(detail.querySelector('iframe')).toBe(frame);
    // Another plugin (no settings page): no tabs. Back again: 详情 first, nothing loaded.
    pick('来信摘要');
    const other = (await screen.findByRole('region', { name: '来信摘要（示例）' })) as HTMLElement;
    expect(within(other).queryByRole('tablist')).toBeNull();
    pick('笔记');
    const again = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    expect(within(again).getByRole('tab', { name: '详情' }).getAttribute('aria-selected')).toBe('true');
    expect(again.querySelector('iframe')).toBeNull();
  });

  it('a plugin turned off has no tabs', async () => {
    const off = apiWith((ps) => ps.map((x) => (x.name === 'notes' ? { ...x, enabled: false } : x)));
    render(<Plugins api={off} pages={pages([page('notes', 'settings', 'settings')])} />);
    await screen.findByRole('navigation', { name: '插件列表' });
    await waitFor(() => pick('笔记'));
    const detail = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    expect(within(detail).queryByRole('tablist')).toBeNull();
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
  it('a plugin with its own icon shows it (as a picture) in the list and the detail; the others their letter', async () => {
    render(<Plugins api={api()} />);
    const detail = (await screen.findByRole('region', { name: '笔记（示例）' })) as HTMLElement;
    const own = within(list()).getByRole('button', { name: /笔记/ }).querySelector('.plugin-badge') as HTMLElement;
    expect(own.tagName).toBe('IMG');
    expect(own.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(own.className).toContain('plugin-icon');
    expect(detail.querySelector('.plugin-title img.plugin-icon')).toBeTruthy();
    // The example gives one for each skin: both are there, the style sheet shows the one for the skin in force.
    expect([...detail.querySelectorAll('.plugin-title img.plugin-icon')].map((i) => i.className)).toEqual(['plugin-badge plugin-icon is-light', 'plugin-badge plugin-icon is-dark']);
    const other = within(list()).getByRole('button', { name: /来信摘要/ }).querySelector('.plugin-badge') as HTMLElement;
    expect(other.tagName).toBe('SPAN');
    expect(other.textContent).toBe('来');
  });

  it('the first character (letters in upper case) on a colour the plugin always gets', () => {
    expect(pluginBadge({ name: 'outlook', displayName: 'Outlook mail' }).letter).toBe('O');
    expect(pluginBadge({ name: 'notes', displayName: '笔记（示例）' }).letter).toBe('笔');
    expect(pluginBadge({ name: 'erp', displayName: 'erp 查询' }).letter).toBe('E');
    expect(pluginBadge({ name: 'notes', displayName: '笔记' }).colour).toBe(pluginBadge({ name: 'notes', displayName: '另一个名字' }).colour);
    expect(pluginBadge({ name: 'notes', displayName: '笔记' }).colour).toMatch(/^#[0-9a-f]{6}$/);
  });
});
