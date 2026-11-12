// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { IMAGE_SCALE, ImageGroup, ImageViewer, useImageGroup, zoomView, type Picture } from './ImageViewer';

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
    render(<ImageViewer pictures={[{ url: 'data:image/png;base64,AA==', name: '图' }]} onClose={vi.fn()} />);
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
    render(<ImageViewer pictures={[{ url: 'data:image/png;base64,AA==', name: '图' }]} onClose={onClose} />);
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

describe('going through the pictures of a group', () => {
  const four = [1, 2, 3, 4].map((n) => ({ url: `data:image/png;base64,${n}`, name: `图${n}` }));
  const shownUrl = () => document.querySelector('.image-viewer img')?.getAttribute('src');

  it('one picture: no ‹ N of M › row', () => {
    render(<ImageViewer pictures={four.slice(0, 1)} onClose={vi.fn()} />);
    expect(document.querySelector('.image-viewer-nav')).toBeNull();
  });

  it('‹ N of M › under the picture; the arrows and the arrow keys go back and on, stopping at the ends; a click on it does not close', () => {
    const onClose = vi.fn();
    render(<ImageViewer pictures={four} start={1} onClose={onClose} />);
    expect(document.querySelector('.image-viewer-count')?.textContent).toBe('2 of 4');
    expect(shownUrl()).toBe(four[1]!.url);
    fireEvent.click(screen.getByRole('button', { name: '下一张' }));
    expect(document.querySelector('.image-viewer-count')?.textContent).toBe('3 of 4');
    expect(onClose).not.toHaveBeenCalled();
    const viewer = document.querySelector('.image-viewer')!;
    fireEvent.keyDown(viewer, { key: 'ArrowRight' });
    fireEvent.keyDown(viewer, { key: 'ArrowRight' });
    expect(document.querySelector('.image-viewer-count')?.textContent).toBe('4 of 4');
    expect((screen.getByRole('button', { name: '下一张' }) as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 5; i++) fireEvent.keyDown(viewer, { key: 'ArrowLeft' });
    expect(document.querySelector('.image-viewer-count')?.textContent).toBe('1 of 4');
    expect(shownUrl()).toBe(four[0]!.url);
    expect((screen.getByRole('button', { name: '上一张' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a zoomed picture is back at its size when another is shown', () => {
    render(<ImageViewer pictures={four} onClose={vi.fn()} />);
    const viewer = document.querySelector('.image-viewer')!;
    act(() => {
      viewer.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    fireEvent.keyDown(viewer, { key: 'ArrowRight' });
    const transform = (document.querySelector('.image-viewer img') as HTMLElement).style.transform;
    expect(transform).toMatch(/scale\(1\)$/);
    expect(transform).not.toContain('1.15');
  });

  function Thumb({ p }: { p: Picture }) {
    const ref = useRef<HTMLButtonElement>(null);
    const group = useImageGroup(ref, p.url, p.name);
    const [open, setOpen] = useState<{ pictures: Picture[]; index: number } | null>(null);
    return (
      <>
        <button type="button" ref={ref} aria-label={p.name} onClick={() => setOpen(group())} />
        {open ? <ImageViewer pictures={open.pictures} start={open.index} onClose={() => setOpen(null)} /> : null}
      </>
    );
  }

  it('pictures in one ImageGroup go together in the order they show; one outside a group is alone', () => {
    render(
      <>
        <ImageGroup>
          {four.slice(0, 3).map((p) => (
            <Thumb key={p.url} p={p} />
          ))}
        </ImageGroup>
        <Thumb p={four[3]!} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: '图2' }));
    expect(document.querySelector('.image-viewer-count')?.textContent).toBe('2 of 3');
    fireEvent.keyDown(document.querySelector('.image-viewer')!, { key: 'Escape' });
    cleanup();
    render(<Thumb p={four[3]!} />);
    fireEvent.click(screen.getByRole('button', { name: '图4' }));
    expect(document.querySelector('.image-viewer-nav')).toBeNull();
    expect(shownUrl()).toBe(four[3]!.url);
  });
});
