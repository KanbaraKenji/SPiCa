import { describe, expect, it } from 'vitest';
import type { CoreEvent, HistoryCardMeta, Message } from '@spica/protocol';
import { FakeBackend } from '../../../main/backend/fake';
import { buildSeed, SEED_IDS } from '../../../main/backend/fake-seed';
import { changesAfter } from './relocate';
import { applyEvent, askAnswer, cancelCard, cwdNoteText, fileCardLine, filesOf, fromHistory, historyRef, humanError, itemAtSeq, resultBody, type Transcript } from './transcript';

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

describe('pictures sent with a message', () => {
  it('come back from the record as thumbnails (the core’s copy); a refused one with its reason', () => {
    const m: Message = {
      id: 'u3', seq: 1, sessionId: 's', role: 'user', kind: 'user', createdAt: '',
      content: [{ type: 'text', text: '图里写了什么？' }, { type: 'image', path: 'D:/media/s/1.png', mediaType: 'image/png', width: 800, height: 600, bytes: 1000 }],
      meta: {
        attachments: [
          { path: 'C:/tmp/a.png', name: 'a.png', block: 1, image: { path: 'D:/media/s/1.png', mediaType: 'image/png', width: 800, height: 600, bytes: 1000, resized: false } },
          { path: 'C:/tmp/big.jpg', name: 'big.jpg', block: null, code: 'image.too_large' },
        ],
      },
    };
    expect(fromHistory([m]).items[0]).toMatchObject({
      kind: 'user',
      text: '图里写了什么？',
      attachments: [
        { name: 'a.png', image: { path: 'D:/media/s/1.png', width: 800, height: 600 } },
        { name: 'big.jpg', code: 'image.too_large' },
      ],
    });
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
    expect(fileCardLine({ ...base, kind: 'pdf', pageCount: 30, read: { pages: '1-5' }, truncated: true })).toBe('PDF · 30 页 · Read pages 1-5 · Partly read');
    expect(fileCardLine({ ...base, kind: 'pdf', pageCount: 3, read: { pages: '1-3' } })).toBe('PDF · 3 页 · Read');
    expect(fileCardLine({ ...base, kind: 'xlsx', sheets: [{ name: 'A', rows: 1, cols: 1 }, { name: 'B', rows: 1, cols: 1 }], read: { sheet: 'A, B' } })).toBe('Excel · 2 个表 · Read');
    expect(fileCardLine({ ...base, kind: 'xlsx', sheets: [{ name: '报价', rows: 3, cols: 2 }], read: { sheet: '报价', rows: '1-3' } })).toBe('Excel · 1 个表 · Read 「报价」 rows 1-3');
    expect(fileCardLine({ ...base, kind: 'pdf', pageCount: 2, read: {}, noTextLayer: true })).toBe('PDF · 2 页 · 扫描件，无法读取文字');
    expect(fileCardLine({ ...base, kind: 'pdf', pageCount: 30, read: { pages: '7' } })).toBe('PDF · 30 页 · Read page 7');
    expect(fileCardLine({ ...base, kind: 'text', read: { rows: '1-80' } })).toBe('文本 · Read rows 1-80');
  });

  it('keeps file details that arrive as events', () => {
    const at = '2026-11-09T10:00:00+08:00';
    const file = { path: 'D:\\b.txt', name: 'b.txt', kind: 'text' as const, sizeBytes: 3, modifiedAt: at, extractedAt: at, read: { rows: '1-3' } };
    const t = applyEvent({ items: [] }, { seq: 1, at, sessionId: 's', parentChain: [], type: 'file.card', callId: 'c1', file });
    expect(t.fileCards).toEqual({ c1: file });
  });
});

