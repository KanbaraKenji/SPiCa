// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ColorPicker, hexToHsv, hsvToHex } from './ColorPicker';

afterEach(cleanup);

describe('the colour picker', () => {
  it('hex and hue, saturation, value turn into each other', () => {
    for (const hex of ['#62a9ff', '#191919', '#ff0000', '#3aa55d', '#ffffff', '#000000']) expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    expect(hexToHsv('#ff0000')).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv('#808080').s).toBe(0);
  });

  it('the swatch opens the app’s own layer (no browser colour input): the area, the hue bar, the hex; Esc closes it', () => {
    render(<ColorPicker label="强调色" value="#62a9ff" onChange={vi.fn()} />);
    expect(document.querySelector('input[type="color"]')).toBeNull();
    const swatch = screen.getByRole('button', { name: '强调色取色' });
    expect(swatch.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(swatch);
    const layer = screen.getByRole('dialog', { name: '强调色取色' });
    expect(screen.getByRole('slider', { name: '强调色饱和度与亮度' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: '强调色色相' }).getAttribute('aria-valuenow')).toBe('213');
    expect((layer.querySelector('input') as HTMLInputElement).value).toBe('#62a9ff');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the keys move the hue and the colour; a hex typed in the layer is taken on Enter', () => {
    const onChange = vi.fn();
    render(<ColorPicker label="底色" value="#ff0000" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '底色取色' }));
    fireEvent.keyDown(screen.getByRole('slider', { name: '底色色相' }), { key: 'ArrowRight', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(hsvToHex({ h: 10, s: 1, v: 1 }));
    fireEvent.keyDown(screen.getByRole('slider', { name: '底色饱和度与亮度' }), { key: 'ArrowDown', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(hsvToHex({ h: 10, s: 1, v: 0.9 }));
    const hex = screen.getByRole('dialog').querySelector('input')!;
    fireEvent.change(hex, { target: { value: '#123456' } });
    fireEvent.keyDown(hex, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('#123456');
  });

  it('a press elsewhere closes it', () => {
    render(
      <div>
        <ColorPicker label="底色" value="#191919" onChange={vi.fn()} />
        <p>elsewhere</p>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: '底色取色' }));
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
