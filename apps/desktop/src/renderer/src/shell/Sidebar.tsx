// Left sidebar: conversations with the assistant, then each project, each with
// the sub-agents it started (at any depth). Every row opens that session's
// conversation; the arrow after its name only expands or collapses.
import { useMemo, useState } from 'react';
import { ContextMenu } from '../ui/ContextMenu';
import type { SessionInfo } from '@spica/protocol';
import { Icon } from '../ui/Icon';
import { letterBadge } from '../ui/badge';
import { StatusSlot } from '../ui/StatusMark';
import { isRunning } from '../store/transcript';
import { rollupText, slotsOf, topSlot } from './row-status';
import { canRename, commitRename, hasRowMenu, RenameField, rowMenuItems, type RowActions } from './row-menu';

export interface SidebarProps {
  sessions: SessionInfo[];
  activeId: string | null;
  onOpen(id: string): void;
  onNewChat(): void;
  /** Absent when the backend cannot create projects. */
  onNewProject?: () => void;
  onSettings(): void;
  /** 插件市场: the settings open at 插件 › 市场; always there, at the top of the 插件 part. */
  onMarket?: () => void;
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
  /** Finished sub-tasks not opened since they finished: news on their row (and on a collapsed row above them). */
  unseenDone?: ReadonlySet<string>;
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
   * The collapsed sidebar: one column of icons. Built from the same blocks as the full
   * sidebar (an empty space where its tabs are), so 新对话, 收件箱, the plugins and 设置 sit at
   * the same height in both. The lists (对话, 项目) are only in the full sidebar.
   */
  compact?: boolean;
  /**
   * The user's account (设置 › 账号): on the bottom row, its letter and the account, the gear for 设置 at the
   * right end. Empty or absent: the row is 设置 alone, as it was. Only the full sidebar shows it (the column of
   * icons keeps only the gear: the account is there when the sidebar slides out).
   */
  account?: string;
  /** A click on the account: 设置 › 账号. Absent: the settings as they last were. */
  onAccount?: () => void;
}

/** The gear on the account row with the word 设置 after it (the other layout he may pick); false: the gear alone. */
const SETTINGS_WORD = false;

const NONE: ReadonlySet<string> = new Set();