describe('history: what the history tools found, and where each message starts', () => {
  const at = '2026-11-09T10:00:00+08:00';
  const card = (ref: number, sessionId: string, seq?: number): HistoryCardMeta => ({
    tool: 'search_history',
    total: 1,
    rows: [{ ref, sessionId, name: '看一下报价单', at, ...(seq !== undefined ? { seq } : {}), text: '合计 12,800 元' }],
  });
  const msg = (seq: number, over: Partial<Message>): Message => ({ id: `m${seq}`, sessionId: 's', seq, role: 'user', kind: 'user', content: [{ type: 'text', text: '' }], createdAt: at, ...over }) as Message;

  it('keeps the cards stored with the results, numbers each item by its first message, and finds a place by number', () => {
    const t = fromHistory([
      msg(1, { content: [{ type: 'text', text: '以前问过的报价单' }] }),
      msg(2, { role: 'assistant', kind: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'search_history', input: { query: '报价' } }] }),
      msg(3, { kind: 'tool_results', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'found' }], meta: { historyCards: { c1: card(1, 'ses_old', 6) } } }),
      msg(4, { role: 'assistant', kind: 'assistant', content: [{ type: 'text', text: '在[看一下报价单](history:1)里说过' }] }),
      msg(5, { content: [{ type: 'text', text: '谢谢' }] }),
    ]);
    expect(t.historyCards?.c1?.rows[0]?.sessionId).toBe('ses_old');
    expect(t.items.map((i) => [i.kind, t.seqs?.[i.id]])).toEqual([
      ['user', 1],
      ['response', 2],
      ['user', 5],
    ]);
    expect(itemAtSeq(t, 3)).toBe(t.items[1]?.id);
    expect(itemAtSeq(t, 5)).toBe(t.items[2]?.id);
    expect(historyRef(t, 1)).toEqual({ sessionId: 'ses_old', seq: 6 });
    expect(historyRef(t, 2)).toBeUndefined();
  });

  it('read_history: one number for the whole conversation, so its link opens it without scrolling', () => {
    const read: HistoryCardMeta = { tool: 'read_history', total: 2, rows: [1, 2].map((seq) => ({ ref: 5, sessionId: 'ses_r', name: '报价', at, seq, who: 'user' as const, text: '…' })) };
    expect(historyRef({ items: [], historyCards: { c9: read } }, 5)).toEqual({ sessionId: 'ses_r' });
  });

  it('keeps a card that arrives as an event', () => {
    const t = applyEvent({ items: [] }, { seq: 1, at, sessionId: 's', parentChain: [], type: 'history.card', callId: 'c2', card: card(3, 'ses_b') });
    expect(historyRef(t, 3)).toEqual({ sessionId: 'ses_b' });
  });
});

describe('resultBody', () => {
  it('shows outside content without the fence written for the model', () => {
    expect(resultBody('<untrusted_data kind="history" source="search_history">\n1 piece found:\n- a\n</untrusted_data>')).toBe('1 piece found:\n- a');
  });
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

  // The core's retries and its final error both say retryable (the kind of error); the run's end tells them apart.
  const base = { at, sessionId: 's', parentChain: [] };
  const retry = (seq: number) => ({ ...base, seq, type: 'error', message: 'retrying model call (ProviderError: token endpoint unreachable [wso2.token_unreachable / net.refused])', retryable: true }) as CoreEvent;
  const unreachable = (seq: number) =>
    ({ ...base, seq, type: 'error', message: 'request failed [wso2.token_unreachable] (ProviderError: token endpoint unreachable)', retryable: true, code: 'wso2.token_unreachable', hint: '无法连接取 token 地址。' }) as CoreEvent;
  const status = (seq: number, s: 'thinking' | 'idle' | 'error') => ({ ...base, seq, type: 'status', status: s }) as CoreEvent;
  const end = (seq: number, reason: 'completed' | 'error' | 'aborted', detail?: string) => ({ ...base, seq, type: 'run.end', reason, ...(detail ? { detail } : {}) }) as CoreEvent;
  const play = (events: CoreEvent[]) => events.reduce<Transcript>((t, e) => applyEvent(t, e, 1000), { items: [] });

  it('shows the last error in the core’s words when the run ends in it, retryable or not', () => {
    const t = play([status(1, 'thinking'), retry(2), retry(3), unreachable(4), status(5, 'error'), end(6, 'error', 'request failed [wso2.token_unreachable]')]);
    expect(t.error).toBe('无法连接取 token 地址。');
    expect(t.lastFailure).toBeUndefined();
  });

  it('leaves nothing when a retry then succeeds', () => {
    const t = play([status(1, 'thinking'), retry(2), status(3, 'idle'), end(4, 'completed')]);
    expect(t.error).toBeUndefined();
    expect(t.lastFailure).toBeUndefined();
  });

  it('leaves nothing when the user stops the run during retries', () => {
    const t = play([status(1, 'thinking'), retry(2), status(3, 'idle'), end(4, 'aborted')]);
    expect(t.error).toBeUndefined();
  });

  it('does not carry an old failure into the next run', () => {
    let t = play([status(1, 'thinking'), unreachable(2), status(3, 'error'), end(4, 'error')]);
    expect(t.error).toBe('无法连接取 token 地址。');
    t = [status(5, 'thinking'), retry(6), status(7, 'idle'), end(8, 'completed')].reduce((x, e) => applyEvent(x, e, 1000), t);
    expect(t.error).toBeUndefined();
  });

  it('a run that ends in an error without an error event says what the core said', () => {
    const t = play([status(1, 'thinking'), status(2, 'error'), end(3, 'error', 'model stream ended without a response')]);
    expect(t.error).toBe('出错：model stream ended without a response');
  });

  it('keeps an error already shown (a non-retryable one) at the end of the run', () => {
    const t = play([status(1, 'thinking'), { ...base, seq: 2, type: 'error', message: 'HTTP 401 unauthorized' } as CoreEvent, end(3, 'error', 'HTTP 401')]);
    expect(t.error).toBe('模型密钥无效或已失效，请检查模型设置。');
  });
});

