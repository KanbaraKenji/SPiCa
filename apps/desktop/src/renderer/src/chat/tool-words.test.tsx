// @vitest-environment jsdom
// What tool-call lines say (English), and the innermost level: the command as written and its output.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FileCardMeta } from '@spica/protocol';
import { ToolCardsContext, ToolGroup } from './Blocks';
import { groupWords, runningGroup, runningWords, toolLineText, type ToolCall } from './tool-words';

afterEach(cleanup);

const at = '2026-11-11T20:00:00+08:00';
const card = (origin: FileCardMeta['origin'], lines?: FileCardMeta['lines']): FileCardMeta => ({ path: 'D:\\w\\q5.py', name: 'q5.py', kind: 'text', sizeBytes: 9, modifiedAt: at, extractedAt: at, read: {}, origin, ...(lines ? { lines } : {}) });
const call = (name: string, input: Record<string, unknown> = {}, extra: Partial<ToolCall> = {}): ToolCall => ({ name, input, ...extra });

describe('a call’s line', () => {
  it('a command: the model’s line on it, else its first line, else “a command”', () => {
    expect(toolLineText(call('run_command', { command: 'Get-ChildItem -Recurse' }, { summary: '统计报价单里的行数' }))).toBe('Ran 统计报价单里的行数');
    expect(toolLineText(call('run_command', { command: 'Get-ChildItem -Recurse' }))).toBe('Ran Get-ChildItem -Recurse');
    expect(toolLineText(call('run_command', { command: 'x'.repeat(200) }))).toBe('Ran a command');
  });

  it('files: Read / Listed / Created +8 / Edited +3 −1, Wrote without a card', () => {
    expect(toolLineText(call('read_file', { path: 'D:\\w\\报价单.xlsx' }))).toBe('Read 报价单.xlsx');
    expect(toolLineText(call('list_dir', { path: 'D:\\w\\报价' }))).toBe('Listed 报价\\');
    expect(toolLineText(call('write_file', { path: 'q5.py' }), card('created', { added: 8, removed: 0 }))).toBe('Created q5.py +8');
    expect(toolLineText(call('write_file', { path: 'q5.py' }), card('modified', { added: 3, removed: 1 }))).toBe('Edited q5.py +3 −1');
    expect(toolLineText(call('write_file', { path: 'q5.py' }))).toBe('Wrote q5.py');
    expect(toolLineText(call('grep', { pattern: 'TODO' }))).toBe('Searched files for “TODO”');
  });

  it('the web, earlier conversations, sub-agents, plugins, anything else', () => {
    expect(toolLineText(call('web_fetch', { url: 'https://nodejs.org/en/about/previous-releases' }))).toBe('Fetched nodejs.org/en/about/previous-releases');
    expect(toolLineText(call('web_search', { query: 'Node 24 release' }))).toBe('Searched the web for “Node 24 release”');
    expect(toolLineText(call('read_history'))).toBe('Read an earlier conversation');
    expect(toolLineText(call('spawn_agent', { title: '整理供应商报价', task: '…' }))).toBe('Started 「整理供应商报价」');
    expect(toolLineText(call('wait_agents', { ids: ['a', 'b'] }))).toBe('Waited for 2 sub-agents');
    expect(toolLineText(call('present_files', { paths: ['a', 'b'] }))).toBe('Presented 2 files');
    expect(toolLineText(call('notes__list_notes'))).toBe('Notes · list_notes');
    expect(toolLineText(call('notes__list_notes', {}, { title: 'List notes' }))).toBe('List notes');
    expect(toolLineText(call('mystery_tool'))).toBe('mystery_tool');
  });

  it('a call announced before its input arrived says what kind of thing it touches', () => {
    const bare = (name: string): ToolCall => ({ name, input: undefined });
    expect(['write_file', 'read_file', 'run_command', 'list_dir', 'grep', 'web_fetch', 'web_search', 'search_history'].map((n) => toolLineText(bare(n)))).toEqual([
      'Wrote a file',
      'Read a file',
      'Ran a command',
      'Listed a folder',
      'Searched files',
      'Fetched a page',
      'Searched the web',
      'Searched conversations',
    ]);
    expect(runningWords(bare('read_file'))).toBe('Reading a file');
    expect(runningGroup([bare('write_file'), bare('list_dir')])).toBe('Writing a file and 1 more');
  });

  it('project tools that change things say what changed', () => {
    expect(toolLineText(call('set_stage', { stage: '评审' }))).toBe('Moved the project to 「评审」');
    expect(toolLineText(call('add_work_object', { level: 'part', name: '外壳' }))).toBe('Added 「外壳」');
    expect(toolLineText(call('open_project', { project: '年度预算' }))).toBe('Checked 「年度预算」');
    expect(groupWords([{ call: call('set_stage', { stage: 'a' }) }, { call: call('add_work_object', { name: 'b' }) }, { call: call('list_projects') }])).toBe('Updated a project, checked projects');
  });

  it('while it runs', () => {
    expect(runningWords(call('run_command', { command: 'Get-ChildItem' }))).toBe('Running Get-ChildItem');
    expect(runningWords(call('read_file', { path: 'a.docx' }))).toBe('Reading a.docx');
    expect(runningWords(call('notes__list_notes'))).toBe('Running Notes · list_notes');
    expect(runningGroup([call('read_file', { path: 'a.docx' }), call('list_dir', { path: '.' })])).toBe('Reading a.docx and 1 more');
  });
});

