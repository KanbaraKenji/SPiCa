// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { McpServers, type McpApi, type McpView } from './McpServers';
import { demoMcpApi } from './demo-mcp';

afterEach(cleanup);

/** The page as 插件 › MCP 服务 keeps it, starting at the form (添加 MCP 服务 is on the tab row there). */
function Adding({ api }: { api: McpApi }) {
  const [view, setView] = useState<McpView>({ at: 'edit', name: null });
  return <McpServers api={api} view={view} onView={setView} />;
}

describe('MCP 服务', () => {
  it('lists the services: the command under the name, the state at the end', async () => {
    render(<McpServers api={demoMcpApi()} />);
    const files = await screen.findByRole('button', { name: /^files/ });
    expect(files.textContent).toContain('npx -y @example/files-server "D:\\Shared Files"');
    expect(screen.getByRole('button', { name: /^weather/ }).textContent).toContain('已停用');
  });

  it('a service failed: its page says why and shows the last lines it wrote', async () => {
    render(<McpServers api={demoMcpApi()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^notes/ }));
    expect(screen.getByText('进程已退出（代码 1）')).toBeTruthy();
    expect(document.querySelector('.mcp-log pre')?.textContent).toContain('FileNotFoundError');
    expect(screen.getByRole('radio', { name: '每次询问' }).getAttribute('aria-checked')).toBe('true');
  });

  it('保存 asks first, with the whole command; a name in use is said in its box', async () => {
    const api = demoMcpApi('none');
    const save = vi.spyOn(api, 'save');
    render(<Adding api={api} />);
    fireEvent.change(await screen.findByRole('textbox', { name: '名称' }), { target: { value: 'mail' } });
    fireEvent.change(screen.getByRole('textbox', { name: '命令' }), { target: { value: 'npx' } });
    fireEvent.change(screen.getByRole('textbox', { name: '参数' }), { target: { value: '-y\n@example/files\nD:\\Shared Files' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText('名称已被使用')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: 'files' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    const ask = screen.getByRole('alertdialog');
    expect(within(ask).getByText('添加「files」？')).toBeTruthy();
    expect(ask.querySelector('pre')?.textContent).toBe('npx -y @example/files "D:\\Shared Files"');
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: '添加' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![1].args).toBe('-y\n@example/files\nD:\\Shared Files');
    // saved: its page
    expect(await screen.findByRole('region', { name: 'files' })).toBeTruthy();
  });

  it('粘贴配置 fills the form from another app\'s mcpServers', async () => {
    render(<Adding api={demoMcpApi('none')} />);
    fireEvent.click(await screen.findByRole('button', { name: '粘贴配置' }));
    fireEvent.change(screen.getByRole('textbox', { name: '配置文本' }), {
      target: { value: JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', '@example/files'], env: { TOKEN: 'x' } }, web: { url: 'https://example.com/mcp' } } }) },
    });
    fireEvent.click(screen.getByRole('button', { name: '识别并填入' }));
    expect((screen.getByRole('textbox', { name: '名称' }) as HTMLInputElement).value).toBe('files');
    expect((screen.getByRole('textbox', { name: '参数' }) as HTMLTextAreaElement).value).toBe('-y\n@example/files');
    expect((screen.getByRole('textbox', { name: '变量名' }) as HTMLInputElement).value).toBe('TOKEN');
    expect(screen.getByText('另有 1 项未填入：web')).toBeTruthy();
  });

  it('网址: the switch shows 网址 and 密钥 (更多请求头 folded); http to another computer is refused; 保存 shows the address and masks only', async () => {
    const api = demoMcpApi('none');
    const save = vi.spyOn(api, 'save');
    render(<Adding api={api} />);
    fireEvent.click(await screen.findByRole('radio', { name: '网址' }));
    expect(screen.queryByRole('textbox', { name: '命令' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: 'docs' } });
    fireEvent.change(screen.getByRole('textbox', { name: '网址' }), { target: { value: 'http://mcp.example.com/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText('只支持 https（本机地址可用 http）')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: '网址' }), { target: { value: 'https://mcp.example.com/mcp' } });
    fireEvent.change(screen.getByLabelText('密钥'), { target: { value: 'dk-secret-value-0000-77aa' } });
    expect(screen.queryByRole('textbox', { name: '请求头名称' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '更多请求头' }));
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.change(screen.getByRole('textbox', { name: '请求头名称' }), { target: { value: 'X-Team' } });
    fireEvent.change(screen.getByLabelText('X-Team 的值'), { target: { value: 'team-secret-docs' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    const ask = screen.getByRole('alertdialog');
    expect(ask.querySelector('pre')?.textContent).toBe('https://mcp.example.com/mcp');
    expect(ask.textContent).toContain('dk-s****77aa');
    expect(ask.textContent).toContain('X-Team');
    expect(ask.textContent).not.toMatch(/dk-secret|team-secret/);
    fireEvent.click(within(ask).getByRole('button', { name: '添加' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![1]).toMatchObject({ kind: 'url', url: 'https://mcp.example.com/mcp', key: 'dk-secret-value-0000-77aa', headers: [{ name: 'X-Team', value: 'team-secret-docs' }] });
    const page = await screen.findByRole('region', { name: 'docs' });
    expect(page.textContent).toContain('https://mcp.example.com/mcp');
  });

  it('粘贴配置 with a web address: 网址, the Bearer key in 密钥, the other headers under 更多请求头', async () => {
    render(<Adding api={demoMcpApi('none')} />);
    fireEvent.click(await screen.findByRole('button', { name: '粘贴配置' }));
    fireEvent.change(screen.getByRole('textbox', { name: '配置文本' }), {
      target: { value: JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ex-key-1', 'X-Team': 'docs' } } } }) },
    });
    fireEvent.click(screen.getByRole('button', { name: '识别并填入' }));
    expect(screen.getByRole('radio', { name: '网址' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('textbox', { name: '网址' }) as HTMLInputElement).value).toBe('https://mcp.example.com/mcp');
    expect((screen.getByLabelText('密钥') as HTMLInputElement).value).toBe('ex-key-1');
    expect((screen.getByRole('textbox', { name: '请求头名称' }) as HTMLInputElement).value).toBe('X-Team');
  });

  it('删除 asks, then the list', async () => {
    const api = demoMcpApi();
    render(<McpServers api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /^files/ }));
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^files/ })).toBeNull());
  });

  it('待下载: 下载 asks first with what would come from where, then the main process is told', async () => {
    const api = demoMcpApi();
    const download = vi.spyOn(api, 'download');
    render(<McpServers api={api} />);
    expect((await screen.findByRole('button', { name: /^docs/ })).textContent).toContain('待下载');
    fireEvent.click(screen.getByRole('button', { name: /^docs/ }));
    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    const ask = screen.getByRole('alertdialog');
    expect(within(ask).getByText('下载「@example/docs-server」？')).toBeTruthy();
    expect(within(ask).getByRole('table').textContent).toContain('registry.npmjs.org');
    expect(download).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: '下载' }));
    await waitFor(() => expect(download).toHaveBeenCalledWith('docs'));
  });
});
