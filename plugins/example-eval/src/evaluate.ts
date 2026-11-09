// Run journeys one after another and measure each: wall time, and the cost
// and number of requests from Spica's traceable records (the ones that appeared
// while the journey ran).
import type { Journey, JourneyContext } from './journeys.ts';
import type { CheckResult } from './report.ts';

interface TraceLine {
  id: string;
  costUsd?: number;
}

async function traces(ctx: JourneyContext): Promise<TraceLine[]> {
  const jsonl = await ctx.link.text('spica_export_traces');
  return jsonl
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceLine);
}

export interface EvaluateOptions {
  /** Journey ids to run (default all). */
  only?: string[];
  /** The run started Spica itself and put the fixture files next to it. */
  localFixtures: boolean;
  onResult?(r: CheckResult): void;
}

export async function evaluate(ctx: JourneyContext, journeys: Journey[], opts: EvaluateOptions): Promise<{ results: CheckResult[]; totals: { durationMs: number; costUsd: number; requests: number } }> {
  const results: CheckResult[] = [];
  const totals = { durationMs: 0, costUsd: 0, requests: 0 };
  const push = (r: CheckResult) => {
    results.push(r);
    opts.onResult?.(r);
  };
  for (const j of journeys) {
    const skip = (note: string) => j.checks.forEach((c) => push({ ...c, status: 'skipped', note, durationMs: 0, costUsd: 0, requests: 0 }));
    if (opts.only && !j.checks.some((c) => opts.only!.includes(c.id))) continue;
    if (j.needsLocalFixtures && !opts.localFixtures) {
      skip('要用本次评测放在 Spica 工作文件夹里的样例文件，连到已在运行的 Spica 时跳过');
      continue;
    }
    if (j.needsRestart && !ctx.restart) {
      skip('要重启 Spica，连到已在运行的 Spica 时跳过');
      continue;
    }
    const before = new Set((await traces(ctx)).map((t) => t.id));
    const t0 = performance.now();
    let checks;
    try {
      checks = await j.run(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks = j.checks.map((c) => ({ ...c, ok: false, note: `出错：${message.slice(0, 300)}` }));
    }
    const durationMs = Math.round(performance.now() - t0);
    const fresh = (await traces(ctx)).filter((t) => !before.has(t.id));
    const costUsd = fresh.reduce((a, t) => a + (t.costUsd ?? 0), 0);
    totals.durationMs += durationMs;
    totals.costUsd += costUsd;
    totals.requests += fresh.length;
    for (const c of checks) push({ id: c.id, title: c.title, status: c.ok ? 'pass' : 'fail', note: c.note, durationMs, costUsd, requests: fresh.length });
  }
  return { results, totals };
}
