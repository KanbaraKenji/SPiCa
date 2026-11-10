// Left sidebar: conversations with the assistant, then each project, each with
// the sub-agents it started (at any depth). Every row opens that session's
// conversation; the arrow in front only expands or collapses.
import { useMemo, useState } from 'react';
import { ContextMenu } from '../ui/ContextMenu';
import type { SessionInfo } from '@spica/protocol';
import { Icon } from '../ui/Icon';
import { NewDot, joinNotes } from '../ui/NewDot';
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
  /**
   * The assistant's default thread (getTopSession). Not singled out any more (the assistant is
   * the voice of every conversation outside a project): it is one of 对话.
   */
  topId?: string | null;
  /** Sets a session's name; an empty name goes back to the automatic one. Absent: no renaming. */
  onRename?: (id: string, title: string | null) => void;
  /** The 收件箱 row; absent when the backend has no mail. `count` = mails waiting for the user. */
  inbox?: { count: number; open: boolean; onOpen(): void };
  /** Short words after a row's title, by session id (e.g. 「有新来信」 on a project). */
  notes?: ReadonlyMap<string, string>;
  /** Project ids pinned to the top, in pin order. */
  pinned?: readonly string[];
  onPin?: (projectId: string, pinned: boolean) => void;
  /** Absent when the backend cannot rename / delete projects: the menu leaves them out. */
  onRenameProject?: (projectId: string, name: string) => void;
  onDeleteProject?: (projectId: string, name: string) => void;
  /** 删除 in the right-click menu of the user's own conversations (not a project's). */
  onDeleteChat?: (s: SessionInfo) => void;
  /** Pages plugins add to the sidebar (views with placement sidebar); they open in the main pane. */
  pluginPages?: { key: string; title: string; icon?: string; open: boolean; onOpen(): void }[];
  /**
   * The collapsed sidebar: one column of icons. Built from the same
   * blocks as the full sidebar, so 新对话, 收件箱, 对话, 项目, the plugins and 设置 sit at
   * the same height in both; 项目 opens a menu of the projects.
   */
  compact?: boolean;
}

/** A conversation the user started (not a project's, not a sub-task): one that can be deleted on its own. */
function isOwnChat(s: SessionInfo): boolean {
  return s.role === 'top' && !s.parentId;
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
  if (waiting) parts.push(`${waiting} 个待处理`);
  if (running) parts.push(`${running} 个运行中`);
  if (queued) parts.push(`${queued} 个排队中`);
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
  /** Right-click or F2 on a row (absent: no menu). */
  startRename?: (s: SessionInfo, at?: { x: number; y: number }) => void;
  finishRename(s: SessionInfo, value: string | null): void;
  notes?: ReadonlyMap<string, string>;
  /** Rows that have a menu (conversations to rename; projects to rename, pin, delete). */
  hasMenu(s: SessionInfo): boolean;
  pinned: ReadonlySet<string>;
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
      {/* Text lines up with the section heading; each level in is one step. The expand
          arrow sits at the right end, only on rows that have something under them. */}
      <div className={active ? 'tree-row is-active' : 'tree-row'} style={{ paddingLeft: depth * 16 }}>
        {tree.editing === s.id ? (
          <RenameField initial={name} onDone={(v) => tree.finishRename(s, v)} />
        ) : (
          <button
            type="button"
            className="tree-open"
            onClick={() => tree.onOpen(s.id)}
            onContextMenu={(e) => {
              if (!tree.startRename || !tree.hasMenu(s)) return;
              e.preventDefault();
              tree.startRename(s, { x: e.clientX, y: e.clientY });
            }}
            onKeyDown={(e) => {
              if (e.key === 'F2' && tree.startRename && tree.hasMenu(s)) {
                e.preventDefault();
                tree.startRename(s);
              }
            }}
            aria-current={active ? 'page' : undefined}
            title={name}
          >
            <span className="tree-title">{name}</span>
            {s.projectId && tree.pinned.has(s.projectId) ? (
              <span className="tree-pin" title="已置顶">
                <Icon name="pin" size={12} />
              </span>
            ) : null}
            {tree.notes?.get(s.id) && !active ? <NewDot text={tree.notes.get(s.id)!} /> : null}
            {summary ? <span className={/等你/.test(summary) ? 'tree-summary is-waiting' : 'tree-summary'}>{summary}</span> : <StatusMark status={s.status} />}
          </button>
        )}
        {kids.length ? (
          <button type="button" className="tree-twisty" aria-label={open ? `收起 ${name}` : `展开 ${name}`} title={open ? '收起' : '展开'} aria-expanded={open} onClick={() => tree.setExpanded(s.id, !open)}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
          </button>
        ) : null}
      </div>
      {open ? kids.map((k) => <Node key={k.id} s={k} depth={depth + 1} tree={tree} />) : null}
    </>
  );
}

