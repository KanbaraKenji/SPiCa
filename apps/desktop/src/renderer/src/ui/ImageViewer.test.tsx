// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { IMAGE_SCALE, ImageViewer, zoomView } from './ImageViewer';

afterEach(cleanup);

describe('zooming a picture around the pointer', () => {
  it('keeps the point under the pointer where it is', () => {
    const v = zoomView({ scale: 1, x: 0, y: 0 }, 2, 100, -40);
    expect(v).toEqual({ scale: 2, x: -100, y: 40 });
    // The picture point that was under the pointer: (px - x) / scale, the same before and after.
    expect((100 - v.x) / v.scale).toBe(100);
  });

  it('stays within its limits, and back at 1 sits in the middle again', () => {
    expect(zoomView({ scale: IMAGE_SCALE.max, x: 5, y: 5 }, 2, 0, 0)).toEqual({ scale: IMAGE_SCALE.max, x: 5, y: 5 });
    expect(zoomView({ scale: 2, x: -100, y: 40 }, 0.5, 30, 30)).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('the picture viewer', () => {
  it('Ctrl+wheel zooms the picture, not the window', () => {
    const windowZoom = vi.fn();
    window.addEventListener('wheel', windowZoom);
    render(<ImageViewer url="data:image/png;base64,AA==" name="图" onClose={vi.fn()} />);
    const viewer = document.querySelector('.image-viewer')!;
    act(() => {
      viewer.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(windowZoom).not.toHaveBeenCalled();
    expect((document.querySelector('.image-viewer img') as HTMLElement).style.transform).toContain('scale(1.15)');
    // Without Ctrl the wheel is left alone.
    viewer.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    expect(windowZoom).toHaveBeenCalledTimes(1);
    window.removeEventListener('wheel', windowZoom);
  });

  it('a click closes it; a drag moves the picture and does not', () => {
    const onClose = vi.fn();
    render(<ImageViewer url="data:image/png;base64,AA==" name="图" onClose={onClose} />);
    const viewer = document.querySelector('.image-viewer')!;
    fireEvent.pointerDown(viewer, { clientX: 10, clientY: 10, buttons: 1 });
    fireEvent.pointerMove(viewer, { clientX: 60, clientY: 30, buttons: 1 });
    fireEvent.pointerUp(viewer);
    fireEvent.click(viewer);
    expect(onClose).not.toHaveBeenCalled();
    expect((document.querySelector('.image-viewer img') as HTMLElement).style.transform).toContain('translate(50px, 20px)');
    fireEvent.pointerDown(viewer, { clientX: 10, clientY: 10, buttons: 1 });
    fireEvent.pointerUp(viewer);
    fireEvent.click(viewer);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
