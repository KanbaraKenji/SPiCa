import { describe, expect, it } from 'vitest';
import type { CoreEvent, Message } from '@spica/protocol';
import { FakeBackend } from '../../../main/backend/fake';
import { buildSeed, SEED_IDS } from '../../../main/backend/fake-seed';
import { applyEvent, askAnswer, fileCardLine, filesOf, fromHistory, humanError, resultBody, type Transcript } from './transcript';

describe('fromHistory', () => {
  const seed = buildSeed(new Date('2026-11-09T10:00:00+08:00'));

  it('merges one run into a single answer with thinking, tools, cards and files', () => {
    const t = fromHistory(seed.messages[SEED_IDS.chat]!);
    expect(t.items.map((i) => i.kind)).toEqual(['user', 'response']);
    const r = t.items[1];
    if (r?.kind !== 'response') throw new Error('expected response');
    expect(r.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool', 'tool', 'tool', 'text', 'suggest']);
    const tool = r.blocks[3];
    expect(tool?.type === 'tool' && tool.result?.startsWith('需求说明 v3')).toBe(true);
    expect(filesOf(r.blocks).map((f) => f.path)).toEqual(['需求说明.docx', '测试报告.pdf']);
  });

  it('turns a pending question into an open ask card', () => {
    const t = fromHistory(seed.messages[SEED_IDS.minutes]!, seed.pending[SEED_IDS.minutes]);
    const r = t.items.at(-1);
    if (r?.kind !== 'response') throw new Error('expected response');
    const ask = r.blocks.find((b) => b.type === 'ask');
    expect(ask).toMatchObject({ question: '纪要按哪种口径写？', options: ['只写结论', '结论加讨论过程', '按议题逐条写'] });
    expect(ask?.type === 'ask' ? ask.answer : 'x').toBeUndefined();
  });
});

describe('mail handed to a project manager', () => {
  it('shows as 收到来信, not as the core’s English instructions', () => {
    const msg: Message = {
      id: 'm1',
      seq: 1,
      sessionId: 's',
      role: 'user' as const,
      kind: 'user' as const,
      content: [{ type: 'text' as const, text: 'New mail for this project.' }],
      createdAt: '2026-11-09T10:00:00+08:00',
      meta: { author: 'parent', mails: [{ id: 'src:1', sourceId: 'src', messageId: '1' }] },
    };
    expect(fromHistory([msg]).items).toEqual([{ kind: 'mail', id: 'm1', mailIds: ['src:1'] }]);
    const live = applyEvent({ items: [] }, { type: 'message', message: msg, seq: 1, at: msg.createdAt, sessionId: 's', parentChain: [] } as CoreEvent);
    expect(live.items[0]?.kind).toBe('mail');
  });
});

describe('notes from sub-agents', () => {
  it('reads ChildNoteMeta instead of the text written for the model', () => {
    const report = {
      id: 'n1',
      sessionId: 'p',
      seq: 1,
      role: 'user' as const,
      kind: 'report' as const,
      content: [{ type: 'text' as const, text: '[Report from sub-agent "写春天" (s-1)] ...' }],
      createdAt: '',
      meta: { author: 'child', kind: 'report', fromSessionId: 's-1', fromTitle: '写春天', at: '', text: '春风拂面。' },
    };
    const plain = { ...report, id: 'n2', kind: 'note' as const, meta: {}, content: [{ type: 'text' as const, text: '普通备注' }] };
    const t = fromHistory([report, plain]);
    expect(t.items).toEqual([
      { kind: 'note', id: 'n1', text: '春风拂面。', child: { kind: 'report', fromSessionId: 's-1', fromTitle: '写春天', text: '春风拂面。' } },
      { kind: 'note', id: 'n2', text: '普通备注' },
    ]);
  });
});

describe('notes the core writes for the model', () => {
  const base = { sessionId: 's', seq: 1, role: 'user' as const, kind: 'note' as const, createdAt: '' };
  it('a model switch is 已切换模型：A → B, not the English line', () => {
    const m: Message = {
      ...base,
      id: 'm1',
      content: [{ type: 'text', text: '[The user switched this conversation from deepseek-flash to deepseek-v4-pro. Carry on as before.]' }],
      meta: { author: 'runtime', decision: true, modelChange: { from: { providerId: 'p1', model: 'deepseek-flash' }, to: { providerId: 'p1', model: 'deepseek-v4-pro' } } },
    };
    expect(fromHistory([m]).items).toEqual([{ kind: 'note', id: 'm1', text: '已切换模型：deepseek-flash → deepseek-v4-pro' }]);
    // The same live, when the note arrives as a message event.
    const live = applyEvent({ items: [] }, { type: 'message', message: m } as unknown as CoreEvent);
    expect(live.items).toEqual([{ kind: 'note', id: 'm1', text: '已切换模型：deepseek-flash → deepseek-v4-pro' }]);
  });
  it('a sub-agent that wrote no report: 无报告内容, not the English placeholder', () => {
    const m: Message = {
      ...base,
      id: 'r1',
      kind: 'report',
      content: [{ type: 'text', text: '[Report from sub-agent "x" (s-2)]\n(finished without a written report)' }],
      meta: { author: 'child', kind: 'report', fromSessionId: 's-2', fromTitle: 'x', at: '', text: '(finished without a written report)' },
    };
    const item = fromHistory([m]).items[0];
    expect(item).toMatchObject({ kind: 'note', text: '无报告内容', child: { text: '无报告内容' } });
  });
  it('another note of the core is not shown as its text', () => {
    const m: Message = { ...base, id: 'x1', content: [{ type: 'text', text: '[System note] Something for the model.' }], meta: { author: 'runtime' } };
    expect(fromHistory([m]).items).toEqual([]);
  });
  it('a file that could not be read: what you typed, and the file marked failed (not the English sentence)', () => {
    const m: Message = {
      ...base,
      id: 'u2',
      kind: 'user',
      content: [
        { type: 'text', text: '看看这个' },
        { type: 'text', text: '[The user attached 坏.pdf, but it could not be read: unreadable]' },
      ],
      meta: { attachments: [{ path: 'D:/坏.pdf', name: '坏.pdf', block: null, error: 'unreadable' }] },
    };
    expect(fromHistory([m]).items[0]).toMatchObject({ kind: 'user', text: '看看这个', attachments: [{ name: '坏.pdf', failed: true }] });
  });
});

describe('tools that were turned off', () => {
  const msg = (over: Partial<Message>): Message => ({
    id: 'x',
    seq: 1,
    sessionId: 's',
    role: 'user',
    kind: 'note',
    content: [],
    createdAt: '2026-11-09T10:00:00+08:00',
    ...over,
  });

  it('says which tools are off in Chinese, and marks a call to one as not run', () => {
    const note = msg({
      id: 'n',
      content: [{ type: 'text', text: '[System note] These tools are no longer available (turned off or removed): notes__add_note, read_file.' }],
      meta: { author: 'runtime', toolsUnavailable: ['notes__add_note', 'read_file'] },
    });
    const call = msg({ id: 'a', seq: 2, role: 'assistant', kind: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'notes__add_note', input: { text: 'x' } }] });
    const result = msg({
      id: 'r',
      seq: 3,
      kind: 'tool_results',
      content: [{ type: 'tool_result', toolUseId: 'c1', isError: true, content: 'Tool "notes__add_note" is no longer available (it was turned off or removed). Nothing was run.' }],
    });
    const t = fromHistory([note, call, result]);
    expect(t.items[0]).toEqual({ kind: 'note', id: 'n', text: '工具已停用：notes__add_note、读取文件' });
    const r = t.items[1];
    expect(r?.kind === 'response' && r.blocks[0]?.type === 'tool' ? r.blocks[0].state : '').toBe('unavailable');
    // Live: the same from tool.end.
    let live: Transcript = { items: [] };
    const ev = (body: object, seq: number) => ({ ...body, seq, at: '', sessionId: 's', parentChain: [] }) as unknown as CoreEvent;
    live = applyEvent(live, ev({ type: 'tool.start', callId: 'c2', name: 'notes__add_note', input: {} }, 1));
    live = applyEvent(live, ev({ type: 'tool.end', callId: 'c2', name: 'notes__add_note', isError: true, preview: 'Tool "notes__add_note" is no longer available', durationMs: 1 }, 2));
    const lr = live.items[0];
    expect(lr?.kind === 'response' && lr.blocks[0]?.type === 'tool' ? lr.blocks[0].state : '').toBe('unavailable');
    // Waiting for sub-tasks that ran out of time is not a failure: they keep working.
    live = applyEvent(live, ev({ type: 'tool.start', callId: 'c3', name: 'wait_agents', input: {} }, 3));
    live = applyEvent(live, ev({ type: 'tool.end', callId: 'c3', name: 'wait_agents', isError: true, preview: 'Stopped waiting (timeout); some sub-agents are still working.', durationMs: 600000 }, 4));
    const wr = live.items[0];
    expect(wr?.kind === 'response' && wr.blocks[1]?.type === 'tool' ? wr.blocks[1].state : '').toBe('timeout');
  });
});

