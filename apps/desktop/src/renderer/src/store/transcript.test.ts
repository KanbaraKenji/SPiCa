import { describe, expect, it } from 'vitest';
import type { CoreEvent } from '@spica/protocol';
import { FakeBackend } from '../../../main/backend/fake';
import { buildSeed, SEED_IDS } from '../../../main/backend/fake-seed';
import { applyEvent, filesOf, fromHistory, resultBody, type Transcript } from './transcript';

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

describe('resultBody', () => {
  it('drops the fetch-time line', () => {
    expect(resultBody('2026-11-09T10:00:00.000+08:00\nhello')).toBe('hello');
    expect(resultBody('plain')).toBe('plain');
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
