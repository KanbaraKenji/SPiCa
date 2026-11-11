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

  it('is there otherwise: tools done and the answer not yet written, a call not started yet, nothing yet', () => {
    expect(shownInAnswer(live([tool('done')], 'thinking'))).toBe(false);
    expect(shownInAnswer(live([tool('pending')]))).toBe(false);
    expect(shownInAnswer(live([], 'thinking'))).toBe(false);
    const { container } = render(<StatusLine transcript={live([tool('pending')])} />);
    expect(container.querySelector('.status-line')?.textContent).toMatch(/^0:0[45]正在读取文件$/);
  });
});