describe('a group’s line', () => {
  it('counts each kind in the order they came: Ran 4 commands, created a file, read a file', () => {
    const cmd = { call: call('run_command', { command: 'x' }) };
    expect(groupWords([cmd, { call: call('write_file', { path: 'q5.py' }), card: card('created') }, cmd, { call: call('read_file', { path: 'a' }) }, cmd, cmd])).toBe('Ran 4 commands, created a file, read a file');
    expect(groupWords([{ call: call('web_fetch', { url: 'https://a' }) }, { call: call('web_fetch', { url: 'https://b' }) }, { call: call('web_search', { query: 'q' }) }])).toBe('Fetched 2 pages, searched the web');
    expect(groupWords([{ call: call('notes__a') }, { call: call('notes__b') }, { call: call('x') }])).toBe('Used 「Notes」, used a tool');
  });
});

describe('calls not finished yet', () => {
  it('in the open list, a running or waiting call says what it is doing, not what it did', () => {
    render(
      <ToolGroup
        blocks={[
          { type: 'tool', callId: 'a', name: 'read_file', input: { path: 'a.docx' }, state: 'done' },
          { type: 'tool', callId: 'b', name: 'write_file', input: undefined, state: 'pending' },
          { type: 'tool', callId: 'c', name: 'run_command', input: { command: 'Get-Item .' }, state: 'running' },
        ]}
      />,
    );
    fireEvent.click(screen.getAllByRole('button')[0]!);
    expect([...document.querySelectorAll('.tool-item-head .tool-text')].map((e) => e.textContent)).toEqual(['Read a.docx', 'Writing a file', 'Running Get-Item .']);
  });
});

describe('the innermost level', () => {
  it('a command opens to the command as written ($, coloured, copyable) and what it printed', () => {
    render(
      <ToolCardsContext.Provider value={{}}>
        <ToolGroup
          blocks={[
            { type: 'tool', callId: 'a', name: 'run_command', input: { command: 'Get-ChildItem *.xlsx' }, summary: '列出报价表', state: 'done', durationMs: 300, result: '报价.xlsx' },
            { type: 'tool', callId: 'b', name: 'spawn_agent', input: { title: '整理报价', task: '把四家报价整理成表' }, state: 'done', result: 'started s-1' },
          ]}
        />
      </ToolCardsContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ran a command, started a sub-agent/ }));
    fireEvent.click(screen.getByRole('button', { name: /Ran 列出报价表/ }));
    expect(document.querySelector('.tool-command pre')?.textContent).toBe('$ Get-ChildItem *.xlsx');
    expect(document.querySelector('.tool-command .hl-built_in, .tool-command [class^="hl-"]')).toBeTruthy();
    expect(document.querySelector('.tool-result')?.textContent).toBe('报价.xlsx');
    expect(screen.getAllByRole('button', { name: '复制' }).length).toBe(1);
    // A step that is not a command: its arguments and its result as plain text, no code box.
    fireEvent.click(screen.getByRole('button', { name: /Started 「整理报价」/ }));
    expect(document.querySelectorAll('.tool-command').length).toBe(1);
    expect(document.querySelector('.tool-args')?.textContent).toBe('title: 整理报价\ntask: 把四家报价整理成表');
  });
});
