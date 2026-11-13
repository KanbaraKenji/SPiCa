// @vitest-environment jsdom
// Thinking between calls folds into the calls' group (a model that thinks before every call).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionInfo } from '@spica/protocol';
import { Conversation, type ConversationActions } from './Conversation';
import type { Transcript } from '../store/transcript';

afterEach(cleanup);

const at = '2026-11-13T10:00:00+08:00';
const session: SessionInfo = { id: 's', parentId: null, parentChain: [], role: 'top', title: null, status: 'idle', providerId: 'p', model: 'm', cwd: 'D:\\工作', costUsd: 0, createdAt: at, updatedAt: at };
const think = (text: string) => ({ type: 'thinking' as const, text });
const call = (callId: string, name: string, input: unknown, state: 'done' | 'running' = 'done') => ({ type: 'tool' as const, callId, name, input, state, durationMs: 300 });
type Blocks = Extract<Transcript['items'][number], { kind: 'response' }>['blocks'];

function show(blocks: Blocks, running = false) {
  const transcript: Transcript = {
    items: [{ kind: 'user', id: 'u', text: '继续', steer: false }, { kind: 'response', id: 'a', blocks, interrupted: false, at }],
    ...(running ? { run: { startedAt: Date.now(), status: 'tool' as const } } : {}),
  };
  render(<Conversation session={running ? { ...session, status: 'tool' } : session} transcript={transcript} actions={{} as ConversationActions} />);
  return [...document.querySelectorAll('.turn-response > :not(.msg-actions)')].map((e) => e.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

describe('thinking among calls', () => {
  it('think, call, think, call, think, call: one line that counts the calls; open, each in its order, each opens on its own', () => {
    const lines = show([
      think('先列文件夹'),
      call('a', 'list_dir', { path: '.' }),
      think('读需求'),
      call('b', 'read_file', { path: '需求.docx' }),
      think('再读报价'),
      call('c', 'read_file', { path: '报价.xlsx' }),
      { type: 'text', text: '看完了。' },
    ]);
    expect(lines[0]).toMatch(/^Listed a folder, read 2 files/);
    expect(lines[0]).not.toContain('思考过程');
    expect(lines[1]).toBe('看完了。');
    fireEvent.click(screen.getByRole('button', { name: /Listed a folder/ }));
    const steps = [...document.querySelectorAll('.tool-list > .tool-item')].map((e) => e.textContent?.trim());
    expect(steps.map((s) => (s?.startsWith('思考过程') ? '思考过程' : s?.split(' ')[0]))).toEqual(['思考过程', 'Listed', '思考过程', 'Read', '思考过程', 'Read']);
    fireEvent.click(screen.getAllByRole('button', { name: '思考过程' })[1]!);
    expect(screen.getByText('读需求')).toBeTruthy();
  });

  it('a round with thinking and no call keeps its own 思考过程 line; words of the answer end a group', () => {
    expect(show([think('想一想'), { type: 'text', text: '先做评审。' }])).toEqual(['思考过程', '先做评审。']);
    cleanup();
    const lines = show([think('先看'), { type: 'text', text: '开始做。' }, call('a', 'list_dir', { path: '.' }), think('再读'), call('b', 'read_file', { path: 'x.docx' })]);
    expect(lines[0]).toBe('思考过程');
    expect(lines[1]).toBe('开始做。');
    expect(lines[2]).toMatch(/^Listed a folder, read a file/);
    expect(lines.filter((l) => !l.startsWith('DOC'))).toHaveLength(3);
  });

  it('one call with thinking before it is a group too (the thinking is inside); a call alone stays its own line', () => {
    expect(show([think('读一下'), call('a', 'read_file', { path: 'x.docx' })])[0]).toMatch(/^Read a file/);
    expect(document.querySelector('.turn-response .fold-head')?.getAttribute('aria-expanded')).toBe('false');
    cleanup();
    expect(show([call('a', 'read_file', { path: 'x.docx' })])[0]).toMatch(/^Read x\.docx/);
  });

  it('while it runs: the call running now says so on the group’s line; thinking still being written stays below as 正在思考', () => {
    const lines = show([think('列一下'), call('a', 'list_dir', { path: '.' }), think('读需求'), call('b', 'read_file', { path: 'x.docx' }, 'running')], true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Reading x\.docx/);
    cleanup();
    const thinking = show([think('列一下'), call('a', 'list_dir', { path: '.' }), think('接着读需求')], true);
    expect(thinking[0]).toMatch(/^Listed/);
    expect(thinking[1]).toMatch(/^正在思考/);
  });
});