describe('attachments and automatic approval', () => {
  it('shows what you typed without the attached file text, and the files as cards', () => {
    const m: Message = {
      id: 'u',
      seq: 1,
      sessionId: 's',
      role: 'user',
      kind: 'user',
      createdAt: '',
      content: [
        { type: 'text', text: '看看这份报价' },
        { type: 'text', text: '<untrusted_data kind="file">供应商 单价 ...</untrusted_data>' },
      ],
      meta: { attachments: [{ path: 'D:/资料/报价.xlsx', name: '报价.xlsx', block: 1 }, { path: 'D:/资料/坏.pdf', name: '坏.pdf', block: null, error: 'unreadable' }] },
    };
    expect(fromHistory([m]).items[0]).toEqual({
      kind: 'user',
      id: 'u',
      text: '看看这份报价',
      steer: false,
      attachments: [
        { path: 'D:/资料/报价.xlsx', name: '报价.xlsx' },
        { path: 'D:/资料/坏.pdf', name: '坏.pdf', failed: true },
      ],
    });
  });

  it('marks a tool that ran without asking', () => {
    let t: Transcript = { items: [] };
    const ev = (body: object, seq: number) => ({ ...body, seq, at: '', sessionId: 's', parentChain: [] }) as unknown as CoreEvent;
    t = applyEvent(t, ev({ type: 'tool.start', callId: 'd1', name: 'delete_note', input: {} }, 1));
    t = applyEvent(t, ev({ type: 'confirm.auto', callId: 'd1', name: 'delete_note', input: {} }, 2));
    const r = t.items[0];
    expect(r?.kind === 'response' && r.blocks[0]?.type === 'tool' ? r.blocks[0].autoApproved : false).toBe(true);
  });
});

