// One line of project activity in plain Chinese, built from the core's
// structured fields (action + target + detail). The core's `summary` is for
// the model and is never shown.
import type { ProjectLogEntry } from '@spica/protocol';

const q = (s: string) => `「${s}」`;

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
  const t = (e.target ?? e.path)?.trim();
  const d = e.detail?.trim();
  switch (action) {
    case 'file.write':
      return t ? `写入 ${t}` : '写入一个文件';
    case 'file.edit':
      return t ? `修改 ${t}` : '修改一个文件';
    case 'file.delete':
      return t ? `删除 ${t}` : '删除一个文件';
    case 'command':
      return t ? `运行 ${t}` : '运行一条命令';
    case 'child.spawn':
      return t ? `创建子任务${q(t)}` : '创建子任务';
    case 'child.report':
      return `${t ? `子任务${q(t)}` : '子任务'}回报${d ? `：${d}` : ''}`;
    case 'decision':
      return `决定：${d ?? t ?? ''}`.replace(/：$/, '');
    case 'stage':
      return `${t ? `进入阶段${q(t)}` : '切换阶段'}${d ? `：${d}` : ''}`;
    case 'manager.report':
      // Progress nobody asked about (mail handled, steps it took on its own): the start of the report.
      return `项目经理回报${d ? `：${d}` : ''}`;
    case 'note':
      // The mail pipeline logs a received mail as a note: subject + mail id (<source>:<id>).
      if (t && d && /^[\w.-]+:\S+$/.test(d)) return `收到来信${q(t)}`;
      return `记录：${d ?? t ?? ''}`.replace(/：$/, '');
    default:
      return d ?? t ?? '';
  }
}
