import { describe, expect, it, vi } from 'vitest';
import { firstWorking, orderSources } from './pick-source';

describe('choosing among the addresses of one source', () => {
  it('tries them as written, once each, and stops at the first that works', async () => {
    expect(orderSources(['\\\\near\\spica', 'https://far.example.com/spica/', '\\\\near\\spica', ''])).toEqual(['\\\\near\\spica', 'https://far.example.com/spica/']);
    const attempt = vi.fn(async (p: string) => {
      if (p.startsWith('\\\\near')) throw new Error('unreachable');
      return `read ${p}`;
    });
    expect(await firstWorking(['\\\\near\\spica', 'https://far.example.com/spica/', 'https://third.example.com/'], attempt)).toEqual({
      place: 'https://far.example.com/spica/',
      value: 'read https://far.example.com/spica/',
    });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('none works: the first address’s error, which is the one meant', async () => {
    await expect(
      firstWorking(['a', 'b'], async (p) => {
        throw new Error(`no ${p}`);
      }),
    ).rejects.toThrow('no a');
    await expect(firstWorking([], async () => 1)).rejects.toThrow('no address');
  });
});
