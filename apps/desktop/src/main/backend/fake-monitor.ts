// The demo's 监控台: what a morning of the real back end writes (a start, plugin servers, requests from the demo's
// request log with their 429 answers, tool calls, a crash and the restart after it), so the page can be looked at
// and screenshotted without the core. Made-up lines; nothing here is read from the machine.
import type { RequestRecord } from '@spica/protocol';
import type { MonitorHub } from '../monitor';
import { requestText } from '../monitor';
import { DEMO_PROVIDER_NAMES } from './fake-usage';

export function seedDemoMonitor(hub: MonitorHub, requests: RequestRecord[], now: Date): void {
  const t0 = now.getTime() - 40 * 60_000;
  const at = (min: number) => new Date(t0 + min * 60_000);
  const lines: [number, Parameters<MonitorHub['add']>[0], Parameters<MonitorHub['add']>[1], string][] = [
    [0, 'process', 'info', 'core starting (pid 18204)'],
    [0.02, 'core', 'info', 'restored 6 sessions from spica.db'],
    [0.03, 'plugin', 'info', '[example-notes] enabled 0.3.1; tools: notes_list, notes_add'],
    [0.04, 'plugin', 'info', '[outlook-mail] enabled 0.4.0; tools: mail_fetch, mail_send'],
    [0.05, 'process', 'info', 'core ready'],
    [0.06, 'core', 'warn', 'workflow file 周报.md: missing "steps", skipped'],
    [3.1, 'tool', 'info', 'read_file ← {"path":"docs/plan.md"}'],
    [3.2, 'tool', 'info', 'read_file ok 12ms → # 计划 本周三件事：一、整理来信……'],
    [5.4, 'tool', 'info', 'run_command ← 统计本月的工单数'],
    [5.9, 'tool', 'error', 'run_command failed 431ms → Get-Content : 找不到路径“C:\\Users\\me\\Documents\\tickets.csv”，因为该路径不存在。'],
    [6.2, 'plugin', 'error', '[outlook-mail] [mail] fetch failed: connect ETIMEDOUT 203.0.113.10:443'],
    [9.0, 'core', 'warn', '[gateway.rate_limited] retrying model call (HTTP 429)'],
    [14.5, 'process', 'error', 'core exited (code 3221225477): unexpected'],
    [14.5, 'process', 'warn', 'core restarts in 1s'],
    [14.53, 'process', 'info', 'core restarting (pid 19876)'],
    [14.56, 'process', 'info', 'core ready'],
    [21.0, 'tool', 'info', 'web_fetch ← {"url":"https://example.com/release-notes"}'],
    [21.1, 'tool', 'info', 'web_fetch ok 640ms → <h1>Release notes</h1> **2.4** adds export to CSV'],
    [30.2, 'core', 'info', 'settings applied: providers'],
  ];
  const entries: { at: Date; add: () => void }[] = lines.map(([m, source, level, text]) => ({ at: at(m), add: () => hub.add(source, level, text, undefined, at(m)) }));
  // the demo's newest requests, spread over the same forty minutes
  const recent = requests.slice(-60);
  recent.forEach((r, i) => {
    const when = at((i / recent.length) * 39);
    entries.push({ at: when, add: () => hub.add('request', r.status === 'ok' || r.status === 'aborted' ? 'info' : r.httpStatus === 429 || r.retried ? 'warn' : 'error', requestText(r, (id) => DEMO_PROVIDER_NAMES[id] ?? id), r.sessionId ?? undefined, when) });
  });
  entries.sort((a, b) => a.at.getTime() - b.at.getTime()).forEach((e) => e.add());
}
