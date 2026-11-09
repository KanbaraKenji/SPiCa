// Outlook plugin smoke test, the whole flow inside a real Spica runtime:
// install → tools appear → mock mode reads the 30 sample messages → triage
// steps → draft a reply → (real Outlook when this computer has one) → disable
// → tools gone.
//
//   npm run smoke -w @spica/plugin-outlook-mail            mock, plus a real-Outlook check
//   npm run smoke -w @spica/plugin-outlook-mail -- --real-draft   also create one real draft (never sent)
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleProvider, Runtime } from '@spica/core';
import { PluginManager, runtimeHost } from '@spica/plugins';

const plugin = fileURLToPath(new URL('..', import.meta.url));
const realDraft = process.argv.includes('--real-draft');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const rt = new Runtime({
  providers: [new OpenAICompatibleProvider({ id: 'model', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'unused-key-000000' })],
  defaults: { providerId: 'model', model: 'none', maxTokens: 256 },
  tools: [],
});
const root = await mkdtemp(join(tmpdir(), 'spica-outlook-smoke-'));
const project = await mkdtemp(join(tmpdir(), 'spica-outlook-project-'));
const pm = new PluginManager({ host: runtimeHost(rt), root });
pm.on((e) => {
  if (e.type === 'plugin.error' || e.type === 'hook.error') console.log(`  ! ${e.type}: ${e.message}`);
});
const tools = () => rt.tools.list({ providerId: 'model', serverWebSearch: false }).map((t) => t.spec.name).sort();
const body = (r) => {
  const i = r.content.indexOf('{');
  return i >= 0 ? JSON.parse(r.content.slice(i)) : undefined;
};
/** Hooks first (confirmation, project-folder guard), then the tool. */
async function use(name, input) {
  const { decision, input: final } = await rt.hooks.beforeTool({ callId: 'c', name, input, irreversible: !!rt.tools.get(name)?.spec.irreversible }, { session: { cwd: project }, runId: 'r', turn: 1 });
  if (decision.action === 'deny') return { decision, content: decision.reason, isError: true };
  const t0 = Date.now();
  const out = await rt.tools.get(name).execute(final, { sessionId: 'smoke', parentChain: [], cwd: project, signal: new AbortController().signal, tracer: rt.tracer, extractors: [], services: {}, callId: 'c', emit() {} });
  return { decision, ms: Date.now() - t0, ...out };
}

try {
  console.log(`Outlook plugin smoke (plugin root ${root})`);

  console.log('\n1. 装上');
  const inst = await pm.install(plugin, { kind: 'folder', location: plugin });
  check(inst.name === 'outlook', '装上 outlook', `${inst.displayName} ${inst.version}`);

  console.log('\n2. 打开模拟模式、启用 → 工具可用');
  await pm.setMock(true);
  const d = await pm.enable('outlook');
  check(d.servers[0]?.status === 'running', 'MCP server 已启动');
  const t = tools();
  check(t.length === 9 && t.includes('outlook__list_messages') && t.includes('outlook__create_draft'), '8 个工具 + 技能工具', t.join(', '));

  console.log('\n3. 模拟模式读 30 封');
  const folders = body(await use('outlook__list_folders', {}));
  const total = folders.folders.reduce((n, f) => n + f.total, 0);
  check(total === 30, '各文件夹合计 30 封', folders.folders.map((f) => `${f.path} ${f.total}`).join(' · '));
  const unread = await use('outlook__list_messages', { unread_only: true, limit: 50 });
  check(unread.content.includes('[sample data — mock mode]'), '结果标明是样例数据');
  const u = body(unread);
  check(u.total > 0, `收件箱未读 ${u.total} 封`, u.messages.slice(0, 3).map((m) => m.subject).join(' / '));
  const read = body(await use('outlook__read_message', { id: 'mock-008' }));
  check(read.subject.includes('团体报名') && read.unread === true, '读正文（不会标成已读）', read.subject);

  console.log('\n4. 归类后的动作');
  const mv = await use('outlook__move_messages', { ids: ['mock-022'], folder: 'Inbox/Website Refresh' });
  check(mv.decision.action === 'confirm', '移动邮件要用户确认');
  const mr = await use('outlook__mark_read', { ids: ['mock-011', 'mock-012'] });
  check(mr.decision.action === 'allow' && !mr.isError, '标已读不用确认');
  const sv = await use('outlook__save_attachments', { id: 'mock-003' });
  const saved = await readdir(join(project, 'attachments')).catch(() => []);
  check(!sv.isError && saved.includes('quote-SM-3306.txt'), '附件存进项目文件夹 attachments/', saved.join(', '));
  const out = await use('outlook__save_attachments', { id: 'mock-003', dest_folder: 'C:\\Windows\\Temp' });
  check(out.decision.action === 'deny', '项目文件夹外的路径被拦下', out.content.slice(0, 40));

  console.log('\n5. 起草一封回复（模拟）');
  const dr = body(await use('outlook__create_draft', { reply_to: 'mock-008', body: '您好，可以团体报名，12 人有团体价，下午场还有位置。' }));
  check(dr.folder === 'Drafts' && dr.sent === false, '草稿进了草稿箱、没有发送', dr.subject);

  console.log('\n6. 真 Outlook');
  await pm.setMock(false);
  const st = body(await use('outlook__status', {}));
  const o = st.outlook;
  console.log(`     经典版 ${o.classic_installed ? '是' : '否'} · 新版 ${o.new_outlook_installed ? '是' : '否'} · 有配置文件 ${o.profile ? '是' : '否'} · 开着 ${o.running ? '是' : '否'} · ${o.powershell_bits ?? '?'} 位 PowerShell · 邮箱 ${st.mailboxes.length} 个`);
  check(typeof o.hint === 'string' && o.hint.length > 0, `状态：${o.state}`, o.hint);
  if (o.state === 'ready') {
    const list = await use('outlook__list_messages', { limit: 5 });
    check(!list.isError, '读真收件箱列表', `${list.ms} ms`);
    const first = body(list)?.messages?.[0];
    if (first) {
      const m = await use('outlook__read_message', { id: first.id, max_chars: 500 });
      check(!m.isError, '读一封真邮件正文', `${m.ms} ms`);
      if (realDraft) {
        const r = await use('outlook__create_draft', { reply_to: first.id, body: 'Spica smoke test draft — safe to delete.' });
        check(!r.isError && body(r)?.sent === false, '真草稿已存进草稿箱（未发送）', `${r.ms} ms`);
      } else {
        console.log('     （加 --real-draft 会在草稿箱里建一封测试草稿，不会发送）');
      }
    }
  } else {
    const r = await use('outlook__list_messages', {});
    check(r.isError && /^\[(OUTLOOK_|NOT_WINDOWS|POWERSHELL_)/.test(r.content), '没有可用的 Outlook 时给出明确错误码', r.content);
  }

  console.log('\n7. 停用 → 工具消失');
  await pm.disable('outlook');
  check(tools().length === 0, '工具表里没有了', tools().join(', ') || '(空)');
  check(rt.hooks.sources.length === 0, '钩子全部解绑');
} catch (err) {
  failures++;
  console.error('  ✗ 出错：', err instanceof Error ? err.message : err);
} finally {
  await pm.shutdown();
  await rt.close();
  await rm(root, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n通过' : `\n没通过：${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
