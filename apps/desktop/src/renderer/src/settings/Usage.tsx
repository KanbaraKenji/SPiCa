// 设置 › 用量: requests and token use over a time range, for all models or one, from the core's request log
// (one record per HTTP request, see packages/core/src/usage.ts). Requests and 429 answers share one chart
// (two lines over their areas); tokens are bars by kind; the 429 answers are listed one by one; a table by
// model; the range's numbers export as CSV. Days before the log starts are marked, not drawn as zero.
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RequestRecord, UsageSummary, UsageQuery } from '@spica/protocol';
import type { SaveCsvResult } from '../../../shared/bridge';
import { Group, matches, SearchHit, SettingsSearchContext } from './Group';
import { bucketLabel, dayLabel, modelChoices, moduleLabel, moduleOrder, niceTicks, onlyModel, queryFor, RANGES, shortCount, timeLabel, TOKEN_KINDS, usageCsvName, usageCsvRows, usageView, usd, type UsageColumn, type UsageRange, type UsageSeries, type UsageView } from './usage-data';
import { toCsv } from '../chat/table-data';
import { SERIES_COUNT } from '../../../shared/skin';
import { Select } from '../ui/Select';
import { intlLocale, N_, t, tc, tx } from '../../../shared/i18n';
import { tn } from '../i18n';

export interface UsageApi {
  summary(query: UsageQuery): Promise<UsageSummary | null>;
  /** Saved connections' names by id (a demo or removed connection shows its id). */
  providerNames?(): Promise<Record<string, string>>;
  /** Installed plugins' names as their page shows them, by id (for the modules on the hover card). */
  pluginNames?(): Promise<Record<string, string>>;
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
  // the chart: tokens by kind, or requests and 429 answers (the tabs at its group's right end; Token first)
  const [metric, setMetric] = useState<'tokens' | 'requests'>('tokens');
  const [summary, setSummary] = useState<UsageSummary | null | undefined>(undefined);
  const [names, setNames] = useState<Record<string, string>>({});
  const [plugins, setPlugins] = useState<Record<string, string>>({});
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
  useEffect(() => {
    if (searching || !api.pluginNames) return;
    void api.pluginNames().then(setPlugins, () => undefined);
  }, [api, searching]);

