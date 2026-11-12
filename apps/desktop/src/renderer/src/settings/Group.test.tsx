// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Group, Pane, Row } from './Group';

afterEach(cleanup);

describe('settings › one group, one box', () => {
  it('a title line with the group’s own buttons, then one box holding the rows and panes', () => {
    const { container } = render(
      <Group title="使用日志" actions={<button type="button">导出…</button>} after={<p>当前：直连</p>}>
        <Row title="时间" hint="说明">
          <button type="button">全部</button>
        </Row>
        <Pane>
          <p>已导出</p>
        </Pane>
      </Group>,
    );
    const group = container.querySelector('.settings-group')!;
    expect(screen.getByRole('heading', { name: '使用日志' }).closest('.group-head')?.textContent).toContain('导出…');
    const box = group.querySelector('.group-box')!;
    expect([...box.children].map((c) => c.className)).toEqual(['setting-row', 'group-pane']);
    // What belongs under the box is not in it.
    expect(box.textContent).not.toContain('当前：直连');
    expect(group.textContent).toContain('当前：直连');
  });

  it('no title and no buttons: no title line', () => {
    const { container } = render(
      <Group>
        <Row title="启用记忆" />
      </Group>,
    );
    expect(container.querySelector('.group-head')).toBeNull();
    expect(container.querySelector('.setting-control')).toBeNull();
  });

  it('a row: the name, the grey line, the control; stack puts the control under the name', () => {
    const { container } = render(
      <Row title="更新源" hint="共享盘" stack>
        <input aria-label="更新源" />
      </Row>,
    );
    const row = container.querySelector('.setting-row')!;
    expect(row.classList.contains('is-stack')).toBe(true);
    expect(row.querySelector('.setting-title')?.textContent).toBe('更新源');
    expect(row.querySelector('.settings-hint')?.textContent).toBe('共享盘');
    expect(row.querySelector('.setting-control input')).not.toBeNull();
  });

  it('a path: one line, cut at the end, whole on hover', () => {
    const { container } = render(<Row title="插件目录" hint="D:\\工作\\plugins" path={{ hint: 'D:\\工作\\plugins' }} />);
    const hint = container.querySelector('.settings-hint')!;
    expect(hint.classList.contains('path-text')).toBe(true);
    expect(hint.getAttribute('title')).toBe('D:\\工作\\plugins');
    expect(container.querySelector('.setting-title')?.classList.contains('path-text')).toBe(false);
  });

  it('a path that is the way to it: a button with the path, its action and the whole path on hover; without one, text', () => {
    const open = vi.fn();
    const dir = 'D:\\Spica\\plugins';
    render(
      <Group>
        <Row title="插件目录" hint={dir} path={{ hint: dir, open }} />
        <Row title="证书" hint={'D:\\ca.pem'} path={{ hint: 'D:\\ca.pem' }} />
        <Row title="导出" hint="—" path={{ hint: '', open }} />
      </Group>,
    );
    const link = screen.getByRole('button', { name: `打开文件夹：${dir}` });
    expect(link.className).toContain('path-link');
    expect(link.textContent).toBe(dir);
    expect(link.getAttribute('title')).toBe(`打开文件夹：${dir}`);
    fireEvent.click(link);
    expect(open).toHaveBeenCalledTimes(1);
    // Only the one with a way and a path is a button.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

