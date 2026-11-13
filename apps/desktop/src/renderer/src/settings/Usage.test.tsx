// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RequestRecord, UsageQuery, UsageSummary } from '@spica/protocol';
import { summarizeRequests } from '@spica/core/src/usage.ts';
import { Usage } from './Usage';
import { niceTicks, queryFor, shortCount, usageCsvName, usageCsvRows, usageView, OTHER_KEY } from './usage-data';

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
    // the 429 is in rateLimited only: 失败 is the other failures
    expect(v.totals).toMatchObject({ requests: 4, rateLimited: 1, failed: 0, unpriced: true });
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
    await screen.findByRole('img', { name: 'Token 用量' });
    const tile = (label: string) => [...document.querySelectorAll('.usage-tile')].find((t) => t.querySelector('.usage-tile-label')?.textContent === label);
    expect(tile('429')?.classList.contains('is-limited')).toBe(true);
    expect(tile('429')?.querySelector('.usage-tile-value')?.textContent).toBe('1');
    // two lines a tile: the name and the number; requests without a price only on the cost's hover
    expect([...document.querySelectorAll('.usage-tile')].every((t) => t.children.length === 2)).toBe(true);
    expect(tile('花费')?.getAttribute('title')).toBe('未计价请求 1：没有价格的模型，不计入花费');
    const rows = [...document.querySelectorAll('.usage-table tbody tr')].map((r) => r.textContent);
    expect(rows.some((r) => r?.includes('已重试') && r.includes('DeepSeek'))).toBe(true);
    expect(rows.filter((r) => r?.includes('claude-sonnet-4-5'))).toHaveLength(1);
  });

  it('asks again for another range and keeps the numbers until they come', async () => {
    const summary = setup();
    await screen.findByRole('img', { name: 'Token 用量' });
    expect(summary.mock.calls[0]![0].bucket).toBe('day');
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: '今天' }));
    });
    expect(summary.mock.calls.at(-1)![0].bucket).toBe('hour');
    expect(screen.getByRole('img', { name: 'Token 用量' })).toBeTruthy();
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

  it('names the providers as the main process does (the made-up demo ones too)', async () => {
    const summary = vi.fn(async (q: UsageQuery): Promise<UsageSummary> => ({ ...summarizeRequests(RECORDS, q, '2026-11-12T02:00:00Z'), providerNames: { anthropic: 'Anthropic Claude', gateway: '公司网关' } }));
    render(<Usage api={{ summary, providerNames: async () => ({ anthropic: '开发用模型（Anthropic）' }) }} now={now} />);
    await screen.findByRole('img', { name: 'Token 用量' });
    const rows = [...document.querySelectorAll('.usage-table tbody tr')].map((r) => r.textContent ?? '');
    expect(rows.some((r) => r.includes('Anthropic Claude'))).toBe(true);
    expect(rows.some((r) => r.includes('公司网关'))).toBe(true);
    expect(rows.some((r) => r.includes('开发用模型'))).toBe(false);
  });

  it('cannot reach the core: one line', async () => {
    render(<Usage api={{ summary: async () => null }} now={now} />);
    expect(await screen.findByText('无法读取用量')).toBeTruthy();
  });
});

describe('the hover card', () => {
  it('opens toward the side with room: a column on the right gets it on its left, never past the edge', async () => {
    const { tipSide } = await import('./Usage');
    expect(tipSide(100, 640)).toEqual({ left: 110 });
    expect(tipSide(620, 640)).toEqual({ right: 30 });
    expect(tipSide(640, 640)).toEqual({ right: 10 });
  });
});

