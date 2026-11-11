// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RailHead, SidebarHead, SidebarToggle } from './SidebarToggle';

afterEach(cleanup);

describe('SidebarToggle', () => {
  it('opens and closes the sidebar; it carries no dot, collapsed or not', () => {
    const onToggle = vi.fn();
    render(<SidebarToggle shown={false} onToggle={onToggle} />);
    const button = screen.getByRole('button', { name: /展开侧栏/ });
    expect(button.querySelector('[role="img"]')).toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalled();
    cleanup();
    render(<SidebarToggle shown onToggle={vi.fn()} />);
    expect(screen.getByRole('button', { name: /收起侧栏/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('SidebarHead', () => {
  const toggle = <SidebarToggle shown onToggle={vi.fn()} />;
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
