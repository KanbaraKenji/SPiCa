// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { StatusLine, shownInAnswer } from './StatusLine';
import type { Block, Transcript } from '../store/transcript';

afterEach(cleanup);

const tool = (state: 'running' | 'done' | 'pending'): Block => ({ type: 'tool', callId: state, name: 'read_file', input: { path: 'a.docx' }, state });
const live = (blocks: Block[], status: 'tool' | 'thinking' = 'tool'): Transcript =>
  ({ items: [{ kind: 'response', id: 'r', blocks }], run: { status, startedAt: Date.now() - 5000 } }) as unknown as Transcript;

describe('the status line under the answer', () => {
  it('stays away while the answer’s last line says what the run is doing (a tool running, thinking as it streams)', () => {
    expect(shownInAnswer(live([tool('done'), tool('running')]))).toBe(true);
    expect(shownInAnswer(live([{ type: 'thinking', text: '…' }], 'thinking'))).toBe(true);
    const { container } = render(<StatusLine transcript={live([tool('running')])} />);
    expect(container.querySelector('.status-line')).toBeNull();
  });

  it('is there while remember runs (its line only comes with the result): 正在保存记忆', () => {
    const saving = live([{ type: 'tool', callId: 'm', name: 'remember', input: {}, state: 'running' }]);
    expect(shownInAnswer(saving)).toBe(false);
    const { container } = render(<StatusLine transcript={saving} />);
    expect(container.textContent).toContain('正在保存记忆');
  });

  it('is there otherwise: tools done and the answer not yet written, a call not started yet, nothing yet', () => {
    expect(shownInAnswer(live([tool('done')], 'thinking'))).toBe(false);
    expect(shownInAnswer(live([tool('pending')]))).toBe(false);
    expect(shownInAnswer(live([], 'thinking'))).toBe(false);
    const { container } = render(<StatusLine transcript={live([tool('pending')])} />);
    expect(container.querySelector('.status-line')?.textContent).toMatch(/^正在读取文件0:0[45]$/);
  });

  it('says what it is doing first and the clock after it, in every state (as the Running … line does)', () => {
    const waiting = (status: string, extra: Record<string, unknown> = {}) =>
      ({ items: [{ kind: 'response', id: 'r', blocks: [{ type: 'text', text: '好' }] }], run: { status, startedAt: Date.now() - 7000, ...extra } }) as unknown as Transcript;
    for (const [status, text] of [['awaiting_confirm', '等待确认'], ['awaiting_answer', '等待回答'], ['queued', '排队中'], ['thinking', '正在回复']] as const) {
      const { container } = render(<StatusLine transcript={waiting(status)} />);
      const parts = [...container.querySelector('.status-line')!.children].map((c) => c.getAttribute('class')?.split(' ')[0]);
      expect(parts, status).toEqual(['spica-mark', 'status-text', 'status-clock']);
      expect(container.querySelector('.status-text')?.textContent, status).toBe(text);
      cleanup();
    }
  });
});
