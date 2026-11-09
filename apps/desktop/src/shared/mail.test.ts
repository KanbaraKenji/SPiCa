import { describe, expect, it } from 'vitest';
import type { MailItem } from '@spica/protocol';
import { mailTime, needsYou, reasonOf, surenessOf, unseenByManager, verdictOf } from './mail';
import { sanitizeSettings } from './settings';

const base: MailItem = {
  id: 'src:1',
  sourceId: 'src',
  messageId: '1',
  subject: '外壳报价',
  status: 'routed',
  routedTo: 'pm-1',
  triage: { decision: 'project', projectId: 'p1', reason: '讲的是报价', confidence: 0.9, by: 'model', at: '2026-11-09T10:00:00+08:00' },
  createdAt: '2026-11-09T10:00:00+08:00',
  updatedAt: '2026-11-09T10:01:00+08:00',
};
const names = (id: string) => (id === 'p1' ? '样机评审' : undefined);

describe('verdictOf', () => {
  it('says where the mail went and whether the user handled it', () => {
    expect(verdictOf(base, names)).toEqual({ tone: 'project', text: '归到 样机评审', handled: '' });
    expect(verdictOf({ ...base, feedback: { action: 'accept', at: base.updatedAt } }, names).handled).toBe('已采纳');
    expect(verdictOf({ ...base, status: 'ignored', feedback: { action: 'ignore', at: base.updatedAt } }, names)).toEqual({ tone: 'ignore', text: '不用管', handled: '已忽略' });
    expect(verdictOf({ ...base, status: 'new', triage: undefined }, names).text).toBe('正在分类');
    expect(verdictOf({ ...base, triage: { ...base.triage!, decision: 'new', suggestion: '团建' } }, names).text).toBe('新事务：团建');
    expect(verdictOf({ ...base, triage: { ...base.triage!, projectId: 'gone' } }, names).text).toBe('归到 已删除的项目');
  });
});

describe('reasonOf and surenessOf', () => {
  it('writes the core’s own reasons in words', () => {
    expect(reasonOf(base)).toBe('讲的是报价');
    expect(reasonOf({ ...base, triage: { ...base.triage!, by: 'rule', decision: 'ignore', reason: 'matches the ignore rule x' } })).toBe('按规则忽略');
    expect(reasonOf({ ...base, triage: { ...base.triage!, by: 'sender_memory', decision: 'ignore', reason: 'you ignored…' } })).toBe('上次你忽略过');
    expect(reasonOf({ ...base, triage: { ...base.triage!, by: 'sender_memory', reason: 'same sender…' } })).toBe('这个发件人的信你以前放进过这个项目');
    expect(reasonOf({ ...base, feedback: { action: 'reassign', projectId: 'p1', at: base.updatedAt } })).toBe('');
  });

  it('shows how sure only for the model’s open decisions', () => {
    expect(surenessOf(base)).toBe('把握大');
    expect(surenessOf({ ...base, triage: { ...base.triage!, confidence: 0.6 } })).toBe('把握一般');
    expect(surenessOf({ ...base, triage: { ...base.triage!, confidence: 0.2 } })).toBe('把握小');
    expect(surenessOf({ ...base, triage: { ...base.triage!, by: 'rule' } })).toBe('');
    expect(surenessOf({ ...base, feedback: { action: 'accept', at: base.updatedAt } })).toBe('');
  });
});

describe('needsYou and unseenByManager', () => {
  it('counts mail a manager got after the user last looked', () => {
    expect(needsYou(base)).toBe(true);
    expect(needsYou({ ...base, status: 'new' })).toBe(false);
    expect(unseenByManager([base], {}).get('pm-1')).toBe(1);
    // Seen later than it arrived (other time zone notation too).
    expect(unseenByManager([base], { 'pm-1': '2026-11-09T02:05:00.000Z' }).size).toBe(0);
    expect(unseenByManager([base], { 'pm-1': '2026-11-09T01:00:00.000Z' }).get('pm-1')).toBe(1);
    // Accepted in the inbox: handled there.
    expect(unseenByManager([{ ...base, feedback: { action: 'accept', at: base.updatedAt } }], {}).size).toBe(0);
  });
});

describe('mailTime', () => {
  it('shows the time today and the date otherwise', () => {
    const now = new Date(2026, 10, 9, 15, 0);
    expect(mailTime(new Date(2026, 10, 9, 9, 5).toISOString(), now)).toBe('09:05');
    expect(mailTime(new Date(2026, 10, 7, 9, 5).toISOString(), now)).toBe('11月7日');
    expect(mailTime(undefined, now)).toBe('');
  });
});

describe('mail settings', () => {
  it('defaults to on every 5 minutes and cleans what it reads', () => {
    expect(sanitizeSettings({}).mail).toEqual({ enabled: true, intervalMinutes: 5, ignore: { from: [], subject: [] } });
    const s = sanitizeSettings({ mail: { enabled: false, intervalMinutes: 0, ignore: { from: [' news@ ', '', 3], subject: 'x' } }, workflowsDir: ' D:\\流程 ', mailSeen: { a: 'nope', b: '2026-11-09T10:00:00Z' } });
    expect(s.mail).toEqual({ enabled: false, intervalMinutes: 1, ignore: { from: ['news@'], subject: [] } });
    expect(s.workflowsDir).toBe('D:\\流程');
    expect(s.mailSeen).toEqual({ b: '2026-11-09T10:00:00Z' });
  });
});
