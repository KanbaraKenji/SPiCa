// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectInfo, SessionInfo } from '@spica/protocol';
import { DetailPanel } from '../shell/DetailPanel';
import { Conversation, type ConversationActions } from './Conversation';

afterEach(cleanup);

const at = '2026-11-09T10:00:00+08:00';
const session = (over: Partial<SessionInfo>): SessionInfo => ({
  id: 's',
  parentId: null,
  parentChain: [],
  role: 'top',
  title: null,
  status: 'tool',
  providerId: 'p',
  model: 'm',
  cwd: 'D:\\工作\\样机评审',
  costUsd: 0,
  createdAt: at,
  updatedAt: at,
  ...over,
});

describe('a sub-task that waits for the user', () => {
  it('is said under the parent conversation, with a way to go there', () => {
    const openSession = vi.fn();
    render(
      <Conversation
        session={session({ id: 'top' })}
        transcript={{ items: [{ kind: 'user', id: 'u', text: '建一个项目', steer: false }], run: { startedAt: Date.now(), status: 'tool' } }}
        actions={{ openSession } as unknown as ConversationActions}
        waiting={[{ id: 'w-a', title: '子Agent A：总结评审报告 PDF', status: 'awaiting_confirm' }]}
      />,
    );
    expect(screen.getByText('「子Agent A：总结评审报告 PDF」在等你确认')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '去处理' }));
    expect(openSession).toHaveBeenCalledWith('w-a');
  });
});

describe('DetailPanel', () => {
  const project: ProjectInfo = {
    id: 'p',
    name: '验收-样机评审',
    folder: 'K:\\spica-review\\验收资料',
    managerSessionId: 'pm',
    workflowId: null,
    stage: null,
    status: 'active',
    createdAt: at,
    updatedAt: at,
  };
  const props = { transcript: { items: [] }, globalCostUsd: 0, onOpenFile: vi.fn(), onOpenSession: vi.fn() };

  it('names the project once for a sub-task of its manager', () => {
    render(<DetailPanel {...props} session={session({ id: 'w', role: 'worker', parentId: 'pm', parentChain: ['pm'] })} parent={session({ id: 'pm', role: 'manager', title: '验收-样机评审' })} project={project} />);
    expect(screen.getByText('项目')).toBeTruthy();
    expect(screen.queryByText('属于')).toBeNull();
    expect(screen.getAllByText('验收-样机评审')).toHaveLength(1);
  });

  it('still says what a deeper sub-task belongs to', () => {
    render(<DetailPanel {...props} session={session({ id: 'w2', role: 'worker', parentId: 'w', parentChain: ['w', 'pm'] })} parent={session({ id: 'w', role: 'worker', title: '整理报价' })} project={project} />);
    expect(screen.getByText('属于')).toBeTruthy();
    expect(screen.getByText('整理报价')).toBeTruthy();
  });
});
