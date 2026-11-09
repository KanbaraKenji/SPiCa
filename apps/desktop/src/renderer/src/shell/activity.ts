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
      return t ? `写了 ${t}` : '写了一个文件';
    case 'file.edit':
      return t ? `改了 ${t}` : '改了一个文件';
    case 'file.delete':
      return t ? `删了 ${t}` : '删了一个文件';
    case 'command':
      return t ? `运行了 ${t}` : '运行了一条命令';
    case 'child.spawn':
      return t ? `开了子任务${q(t)}` : '开了一个子任务';
    case 'child.report':
      return `${t ? `子任务${q(t)}` : '子任务'}回报${d ? `：${d}` : ''}`;
    case 'decision':
      return `定了：${d ?? t ?? ''}`.replace(/：$/, '');
    case 'stage':
      return `${t ? `进入阶段${q(t)}` : '换了阶段'}${d ? `：${d}` : ''}`;
    case 'note':
      return `记了：${d ?? t ?? ''}`.replace(/：$/, '');
    default:
      return d ?? t ?? '';
  }
}
