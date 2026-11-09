// The acceptance journeys J2–J7, written only against Spica's MCP tools
// (spica_*). Each check returns pass / fail and a one-line note; the runner
// adds time and cost. J6 follows the same steps as
// packages/plugins/scripts/journey-j6.ts.
import type { Json, SpicaLink } from './link.ts';

export interface JourneyContext {
  /** Current connection (J7 replaces it after the restart). */
  link: SpicaLink;
  /** Stop Spica and start it again on the same database; undefined when the run does not own Spica. */
  restart?: () => Promise<SpicaLink>;
  /** Folder of the example plugin J6 installs. */
  examplePlugin: string;
}

export interface Check {
  id: string;
  title: string;
  ok: boolean;
  note: string;
}

export interface Journey {
  id: string;
  /** Checks it reports (one journey can report two, like J3 + J4). */
  checks: { id: string; title: string }[];
  /** Needs files this run put next to Spica (only when the run starts Spica itself). */
  needsLocalFixtures?: boolean;
  /** Needs to restart Spica. */
  needsRestart?: boolean;
  run(ctx: JourneyContext): Promise<Check[]>;
}

const text = (v: unknown) => String(v ?? '');
const flat = (s: string, n: number) => s.replace(/\s+/g, ' ').slice(0, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Ev = { seq: number; type: string; sessionId: string; name?: string; input?: unknown };

export const JOURNEYS: Journey[] = [
  {
    id: 'J2',
    checks: [{ id: 'J2', title: '读 PDF / Word / Excel' }],
    needsLocalFixtures: true,
    async run({ link }) {
      const s = await link.call('spica_create_session', { title: 'J2' });
      const r = await link.call('spica_run', {
        session_id: s.id,
        text: 'Read docs/quote.pdf, docs/spec.docx and docs/inventory.xlsx in the working folder. Answer in one short line each: the unit price in the quote, the battery capacity in the spec, and the quantity of 无线键盘 in the inventory.',
        timeout_seconds: 300,
      });
      const answer = text(r.answer);
      const msgs = (await link.call('spica_get_messages', { session_id: s.id })) as unknown as { meta?: { fileCards?: Record<string, { kind: string }> } }[];
      const kinds = msgs.flatMap((m) => Object.values(m.meta?.fileCards ?? {}).map((c) => c.kind));
      const ok = /12[.,]40/.test(answer) && /4800/.test(answer) && /150/.test(answer) && ['pdf', 'docx', 'xlsx'].every((k) => kinds.includes(k));
      return [{ id: 'J2', title: '读 PDF / Word / Excel', ok, note: `答：${flat(answer, 160)}｜文件卡：${kinds.join(', ')}` }];
    },
  },
  {
    id: 'J3',
    checks: [
      { id: 'J3', title: '建项目、开两个子 Agent' },
      { id: 'J4', title: '在子 Agent 里改方向，项目经理照改' },
    ],
    needsLocalFixtures: true,
    async run({ link }) {
      const p = await link.call('spica_create_project', {
        name: 'Supplier choice',
        folder: 'suppliers',
        workflow: 'product-development',
        brief:
          'Compare the two supplier offers in the project folder (supplier-a.md, supplier-b.md): start one sub-agent per file to summarize it, wait for both with wait_agents, then recommend one supplier.',
      });
      let since = 0;
      let redirected = '';
      const t0 = Date.now();
      while (!redirected && Date.now() - t0 < 180_000) {
        const events = (await link.call('spica_events', { since })) as unknown as Ev[];
        for (const e of events) {
          since = Math.max(since, e.seq);
          if (!redirected && e.type === 'tool.start' && e.name === 'read_file' && JSON.stringify(e.input).includes('supplier-b') && e.sessionId !== p.managerSessionId) {
            redirected = e.sessionId;
            await link.call('spica_send', { session_id: e.sessionId, text: 'Only payment terms and certification matter. Ignore price.' });
          }
        }
        await sleep(300);
      }
      await link.call('spica_wait', { session_id: p.managerSessionId, wait_for_subagents: true, timeout_seconds: 300 });
      await sleep(1500); // the manager may finish before the redirect lands: wait for the follow-up too
      const again = await link.call('spica_wait', { session_id: p.managerSessionId, wait_for_subagents: true, timeout_seconds: 300 });
      const pmMsgs = (await link.call('spica_get_messages', { session_id: p.managerSessionId })) as unknown as { kind: string; text?: string }[];
      const answer = pmMsgs
        .filter((m) => m.kind === 'assistant' && m.text)
        .map((m) => m.text)
        .join('\n');
      const subs = (again.subAgents as unknown[]).length;
      const followed =
        /payment|prepay|付款/i.test(answer) &&
        /certif|ISO|认证/i.test(answer) &&
        /user|sub-agent|子|said|instruction|you (decided|asked|wanted)|your (decision|instruction)|as you|用户/i.test(answer);
      return [
        { id: 'J3', title: '建项目、开两个子 Agent', ok: subs >= 2 && answer.length > 0, note: `项目「${text(p.name)}」，子 Agent ${subs} 个` },
        { id: 'J4', title: '在子 Agent 里改方向，项目经理照改', ok: !!redirected && followed, note: `插话${redirected ? '已发' : '没发出去'}；项目经理：${flat(answer, 400).slice(-220)}` },
      ];
    },
  },
  {
    id: 'J5',
    checks: [{ id: 'J5', title: '提问卡 → 确认 → 执行' }],
    async run({ link }) {
      const s = await link.call('spica_create_session', { title: 'J5' });
      let r = await link.call('spica_run', {
        session_id: s.id,
        text: 'First use ask_user to ask me which single word to print. After I answer, use run_command to run exactly: Write-Output <that word>. Then tell me the output.',
        timeout_seconds: 180,
      });
      const pending = (x: Json) => (x.pending ?? []) as { kind: string; callId: string }[];
      const ask = pending(r).find((x) => x.kind === 'ask');
      if (ask) {
        await link.call('spica_answer', { session_id: s.id, call_id: ask.callId, answer: 'Orion' });
        r = await link.call('spica_wait', { session_id: s.id, timeout_seconds: 180 });
      }
      const confirm = pending(r).find((x) => x.kind === 'confirm');
      if (confirm) {
        await link.call('spica_confirm', { session_id: s.id, call_id: confirm.callId, approved: true });
        r = await link.call('spica_wait', { session_id: s.id, timeout_seconds: 180 });
      }
      return [{ id: 'J5', title: '提问卡 → 确认 → 执行', ok: !!ask && !!confirm && /Orion/.test(text(r.answer)), note: `问了：${ask ? '是' : '否'}；确认：${confirm ? '是' : '否'}；答：${flat(text(r.answer), 120)}` }];
    },
  },
  {
    id: 'J6',
    checks: [{ id: 'J6', title: '插件：装上能用，停用后调不到' }],
    async run({ link, examplePlugin }) {
      const tools = async () => ((await link.call('spica_list_tools')) as unknown as { name: string }[]).map((t) => t.name);
      const steps: string[] = [];
      const step = (label: string, ok: boolean) => (steps.push(`${ok ? '✓' : '✗'} ${label}`), ok);
      let ok = step('一开始没有插件工具', !(await tools()).some((t) => t.startsWith('notes__')));
      const d = await link.call('spica_plugin_install', { path: examplePlugin, enable: true });
      ok = step('装上并启用', d.enabled === true) && ok;
      const after = await tools();
      ok = step('工具立刻出现', after.includes('notes__write_note') && after.includes('notes__read_note')) && ok;
      const s = await link.call('spica_create_session', { title: 'J6' });
      const run = await link.call('spica_run', {
        session_id: s.id,
        text: 'Save a note titled "j6" with the text "plugins work", then read it back and tell me what it says in one sentence.',
        timeout_seconds: 180,
      });
      const used = (run.toolCalls as string[]) ?? [];
      ok = step('Agent 调了插件工具', used.includes('notes__write_note') && used.includes('notes__read_note')) && ok;
      ok = step('回答里带出笔记内容', /plugins work/i.test(text(run.answer))) && ok;
      await link.call('spica_plugin_disable', { name: 'notes' });
      ok = step('停用后工具消失', !(await tools()).some((t) => t.startsWith('notes__'))) && ok;
      const run2 = await link.call('spica_run', {
        session_id: s.id,
        text: 'Read the note "j6" again with the notebook tool. If no notebook tool is available, just say "no notebook tool".',
        timeout_seconds: 180,
      });
      const used2 = (run2.toolCalls as string[]) ?? [];
      ok = step('停用后 Agent 也调不到', !used2.some((t) => t.startsWith('notes__'))) && ok;
      await link.call('spica_plugin_uninstall', { name: 'notes' }).catch(() => undefined);
      return [{ id: 'J6', title: '插件：装上能用，停用后调不到', ok, note: steps.join('；') }];
    },
  },
  {
    id: 'J7',
    checks: [{ id: 'J7', title: '运行中关掉、重开、续跑' }],
    needsLocalFixtures: true,
    needsRestart: true,
    async run(ctx) {
      const s = await ctx.link.call('spica_create_session', { title: 'J7' });
      await ctx.link.call('spica_send', { session_id: s.id, text: 'Read docs/quote.pdf, then docs/spec.docx, then docs/inventory.xlsx, one after another, and summarize each in one line.' });
      let since = 0;
      let started = false;
      const t0 = Date.now();
      while (!started && Date.now() - t0 < 120_000) {
        const events = (await ctx.link.call('spica_events', { since, session_id: s.id })) as unknown as Ev[];
        for (const e of events) {
          since = Math.max(since, e.seq);
          if (e.type === 'tool.start' || e.type === 'thinking.delta' || e.type === 'status') started = true;
        }
        await sleep(200);
      }
      ctx.link = await ctx.restart!(); // the app is closed mid-run and opened again
      const sessions = (await ctx.link.call('spica_list_sessions')) as unknown as { id: string; status: string }[];
      const mine = sessions.find((x) => x.id === s.id);
      let resumed = '';
      if (mine?.status === 'interrupted') {
        await ctx.link.call('spica_resume', { session_id: s.id });
        resumed = text((await ctx.link.call('spica_wait', { session_id: s.id, timeout_seconds: 300 })).answer);
      }
      const ok = (mine?.status === 'interrupted' && resumed.length > 0) || mine?.status === 'idle';
      return [{ id: 'J7', title: '运行中关掉、重开、续跑', ok, note: `重开后这个会话是 ${mine?.status ?? '找不到'}，共 ${sessions.length} 个会话${resumed ? `；续跑答：${flat(resumed, 100)}` : ''}` }];
    },
  },
];
