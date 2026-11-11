import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@spica/protocol';
import { nextDoneSeen, rollupText, slotsOf, topSlot, unseenDone } from './row-status';

const s = (id: string, status: SessionInfo['status']) => ({ id, status }) as SessionInfo;
const quiet = { active: false, unseenDone: false };

describe('the one status place of a row', () => {
  it('each state has its mark; idle and finished-and-opened have none', () => {
    const kind = (status: SessionInfo['status']) => topSlot(slotsOf(s('a', status), quiet))?.kind ?? null;
    expect(kind('awaiting_answer')).toBe('waiting');
    expect(kind('awaiting_confirm')).toBe('waiting');
    expect(kind('error')).toBe('error');
    expect(kind('interrupted')).toBe('error');
    expect(kind('thinking')).toBe('running');
    expect(kind('tool')).toBe('running');
    expect(kind('queued')).toBe('queued');
    expect(kind('aborted')).toBe('stopped');
    expect(kind('idle')).toBeNull();
    expect(kind('done')).toBeNull();
  });

  it('the most pressing wins: waiting, error, running, news, queued, stopped', () => {
    const over = (...list: SessionInfo['status'][]) => topSlot(list.flatMap((st, i) => slotsOf(s(String(i), st), { note: i === 0 ? '有新来信' : undefined, active: false, unseenDone: false })))?.kind;
    expect(over('thinking', 'awaiting_confirm', 'error')).toBe('waiting');
    expect(over('thinking', 'error', 'queued')).toBe('error');
    expect(over('idle', 'tool', 'queued')).toBe('running');
    expect(over('idle', 'queued', 'aborted')).toBe('news');
    expect(topSlot([...slotsOf(s('a', 'aborted'), quiet), ...slotsOf(s('b', 'queued'), quiet)])?.kind).toBe('queued');
  });

  it('news is not shown on the row that is open; a finished sub-task is news until it is opened', () => {
    expect(slotsOf(s('a', 'idle'), { note: '有新回报', active: true, unseenDone: false })).toEqual([]);
    expect(slotsOf(s('a', 'idle'), { note: '有新回报', active: false, unseenDone: false })).toEqual([{ kind: 'news', text: '有新回报' }]);
    expect(slotsOf(s('a', 'done'), { active: false, unseenDone: true })).toEqual([{ kind: 'news', text: '已完成' }]);
    expect(slotsOf(s('a', 'done'), { active: true, unseenDone: true })).toEqual([]);
  });

  it('a collapsed row says the counts that are not zero, then what is new, each once', () => {
    const all = [
      ...slotsOf(s('a', 'awaiting_answer'), quiet),
      ...slotsOf(s('b', 'tool'), quiet),
      ...slotsOf(s('c', 'thinking'), quiet),
      ...slotsOf(s('d', 'error'), quiet),
      ...slotsOf(s('e', 'done'), { active: false, unseenDone: true }),
      ...slotsOf(s('f', 'queued'), quiet),
      ...slotsOf(s('g', 'aborted'), quiet),
      ...slotsOf(s('h', 'idle'), { note: '有新来信 · 有新回报', active: false, unseenDone: false }),
      ...slotsOf(s('i', 'idle'), { note: '有新来信', active: false, unseenDone: false }),
    ];
    expect(rollupText(all)).toBe('1 个待处理 · 1 个出错 · 2 个运行中 · 1 个已完成 · 1 个排队中 · 1 个已停止 · 有新来信 · 有新回报');
    expect(rollupText([])).toBe('');
  });
});

describe('which finished sub-tasks have been opened', () => {
  const list = [s('a', 'done'), s('b', 'done'), s('c', 'thinking'), s('d', 'idle')];

  it('nothing recorded yet: none is news, and everything finished so far is taken as seen', () => {
    expect([...unseenDone(list, null)]).toEqual([]);
    expect(nextDoneSeen(list, null, null)).toEqual(['a', 'b']);
  });

  it('one that finishes later is news until it is opened', () => {
    const later = [s('a', 'done'), s('b', 'done'), s('c', 'done'), s('d', 'idle')];
    expect([...unseenDone(later, ['a', 'b'])]).toEqual(['c']);
    expect(nextDoneSeen(later, ['a', 'b'], 'd')).toBeNull();
    expect(nextDoneSeen(later, ['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect([...unseenDone(later, ['a', 'b', 'c'])]).toEqual([]);
  });

  it('one that runs again leaves the record, so its next finish is news again', () => {
    expect(nextDoneSeen([s('a', 'tool'), s('b', 'done')], ['a', 'b'], null)).toEqual(['b']);
    expect([...unseenDone([s('a', 'done'), s('b', 'done')], ['b'])]).toEqual(['a']);
  });

  it('a list that is short for a moment does not empty the record', () => {
    expect(nextDoneSeen([], ['a', 'b'], null)).toBeNull();
    expect(nextDoneSeen([s('b', 'done')], ['a', 'b'], null)).toBeNull();
    expect([...unseenDone(list, ['a', 'b'])]).toEqual([]);
  });

  it('nothing to change: null, so nothing is written', () => {
    expect(nextDoneSeen(list, ['a', 'b'], 'a')).toBeNull();
    expect(nextDoneSeen(list, ['a', 'b'], 'c')).toBeNull();
  });
});
