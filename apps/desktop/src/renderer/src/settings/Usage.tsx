// 设置 › 用量: requests and token use over a time range, for all models or one, from the core's request log
// (one record per HTTP request, see packages/core/src/usage.ts). Requests and 429 answers share one chart
// (two lines over their areas); tokens are bars by kind; the 429 answers are listed one by one; a table by
// model; the range's numbers export as CSV. Days before the log starts are marked, not drawn as zero.
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RequestRecord, UsageSummary, UsageQuery } from '@spica/protocol';
import type { SaveCsvResult } from '../../../shared/bridge';
import { Group, matches, SearchHit, SettingsSearchContext } from './Group';
import { bucketLabel, dayLabel, modelChoices, niceTicks, onlyModel, queryFor, RANGES, shortCount, timeLabel, TOKEN_KINDS, usageCsvName, usageCsvRows, usageView, usd, type UsageColumn, type UsageRange, type UsageSeries, type UsageView } from './usage-data';
import { toCsv } from '../chat/table-data';
import { SERIES_COUNT } from '../../../shared/skin';
import { Select } from '../ui/Select';

export interface UsageApi {
  summary(query: UsageQuery): Promise<UsageSummary | null>;
  /** Saved connections' names by id (a demo or removed connection shows its id). */
  providerNames?(): Promise<Record<string, string>>;
  /** Save a CSV file (the save dialog; null when cancelled). */
  saveCsv?(name: string, text: string): Promise<SaveCsvResult>;
  /** Shows a saved file in Explorer. */
  showInFolder?(path: string): void;
}

export interface UsageProps {
  api: UsageApi;
  /** Clock, for tests and screenshots. */
  now?: () => Date;
}

/** The picker's value for 全部模型 (a model's key always holds its provider and a NUL between them). */
const ALL = '';

/** The color of the requests line (the 429 line is the danger color). */
const REQUESTS_COLOR = 'var(--spica-series-1)';