describe('the working folder chosen later', () => {
  it('a note line: where, how many files moved, which got another name', () => {
    expect(cwdNoteText({ from: 'C:/data/ses_1', to: 'D:/资料/报价', moved: [], renamed: [] })).toBe('工作文件夹已选为 D:/资料/报价');
    expect(
      cwdNoteText({
        from: 'C:/data/ses_1',
        to: 'D:/资料/报价',
        moved: [
          { from: '报价.xlsx', to: '报价.xlsx' },
          { from: 'a.txt', to: 'a (1).txt' },
        ],
        renamed: [{ from: 'a.txt', to: 'a (1).txt' }],
      }),
    ).toBe('工作文件夹已选为 D:/资料/报价，移入 2 个文件，其中 1 个改了名：a.txt → a (1).txt');
  });

  it('a conversation from 0.1.0-rc.2: its files stay where they were, said instead of a count', () => {
    const shared = 'C:\\Users\\me\\Documents\\Spica';
    expect(cwdNoteText({ from: shared, to: 'D:\\资料\\报价', moved: [], renamed: [], filesStayIn: shared })).toBe(`工作文件夹已选为 D:\\资料\\报价，原来的文件留在 ${shared}`);
  });

  it('file cards of answers before the note open where the files went; after it, as written', () => {
    const files = 'C:\\Users\\me\\AppData\\Roaming\\Spica\\sessions\\ses_1\\files';
    const change = { from: files, to: 'D:\\资料\\报价', moved: [{ from: '报价.md', to: '报价 (1).md' }], renamed: [{ from: '报价.md', to: '报价 (1).md' }] };
    const msg = (seq: number, role: 'user' | 'assistant', kind: string, content: unknown[], meta?: unknown) => ({ id: `m${seq}`, sessionId: 's', seq, role, kind, content, createdAt: `2026-11-10T10:00:0${seq}Z`, ...(meta ? { meta } : {}) });
    const t = fromHistory([
      msg(1, 'user', 'user', [{ type: 'text', text: '写文件' }]),
      msg(2, 'assistant', 'assistant', [{ type: 'tool_use', id: 'w1', name: 'write_file', input: { path: '报价.md', content: 'x' } }]),
      msg(3, 'user', 'tool_results', [{ type: 'tool_result', toolUseId: 'w1', content: 'ok' }]),
      msg(4, 'user', 'note', [{ type: 'text', text: '[chosen]' }], { author: 'runtime', cwdChange: change }),
      msg(5, 'user', 'user', [{ type: 'text', text: '再写一个' }]),
      msg(6, 'assistant', 'assistant', [{ type: 'tool_use', id: 'w2', name: 'write_file', input: { path: '报价.md', content: 'y' } }]),
      msg(7, 'user', 'tool_results', [{ type: 'tool_result', toolUseId: 'w2', content: 'ok' }]),
    ] as unknown as Message[]);
    const note = t.items.find((i) => i.kind === 'note');
    expect(note).toMatchObject({ cwd: change });
    const moves = changesAfter(t.items);
    const answers = t.items.filter((i): i is Extract<typeof i, { kind: 'response' }> => i.kind === 'response');
    expect(answers).toHaveLength(2);
    // Opened at the new name; shown as files in the conversation's folder are (no folder).
    expect(filesOf(answers[0]!.blocks, {}, moves.get(answers[0]!.id))).toEqual([{ path: 'D:\\资料\\报价\\报价 (1).md', shown: '报价 (1).md', tool: 'write_file' }]);
    // Written after the folder was chosen: 报价.md in the new folder is that one.
    expect(filesOf(answers[1]!.blocks, {}, moves.get(answers[1]!.id)).map((f) => f.path)).toEqual(['报价.md']);
  });
});