function byRecent(a: SessionInfo, b: SessionInfo): number {
  return b.updatedAt.localeCompare(a.updatedAt);
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
  /** The 更多 button at a row's end: its menu (the same as right-click) under the button; again closes it. */
  toggleMenu?: (s: SessionInfo, button: HTMLElement) => void;
  /** Row whose menu is open, if any. */
  menuFor: string | null;
  finishRename(s: SessionInfo, value: string | null): void;
  unseenDone: ReadonlySet<string>;
  /** Rows that have a menu (conversations to rename; projects to rename, pin, delete). */
  hasMenu(s: SessionInfo): boolean;
  /** Rows whose name can be changed (a double-click on the row starts it). */
  canRename(s: SessionInfo): boolean;
  pinned: ReadonlySet<string>;
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
  const active = !tree.settingsOpen && s.id === tree.activeId;
  // One status place per row: its own most pressing state (anything else it has is said on hover);
  // collapsed, the most pressing of it and everything below it, with the counts on hover.
  // A project's row is the project, not a conversation: it shows no state, its own or of what is below it.
  // What goes on in a project is on the rows under it (a project with something running or waiting opens itself).
  const isProject = s.role === 'manager';
  const said = (x: SessionInfo, isActive: boolean) => slotsOf(x, { active: isActive, unseenDone: tree.unseenDone.has(x.id) });
  const own = isProject ? [] : said(s, active);
  const below = !isProject && kids.length && !open ? all.flatMap((k) => said(k, !tree.settingsOpen && k.id === tree.activeId)) : [];
  const slot = topSlot([...own, ...below]);
  const name = s.title ?? '';
  const menuOpen = tree.menuFor === s.id;
  // 更多 (…) only on the row that is open: there it takes the status place. Every row has the same menu on right-click.
  const more = active && tree.toggleMenu && tree.hasMenu(s) && tree.editing !== s.id ? tree.toggleMenu : null;
  const toggle = () => tree.setExpanded(s.id, !open);
  return (
    <>
      {/* Text lines up with the section heading; each level in is one step. After the name, on rows
          with something under them, the expand arrow; at the end the status place. On the row that is
          open, 更多 (…) stands in that same place instead (its menu under the button); nothing shows
          on hovering, so nothing moves. A click anywhere else on the row opens it; a right-click
          anywhere on it opens the same menu at the pointer. */}
      <div
        className={['tree-row', active ? 'is-active' : '', menuOpen ? 'is-menu-open' : ''].filter(Boolean).join(' ')}
        style={{ paddingLeft: depth * 16 }}
        onContextMenu={(e) => {
          if (!tree.startRename || !tree.hasMenu(s) || tree.editing === s.id) return;
          e.preventDefault();
          tree.startRename(s, { x: e.clientX, y: e.clientY });
        }}
      >
        {tree.editing === s.id ? (
          <RenameField initial={name} onDone={(v) => tree.finishRename(s, v)} />
        ) : (
          <>
            <button
              type="button"
              className="tree-open"
              onClick={() => tree.onOpen(s.id)}
              // A double-click on the row (not on its arrow or 更多, which are buttons of their own) edits the name.
              onDoubleClick={() => {
                if (tree.startRename && tree.canRename(s)) tree.startRename(s);
              }}
              onKeyDown={(e) => {
                // Right opens what is under the row, left closes it (the arrow button does the same).
                if (kids.length && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && open !== (e.key === 'ArrowRight')) {
                  e.preventDefault();
                  toggle();
                } else if (e.key === 'F2' && tree.startRename && tree.hasMenu(s)) {
                  e.preventDefault();
                  tree.startRename(s);
                }
              }}
              aria-current={active ? 'page' : undefined}
              title={name}
              data-tip-clipped=".tree-title"
            >
              <span className="tree-title">{name}</span>
            </button>
            {kids.length ? (
              <button type="button" className="tree-twisty" aria-label={open ? `收起 ${name}` : `展开 ${name}`} title={open ? '收起' : '展开'} aria-expanded={open} onClick={toggle}>
                <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
              </button>
            ) : null}
            {s.projectId && tree.pinned.has(s.projectId) ? (
              <span className="tree-pin" title="已置顶" onClick={() => tree.onOpen(s.id)}>
                <Icon name="pin" size={12} />
              </span>
            ) : null}
            {more ? null : <StatusSlot slot={slot} {...(below.length ? { text: rollupText([...own, ...below]) } : own.length > 1 ? { text: own.map((x) => x.text).join(' · ') } : {})} onClick={() => tree.onOpen(s.id)} />}
          </>
        )}
        {more ? (
          <button type="button" className="tree-more" aria-label="更多" title="更多" aria-haspopup="menu" aria-expanded={menuOpen} onClick={(e) => more(s, e.currentTarget)}>
            <Icon name="more" size={16} />
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
  onMarket,
  settingsOpen,
  onRename,
  inbox,
  unseenDone,
  pinned = [],
  onPin,
  onRenameProject,
  onDeleteProject,
  onDeleteChat,
  pluginPages = [],
  compact = false,
  account = '',
  onAccount,
}: SidebarProps) {
  const me = account ? letterBadge(account, account) : null;
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

  // One set of rules with the name in the title bar (row-menu).
  const actions: RowActions = { pinned, ...(onRename ? { onRename } : {}), ...(onPin ? { onPin } : {}), ...(onRenameProject ? { onRenameProject } : {}), ...(onDeleteProject ? { onDeleteProject } : {}), ...(onDeleteChat ? { onDeleteChat } : {}) };
  const [expanded, setExpandedState] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ s: SessionInfo; x: number; y: number; anchor?: HTMLElement } | null>(null);
  const tree: TreeProps = {
    childrenOf,
    activeId,
    // Another view (settings, inbox) is open: no row is the current one.
    settingsOpen: settingsOpen || Boolean(inbox?.open),
    unseenDone: unseenDone ?? NONE,
    expanded,
    setExpanded: (id, open) => setExpandedState((e) => ({ ...e, [id]: open })),
    onOpen,
    openByDefault: new Set<string>(),
    editing,
    menuFor: menu?.s.id ?? null,
    pinned: new Set(pinned),
    hasMenu: (s) => hasRowMenu(s, actions),
    canRename: (s) => canRename(s, actions),
    ...(onRename || onPin || onRenameProject || onDeleteProject || onDeleteChat
      ? {
          startRename: (s: SessionInfo, at?: { x: number; y: number }) => {
            if (at) setMenu({ s, ...at });
            else setEditing(s.id);
          },
          toggleMenu: (s: SessionInfo, button: HTMLElement) => {
            if (menu?.s.id === s.id) return setMenu(null);
            setMenu({ s, x: 0, y: 0, anchor: button });
          },
        }
      : {}),
    finishRename: (s, value) => {
      setEditing(null);
      commitRename(s, value, actions);
    },
  };

  const menuItems = (row: SessionInfo) => rowMenuItems(row, actions, () => setEditing(row.id));

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
  if (compact) {
    // Only actions here; the lists (对话, 项目) come with the full sidebar, slid out by resting on this column.
    return (
      <nav className="sidebar is-rail" aria-label="对话">
        {/* As tall as the tabs of the full sidebar, so the icons below sit where their rows do. */}
        <div className="side-tabs-space" aria-hidden />
        {/* In the scrolling part, like the full sidebar's rows: a window too short for all of them scrolls them away. */}
        <div className="sidebar-scroll">
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
        </div>
        {pluginPages.length || onMarket ? (
          <section className="tree-section side-plugins" aria-label="插件">
            <h2 className="tree-heading rail-sep" aria-hidden>
              插件
            </h2>
            {onMarket ? (
              <button type="button" className="side-action side-market" onClick={onMarket} aria-label="插件市场" title="插件市场">
                <Icon name="download" />
              </button>
            ) : null}
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
      {/* 对话 and 项目 as two tabs right under the brand row, each half the width. */}
      <div className="tabs side-tabs" role="tablist" aria-label="列表">
        {(['chats', 'projects'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={listTab === t} className={listTab === t ? 'tab is-on' : 'tab'} onClick={() => setListTab(t)}>
            {t === 'chats' ? '对话' : '项目'}
          </button>
        ))}
      </div>
      {/* 新对话 and 收件箱 scroll with the list (a short window scrolls them away); the tabs and 设置 stay. */}
      <div className="sidebar-scroll">
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
      <div role="tabpanel">
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
      </div>
      {pluginPages.length || onMarket ? (
        <section className="tree-section side-plugins" aria-label="插件">
          <h2 className="tree-heading">插件</h2>
          {/* An action, not a page: first, in the quiet colour of 新项目, with the download mark (pages have their own icon). */}
          {onMarket ? (
            <button type="button" className="side-action side-market" onClick={onMarket}>
              <Icon name="download" />
              <span className="side-action-text">插件市场</span>
            </button>
          ) : null}
          {pluginPages.map((p) => (
            <button key={p.key} type="button" className={p.open ? 'side-action is-active' : 'side-action'} onClick={p.onOpen} aria-current={p.open ? 'page' : undefined} title={p.title} data-tip-clipped=".side-action-text">
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
          anchor={menu.anchor ?? null}
          onClose={() => setMenu(null)}
        />
      ) : null}
      <div className={account ? 'sidebar-bottom has-account' : 'sidebar-bottom'}>
        {account ? (
          <>
            {/* The account (its letter, as a plugin without an icon has) opens 设置 › 账号; the gear the settings as before. */}
            <button type="button" className="side-action side-me" onClick={onAccount ?? onSettings} aria-label={`账号 ${account}`} title={account} data-tip-clipped=".side-action-text">
              <span className="plugin-badge side-avatar" style={{ background: me!.colour }} aria-hidden>
                {me!.letter}
              </span>
              <span className="side-action-text">{account}</span>
            </button>
            <button
              type="button"
              className={['side-action', 'side-gear', SETTINGS_WORD ? 'has-word' : '', settingsOpen ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={onSettings}
              aria-current={settingsOpen ? 'page' : undefined}
              aria-label="设置"
              title="设置"
            >
              <Icon name="settings" />
              {SETTINGS_WORD ? <span>设置</span> : null}
            </button>
          </>
        ) : (
          <button type="button" className={settingsOpen ? 'side-action is-active' : 'side-action'} onClick={onSettings} aria-current={settingsOpen ? 'page' : undefined}>
            <Icon name="settings" />
            <span>设置</span>
          </button>
        )}
      </div>
    </nav>
  );
}
