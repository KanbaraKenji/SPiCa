// A sentence typed on an entry's page: the model proposes changes to that entry, the runtime keeps what passes its
// checks, applies it as a tidy (by 'ask') that can be undone, and keeps the summaries true (待整理).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryTidyRun } from './types.ts';
import { parseAsk } from './memory-ask.ts';
import type { FakeGateway } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway, tempDir } from './testing/helpers.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let gw: FakeGateway;
let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  gw = await startGateway();
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await gw.stop();
  await cleanup();
});

type Rt = ReturnType<typeof makeRuntime>;
const isAsk = (body: Record<string, unknown>) => {
  const msgs = body.messages as { role: string; content: unknown }[];
  return String(msgs.find((m) => m.role === 'system')?.content ?? '').startsWith('You change one entry');
};
const userText = (body: Record<string, unknown>) => {
  const msgs = body.messages as { role: string; content: unknown }[];
  const c = msgs.filter((m) => m.role === 'user').at(-1)?.content;
  return typeof c === 'string' ? c : JSON.stringify(c);
};
const done = (rt: Rt) =>
  new Promise<MemoryTidyRun>((resolve) => {
    const off = rt.events.on((e) => {
      if (e.type === 'memory.tidy' && e.run.status !== 'running') {
        off();
        resolve(e.run);
      }
    });
  });
const entry = (rt: Rt, name: string, summary: string, category: 'you' | 'people' | 'areas', details: string[]) => {
  const first = rt.memory.addOwn(details[0]!, { name, summary, category }) as { entry: { id: number } };
  for (const d of details.slice(1)) rt.memory.addOwn(d, first.entry.id);
  return { id: first.entry.id, items: rt.memory.details(first.entry.id) };
};
/** The model answers `answer` to the ask; the prompt it got. */
const answering = (answer: unknown) => {
  const got = { prompt: '' };
  gw.onRequest((req) => {
    if (!isAsk(req.body)) return { text: '好' };
    got.prompt = userText(req.body);
    return { text: typeof answer === 'string' ? answer : JSON.stringify(answer) };
  });
  return got;
};

