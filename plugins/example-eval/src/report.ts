// The Markdown report: one row per check (pass / fail / skipped, time, cost),
// totals first, notes below.

export interface CheckResult {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'skipped';
  note: string;
  /** Wall time of the journey the check belongs to (shared by its checks). */
  durationMs: number;
  /** Model and tool spending of that journey, from Spica's traceable records. */
  costUsd: number;
  /** Model / tool requests of that journey. */
  requests: number;
}

export interface ReportInfo {
  startedAt: string;
  /** e.g. "stdio (new database)" or "http". */
  mode: string;
  /** Provider id and model; never the endpoint address. */
  model: string;
  results: CheckResult[];
  /** Journeys that share one run are listed once in the totals. */
  journeyTotals: { durationMs: number; costUsd: number; requests: number };
}

const MARK = { pass: '✅ 通过', fail: '❌ 失败', skipped: '⏭ 跳过' } as const;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
const usd = (v: number) => `$${v.toFixed(4)}`;
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function renderReport(info: ReportInfo): string {
  const passed = info.results.filter((r) => r.status === 'pass').length;
  const failed = info.results.filter((r) => r.status === 'fail').length;
  const skipped = info.results.filter((r) => r.status === 'skipped').length;
  const verdict = failed > 0 ? `**${failed} 项失败**` : passed > 0 ? '**全部通过**' : '**没有跑任何一项**';
  const lines = [
    '# Spica 评测报告',
    '',
    `${verdict}：通过 ${passed}，失败 ${failed}，跳过 ${skipped}；共 ${secs(info.journeyTotals.durationMs)}，花费约 ${usd(info.journeyTotals.costUsd)}（${info.journeyTotals.requests} 次请求）。`,
    '',
    `- 开始：${info.startedAt}`,
    `- 方式：${info.mode}，只经 Spica 的 MCP 服务`,
    `- 模型：${info.model}`,
    '',
    '| 项 | 内容 | 结果 | 耗时 | 花费 |',
    '|---|---|---|---|---|',
    ...info.results.map((r) =>
      r.status === 'skipped'
        ? `| ${r.id} | ${cell(r.title)} | ${MARK[r.status]} | — | — |`
        : `| ${r.id} | ${cell(r.title)} | ${MARK[r.status]} | ${secs(r.durationMs)} | ${usd(r.costUsd)} |`,
    ),
    '',
    '同一段跑出来的几项（J3 和 J4）耗时和花费相同，合计里只算一次。花费按 Spica 自己的可追溯记录估算。',
    '',
    '## 说明',
    '',
    ...info.results.map((r) => `- **${r.id}** ${MARK[r.status]}：${r.note}`),
    '',
  ];
  return lines.join('\n');
}