describe('a question or confirmation stopped while it waits', () => {
  const ev = (seq: number, body: Record<string, unknown>) => ({ sessionId: 's', parentChain: [], seq, at: '', ...body }) as unknown as CoreEvent;
  const asked = (): Transcript => {
    let t: Transcript = { items: [] };
    t = applyEvent(t, ev(1, { type: 'ask.request', callId: 'q1', question: '确认这次申请的四项？', options: ['是', '不是'] }));
    t = applyEvent(t, ev(2, { type: 'confirm.request', callId: 'm1', name: 'send_email', input: {}, reason: '发送邮件' }));
    return t;
  };
  const cards = (t: Transcript) => t.items.flatMap((i) => (i.kind === 'response' ? i.blocks : [])).filter((b) => b.type === 'ask' || b.type === 'confirm');

  it('the core’s way: status aborted and a cancelled result, no ask.resolved: both cards are cancelled, the answer interrupted', () => {
    let t = asked();
    t = applyEvent(t, ev(3, { type: 'status', status: 'aborted' }));
    t = applyEvent(t, ev(4, { type: 'message', message: { id: 'r', sessionId: 's', seq: 3, role: 'user', kind: 'tool_results', createdAt: '', content: [
      { type: 'tool_result', toolUseId: 'q1', content: '[fetched at 2026-11-12T00:00:00Z]\nCancelled: aborted by user.', isError: true },
      { type: 'tool_result', toolUseId: 'm1', content: '[fetched at 2026-11-12T00:00:00Z]\nCancelled: aborted by user.', isError: true },
    ] } }));
    expect(cards(t).map((b) => [b.callId, (b as { cancelled?: boolean }).cancelled])).toEqual([['q1', true], ['m1', true]]);
    expect((cards(t)[0] as { answer?: string }).answer).toBeUndefined();
    expect(t.items.at(-1)).toMatchObject({ kind: 'response', interrupted: true });
  });

  it('the cancelled result alone (no status first) does the same', () => {
    const t = applyEvent(asked(), ev(3, { type: 'message', message: { id: 'r', sessionId: 's', seq: 3, role: 'user', kind: 'tool_results', createdAt: '', content: [{ type: 'tool_result', toolUseId: 'q1', content: 'Cancelled: aborted by user.', isError: true }] } }));
    expect(cards(t)[0]).toMatchObject({ callId: 'q1', cancelled: true });
  });

  it('answered or decided cards stay as they are when the run is stopped later', () => {
    let t = asked();
    t = applyEvent(t, ev(3, { type: 'ask.resolved', callId: 'q1', answer: '是' }));
    t = applyEvent(t, ev(4, { type: 'confirm.resolved', callId: 'm1', approved: false }));
    t = applyEvent(t, ev(5, { type: 'status', status: 'aborted' }));
    expect(cards(t)).toMatchObject([{ answer: '是' }, { approved: false }]);
    expect(cards(t).some((b) => (b as { cancelled?: boolean }).cancelled)).toBe(false);
  });

  it('reopened later: a stopped question is cancelled (not an answer that reads Cancelled …); one still waited on stays open', () => {
    const at = '2026-11-12T00:00:00Z';
    const ask = (id: string, seq: number): Message => ({ id: `a${id}`, sessionId: 's', seq, role: 'assistant', kind: 'assistant', createdAt: at, content: [{ type: 'tool_use', id, name: 'ask_user', input: { question: '哪一种？', options: ['A'] } }] });
    const history: Message[] = [
      ask('q1', 1),
      { id: 'r1', sessionId: 's', seq: 2, role: 'user', kind: 'tool_results', createdAt: at, content: [{ type: 'tool_result', toolUseId: 'q1', content: 'Cancelled: aborted by user.', isError: true }] },
      ask('q2', 3),
      { id: 'r2', sessionId: 's', seq: 4, role: 'user', kind: 'tool_results', createdAt: at, content: [{ type: 'tool_result', toolUseId: 'q2', content: 'User answered: A' }] },
      ask('q3', 5),
      ask('q4', 6),
    ];
    const t = fromHistory(history, [{ kind: 'ask', callId: 'q4', question: '哪一种？', options: ['A'], createdAt: at }]);
    expect(cards(t).map((b) => [b.callId, (b as { answer?: string }).answer ?? null, (b as { cancelled?: boolean }).cancelled ?? false])).toEqual([
      ['q1', null, true],
      ['q2', 'A', false],
      // No result and no longer waited on (stopped before its result was written): nothing to answer.
      ['q3', null, true],
      ['q4', null, false],
    ]);
  });

  it('asked again under the same id: open again', () => {
    let t = applyEvent(asked(), ev(3, { type: 'status', status: 'aborted' }));
    t = applyEvent(t, ev(4, { type: 'ask.request', callId: 'q1', question: '确认这次申请的四项？', options: ['是'] }));
    expect((cards(t)[0] as { cancelled?: boolean }).cancelled).toBeUndefined();
  });

  it('cancelCard: the card the core no longer knows', () => {
    const t = cancelCard(asked(), 'q1');
    expect(cards(t)[0]).toMatchObject({ callId: 'q1', cancelled: true });
    expect((cards(t)[1] as { cancelled?: boolean }).cancelled).toBeUndefined();
  });
});

