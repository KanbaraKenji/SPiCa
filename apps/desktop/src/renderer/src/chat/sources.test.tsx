// @vitest-environment jsdom
// The web pages an answer rests on: under the answer, and inside the web call that found them.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CoreEvent, Message, SourceCardMeta } from '@spica/protocol';
import { AnswerSources, SourceCardsContext, ToolGroup } from './Blocks';
import { answerSources, hostOf } from './sources';
import { applyEvent, EMPTY_TRANSCRIPT, fromHistory, type Block } from '../store/transcript';

afterEach(cleanup);

const at = '2026-11-11T20:00:00+08:00';
const search: SourceCardMeta = {
  tool: 'web_search',
  query: '模具 报价',
  sources: [
    { url: 'https://example.com/a', title: '甲', snippet: '摘要甲', fetchedAt: at },
    { url: 'https://example.org/b/', title: '乙', fetchedAt: at },
    { url: 'https://example.net/c', title: null, fetchedAt: at },
  ],
};
const page: SourceCardMeta = { tool: 'web_fetch', sources: [{ url: 'https://example.com/guide', title: '指南', fetchedAt: at }] };
const tool = (callId: string, name: string, state: 'done' | 'error' = 'done'): Block => ({ type: 'tool', callId, name, input: {}, state });

describe('which pages an answer rests on', () => {
  it('every page it opened, and the search results it links to (each once)', () => {
    const blocks: Block[] = [tool('s', 'web_search'), tool('f', 'web_fetch'), { type: 'text', text: '见 [乙](https://example.org/b) 和 https://example.com/guide。还有 [乙](https://example.org/b#x)' }];
    expect(answerSources(blocks, { s: search, f: page }).map((r) => r.url)).toEqual(['https://example.org/b/', 'https://example.com/guide']);
  });

  it('nothing from a failed call, or without cards', () => {
    expect(answerSources([tool('f', 'web_fetch', 'error')], { f: page })).toEqual([]);
    expect(answerSources([tool('f', 'web_fetch')])).toEqual([]);
  });

  it('a page with no title goes by its site', () => {
    expect(hostOf('https://www.example.com/x')).toBe('example.com');
  });
});

describe('where the cards come from', () => {
  it('the source.card event, and the stored meta of a reopened conversation', () => {
    const ev = { type: 'source.card', callId: 's', card: search, seq: 1, at: '', sessionId: 'x', parentChain: [] } as unknown as CoreEvent;
    expect(applyEvent(EMPTY_TRANSCRIPT, ev).sourceCards).toEqual({ s: search });
    const t = fromHistory([
      { id: 'm1', sessionId: 'x', seq: 1, role: 'user', kind: 'user', content: [{ type: 'text', text: '查' }], createdAt: at },
      { id: 'm2', sessionId: 'x', seq: 2, role: 'assistant', kind: 'assistant', content: [{ type: 'tool_use', id: 'f', name: 'web_fetch', input: {} }], createdAt: at },
      { id: 'm3', sessionId: 'x', seq: 3, role: 'user', kind: 'tool_results', content: [{ type: 'tool_result', toolUseId: 'f', content: 'ok' }], meta: { sourceCards: { f: page } }, createdAt: at },
    ] as unknown as Message[]);
    expect(t.sourceCards).toEqual({ f: page });
  });
});

describe('how they show', () => {
  it('under the answer: 来源 and a chip a page, title and site, opening in the browser', () => {
    render(<AnswerSources sources={[...search.sources, ...page.sources]} />);
    const chips = [...document.querySelectorAll('.source-chip')] as HTMLAnchorElement[];
    expect(chips.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')])).toEqual([
      ['甲example.com', 'https://example.com/a', '_blank'],
      ['乙example.org', 'https://example.org/b/', '_blank'],
      ['example.net', 'https://example.net/c', '_blank'],
      ['指南example.com', 'https://example.com/guide', '_blank'],
    ]);
    expect(screen.getByLabelText('来源')).toBeTruthy();
  });

  it('many: six, then 全部 N 个', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ url: `https://example.com/${i}`, title: `页 ${i}`, fetchedAt: at }));
    render(<AnswerSources sources={many} />);
    expect(document.querySelectorAll('.source-chip').length).toBe(6);
    fireEvent.click(screen.getByRole('button', { name: '全部 9 个' }));
    expect(document.querySelectorAll('.source-chip').length).toBe(9);
  });

  it('inside the web call: one page a row (with the snippet), not the raw text', () => {
    render(
      <SourceCardsContext.Provider value={{ s: search }}>
        <ToolGroup blocks={[{ type: 'tool', callId: 's', name: 'web_search', input: { query: '模具 报价' }, state: 'done', result: 'RAW RESULT TEXT' }]} />
      </SourceCardsContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Searched the web for “模具 报价”/ }));
    expect([...document.querySelectorAll('.source-row')].map((r) => r.textContent)).toEqual(['甲example.com摘要甲', '乙example.org', 'example.net']);
    expect(screen.queryByText('RAW RESULT TEXT')).toBeNull();
  });
});
