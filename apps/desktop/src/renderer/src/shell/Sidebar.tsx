// Left sidebar: conversations with the assistant, then each project, each with
// the sub-agents it started (at any depth). Every row opens that session's
// conversation; the arrow in front only expands or collapses.
import { useMemo, useState } from 'react';
import { ContextMenu } from '../ui/ContextMenu';
import type { SessionInfo } from '@spica/protocol';
import { Icon } from '../ui/Icon';
import { StatusMark } from '../ui/StatusMark';
import { isRunning } from '../store/transcript';

export interface SidebarProps {
  sessions: SessionInfo[];
  activeId: string | null;
  onOpen(id: string): void;
  onNewChat(): void;
  /** Absent when the backend cannot create projects. */
  onNewProject?: () => void;
  onSettings(): void;
  settingsOpen: boolean;
  /** The assistant's default thread (getTopSession); other top-level threads are listed under it. */
  topId?: string | null;
  /** Sets a session's name; an empty name goes back to the automatic one. Absent: no renaming. */
  onRename?: (id: string, title: string | null) => void;
  /** The 收件箱 row; absent when the backend has no mail. `count` = mails waiting for the user. */
  inbox?: { count: number; open: boolean; onOpen(): void };
  /** Short words after a row's title, by session id (e.g. 「有新来信」 on a project). */
  notes?: ReadonlyMap<string, string>;
}

function byRecent(a: SessionInfo, b: SessionInfo): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function waitingForYou(s: SessionInfo): boolean {
  return s.status === 'awaiting_answer' || s.status === 'awaiting_confirm';
}

/** Collapsed row summary over everything below it: only counts that are not zero. */
export function projectSummary(descendants: SessionInfo[]): string {
  const running = descendants.filter((c) => c.status === 'thinking' || c.status === 'tool').length;
  const queued = descendants.filter((c) => c.status === 'queued').length;
  const waiting = descendants.filter(waitingForYou).length;
  const parts: string[] = [];
  if (waiting) parts.push(`${waiting} 个等你`);
  if (running) parts.push(`${running} 个在跑`);
  if (queued) parts.push(`${queued} 个排队`);
  return parts.join(' · ');
}

interface TreeProps {
  childrenOf: Map<string, SessionInfo[]>;
  activeId: string | null;
  settingsOpen: boolean;
  expanded: Record<string, boolean>;
  setExpanded(id: string, open: boolean): void;
  onOpen(id: string): void;
  /** Rows that start expanded no matter what runs below them. */
  openByDefault: ReadonlySet<string>;
  /** Row being renamed, if any. */
  editing: string | null;
  startRename?: (s: SessionInfo, at?: { x: number; y: number }) => void;
  finishRename(s: SessionInfo, value: string | null): void;
  notes?: ReadonlyMap<string, string>;
}

/** Projects are renamed through the project, not the manager's session. */
function canRename(s: SessionInfo): boolean {
  return s.role !== 'manager';
}

