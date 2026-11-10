// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SidebarToggle } from './SidebarToggle';

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
