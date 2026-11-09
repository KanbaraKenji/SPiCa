// Mail pipeline: poll → triage → route → feedback, with a fake mail plugin and a scripted model.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseToolJson } from './mail.ts';
import type { FakeGateway, ReceivedRequest, ScriptedReply } from './testing/fake-gateway.ts';
import { makeRuntime, startGateway, tempDir } from './testing/helpers.ts';
import type { Tool } from './tools/types.ts';
import type { CoreEvent } from './types.ts';

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

type Mail = { id: string; from_name: string; from_address: string; subject: string; received: string; preview: string };
const inbox: Mail[] = [];
const mail = (id: string, from: string, subject: string): Mail => ({ id, from_name: from.split('@')[0]!, from_address: from, subject, received: '2026-11-09T09:00:00+08:00', preview: `${subject} …` });

function mailTools(): Tool[] {
  return [
    {
      spec: { name: 'mailbox__list_messages', description: 'list', inputSchema: { type: 'object' } },
      execute: async () => ({ content: `[sample data — mock mode]\n${JSON.stringify({ messages: inbox, total: inbox.length }, null, 1)}` }),
    },
    {
      spec: { name: 'mailbox__read_message', description: 'read', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
      execute: async (i) => ({ content: JSON.stringify({ id: i.id, body: 'full text' }) }),
    },
  ];
}

/** The fake triage agent: website mail → website project, move mail → office project, newsletters ignored, the rest new. */
function triageModel(opts: { badFirst?: boolean; omitFirst?: boolean } = {}) {
  let firstTriage = true;
  return (r: ReceivedRequest): ScriptedReply => {
    const msgs = r.body.messages as { role: string; content: string }[];
    const sys = msgs[0]?.content ?? '';
    const last = msgs.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    const lastMsg = msgs.at(-1);
    if (!sys.includes('You sort the user')) return { text: 'ok' };
    if (lastMsg?.role === 'tool' && !String(lastMsg.content).includes('were not recorded')) return { text: 'ok' };
    const projects = [...last.matchAll(/- (prj_\w+): (.+?)(?: \(stage|\n|$)/g)].map((m) => ({ id: m[1]!, name: m[2]! }));
    const proj = (word: string) => projects.find((p) => p.name.toLowerCase().includes(word))?.id;
    const blocks = last.split('- mail_id: ').slice(1);
    const results = blocks.map((b) => {
      const mailId = b.split('\n')[0]!.trim();
      const subject = /subject: (.+)/.exec(b)?.[1] ?? '';
      if (/newsletter/i.test(subject)) return { mail_id: mailId, decision: 'ignore', reason: 'newsletter', confidence: 0.9 };
      if (/website|homepage/i.test(subject)) return { mail_id: mailId, decision: 'project', project_id: opts.badFirst && firstTriage ? 'prj_nope' : proj('website'), reason: 'about the website', confidence: 0.8 };
      if (/office|move/i.test(subject)) return { mail_id: mailId, decision: 'project', project_id: proj('office'), reason: 'about the move', confidence: 0.8 };
      return { mail_id: mailId, decision: 'new', suggestion: 'Open house event', reason: 'nothing matches', confidence: 0.6 };
    });
    if (opts.omitFirst && firstTriage) results.pop(); // forget one mail the first time
    firstTriage = false;
    return { toolCalls: [{ id: `t${Math.random().toString(36).slice(2, 8)}`, name: 'triage_mail', args: { results } }] };
  };
}

function setup(opts: { badFirst?: boolean; omitFirst?: boolean } = {}) {
  inbox.length = 0;
  inbox.push(
    mail('m1', 'ana@web.example', 'Website homepage draft v2'),
    mail('m2', 'bo@move.example', 'Office move: floor plan'),
    mail('m3', 'news@weekly.example', 'Design newsletter #212'),
    mail('m4', 'cy@event.example', 'Open house catering'),
    mail('m5', 'ana@web.example', 'Website copy for the About page'),
  );
  gw.onRequest(triageModel(opts));
  const rt = makeRuntime(gw, {
    cwd: dir,
    projectsRoot: dir,
    tools: undefined,
    mail: { sources: [{ id: 'mailbox', listTool: 'mailbox__list_messages', readTool: 'mailbox__read_message' }] },
  });
  for (const t of mailTools()) rt.tools.register(t, 'plugin:mailbox');
  const web = rt.createProject({ name: 'Website refresh' });
  const office = rt.createProject({ name: 'Office move' });
  const events: CoreEvent[] = [];
  rt.events.on((e) => events.push(e));
  return { rt, web, office, events };
}

describe('mail pipeline', () => {
  it('polls, triages into projects, routes to the right managers, and does not repeat itself', async () => {
    const { rt, web, office, events } = setup();
    const r = await rt.mail.poll();
    expect(r).toMatchObject({ fetched: 5, added: 5, triaged: 5, routed: 3 });
    const items = rt.store.listMail();
    const byMsg = Object.fromEntries(items.map((i) => [i.messageId, i]));
    expect(byMsg.m1).toMatchObject({ status: 'routed', triage: { decision: 'project', projectId: web.id, by: 'model' }, routedTo: web.managerSessionId });
    expect(byMsg.m2).toMatchObject({ status: 'routed', routedTo: office.managerSessionId });
    expect(byMsg.m3).toMatchObject({ status: 'ignored', triage: { decision: 'ignore' } });
    expect(byMsg.m4).toMatchObject({ status: 'triaged', triage: { decision: 'new', suggestion: 'Open house event' } });

    // the managers got the mail with structured meta and the never-send instruction
    const pmFirst = rt.session(web.managerSessionId)!.messages()[0]!;
    // one message per manager listing all its new mail
    expect(pmFirst.meta).toMatchObject({ author: 'parent', mails: [{ id: 'mailbox:m1', messageId: 'm1', sourceId: 'mailbox' }, { id: 'mailbox:m5' }] });
    expect(JSON.stringify(pmFirst.content)).toContain('2 new mails for this project');
    expect(JSON.stringify(pmFirst.content)).toContain('never send mail');
    expect(JSON.stringify(pmFirst.content)).toContain('mailbox__read_message');
    await rt.session(web.managerSessionId)!.settled();
    expect(rt.getProject(web.id)!.recentLog.some((e) => e.action === 'note' && e.target === 'Website homepage draft v2')).toBe(true);

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'mail.triaged')).toHaveLength(5);
    expect(types.filter((t) => t === 'mail.routed')).toHaveLength(3);
    expect(events.find((e) => e.type === 'mail.polled')).toMatchObject({ sourceId: 'mailbox', fetched: 5, added: 5 });

    // the same inbox again: nothing new, nothing re-triaged
    const before = gw.requests.length;
    expect(await rt.mail.poll()).toMatchObject({ fetched: 5, added: 0, routed: 0 });
    expect(gw.requests.length).toBe(before);
  });

  it('the triage tool rejects unknown projects and the agent can correct itself', async () => {
    const { rt, web } = setup({ badFirst: true });
    await rt.mail.poll();
    const m1 = rt.store.getMail('mailbox:m1')!;
    // first answer had a bad project id; the tool said so; the second answer was recorded
    expect(m1).toMatchObject({ status: 'routed', triage: { projectId: web.id } });
    const thread = rt.mail.thread();
    expect(JSON.stringify(thread.messages())).toContain('is not one of the listed projects');
    expect(thread.info().templateId).toBe('mail-triage');
  });

  it('a mail left out of the answer is pointed out and then recorded', async () => {
    const { rt } = setup({ omitFirst: true });
    const r = await rt.mail.poll();
    expect(r.triaged).toBe(5);
    expect(rt.store.listMail({ status: 'new' })).toEqual([]);
    expect(JSON.stringify(rt.mail.thread().messages())).toContain('no result yet for: mailbox:m5');
  });

  it('the user accepting or reassigning teaches the sender memory', async () => {
    const { rt, web, office, events } = setup();
    await rt.mail.poll();
    // reassign Ana's website mail to the office move: she is now an office-move sender
    const re = rt.mail.feedback('mailbox:m1', { action: 'reassign', projectId: office.id });
    expect(re).toMatchObject({ status: 'routed', routedTo: office.managerSessionId, triage: { projectId: office.id }, feedback: { action: 'reassign' } });
    expect(rt.store.getSenderDecision('ANA@web.example')).toEqual({ decision: 'project', projectId: office.id });
    expect(events.some((e) => e.type === 'mail.feedback')).toBe(true);
    rt.mail.feedback('mailbox:m2', { action: 'accept' });
    expect(rt.store.getSenderDecision('bo@move.example')).toEqual({ decision: 'project', projectId: office.id });
    rt.mail.feedback('mailbox:m4', { action: 'ignore' });
    expect(rt.store.getMail('mailbox:m4')!.status).toBe('ignored');
    expect(rt.store.getSenderDecision('cy@event.example')).toEqual({ decision: 'ignore' });
    expect(() => rt.mail.feedback('mailbox:m3', { action: 'reassign' })).toThrow(/needs an existing projectId/);

    // a new mail from Ana goes straight to the office move, without asking the model
    inbox.push(mail('m6', 'ana@web.example', 'Website: one more thing'));
    const before = gw.requests.filter((q) => JSON.stringify(q.body.messages).includes('You sort the user')).length;
    const r = await rt.mail.poll();
    expect(r).toMatchObject({ added: 1, routed: 1 });
    expect(rt.store.getMail('mailbox:m6')).toMatchObject({ triage: { by: 'sender_memory', projectId: office.id, confidence: 1 }, routedTo: office.managerSessionId });
    expect(gw.requests.filter((q) => JSON.stringify(q.body.messages).includes('You sort the user')).length).toBe(before);
    expect(web.id).not.toBe(office.id);
  });

  it('ignore rules and ignored senders skip the model; a source added later is picked up', async () => {
    inbox.length = 0;
    inbox.push(mail('a1', 'noreply@ci.example', 'Build 812 passed'), mail('a2', 'x@promo.example', 'WEEKLY DEALS inside'), mail('a3', 'ana@web.example', 'Website homepage draft v3'));
    gw.onRequest(triageModel());
    const rt = makeRuntime(gw, { cwd: dir, projectsRoot: dir, mail: { ignore: { from: ['noreply@'], subject: ['/weekly\\s+deals/'] } } });
    rt.createProject({ name: 'Website refresh' });
    expect(rt.mail.activeSources).toEqual([]);
    // a plugin registers itself as a mail source after start-up
    for (const t of mailTools()) rt.tools.register(t, 'plugin:mailbox');
    const remove = rt.mail.addSource({ id: 'mailbox', listTool: 'mailbox__list_messages', readTool: 'mailbox__read_message' });
    await rt.mail.poll();
    expect(rt.store.getMail('mailbox:a1')!.triage).toMatchObject({ decision: 'ignore', by: 'rule', reason: 'matches the ignore rule noreply@' });
    expect(rt.store.getMail('mailbox:a2')!.triage).toMatchObject({ decision: 'ignore', by: 'rule' });
    expect(rt.store.getMail('mailbox:a3')!.triage).toMatchObject({ decision: 'project', by: 'model' });
    expect(rt.mail.thread().config.tools).toContain('mailbox__read_message');
    // the user ignores a sender once; the next mail from them is ignored without the model
    rt.mail.feedback('mailbox:a3', { action: 'ignore' });
    inbox.push(mail('a4', 'ana@web.example', 'Website: yet another thing'));
    const asked = gw.requests.length;
    await rt.mail.poll();
    expect(rt.store.getMail('mailbox:a4')!.triage).toMatchObject({ decision: 'ignore', by: 'sender_memory' });
    expect(gw.requests.length).toBe(asked);
    remove();
    expect(rt.mail.activeSources).toEqual([]);
  });

  it('the triage role template can be replaced by the deployment', async () => {
    const rt = makeRuntime(gw, { cwd: dir, templates: [{ id: 'mail-triage', name: 'Sorter', role: 'top', system: 'CUSTOM SORTER RULES' }] });
    expect(rt.mail.thread().config.system).toBe('CUSTOM SORTER RULES');
    const other = makeRuntime(gw, { cwd: dir, templates: [{ id: 'my-sorter', name: 'Mine', role: 'top', system: 'MINE' }], mail: { triageTemplateId: 'my-sorter' } });
    expect(other.mail.thread().config.system).toBe('MINE');
  });

  it('without a mail plugin nothing runs; start() respects enabled:false', async () => {
    const rt = makeRuntime(gw, { cwd: dir, mail: { enabled: false, sources: [{ id: 'x', listTool: 'missing__list', readTool: 'missing__read' }] } });
    expect(rt.mail.activeSources).toEqual([]);
    expect(await rt.mail.poll()).toEqual({ fetched: 0, added: 0, triaged: 0, routed: 0 });
    expect(rt.mail.start()).toBe(false);
    expect(gw.requests).toHaveLength(0);
  });

  it('parseToolJson skips hint lines before the JSON', () => {
    expect(parseToolJson('[sample data — mock mode]\n[fetched at 2026]\n{ "a": 1 }')).toEqual({ a: 1 });
    expect(parseToolJson('[{"x":1}]')).toEqual([{ x: 1 }]);
  });
});