export function Usage({ api, now = () => new Date() }: UsageProps) {
  const search = useContext(SettingsSearchContext);
  const [range, setRange] = useState<UsageRange>('7d');
  // one model (its key: provider and name), or null for all
  const [model, setModel] = useState<string | null>(null);
  const [summary, setSummary] = useState<UsageSummary | null | undefined>(undefined);
  const [names, setNames] = useState<Record<string, string>>({});
  const [exported, setExported] = useState<SaveCsvResult | undefined>(undefined);
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
  if (searching) return search && (search.sectionHit || matches(search.query, '用量', 'Token', '429', '请求数', '花费', 'CSV')) ? <SearchHit title="用量" onGo={() => search.jump('')} /> : null;
  // the main process's names first (the connections', and the demo's for its made-up records)
  const provider = (id: string) => summary?.providerNames?.[id] ?? names[id] ?? id;
  const choices = summary ? modelChoices(summary) : [];
  // a model picked in another range stays picked (and listed) when this range has none of it
  const picked = model ? (choices.find((c) => c.key === model) ?? { key: model, providerId: model.split('\u0000')[0] ?? '', model: model.split('\u0000')[1] ?? '' }) : null;
  if (picked && !choices.some((c) => c.key === picked.key)) choices.push(picked);
  const modelLabel = (c: { providerId: string; model: string }) => (c.providerId ? `${c.model} · ${provider(c.providerId)}` : c.model);
  const shown = summary ? onlyModel(summary, model) : null;
  const view = shown ? usageView(shown, SERIES_COUNT) : null;
  const bucket = summary?.query.bucket ?? 'day';

  const exportCsv = async () => {
    if (!shown || !api.saveCsv) return;
    const r = await api.saveCsv(usageCsvName(shown, picked?.model ?? null), toCsv(usageCsvRows(shown, provider))).catch(() => ({ error: '无法导出 CSV。' }));
    setExported(r ?? undefined);
  };

  return (
    <>
      <div className="usage-bar">
        <div className="usage-bar-picks">
          <div className="segmented" role="radiogroup" aria-label="时间">
            {RANGES.map(([r, label]) => (
              <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? 'segment is-on' : 'segment'} onClick={() => setRange(r)}>
                {label}
              </button>
            ))}
          </div>
          <Select
            className="usage-model"
            label="模型"
            value={model ?? ALL}
            options={[{ value: ALL, label: '全部模型' }, ...choices.map((c) => ({ value: c.key, label: modelLabel(c) }))]}
            onChange={(v) => setModel(v === ALL ? null : v)}
          />
        </div>
        <div className="usage-bar-end">
          <span className="usage-since">
            {view?.since ? `${dayLabel(view.since)} 起有记录 · ` : ''}
            {tzLabel(now())}
          </span>
          {api.saveCsv ? (
            <button type="button" className="btn btn-small" disabled={!shown?.rows.length} onClick={() => void exportCsv()}>
              导出 CSV
            </button>
          ) : null}
        </div>
      </div>
      {exported && 'error' in exported ? <p className="settings-hint usage-note is-bad">{exported.error}</p> : null}
      {exported && 'file' in exported ? (
        <p className="settings-hint usage-note">
          已导出：
          {api.showInFolder ? (
            <button type="button" className="path-text path-link" title={`在文件夹中显示：${exported.file}`} onClick={() => api.showInFolder!(exported.file)}>
              {exported.file}
            </button>
          ) : (
            exported.file
          )}
        </p>
      ) : null}
      {summary === null ? <p className="settings-hint usage-empty">无法读取用量</p> : null}
      {view ? (
        <>
          <Tiles view={view} />
          <Group title="请求">
            <div className="group-pane usage-chart-pane">
              <RequestChart view={view} bucket={bucket} provider={provider} byModel={!model} />
              <ul className="usage-legend">
                <li>
                  <span className="usage-swatch" style={{ background: REQUESTS_COLOR }} />
                  请求
                </li>
                <li>
                  <span className="usage-swatch is-limited" />
                  429
                </li>
              </ul>
            </div>
          </Group>
          <Group title="Token">
            <div className="group-pane usage-chart-pane">
              <TokenChart view={view} bucket={bucket} provider={provider} byModel={!model} />
              <ul className="usage-legend">
                {TOKEN_KINDS.filter((k) => view.totals.kinds[k.kind] > 0).map((k) => (
                  <li key={k.kind}>
                    <span className="usage-swatch" style={{ background: k.color }} />
                    {k.label}
                  </li>
                ))}
              </ul>
            </div>
          </Group>
          <Group title="429">
            <LimitList records={shown!.rateLimited} total={view.totals.rateLimited} provider={provider} />
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

/** The totals: a name and a number each. Requests without a price say so on the cost's hover. */
function Tiles({ view }: { view: UsageView }) {
  const t = view.totals;
  const tiles: [string, string, string?][] = [
    ['请求', shortCount(t.requests)],
    ['Token', shortCount(t.tokens)],
    ['429', shortCount(t.rateLimited)],
    ['失败', shortCount(t.failed)],
    ['花费', usd(t.costUsd), t.unpricedRequests ? `未计价请求 ${t.unpricedRequests.toLocaleString('en-US')}：没有价格的模型，不计入花费` : undefined],
  ];
  return (
    <div className="usage-tiles">
      {tiles.map(([label, value, tip]) => (
        <div key={label} className={label === '429' && t.rateLimited > 0 ? 'usage-tile is-limited' : 'usage-tile'} title={tip}>
          <span className="usage-tile-label">{label}</span>
          <span className="usage-tile-value">{value}</span>
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
const CHART_H = 180;

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

/** What both charts share: the frame (grid, axis numbers, dates, no-data marks, a hit target per column). */
function ChartFrame({ cols, width, max, bucket, label, onHover, children }: { cols: UsageColumn[]; width: number; max: number; bucket: UsageQuery['bucket']; label: string; onHover(h: Hover): void; children(scale: { slot: number; plotH: number; y(v: number): number }): React.ReactNode }) {
  const plotW = Math.max(40, width - AXIS_W);
  const plotH = CHART_H - LABEL_H;
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]!;
  const slot = plotW / Math.max(1, cols.length);
  const every = labelEvery(cols.length, plotW);
  const y = (v: number) => plotH - (v / top) * (plotH - 6);
  return (
    <svg width={width} height={CHART_H} role="img" aria-label={label}>
      {ticks.map((t) => (
        <g key={t}>
          <line className="usage-grid" x1={AXIS_W} x2={width} y1={y(t)} y2={y(t)} />
          <text className="usage-axis" x={AXIS_W - 6} y={y(t)} dy="0.32em" textAnchor="end">
            {shortCount(t)}
          </text>
        </g>
      ))}
      {cols.map((c, i) => (c.noData ? <rect key={c.start} className="usage-nodata" x={AXIS_W + i * slot} y={0} width={slot} height={plotH} /> : null))}
      {children({ slot, plotH, y })}
      <NoDataLabels cols={cols} slot={slot} plotH={plotH} />
      <line className="usage-baseline" x1={AXIS_W} x2={width} y1={plotH} y2={plotH} />
      {cols.map((c, i) => (
        <g key={c.start}>
          {i % every === 0 ? (
            <text className="usage-axis" x={AXIS_W + i * slot + slot / 2} y={CHART_H - 4} textAnchor="middle">
              {bucketLabel(c.start, bucket)}
            </text>
          ) : null}
          {/* the hit target is the whole column, on top of the marks */}
          <rect x={AXIS_W + i * slot} y={0} width={slot} height={plotH} fill="transparent" onMouseEnter={() => onHover({ col: c, x: AXIS_W + i * slot + slot / 2 })} />
        </g>
      ))}
    </svg>
  );
}

/** Lines through the columns' centers, broken where there is no data; each with its area down to the baseline. */
function runsOf(cols: UsageColumn[]): number[][] {
  const runs: number[][] = [];
  cols.forEach((c, i) => {
    if (c.noData) return;
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else runs.push([i]);
  });
  return runs;
}

/** Requests and 429 answers per bucket: two lines on one scale, each over its own faint area. */
function RequestChart({ view, bucket, provider, byModel }: { view: UsageView; bucket: UsageQuery['bucket']; provider: (id: string) => string; byModel: boolean }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const cols = view.columns;
  const max = Math.max(0, ...cols.map((c) => c.requestCount));
  const runs = runsOf(cols);
  return (
    <div className="usage-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <ChartFrame cols={cols} width={width} max={max} bucket={bucket} label="请求数" onHover={setHover}>
        {({ slot, plotH, y }) => {
          const x = (i: number) => AXIS_W + i * slot + slot / 2;
          const line = (run: number[], v: (c: UsageColumn) => number) => run.map((i, j) => `${j ? 'L' : 'M'}${x(i)},${y(v(cols[i]!))}`).join('');
          const area = (run: number[], v: (c: UsageColumn) => number) => `${line(run, v)}L${x(run[run.length - 1]!)},${plotH}L${x(run[0]!)},${plotH}Z`;
          const series = [
            { cls: 'is-requests', v: (c: UsageColumn) => c.requestCount },
            { cls: 'is-limited', v: (c: UsageColumn) => c.rateLimited },
          ];
          const hi = hover ? cols.indexOf(hover.col) : -1;
          return (
            <>
              {series.map((s) =>
                runs.map((run) => (
                  <g key={`${s.cls}${run[0]}`} className={`usage-line ${s.cls}`}>
                    <path className="usage-line-area" d={area(run, s.v)} />
                    {run.length > 1 ? <path className="usage-line-stroke" d={line(run, s.v)} /> : <circle className="usage-line-dot" cx={x(run[0]!)} cy={y(s.v(cols[run[0]!]!))} r={2.5} />}
                  </g>
                )),
              )}
              {hi >= 0 && !cols[hi]!.noData ? (
                <g className="usage-hover-mark">
                  <line className="usage-hover-line" x1={x(hi)} x2={x(hi)} y1={0} y2={plotH} />
                  {series.map((s) => (
                    <circle key={s.cls} className={`usage-line-dot ${s.cls}`} cx={x(hi)} cy={y(s.v(cols[hi]!))} r={4} />
                  ))}
                </g>
              ) : null}
            </>
          );
        }}
      </ChartFrame>
      {hover ? (
        <div className="usage-tip" style={tipSide(hover.x, width)} role="tooltip">
          <div className="usage-tip-title">{tipTitle(hover.col, bucket)}</div>
          {hover.col.noData ? (
            <div className="usage-tip-row">无记录</div>
          ) : (
            <>
              <div className="usage-tip-row">
                <span className="usage-swatch" style={{ background: REQUESTS_COLOR }} />
                <span className="usage-tip-name">请求</span>
                <span className="usage-num">{hover.col.requestCount.toLocaleString('en-US')}</span>
              </div>
              <div className="usage-tip-row is-limited">
                <span className="usage-swatch is-limited" />
                <span className="usage-tip-name">429</span>
                <span className="usage-num">{hover.col.rateLimited.toLocaleString('en-US')}</span>
              </div>
              {byModel ? <ModelRows view={view} col={hover.col} provider={provider} value={(c, k) => c.requests[k] ?? 0} limited /> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Tokens per bucket: one bar stacked by kind (cache hits, cache writes, misses, input without cache numbers, output). */
function TokenChart({ view, bucket, provider, byModel }: { view: UsageView; bucket: UsageQuery['bucket']; provider: (id: string) => string; byModel: boolean }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const cols = view.columns;
  const total = (c: UsageColumn) => TOKEN_KINDS.reduce((a, k) => a + c.kinds[k.kind], 0);
  const max = Math.max(0, ...cols.map(total));
  return (
    <div className="usage-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <ChartFrame cols={cols} width={width} max={max} bucket={bucket} label="Token 用量" onHover={setHover}>
        {({ slot, plotH, y }) => {
          const barW = Math.max(2, Math.min(28, slot - 4));
          return cols.map((c, i) => {
            const x = AXIS_W + i * slot + (slot - barW) / 2;
            let top = plotH;
            const segs = TOKEN_KINDS.map((k) => ({ k, v: c.kinds[k.kind] })).filter((p) => p.v > 0);
            return (
              <g key={c.start} className={hover?.col === c ? 'usage-bar-col is-hover' : 'usage-bar-col'}>
                {segs.map(({ k, v }, j) => {
                  const h = plotH - y(v);
                  top -= h;
                  const last = j === segs.length - 1;
                  // a 2px gap between segments; the top segment's end is rounded
                  return <path key={k.kind} d={barPath(x, top, barW, Math.max(0, h - (j > 0 ? 2 : 0)), last ? Math.min(4, barW / 2) : 0)} style={{ fill: k.color }} />;
                })}
              </g>
            );
          });
        }}
      </ChartFrame>
      {hover ? (
        <div className="usage-tip" style={tipSide(hover.x, width)} role="tooltip">
          <div className="usage-tip-title">
            <span className="usage-tip-name">{tipTitle(hover.col, bucket)}</span>
            {hover.col.noData ? null : <span className="usage-num">{total(hover.col).toLocaleString('en-US')}</span>}
          </div>
          {hover.col.noData ? (
            <div className="usage-tip-row">无记录</div>
          ) : (
            <>
              {TOKEN_KINDS.filter((k) => hover.col.kinds[k.kind] > 0).map((k) => (
                <div key={k.kind} className="usage-tip-row">
                  <span className="usage-swatch" style={{ background: k.color }} />
                  <span className="usage-tip-name">{k.label}</span>
                  <span className="usage-num">{hover.col.kinds[k.kind].toLocaleString('en-US')}</span>
                </div>
              ))}
              {byModel ? <ModelRows view={view} col={hover.col} provider={provider} value={(c, k) => c.tokens[k] ?? 0} /> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function tipTitle(c: UsageColumn, bucket: UsageQuery['bucket']): string {
  return bucket === 'hour' ? `${dayLabel(c.start)} ${bucketLabel(c.start, bucket)}` : dayLabel(c.start);
}

/**
 * The hover card's lines per model under 按模型 (only when there is more than one): the value, its 429 answers in red
 * after it. No color mark: the charts' colors are requests / 429 and the kinds of token, not models.
 */
function ModelRows({ view, col, provider, value, limited }: { view: UsageView; col: UsageColumn; provider: (id: string) => string; value(c: UsageColumn, key: string): number; limited?: boolean }) {
  const rows = view.series.map((s) => ({ s, v: value(col, s.key), l: col.limited[s.key] ?? 0 })).filter((r) => r.v > 0);
  if (rows.length < 2) return null;
  return (
    <>
      <div className="usage-tip-head">按模型</div>
      {rows.map(({ s, v, l }) => (
        <div key={s.key} className="usage-tip-row">
          <span className="usage-tip-name">{s.model}</span>
          <span className="usage-tip-provider">{s.providerId ? provider(s.providerId) : ''}</span>
          <span className="usage-num">
            {v.toLocaleString('en-US')}
            {limited && l ? (
              <>
                (<span className="usage-limited-num">{l.toLocaleString('en-US')}</span>)
              </>
            ) : null}
          </span>
        </div>
      ))}
    </>
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

/** The 429 answers one by one, newest first: the first 8, then all on 全部. */
function LimitList({ records, total, provider }: { records: RequestRecord[]; total: number; provider: (id: string) => string }) {
  const [all, setAll] = useState(false);
  if (!records.length) return <p className="group-pane settings-hint">无记录</p>;
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
              <td data-label="模型">{s.model}</td>
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

