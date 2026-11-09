// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AskCard, ConfirmCard, FileCards, SuggestCard, ToolGroup } from './Blocks';

afterEach(cleanup);

describe('AskCard', () => {
  const block = { type: 'ask' as const, callId: 'c1', question: '纪要按哪种口径写？', options: ['只写结论', '按议题逐条写'] };

  it('answers with an option', () => {
    const onAnswer = vi.fn();
    render(<AskCard block={block} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: '只写结论' }));
    expect(onAnswer).toHaveBeenCalledWith('只写结论');
  });

  it('answers with free text', () => {
    const onAnswer = vi.fn();
    render(<AskCard block={block} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByRole('textbox', { name: '你的回答' }), { target: { value: '写简短一点' } });
    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    expect(onAnswer).toHaveBeenCalledWith('写简短一点');
  });

  it('shows the answer instead of controls once answered', () => {
    render(<AskCard block={{ ...block, answer: '只写结论' }} onAnswer={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '回答' })).toBeNull();
    expect(screen.getByText('只写结论')).toBeTruthy();
  });
});

describe('ConfirmCard', () => {
  it('says only what is being confirmed and reports the decision', () => {
    const onDecide = vi.fn();
    render(<ConfirmCard block={{ type: 'confirm', callId: 'c2', name: 'send_email', input: {}, reason: '发送邮件给「项目组」' }} onDecide={onDecide} />);
    expect(document.querySelector('.card-why')).toBeNull();
    expect(screen.getByText('发送邮件给「项目组」')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(onDecide).toHaveBeenCalledWith(true);
  });
});

describe('SuggestCard and FileCards', () => {
  it('sends the prompt behind a suggestion', () => {
    const onPick = vi.fn();
    render(<SuggestCard block={{ type: 'suggest', callId: 'c3', title: '接下来可以', actions: [{ label: '起草催价邮件', prompt: '帮我起草催价邮件' }] }} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: /起草催价邮件/ }));
    expect(onPick).toHaveBeenCalledWith('帮我起草催价邮件');
  });

  it('opens a file card', () => {
    const onOpen = vi.fn();
    render(<FileCards files={[{ path: '资料\\需求说明.docx', tool: 'read_file' }]} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /需求说明\.docx/ }));
    expect(onOpen).toHaveBeenCalledWith('资料\\需求说明.docx');
  });
});

describe('ToolGroup', () => {
  it('folds several calls into one line and expands on click', () => {
    render(
      <ToolGroup
        blocks={[
          { type: 'tool', callId: 'a', name: 'list_dir', input: { path: '.' }, state: 'done', durationMs: 400 },
          { type: 'tool', callId: 'b', name: 'read_file', input: { path: '需求说明.docx' }, state: 'done', durationMs: 700, result: '内容' },
        ]}
      />,
    );
    const head = screen.getByRole('button', { name: /调用了 2 个工具/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(head);
    expect(screen.getByRole('button', { name: /读取文件\s+需求说明\.docx/ })).toBeTruthy();
  });
});
