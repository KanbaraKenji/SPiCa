// What can be done to a session by its name: rename, pin, delete. One set of rules for the sidebar's row
// (double-click, F2, right-click, 更多) and for the name in the title bar (click, right-click), so the two
// never disagree on which sessions can be renamed or what their menu holds.
import { useState } from 'react';
import type { SessionInfo } from '@spica/protocol';
import type { MenuItem } from '../ui/ContextMenu';

/** The actions the app offers; an absent one is not offered anywhere. */
export interface RowActions {
  /** Sets a session's name; an empty name goes back to the automatic one. */
  onRename?: (id: string, title: string | null) => void;
  onPin?: (projectId: string, pinned: boolean) => void;
  onRenameProject?: (projectId: string, name: string) => void;
  onDeleteProject?: (projectId: string, name: string) => void;
  /** Only the user's own conversations (not a project's, not a sub-task). */
  onDeleteChat?: (s: SessionInfo) => void;
  /** Project ids pinned to the top, in pin order. */
  pinned: readonly string[];
}

/** A conversation the user started (not a project's, not a sub-task): one that can be deleted on its own. */
export function isOwnChat(s: SessionInfo): boolean {
  return s.role === 'top' && !s.parentId;
}

/** Whether the session has a menu at all (conversations to rename or delete; projects to rename, pin, delete). */
export function hasRowMenu(s: SessionInfo, a: RowActions): boolean {
  return s.role === 'manager' ? Boolean(s.projectId && (a.onPin || a.onRenameProject || a.onDeleteProject)) : Boolean(a.onRename || (a.onDeleteChat && isOwnChat(s)));
}

/** Whether the session's name can be changed. */
export function canRename(s: SessionInfo, a: RowActions): boolean {
  return s.role === 'manager' ? Boolean(s.projectId && a.onRenameProject) : Boolean(a.onRename);
}

/** The session's menu. `startRename`: what 重命名 does where the menu was opened (edit the name there). */
export function rowMenuItems(s: SessionInfo, a: RowActions, startRename: () => void): MenuItem[] {
  if (s.role !== 'manager') {
    const del = a.onDeleteChat;
    return [...(a.onRename ? [{ label: '重命名', onSelect: startRename }] : []), ...(del && isOwnChat(s) ? [{ label: '删除', danger: true, onSelect: () => del(s) }] : [])];
  }
  const pid = s.projectId;
  if (!pid) return [];
  const { onPin, onDeleteProject } = a;
  const isPinned = a.pinned.includes(pid);
  return [
    ...(a.onRenameProject ? [{ label: '重命名', onSelect: startRename }] : []),
    ...(onPin ? [{ label: isPinned ? '取消置顶' : '置顶', onSelect: () => onPin(pid, !isPinned) }] : []),
    ...(onDeleteProject ? [{ label: '删除', danger: true, onSelect: () => onDeleteProject(pid, s.title ?? '') }] : []),
  ];
}

/** Takes what was typed as the new name. null: cancelled. The same name: nothing happens. */
export function commitRename(s: SessionInfo, value: string | null, a: RowActions): void {
  if (value === null) return;
  const next = value.trim();
  if (next === (s.title ?? '')) return;
  if (s.role === 'manager') {
    // A project keeps a name: an empty one changes nothing.
    if (next && s.projectId && a.onRenameProject) a.onRenameProject(s.projectId, next);
  } else if (a.onRename) a.onRename(s.id, next || null);
}

/** The name being edited in place: Enter or leaving the field takes it, Esc cancels. */
export function RenameField({ initial, onDone, className = 'input tree-rename' }: { initial: string; onDone(value: string | null): void; className?: string }) {
  const [value, setValue] = useState(initial);
  const [done, setDone] = useState(false);
  const finish = (v: string | null) => {
    if (done) return;
    setDone(true);
    onDone(v);
  };
  return (
    <input
      className={className}
      value={value}
      maxLength={60}
      aria-label="名称"
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          finish(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}