describe('file cards', () => {
  const seed = buildSeed(new Date('2026-11-09T10:00:00+08:00'));

  it('uses the core file details when there are some, and the path argument otherwise', () => {
    const t = fromHistory(seed.messages[SEED_IDS.chat]!);
    const r = t.items[1];
    if (r?.kind !== 'response') throw new Error('expected response');
    const files = filesOf(r.blocks, t.fileCards);
    expect(files.map((f) => f.card?.name)).toEqual(['需求说明.docx', '测试报告.pdf']);
    expect(files[1]?.path).toBe('D:\\工作\\样机评审\\测试报告.pdf');
    expect(filesOf(r.blocks).map((f) => f.path)).toEqual(['需求说明.docx', '测试报告.pdf']);
  });

  it('says what was read in one line', () => {
    const at = '2026-11-09T10:00:00+08:00';
    const base = { path: 'D:\\a', name: 'a', sizeBytes: 1, modifiedAt: at, extractedAt: at };
    expect(fileCardLine({ ...base, kind: 'pdf', pageCount: 30, read: { pages: '1-5' }, truncated: true })).toBe('PDF · 30 页 · 已读取第 1-5 页 · 未读完');
    expect(fileCardLine({ ...base, kind: 'pdf', pageCount: 3, read: { pages: '1-3' } })).toBe('PDF · 3 页 · 已全部读取');
    expect(fileCardLine({ ...base, kind: 'xlsx', sheets: [{ name: 'A', rows: 1, cols: 1 }, { name: 'B', rows: 1, cols: 1 }], read: { sheet: 'A, B' } })).toBe('Excel · 2 个表 · 已全部读取');
    expect(fileCardLine({ ...base, kind: 'xlsx', sheets: [{ name: '报价', rows: 3, cols: 2 }], read: { sheet: '报价', rows: '1-3' } })).toBe('Excel · 1 个表 · 已读取「报价」第 1-3 行');
    expect(fileCardLine({ ...base, kind: 'pdf', pageCount: 2, read: {}, noTextLayer: true })).toBe('PDF · 2 页 · 扫描件，无法读取文字');
  });

  it('keeps file details that arrive as events', () => {
    const at = '2026-11-09T10:00:00+08:00';
    const file = { path: 'D:\\b.txt', name: 'b.txt', kind: 'text' as const, sizeBytes: 3, modifiedAt: at, extractedAt: at, read: { rows: '1-3' } };
    const t = applyEvent({ items: [] }, { seq: 1, at, sessionId: 's', parentChain: [], type: 'file.card', callId: 'c1', file });
    expect(t.fileCards).toEqual({ c1: file });
  });
});

