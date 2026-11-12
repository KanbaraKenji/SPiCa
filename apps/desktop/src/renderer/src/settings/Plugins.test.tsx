// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { Plugins, pluginBadge, type PluginsApi, type SettingsPages } from './Plugins';
import type { PluginView as PageView } from '../../../shared/plugin-view';
import { FakePluginService } from '../../../main/plugins/fake';
import { dropAllDrafts } from './drafts';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import type { PluginsProgress, PluginsState, PluginView } from '../../../shared/plugins';

afterEach(() => {
  cleanup();
  dropAllDrafts();
});

function api(): PluginsApi {
  const svc = new FakePluginService('C:\\Users\\me\\AppData\\Roaming\\Spica\\plugins');
  return { run: (cmd) => svc.run(cmd), onChanged: () => () => {} };
}

/** The demo's plugins with changes, for the list's parts, marks and filters. */
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
const row = (name: string) => within(list()).getByRole('button', { name: new RegExp(name) });
/** Opens a plugin's (or under 市场 a package's) page from the list, as a press on its row or card does. */
async function open(name: string, region = name): Promise<HTMLElement> {
  fireEvent.click(await within(await screen.findByRole('navigation', { name: '插件列表' })).findByRole('button', { name: new RegExp(name) }));
  return (await screen.findByRole('region', { name: region })) as HTMLElement;
}
/** ← back to the list, at the page's top left. */
const back = () => fireEvent.click(document.querySelector('.plugin-back') as HTMLElement);
/** The part (已启用 / 已停用) a plugin's row is in. */
const partOf = (name: string) => row(name).closest('.plugins-part')?.getAttribute('aria-label');
/** The sources under 市场, one item each (their cards are items of their own lists). */
const sourceItems = () => [...screen.getByRole('list', { name: '插件来源' }).children] as HTMLElement[];
const sourceTitles = () => sourceItems().map((s) => s.querySelector('.plugins-part-title')?.textContent);
/** Picks a filter from the menu under 筛选. */
function filterBy(label: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: /^筛选：/ }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: label }));
}

