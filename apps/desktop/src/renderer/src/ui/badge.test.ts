import { describe, expect, it } from 'vitest';
import { BADGE_COLOURS, letterBadge } from './badge';

describe('letterBadge', () => {
  it('the first character, a letter in capitals; the colour follows the key only', () => {
    expect(letterBadge('alex.chen', 'ALEX.CHEN').letter).toBe('A');
    expect(letterBadge(' 陈 ', 'x').letter).toBe('陈');
    expect(letterBadge('', 'x').letter).toBe('?');
    expect(letterBadge('one', 'k').colour).toBe(letterBadge('other', 'k').colour);
    expect(BADGE_COLOURS).toContain(letterBadge('a', 'ALEX.CHEN').colour);
  });
});
