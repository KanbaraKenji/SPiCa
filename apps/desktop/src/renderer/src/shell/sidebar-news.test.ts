import { describe, expect, it, vi } from 'vitest';
import { sidebarNews } from './sidebar-news';

describe('the 收件箱 entry of the sidebar', () => {
  const inbox = { count: 3, open: false, onOpen: vi.fn() };

  it('without a mail plugin: no 收件箱', () => {
    expect(sidebarNews({ inboxShown: false, inbox })).toEqual({});
  });

  it('with a mail plugin: 收件箱', () => {
    expect(sidebarNews({ inboxShown: true, inbox }).inbox).toBe(inbox);
  });
});