function RenameField({ initial, onDone }: { initial: string; onDone(value: string | null): void }) {
  const [value, setValue] = useState(initial);
  const [done, setDone] = useState(false);
  const finish = (v: string | null) => {
    if (done) return;
    setDone(true);
    onDone(v);
  };
  return (
    <input
      className="input tree-rename"
      value={value}
      maxLength={60}
      aria-label="新名字"
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

function descendantsOf(id: string, childrenOf: Map<string, SessionInfo[]>): SessionInfo[] {
  const out: SessionInfo[] = [];
  const walk = (pid: string) => {
    for (const c of childrenOf.get(pid) ?? []) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

function Node({ s, depth, tree }: { s: SessionInfo; depth: number; tree: TreeProps }) {
  const kids = tree.childrenOf.get(s.id) ?? [];
  const all = kids.length ? descendantsOf(s.id, tree.childrenOf) : [];
  // Rows with something going on below them (or the open session) start expanded.
  const open =
    s.id in tree.expanded ? tree.expanded[s.id] === true : tree.openByDefault.has(s.id) || all.some((k) => isRunning(k.status) || k.id === tree.activeId);
  const summary = kids.length && !open ? projectSummary(all) : '';
  const active = !tree.settingsOpen && s.id === tree.activeId;
  const name = s.title ?? '';
  return (
    <>
      <div className={active ? 'tree-row is-active' : 'tree-row'} style={{ paddingLeft: 2 + depth * 18 }}>
        {kids.length ? (
          <button type="button" className="tree-twisty" aria-label={open ? `收起 ${name}` : `展开 ${name}`} aria-expanded={open} onClick={() => tree.setExpanded(s.id, !open)}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
          </button>
        ) : (
          <span className="tree-twisty" aria-hidden />
        )}
        {tree.editing === s.id ? (
          <RenameField initial={name} onDone={(v) => tree.finishRename(s, v)} />
        ) : (
          <button
            type="button"
            className="tree-open"
            onClick={() => tree.onOpen(s.id)}
            onContextMenu={(e) => {
              if (!tree.startRename || !canRename(s)) return;
              e.preventDefault();
              tree.startRename(s, { x: e.clientX, y: e.clientY });
            }}
            onKeyDown={(e) => {
              if (e.key === 'F2' && tree.startRename && canRename(s)) {
                e.preventDefault();
                tree.startRename(s);
              }
            }}
            aria-current={active ? 'page' : undefined}
            title={name}
          >
            <span className="tree-title">{name}</span>
            {tree.notes?.get(s.id) && !active ? <span className="tree-note">{tree.notes.get(s.id)}</span> : null}
            {summary ? <span className={/等你/.test(summary) ? 'tree-summary is-waiting' : 'tree-summary'}>{summary}</span> : <StatusMark status={s.status} />}
          </button>
        )}
      </div>
      {open ? kids.map((k) => <Node key={k.id} s={k} depth={depth + 1} tree={tree} />) : null}
    </>
  );
}

export function Sidebar({ sessions, activeId, onOpen, onNewChat, onNewProject, onSettings, settingsOpen, topId = null, onRename, inbox, notes }: SidebarProps) {
  const { chats, projects, childrenOf, top } = useMemo(() => {
    const chats = sessions.filter((s) => s.role === 'top' && !s.parentId).sort(byRecent);
    // A project is a project-manager session, wherever it was started from.
    const projects = sessions.filter((s) => s.role === 'manager').sort(byRecent);
    const childrenOf = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      if (!s.parentId || s.role === 'manager') continue;
      const list = childrenOf.get(s.parentId) ?? [];
      list.push(s);
      childrenOf.set(s.parentId, list);
    }
    for (const list of childrenOf.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // The assistant is one role with many threads: its default thread is the row,
    // the other threads (新对话) sit under it, newest first.
    const top = topId ? chats.find((s) => s.id === topId) : undefined;
    if (top) childrenOf.set(top.id, [...chats.filter((s) => s.id !== top.id), ...(childrenOf.get(top.id) ?? [])]);
    return { chats, projects, childrenOf, top };
  }, [sessions, topId]);

  const [expanded, setExpandedState] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ s: SessionInfo; x: number; y: number } | null>(null);
  const tree: TreeProps = {
    childrenOf,
    activeId,
    // Another view (settings, inbox) is open: no row is the current one.
    settingsOpen: settingsOpen || Boolean(inbox?.open),
    ...(notes ? { notes } : {}),
    expanded,
    setExpanded: (id, open) => setExpandedState((e) => ({ ...e, [id]: open })),
    onOpen,
    openByDefault: new Set(top ? [top.id] : []),
    editing,
    ...(onRename
      ? {
          startRename: (s: SessionInfo, at?: { x: number; y: number }) => {
            if (at) setMenu({ s, ...at });
            else setEditing(s.id);
          },
        }
      : {}),
    finishRename: (s, value) => {
      setEditing(null);
      if (value === null || !onRename) return;
      const next = value.trim();
      if (next !== (s.title ?? '')) onRename(s.id, next || null);
    },
  };

  return (
    <nav className="sidebar" aria-label="会话">
      <div className="sidebar-top">
        <button type="button" className="side-action" onClick={onNewChat}>
          <Icon name="plus" />
          <span>新对话</span>
        </button>
        {inbox ? (
          <button type="button" className={inbox.open ? 'side-action is-active' : 'side-action'} onClick={inbox.onOpen} aria-current={inbox.open ? 'page' : undefined}>
            <Icon name="inbox" />
            <span>收件箱</span>
            {inbox.count ? (
              <span className="side-count" aria-label={`${inbox.count} 封待确认`}>
                {inbox.count}
              </span>
            ) : null}
          </button>
        ) : null}
      </div>
      <div className="sidebar-scroll">
        {top ? (
          <section className="tree-section" aria-label="助理">
            <Node s={top} depth={0} tree={tree} />
          </section>
        ) : chats.length ? (
          <section className="tree-section">
            <h2 className="tree-heading">对话</h2>
            {chats.map((s) => (
              <Node key={s.id} s={s} depth={0} tree={tree} />
            ))}
          </section>
        ) : null}
        {projects.length || onNewProject ? (
          <section className="tree-section">
            <div className="tree-heading-row">
              <h2 className="tree-heading">项目</h2>
              {onNewProject ? (
                <button type="button" className="icon-btn tree-heading-btn" onClick={onNewProject} aria-label="新项目" title="新项目">
                  <Icon name="plus" size={14} />
                </button>
              ) : null}
            </div>
            {projects.map((p) => (
              <Node key={p.id} s={p} depth={0} tree={tree} />
            ))}
          </section>
        ) : null}
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ label: '重命名', onSelect: () => setEditing(menu.s.id) }]}
          onClose={() => setMenu(null)}
        />
      ) : null}
      <div className="sidebar-bottom">
        <button type="button" className={settingsOpen ? 'side-action is-active' : 'side-action'} onClick={onSettings} aria-current={settingsOpen ? 'page' : undefined}>
          <Icon name="settings" />
          <span>设置</span>
        </button>
      </div>
    </nav>
  );
}
