// 设置 › 用量: token use and requests by model over a time range, from the core's request log
// (one record per HTTP request, see packages/core/src/usage.ts). 429 answers have their own
// tile, their own bars under the chart, a column in the table and a list. Days before the log
// starts are marked, not drawn as zero.
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RequestRecord, UsageSummary, UsageQuery } from '@spica/protocol';
import { Group, matches, SearchHit, SettingsSearchContext } from './Group';
import { bucketLabel, dayLabel, niceTicks, queryFor, RANGES, shortCount, timeLabel, usageView, usd, type UsageColumn, type UsageRange, type UsageSeries, type UsageView } from './usage-data';
import { SERIES_COUNT } from '../../../shared/skin';

export interface UsageApi {
  summary(query: UsageQuery): Promise<UsageSummary | null>;
  /** Saved connections' names by id (a demo or removed connection shows its id). */
  providerNames?(): Promise<Record<string, string>>;
}

export interface UsageProps {
  api: UsageApi;
  /** Clock, for tests and screenshots. */
  now?: () => Date;
}

type Metric = 'requests' | 'tokens';

export function Usage({ api, now = () => new Date() }: UsageProps) {
  const search = useContext(SettingsSearchContext);
  const [range, setRange] = useState<UsageRange>('7d');
  const [metric, setMetric] = useState<Metric>('tokens');
  const [summary, setSummary] = useState<UsageSummary | null | undefined>(undefined);
  const [names, setNames] = useState<Record<string, string>>({});
  const searching = Boolean(search?.query);

  useEffect(() => {
    if (searching) return;
    let live = true;
    // the last numbers stay until the new ones come (no empty flash between ranges)
    api.summary(queryFor(range, now())).then(
      (s) => live && setSummary(s),
      () => live && setSummary(null),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, range, searching]);
  useEffect(() => {
    if (searching || !api.providerNames) return;
    void api.providerNames().then(setNames, () => undefined);
  }, [api, searching]);

  // 搜索设置: the section has no rows; its name and what it shows find it
  if (searching) return search && (search.sectionHit || matches(search.query, '用量', 'Token', '429', '请求数', '花费')) ? <SearchHit title="用量" onGo={() => search.jump('')} /> : null;
  const view = summary ? usageView(summary, SERIES_COUNT) : null;
  const bucket = summary?.query.bucket ?? 'day';
  // the main process's names first (the connections', and the demo's for its made-up records)
  const provider = (id: string) => summary?.providerNames?.[id] ?? names[id] ?? id;

  return (
    <>
      <div className="usage-bar">
        <div className="segmented" role="radiogroup" aria-label="时间">
          {RANGES.map(([r, label]) => (
            <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? 'segment is-on' : 'segment'} onClick={() => setRange(r)}>
              {label}
            </button>
          ))}
        </div>
        <span className="usage-since">
          {view?.since ? `${dayLabel(view.since)} 起有记录 · ` : ''}
          {tzLabel(now())}
        </span>
      </div>
      {summary === null ? <p className="settings-hint usage-empty">无法读取用量</p> : null}
      {view ? (
        <>
          <Tiles view={view} />
          <Group
            title="按模型"
            actions={
              <div className="segmented" role="radiogroup" aria-label="显示">
                {(
                  [
                    ['tokens', 'Token'],
                    ['requests', '请求'],
                  ] as const
                ).map(([m, label]) => (
                  <button key={m} type="button" role="radio" aria-checked={metric === m} className={metric === m ? 'segment is-on' : 'segment'} onClick={() => setMetric(m)}>
                    {label}
                  </button>
                ))}
              </div>
            }
          >
            <div className="group-pane usage-chart-pane">
              <StackChart view={view} metric={metric} bucket={bucket} provider={provider} />
              <Legend series={view.series} />
            </div>
          </Group>
          <Group title="429">
            <div className="group-pane usage-chart-pane">
              <LimitChart view={view} bucket={bucket} />
            </div>
            <LimitList records={summary!.rateLimited} total={view.totals.rateLimited} provider={provider} />
          </Group>
          <Group title="模型">
            <ModelTable series={view.series} provider={provider} />
          </Group>
        </>
      ) : null}
    </>
  );
}

