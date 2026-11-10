import { describe, expect, it, vi } from 'vitest';
import { sidebarNews } from './sidebar-news';

describe('what the sidebar shows as new', () => {
  const inbox = { count: 3, open: false, onOpen: vi.fn() };
  const notes = new Map([['ses_pm', '有新回报']]);

  it('without a mail plugin: no 收件箱, but a project with an unseen report keeps its dot', () => {
    const news = sidebarNews({ inboxShown: false, inbox, notes });
    expect(news.inbox).toBeUndefined();
    expect(news.notes?.get('ses_pm')).toBe('有新回报');
  });

  it('with a mail plugin: 收件箱 and the dots', () => {
    const news = sidebarNews({ inboxShown: true, inbox, notes });
    expect(news.inbox).toBe(inbox);
    expect(news.notes).toBe(notes);
  });
});
