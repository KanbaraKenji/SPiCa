// The evaluation harness: journeys over Spica's MCP service (here over HTTP,
// with a scripted model), time and cost per journey, skips, failures, report.
import { fileURLToPath } from 'node:url';
import { serveMcpHttp, type McpHttpServer, type Runtime } from '@spica/core';
import { readPluginFolder } from '@spica/plugins';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeGateway } from '../../../packages/core/src/testing/fake-gateway.ts';
import { makeRuntime, tempDir } from '../../../packages/core/src/testing/helpers.ts';
import { evaluate } from './evaluate.ts';
import { JOURNEYS, type Journey } from './journeys.ts';
import { httpLink, type SpicaLink } from './link.ts';
import { renderReport } from './report.ts';

let gw: FakeGateway;
let srv: McpHttpServer;
let rt: Runtime;
let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  gw = await new FakeGateway().start();
  ({ dir, cleanup } = await tempDir());
  rt = makeRuntime(gw, { cwd: dir });
  srv = await serveMcpHttp(rt);
});
afterEach(async () => {
  await srv.close();
  await rt.close();
  await gw.stop();
  await cleanup();
});
const examplePlugin = fileURLToPath(new URL('../../example-notes', import.meta.url));

describe('evaluation over the MCP service', () => {
  it('runs J5 over HTTP, measures it, and skips what needs a Spica of its own', async () => {
    gw.enqueue(
      { toolCalls: [{ id: 'a1', name: 'ask_user', args: { question: 'Which word?' } }], usage: { input: 1000, output: 20 } },
      { toolCalls: [{ id: 'r1', name: 'run_command', args: { command: 'Write-Output Orion' } }], usage: { input: 1200, output: 20 } },
      { text: 'The output was: Orion', usage: { input: 1300, output: 10 } },
    );
    const link = httpLink(srv.url, srv.token);
    const seen: string[] = [];
    const { results, totals } = await evaluate({ link, examplePlugin }, JOURNEYS, {
      only: ['J2', 'J5', 'J7'],
      localFixtures: false,
      onResult: (r) => seen.push(`${r.id}:${r.status}`),
    });
    expect(seen).toEqual(['J2:skipped', 'J5:pass', 'J7:skipped']);
    const j5 = results.find((r) => r.id === 'J5')!;
    expect(j5.requests).toBe(3);
    expect(j5.costUsd).toBeGreaterThan(0);
    expect(j5.durationMs).toBeGreaterThan(0);
    expect(totals).toMatchObject({ requests: 3, costUsd: j5.costUsd });

    const md = renderReport({ startedAt: '2026-11-10T00:00:00Z', mode: 'HTTP', model: 'fake', results, journeyTotals: totals });
    expect(md).toMatch(/^# Spica 评测报告\n\n\*\*全部通过\*\*：通过 1，失败 0，跳过 2/);
    expect(md).toContain('| J5 | 提问卡 → 确认 → 执行 | ✅ 通过 |');
    expect(md).toContain('| J2 | 读 PDF / Word / Excel | ⏭ 跳过 | — | — |');
    expect(md).not.toContain(srv.token);
  }, 30_000);

  it('a journey that throws fails all its checks with the reason; a failed check is reported as such', async () => {
    const link: SpicaLink = { call: async () => ({}), text: async () => '', close: async () => {} };
    const broken: Journey = { id: 'JX', checks: [{ id: 'JX', title: 'a' }, { id: 'JY', title: 'b' }], run: async () => { throw new Error('service gone'); } };
    const wrong: Journey = { id: 'JZ', checks: [{ id: 'JZ', title: 'c' }], run: async () => [{ id: 'JZ', title: 'c', ok: false, note: 'answer did not mention 4800' }] };
    const { results, totals } = await evaluate({ link, examplePlugin }, [broken, wrong], { localFixtures: true });
    expect(results.map((r) => [r.id, r.status])).toEqual([['JX', 'fail'], ['JY', 'fail'], ['JZ', 'fail']]);
    expect(results[0]!.note).toContain('service gone');
    const md = renderReport({ startedAt: 'x', mode: 'm', model: 'm', results, journeyTotals: totals });
    expect(md).toContain('**3 项失败**');
    expect(md).toContain('- **JZ** ❌ 失败：answer did not mention 4800');
  });

  it('the plugin folder is a valid Spica plugin', async () => {
    const folder = await readPluginFolder(fileURLToPath(new URL('..', import.meta.url)));
    expect(folder.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(folder.manifest?.name).toBe('eval');
  });
});
