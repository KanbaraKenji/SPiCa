// Real-model smoke for taking back 始终允许: the user allows a folder outside the conversation's folder on the
// card, writes there again without a card, then asks in their own words to be asked again; the agent takes the
// folder back with allowed_folders (no card for that), and the next write there shows the card again. The writes
// use relative paths (a path the user types counts as given, and would need no card at all); the second time the
// user names the folder in full when asking to be asked again, which must not give it anew.
//
//   node --env-file=../../.env.local scripts/smoke-allowed-folders.ts
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleProvider } from '../src/providers/openai.ts';
import { Runtime } from '../src/runtime.ts';
import type { CoreEvent } from '../src/types.ts';

const baseUrl = process.env.SPICA_OPENAI_BASE_URL;
const apiKey = process.env.SPICA_OPENAI_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('missing SPICA_OPENAI_BASE_URL / SPICA_OPENAI_API_KEY');
  process.exit(2);
}
const model = process.env.SPICA_OPENAI_MODEL ?? 'deepseek-flash';
const root = await mkdtemp(join(tmpdir(), 'spica-allowed-'));
const work = join(root, 'work');
const minutes = join(root, 'minutes');
await mkdir(work);
await mkdir(minutes);

const rt = new Runtime({
  providers: [new OpenAICompatibleProvider({ id: 'openai', baseUrl, apiKey })],
  redactions: [apiKey, baseUrl],
  defaults: { providerId: 'openai', model, maxTokens: 1200, maxTurns: 8 },
  cwd: work,
  projectsRoot: root,
  budget: { perRunUsd: 0.2, globalUsd: 0.6 },
  mail: { enabled: false },
});
const events: CoreEvent[] = [];
rt.events.on((e) => events.push(e));
const s = rt.createSession({ cwd: work, approvalMode: 'auto' });

const cards = () => events.filter((e) => e.type === 'confirm.request') as Extract<CoreEvent, { type: 'confirm.request' }>[];
const calls = (name: string) => events.filter((e) => e.type === 'tool.call' && (e as { name?: string }).name === name).length;
const checks: [string, boolean][] = [];
const check = (what: string, ok: boolean) => {
  checks.push([what, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
};

/** One user turn; a card that comes up is answered as `answer` says (until the run ends). */
async function turn(text: string, answer: 'always' | 'once' | 'no' | 'none' = 'none') {
  console.log(`\n> ${text}`);
  const before = cards().length;
  let r = await s.send(text).done;
  while (r.reason === 'awaiting_confirm' || r.reason === 'awaiting_answer') {
    if (r.reason === 'awaiting_answer') {
      // the agent asks before writing (it may, after being told to ask first): the user says go ahead
      const q = events.filter((e) => e.type === 'ask.request').at(-1) as Extract<CoreEvent, { type: 'ask.request' }>;
      console.log(`  [ask] ${q.question.slice(0, 120)}; answer: 可以，直接写。`);
      r = await s.answer(q.callId, '可以，直接写。')!;
      continue;
    }
    const c = cards().at(-1)!;
    console.log(`  [card] ${c.name} → ${c.outsideFolder ?? '(no folder)'}; answer: ${answer}`);
    if (answer === 'none') break;
    r = await (await s.confirm(c.callId, answer !== 'no', answer === 'always' ? { allowFolder: true } : {}))!;
  }
  const last = s.messages().filter((m) => m.role === 'assistant').at(-1);
  const said = last?.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  if (said) console.log(`  [agent] ${said.slice(0, 300)}`);
  return { cards: cards().length - before, reason: r.reason };
}

try {
  const t1 = await turn('在 ../minutes/a.md 里写一行「样品改用 B 方案」。', 'always');
  check('first write outside: a card, allowed for good', t1.cards === 1 && s.allowedWriteFolders().length === 1);

  const t2 = await turn('再在 ../minutes/b.md 里写一行「交期延后一周」。', 'no');
  check('second write there: no card', t2.cards === 0 && (await readFile(join(minutes, 'b.md'), 'utf8').catch(() => '')).includes('交期'));

  const t3 = await turn('取消刚才的始终允许，以后往 minutes 文件夹写要先问我。', 'no');
  check('taking it back: allowed_folders called, no card', calls('allowed_folders') >= 1 && t3.cards === 0);
  check('taking it back: the folder is gone', s.allowedWriteFolders().length === 0);

  const t4 = await turn('在 ../minutes/c.md 里写一行「下周再评审」。', 'once');
  check('the next write there: the card again', t4.cards === 1 && cards().at(-1)?.outsideFolder !== undefined);

  const t5 = await turn('在 ../minutes/d.md 里写一行「样机下周到」。', 'always');
  check('allowed for good again', t5.cards === 1 && s.allowedWriteFolders().length === 1);

  const t6 = await turn(`以后往 ${minutes} 写要先问我。`, 'no');
  check('his own words with the folder in full: taken back, no card', t6.cards === 0 && s.allowedWriteFolders().length === 0 && !s.mayWriteIn(minutes));

  const t7 = await turn('在 ../minutes/e.md 里写一行「评审改到周五」。', 'none');
  check('the next write there: the card again', t7.cards === 1 && t7.reason === 'awaiting_confirm');
} finally {
  await rt.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