export function Sidebar({
  sessions,
  activeId,
  onOpen,
  onNewChat,
  onNewProject,
  onSettings,
  settingsOpen,
  onRename,
  inbox,
  notes,
  pinned = [],
  onPin,
  onRenameProject,
  onDeleteProject,
  onDeleteChat,
  pluginPages = [],
  compact = false,
}: SidebarProps) {
  const pinOrder = useMemo(() => new Map(pinned.map((id, i) => [id, i])), [pinned]);
  const { chats, projects, childrenOf } = useMemo(() => {
    const chats = sessions.filter((s) => s.role === 'top' && !s.parentId).sort(byRecent);
    // A project is a project-manager session, wherever it was started from. Pinned ones first.
    const rank = (s: SessionInfo) => (s.projectId !== undefined ? (pinOrder.get(s.projectId) ?? Infinity) : Infinity);
    const projects = sessions.filter((s) => s.role === 'manager').sort((a, b) => rank(a) - rank(b) || byRecent(a, b));
    const childrenOf = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      if (!s.parentId || s.role === 'manager') continue;
      const list = childrenOf.get(s.parentId) ?? [];
      list.push(s);
      childrenOf.set(s.parentId, list);
    }
    for (const list of childrenOf.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { chats, projects, childrenOf };
  }, [sessions, pinOrder]);

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
    openByDefault: new Set<string>(),
    editing,
    pinned: new Set(pinned),
    hasMenu: (s) => (s.role === 'manager' ? Boolean(s.projectId && (onPin || onRenameProject || onDeleteProject)) : Boolean(onRename || (onDeleteChat && isOwnChat(s)))),
    ...(onRename || onPin || onRenameProject || onDeleteProject || onDeleteChat
      ? {
          startRename: (s: SessionInfo, at?: { x: number; y: number }) => {
            if (at) setMenu({ s, ...at });
            else setEditing(s.id);
          },
        }
      : {}),
    finishRename: (s, value) => {
      setEditing(null);
      if (value === null) return;
      const next = value.trim();
      if (next === (s.title ?? '')) return;
      if (s.role === 'manager') {
        // A project keeps a name: an empty one changes nothing.
        if (next && s.projectId && onRenameProject) onRenameProject(s.projectId, next);
      } else if (onRename) onRename(s.id, next || null);
    },
  };

  const menuItems = (row: SessionInfo) => {
    if (row.role !== 'manager')
      return [
        ...(onRename ? [{ label: '重命名', onSelect: () => setEditing(row.id) }] : []),
        ...(onDeleteChat && isOwnChat(row) ? [{ label: '删除', danger: true, onSelect: () => onDeleteChat(row) }] : []),
      ];
    const pid = row.projectId;
    if (!pid) return [];
    const isPinned = pinOrder.has(pid);
    return [
      ...(onRenameProject ? [{ label: '重命名', onSelect: () => setEditing(row.id) }] : []),
      ...(onPin ? [{ label: isPinned ? '取消置顶' : '置顶', onSelect: () => onPin(pid, !isPinned) }] : []),
      ...(onDeleteProject ? [{ label: '删除', danger: true, onSelect: () => onDeleteProject(pid, row.title ?? '') }] : []),
    ];
  };

  // Which list the full sidebar shows; it follows the conversation you open (one in a project → 项目).
  const [listTab, setListTab] = useState<'chats' | 'projects'>('chats');
  const [followed, setFollowed] = useState<string | null>(null);
  if (activeId !== followed) {
    setFollowed(activeId);
    const byIdNow = new Map(sessions.map((x) => [x.id, x]));
    let at = activeId ? byIdNow.get(activeId) : undefined;
    while (at?.parentId && at.role !== 'manager') at = byIdNow.get(at.parentId);
    if (at) setListTab(at.role === 'manager' ? 'projects' : 'chats');
  }
  const projectIds = new Set(projects.map((p) => p.id));
  // What is new under each tab, for its dot ('' when nothing).
  const projectsNews = joinNotes([...(notes ?? [])].filter(([id]) => projectIds.has(id)).map(([, n]) => n));
  const chatsNews = joinNotes([...(notes ?? [])].filter(([id]) => !projectIds.has(id)).map(([, n]) => n));
  if (compact) {
    // Only actions here; the lists (对话, 项目) come with the full sidebar, slid out by resting on this column.
    return (
      <nav className="sidebar is-rail" aria-label="对话">
        <div className="sidebar-top">
          <button type="button" className="side-action" onClick={onNewChat} aria-label="新对话" title="新对话">
            <Icon name="newChat" />
          </button>
          {inbox ? (
            <button type="button" className={inbox.open ? 'side-action is-active' : 'side-action'} onClick={inbox.onOpen} aria-current={inbox.open ? 'page' : undefined} aria-label={inbox.count ? `收件箱，${inbox.count} 封待确认` : '收件箱'} title="收件箱">
              <Icon name="inbox" />
              {inbox.count ? <span className="rail-badge">{inbox.count}</span> : null}
            </button>
          ) : null}
        </div>
        <div className="sidebar-scroll" />
        {pluginPages.length ? (
          <section className="tree-section side-plugins" aria-label="插件">
            <h2 className="tree-heading rail-sep" aria-hidden>
              插件
            </h2>
            {pluginPages.map((p) => (
              <button key={p.key} type="button" className={p.open ? 'side-action is-active' : 'side-action'} onClick={p.onOpen} aria-current={p.open ? 'page' : undefined} aria-label={p.title} title={p.title}>
                {p.icon ? <img className="side-plugin-icon" src={p.icon} alt="" /> : <Icon name="plugin" />}
              </button>
            ))}
          </section>
        ) : null}
        <div className="sidebar-bottom">
          <button type="button" className={settingsOpen ? 'side-action is-active' : 'side-action'} onClick={onSettings} aria-current={settingsOpen ? 'page' : undefined} aria-label="设置" title="设置">
            <Icon name="settings" />
          </button>
        </div>
      </nav>
    );
  }

  return (
    <nav className="sidebar" aria-label="对话">
      <div className="sidebar-top">
        <button type="button" className="side-action" onClick={onNewChat}>
          <Icon name="newChat" />
          <span>新对话</span>
        </button>
        {inbox ? (
          <button type="button" className={inbox.open ? 'side-action is-active' : 'side-action'} onClick={inbox.onOpen} aria-current={inbox.open ? 'page' : undefined}>
            <Icon name="inbox" />
            <span>收件箱</span>
            {inbox.count ? (
              <span className="side-count" aria-label={`${inbox.count} 封待确认`} title={`${inbox.count} 封待确认`}>
                {inbox.count}
              </span>
            ) : null}
          </button>
        ) : null}
      </div>
      {/* 对话 and 项目 as two tabs, each half the width. The one not shown carries a dot
          when something in it has news. */}
      <div className="tabs side-tabs" role="tablist" aria-label="列表">
        {(['chats', 'projects'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={listTab === t} className={listTab === t ? 'tab is-on' : 'tab'} onClick={() => setListTab(t)}>
            {t === 'chats' ? '对话' : '项目'}
            {listTab !== t && (t === 'chats' ? chatsNews : projectsNews) ? <NewDot text={t === 'chats' ? chatsNews : projectsNews} /> : null}
          </button>
        ))}
      </div>
      <div className="sidebar-scroll" role="tabpanel">
        {listTab === 'chats' ? (
          // Every conversation outside a project, newest first; the assistant speaks in all of them.
          <section className="tree-section">
            {chats.map((s) => (
              <Node key={s.id} s={s} depth={0} tree={tree} />
            ))}
          </section>
        ) : (
          <section className="tree-section">
            {projects.map((p) => (
              <Node key={p.id} s={p} depth={0} tree={tree} />
            ))}
            {onNewProject ? (
              <button type="button" className="side-action side-new-project" onClick={onNewProject}>
                <Icon name="plus" />
                <span>新项目</span>
              </button>
            ) : null}
          </section>
        )}
      </div>
      {pluginPages.length ? (
        <section className="tree-section side-plugins" aria-label="插件">
          <h2 className="tree-heading">插件</h2>
          {pluginPages.map((p) => (
            <button key={p.key} type="button" className={p.open ? 'side-action is-active' : 'side-action'} onClick={p.onOpen} aria-current={p.open ? 'page' : undefined} title={p.title}>
              {p.icon ? <img className="side-plugin-icon" src={p.icon} alt="" /> : <Icon name="plugin" />}
              <span className="side-action-text">{p.title}</span>
            </button>
          ))}
        </section>
      ) : null}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.s)}
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