describe('resultBody', () => {
  it('drops the fetch-time line', () => {
    expect(resultBody('2026-11-09T10:00:00.000+08:00\nhello')).toBe('hello');
    expect(resultBody('plain')).toBe('plain');
    expect(resultBody('[fetched at 2026-11-09T15:58:17.755+08:00]\nbody')).toBe('body');
  });
  it('pulls the answer out of an ask_user result', () => {
    expect(askAnswer('[fetched at 2026-11-09T15:58:17.755+08:00]\nUser answered: 只写结论')).toBe('只写结论');
  });
});

describe('humanError', () => {
  it('says common failures in plain words', () => {
    expect(humanError('HTTP 401 Unauthorized')).toContain('密钥');
    expect(humanError('429 Too Many Requests')).toContain('限流');
    expect(humanError('TypeError: fetch failed')).toContain('无法连接');
    expect(humanError('something odd')).toBe('出错：something odd');
  });
});

describe('applyEvent', () => {
  it('ends with the same view as the stored history (no jump when the run ends)', async () => {
    const b = new FakeBackend({ speed: 0, seed: false });
    const chat = await b.createSession({});
    let live: Transcript = { items: [] };
    const done = new Promise<void>((resolve) =>
      b.onEvent((e: CoreEvent) => {
        live = applyEvent(live, e, 1000);
        if (e.type === 'run.end') resolve();
      }),
    );
    await b.send(chat.id, '看看资料');
    await done;
    const stored = fromHistory(await b.getMessages(chat.id));
    const strip = (t: Transcript) =>
      t.items.map((i) =>
        i.kind === 'response'
          ? { kind: i.kind, blocks: i.blocks.map((x) => (x.type === 'tool' ? { type: 'tool', name: x.name, state: x.state } : x)) }
          : { kind: i.kind },
      );
    expect(strip(live)).toEqual(strip(stored));
    expect(live.run).toBeUndefined();
    expect(live.lastRun?.reason).toBe('idle');
  });

  it('drops a queued message once the agent takes it in', () => {
    const base = { seq: 1, at: '', sessionId: 's', parentChain: [] };
    const t0: Transcript = { items: [], queued: [{ id: 'm9', text: '改成两点' }] };
    const message = { id: 'm9', sessionId: 's', seq: 3, role: 'user' as const, kind: 'steer' as const, content: [{ type: 'text' as const, text: '改成两点' }], createdAt: '' };
    const t1 = applyEvent(t0, { ...base, type: 'message', message });
    expect(t1.queued).toEqual([]);
    expect(t1.items).toEqual([{ kind: 'user', id: 'm9', text: '改成两点', steer: true }]);
  });

  it('tracks the run for the status line', () => {
    const base = { seq: 1, at: '', sessionId: 's', parentChain: [] };
    let t: Transcript = { items: [] };
    t = applyEvent(t, { ...base, type: 'status', status: 'queued' }, 100);
    t = applyEvent(t, { ...base, seq: 2, type: 'queue', position: 3, waitingFor: 'model' }, 150);
    expect(t.run).toMatchObject({ startedAt: 100, status: 'queued', queuePosition: 3 });
    t = applyEvent(t, { ...base, seq: 3, type: 'status', status: 'thinking' }, 200);
    expect(t.run?.startedAt).toBe(100);
    t = applyEvent(t, { ...base, seq: 4, type: 'status', status: 'idle' }, 1100);
    expect(t.run).toBeUndefined();
    expect(t.lastRun).toMatchObject({ durationMs: 1000 });
  });
});

describe('model errors', () => {
  const at = '2026-11-10T10:00:00Z';
  it('says the core’s own words when main added them for a known code (WSO2 fault)', () => {
    const hint = '这个应用还没订阅这个接口（WSO2 900908）：去 WSO2 开发者门户给应用订阅这个 API，或找管理员。';
    const t = applyEvent({ items: [] }, { type: 'error', message: 'HTTP 403', code: 'wso2.not_subscribed', hint, seq: 1, at, sessionId: 's', parentChain: [] } as CoreEvent);
    expect(t.error).toBe(hint);
  });

  it('falls back to its own plain words otherwise', () => {
    const t = applyEvent({ items: [] }, { type: 'error', message: 'HTTP 401 unauthorized', seq: 1, at, sessionId: 's', parentChain: [] } as CoreEvent);
    expect(t.error).toBe('模型密钥无效或已失效，请检查模型设置。');
  });
});