/** The window's time zone as the page names it: UTC+8, UTC-5:30. */
export function tzLabel(d: Date): string {
  const off = -d.getTimezoneOffset();
  const h = Math.trunc(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  return `UTC${off < 0 ? '-' : '+'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

function Tiles({ view }: { view: UsageView }) {
  const t = view.totals;
  const tiles: [string, string, (string | undefined)?][] = [
    ['请求', shortCount(t.requests)],
    ['Token', shortCount(t.inputTokens + t.outputTokens)],
    ['429', shortCount(t.rateLimited)],
    ['失败', shortCount(t.failed)],
    // a model without a price adds nothing: how many requests that is, under the number (the reason on hover)
    ['花费', usd(t.costUsd), t.unpricedRequests ? `未计价请求 ${shortCount(t.unpricedRequests)}` : undefined],
  ];
  return (
    <div className="usage-tiles">
      {tiles.map(([label, value, sub]) => (
        <div key={label} className={label === '429' && t.rateLimited > 0 ? 'usage-tile is-limited' : 'usage-tile'}>
          <span className="usage-tile-label">{label}</span>
          <span className="usage-tile-value">{value}</span>
          {sub ? (
            <span className="usage-tile-sub" title={label === '花费' ? '没有价格的模型，不计入花费' : undefined}>
              {sub}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The width the chart has (the pane's), measured; a fixed width where nothing lays out (tests). */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => el.clientWidth > 0 && setW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const AXIS_W = 44;
const LABEL_H = 18;

interface Hover {
  col: UsageColumn;
  x: number;
}

/** Which columns get a label under them: about one per 56px of chart, always the first. */
function labelEvery(count: number, width: number): number {
  // one label per 56px or so (a date like 10/29 is about 32px at 12px): never crowded, at any zoom
  const room = Math.max(1, Math.floor(width / 56));
  return Math.max(1, Math.ceil(count / room));
}

function StackChart({ view, metric, bucket, provider }: { view: UsageView; metric: Metric; bucket: UsageQuery['bucket']; provider: (id: string) => string }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const height = 180;
  const plotW = Math.max(40, width - AXIS_W);
  const plotH = height - LABEL_H;
  const cols = view.columns;
  const value = (c: UsageColumn, k: string) => (metric === 'requests' ? c.requests[k] : c.tokens[k]) ?? 0;
  const max = Math.max(0, ...cols.map((c) => view.series.reduce((a, s) => a + value(c, s.key), 0)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]!;
  const slot = plotW / Math.max(1, cols.length);
  const barW = Math.max(2, Math.min(28, slot - 4));
  const every = labelEvery(cols.length, plotW);
  return (
    <div className="usage-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={metric === 'requests' ? '请求数' : 'Token 用量'}>
        {ticks.map((t) => {
          const y = plotH - (t / top) * (plotH - 6);
          return (
            <g key={t}>
              <line className="usage-grid" x1={AXIS_W} x2={width} y1={y} y2={y} />
              <text className="usage-axis" x={AXIS_W - 6} y={y} dy="0.32em" textAnchor="end">
                {shortCount(t)}
              </text>
            </g>
          );
        })}
        {cols.map((c, i) => {
          const x = AXIS_W + i * slot + (slot - barW) / 2;
          let y = plotH;
          const segs = view.series.map((s) => ({ s, v: value(c, s.key) })).filter((p) => p.v > 0);
          return (
            <g key={c.start} onMouseEnter={() => setHover({ col: c, x: AXIS_W + i * slot + slot / 2 })}>
              {c.noData ? <rect className="usage-nodata" x={AXIS_W + i * slot} y={0} width={slot} height={plotH} /> : null}
              {/* the hit target is the whole column, wider and taller than the bar */}
              <rect x={AXIS_W + i * slot} y={0} width={slot} height={plotH} fill="transparent" />
              {segs.map(({ s, v }, j) => {
                const h = (v / top) * (plotH - 6);
                y -= h;
                const last = j === segs.length - 1;
                // a 2px gap between segments; the top segment's end is rounded
                return <path key={s.key} d={barPath(x, y, barW, Math.max(0, h - (j > 0 ? 2 : 0)), last ? Math.min(4, barW / 2) : 0)} style={{ fill: s.color }} />;
              })}
              {i % every === 0 ? (
                <text className="usage-axis" x={AXIS_W + i * slot + slot / 2} y={height - 4} textAnchor="middle">
                  {bucketLabel(c.start, bucket)}
                </text>
              ) : null}
            </g>
          );
        })}
        <NoDataLabels cols={cols} slot={slot} plotH={plotH} />
        <line className="usage-baseline" x1={AXIS_W} x2={width} y1={plotH} y2={plotH} />
      </svg>
      {hover ? <ChartTip hover={hover} width={width} view={view} metric={metric} bucket={bucket} provider={provider} /> : null}
    </div>
  );
}

/** 无记录 written on each run of columns before the log starts, when the run is wide enough for the word. */
function NoDataLabels({ cols, slot, plotH }: { cols: UsageColumn[]; slot: number; plotH: number }) {
  const runs: [number, number][] = [];
  cols.forEach((c, i) => {
    if (!c.noData) return;
    const last = runs[runs.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else runs.push([i, i + 1]);
  });
  return (
    <>
      {runs
        .filter(([a, b]) => (b - a) * slot >= 56)
        .map(([a, b]) => (
          <text key={a} className="usage-nodata-label" x={AXIS_W + ((a + b) / 2) * slot} y={plotH / 2} dy="0.32em" textAnchor="middle">
            无记录
          </text>
        ))}
    </>
  );
}

/** A bar from its top-left corner, `r` rounding only the top end (the baseline end stays square). */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return '';
  const rr = Math.min(r, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * Where a hover card goes: beside the column, on the side with more room (a column in the right half gets it on
 * its left), never past the chart's edge; as wide as its words, up to the chart's width.
 */
export function tipSide(x: number, width: number): { left: number } | { right: number } {
  return x > width / 2 ? { right: Math.max(0, width - x + 10) } : { left: Math.max(0, x + 10) };
}

function ChartTip({ hover, width, view, metric, bucket, provider }: { hover: Hover; width: number; view: UsageView; metric: Metric; bucket: UsageQuery['bucket']; provider: (id: string) => string }) {
  const c = hover.col;
  const rows = view.series.map((s) => ({ s, v: (metric === 'requests' ? c.requests[s.key] : c.tokens[s.key]) ?? 0 })).filter((r) => r.v > 0);
  return (
    <div className="usage-tip" style={tipSide(hover.x, width)} role="tooltip">
      <div className="usage-tip-title">{bucket === 'hour' ? `${dayLabel(c.start)} ${bucketLabel(c.start, bucket)}` : dayLabel(c.start)}</div>
      {c.noData ? (
        <div className="usage-tip-row">无记录</div>
      ) : rows.length ? (
        rows.map(({ s, v }) => (
          <div key={s.key} className="usage-tip-row">
            <span className="usage-swatch" style={{ background: s.color }} />
            <span className="usage-tip-name">{s.key.startsWith('\u0000') ? s.model : `${s.model}`}</span>
            <span className="usage-tip-provider">{s.providerId ? provider(s.providerId) : ''}</span>
            <span className="usage-num">{v.toLocaleString('en-US')}</span>
          </div>
        ))
      ) : (
        <div className="usage-tip-row">0</div>
      )}
      {c.rateLimited ? (
        <div className="usage-tip-row is-limited">
          <span className="usage-tip-name">429</span>
          <span className="usage-num">{c.rateLimited}</span>
        </div>
      ) : null}
    </div>
  );
}

function Legend({ series }: { series: UsageSeries[] }) {
  if (!series.length) return null;
  return (
    <ul className="usage-legend">
      {series.map((s) => (
        <li key={s.key}>
          <span className="usage-swatch" style={{ background: s.color }} />
          {s.model}
        </li>
      ))}
    </ul>
  );
}

function LimitChart({ view, bucket }: { view: UsageView; bucket: UsageQuery['bucket'] }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const height = 84;
  const plotW = Math.max(40, width - AXIS_W);
  const plotH = height - LABEL_H;
  const cols = view.columns;
  const max = Math.max(0, ...cols.map((c) => c.rateLimited));
  const ticks = niceTicks(max, 2);
  const top = ticks[ticks.length - 1]!;
  const slot = plotW / Math.max(1, cols.length);
  const barW = Math.max(2, Math.min(28, slot - 4));
  const every = labelEvery(cols.length, plotW);
  return (
    <div className="usage-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label="429 次数">
        {ticks.map((t) => {
          const y = plotH - (t / top) * (plotH - 6);
          return (
            <g key={t}>
              <line className="usage-grid" x1={AXIS_W} x2={width} y1={y} y2={y} />
              <text className="usage-axis" x={AXIS_W - 6} y={y} dy="0.32em" textAnchor="end">
                {t}
              </text>
            </g>
          );
        })}
        {cols.map((c, i) => {
          const h = (c.rateLimited / top) * (plotH - 6);
          return (
            <g key={c.start} onMouseEnter={() => setHover({ col: c, x: AXIS_W + i * slot + slot / 2 })}>
              {c.noData ? <rect className="usage-nodata" x={AXIS_W + i * slot} y={0} width={slot} height={plotH} /> : null}
              <rect x={AXIS_W + i * slot} y={0} width={slot} height={plotH} fill="transparent" />
              {h > 0 ? <path className="usage-limit-bar" d={barPath(AXIS_W + i * slot + (slot - barW) / 2, plotH - h, barW, h, Math.min(4, barW / 2))} /> : null}
              {i % every === 0 ? (
                <text className="usage-axis" x={AXIS_W + i * slot + slot / 2} y={height - 4} textAnchor="middle">
                  {bucketLabel(c.start, bucket)}
                </text>
              ) : null}
            </g>
          );
        })}
        <NoDataLabels cols={cols} slot={slot} plotH={plotH} />
        <line className="usage-baseline" x1={AXIS_W} x2={width} y1={plotH} y2={plotH} />
      </svg>
      {hover ? (
        <div className="usage-tip" style={tipSide(hover.x, width)} role="tooltip">
          <div className="usage-tip-title">{bucket === 'hour' ? `${dayLabel(hover.col.start)} ${bucketLabel(hover.col.start, bucket)}` : dayLabel(hover.col.start)}</div>
          <div className="usage-tip-row">{hover.col.noData ? '无记录' : `429：${hover.col.rateLimited}`}</div>
        </div>
      ) : null}
    </div>
  );
}

/** The 429 answers one by one, newest first: the first 8, then all on 全部. */
function LimitList({ records, total, provider }: { records: RequestRecord[]; total: number; provider: (id: string) => string }) {
  const [all, setAll] = useState(false);
  if (!records.length) return null;
  const shown = all ? records : records.slice(0, 8);
  return (
    <div className="group-pane usage-table-pane">
      <table className="usage-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>模型</th>
            <th>服务商</th>
            <th className="is-num">第几次</th>
            <th>重试</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id}>
              <td data-label="时间" className="usage-num">{timeLabel(r.startedAt)}</td>
              <td data-label="模型">{r.model ?? '—'}</td>
              <td data-label="服务商">{r.providerId ? provider(r.providerId) : '—'}</td>
              <td data-label="第几次" className="is-num usage-num">{r.attempt}</td>
              <td data-label="重试">{r.retried ? '已重试' : '未重试'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {records.length > 8 ? (
        <button type="button" className="btn btn-small usage-more" onClick={() => setAll((v) => !v)}>
          {all ? '收起' : `全部 ${Math.min(records.length, total)} 条`}
        </button>
      ) : null}
    </div>
  );
}

function ModelTable({ series, provider }: { series: UsageSeries[]; provider: (id: string) => string }) {
  if (!series.length) return <p className="group-pane settings-hint">无记录</p>;
  const sorted = [...series].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  return (
    <div className="group-pane usage-table-pane">
      <table className="usage-table">
        <thead>
          <tr>
            <th>模型</th>
            <th>服务商</th>
            <th className="is-num">请求</th>
            <th className="is-num">429</th>
            <th className="is-num">失败</th>
            <th className="is-num">输入</th>
            <th className="is-num">输出</th>
            <th className="is-num">缓存读</th>
            <th className="is-num">缓存写</th>
            <th className="is-num">花费</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.key}>
              <td data-label="模型">
                <span className="usage-swatch" style={{ background: s.color }} />
                {s.model}
              </td>
              <td data-label="服务商">{s.providerId ? provider(s.providerId) : '—'}</td>
              <td data-label="请求" className="is-num usage-num">{s.requests.toLocaleString('en-US')}</td>
              <td data-label="429" className={s.rateLimited ? 'is-num usage-num is-limited' : 'is-num usage-num'}>{s.rateLimited}</td>
              <td data-label="失败" className="is-num usage-num">{s.failed}</td>
              <td data-label="输入" className="is-num usage-num">{shortCount(s.inputTokens)}</td>
              <td data-label="输出" className="is-num usage-num">{shortCount(s.outputTokens)}</td>
              <td data-label="缓存读" className="is-num usage-num">{s.cacheReadTokens ? shortCount(s.cacheReadTokens) : '—'}</td>
              <td data-label="缓存写" className="is-num usage-num">{s.cacheWriteTokens ? shortCount(s.cacheWriteTokens) : '—'}</td>
              <td data-label="花费" className="is-num usage-num" title={s.unpriced ? `未计价请求 ${s.unpricedRequests}：没有价格的模型，不计入花费` : undefined}>
                {s.unpriced && !s.costUsd ? '未计价' : usd(s.costUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