describe('the tables on a narrow pane', () => {
  it('every cell carries its column name (a narrow pane lists name and value)', async () => {
    const summary = vi.fn(async (q: UsageQuery): Promise<UsageSummary> => summarizeRequests(RECORDS, q, '2026-11-12T02:00:00Z'));
    render(<Usage api={{ summary }} now={() => new Date('2026-11-13T12:00:00Z')} />);
    await screen.findByRole('img', { name: 'Token 用量' });
    const cells = [...document.querySelectorAll('.usage-table tbody td')];
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c.getAttribute('data-label'))).toBe(true);
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

describe('one model or all', () => {
  const now = () => new Date('2026-11-13T12:00:00Z');
  async function pick(label: string) {
    await act(async () => {
      fireEvent.click(screen.getByRole('combobox', { name: '模型' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemradio', { name: label }));
    });
  }

  it('lists 全部模型 and each model with its provider; picking one counts only it everywhere', async () => {
    const summary = vi.fn(async (q: UsageQuery): Promise<UsageSummary> => summarizeRequests(RECORDS, q, '2026-11-12T02:00:00Z'));
    render(<Usage api={{ summary, providerNames: async () => ({ deepseek: 'DeepSeek' }) }} now={now} />);
    await screen.findByRole('img', { name: 'Token 用量' });
    expect(screen.getByRole('combobox', { name: '模型' }).textContent).toBe('全部模型');
    await act(async () => {
      fireEvent.click(screen.getByRole('combobox', { name: '模型' }));
    });
    expect(screen.getAllByRole('menuitemradio').map((m) => m.textContent)).toEqual(['全部模型', 'claude-sonnet-4-5 · anthropic', 'deepseek-chat · DeepSeek', 'gateway-model · gateway']);
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'deepseek-chat · DeepSeek' }));
    });
    const tile = (label: string) => [...document.querySelectorAll('.usage-tile')].find((t) => t.querySelector('.usage-tile-label')?.textContent === label)?.querySelector('.usage-tile-value')?.textContent;
    expect(tile('请求')).toBe('2');
    expect(tile('429')).toBe('1');
    const models = [...document.querySelectorAll('.usage-table tbody tr')].map((r) => r.textContent ?? '');
    expect(models.some((r) => r.includes('claude-sonnet-4-5'))).toBe(false);
    // and back
    await pick('全部模型');
    expect(tile('请求')).toBe('4');
  });

  it('one model picked: the hover card is by function module (对话, 记忆整理, 插件 …), not by model', async () => {
    const recs = [
      rec('2026-11-12T03:00:00Z'),
      rec('2026-11-12T04:00:00Z', { initiator: 'runtime:memory-tidy', inputTokens: 500, outputTokens: 50 }),
      rec('2026-11-12T05:00:00Z', { initiator: 'plugin:example-notes', httpStatus: 429, status: 'error', errorCode: 'gateway.rate_limited', inputTokens: 0, outputTokens: 0 }),
      rec('2026-11-12T05:01:00Z', { initiator: 'view:example-notes' }),
      rec('2026-11-12T05:30:00Z', { initiator: 'plugin:gone' }),
      rec('2026-11-12T06:00:00Z', { providerId: 'anthropic', model: 'claude-sonnet-4-5' }),
    ];
    const summary = vi.fn(async (q: UsageQuery): Promise<UsageSummary> => summarizeRequests(recs, q, '2026-11-12T02:00:00Z'));
    // a plugin by the name its page shows; one no longer installed by its id
    render(<Usage api={{ summary, providerNames: async () => ({ deepseek: 'DeepSeek' }), pluginNames: async () => ({ 'example-notes': '笔记（示例）' }) }} now={now} />);
    await screen.findByRole('img', { name: 'Token 用量' });
    await pick('deepseek-chat · DeepSeek');
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: '请求' }));
    });
    const cols = [...screen.getByRole('img', { name: '请求数' }).querySelectorAll('rect[fill="transparent"]')];
    fireEvent.mouseEnter(cols[5]!);
    const tip = document.querySelector('.usage-tip')!;
    expect(tip.querySelector('.usage-tip-head')?.textContent).toBe('按功能模块');
    const lines = [...tip.querySelectorAll('.usage-tip-row')].map((r) => r.textContent);
    // the other model's request is not in it; a plugin's borrowing and its view are one module
    expect(lines).toEqual(['请求5', '4291', '对话1', '记忆整理1', '插件 笔记（示例）(1)2', '插件 gone1']);
    // tokens: by module too
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Token' }));
    });
    fireEvent.mouseEnter([...screen.getByRole('img', { name: 'Token 用量' }).querySelectorAll('rect[fill="transparent"]')][5]!);
    const rows = [...document.querySelector('.usage-tip')!.querySelectorAll('.usage-tip-row')].map((r) => r.textContent);
    expect(rows.slice(-4)).toEqual(['对话1,100', '记忆整理550', '插件 笔记（示例）1,100', '插件 gone1,100']);
  });

  it('a model picked stays picked in a range without it', async () => {
    const summary = vi.fn(async (q: UsageQuery): Promise<UsageSummary> => summarizeRequests(RECORDS, q, '2026-11-12T02:00:00Z'));
    render(<Usage api={{ summary }} now={now} />);
    await screen.findByRole('img', { name: 'Token 用量' });
    await act(async () => {
      fireEvent.click(screen.getByRole('combobox', { name: '模型' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'deepseek-chat · deepseek' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: '今天' }));
    });
    expect(screen.getByRole('combobox', { name: '模型' }).textContent).toBe('deepseek-chat · deepseek');
  });
});

