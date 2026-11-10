// Keys are shown the same way everywhere: long ones by their ends, mid-length
// ones by the last 4, short ones not at all.
import { describe, expect, it } from 'vitest';
import { keyMaskParts, keyMaskText } from './index';

describe('key mask', () => {
  it('24 characters or more: first and last 4; 12 to 23: last 4; shorter: nothing', () => {
    expect(keyMaskText(keyMaskParts('sk-0123456789abcdef0123456789abcd3f9a'))).toBe('sk-0****3f9a');
    expect(keyMaskText(keyMaskParts('ck-0123456789ab'))).toBe('****89ab');
    expect(keyMaskText(keyMaskParts('short-key'))).toBe('****');
    // the edges
    expect(keyMaskParts('a'.repeat(23) + 'Z')).toEqual({ head: 'aaaa', tail: 'aaaZ' });
    expect(keyMaskParts('b'.repeat(22) + 'Y')).toEqual({ head: '', tail: 'bbbY' });
    expect(keyMaskParts('c'.repeat(11) + 'X')).toEqual({ head: '', tail: 'cccX' });
    expect(keyMaskParts('d'.repeat(11))).toEqual({ head: '', tail: '' });
    expect(keyMaskParts('  ck-0123456789ab  ')).toEqual({ head: '', tail: '89ab' }); // surrounding spaces do not count
  });
});
