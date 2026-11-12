// The demo backend's request log: two weeks of made-up model requests over three
// providers and five models, with some 429 answers (a few bursts, most retried and
// then answered), server errors and timeouts. Same every time for the same clock.
import type { RequestRecord } from '@spica/protocol';
import { isoAt } from './time';

const DAY = 86_400_000;

/** Small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DemoModel {
  providerId: string;
  model: string;
  /** Requests on a busy day. */
  daily: number;
  /** USD per million input / output tokens; null: no known price. */
  price: [number, number] | null;
}

/**
 * The demo's providers as people call them (the catalog's names; 'fake' is the provider the demo's own
 * conversations run on). The demo's records use these ids; nothing like them is saved in 设置 › 模型.
 */
export const DEMO_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  deepseek: 'DeepSeek',
  anthropic: 'Anthropic Claude',
  gateway: '公司网关',
  fake: 'DeepSeek',
};

export const DEMO_MODELS: readonly DemoModel[] = [
  { providerId: 'deepseek', model: 'deepseek-chat', daily: 46, price: [0.27, 1.1] },
  { providerId: 'deepseek', model: 'deepseek-reasoner', daily: 12, price: [0.55, 2.19] },
  { providerId: 'anthropic', model: 'claude-sonnet-4-5', daily: 18, price: [3, 15] },
  { providerId: 'anthropic', model: 'claude-haiku-4-5', daily: 9, price: [1, 5] },
  { providerId: 'gateway', model: 'gateway-model', daily: 7, price: null },
];

/** Days with a burst of 429 answers (days before `now`) and the model that got them. */
const BURSTS: readonly [number, string][] = [
  [0, 'deepseek-chat'],
  [3, 'claude-sonnet-4-5'],
  [6, 'deepseek-chat'],
  [10, 'deepseek-reasoner'],
];

export function fakeRequests(now: Date, days = 14): RequestRecord[] {
  const rand = rng(20261113);
  const out: RequestRecord[] = [];
  let n = 0;
  const end = now.getTime();
  for (let d = days - 1; d >= 0; d--) {
    const dayStart = end - (d + 1) * DAY;
    const weekend = new Date(dayStart).getDay() % 6 === 0;
    for (const m of DEMO_MODELS) {
      const count = Math.round(m.daily * (weekend ? 0.35 : 0.7 + rand() * 0.6));
      const burst = BURSTS.some(([bd, bm]) => bd === d && bm === m.model);
      for (let i = 0; i < count; i++) {
        // working hours mostly
        const hour = 9 + rand() * 10 + (rand() < 0.15 ? 4 : 0);
        const t = dayStart + Math.min(DAY - 60_000, hour * 3_600_000 + rand() * 60_000);
        if (t > end) continue;
        const traceId = `tr_demo${++n}`;
        const base = { traceId, sessionId: rand() < 0.85 ? 's_demo' : null, initiator: rand() < 0.9 ? 'model' : 'runtime:memory-tidy', providerId: m.providerId, model: m.model } as const;
        let at = t;
        let attempt = 1;
        // a burst: one to three 429 answers before it goes through (sometimes it never does)
        const limited = burst ? 1 + Math.floor(rand() * 3) : rand() < 0.02 ? 1 : 0;
        for (let k = 0; k < limited; k++) {
          const last = burst && k === limited - 1 && rand() < 0.2;
          out.push({ id: `rq_demo${++n}`, ...base, startedAt: isoAt(new Date(at)), durationMs: 80 + Math.round(rand() * 300), attempt, ...(last ? {} : { retried: true as const }), status: 'error', httpStatus: 429, errorCode: 'gateway.rate_limited', error: 'HTTP 429 [gateway.rate_limited]: rate limit reached for requests' });
          if (last) break;
          at += 1000 + rand() * 4000;
          attempt++;
        }
        if (attempt <= limited && burst) continue; // given up after the 429s
        const fail = rand();
        if (fail < 0.012) {
          out.push({ id: `rq_demo${++n}`, ...base, startedAt: isoAt(new Date(at)), durationMs: 600 + Math.round(rand() * 900), attempt, retried: true, status: 'error', httpStatus: 503, errorCode: 'gateway.server', error: 'HTTP 503 [gateway.server]: upstream unavailable' });
          at += 1500;
          attempt++;
        } else if (fail < 0.02) {
          out.push({ id: `rq_demo${++n}`, ...base, startedAt: isoAt(new Date(at)), durationMs: 120_000, attempt, status: 'error', errorCode: 'net.timeout', error: 'request failed [net.timeout] (TimeoutError: timed out waiting for response)' });
          continue;
        }
        const input = Math.round(2000 + rand() * 30000);
        const output = Math.round(100 + rand() * (m.model.includes('reasoner') ? 4000 : 1500));
        const cacheRead = m.providerId === 'gateway' ? 0 : Math.round(input * rand() * 0.7);
        const cost = m.price ? ((input - cacheRead) * m.price[0] + cacheRead * m.price[0] * 0.1 + output * m.price[1]) / 1_000_000 : 0;
        out.push({
          id: `rq_demo${++n}`,
          ...base,
          startedAt: isoAt(new Date(at)),
          durationMs: 1500 + Math.round(rand() * 20000),
          attempt,
          status: 'ok',
          httpStatus: 200,
          inputTokens: input,
          outputTokens: output,
          ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
          ...(m.price ? { costUsd: Math.round(cost * 1e6) / 1e6 } : { unpriced: true as const }),
        });
      }
    }
  }
  return out.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}
