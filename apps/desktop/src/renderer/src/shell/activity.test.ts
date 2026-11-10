import { describe, expect, it } from 'vitest';
import { activityText } from './activity';

describe('activityText', () => {
  it('says each kind of project activity in plain Chinese', () => {
    expect(activityText({ action: 'file.write', target: 'kickoff.md' })).toBe('写入 kickoff.md');
    expect(activityText({ action: 'file.edit', target: 'docs/plan.md' })).toBe('修改 docs/plan.md');
    expect(activityText({ action: 'file.delete', target: 'old.txt' })).toBe('删除 old.txt');
    expect(activityText({ action: 'command', target: 'npm test' })).toBe('运行 npm test');
    expect(activityText({ action: 'note', target: '办公室搬迁报价', detail: 'outlook:mock-015' })).toBe('收到来信「办公室搬迁报价」');
    expect(activityText({ action: 'child.spawn', target: '整理报价' })).toBe('创建子任务「整理报价」');
    expect(activityText({ action: 'child.report', target: '整理报价', detail: '三家都回价了' })).toBe('子任务「整理报价」回报：三家都回价了');
    expect(activityText({ action: 'decision', detail: '选北方零件' })).toBe('决定：选北方零件');
    expect(activityText({ action: 'stage', target: '试产' })).toBe('进入阶段「试产」');
    expect(activityText({ action: 'note', detail: '周四开会' })).toBe('记录：周四开会');
  });

  it('still reads when a field is missing', () => {
    expect(activityText({ action: 'file.write' })).toBe('写入一个文件');
    expect(activityText({ action: 'decision' })).toBe('决定');
    expect(activityText({ action: 'child.report' })).toBe('子任务回报');
    // Older entries without `action`.
    expect(activityText({ kind: 'file_write', path: 'kickoff.md' } as never)).toBe('写入 kickoff.md');
  });
});