describe('Plugins', () => {
  it('lists the plugins one full-width row each under 已启用 / 已停用; a press opens its page in their place, ← back returns', async () => {
    render(<Plugins api={api()} />);
    await screen.findByRole('navigation', { name: '插件列表' });
    expect(within(list()).getByRole('heading', { name: /^已启用/ }).textContent).toBe('已启用2');
    expect(partOf('笔记')).toBe('已启用');
    // No page until one is picked.
    expect(screen.queryByRole('region', { name: '笔记（示例）' })).toBeNull();
    const detail = await open('笔记', '笔记（示例）');
    expect(screen.queryByRole('navigation', { name: '插件列表' })).toBeNull();
    expect(screen.queryByRole('tablist', { name: '插件' })).toBeNull();
    expect(within(detail).getByRole('switch', { name: '停用「笔记（示例）」' })).toBeTruthy();
    expect(within(detail).getByText('工具')).toBeTruthy();
    expect((detail.querySelector('.plugin-back') as HTMLElement).textContent).toBe('已安装');
    back();
    expect(await screen.findByRole('navigation', { name: '插件列表' })).toBeTruthy();
    expect(await open('来信摘要', '来信摘要（示例）')).toBeTruthy();
  });

  it('each row has the version after the name, in the small secondary style; the page says where it is from and the version', async () => {
    render(<Plugins api={api()} />);
    await screen.findByRole('navigation', { name: '插件列表' });
    const version = row('笔记').querySelector('.plugin-version');
    expect(version?.textContent).toBe('0.2.0');
    expect(version?.previousElementSibling?.className).toBe('plugin-row-name');
    const detail = await open('笔记', '笔记（示例）');
    expect(detail.querySelector('.plugin-sub')?.textContent).toMatch(/ · 0\.2\.0$/);
  });

  it('a plugin turned off stays where it is while the page is open; it moves to 已停用 the next time', async () => {
    const a = api();
    const first = render(<Plugins api={a} />);
    const detail = await open('笔记', '笔记（示例）');
    fireEvent.click(within(detail).getByRole('switch', { name: '停用「笔记（示例）」' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: '启用「笔记（示例）」' }).getAttribute('aria-checked')).toBe('false'));
    expect(within(screen.getByRole('region', { name: '笔记（示例）' })).getByText('已停用')).toBeTruthy();
    back();
    // Still in 已启用, shown as off.
    expect(partOf('笔记')).toBe('已启用');
    expect(row('笔记').className).toContain('is-off');
    first.unmount();
    render(<Plugins api={a} />);
    await waitFor(() => expect(partOf('笔记')).toBe('已停用'));
    expect(partOf('来信摘要')).toBe('已启用');
  });

  it('marks an update in the list (可更新); the page offers it at its top right; the mock switch is at the bottom', async () => {
    render(<Plugins api={api()} />);
    await screen.findByRole('navigation', { name: '插件列表' });
    expect(row('来信摘要').querySelector('.plugin-row-state')?.textContent).toBe('可更新');
    expect(row('笔记').querySelector('.plugin-row-state')).toBeNull();
    const mock = screen.getByRole('switch', { name: '模拟模式' });
    fireEvent.click(mock);
    await waitFor(() => expect(mock.getAttribute('aria-checked')).toBe('true'));
    const detail = await open('来信摘要', '来信摘要（示例）');
    expect(within(detail.querySelector('.plugin-head-actions') as HTMLElement).getByRole('button', { name: '更新到 1.1.0' })).toBeTruthy();
  });

  it('search and the filter menu narrow the list, and say so when nothing is left', async () => {
    render(<Plugins api={apiWith((ps) => ps.map((p, i) => (i === 0 ? { ...p, issues: ['manifest.json 缺少 version'] } : p)))} />);
    fireEvent.change(await screen.findByLabelText('搜索插件'), { target: { value: '摘要' } });
    expect(within(list()).queryByRole('button', { name: /笔记/ })).toBeNull();
    expect(row('来信摘要')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('搜索插件'), { target: { value: '没有这个' } });
    expect(screen.getByText('没有匹配的插件')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('搜索插件'), { target: { value: '' } });
    // The menu counts each filter.
    fireEvent.click(screen.getByRole('button', { name: '筛选：全部' }));
    expect(screen.getAllByRole('menuitemradio').map((m) => m.textContent)).toEqual(['全部 2', '已启用 2', '有更新 1', '有问题 1']);
    fireEvent.click(screen.getByRole('menuitemradio', { name: '有问题 1' }));
    expect(screen.getByRole('button', { name: '筛选：有问题' })).toBeTruthy();
    expect(row('笔记')).toBeTruthy();
    expect(within(list()).queryByRole('button', { name: /来信摘要/ })).toBeNull();
    // The problem: marked on the row, said on its page.
    expect(within(row('笔记')).getByRole('img', { name: 'manifest.json 缺少 version' })).toBeTruthy();
    const detail = await open('笔记', '笔记（示例）');
    expect(within(detail).getByText('manifest.json 缺少 version')).toBeTruthy();
    back();
    filterBy(/^有更新/);
    filterBy(/^有问题/);
    expect(row('笔记')).toBeTruthy();
  });

  it('one row on top: 已安装 / 市场, the search, the filter (已安装 only), 全部检查更新 and 添加来源', async () => {
    render(<Plugins api={{ ...api(), pickFolder: async () => null }} />);
    await screen.findByRole('navigation', { name: '插件列表' });
    const bar = document.querySelector('.plugins-bar') as HTMLElement;
    expect(screen.getByRole('tab', { name: /^已安装/ }).getAttribute('aria-selected')).toBe('true');
    expect(within(bar).getAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent)).toEqual(['筛选：全部', '全部检查更新', '添加来源']);
    expect((within(bar).getByLabelText('搜索插件') as HTMLInputElement).placeholder).toBe('搜索插件');
    // 添加来源 goes to 市场, where what is added is listed, with the box open.
    expect(screen.queryByRole('button', { name: '选择文件夹' })).toBeNull();
    fireEvent.click(within(bar).getByRole('button', { name: '添加来源' }));
    expect(screen.getByRole('tab', { name: '市场' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText('插件来源的位置')).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择文件夹' })).toBeTruthy();
    // Under 市场 no filter; the search looks through what the sources offer.
    expect(screen.queryByRole('button', { name: /^筛选：/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('搜索插件'), { target: { value: '术语' } });
    expect(within(list()).getAllByRole('button', { name: /^(笔记|来信摘要|周报助手|术语表)/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['术语表']);
  });

  it('nothing installed: 未安装插件 under the tabs, no rows', async () => {
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
    expect(document.querySelector('.plugin-item')).toBeNull();
  });

  it('市场: one part per source, the official one first (marked, no 移除), each with how it went last time, 检查更新 and 移除 on its title line, then its cards', async () => {
    render(<Plugins api={api()} tab="market" />);
    await screen.findByRole('list', { name: '插件来源' });
    const items = sourceItems();
    expect(sourceTitles()).toEqual(['官方插件官方2', '\\\\fileserver\\spica-plugins2', 'https://plugins.example.com/index.json']);
    expect(within(items[0]!).getByText('官方').className).toContain('provider-default');
    const actions = (s: HTMLElement) => within(s.querySelector('.plugins-part-actions') as HTMLElement).getAllByRole('button').map((b) => b.textContent || b.getAttribute('aria-label'));
    expect(actions(items[0]!)).toEqual(['检查更新']);
    expect(actions(items[1]!)).toEqual(['检查更新', '移除来源']);
    expect(items[1]!.textContent).toMatch(/上次读取 \d\d:\d\d · 2 个插件/);
    expect(within(items[2]!).getByText('连接失败').getAttribute('title')).toMatch(/HTTP 503/);
    // Every package a card with its state: 已安装, 可更新, or nothing (not installed, with + to install).
    const card = (name: string) => within(list()).getByRole('button', { name }).closest('li') as HTMLElement;
    const state = (name: string) => card(name).querySelector('.plugin-row-state')?.textContent ?? '';
    expect(['笔记（示例）', '来信摘要（示例）', '周报助手', '术语表'].map(state)).toEqual(['已安装', '可更新', '', '']);
    expect(within(card('周报助手')).getByRole('button', { name: '安装' })).toBeTruthy();
    expect(within(card('来信摘要（示例）')).getByRole('button', { name: '更新到 1.1.0' })).toBeTruthy();
    expect(within(card('笔记（示例）')).queryByRole('button', { name: /安装|更新/ })).toBeNull();
    // The installed plugins' own things are under 已安装.
    expect(screen.queryByRole('switch', { name: '模拟模式' })).toBeNull();
  });

  it('a package picked: its page has 安装 at the top right; installing says each step and how long, then it is installed, on and its page shown under 已安装', async () => {
    const svc = new FakePluginService('C:\\Users\\me\\AppData\\Roaming\\Spica\\plugins');
    const listeners = new Set<(p: PluginsProgress) => void>();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a: PluginsApi = {
      run: async (cmd) => {
        if (cmd.op === 'installAvailable') {
          // Say a step, then wait to be let go: the page is looked at in between.
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
    await screen.findByRole('navigation', { name: '插件列表' });
    fireEvent.click(screen.getByRole('tab', { name: '市场' }));
    const detail = await open('周报助手');
    expect((detail.querySelector('.plugin-back') as HTMLElement).textContent).toBe('市场');
    expect(within(detail).getByText(/^\\\\fileserver\\spica-plugins\\weekly-report-1\.2\.0\.zip · 1\.2\.0$/)).toBeTruthy();
    fireEvent.click(within(detail.querySelector('.plugin-head-actions') as HTMLElement).getByRole('button', { name: '安装' }));
    await waitFor(() => expect(within(detail).getByRole('status').textContent).toMatch(/^正在下载 3\.0 MB \/ 8\.0 MB\d+s$/));
    expect((detail.querySelector('.plugin-progress-bar > span') as HTMLElement).style.width).toBe('38%');
    release();
    // Now the installed plugin's own page under 已安装: its switch at the top right, on; the result under its title.
    await waitFor(() => expect(within(screen.getByRole('region', { name: '周报助手' })).getByRole('switch', { name: '停用「周报助手」' })).toBeTruthy());
    expect(within(screen.getByRole('region', { name: '周报助手' })).getByText('已安装「周报助手」1.2.0。')).toBeTruthy();
    back();
    expect(screen.getByRole('tab', { name: /^已安装/ }).getAttribute('aria-selected')).toBe('true');
    expect(partOf('周报助手')).toBe('已启用');
  });

  it('a card’s + installs it without opening it', async () => {
    render(<Plugins api={api()} tab="market" />);
    await screen.findByRole('list', { name: '插件来源' });
    const card = within(list()).getByRole('button', { name: '术语表' }).closest('li') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '安装' }));
    expect(await screen.findByText('已安装「术语表」0.3.0。')).toBeTruthy();
    // Installed: the card says so and offers no + (the tab is the caller's here, so it stays on 市场).
    const now = within(list()).getByRole('button', { name: '术语表' }).closest('li') as HTMLElement;
    expect(now.querySelector('.plugin-row-state')?.textContent).toBe('已安装');
    expect(within(now).queryByRole('button', { name: '安装' })).toBeNull();
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
    // Added: the box closes, the source is a part, what it offers is a card in it.
    expect(screen.queryByLabelText('插件来源的位置')).toBeNull();
    const added = sourceItems().find((s) => s.textContent?.includes('D:\\插件\\note-box')) as HTMLElement;
    expect(within(added).getByRole('button', { name: /note-box/ })).toBeTruthy();
    // Nothing there: not added, the box stays open with what was typed, the reason in the result line.
    fireEvent.click(screen.getByRole('button', { name: '添加来源' }));
    fireEvent.change(screen.getByLabelText('插件来源的位置'), { target: { value: 'D:\\插件\\不存在' } });
    fireEvent.submit(screen.getByLabelText('插件来源的位置').closest('form')!);
    expect(await screen.findByText('找不到该文件夹或文件。')).toBeTruthy();
    expect((screen.getByLabelText('插件来源的位置') as HTMLInputElement).value).toBe('D:\\插件\\不存在');
    expect(sourceItems()).toHaveLength(4);
  });

  it('添加来源 › 选择文件夹: the folder picked is added at once', async () => {
    const pickFolder = vi.fn(async () => 'D:/插件/outlook-mail');
    render(<Plugins api={{ ...api(), pickFolder }} tab="market" />);
    fireEvent.click(await screen.findByRole('button', { name: '添加来源' }));
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
    await waitFor(() => expect(sourceTitles().some((t) => t?.startsWith('D:/插件/outlook-mail'))).toBe(true));
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
    expect(sourceTitles()).toEqual(['官方插件官方2', '\\\\fileserver\\spica-plugins2', 'https://plugins.example.com/index.json', '找到的插件']);
  });

  it('检查更新 of one source reads that one; 全部检查更新 reads all and says how many were not reached', async () => {
    const svc = new FakePluginService('C:\\Users\\me\\AppData\\Roaming\\Spica\\plugins');
    const sent: unknown[] = [];
    render(<Plugins api={{ run: (cmd) => (sent.push(cmd), svc.run(cmd)), onChanged: () => () => {} }} tab="market" />);
    await screen.findByRole('list', { name: '插件来源' });
    fireEvent.click(within(sourceItems()[1]!).getByRole('button', { name: '检查更新' }));
    expect(await screen.findByText('1 个插件可更新。')).toBeTruthy();
    expect(sent).toContainEqual({ op: 'checkSources', location: '\\\\fileserver\\spica-plugins' });
    fireEvent.click(screen.getByRole('button', { name: '全部检查更新' }));
    expect(await screen.findByText('已检查 2 个插件来源：1 个插件可更新；1 个连接失败。')).toBeTruthy();
    expect(sent).toContainEqual({ op: 'checkSources' });
  });

  it('移除来源 asks first; removed, its part and cards leave the list', async () => {
    render(<Plugins api={api()} tab="market" />);
    await screen.findByRole('list', { name: '插件来源' });
    fireEvent.click(within(sourceItems()[1]!).getByRole('button', { name: '移除来源' }));
    const box = screen.getByRole('alertdialog');
    expect(within(box).getByText('移除来源「\\\\fileserver\\spica-plugins」？')).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: '移除' }));
    await waitFor(() => expect(sourceItems()).toHaveLength(2));
    expect(within(list()).queryByRole('button', { name: '周报助手' })).toBeNull();
    expect(within(list()).getByRole('button', { name: '笔记（示例）' })).toBeTruthy();
  });

  it('市场: one installed as it is says so and goes to 已安装; one with a newer version offers 更新到', async () => {
    // The tab kept by the caller, as the settings dialog keeps it.
    function Kept() {
      const [tab, setTab] = useState<'installed' | 'market'>('market');
      return <Plugins api={api()} tab={tab} onTab={setTab} />;
    }
    render(<Kept />);
    await screen.findByRole('list', { name: '插件来源' });
    const newer = await open('来信摘要', '来信摘要（示例）');
    expect(within(newer).getByRole('button', { name: '更新到 1.1.0' })).toBeTruthy();
    back();
    const here = await open('笔记', '笔记（示例）');
    expect(here.querySelector('.plugin-head-actions .plugin-here')?.textContent).toBe('已安装');
    expect(within(here).queryByRole('button', { name: /^(重新)?安装/ })).toBeNull();
    fireEvent.click(within(here).getByRole('button', { name: '在已安装中查看' }));
    expect(screen.getByRole('tab', { name: /^已安装/ }).getAttribute('aria-selected')).toBe('true');
    expect(partOf('笔记')).toBe('已启用');
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

  it('a plugin’s page: 更新到, its switch and 「…」 at the top right; 回退到 and 删除 in the 「…」 menu', async () => {
    render(<Plugins api={api()} />);
    const detail = await open('笔记', '笔记（示例）');
    const actions = detail.querySelector('.plugin-head-actions') as HTMLElement;
    expect([...actions.children].map((b) => b.getAttribute('aria-label') || b.textContent)).toEqual(['停用「笔记（示例）」', '更多操作']);
    fireEvent.click(within(actions).getByRole('button', { name: '更多操作' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['回退到 0.1.0', '删除']);
    fireEvent.click(screen.getByRole('menuitem', { name: '回退到 0.1.0' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('将「笔记（示例）」回退到 0.1.0？');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '取消' }));
    back();
    const mailDetail = await open('来信摘要', '来信摘要（示例）');
    expect([...(mailDetail.querySelector('.plugin-head-actions') as HTMLElement).children].map((b) => b.getAttribute('aria-label') || b.textContent)).toEqual(['更新到 1.1.0', '停用「来信摘要（示例）」', '更多操作']);
    fireEvent.click(within(mailDetail).getByRole('button', { name: '更多操作' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['删除']);
  });

  it('opened from 搜索设置 (focus): that plugin’s page', async () => {
    render(<Plugins api={api()} focus="mail-digest" />);
    expect(await screen.findByRole('region', { name: '来信摘要（示例）' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '插件列表' })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: '全部检查更新' }));
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
      fireEvent.click(screen.getByRole('button', { name: '全部检查更新' }));
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

  it('deletes only after confirming; deleted, back on the list', async () => {
    render(<Plugins api={api()} />);
    const detail = await open('笔记', '笔记（示例）');
    fireEvent.click(within(detail).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('删除插件「笔记（示例）」？');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: '笔记（示例）' })).toBeNull());
    await waitFor(() => expect(within(list()).queryByRole('button', { name: /笔记/ })).toBeNull());
  });

  it('today’s spending says 未计价 for calls of a model without a price, never 0 (「+ 未计价」 beside what was counted)', async () => {
    const unpriced = (spent: number) => apiWith((ps) => ps.map((p) => (p.model ? { ...p, model: { ...p.model, spentTodayUsd: spent, unpricedToday: true as const } } : p)));
    render(<Plugins api={unpriced(0)} />);
    let card = await open('笔记', '笔记（示例）');
    expect(within(card).getByText(/今日 未计价$/)).toBeTruthy();
    cleanup();
    render(<Plugins api={unpriced(0.03)} />);
    card = await open('笔记', '笔记（示例）');
    expect(within(card).getByText(/今日 \$0\.03 \+ 未计价$/)).toBeTruthy();
  });

  it('a plugin that uses models says so, with its reason, today’s spending and a limit to lower', async () => {
    render(<Plugins api={api()} />);
    const card = await open('笔记', '笔记（示例）');
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
    await open('笔记', '笔记（示例）');
    const input = screen.getByLabelText('「笔记（示例）」每日上限（美元）') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.05' } });
    expect(within(screen.getByRole('region', { name: '笔记（示例）' })).getByText('未保存')).toBeTruthy();
    first.unmount();
    render(<Plugins api={a} />);
    await open('笔记', '笔记（示例）');
    expect((screen.getByLabelText('「笔记（示例）」每日上限（美元）') as HTMLInputElement).value).toBe('0.05');
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
    const detail = await open('笔记', '笔记（示例）');
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
    // The title line and what can be done there stay.
    expect(within(detail).getByRole('switch', { name: '停用「笔记（示例）」' })).toBeTruthy();
    // Back on 详情 the page stays, hidden (what was typed in it is still there); again on its tab, the same frame.
    fireEvent.click(within(tabs).getByRole('tab', { name: '详情' }));
    expect((detail.querySelector('.plugin-tab-page') as HTMLElement).hidden).toBe(true);
    expect(detail.classList.contains('is-page')).toBe(false);
    fireEvent.click(within(tabs).getByRole('tab', { name: '设置' }));
    expect(detail.querySelector('iframe')).toBe(frame);
    // Another plugin (no settings page): no tabs. Back again: 详情 first, nothing loaded.
    back();
    const other = await open('来信摘要', '来信摘要（示例）');
    expect(within(other).queryByRole('tablist')).toBeNull();
    back();
    const again = await open('笔记', '笔记（示例）');
    expect(within(again).getByRole('tab', { name: '详情' }).getAttribute('aria-selected')).toBe('true');
    expect(again.querySelector('iframe')).toBeNull();
  });

  it('a plugin turned off has no tabs', async () => {
    const off = apiWith((ps) => ps.map((x) => (x.name === 'notes' ? { ...x, enabled: false } : x)));
    render(<Plugins api={off} pages={pages([page('notes', 'settings', 'settings')])} />);
    const detail = await open('笔记', '笔记（示例）');
    expect(within(detail).queryByRole('tablist')).toBeNull();
  });
});

describe('what deleting does, said in the confirm box', () => {
  it('a plugin: its tools and pages', async () => {
    render(<Plugins api={api()} />);
    fireEvent.click(within(await open('笔记', '笔记（示例）')).getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('该插件的工具和页面将不再可用。');
  });
});

describe('mail sorting, with the plugin that provides mail', () => {
  const mail = (over: { model?: string } = {}) => ({ prefs: DEFAULT_SETTINGS.mail, onChange: vi.fn(), ...over });

  it('sits in that plugin’s page; turning it on asks first, naming the model; agreeing records when', async () => {
    const m = mail({ model: 'DeepSeek · deepseek-chat' });
    render(<Plugins api={api()} mail={m} />);
    // Not with the other plugin.
    expect(within(await open('笔记', '笔记（示例）')).queryByRole('switch', { name: '邮件分类' })).toBeNull();
    back();
    const card = await open('来信摘要', '来信摘要（示例）');
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
    await open('来信摘要', '来信摘要（示例）');
    fireEvent.change(await screen.findByLabelText('发件人包含'), { target: { value: 'noreply@' } });
    expect(screen.getByText('未保存')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('region', { name: '来信摘要（示例）' })).getAllByRole('button', { name: '保存' }).at(-1)!);
    expect(onChange).toHaveBeenCalledWith({ ignore: { from: ['noreply@'], subject: [] } });
    expect(screen.getByText('已保存')).toBeTruthy();
  });

  it('cancelling leaves it off', async () => {
    const m = mail();
    render(<Plugins api={api()} mail={m} />);
    await open('来信摘要', '来信摘要（示例）');
    fireEvent.click(await screen.findByRole('switch', { name: '邮件分类' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(m.onChange).not.toHaveBeenCalled();
  });

  it('is gone while no plugin provides mail', async () => {
    render(<Plugins api={api()} mail={mail()} />);
    await open('来信摘要', '来信摘要（示例）');
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
  it('a plugin with its own icon shows it (as a picture) in the list and on its page; the others their letter', async () => {
    render(<Plugins api={api()} />);
    await screen.findByRole('navigation', { name: '插件列表' });
    const own = row('笔记').querySelector('.plugin-badge') as HTMLElement;
    expect(own.tagName).toBe('IMG');
    expect(own.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(own.className).toContain('plugin-icon');
    const other = row('来信摘要').querySelector('.plugin-badge') as HTMLElement;
    expect(other.tagName).toBe('SPAN');
    expect(other.textContent).toBe('来');
    const detail = await open('笔记', '笔记（示例）');
    // The example gives one for each skin: both are there, the style sheet shows the one for the skin in force.
    expect([...detail.querySelectorAll('.plugin-title img.plugin-icon')].map((i) => i.className)).toEqual(['plugin-badge plugin-icon is-light', 'plugin-badge plugin-icon is-dark']);
  });

  it('the first character (letters in upper case) on a colour the plugin always gets', () => {
    expect(pluginBadge({ name: 'outlook', displayName: 'Outlook mail' }).letter).toBe('O');
    expect(pluginBadge({ name: 'notes', displayName: '笔记（示例）' }).letter).toBe('笔');
    expect(pluginBadge({ name: 'erp', displayName: 'erp 查询' }).letter).toBe('E');
    expect(pluginBadge({ name: 'notes', displayName: '笔记' }).colour).toBe(pluginBadge({ name: 'notes', displayName: '另一个名字' }).colour);
    expect(pluginBadge({ name: 'notes', displayName: '笔记' }).colour).toMatch(/^#[0-9a-f]{6}$/);
  });
});
