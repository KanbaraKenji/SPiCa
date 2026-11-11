import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { barChartPng } from './demo-image';

describe('the demo backend’s picture', () => {
  it('is a well-formed PNG of the size asked for', () => {
    const png = barChartPng(60, 30);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([60, 30]);
    // The image data unpacks to the full raster.
    const idatLen = png.readUInt32BE(33);
    expect(png.toString('ascii', 37, 41)).toBe('IDAT');
    expect(inflateSync(png.subarray(41, 41 + idatLen)).length).toBe((60 * 3 + 1) * 30);
    // The end chunk's checksum is fixed for every PNG.
    expect(png.subarray(png.length - 4).toString('hex')).toBe('ae426082');
  });
});