describe('the requests chart', () => {
  it('draws requests and 429 as two lines; the hover card has both totals, then each model with its 429 in red', async () => {
    const summary = vi.fn(async (q: UsageQuery): Promise<UsageSummary> =>
      summarizeRequests([...RECORDS, rec('2026-11-12T05:00:00Z', { providerId: 'anthropic', model: 'claude-sonnet-4-5' })], q, '2026-11-12T02:00:00Z'),
    );
    render(<Usage api={{ summary }} now={() => new Date('2026-11-13T12:00:00Z')} />);
    await screen.findByRole('img', { name: 'Token 用量' });
    // Token first; the tabs at the chart's right end switch it to requests (as before)
    expect(screen.queryByRole('img', { name: '请求数' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Token' }).getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: '请求' }));
    });
    expect(screen.queryByRole('img', { name: 'Token 用量' })).toBeNull();
    const chart = screen.getByRole('img', { name: '请求数' });
    // smooth curves, not straight segments
    expect(chart.querySelector('.usage-line.is-requests .usage-line-stroke')?.getAttribute('d')).toMatch(/C/);
    expect(chart.querySelectorAll('.usage-line.is-requests').length).toBeGreaterThan(0);
    expect(chart.querySelectorAll('.usage-line.is-limited').length).toBeGreaterThan(0);
    // no separate 429 chart any more
    expect(screen.queryByRole('img', { name: '429 次数' })).toBeNull();
    const cols = [...chart.querySelectorAll('rect[fill="transparent"]')];
    // 7 days ending the 13th: the 12th is the sixth column
    fireEvent.mouseEnter(cols[5]!);
    const tip = document.querySelector('.usage-tip')!;
    // the date on the left, the column's requests on the right (as his old design)
    expect(tip.querySelector('.usage-tip-title')?.textContent).toBe('2026-11-123');
    const lines = [...tip.querySelectorAll('.usage-tip-row')].map((r) => r.textContent);
    expect(lines.slice(0, 2)).toEqual(['请求3', '4291']);
    expect(tip.querySelector('.usage-tip-head')?.textContent).toBe('按模型');
    // no provider column; the model's 429 answers in red just before its number, which ends the line
    expect(lines).toContain('deepseek-chat(1)2');
    const model = [...tip.querySelectorAll('.usage-tip-row')].find((r) => r.textContent?.startsWith('deepseek-chat'))!;
    expect([...model.children].map((c) => c.className)).toEqual(['usage-tip-mark', 'usage-tip-name', 'usage-limited-num', 'usage-num']);
    expect(model.querySelector('.usage-tip-provider')).toBeNull();
    // every line has its mark, so every name starts in one place: the chart's series coloured, the models quiet
    expect(model.querySelector('.usage-swatch.is-plain')).toBeTruthy();
    expect([...tip.querySelectorAll('.usage-tip-row')][0]!.querySelector('.usage-swatch.is-plain')).toBeNull();
  });

  it('a model name two providers have says its provider after it (no provider column)', async () => {
    const summary = vi.fn(async (q: UsageQuery): Promise<UsageSummary> =>
      summarizeRequests([...RECORDS, rec('2026-11-12T05:00:00Z', { providerId: 'gateway', model: 'deepseek-chat' })], q, '2026-11-12T02:00:00Z'),
    );
    render(<Usage api={{ summary, providerNames: async () => ({ deepseek: 'DeepSeek', gateway: '公司网关' }) }} now={() => new Date('2026-11-13T12:00:00Z')} />);
    await screen.findByRole('img', { name: 'Token 用量' });
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: '请求' }));
    });
    fireEvent.mouseEnter([...screen.getByRole('img', { name: '请求数' }).querySelectorAll('rect[fill="transparent"]')][5]!);
    const names = [...document.querySelectorAll('.usage-tip .usage-tip-name')].map((n) => n.textContent);
    expect(names).toContain('deepseek-chat · DeepSeek');
    expect(names).toContain('deepseek-chat · 公司网关');
  });

  it('the token bars are by kind, and the hover card says each kind', async () => {
    const summary = vi.fn(async (q: UsageQuery): Promise<UsageSummary> =>
      summarizeRequests([rec('2026-11-13T01:00:00Z', { inputTokens: 1000, cacheReadTokens: 400, outputTokens: 100 }), rec('2026-11-13T02:00:00Z', { inputTokens: 50, outputTokens: 5 })], q, '2026-11-12T02:00:00Z'),
    );
    render(<Usage api={{ summary }} now={() => new Date('2026-11-13T12:00:00Z')} />);
    await screen.findByRole('img', { name: 'Token 用量' });
    expect([...document.querySelectorAll('.usage-legend')].at(-1)!.textContent).toBe('缓存命中缓存未命中输入（未报告缓存）输出');
    const chart = screen.getByRole('img', { name: 'Token 用量' });
    fireEvent.mouseEnter([...chart.querySelectorAll('rect[fill="transparent"]')].at(-1)!);
    const tip = document.querySelector('.usage-tip')!;
    expect(tip.querySelector('.usage-tip-title')?.textContent).toBe('2026-11-131,155');
    expect([...tip.querySelectorAll('.usage-tip-row')].map((r) => r.textContent)).toEqual(['缓存命中400', '缓存未命中600', '输入（未报告缓存）50', '输出105']);
  });
});

