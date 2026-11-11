// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RailHead, SidebarHead, SidebarToggle } from './SidebarToggle';

afterEach(cleanup);

describe('SidebarToggle', () => {
  it('collapsed: carries the dot for what is new in 对话 and 项目, with its text on hover', () => {
    const onToggle = vi.fn();
    render(<SidebarToggle shown={false} news="有新来信 · 有新回报" onToggle={onToggle} />);
    const button = screen.getByRole('button', { name: /展开侧栏/ });
    expect(screen.getByRole('img', { name: '有新来信 · 有新回报' }).getAttribute('title')).toBe('有新来信 · 有新回报');
    expect(button.contains(screen.getByRole('img'))).toBe(true);
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalled();
  });

  it('no dot while the sidebar is shown (the rows carry it) or when nothing is new', () => {
    render(<SidebarToggle shown news="有新回报" onToggle={vi.fn()} />);
    expect(screen.queryByRole('img')).toBeNull();
    cleanup();
    render(<SidebarToggle shown={false} news="" onToggle={vi.fn()} />);
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('SidebarHead', () => {
  const toggle = <SidebarToggle shown news="" onToggle={vi.fn()} />;
  const brand = <span>Spica</span>;

  it('slid out by resting on the icon column: only the toggle, where the column has it; no brand', () => {
    const { container } = render(<SidebarHead peek toggle={toggle} brand={brand} />);
    expect(screen.queryByText('Spica')).toBeNull();
    expect(container.querySelector('.sidebar-head')?.className).toContain('is-over-rail');
    expect(screen.getByRole('button', { name: '收起侧栏' })).toBeTruthy();
  });

  it('opened with the toggle: the brand first, the toggle at the end', () => {
    const { container } = render(<SidebarHead peek={false} toggle={toggle} brand={brand} />);
    const head = container.querySelector('.sidebar-head')!;
    expect(head.className).not.toContain('is-over-rail');
    expect(head.firstElementChild?.textContent).toBe('Spica');
    expect(head.lastElementChild?.getAttribute('aria-label')).toBe('收起侧栏');
  });
});

describe('the top of the icon column', () => {
  it('resting on the toggle is what slides the sidebar out; the rest of the head does not', () => {
    const onRest = vi.fn();
    const onLeave = vi.fn();
    const { container } = render(<RailHead toggle={<button type="button">开关</button>} onRest={onRest} onLeave={onLeave} />);
    fireEvent.mouseOver(container.querySelector('.rail-head')!);
    expect(onRest).not.toHaveBeenCalled();
    fireEvent.mouseOver(screen.getByRole('button', { name: '开关' }));
    expect(onRest).toHaveBeenCalledTimes(1);
    fireEvent.mouseLeave(container.querySelector('.rail-toggle')!);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