describe('a sentence on the memory page', () => {
  it('changes the entry it was typed on: summary, a rewrite, a forget, moves to an entry there is and a new one; undone whole', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    const boss = entry(rt, '王经理', '直属上司，周报和报价单抄送他', 'people', ['王经理是直属上司', '周报发给王经理', '报价单抄送王经理', '每周三下午和王经理开会']);
    const report = entry(rt, '周报', '每周五发', 'areas', ['周报每周五下午发']);
    const [a, b, c, d] = boss.items;
    const reportAt = rt.memory.entry(report.id)!.updatedAt;
    const got = answering({
      changes: [
        { action: 'summarized', summary: '直属上司' },
        { action: 'rewritten', id: a!.id, text: '王经理是我的直属上司' },
        { action: 'forgotten', id: c!.id },
        { action: 'moved', id: b!.id, entry: '周报' },
        { action: 'moved', id: d!.id, entry: '例会', summary: '周三下午开会', category: 'areas' },
      ],
      reply: '已改。',
    });
    expect(rt.memory.ask({ entry: boss.id }, '周报那条挪到周报，例会单独一个条目，报价单那条不要了')).toMatchObject({ started: true });
    const run = await done(rt);
    // what the model read: this entry with numbers, the others by name and summary, the sentence
    expect(got.prompt).toContain('The entry: 王经理 (people)');
    expect(got.prompt).toContain(`[${b!.id}] 周报发给王经理`);
    expect(got.prompt).toContain('- 周报 (areas): 每周五发');
    expect(got.prompt).not.toContain('周报每周五下午发');
    expect(got.prompt).toContain("The user's sentence: 周报那条挪到周报");
    expect(run).toMatchObject({ by: 'ask', status: 'done', refused: 0, ask: { entry: boss.id, text: '周报那条挪到周报，例会单独一个条目，报价单那条不要了', reply: '已改。' } });
    expect(run.changes.map((x) => x.action)).toEqual(['rewritten', 'forgotten']);
    expect(rt.memory.entry(boss.id)).toMatchObject({ summary: '直属上司' });
    expect(rt.memory.entry(boss.id)!.stale).toBeUndefined();
    expect(rt.memory.details(boss.id).map((m) => m.text)).toEqual(['王经理是我的直属上司']);
    // moved into an entry there was: its summary may not cover it (待整理), its time as it was
    expect(rt.memory.details(report.id).map((m) => m.text).sort()).toEqual(['周报发给王经理', '周报每周五下午发']);
    expect(rt.memory.entry(report.id)).toMatchObject({ stale: true, updatedAt: reportAt });
    const meeting = rt.memory.entries().find((e) => e.name === '例会')!;
    expect(meeting).toMatchObject({ summary: '周三下午开会', category: 'areas' });
    expect(meeting.stale).toBeUndefined();
    // not a tidy: the 整理 group does not list it
    expect(rt.memory.tidies().some((r) => r.id === run.id)).toBe(false);
    expect(rt.memory.asks()[0]!.id).toBe(run.id);
    // the whole undo: the details back where they were, the summary as it was
    rt.memory.undoTidy(run.id);
    expect(rt.memory.details(boss.id).map((m) => m.text).sort()).toEqual(['周报发给王经理', '报价单抄送王经理', '王经理是直属上司', '每周三下午和王经理开会'].sort());
    expect(rt.memory.entry(boss.id)!.summary).toBe('直属上司，周报和报价单抄送他');
    expect(rt.memory.details(report.id).map((m) => m.text)).toEqual(['周报每周五下午发']);
  });

  it('refuses what is not this entry: another entry\'s detail, a taken name, an unknown action; a rewrite that loses a number', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    const boss = entry(rt, '王经理', '直属上司，每周三开会', 'people', ['王经理是直属上司', '每周三下午 3 点开会']);
    const report = entry(rt, '周报', '每周五发', 'areas', ['周报每周五下午发']);
    answering({
      changes: [
        { action: 'forgotten', id: report.items[0]!.id },
        { action: 'renamed', name: '周报' },
        { action: 'rewritten', id: boss.items[1]!.id, text: '每周开会' },
        { action: 'shout' },
        { action: 'moved', id: boss.items[0]!.id, entry: '王经理' },
      ],
    });
    rt.memory.ask({ entry: boss.id }, '改一下');
    const run = await done(rt);
    expect(run).toMatchObject({ status: 'done', changes: [], refused: 5 });
    expect(run.ask!.reply).toBeUndefined();
    expect(rt.memory.details(report.id)).toHaveLength(1);
    expect(rt.memory.entry(boss.id)!.name).toBe('王经理');
    expect(rt.memory.entry(boss.id)!.stale).toBeUndefined();
  });

  it('a sentence the model cannot act on: its word back as it is, nothing changed; an answer that is no JSON is all word back', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    const boss = entry(rt, '王经理', '直属上司', 'people', ['王经理是直属上司']);
    answering({ changes: [], reply: '这句话和这个条目无关，没有改动。' });
    rt.memory.ask({ entry: boss.id }, '今天天气怎么样');
    expect(await done(rt)).toMatchObject({ status: 'done', changes: [], refused: 0, ask: { reply: '这句话和这个条目无关，没有改动。' } });
    expect(parseAsk('我不明白你的意思')).toEqual({ changes: [], reply: '我不明白你的意思' });
  });

  it('a note in no entry: 归进 an entry there is; the undo puts it back in none', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    const boss = entry(rt, '王经理', '直属上司', 'people', ['王经理是直属上司']);
    const note = (rt.memory.addOwn('周报发给王经理') as { item: { id: number } }).item;
    const got = answering({ changes: [{ action: 'moved', id: note.id, entry: '王经理' }], reply: '已归进王经理。' });
    rt.memory.ask({ item: note.id }, '归进王经理');
    const run = await done(rt);
    expect(got.prompt).toContain('A note in no entry yet');
    expect(rt.memory.get(note.id)!.entryId).toBe(boss.id);
    expect(rt.memory.entry(boss.id)!.stale).toBe(true);
    rt.memory.undoTidy(run.id);
    expect(rt.memory.get(note.id)!.entryId).toBeUndefined();
  });

  it('one at a time with a tidy; refused when empty, off or with no model; stopped, nothing is applied; recorded as 记忆 in the usage', async () => {
    const rt = makeRuntime(gw, { cwd: dir });
    const boss = entry(rt, '王经理', '直属上司', 'people', ['王经理是直属上司']);
    expect(rt.memory.ask({ entry: boss.id }, '  ')).toEqual({ started: false, reason: 'empty' });
    let slow = true;
    gw.onRequest(() => ({ text: JSON.stringify({ changes: [{ action: 'summarized', summary: '上司' }] }), ...(slow ? { delayMs: 300 } : {}) }));
    const first = rt.memory.ask({ entry: boss.id }, '摘要改成上司');
    expect(first).toMatchObject({ started: true });
    expect(rt.memory.ask({ entry: boss.id }, '再改')).toEqual({ started: false, reason: 'running' });
    expect(rt.memory.tidy('user')).toEqual({ started: false, reason: 'running' });
    const ended = done(rt);
    expect(rt.memory.stop((first as { id: number }).id)).toBe(true);
    slow = false;
    expect(await ended).toMatchObject({ status: 'failed' });
    expect(rt.memory.entry(boss.id)!.summary).toBe('直属上司');
    // the next one goes through, traced as the memory page's
    rt.memory.ask({ entry: boss.id }, '摘要改成上司');
    expect(await done(rt)).toMatchObject({ status: 'done' });
    expect(rt.memory.entry(boss.id)!.summary).toBe('上司');
    expect(rt.store.listTraces().some((t) => t.initiator === 'runtime:memory-ask')).toBe(true);
    rt.memory.setEnabled(false);
    expect(rt.memory.ask({ entry: boss.id }, '改')).toEqual({ started: false, reason: 'off' });
  });
});