describe('a spending limit stops the run', () => {
  it('says why it stopped before the limit was reached, and where to change it (a button opens 设置 › 模型)', () => {
    const at = '2026-11-12T10:00:00Z';
    const t = applyEvent({ items: [] }, { type: 'budget.stop', scope: 'all:run', spentUsd: 0.75, limitUsd: 1, nextUsd: 0.4, message: 'x', seq: 1, at, sessionId: 's', parentChain: [] } as CoreEvent);
    expect(t.error).toBe('已达单次运行花费上限，已停止（已花费 US$0.75，上限 US$1.00）：下一步最多可能花 US$0.40，会超出上限，所以没有开始。可在 设置 › 模型 修改上限，或再发一条消息重新开始一次运行。');
    expect(t.errorAction).toBe('models');
    const next = applyEvent(t, { type: 'status', status: 'thinking', seq: 2, at, sessionId: 's', parentChain: [] } as CoreEvent);
    expect(next.error).toBeUndefined();
    expect(next.errorAction).toBeUndefined();
  });
});

describe('a run stopped at the turn limit', () => {
  it('says so after the answer (it looked done before); the next run clears it', () => {
    const base = { seq: 1, at: '2026-11-12T10:00:00Z', sessionId: 's', parentChain: [] };
    const t = applyEvent({ items: [] }, { ...base, type: 'run.end', reason: 'max_turns', detail: 'stopped after 30 turns' } as CoreEvent);
    expect(t.stopped).toBe('max_turns');
    expect(applyEvent(t, { ...base, type: 'status', status: 'thinking' } as CoreEvent).stopped).toBeUndefined();
    expect(applyEvent({ items: [] }, { ...base, type: 'run.end', reason: 'completed' } as CoreEvent).stopped).toBeUndefined();
  });
});

describe('an answer cut at the most the model may write', () => {
  it('is marked from the stored stop reason, live and when read again', async () => {
    const b = new FakeBackend({ speed: 0, seed: false });
    const chat = await b.createSession({});
    let live: Transcript = { items: [] };
    b.onEvent((e) => {
      if (e.sessionId === chat.id) live = applyEvent(live, e);
    });
    await b.send(chat.id, '写长一点');
    await new Promise((r) => setTimeout(r, 20));
    const last = (t: Transcript) => t.items.filter((i) => i.kind === 'response').at(-1) as { truncated?: boolean } | undefined;
    expect(last(live)?.truncated).toBe(true);
    expect(last(fromHistory(await b.getMessages(chat.id)))?.truncated).toBe(true);
    await b.send(chat.id, '继续');
    await new Promise((r) => setTimeout(r, 20));
    expect(last(fromHistory(await b.getMessages(chat.id)))?.truncated).toBe(false);
  });
});

describe('messages to other agents past the limit', () => {
  it('a refused message_agent is noted, live and when read again; the user writing clears it', async () => {
    const b = new FakeBackend({ speed: 0, seed: false });
    b.setAgentMessages(1);
    const chat = await b.createSession({});
    let live: Transcript = { items: [] };
    b.onEvent((e) => {
      if (e.sessionId === chat.id) live = applyEvent(live, e);
    });
    await b.send(chat.id, '互发');
    await new Promise((r) => setTimeout(r, 20));
    expect(live.agentLimit).toBe(true);
    expect(fromHistory(await b.getMessages(chat.id)).agentLimit).toBe(true);
    await b.send(chat.id, '好的，继续');
    await new Promise((r) => setTimeout(r, 20));
    expect(live.agentLimit).toBeUndefined();
    expect(fromHistory(await b.getMessages(chat.id)).agentLimit).toBeUndefined();
  });
});
