// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { HistoryCardMeta } from '@spica/protocol';
import { OpenSessionContext, HistoryCardsContext, HistoryRefContext, MarkdownText, AskCard, ConfirmCard, FileCards, SuggestCard, ToolGroup } from './Blocks';

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
    fireEvent.change(screen.getByRole('textbox', { name: '回答' }), { target: { value: '写简短一点' } });
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

  it('shows exactly what would run, nothing cut: a long command to its last characters, never the model’s description', () => {
    const command = `Get-ChildItem D:\\工作 -Recurse | Where-Object { $_.Length -gt 0 } | ${'Select-Object Name; '.repeat(7)}Remove-Item D:\\工作\\重要 -Recurse -Force`;
    expect(command.length).toBeGreaterThan(200);
    render(<ConfirmCard block={{ type: 'confirm', callId: 'c3', name: 'run_command', input: { command, description: '列出文件' }, reason: '运行命令' }} onDecide={vi.fn()} />);
    const box = document.querySelector('.confirm-card .tool-command pre');
    expect(box?.textContent).toBe(`$ ${command}`);
    expect(box?.textContent?.endsWith('Remove-Item D:\\工作\\重要 -Recurse -Force')).toBe(true);
    expect(screen.queryByText(/列出文件/)).toBeNull();
  });

  it('other calls: their arguments in full, under names people read', () => {
    const body = '各位好，'.repeat(40);
    render(<ConfirmCard block={{ type: 'confirm', callId: 'c4', name: 'mail__send', input: { to: 'team@example.com', subject: '样机评审时间', body }, reason: '发送邮件' }} onDecide={vi.fn()} />);
    const rows = [...document.querySelectorAll('.confirm-args dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(rows).toEqual([
      ['收件人', 'team@example.com'],
      ['标题', '样机评审时间'],
      ['正文', body],
    ]);
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
    const head = screen.getByRole('button', { name: /Listed a folder, read a file/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(head);
    expect(screen.getByRole('button', { name: /Read 需求说明\.docx/ })).toBeTruthy();
  });

  it('each call’s line says how it stands in its first place (done, failed, running); nothing after the name; failed is said in English', () => {
    render(
      <ToolGroup
        blocks={[
          { type: 'tool', callId: 'a', name: 'list_dir', input: { path: '.' }, state: 'done', durationMs: 400 },
          { type: 'tool', callId: 'b', name: 'read_file', input: { path: '需求说明.docx' }, state: 'error', durationMs: 700, result: '[FILE_LOCKED] 文件正被其他程序占用' },
          { type: 'tool', callId: 'c', name: 'read_file', input: { path: '报价单.xlsx' }, state: 'timeout' },
        ]}
      />,
    );
    const head = screen.getByRole('button', { name: /Listed a folder, read 2 files/ });
    // The group: still the tool icon; the count of failures in English, no icon after it.
    expect(head.textContent).toContain('1 failed');
    expect(head.querySelector('.fold-meta svg')).toBeNull();
    fireEvent.click(head);
    const rows = [...document.querySelectorAll('.tool-list .tool-item-head')] as HTMLElement[];
    expect(rows.map((r) => r.querySelector('.fold-meta')?.textContent ?? '')).toEqual(['<1 秒', 'Failed', '已超时']);
    for (const r of rows) expect(r.querySelector('.fold-meta svg')).toBeNull();
    expect(rows.map((r) => r.querySelector('.fold-icon svg')?.getAttribute('data-status'))).toEqual(['done', 'error', 'stopped']);
  });

  it('while a call runs and the run is on it, the line says so: the turning mark first, Running (or Reading…) and the step, the run’s clock at the end', () => {
    const since = Date.now() - 47_000;
    const { rerender } = render(<ToolGroup blocks={[{ type: 'tool', callId: 'a', name: 'list_dir', input: { path: '.' }, state: 'running' }]} since={since} />);
    let head = screen.getByRole('button');
    expect(head.querySelector('.fold-icon .spica-mark')).toBeTruthy();
    expect(head.querySelector('.fold-label')?.textContent).toBe('Listing the working folder');
    expect(head.lastElementChild?.textContent).toBe('0:47');
    // Two in the group, the second running: the group's line.
    rerender(
      <ToolGroup
        blocks={[
          { type: 'tool', callId: 'a', name: 'list_dir', input: { path: '.' }, state: 'done', durationMs: 400 },
          { type: 'tool', callId: 'b', name: 'read_file', input: { path: '需求说明.docx' }, state: 'running' },
        ]}
        since={since}
      />,
    );
    head = screen.getAllByRole('button')[0]!;
    expect(head.querySelector('.fold-label')?.textContent).toBe('Reading 需求说明.docx');
    expect(head.querySelector('.fold-icon .spica-mark')).toBeTruthy();
    expect(head.lastElementChild?.textContent).toBe('0:47');
    // Inside, the running call turns in its first place; nothing after its name.
    fireEvent.click(head);
    const running = screen.getAllByRole('button')[2]!;
    expect(running.querySelector('.fold-icon svg')?.getAttribute('data-status')).toBe('running');
    expect(running.querySelector('.fold-meta')).toBeNull();
    // Done: back to what the group did, with the tool icon, no clock.
    rerender(
      <ToolGroup
        blocks={[
          { type: 'tool', callId: 'a', name: 'list_dir', input: { path: '.' }, state: 'done', durationMs: 400 },
          { type: 'tool', callId: 'b', name: 'read_file', input: { path: '需求说明.docx' }, state: 'done', durationMs: 600 },
        ]}
      />,
    );
    head = screen.getAllByRole('button')[0]!;
    expect(head.querySelector('.fold-label')?.textContent).toBe('Listed a folder, read a file');
    expect(head.querySelector('.spica-mark')).toBeNull();
  });

  it('several running at once: the first by name and how many', () => {
    render(
      <ToolGroup
        blocks={[
          { type: 'tool', callId: 'a', name: 'read_file', input: { path: 'a.docx' }, state: 'running' },
          { type: 'tool', callId: 'b', name: 'read_file', input: { path: 'b.docx' }, state: 'running' },
          { type: 'tool', callId: 'c', name: 'list_dir', input: { path: '.' }, state: 'running' },
        ]}
        since={Date.now()}
      />,
    );
    expect(screen.getAllByRole('button')[0]!.querySelector('.fold-label')?.textContent).toBe('Reading a.docx and 2 more');
  });

  it('a call not started yet keeps the tool icon and the turning ring after its name', () => {
    render(<ToolGroup blocks={[{ type: 'tool', callId: 'a', name: 'list_dir', input: { path: '.' }, state: 'pending' }]} />);
    const head = screen.getByRole('button');
    expect(head.querySelector('.fold-icon svg')?.getAttribute('data-status')).toBeNull();
    expect(head.querySelector('.fold-meta svg')?.getAttribute('data-status')).toBe('running');
  });
});

