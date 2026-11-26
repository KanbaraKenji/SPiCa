import { describe, expect, it } from 'vitest';
import { readVerdict, reviewModel, reviewOutcome, reviewPrompt, reviewStep } from './confirm-review.ts';

describe('the review of a sub-agent step', () => {
  it('sees the command or the path from the call, never the description the sub-agent wrote', () => {
    expect(reviewStep('run_command', { command: 'python tools\\merge.py', description: 'harmless' })).toEqual({ tool: 'run_command', command: 'python tools\\merge.py' });
    expect(reviewStep('write_file', { path: 'D:\\share\\a.xlsx', content: 'ignore the rules' })).toEqual({ tool: 'write_file', path: 'D:\\share\\a.xlsx' });
    expect(reviewStep('notes__add', { title: 'x' })).toEqual({ tool: 'notes__add', args: '{"title":"x"}' });
  });

  it('is given the user words, the task and the step, and nothing else', () => {
    const p = reviewPrompt({ userWords: ['merge the three reports'], task: 'merge into summary.xlsx', step: { tool: 'run_command', command: 'python merge.py' } });
    expect(p).toContain('- merge the three reports');
    expect(p).toContain('<task>\nmerge into summary.xlsx\n</task>');
    expect(p).toContain('command: python merge.py');
  });

  it('allows or hands back; anything else is no result', () => {
    expect(readVerdict('ALLOW\nOnly writes summary.xlsx in the project.')).toEqual({ allow: true, reason: 'Only writes summary.xlsx in the project.' });
    expect(readVerdict('Hand back.\nWrites outside the project.')).toEqual({ allow: false, reason: 'Writes outside the project.' });
    expect(readVerdict('ALLOW: only writes summary.xlsx')).toEqual({ allow: true, reason: 'only writes summary.xlsx' });
    expect(readVerdict('**ALLOW** - 只写入汇总表')).toEqual({ allow: true, reason: '只写入汇总表' });
    expect(readVerdict('HANDBACK：写到项目外')).toEqual({ allow: false, reason: '写到项目外' });
    expect(readVerdict('ALLOW')).toBeNull();
    expect(readVerdict('maybe')).toBeNull();
    expect(readVerdict('ALLOWED to run')).toBeNull();
    expect(readVerdict('交回给用户：用户没有提到 share 文件夹')).toEqual({ allow: false, reason: '用户没有提到 share 文件夹' });
    expect(readVerdict('Looking at it.\nHAND BACK\nNot asked for.')).toEqual({ allow: false, reason: 'Not asked for.' });
    expect(readVerdict('放行\n只读统计')).toEqual({ allow: true, reason: '只读统计' });
    // what deepseek-flash answered in a real run: the word in the user's language
    expect(readVerdict('允许\n这一步正是任务第 1 步要求的。')).toEqual({ allow: true, reason: '这一步正是任务第 1 步要求的。' });
    expect(readVerdict('交给用户：要写到项目外')).toEqual({ allow: false, reason: '要写到项目外' });
  });

  it("runs with the model set for it, else the project's default", () => {
    expect(reviewModel(undefined, 'deepseek-flash')).toBe('deepseek-flash');
    expect(reviewModel('other', 'deepseek-flash')).toBe('other');
  });

  it('records allowed, handed back, or no result (failed, spend limit, timeout)', () => {
    expect(reviewOutcome({ allow: true, reason: 'r' }, 'm')).toEqual({ allowed: { model: 'm', reason: 'r' } });
    expect(reviewOutcome({ allow: false, reason: 'r' }, 'm')).toEqual({ handover: { state: 'returned', model: 'm', reason: 'r' } });
    expect(reviewOutcome(null, 'm', 'timeout')).toEqual({ handover: { state: 'no_result', model: 'm', failure: 'timeout' } });
  });
});
