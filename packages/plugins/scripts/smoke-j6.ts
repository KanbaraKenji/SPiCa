// J6 smoke test: install the example plugin (with its MCP server), its tools
// are available at once, call one, disable it, the tools are gone.
//
//   npm run smoke:plugins -w @spica/plugins            direct tool calls, no model
//   npm run smoke:plugins:model -w @spica/plugins      also let a real model (DeepSeek, from .env.local) call a plugin tool
//
// Runs against a real @spica/core runtime in a temporary plugin root.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleProvider, Runtime, type Provider } from '@spica/core';
import { PluginManager, runtimeHost } from '../src/index.ts';

const withModel = process.argv.includes('--model');
const example = fileURLToPath(new URL('../../../plugins/example-notes', import.meta.url));

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

let provider: Provider;
let model = 'none';
if (withModel) {
  const key = process.env.SPICA_OPENAI_API_KEY;
  const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
  if (!key || !baseUrl) {
    console.error('--model needs SPICA_OPENAI_BASE_URL and SPICA_OPENAI_API_KEY (from .env.local)');
    process.exit(2);
  }
  model = process.env.SPICA_OPENAI_MODEL ?? 'deepseek-flash';
  provider = new OpenAICompatibleProvider({ id: 'model', baseUrl, apiKey: key });
} else {
  provider = new OpenAICompatibleProvider({ id: 'model', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'unused-key-000000' });
}

const rt = new Runtime({
  providers: [provider],
  defaults: { providerId: 'model', model, maxTokens: 1024, maxTurns: 6 },
  tools: [],
  budget: { globalUsd: 0.05, perRunUsd: 0.02 },
});
const root = await mkdtemp(join(tmpdir(), 'spica-j6-'));
const pm = new PluginManager({ host: runtimeHost(rt), root });
pm.on((e) => {
  if (e.type === 'plugin.error' || e.type === 'hook.error') console.log(`  ! ${e.type}: ${e.message}`);
});
const tools = () => rt.tools.list({ providerId: 'model', serverWebSearch: false }).map((t) => t.spec.name).sort();
const call = async (name: string, input: Record<string, unknown>) => {
  const t = rt.tools.get(name);
  if (!t) return { content: `(no tool ${name})`, isError: true };
  return t.execute(input, {
    sessionId: 'smoke',
    parentChain: [],
    cwd: root,
    signal: new AbortController().signal,
    tracer: rt.tracer,
    extractors: [],
    services: {},
    callId: 'smoke-1',
    emit() {},
  });
};

try {
  console.log(`J6 plugin smoke (plugin root ${root})`);
  console.log('\n1. 装上示例插件');
  const t0 = Date.now();
  const inst = await pm.install(example, { kind: 'folder', location: example });
  check(inst.name === 'notes' && inst.version === '0.1.0', '装上 notes', `${inst.displayName} ${inst.version}`);
  check(tools().length === 0, '还没启用，工具表里没有它的工具');

  console.log('\n2. 启用 → 工具立刻可用');
  const d = await pm.enable('notes');
  check(d.enabled && d.servers[0]?.status === 'running', 'MCP server 已启动', `${d.servers[0]?.runtime} · ${Date.now() - t0} ms`);
  const after = tools();
  check(after.includes('notes__write_note') && after.includes('notes__search_catalog'), '工具表里出现了', after.join(', '));
  check(d.skills.length === 1 && d.commands.length === 1 && d.hooks[0]?.kinds.includes('inject') === true, '技能、命令、钩子都挂上', `${d.skills[0]?.id} · /notes:${d.commands[0]?.id} · ${d.hooks[0]?.module}`);

  console.log('\n3. 调一次');
  const w = await call('notes__write_note', { title: 'smoke', text: '2026-11-09\nJ6 works' });
  check(!w.isError, 'notes__write_note', w.content);
  const rd = await call('notes__read_note', { title: 'smoke' });
  check(!rd.isError && rd.content.includes('J6 works'), 'notes__read_note', rd.content.replace(/\n/g, ' '));
  const off = await call('notes__search_catalog', { query: 'clocks' });
  check(!!off.isError, '模拟模式关：样例目录提示「没配置，打开模拟模式」', off.content.slice(0, 70));
  await pm.setMock(true);
  const on = await call('notes__search_catalog', { query: 'clocks' });
  check(!on.isError && on.content.includes('A Short History of Clocks'), '模拟模式开：返回样例数据', on.content.split('\n')[1] ?? '');

  if (withModel) {
    console.log(`\n3b. 真模型调插件工具（${model}）`);
    const s = rt.createSession();
    const run = await s.send('Use the notebook tool to read my note titled "smoke" and tell me what it says, in one sentence.').done;
    const msgs = JSON.stringify(s.messages());
    check(msgs.includes('notes__read_note'), '模型调用了 notes__read_note', `run ended: ${run.reason}`);
    const text = run.text;
    check(/J6/.test(text), '回答里带出了笔记内容', text.slice(0, 120));
  }

  console.log('\n4. 停用 → 工具消失');
  await pm.disable('notes');
  const gone = tools();
  check(gone.length === 0, '工具表里没有了', gone.join(', ') || '(空)');
  check(rt.hooks.sources.length === 0, '钩子全部解绑');
  const desc = pm.describe('notes');
  check(!desc.enabled && desc.servers[0]?.status === 'stopped', 'MCP server 已停');
  const again = await call('notes__read_note', { title: 'smoke' });
  check(!!again.isError, '再调用会失败', again.content);
} catch (err) {
  failures++;
  console.error('  ✗ 出错：', err instanceof Error ? err.message : err);
} finally {
  await pm.shutdown();
  await rt.close();
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nJ6 通过' : `\nJ6 没通过：${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