describe('the assistant looking through earlier conversations', () => {
  const card: HistoryCardMeta = {
    tool: 'search_history',
    query: '报价单',
    total: 3,
    rows: [
      { ref: 1, sessionId: 'ses_ab12', name: '看一下报价单', at: '2026-11-09T10:00:00+08:00', seq: 4, who: 'agent', text: '报价单的合计是 12,800 元' },
      { ref: 2, sessionId: 'ses_cd34', name: '样机评审', projectId: 'pr1', projectName: '样机评审', at: '2026-11-08T10:00:00+08:00', seq: 9, who: 'user', text: '报价单已更新' },
      { ref: 3, sessionId: 'ses_ef56', name: '整理来信', projectId: 'pr2', projectName: '采购', at: '2026-11-07T10:00:00+08:00', who: 'user', text: '附件里有报价单' },
    ],
  };
  const block = {
    type: 'tool' as const,
    callId: 'h1',
    name: 'search_history',
    input: { query: '报价单' },
    state: 'done' as const,
    result: '<untrusted_data kind="history">3 conversations found:\n- [1] 看一下报价单 · agent: …</untrusted_data>',
  };

  it('a table of conversation and matching text; a row opens that conversation at the message; what the model read is not shown', () => {
    const open = vi.fn();
    render(
      <OpenSessionContext.Provider value={open}>
        <HistoryCardsContext.Provider value={{ h1: card }}>
          <ToolGroup blocks={[block]} />
        </HistoryCardsContext.Provider>
      </OpenSessionContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Searched conversations for “报价单”/ }));
    expect(screen.getByText('对话')).toBeTruthy();
    expect(screen.getByText('匹配内容')).toBeTruthy();
    expect(screen.queryByText(/conversations found|untrusted_data/)).toBeNull();
    // No time, no who said it.
    expect(screen.queryByText(/2026|Spica|我/)).toBeNull();
    // The project is named when it is not the conversation's own name.
    expect(screen.getByRole('button', { name: '打开「整理来信」' }).textContent).toContain('采购');
    expect(screen.getByRole('button', { name: '打开「样机评审」' }).textContent).toBe('样机评审报价单已更新');
    fireEvent.click(screen.getByRole('button', { name: '打开「看一下报价单」' }));
    expect(open).toHaveBeenCalledWith('ses_ab12', 4);
  });

  it('files: the file in the second column; fewer rows than found says so', () => {
    const files: HistoryCardMeta = {
      tool: 'find_history_files',
      query: '报价',
      total: 5,
      rows: [{ ref: 4, sessionId: 'ses_ab12', name: '看一下报价单', at: '2026-11-09T10:00:00+08:00', text: 'D:/报价/报价单.xlsx', path: 'D:/报价/报价单.xlsx', how: 'attached' }],
    };
    render(
      <HistoryCardsContext.Provider value={{ h2: files }}>
        <ToolGroup blocks={[{ ...block, callId: 'h2', name: 'find_history_files' }]} />
      </HistoryCardsContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Listed files from conversations/ }));
    expect(screen.getByText('文件')).toBeTruthy();
    expect(screen.getByText('D:/报价/报价单.xlsx')).toBeTruthy();
    expect(screen.getByText('共 5 条，显示最近 1 条')).toBeTruthy();
  });

  it('[name](history:n) in an answer opens that place; a number not known here is plain text', () => {
    const open = vi.fn();
    render(
      <OpenSessionContext.Provider value={open}>
        <HistoryRefContext.Provider value={(n) => (n === 1 ? { sessionId: 'ses_ab12', seq: 4 } : undefined)}>
          <MarkdownText text={'在[看一下报价单](history:1)里说过，[另一条](history:7)没有。[文档](https://example.com/a)[第一](history:1x)'} />
        </HistoryRefContext.Provider>
      </OpenSessionContext.Provider>,
    );
    // Told apart by the pointer and a hover note, not a line under it.
    expect(screen.getByRole('button', { name: '看一下报价单' }).getAttribute('title')).toBe('打开对话');
    fireEvent.click(screen.getByRole('button', { name: '看一下报价单' }));
    expect(open).toHaveBeenCalledWith('ses_ab12', 4);
    expect(screen.queryByRole('button', { name: '另一条' })).toBeNull();
    expect(screen.queryByRole('link', { name: '另一条' })).toBeNull();
    expect(screen.getByText(/另一条/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '文档' }).getAttribute('href')).toBe('https://example.com/a');
    // Only digits after history:.
    expect(screen.queryByRole('button', { name: '第一' })).toBeNull();
  });
});
