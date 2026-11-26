// What a command will do, said by the app from the command itself (not by the model, whose description may not
// match): the common kinds of change a confirmation is about. Only what is recognised is said; anything else
// falls back to 运行命令, and the command itself is always shown in full. The reading is shared with the core
// (@spica/protocol's scanCommand); the words are the window's.
import { scanCommand, type CommandPart, type CommandPartKind } from '@spica/protocol';
import { t } from '../../../shared/i18n';

export type FactKind = CommandPartKind;

export interface CommandFact {
  kind: FactKind;
  /** One plain line, e.g. 删除 D:\工作\样机评审（含其中所有内容）. */
  text: string;
  /** Cannot be taken back (deleting, overwriting, stopping a program, the registry). */
  danger: boolean;
}

function say(p: CommandPart): string {
  const x = p.target;
  switch (p.kind) {
    case 'delete':
      if (!x) return p.recurse ? t('删除 文件（含其中所有内容）') : t('删除 文件');
      return p.recurse ? t('删除 {target}（含其中所有内容）', { target: x }) : t('删除 {target}', { target: x });
    case 'move':
      return x ? t('移动或改名 {target}', { target: x }) : t('移动或改名 文件');
    case 'copy':
      return x ? t('复制 {target}', { target: x }) : t('复制 文件');
    case 'write':
      if (p.danger) return x ? t('覆盖 {target}', { target: x }) : t('覆盖 文件');
      return x ? t('写入 {target}', { target: x }) : t('写入 文件');
    case 'net':
      return x ? t('访问网络 {target}', { target: x }) : t('访问网络');
    case 'install':
      return x ? t('安装 {target}', { target: x }) : t('安装');
    case 'process':
      return x ? t('结束程序 {target}', { target: x }) : t('结束程序');
    case 'registry':
      return t('修改注册表');
  }
}

/** What the command will do, in order, as far as it can be told; nothing recognised gives []. */
export function commandFacts(command: string): CommandFact[] {
  return scanCommand(command).map((p) => ({ kind: p.kind, text: say(p), danger: p.danger }));
}

/**
 * Where the dangerous words are in the command ([start, end) pairs, in order): the verb that deletes, overwrites,
 * stops a program or changes the registry, its -Recurse / -Force and the like, and a > that overwrites a file.
 * A command with nothing dangerous in it has none.
 */
export function dangerSpans(command: string): [number, number][] {
  return scanCommand(command)
    .flatMap((p) => p.marks)
    .sort((a, b) => a[0] - b[0]);
}