  // 搜索设置: the section has no rows; its name and what it shows find it
  if (searching) return search && (search.sectionHit || matches(search.query, t('用量'), 'Token', '429', t('请求数'), t('花费'), 'CSV')) ? <SearchHit title={t('用量')} onGo={() => search.jump('')} /> : null;
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
    const r = await api.saveCsv(usageCsvName(shown, picked?.model ?? null), toCsv(usageCsvRows(shown, provider))).catch(() => ({ error: N_('无法导出 CSV。') }));
    setExported(r ?? undefined);
  };

  return (
    <>
      <div className="usage-bar">
        <div className="usage-bar-picks">
          <div className="segmented" role="radiogroup" aria-label={t('时间')}>
            {RANGES.map(([r, label]) => (
              <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? 'segment is-on' : 'segment'} onClick={() => setRange(r)}>
                {t(label)}
              </button>
            ))}
          </div>
          <Select
            className="usage-model"
            label={tc('single', '模型')}
            value={model ?? ALL}
            options={[{ value: ALL, label: t('全部模型') }, ...choices.map((c) => ({ value: c.key, label: modelLabel(c) }))]}
            onChange={(v) => setModel(v === ALL ? null : v)}
          />
        </div>
        <div className="usage-bar-end">
          <span className="usage-since">
            {view?.since ? t('{day} 起有记录', { day: dayLabel(view.since) }) + ' · ' : ''}
            {tzLabel(now())}
          </span>
          {api.saveCsv ? (
            <button type="button" className="btn btn-small" disabled={!shown?.rows.length} onClick={() => void exportCsv()}>
              {t('导出 CSV')}
            </button>
          ) : null}
        </div>
      </div>
      {exported && 'error' in exported ? <p className="settings-hint usage-note is-bad">{tx(exported.error)}</p> : null}
      {exported && 'file' in exported ? (
        <p className="settings-hint usage-note">
          {tn('已导出：{file}', {
            file: api.showInFolder ? (
              <button type="button" className="path-text path-link" title={t('在文件夹中显示：{file}', { file: exported.file })} onClick={() => api.showInFolder!(exported.file)}>
                {exported.file}
              </button>
            ) : (
              exported.file
            ),
          })}
        </p>
      ) : null}
      {summary === null ? <p className="settings-hint usage-empty">{t('无法读取用量')}</p> : null}
      {view ? (
        <>
          <Tiles view={view} />
          <Group
            title={metric === 'tokens' ? 'Token' : t('请求')}
            actions={
              <div className="segmented" role="radiogroup" aria-label={tc('chart', '显示')}>
                {(
                  [
                    ['tokens', 'Token'],
                    ['requests', N_('请求')],
                  ] as const
                ).map(([m, label]) => (
                  <button key={m} type="button" role="radio" aria-checked={metric === m} className={metric === m ? 'segment is-on' : 'segment'} onClick={() => setMetric(m)}>
                    {t(label)}
                  </button>
                ))}
              </div>
            }
          >
            <div className="group-pane usage-chart-pane">
              {metric === 'tokens' ? (
                <>
                  <TokenChart view={view} bucket={bucket} provider={provider} byModel={!model} pluginName={(id) => plugins[id]} />
                  <ul className="usage-legend">
                    {TOKEN_KINDS.filter((k) => view.totals.kinds[k.kind] > 0).map((k) => (
                      <li key={k.kind}>
                        <span className="usage-swatch" style={{ background: k.color }} />
                        {t(k.label)}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <RequestChart view={view} bucket={bucket} provider={provider} byModel={!model} pluginName={(id) => plugins[id]} />
                  <ul className="usage-legend">
                    <li>
                      <span className="usage-swatch" style={{ background: REQUESTS_COLOR }} />
                      {t('请求')}
                    </li>
                    <li>
                      <span className="usage-swatch is-limited" />
                      429
                    </li>
                  </ul>
                </>
              )}
            </div>
          </Group>
          <Group title="429">
            <LimitList records={shown!.rateLimited} total={view.totals.rateLimited} provider={provider} />
          </Group>
          <Group title={tc('single', '模型')}>
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
  const totals = view.totals;
  const tiles: [string, string, string?][] = [
    [N_('请求'), shortCount(totals.requests)],
    ['Token', shortCount(totals.tokens)],
    ['429', shortCount(totals.rateLimited)],
    [N_('失败'), shortCount(totals.failed)],
    [N_('花费'), usd(totals.costUsd), totals.unpricedRequests ? t('未计价请求 {count}：没有价格的模型，不计入花费', { count: totals.unpricedRequests.toLocaleString(intlLocale()) }) : undefined],
  ];
  return (
    <div className="usage-tiles">
      {tiles.map(([label, value, tip]) => (
        <div key={label} className={label === '429' && totals.rateLimited > 0 ? 'usage-tile is-limited' : 'usage-tile'} title={tip}>
          <span className="usage-tile-label">{t(label)}</span>
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
// taller than it was (his old design's chart is about a third taller)
const CHART_H = 240;

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

/**
 * A smooth line through points (monotone cubic, Fritsch–Carlson): it never swings past its neighbours, so a count is
 * never drawn under 0 or over the peak between two columns. One point: a move only.
 */
export function smoothPath(pts: readonly [number, number][]): string {
  const n = pts.length;
  if (!n) return '';
  if (n === 1) return `M${pts[0]![0]},${pts[0]![1]}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0]);
    m.push((pts[i + 1]![1] - pts[i]![1]) / dx[i]!);
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2);
  t.push(m[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const h = a * a + b * b;
    if (h > 9) {
      const k = 3 / Math.sqrt(h);
      t[i] = k * a * m[i]!;
      t[i + 1] = k * b * m[i]!;
    }
  }
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += `C${x0 + h},${y0 + t[i]! * h} ${x1 - h},${y1 - t[i + 1]! * h} ${x1},${y1}`;
  }
  return d;
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

interface ChartProps {
  view: UsageView;
  bucket: UsageQuery['bucket'];
  provider: (id: string) => string;
  /** 全部模型: the hover card by model; one model picked: by function module. */
  byModel: boolean;
  pluginName: (id: string) => string | undefined;
}

/** Requests and 429 answers per bucket: two smooth lines on one scale, each over its own faint area. */
function RequestChart({ view, bucket, provider, byModel, pluginName }: ChartProps) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const cols = view.columns;
  const max = Math.max(0, ...cols.map((c) => c.requestCount));
  const runs = runsOf(cols);
  return (
    <div className="usage-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <ChartFrame cols={cols} width={width} max={max} bucket={bucket} label={t('请求数')} onHover={setHover}>
        {({ slot, plotH, y }) => {
          const x = (i: number) => AXIS_W + i * slot + slot / 2;
          // a smooth curve through the columns (his reference: curves, not straight segments)
          const line = (run: number[], v: (c: UsageColumn) => number) => smoothPath(run.map((i) => [x(i), y(v(cols[i]!))] as [number, number]));
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
          <div className="usage-tip-title">
            <span>{tipTitle(hover.col, bucket)}</span>
            {hover.col.noData ? null : <span className="usage-num">{hover.col.requestCount.toLocaleString(intlLocale())}</span>}
          </div>
          {hover.col.noData ? (
            <div className="usage-tip-empty">{t('无记录')}</div>
          ) : (
            <div className="usage-tip-grid">
              <TipRow mark={REQUESTS_COLOR} name={t('请求')} value={hover.col.requestCount} />
              <TipRow mark="danger" name="429" value={hover.col.rateLimited} limitedRow />
              {byModel ? <ModelRows view={view} col={hover.col} provider={provider} value={(c, k) => c.requests[k] ?? 0} limited /> : <ModuleRows col={hover.col} value={(m) => m.requests} pluginName={pluginName} limited />}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Tokens per bucket: one bar stacked by kind (cache hits, cache writes, misses, input without cache numbers, output). */
function TokenChart({ view, bucket, provider, byModel, pluginName }: ChartProps) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const cols = view.columns;
  const total = (c: UsageColumn) => TOKEN_KINDS.reduce((a, k) => a + c.kinds[k.kind], 0);
  const max = Math.max(0, ...cols.map(total));
  return (
    <div className="usage-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <ChartFrame cols={cols} width={width} max={max} bucket={bucket} label={t('Token 用量')} onHover={setHover}>
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
            <span>{tipTitle(hover.col, bucket)}</span>
            {hover.col.noData ? null : <span className="usage-num">{total(hover.col).toLocaleString(intlLocale())}</span>}
          </div>
          {hover.col.noData ? (
            <div className="usage-tip-empty">{t('无记录')}</div>
          ) : (
            <div className="usage-tip-grid">
              {TOKEN_KINDS.filter((k) => hover.col.kinds[k.kind] > 0).map((k) => (
                <TipRow key={k.kind} mark={k.color} name={t(k.label)} value={hover.col.kinds[k.kind]} />
              ))}
              {byModel ? <ModelRows view={view} col={hover.col} provider={provider} value={(c, k) => c.tokens[k] ?? 0} /> : <ModuleRows col={hover.col} value={(m) => m.tokens} pluginName={pluginName} />}
            </div>
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
  // no provider column: a model name two providers have says its provider after it
  const twice = new Set(rows.map((r) => r.s.model).filter((m, i, all) => all.indexOf(m) !== i));
  return (
    <>
      <div className="usage-tip-head">{t('按模型')}</div>
      {rows.map(({ s, v, l }) => (
        <TipRow key={s.key} name={s.model} {...(twice.has(s.model) && s.providerId ? { provider: provider(s.providerId) } : {})} value={v} {...(limited && l ? { limited: l } : {})} />
      ))}
    </>
  );
}

/**
 * One model picked: the hover card's lines per function module under 按功能模块 (对话, 记忆整理, 插件 …), the value
 * and its 429 answers in red after it; the names at the card's left edge as the models' are.
 */
function ModuleRows({ col, value, pluginName, limited }: { col: UsageColumn; value(m: UsageColumn['modules'][string]): number; pluginName: (id: string) => string | undefined; limited?: boolean }) {
  const rows = Object.entries(col.modules)
    .map(([key, m]) => ({ key, v: value(m), l: m.rateLimited }))
    .filter((r) => r.v > 0)
    .sort((a, b) => moduleOrder(a.key) - moduleOrder(b.key) || a.key.localeCompare(b.key));
  if (!rows.length) return null;
  return (
    <>
      <div className="usage-tip-head">{t('按功能模块')}</div>
      {rows.map(({ key, v, l }) => (
        <TipRow key={key} name={moduleLabel(key, pluginName)} value={v} {...(limited && l ? { limited: l } : {})} />
      ))}
    </>
  );
}

/**
 * One line of a hover card, as his old design: a round mark and the name on the left, the number bold and flush right;
 * a model's 429 answers in red just before its number ((22)), so every number ends at the card's right edge. The
 * chart's series have their colour; the models and modules a quiet mark, so every name starts in one place.
 */
function TipRow({ mark, name, provider, value, limited, limitedRow }: { mark?: string; name: string; provider?: string; value: number; limited?: number; limitedRow?: boolean }) {
  return (
    <div className={limitedRow ? 'usage-tip-row is-limited' : 'usage-tip-row'}>
      <span className="usage-tip-mark">
        <span className={mark === 'danger' ? 'usage-swatch is-limited' : mark ? 'usage-swatch' : 'usage-swatch is-plain'} style={mark && mark !== 'danger' ? { background: mark } : undefined} />
      </span>
      <span className="usage-tip-name">
        {name}
        {provider ? <span className="usage-tip-provider"> · {provider}</span> : null}
      </span>
      <span className="usage-num">
        {value.toLocaleString(intlLocale())}
        {limited ? (
          <>
            (<span className="usage-limited-num">{limited.toLocaleString(intlLocale())}</span>)
          </>
        ) : null}
      </span>
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
            {t('无记录')}
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
  if (!records.length) return <p className="group-pane settings-hint">{t('无记录')}</p>;
  const shown = all ? records : records.slice(0, 8);
  return (
    <div className="group-pane usage-table-pane">
      <table className="usage-table">
        <thead>
          <tr>
            <th>{t('时间')}</th>
            <th>{tc('single', '模型')}</th>
            <th>{t('服务商')}</th>
            <th className="is-num">{t('第几次')}</th>
            <th>{t('重试')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id}>
              <td data-label={t('时间')} className="usage-num">{timeLabel(r.startedAt)}</td>
              <td data-label={tc('single', '模型')}>{r.model ?? '—'}</td>
              <td data-label={t('服务商')}>{r.providerId ? provider(r.providerId) : '—'}</td>
              <td data-label={t('第几次')} className="is-num usage-num">{r.attempt}</td>
              <td data-label={t('重试')}>{r.retried ? t('已重试') : t('未重试')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {records.length > 8 ? (
        <button type="button" className="btn btn-small usage-more" onClick={() => setAll((v) => !v)}>
          {all ? tc('more', '收起') : t('全部 {n} 条', { n: Math.min(records.length, total) })}
        </button>
      ) : null}
    </div>
  );
}

function ModelTable({ series, provider }: { series: UsageSeries[]; provider: (id: string) => string }) {
  if (!series.length) return <p className="group-pane settings-hint">{t('无记录')}</p>;
  const sorted = [...series].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  return (
    <div className="group-pane usage-table-pane">
      <table className="usage-table">
        <thead>
          <tr>
            <th>{tc('single', '模型')}</th>
            <th>{t('服务商')}</th>
            <th className="is-num">{t('请求')}</th>
            <th className="is-num">429</th>
            <th className="is-num">{t('失败')}</th>
            <th className="is-num">{t('输入')}</th>
            <th className="is-num">{t('输出')}</th>
            <th className="is-num">{t('缓存读')}</th>
            <th className="is-num">{t('缓存写')}</th>
            <th className="is-num">{t('花费')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.key}>
              <td data-label={tc('single', '模型')}>{s.model}</td>
              <td data-label={t('服务商')}>{s.providerId ? provider(s.providerId) : '—'}</td>
              <td data-label={t('请求')} className="is-num usage-num">{s.requests.toLocaleString(intlLocale())}</td>
              <td data-label="429" className={s.rateLimited ? 'is-num usage-num is-limited' : 'is-num usage-num'}>{s.rateLimited}</td>
              <td data-label={t('失败')} className="is-num usage-num">{s.failed}</td>
              <td data-label={t('输入')} className="is-num usage-num">{shortCount(s.inputTokens)}</td>
              <td data-label={t('输出')} className="is-num usage-num">{shortCount(s.outputTokens)}</td>
              <td data-label={t('缓存读')} className="is-num usage-num">{s.cacheReadTokens ? shortCount(s.cacheReadTokens) : '—'}</td>
              <td data-label={t('缓存写')} className="is-num usage-num">{s.cacheWriteTokens ? shortCount(s.cacheWriteTokens) : '—'}</td>
              <td data-label={t('花费')} className="is-num usage-num" title={s.unpriced ? t('未计价请求 {count}：没有价格的模型，不计入花费', { count: s.unpricedRequests }) : undefined}>
                {s.unpriced && !s.costUsd ? t('未计价') : usd(s.costUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

