// Cards for the files a round made or read: several per call, one per file under the answer, and what each says.
import { describe, expect, it } from 'vitest';
import type { CoreEvent, FileCardMeta, Message } from '@spica/protocol';
import { applyEvent, EMPTY_TRANSCRIPT, fileCardVerb, filesOf, fromHistory, type Block } from './transcript';

const at = '2026-11-11T20:00:00+08:00';
const card = (path: string, origin?: FileCardMeta['origin'], lines?: FileCardMeta['lines']): FileCardMeta => ({
  path,
  name: path.split('\\').pop()!,
  kind: 'other',
  sizeBytes: 10,
  modifiedAt: at,
  extractedAt: at,
  read: {},
  ...(origin ? { origin } : {}),
  ...(lines ? { lines } : {}),
});
const tool = (callId: string, name: string, extra: Partial<Extract<Block, { type: 'tool' }>> = {}): Block => ({ type: 'tool', callId, name, input: {}, state: 'done', ...extra });

describe('one card per file under the answer', () => {
  it('each card of a call (a command reports several), with what the round did', () => {
    const blocks = [tool('c1', 'run_command', { category: 'command' })];
    const files = filesOf(blocks, { c1: card('D:\\w\\out.csv', 'created') }, undefined, { c1: [card('D:\\w\\out.csv', 'created'), card('D:\\w\\old.txt', 'modified')] });
    expect(files.map((f) => [f.path, fileCardVerb(f)])).toEqual([
      ['D:\\w\\out.csv', 'Created while the command ran'],
      ['D:\\w\\old.txt', 'Changed while the command ran'],
    ]);
  });

  it('write_file and edit_file say Created / Edited from the card; lines are added up over the round', () => {
    const blocks = [tool('w1', 'write_file'), tool('e1', 'edit_file'), tool('e2', 'edit_file')];
    const files = filesOf(blocks, { w1: card('D:\\w\\q5.py', 'created', { added: 8, removed: 0 }), e1: card('D:\\w\\q5.py', 'modified', { added: 2, removed: 1 }), e2: card('D:\\w\\a.md', 'modified', { added: 1, removed: 1 }) });
    expect(files.map((f) => [f.path, fileCardVerb(f), f.lines])).toEqual([
      ['D:\\w\\q5.py', 'Edited', { added: 10, removed: 1 }],
      ['D:\\w\\a.md', 'Edited', { added: 1, removed: 1 }],
    ]);
  });

  it('what present_files handed over comes first and keeps its card; otherwise the latest card wins', () => {
    const blocks = [tool('w1', 'write_file'), tool('r1', 'read_file'), tool('c1', 'run_command', { category: 'command' }), tool('p1', 'present_files', { category: 'present' }), tool('e1', 'edit_file')];
    const files = filesOf(
      blocks,
      { w1: card('D:\\w\\报告.pdf', 'created', { added: 3, removed: 0 }), r1: card('D:\\w\\需求说明.docx'), e1: card('D:\\w\\报告.pdf', 'modified', { added: 1, removed: 0 }) },
      undefined,
      { c1: [card('D:\\w\\需求说明.docx', 'modified')], p1: [card('D:\\w\\报告.pdf', 'created')] },
    );
    expect(files.map((f) => [f.path, f.tool, fileCardVerb(f), f.lines])).toEqual([
      ['D:\\w\\报告.pdf', 'present_files', 'Created', { added: 4, removed: 0 }],
      ['D:\\w\\需求说明.docx', 'run_command', 'Changed while the command ran', undefined],
    ]);
  });

  it('a plugin tool’s file says Made; a read file says what was read', () => {
    const files = filesOf([tool('m1', 'notes__export'), tool('r1', 'read_file')], { r1: card('D:\\w\\a.docx') }, undefined, { m1: [card('D:\\w\\导出.zip', 'produced')] });
    expect(files.map((f) => fileCardVerb(f))).toEqual(['Made', null]);
  });

  it('older conversations without cards: the path argument of write_file / edit_file, and a card wins over it', () => {
    const blocks = [tool('w1', 'write_file', { input: { path: 'a.md' } }), tool('e1', 'edit_file', { input: { path: 'a.md' } }), tool('r1', 'read_file', { input: { path: 'b.md' } })];
    expect(filesOf(blocks).map((f) => [f.path, f.tool, fileCardVerb(f)])).toEqual([
      ['a.md', 'write_file', null],
      ['b.md', 'read_file', null],
    ]);
    expect(filesOf(blocks, { r1: card('b.md') }).find((f) => f.path === 'b.md')?.card?.path).toBe('b.md');
  });

  it('a failed call gives no card', () => {
    expect(filesOf([tool('w1', 'write_file', { state: 'error' })], { w1: card('D:\\w\\a.md', 'created') })).toEqual([]);
  });
});

describe('where the cards come from', () => {
  it('a file.card event with several keeps them all, and tool.start gives the call its kind', () => {
    const ev = (body: object, seq: number) => ({ ...body, seq, at: '', sessionId: 's', parentChain: [] }) as unknown as CoreEvent;
    let t = applyEvent(EMPTY_TRANSCRIPT, ev({ type: 'tool.start', callId: 'c1', name: 'run_command', input: { command: 'x' }, category: 'command' }, 1));
    const files = [card('D:\\w\\a.csv', 'created'), card('D:\\w\\b.csv', 'created')];
    t = applyEvent(t, ev({ type: 'file.card', callId: 'c1', file: files[0], files }, 2));
    expect(t.fileCardLists).toEqual({ c1: files });
    const r = t.items.find((i) => i.kind === 'response');
    expect(r?.kind === 'response' && r.blocks[0]).toMatchObject({ callId: 'c1', category: 'command' });
  });

  it('a reopened conversation reads meta.fileCardLists and meta.toolInfo', () => {
    const files = [card('D:\\w\\a.csv', 'created'), card('D:\\w\\b.csv', 'modified')];
    const messages = [
      { id: 'm1', sessionId: 's', seq: 1, role: 'user', kind: 'user', content: [{ type: 'text', text: '汇总' }], createdAt: at },
      { id: 'm2', sessionId: 's', seq: 2, role: 'assistant', kind: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'run_command', input: { command: 'x' } }], createdAt: at },
      {
        id: 'm3',
        sessionId: 's',
        seq: 3,
        role: 'user',
        kind: 'tool_results',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok' }],
        meta: { fileCards: { c1: files[0] }, fileCardLists: { c1: files }, toolInfo: { c1: { category: 'command' } } },
        createdAt: at,
      },
    ] as unknown as Message[];
    const t = fromHistory(messages);
    const r = t.items.find((i) => i.kind === 'response');
    if (r?.kind !== 'response') throw new Error('no answer');
    expect(filesOf(r.blocks, t.fileCards, undefined, t.fileCardLists).map((f) => fileCardVerb(f))).toEqual(['Created while the command ran', 'Changed while the command ran']);
  });
});