describe('导出 CSV', () => {
  const now = () => new Date('2026-11-13T12:00:00Z');
  it('one row per day and model, in the range and for the model picked', async () => {
    const q = queryFor('7d', now());
    const rows = usageCsvRows(summarizeRequests(RECORDS, q, null), (id) => (id === 'deepseek' ? 'DeepSeek' : id));
    expect(rows[0]).toEqual(['时间', '服务商', '模型', '请求', '429', '失败', '输入', '输出', '缓存读', '缓存写', '花费（美元）']);
    expect(rows[1]).toEqual(['2026-11-12', 'DeepSeek', 'deepseek-chat', '2', '1', '0', '1000', '100', '0', '0', '0.01']);
    // no price: the cost is blank, not 0
    expect(rows.find((r) => r[2] === 'gateway-model')?.[10]).toBe('');
    expect(usageCsvName(summarizeRequests(RECORDS, q, null), null)).toMatch(/^用量-\d{8}-20261113\.csv$/);
  });

  it('the button saves what is shown and says where it went', async () => {
    const summary = vi.fn(async (q: UsageQuery): Promise<UsageSummary> => summarizeRequests(RECORDS, q, '2026-11-12T02:00:00Z'));
    const saveCsv = vi.fn(async () => ({ file: 'C:\\Users\\me\\Documents\\用量.csv' }));
    const showInFolder = vi.fn();
    render(<Usage api={{ summary, saveCsv, showInFolder }} now={now} />);
    await screen.findByRole('img', { name: 'Token 用量' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    });
    const [name, text] = saveCsv.mock.calls[0] as unknown as [string, string];
    expect(name).toMatch(/^用量-.*\.csv$/);
    expect(text.split('\r\n')[0]).toBe('时间,服务商,模型,请求,429,失败,输入,输出,缓存读,缓存写,花费（美元）');
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'C:\\Users\\me\\Documents\\用量.csv' }));
    expect(showInFolder).toHaveBeenCalledWith('C:\\Users\\me\\Documents\\用量.csv');
  });
});

describe('smoothPath', () => {
  it('goes through every point and never past its neighbours (no curve under 0 between two zeros)', async () => {
    const { smoothPath } = await import('./Usage');
    const d = smoothPath([[0, 100], [10, 100], [20, 0], [30, 100]]);
    expect(d.startsWith('M0,100C')).toBe(true);
    expect(d.endsWith(' 30,100')).toBe(true);
    // flat between the first two points: the control points stay on the line
    expect(d).toMatch(/^M0,100C[\d.]+,100 [\d.]+,100 10,100/);
  });
});
