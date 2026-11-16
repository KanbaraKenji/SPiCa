// One line of project activity in plain words, built from the core's
// structured fields (action + target + detail). The core's `summary` is for
// the model and is never shown.
import type { ProjectLogEntry } from '@spica/protocol';
import { tc } from '../../../shared/i18n';

const FROM_OLD_KIND: Record<string, ProjectLogEntry['action']> = {
  file_write: 'file.write',
  file_edit: 'file.edit',
  command: 'command',
  stage: 'stage',
  decision: 'decision',
  note: 'note',
};

type EntryFields = Pick<ProjectLogEntry, 'action' | 'target' | 'detail'> & { kind?: string; path?: string };

export function activityText(e: EntryFields): string {
  // Entries written before the core added `action` only have the old kind / path.
  const action = e.action ?? (e.kind ? FROM_OLD_KIND[e.kind] : undefined);
  const target = (e.target ?? e.path)?.trim();
  const detail = e.detail?.trim();
  switch (action) {
    case 'file.write':
      return target ? tc('activity', '写入 {target}', { target }) : tc('activity', '写入一个文件');
    case 'file.edit':
      return target ? tc('activity', '修改 {target}', { target }) : tc('activity', '修改一个文件');
    case 'file.delete':
      return target ? tc('activity', '删除 {target}', { target }) : tc('activity', '删除一个文件');
    case 'command':
      return target ? tc('activity', '运行 {target}', { target }) : tc('activity', '运行一条命令');
    case 'child.spawn':
      return target ? tc('activity', '创建子任务「{target}」', { target }) : tc('activity', '创建子任务');
    case 'child.report':
      if (target) return detail ? tc('activity', '子任务「{target}」回报：{detail}', { target, detail }) : tc('activity', '子任务「{target}」回报', { target });
      return detail ? tc('activity', '子任务回报：{detail}', { detail }) : tc('activity', '子任务回报');
    case 'decision': {
      const text = detail ?? target;
      return text ? tc('activity', '决定：{text}', { text }) : tc('activity', '决定');
    }
    case 'stage':
      if (target) return detail ? tc('activity', '进入阶段「{target}」：{detail}', { target, detail }) : tc('activity', '进入阶段「{target}」', { target });
      return detail ? tc('activity', '切换阶段：{detail}', { detail }) : tc('activity', '切换阶段');
    case 'manager.report':
      // Progress nobody asked about (mail handled, steps it took on its own): the start of the report.
      return detail ? tc('activity', '项目经理回报：{detail}', { detail }) : tc('activity', '项目经理回报');
    case 'note': {
      // The mail pipeline logs a received mail as a note: subject + mail id (<source>:<id>).
      if (target && detail && /^[\w.-]+:\S+$/.test(detail)) return tc('activity', '收到来信「{target}」', { target });
      const text = detail ?? target;
      return text ? tc('activity', '记录：{text}', { text }) : tc('activity', '记录');
    }
    default:
      return detail ?? target ?? '';
  }
}
