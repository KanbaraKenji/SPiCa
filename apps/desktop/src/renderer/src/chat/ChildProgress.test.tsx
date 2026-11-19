// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { CoreEvent, SessionInfo } from '@spica/protocol';
import { applyEvent, type Transcript } from '../store/transcript';
import { ChildProgress, ChildSourceContext, type ChildSource } from './ChildProgress';

const session = (id: string, title: string, status: SessionInfo['status']): SessionInfo =>
  ({ id, title, status, parentId: 'top', parentChain: ['top'] }) as unknown as SessionInfo;
const withPlan = (steps: [string, string][]): Transcript =>
  applyEvent({ items: [] }, { seq: 1, at: '', sessionId: 's', parentChain: [], type: 'tool.start', callId: 'p', name: 'update_plan', input: { plan: steps.map(([step, status]) => ({ step, status })) } } as unknown as CoreEvent);

describe('ChildProgress (the 等待子任务 row opened)', () => {
  it('a line per sub-agent: its name, how far its plan is, the step it is on; loads the ones it shows', () => {
    const load = vi.fn();
    const src: ChildSource = {
      parentId: 'top',
      sessions: [session('a', '报价汇总', 'tool'), session('b', '测试报告核对', 'done'), session('c', '别的对话', 'idle')],
      transcripts: {
        a: withPlan([['读四家报价单', 'completed'], ['对比四家单价和交期', 'in_progress'], ['标出缺的报价', 'pending'], ['写成对比表', 'pending']]),
        b: withPlan([['读测试报告', 'completed'], ['对照需求逐条核对', 'completed'], ['列出不符合的项', 'completed']]),
      },
      load,
    };
    const { container } = render(
      <ChildSourceContext.Provider value={src}>
        <ChildProgress ids={['a', 'b']} />
      </ChildSourceContext.Provider>,
    );
    const rows = [...container.querySelectorAll('.child-progress-row')].map((r) => r.textContent);
    expect(rows).toEqual(['报价汇总2 / 4对比四家单价和交期', '测试报告核对3 / 3已完成']);
    expect(load.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    cleanup();
  });

  it('without ids: the open conversation\'s sub-agents; no plan: the state in words', () => {
    const src: ChildSource = { parentId: 'top', sessions: [session('a', '报价汇总', 'awaiting_answer'), { ...session('x', '别处', 'tool'), parentId: 'other' } as SessionInfo], transcripts: {}, load: () => {} };
    const { container } = render(
      <ChildSourceContext.Provider value={src}>
        <ChildProgress ids={undefined} />
      </ChildSourceContext.Provider>,
    );
    expect([...container.querySelectorAll('.child-progress-row')].map((r) => r.textContent)).toEqual(['报价汇总等待回答']);
    cleanup();
  });
});
