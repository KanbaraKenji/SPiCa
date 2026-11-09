// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PANEL_LIMITS } from '../../../shared/settings';
import { Resizer } from './Resizer';

afterEach(cleanup);

describe('Resizer', () => {
  it('drags the sidebar wider (live preview, saved on release), within its limits', () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    render(<Resizer side="left" width={264} onPreview={onPreview} onCommit={onCommit} />);
    const edge = screen.getByRole('separator', { name: '调整侧栏宽度' });
    edge.setPointerCapture = () => {};
    fireEvent.pointerDown(edge, { button: 0, clientX: 264, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 300, pointerId: 1 });
    expect(onPreview).toHaveBeenLastCalledWith(300);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(edge, { clientX: 2000, pointerId: 1 });
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(onCommit).toHaveBeenCalledWith(PANEL_LIMITS.left.max);
  });

  it('the right panel grows to the left; keys and double-click work too', () => {
    const onCommit = vi.fn();
    render(<Resizer side="right" width={300} onPreview={vi.fn()} onCommit={onCommit} />);
    const edge = screen.getByRole('separator', { name: '调整详情栏宽度' });
    fireEvent.keyDown(edge, { key: 'ArrowLeft' });
    expect(onCommit).toHaveBeenLastCalledWith(316);
    fireEvent.keyDown(edge, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenLastCalledWith(284);
    fireEvent.doubleClick(edge);
    expect(onCommit).toHaveBeenLastCalledWith(PANEL_LIMITS.right.initial);
  });
});
