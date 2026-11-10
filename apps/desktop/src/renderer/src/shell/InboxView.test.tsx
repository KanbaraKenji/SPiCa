// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { seedMail, FAKE_PROJECTS } from '../../../main/backend/fake-mail';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import { mailTime } from '../../../shared/mail';
import type { MailView } from '../store/mail';
import { InboxView, type InboxViewProps } from './InboxView';

afterEach(cleanup);

const now = new Date('2026-11-09T10:00:00+08:00');
const view = (over: Partial<MailView> = {}): MailView => ({
  supported: true,
  loaded: true,
  items: seedMail(now),
  polling: false,
  lastPolledAt: null,
  lastAdded: null,
  problem: '',
  threadId: null,
  flagged: [],
  triageModel: null,
  ...over,
});

function setup(over: Partial<InboxViewProps> = {}) {
  const props: InboxViewProps = {
    mail: view(),
    prefs: DEFAULT_SETTINGS.mail,
    projects: FAKE_PROJECTS.map((p) => ({ ...p })),
    onPoll: vi.fn(),
    onAccept: vi.fn(),
    onIgnore: vi.fn(),
    onMove: vi.fn(),
    onNewProject: vi.fn(),
    onOpenSession: vi.fn(),
    onOpenSettings: vi.fn(),
    onDismissProblem: vi.fn(),
    now,
    ...over,
  };
  render(<InboxView {...props} />);
  return props;
}

describe('InboxView', () => {
  it('lists what waits for the user with where it went and why', () => {
    setup();
    // 6 demo mails; one was already accepted.
    expect(screen.getAllByRole('article')).toHaveLength(5);
    const card = screen.getByRole('article', { name: '外壳模具报价补充说明' });
    expect(within(card).getByText('归入 新品样机评审')).toBeTruthy();
    expect(within(card).getByText('置信度高')).toBeTruthy();
    // The core's English reason for sender memory is never shown.
    expect(screen.getByText('该发件人的邮件曾归入此项目')).toBeTruthy();
    expect(screen.queryByText(/same sender/)).toBeNull();
    expect(screen.queryByRole('article', { name: '会议室预订成功' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '全部' }));
    expect(within(screen.getByRole('article', { name: '会议室预订成功' })).getByText('已采纳')).toBeTruthy();
  });

  it('accepts, ignores, moves and opens the project', () => {
    const p = setup();
    const card = screen.getByRole('article', { name: '外壳模具报价补充说明' });
    fireEvent.click(within(card).getByRole('button', { name: '采纳' }));
    expect(p.onAccept).toHaveBeenCalledWith('demo:m1');
    fireEvent.click(within(card).getByRole('button', { name: '忽略' }));
    expect(p.onIgnore).toHaveBeenCalledWith('demo:m1');
    fireEvent.click(within(card).getByRole('button', { name: '打开项目' }));
    expect(p.onOpenSession).toHaveBeenCalledWith('s-pm-1');
    fireEvent.click(within(card).getByRole('button', { name: '更改项目' }));
    // Only the other project is offered.
    expect(screen.queryByRole('menuitem', { name: '新品样机评审' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: '年度预算' }));
    expect(p.onMove).toHaveBeenCalledWith('demo:m1', 'p-budget');
  });

  it('offers to start a project for a new matter, and no 忽略 on what is already ignored', () => {
    const p = setup();
    const fresh = screen.getByRole('article', { name: '季度团建活动征集意见' });
    expect(within(fresh).getByText('新事务：季度团建')).toBeTruthy();
    expect(within(fresh).queryByRole('button', { name: '采纳' })).toBeNull();
    fireEvent.click(within(fresh).getByRole('button', { name: '新建项目' }));
    expect(p.onNewProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'demo:m4' }));
    const news = screen.getByRole('article', { name: '本周行业资讯' });
    expect(within(news).getByText('无需处理')).toBeTruthy();
    expect(within(news).queryByRole('button', { name: '忽略' })).toBeNull();
    expect(within(news).getByRole('button', { name: '采纳' })).toBeTruthy();
  });

  it('marks a mail whose text carried instructions', () => {
    setup({ mail: view({ flagged: ['demo:m1'] }) });
    const card = screen.getByRole('article', { name: '外壳模具报价补充说明' });
    expect(within(card).getByText('邮件中含有指令，已忽略')).toBeTruthy();
    expect(screen.getAllByText('邮件中含有指令，已忽略')).toHaveLength(1);
  });

  it('says what to do when there is no mail, and when sorting is off', () => {
    const p = setup({ mail: view({ items: [] }), prefs: { ...DEFAULT_SETTINGS.mail, enabled: false } });
    expect(screen.getByText('没有邮件')).toBeTruthy();
    expect(screen.getByText('邮件分类已关闭')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '开启' }));
    expect(p.onOpenSettings).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '现在查收' }));
    expect(p.onPoll).toHaveBeenCalled();
  });

  it('模拟模式 on: the top says the mail is demo data', () => {
    setup({ mock: true });
    expect(screen.getByText('模拟数据')).toBeTruthy();
    cleanup();
    setup();
    expect(screen.queryByText('模拟数据')).toBeNull();
  });

  it('after 现在查收: when, and what it found, also when nothing new came', () => {
    // The time is shown in the machine's zone; the expectation uses the same formatter.
    const polled = '2026-11-09T09:58:00+08:00';
    const at = mailTime(polled, now);
    setup({ mail: view({ lastPolledAt: polled, lastAdded: 0 }), prefs: { ...DEFAULT_SETTINGS.mail, enabled: true } });
    expect(screen.getByText(`上次 ${at} · 没有新邮件`, { exact: false })).toBeTruthy();
    cleanup();
    setup({ mail: view({ lastPolledAt: polled, lastAdded: 3 }), prefs: { ...DEFAULT_SETTINGS.mail, enabled: true } });
    expect(screen.getByText(`上次 ${at} · 3 封新邮件`, { exact: false })).toBeTruthy();
    cleanup();
    // While it runs: the button shows it is working and cannot be clicked again.
    setup({ mail: view({ polling: true }) });
    expect((screen.getByRole('button', { name: '现在查收' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
