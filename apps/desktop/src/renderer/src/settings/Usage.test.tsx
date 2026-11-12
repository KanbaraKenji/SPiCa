// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RequestRecord, UsageQuery, UsageSummary } from '@spica/protocol';
import { summarizeRequests } from '@spica/core/src/usage.ts';
import { Usage } from './Usage';
import { niceTicks, queryFor, shortCount, usageView, OTHER_KEY } from './usage-data';

afterEach(cleanup);

const rec = (at: string, over: Partial<RequestRecord> = {}): RequestRecord => ({ id: at + (over.model ?? ''), traceId: 't', startedAt: at, durationMs: 1, sessionId: null, initiator: 'model', providerId: 'deepseek', model: 'deepseek-chat', attempt: 1, status: 'ok', httpStatus: 200, inputTokens: 1000, outputTokens: 100, costUsd: 0.01, ...over });

const RECORDS = [
  rec('2026-11-12T02:00:00Z'),
  rec('2026-11-12T03:00:00Z', { status: 'error', httpStatus: 429, errorCode: 'gateway.rate_limited', retried: true, inputTokens: undefined, outputTokens: undefined, costUsd: undefined }),
  rec('2026-11-13T01:00:00Z', { providerId: 'anthropic', model: 'claude-sonnet-4-5', costUsd: 0.2 }),
  rec('2026-11-13T01:30:00Z', { providerId: 'gateway', model: 'gateway-model', unpriced: true, costUsd: undefined }),
];

describe('usage-data', () => {
  it('today is by the hour from local midnight; the others whole local days, with the window’s offset', () => {
    const now = new Date(2026, 10, 13, 15, 30);
    const today = queryFor('today', now);
    expect(today.bucket).toBe('hour');
    expect(Date.parse(today.from)).toBe(new Date(2026, 10, 13).getTime());
    const week = queryFor('7d', now);
    expect(week.bucket).toBe('day');
    expect(Date.parse(week.from)).toBe(new Date(2026, 10, 7).getTime());
    expect(week.tzOffsetMinutes).toBe(-now.getTimezoneOffset());
  });

  it('every bucket of the range is a column; before the log starts it is marked, not zero', () => {
    const q: UsageQuery = { from: '2026-11-10T00:00:00Z', to: '2026-11-13T12:00:00Z', bucket: 'day', tzOffsetMinutes: 0 };
    const v = usageView(summarizeRequests(RECORDS, q, '2026-11-12T02:00:00Z'), 6);
    expect(v.columns.map((c) => c.noData)).toEqual([true, true, false, false]);
    expect(v.since).toBe(Date.parse('2026-11-12T02:00:00Z'));
    expect(v.columns[2]!.rateLimited).toBe(1);
    expect(v.totals).toMatchObject({ requests: 4, rateLimited: 1, failed: 1, unpriced: true });
    expect(v.totals.costUsd).toBeCloseTo(0.21);
  });

  it('series keep their color by name, and fold past the cap into 其他', () => {
    const q: UsageQuery = { from: '2026-11-12T00:00:00Z', to: '2026-11-14T00:00:00Z', bucket: 'day', tzOffsetMinutes: 0 };
    const all = usageView(summarizeRequests(RECORDS, q, null), 6).series;
    expect(all.map((s) => s.model)).toEqual(['claude-sonnet-4-5', 'deepseek-chat', 'gateway-model']);
    expect(all[1]!.color).toBe('var(--spica-series-2)');
    const two = usageView(summarizeRequests(RECORDS, q, null), 2).series;
    expect(two.map((s) => s.key)).toEqual(['anthropic\u0000claude-sonnet-4-5', OTHER_KEY]);
    expect(two[1]!.requests).toBe(3);
  });

  it('short counts and round axes', () => {
    expect(shortCount(999)).toBe('999');
    expect(shortCount(12_345)).toBe('12.3K');
    expect(shortCount(7_030_000)).toBe('7.03M');
    expect(niceTicks(66, 2)).toEqual([0, 50, 100]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe('设置 › 用量', () => {
  const now = () => new Date('2026-11-13T12:00:00Z');
  function setup() {
    const summary = vi.fn(async (q: UsageQuery): Promise<UsageSummary> => summarizeRequests(RECORDS, q, '2026-11-12T02:00:00Z'));
    render(<Usage api={{ summary, providerNames: async () => ({ deepseek: 'DeepSeek' }) }} now={now} />);
    return summary;
  }

  it('shows the totals with 429 on its own, the 429 list, and a row per model', async () => {
    setup();
    await screen.findByText('按模型');
    const tile = (label: string) => [...document.querySelectorAll('.usage-tile')].find((t) => t.querySelector('.usage-tile-label')?.textContent === label);
    expect(tile('429')?.classList.contains('is-limited')).toBe(true);
    expect(tile('429')?.querySelector('.usage-tile-value')?.textContent).toBe('1');
    // how many requests had no price, under the cost; the reason on hover
    expect(tile('花费')?.querySelector('.usage-tile-sub')?.textContent).toBe('未计价请求 1');
    expect(tile('花费')?.querySelector('.usage-tile-sub')?.getAttribute('title')).toBe('没有价格的模型，不计入花费');
    const rows = [...document.querySelectorAll('.usage-table tbody tr')].map((r) => r.textContent);
    expect(rows.some((r) => r?.includes('已重试') && r.includes('DeepSeek'))).toBe(true);
    expect(rows.filter((r) => r?.includes('claude-sonnet-4-5'))).toHaveLength(1);
  });

  it('asks again for another range and keeps the numbers until they come', async () => {
    const summary = setup();
    await screen.findByText('按模型');
    expect(summary.mock.calls[0]![0].bucket).toBe('day');
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: '今天' }));
    });
    expect(summary.mock.calls.at(-1)![0].bucket).toBe('hour');
    expect(screen.getByText('按模型')).toBeTruthy();
  });

  it('says when the log starts when that is inside the range', async () => {
    setup();
    await act(async () => {
      fireEvent.click(await screen.findByRole('radio', { name: '30 天' }));
    });
    expect(document.querySelector('.usage-since')?.textContent).toContain('起有记录');
    expect(document.querySelectorAll('.usage-nodata').length).toBeGreaterThan(0);
    // the word is on the grey run itself, not only on hover
    expect([...document.querySelectorAll('.usage-nodata-label')].map((t) => t.textContent)).toContain('无记录');
  });

  it('cannot reach the core: one line', async () => {
    render(<Usage api={{ summary: async () => null }} now={now} />);
    expect(await screen.findByText('无法读取用量')).toBeTruthy();
  });
});

describe('搜索设置 finds 用量', () => {
  it('by its name or what it shows', async () => {
    const { SettingsSearchContext } = await import('./Group');
    const results = document.createElement('div');
    document.body.appendChild(results);
    const jump = vi.fn();
    const summary = vi.fn();
    render(
      <SettingsSearchContext.Provider value={{ query: '429', results, sectionHit: false, jump }}>
        <Usage api={{ summary }} />
      </SettingsSearchContext.Provider>,
    );
    expect(results.textContent).toBe('用量');
    expect(summary).not.toHaveBeenCalled();
    fireEvent.click(results.querySelector('button')!);
    expect(jump).toHaveBeenCalled();
    results.remove();
  });
});
