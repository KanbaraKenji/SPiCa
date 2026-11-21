// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { HistoryCardMeta } from '@spica/protocol';
import { OpenSessionContext, HistoryCardsContext, HistoryRefContext, MarkdownText, AskCard, askQuestionParts, ConfirmCard, FileCards, RoundDoneContext, SuggestCard, ToolGroup } from './Blocks';

afterEach(cleanup);

describe('AskCard', () => {
  const block = { type: 'ask' as const, callId: 'c1', question: '纪要按哪种口径写？', options: ['只写结论', '按议题逐条写'] };
  const ok = () => screen.getByRole('button', { name: '确定' }) as HTMLButtonElement;

  it('one option: choosing it sends nothing; 确定 sends it', () => {
    const onAnswer = vi.fn();
    render(<AskCard block={block} onAnswer={onAnswer} />);
    expect(ok().disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /只写结论/ }));
    fireEvent.click(screen.getByRole('radio', { name: /按议题逐条写/ }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect((screen.getByRole('radio', { name: /只写结论/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(ok());
    expect(onAnswer).toHaveBeenCalledWith('按议题逐条写');
  });

  it('words of one’s own: typing chooses the row to type in (instead of an option); Enter sends them', () => {
    const onAnswer = vi.fn();
    render(<AskCard block={block} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('radio', { name: /只写结论/ }));
    const box = screen.getByRole('textbox', { name: '输入回答' });
    fireEvent.change(box, { target: { value: '写简短一点' } });
    expect((screen.getByRole('radio', { name: '其他' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /只写结论/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.submit(box.closest('form')!);
    expect(onAnswer).toHaveBeenCalledWith('写简短一点');
  });

  it('Enter on a chosen option sends it, once', () => {
    const onAnswer = vi.fn();
    render(<AskCard block={block} onAnswer={onAnswer} />);
    const r = screen.getByRole('radio', { name: /按议题逐条写/ });
    fireEvent.click(r);
    fireEvent.keyDown(r, { key: 'Enter' });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('按议题逐条写');
  });

  it('a question with no options: the box and 确定', () => {
    const onAnswer = vi.fn();
    render(<AskCard block={{ ...block, options: [] }} onAnswer={onAnswer} />);
    expect(screen.queryByRole('radio')).toBeNull();
    // no empty list above the box
    expect(document.querySelector('.ask-options')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '输入回答' }), { target: { value: '周三' } });
    fireEvent.click(ok());
    expect(onAnswer).toHaveBeenCalledWith('周三');
  });

  it('stopped while it waited: 已中断 where the answer goes, nothing to click', () => {
    const onAnswer = vi.fn();
    render(<AskCard block={{ ...block, cancelled: true }} onAnswer={onAnswer} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('.ask-card.is-done .ask-done-answer')?.textContent).toBe('已中断');
    // red (the colour of 无法撤销), its mark too: marked is-stopped; an answer is not
    expect(document.querySelector('.ask-card.is-done')?.classList.contains('is-stopped')).toBe(true);
    expect(document.querySelector('.ask-card .ask-done-mark .spica-status-icon')).toBeTruthy();
  });

  it('takes one answer: after 确定 everything is off until the card closes', () => {
    const onAnswer = vi.fn();
    render(<AskCard block={block} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('radio', { name: /只写结论/ }));
    fireEvent.click(ok());
    fireEvent.click(ok());
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('radio', { name: /按议题逐条写/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('textbox', { name: '输入回答' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('answered: the mark, the question’s first line (in full on hover) and the answer under it; nothing to click', () => {
    const question = '订会议室还缺几项信息：\n- 日期\n- 人数';
    const { rerender } = render(<AskCard block={{ ...block, question }} onAnswer={vi.fn()} />);
    expect(document.querySelector('.ask-card .ask-options')).toBeTruthy();
    rerender(<AskCard block={{ ...block, question, answer: '只写结论' }} onAnswer={vi.fn()} />);
    const title = document.querySelector('.ask-card.is-done .ask-done-title')!;
    // its colon dropped (it led into the list, now not shown); the full question on hover
    expect(title.textContent).toBe('订会议室还缺几项信息');
    expect(title.getAttribute('title')).toBe(question);
    // the mark first, then the question and under it the answer (not at the question's right end)
    const done = document.querySelector('.ask-card.is-done')!;
    expect([...done.children].map((c) => c.className)).toEqual(['ask-done-mark', 'ask-done-text']);
    expect([...done.querySelector('.ask-done-text')!.children].map((c) => c.className)).toEqual(['ask-done-title', 'ask-done-answer']);
    const answer = done.querySelector('.ask-done-answer')!;
    expect(answer.textContent).toBe('只写结论');
    expect(answer.getAttribute('title')).toBe('只写结论');
    expect(done.classList.contains('is-stopped')).toBe(false);
    expect(document.querySelector('.ask-card .ask-options')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('the question: its first line apart (the title’s weight), the rest as Markdown, single line breaks kept', () => {
    render(<AskCard block={{ ...block, question: '订会议室还缺几项信息：\n- 日期和时段\n- 人数' }} onAnswer={vi.fn()} />);
    expect(document.querySelector('.ask-head')?.textContent).toBe('订会议室还缺几项信息：');
    expect([...document.querySelectorAll('.ask-rest ul > li')].map((li) => li.textContent)).toEqual(['日期和时段', '人数']);
    cleanup();
    // numbered by the model itself (full-width 1）, no list marker): shown as written, a line each
    render(<AskCard block={{ ...block, question: '还缺几项：\n1）日期\n2）人数' }} onAnswer={vi.fn()} />);
    expect(document.querySelector('.ask-head')?.textContent).toBe('还缺几项：');
    const p = document.querySelector('.ask-rest p')!;
    expect(p.querySelectorAll('br')).toHaveLength(1);
    expect(p.textContent?.replace(/\n/g, '')).toBe('1）日期2）人数');
    cleanup();
    // a loose list and a nested one: no line breaks of their own
    render(<AskCard block={{ ...block, question: '还缺几项：\n\n1. 日期\n\n2. 地点：\n   - 楼层\n   - 朝向' }} onAnswer={vi.fn()} />);
    const q = document.querySelector('.ask-rest')!;
    expect(q.querySelectorAll('br')).toHaveLength(0);
    expect(q.querySelectorAll('ol > li')).toHaveLength(2);
    expect([...q.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(['楼层', '朝向']);
    cleanup();
    // one line: all of it the head
    render(<AskCard block={block} onAnswer={vi.fn()} />);
    expect(document.querySelector('.ask-head')?.textContent).toBe('纪要按哪种口径写？');
    expect(document.querySelector('.ask-rest')).toBeNull();
  });

  it('确定 on a row of its own, not in the row to type in', () => {
    render(<AskCard block={block} onAnswer={vi.fn()} />);
    const ok = screen.getByRole('button', { name: '确定' });
    expect(ok.closest('.ask-other')).toBeNull();
    expect(ok.parentElement?.classList.contains('ask-foot')).toBe(true);
  });

  it('askQuestionParts: a first line that is a list item is no head', () => {
    expect(askQuestionParts('- 日期\n- 人数')).toEqual({ head: '', rest: '- 日期\n- 人数' });
    expect(askQuestionParts('缺：\n\n- 日期')).toEqual({ head: '缺：', rest: '- 日期' });
    expect(askQuestionParts('1）日期\n2）人数').head).toBe('');
    // no space after a half-width marker: no list item, the line is the head
    expect(askQuestionParts('**会议室**还缺：\n- 日期').head).toBe('**会议室**还缺：');
    expect(askQuestionParts('1.5 倍行距还是单倍？\n- 正文').head).toBe('1.5 倍行距还是单倍？');
  });

  it('answers keep Markdown’s soft line breaks (lineBreaks is the question card’s)', () => {
    render(<MarkdownText text={'一行\n两行'} />);
    expect(document.querySelectorAll('.md br')).toHaveLength(0);
  });

  it('options numbered in order, one a row, then the row to type in; 建议 on the suggested one only', () => {
    render(<AskCard block={{ ...block, options: ['只写结论', '结论加讨论过程', '按议题逐条写'], recommended: '结论加讨论过程' }} onAnswer={vi.fn()} />);
    expect([...document.querySelectorAll('.ask-option-n')].map((n) => n.textContent)).toEqual(['1', '2', '3', '4']);
    expect([...document.querySelectorAll('.ask-options > li')].map((li) => li.querySelector('.ask-option-tag')?.textContent ?? null)).toEqual([null, '建议', null]);
    // the row to type in is the app's own field (bordered), not a line under the words
    expect(screen.getByRole('textbox', { name: '输入回答' }).classList.contains('input')).toBe(true);
    // nothing chosen beforehand, the suggested one neither
    expect(screen.getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false);
  });

  it('no suggested option (or one stored before there were any): no 建议', () => {
    render(<AskCard block={block} onAnswer={vi.fn()} />);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(document.querySelector('.ask-option-tag')).toBeNull();
  });

  it('answering the suggested option sends the option only (not 建议)', () => {
    const onAnswer = vi.fn();
    render(<AskCard block={{ ...block, recommended: '按议题逐条写' }} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('radio', { name: /按议题逐条写/ }));
    fireEvent.click(ok());
    expect(onAnswer).toHaveBeenCalledWith('按议题逐条写');
  });

  describe('several may be chosen (multiSelect)', () => {
    const multi = { ...block, options: ['本周完成的事', '下周计划', '数据和图表'], multiSelect: true };

    it('options tick and untick; 确定 sends the ticked ones in their order, one a line, with the box’s words', () => {
      const onAnswer = vi.fn();
      render(<AskCard block={multi} onAnswer={onAnswer} />);
      expect(ok().disabled).toBe(true);
      fireEvent.click(screen.getByRole('checkbox', { name: /数据和图表/ }));
      fireEvent.click(screen.getByRole('checkbox', { name: /本周完成的事/ }));
      fireEvent.click(screen.getByRole('checkbox', { name: /下周计划/ }));
      fireEvent.click(screen.getByRole('checkbox', { name: /下周计划/ }));
      expect(onAnswer).not.toHaveBeenCalled();
      expect((screen.getByRole('checkbox', { name: /本周完成的事/ }) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByRole('checkbox', { name: /下周计划/ }) as HTMLInputElement).checked).toBe(false);
      fireEvent.change(screen.getByRole('textbox', { name: '输入回答' }), { target: { value: '加一段客户反馈' } });
      expect((screen.getByRole('checkbox', { name: '其他' }) as HTMLInputElement).checked).toBe(true);
      fireEvent.click(ok());
      expect(onAnswer).toHaveBeenCalledWith('本周完成的事\n数据和图表\n加一段客户反馈');
    });

    it('the box emptied: its row off again, the ticked ones only', () => {
      const onAnswer = vi.fn();
      render(<AskCard block={multi} onAnswer={onAnswer} />);
      fireEvent.click(screen.getByRole('checkbox', { name: /下周计划/ }));
      const box = screen.getByRole('textbox', { name: '输入回答' });
      fireEvent.change(box, { target: { value: '加' } });
      fireEvent.change(box, { target: { value: '' } });
      expect((screen.getByRole('checkbox', { name: '其他' }) as HTMLInputElement).checked).toBe(false);
      fireEvent.click(ok());
      expect(onAnswer).toHaveBeenCalledWith('下周计划');
    });

    it('answered: the chosen ones on one line', () => {
      render(<AskCard block={{ ...multi, answer: '本周完成的事\n数据和图表' }} onAnswer={vi.fn()} />);
      expect(document.querySelector('.ask-card .ask-done-answer')?.textContent).toBe('本周完成的事、数据和图表');
    });

    it('a single-choice card (or one stored before multiSelect) has round marks, no boxes', () => {
      render(<AskCard block={block} onAnswer={vi.fn()} />);
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.getAllByRole('radio').length).toBeGreaterThan(0);
    });
  });
});

describe('ConfirmCard', () => {
  describe('a write outside the conversation’s folders', () => {
    const block = { type: 'confirm' as const, callId: 'c9', name: 'edit_file', input: { path: 'D:\\共享资料\\纪要\\会议纪要.md', old_string: 'a', new_string: 'b' }, reason: 'outside', cause: 'outside_folder' as const, outsideFolder: 'D:\\共享资料\\纪要' };
    const card = () => {
      const onDecide = vi.fn();
      render(<ConfirmCard block={block} onDecide={onDecide} />);
      return { onDecide, always: screen.getByRole('button', { name: '始终允许' }), more: screen.getByRole('button', { name: '更多选项' }) };
    };

    it('工作文件夹以外 as a tag; 拒绝, then 始终允许 (blue) and its arrow as one button; the hover on 始终允许 is the folder', () => {
      const { always, more } = card();
      expect(document.querySelector('.confirm-undo')?.textContent).toBe('工作文件夹以外');
      expect(document.querySelector('.confirm-card.is-danger')).toBeNull();
      expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['拒绝', '始终允许', '']);
      expect(screen.getByRole('button', { name: '拒绝' }).className).toBe('btn');
      expect(always.className).toBe('btn btn-primary allow-split-main');
      expect(always.parentElement).toBe(more.parentElement);
      expect(always.getAttribute('title')).toBe(block.outsideFolder);
      expect(more.getAttribute('aria-haspopup')).toBe('menu');
      expect(more.getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
    });

    it('a click on 始终允许: that folder from now on', () => {
      const { onDecide, always } = card();
      fireEvent.click(always);
      expect(onDecide.mock.calls).toEqual([[true, true]]);
    });

    it('the arrow opens a menu with 允许一次 alone (this once); a second press closes it', () => {
      const { onDecide, more } = card();
      fireEvent.click(more);
      expect(more.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['允许一次']);
      expect(document.activeElement?.textContent).toBe('允许一次');
      fireEvent.click(more);
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.click(more);
      fireEvent.click(screen.getByRole('menuitem', { name: '允许一次' }));
      expect(onDecide.mock.calls).toEqual([[true]]);
    });

    it('Alt+Down on 始终允许 opens the same menu; Esc closes it without deciding', () => {
      const { onDecide, always } = card();
      fireEvent.keyDown(always, { key: 'ArrowDown', altKey: true });
      expect(screen.getByRole('menu')).not.toBeNull();
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(onDecide).not.toHaveBeenCalled();
    });

    it('a command writing outside (Auto): the path marked in the command; run in a folder outside, that folder under it', () => {
      const folder = 'D:\\共享资料\\纪要';
      const cmd = { type: 'confirm' as const, callId: 'c10', name: 'run_command', input: { command: `Set-Content -Path '${folder}\\周会汇总.md' -Value x` }, reason: 'outside', cause: 'outside_folder' as const, outsideFolder: folder };
      render(<ConfirmCard block={cmd} onDecide={vi.fn()} />);
      // Set-Content overwrites: 无法撤销 too, as for any such command
      expect([...document.querySelectorAll('.confirm-undo')].map((x) => x.textContent)).toContain('工作文件夹以外');
      expect([...document.querySelectorAll('mark.cmd-danger')].map((m) => m.textContent)).toContain(`${folder}\\周会汇总.md`);
      expect(document.querySelector('.card-why')).toBeNull();
      expect(document.querySelector('.allow-split')).not.toBeNull();
      cleanup();
      render(<ConfirmCard block={{ ...cmd, input: { command: "Set-Content a.md x", cwd: folder } }} onDecide={vi.fn()} />);
      expect([...document.querySelectorAll('mark.cmd-danger')].map((m) => m.textContent)).not.toContain(folder);
      expect(document.querySelector('.card-why')?.textContent).toBe(`起始文件夹：${folder}`);
    });

    it('an ordinary confirmation keeps its blue 允许 alone', () => {
      render(<ConfirmCard block={{ ...block, outsideFolder: undefined, cause: undefined }} onDecide={vi.fn()} />);
      expect(screen.getByRole('button', { name: '允许' }).className).toBe('btn btn-primary');
      expect(document.querySelector('.allow-split')).toBeNull();
    });

    it('a drive’s root or the home folder (never kept): still outside, but 允许 alone, this once', () => {
      const onDecide = vi.fn();
      render(<ConfirmCard block={{ ...block, outsideFolder: 'D:\\', folderTooWide: true }} onDecide={onDecide} />);
      expect(screen.getByText('工作文件夹以外')).toBeTruthy();
      expect(document.querySelector('.allow-split')).toBeNull();
      expect(screen.queryByRole('button', { name: '始终允许' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '允许' }));
      expect(onDecide.mock.calls).toEqual([[true]]);
    });
  });

  it('a download for the app’s Python: what, from where, how big, and the total; — where the size is not known, and then no total', () => {
    const install = {
      python: { version: '3.12.16', host: 'releases.astral.sh', bytes: 31 * 1024 * 1024 },
      packages: [
        { name: 'pandas', version: '2.3.3', bytes: 11 * 1024 * 1024 },
        { name: 'numpy', version: '2.3.4', bytes: 12.8 * 1024 * 1024 },
      ],
      packageHost: 'pypi.org',
    };
    const block = { type: 'confirm' as const, callId: 'p1', name: 'python_env', input: { packages: ['pandas'] }, reason: '', cause: 'python_install' as const, install };
    render(<ConfirmCard block={block} onDecide={vi.fn()} />);
    expect(document.querySelector('.card-title')?.textContent).toBe('下载 Python 3.12.16 和 2 个库');
    const rows = [...document.querySelectorAll('.download-row')].map((r) => [...r.children].map((c) => c.textContent));
    expect(rows).toEqual([
      ['Python 3.12.16', 'releases.astral.sh', '31 MB'],
      ['pandas 2.3.3', 'pypi.org', '11 MB'],
      ['numpy 2.3.4', 'pypi.org', '12.8 MB'],
      ['合计', '', '54.8 MB'],
    ]);
    // no arguments box, no explanation line
    expect(document.querySelector('.tool-args')).toBeNull();
    expect(document.querySelector('.card-why')).toBeNull();
    cleanup();
    // the first time: Python known, the packages asked for by name only; no total
    cleanup();
    render(<ConfirmCard block={{ ...block, install: { python: install.python, packages: [{ name: 'pandas' }, { name: 'openpyxl' }], packageHost: 'pypi.org' } }} onDecide={vi.fn()} />);
    expect(document.querySelector('.card-title')?.textContent).toBe('下载 Python 3.12.16 和 2 个库');
    expect([...document.querySelectorAll('.download-row')].map((r) => [...r.children].map((c) => c.textContent))).toEqual([
      ['Python 3.12.16', 'releases.astral.sh', '31 MB'],
      ['pandas', 'pypi.org', '—'],
      ['openpyxl', 'pypi.org', '—'],
    ]);
    cleanup();
    // later: packages only; one size unknown
    render(<ConfirmCard block={{ ...block, install: { packages: [{ name: 'openpyxl', version: '3.1.5', bytes: 250 * 1024 }, { name: 'et-xmlfile' }], packageHost: 'pypi.example.com' } }} onDecide={vi.fn()} />);
    expect(document.querySelector('.card-title')?.textContent).toBe('安装 2 个库');
    const later = [...document.querySelectorAll('.download-row')].map((r) => [...r.children].map((c) => c.textContent));
    expect(later).toEqual([
      ['openpyxl 3.1.5', 'pypi.example.com', '250 KB'],
      ['et-xmlfile', 'pypi.example.com', '—'],
    ]);
  });

  it('an ordinary one has no mark before its title, in every state; a dangerous one keeps the warning and 无法撤销', () => {
    const mail = { type: 'confirm' as const, callId: 'c5', name: 'send_email', input: {}, reason: '发送邮件给「项目组」' };
    for (const state of [{}, { approved: true }, { approved: false }, { cancelled: true }]) {
      render(<ConfirmCard block={{ ...mail, ...state }} onDecide={vi.fn()} />);
      const head = document.querySelector('.confirm-card > .card-head')!;
      expect(head.firstElementChild?.className, JSON.stringify(state)).toBe('card-title');
      cleanup();
    }
    render(<ConfirmCard block={{ type: 'confirm', callId: 'c6', name: 'run_command', input: { command: 'Remove-Item D:\\工作 -Recurse -Force' }, reason: '运行命令' }} onDecide={vi.fn()} />);
    const head = document.querySelector('.confirm-card.is-danger > .card-head')!;
    expect(head.firstElementChild?.getAttribute('data-status')).toBe('warning');
    expect(head.querySelector('.confirm-undo')?.textContent).toBe('无法撤销');
  });

  it('a reason on two lines: the title, then a grey second line (whole on hover); 无法撤销 and the buttons where they were', () => {
    render(<ConfirmCard block={{ type: 'confirm', callId: 'c8', name: 'browser_click', input: { ref: 4 }, reason: '提交表单\n127.0.0.1:47841 · 「提交登记」', irreversible: true }} onDecide={vi.fn()} />);
    const head = document.querySelector('.confirm-card > .card-head')!;
    expect(head.querySelector('.card-title')?.textContent).toBe('提交表单');
    // the second line under the head, not in it
    const sub = document.querySelector('.confirm-card > .card-sub')!;
    expect(head.nextElementSibling).toBe(sub);
    expect(sub.textContent).toBe('127.0.0.1:47841 · 「提交登记」');
    expect(sub.getAttribute('title')).toBe('127.0.0.1:47841 · 「提交登记」');
    // the head as on every card: the mark, the title, 无法撤销, the spacer, the buttons
    expect([...head.children].map((c) => (c.tagName === 'svg' ? 'warning' : c.getAttribute('class')))).toEqual(['warning', 'card-title', 'confirm-undo', 'confirm-spacer', 'card-actions']);
    // the browser's element number is not shown
    expect(document.querySelector('.confirm-card')!.textContent).not.toContain('ref');
  });

  it('a reason on one line: no second line, the title straight in the head as before', () => {
    render(<ConfirmCard block={{ type: 'confirm', callId: 'c9', name: 'send_email', input: {}, reason: '发送邮件给「项目组」' }} onDecide={vi.fn()} />);
    const head = document.querySelector('.confirm-card > .card-head')!;
    expect(document.querySelector('.confirm-card .card-sub')).toBeNull();
    expect(head.firstElementChild?.className).toBe('card-title');
  });

  it('a plugin step marked irreversible: the warning and 无法撤销, its reason as the title; unmarked, neither', () => {
    const step = { type: 'confirm' as const, callId: 'c7', name: 'notes__write_note', input: { title: '周会' }, reason: '覆盖笔记「周会」' };
    render(<ConfirmCard block={{ ...step, irreversible: true }} onDecide={vi.fn()} />);
    const head = document.querySelector('.confirm-card.is-danger > .card-head')!;
    expect(head.firstElementChild?.getAttribute('data-status')).toBe('warning');
    expect(head.querySelector('.card-title')?.textContent).toBe('覆盖笔记「周会」');
    expect(head.querySelector('.confirm-undo')?.textContent).toBe('无法撤销');
    cleanup();
    // a declared irreversible tool: the reason names the plugin and the tool
    render(<ConfirmCard block={{ ...step, name: 'notes__delete_note', reason: '「Notes (example)」：delete_note', irreversible: true }} onDecide={vi.fn()} />);
    expect(document.querySelector('.card-title')?.textContent).toBe('「Notes (example)」：delete_note');
    expect(document.querySelector('.confirm-undo')).toBeTruthy();
    cleanup();
    render(<ConfirmCard block={step} onDecide={vi.fn()} />);
    expect(document.querySelector('.confirm-card.is-danger')).toBeNull();
    expect(document.querySelector('.confirm-undo')).toBeNull();
  });

  it('stopped while it waited: 已中断, no 拒绝 / 允许; one decision only', () => {
    const block = { type: 'confirm' as const, callId: 'c4', name: 'send_email', input: {}, reason: '发送邮件给「项目组」' };
    render(<ConfirmCard block={{ ...block, cancelled: true }} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
    expect(document.querySelector('.confirm-card.is-done .card-answer')?.textContent).toBe('已中断');
    expect(document.querySelector('.confirm-card .card-answer')?.classList.contains('is-stopped')).toBe(true);
    cleanup();
    // 已允许 and the user's own 已拒绝 stay grey
    for (const approved of [true, false]) {
      render(<ConfirmCard block={{ ...block, approved }} onDecide={vi.fn()} />);
      expect(document.querySelector('.confirm-card .card-answer')?.classList.contains('is-stopped'), String(approved)).toBe(false);
      cleanup();
    }
    cleanup();
    const onDecide = vi.fn();
    render(<ConfirmCard block={block} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

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

  it('a command that cannot be taken back: what it does in the title row, 无法撤销, the dangerous words marked', () => {
    const command = "Get-ChildItem 'D:\\工作\\样机评审' | Measure-Object; Remove-Item 'D:\\工作\\样机评审' -Recurse -Force";
    const onDecide = vi.fn();
    render(<ConfirmCard block={{ type: 'confirm', callId: 'c5', name: 'run_command', input: { command, description: '整理旧的报价文件' }, reason: '运行命令' }} onDecide={onDecide} />);
    const card = document.querySelector('.confirm-card')!;
    expect(card.classList.contains('is-danger')).toBe(true);
    const head = card.querySelector('.card-head')!;
    expect(head.querySelector('.card-title')?.textContent).toBe('删除 D:\\工作\\样机评审（含其中所有内容）');
    expect(head.querySelector('.confirm-undo')?.textContent).toBe('无法撤销');
    // 拒绝 and 允许 are in the same row as what is being confirmed; copy is in the command's box, at its top right
    // (in the title row it read as copying the title).
    expect(head.querySelector('.md-tool')).toBeNull();
    expect([...head.querySelectorAll('.card-actions button')].map((b) => b.textContent)).toEqual(['拒绝', '允许']);
    expect([...card.querySelectorAll('.cmd-danger')].map((m) => m.textContent)).toEqual(['Remove-Item', '-Recurse', '-Force']);
    expect(card.querySelector('.tool-command.is-bare .tool-command-box > .tool-command-copy')?.getAttribute('aria-label')).toBe('复制');
    expect(screen.queryByText(/整理旧的报价文件/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onDecide).toHaveBeenCalledWith(false);
  });

  it('a command that changes nothing it cannot take back: 运行命令, no 无法撤销, the command coloured as usual', () => {
    const command = "python 导出各家报价.py --out './报价' 2>&1";
    render(<ConfirmCard block={{ type: 'confirm', callId: 'c6', name: 'run_command', input: { command }, reason: '运行命令' }} onDecide={vi.fn()} />);
    const card = document.querySelector('.confirm-card')!;
    expect(card.classList.contains('is-danger')).toBe(false);
    expect(card.querySelector('.card-title')?.textContent).toBe('运行命令');
    expect(card.querySelector('.confirm-undo')).toBeNull();
    expect(card.querySelector('.cmd-danger')).toBeNull();
    expect(card.querySelector('.tool-command pre')?.textContent).toBe(`$ ${command}`);
  });

  it('decided: what was decided in place of the buttons, the card back to quiet', () => {
    const command = 'Remove-Item a.txt';
    render(<ConfirmCard block={{ type: 'confirm', callId: 'c7', name: 'run_command', input: { command }, reason: '运行命令', approved: true }} onDecide={vi.fn()} />);
    const card = document.querySelector('.confirm-card')!;
    expect(card.classList.contains('is-done')).toBe(true);
    expect(card.querySelector('.card-head .card-answer')?.textContent).toBe('已允许');
    expect(card.querySelector('.card-actions')).toBeNull();
  });

  it('a write: what it would change, numbered, green in and red out, before it is allowed; a new file all green', () => {
    const change = { path: 'D:/work/a.txt', created: false, change: { hunks: [{ oldStart: 1, newStart: 1, lines: [' one', '-two', '+TWO'] }] } };
    const { unmount } = render(<ConfirmCard block={{ type: 'confirm', callId: 'w1', name: 'edit_file', input: { path: 'a.txt', old_string: 'two', new_string: 'TWO' }, reason: '修改文件', change }} onDecide={vi.fn()} />);
    expect(document.querySelector('.confirm-card .file-change-path')?.textContent).toBe('D:/work/a.txt');
    const lines = [...document.querySelectorAll('.confirm-card .change-line')].map((l) => [l.className.replace('change-line is-', ''), l.querySelector('.change-gutter')?.textContent, l.querySelector('.change-text')?.textContent]);
    expect(lines).toEqual([
      ['same', '1', 'one'],
      ['out', '2', 'two'],
      ['in', '2', 'TWO'],
    ]);
    unmount();
    render(<ConfirmCard block={{ type: 'confirm', callId: 'w2', name: 'write_file', input: { path: 'b.txt', content: 'x\ny' }, reason: '写入文件', change: { path: 'D:/work/b.txt', created: true } }} onDecide={vi.fn()} />);
    expect([...document.querySelectorAll('.confirm-card .change-line')].map((l) => l.className)).toEqual(['change-line is-in', 'change-line is-in']);
  });

  it('other calls: their arguments in full, under names people read', () => {
    const body = '各位好，'.repeat(40);
    render(<ConfirmCard block={{ type: 'confirm', callId: 'c4', name: 'mail__send', input: { to: 'team@example.com', subject: '样机评审时间', body }, reason: '发送邮件' }} onDecide={vi.fn()} />);
    const rows = [...document.querySelectorAll('.confirm-card .tool-arg')].map((r) => [r.querySelector('.tool-arg-key')?.textContent, r.querySelector('.tool-arg-value, .tool-arg-block')?.textContent]);
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
    expect(rows.map((r) => r.querySelector('.fold-meta')?.textContent ?? '')).toEqual(['<1s', 'Failed', '已超时']);
    for (const r of rows) expect(r.querySelector('.fold-meta svg')).toBeNull();
    expect(rows.map((r) => r.querySelector('.fold-icon svg')?.getAttribute('data-status'))).toEqual(['done', 'error', 'stopped']);
  });

  it('while a call runs and the run is on it, the line says so: the turning mark first, Running (or Reading…) and the step, the run’s clock at the end', () => {
    const since = Date.now() - 47_000;
    const { rerender } = render(<ToolGroup blocks={[{ type: 'tool', callId: 'a', name: 'list_dir', input: { path: '.' }, state: 'running' }]} since={since} />);
    let head = screen.getByRole('button');
    expect(head.querySelector('.fold-icon .spica-mark')).toBeTruthy();
    expect(head.querySelector('.fold-label')?.textContent).toBe('Listing the working folder');
    expect(head.lastElementChild?.textContent).toBe('47s');
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
    expect(head.lastElementChild?.textContent).toBe('47s');
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

describe('tool times once the round is over', () => {
  const blocks = [
    { type: 'tool' as const, callId: 'a', name: 'list_dir', input: { path: '.' }, state: 'done' as const, durationMs: 4200 },
    { type: 'tool' as const, callId: 'b', name: 'read_file', input: { path: 'a.docx' }, state: 'timeout' as const },
    { type: 'tool' as const, callId: 'c', name: 'read_file', input: { path: 'b.docx' }, state: 'done' as const, durationMs: 800, autoApproved: true },
  ];
  const metas = () => [...document.querySelectorAll('.fold-meta')].map((m) => m.textContent);

  it('while the round goes on: each finished step and the group keep their time', () => {
    render(<ToolGroup blocks={blocks} />);
    expect(metas()).toEqual(['5s']);
    fireEvent.click(screen.getByRole('button', { name: /Listed a folder/ }));
    expect(metas()).toEqual(['5s', '4s', '已超时', 'Auto · <1s']);
  });

  it('the round over: no time after the group, its steps, or a call alone; what is not a time stays', () => {
    render(
      <RoundDoneContext.Provider value={true}>
        <ToolGroup blocks={blocks} />
        <ToolGroup blocks={[blocks[0]!]} />
      </RoundDoneContext.Provider>,
    );
    expect(metas()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /Listed a folder, read 2 files/ }));
    expect(metas()).toEqual(['已超时', 'Auto']);
  });
});

describe('files under an answer: cards when few, a list when many', () => {
  const at = '2026-11-12T10:00:00+08:00';
  const file = (i: number, ext = 'pdf') => {
    const path = `D:\\规格书\\料号${String(i).padStart(2, '0')}.${ext}`;
    const name = path.split('\\').pop()!;
    return { path, tool: 'run_command', category: 'command' as const, card: { path, name, kind: (ext === 'pdf' ? 'pdf' : 'other') as 'pdf' | 'other', sizeBytes: 1, modifiedAt: at, extractedAt: at, read: {}, origin: 'created' as const, ...(ext === 'pdf' ? { pageCount: 4 } : {}) } };
  };
  const files = (n: number) => Array.from({ length: n }, (_, i) => file(i + 1, i === 2 ? 'png' : 'pdf'));
  const actions = { reveal: vi.fn(), imageUrl: async () => 'blob:x' };

  it('up to 4: cards, as before', () => {
    render(<FileCards files={files(4)} onOpen={vi.fn()} actions={actions} />);
    expect(document.querySelectorAll('.file-card')).toHaveLength(4);
    expect(document.querySelector('.file-list')).toBeNull();
  });

  it('5 or more: one a line (icon and name, what it is, what was done, the two buttons); a click opens it as a card does', () => {
    const onOpen = vi.fn();
    render(<FileCards files={files(5)} onOpen={onOpen} actions={actions} />);
    expect(document.querySelector('.file-card')).toBeNull();
    const rows = [...document.querySelectorAll('.file-list .file-row')];
    expect(rows).toHaveLength(5);
    expect(rows[0]!.querySelector('.file-row-text')?.textContent).toBe('料号01.pdf');
    expect(rows[0]!.querySelector('.file-row-kind')?.textContent).toBe('PDF · 4 页');
    expect(rows[0]!.querySelector('.file-row-did')?.textContent).toBe('Created while the command ran');
    // A picture shows its icon only, no small picture.
    expect(rows[2]!.querySelector('img')).toBeNull();
    expect(rows[2]!.querySelector('svg')).toBeTruthy();
    fireEvent.click(rows[1]!.querySelector('.file-row-main')!);
    expect(onOpen).toHaveBeenCalledWith('D:\\规格书\\料号02.pdf');
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: '打开所在文件夹' }));
    expect(actions.reveal).toHaveBeenCalledWith('D:\\规格书\\料号02.pdf');
  });

  it('more than 10: the first 8, then 全部 N 个 and 收起', () => {
    render(<FileCards files={files(14)} onOpen={vi.fn()} actions={actions} />);
    expect(document.querySelectorAll('.file-row')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: '全部 14 个' }));
    expect(document.querySelectorAll('.file-row')).toHaveLength(14);
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(document.querySelectorAll('.file-row')).toHaveLength(8);
    cleanup();
    render(<FileCards files={files(10)} onOpen={vi.fn()} actions={actions} />);
    expect(document.querySelectorAll('.file-row')).toHaveLength(10);
    expect(screen.queryByRole('button', { name: /全部/ })).toBeNull();
  });
});
