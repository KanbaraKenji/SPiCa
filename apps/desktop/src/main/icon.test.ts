import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flatten, icoFromPngs, inkFor, TASKBAR_FRAME_SIZES } from './icon';

describe('taskbar icon', () => {
  it('is one flat color with the same shape (premultiplied BGRA)', () => {
    // opaque blue, half-transparent blue, transparent
    const px = new Uint8Array([255, 120, 40, 255, 128, 60, 20, 128, 0, 0, 0, 0]);
    expect([...flatten(px, 'white')]).toEqual([255, 255, 255, 255, 128, 128, 128, 128, 0, 0, 0, 0]);
    expect([...flatten(px, 'black')]).toEqual([0, 0, 0, 255, 0, 0, 0, 128, 0, 0, 0, 0]);
    // the input is not changed
    expect(px[0]).toBe(255);
  });

  it('follows the taskbar: white on dark, black on light', () => {
    expect(inkFor(true)).toBe('white');
    expect(inkFor(false)).toBe('black');
  });

  it('writes an .ico that holds the PNGs', () => {
    const a = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
    const b = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2, 3]);
    const ico = icoFromPngs([
      { size: 256, png: a },
      { size: 32, png: b },
    ]);
    const v = new DataView(ico.buffer);
    expect([v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true)]).toEqual([0, 1, 2]);
    // first entry: 256 is written as 0, 32 bpp, size and offset
    expect([ico[6], ico[7], v.getUint16(12, true), v.getUint32(14, true), v.getUint32(18, true)]).toEqual([0, 0, 32, 5, 38]);
    expect([ico[22], v.getUint32(30, true), v.getUint32(34, true)]).toEqual([32, 6, 43]);
    expect([...ico.slice(38, 43)]).toEqual([...a]);
    expect([...ico.slice(43)]).toEqual([...b]);
  });

  it('the brand draws a mask for every taskbar size; an .ico of them lists every frame', () => {
    const dir = join(__dirname, '..', '..', 'resources', 'branding', 'png');
    const images = TASKBAR_FRAME_SIZES.map((size) => {
      const png = readFileSync(join(dir, `spica-taskbar-${size}.png`));
      // PNG IHDR: width and height at bytes 16-23, drawn at that size (not scaled from another).
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
      return { size, png: new Uint8Array(png) };
    });
    const ico = Buffer.from(icoFromPngs(images));
    expect(ico.readUInt16LE(4)).toBe(12);
    const widths = TASKBAR_FRAME_SIZES.map((_, i) => ico[6 + i * 16]);
    expect(widths).toEqual(TASKBAR_FRAME_SIZES.map((s) => (s >= 256 ? 0 : s)));
  });
});
