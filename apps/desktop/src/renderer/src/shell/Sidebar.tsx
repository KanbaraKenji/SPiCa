// Left sidebar: conversations with the assistant, then each project, each with
// the sub-agents it started (at any depth). Every row opens that session's
// conversation; the arrow after its name only expands or collapses.
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import type { ProjectInfo, SessionInfo } from '@spica/protocol';
import { Icon } from '../ui/Icon';
import { letterBadge } from '../ui/badge';
import { StatusSlot } from '../ui/StatusMark';
import { isRunning } from '../store/transcript';
import { rollupText, slotsOf, topSlot } from './row-status';
import { canRename, commitRename, hasRowMenu, RenameField, rowMenuItems, type RowActions } from './row-menu';
import { t, tc } from '../../../shared/i18n';

export interface SidebarProps {
  sessions: SessionInfo[];
  activeId: string | null;
  onOpen(id: string): void;
  onNewChat(): void;
  /** Absent when the backend cannot create projects. */
  onNewProject?: () => void;
  /** 新子项目 on a project's menu. Absent: not offered. */
  onNewSubProject?: (projectId: string) => void;
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
  /** Updates (shell/UpdateNotice.tsx): the card, or in the column of icons its icon; right above the bottom row. */
  notice?: ReactNode;
  /**
   * The user's account (设置 › 账号): on the bottom row, its letter and the account, the gear for 设置 at the
   * right end. Empty or absent: the row is 设置 alone, as it was. The column of icons has its letter just above the
   * gear (the row's order; the gear stays where it was), opening the same menu.
   */
  account?: string;
  /**
   * The account opens a menu above it (as Claude's does): 设置 (the settings as they last were) and 模型
   * (设置 › 模型), each opening the settings there. Absent: the account opens the settings as the gear does.
   */
  onAccount?: (where: AccountMenuTo) => void;
  /** A page other than a conversation fills the main area (a plugin's page): no row is the current one. */
  elsewhere?: boolean;
  /**
   * The projects as the backend lists them. With it, 项目 lists projects and their sub-projects: a project holding
   * sub-projects opens its page (onOpenProject); a sub-project (and a project with a conversation of its own and no
   * sub-projects) is one row, its manager's conversation. Sub-tasks are not rows: they are in the details.
   */
  projectInfos?: ProjectInfo[];
  onOpenProject?: (projectId: string) => void;
  /** The project whose page is open (its row is the current one). */
  projectPageId?: string | null;
}

/** Where an item of the account's menu opens the settings. */
export type AccountMenuTo = 'settings' | 'models';

/**
 * The account's menu: the account in full on top (not an item: where a long one is read whole), then the items,
 * each with the icon its settings page has in the settings' list (given as `after`, drawn before the words).
 */
export function accountMenuItems(account: string, go: (where: AccountMenuTo) => void): MenuItem[] {
  return [
    { label: t('设置'), group: account, icon: 'settings', onSelect: () => go('settings') },
    { label: t('模型'), group: account, icon: 'model', onSelect: () => go('models') },
  ];
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

/** Each level in is one step; the line to a row's sub-agents runs under the first character of its name. */
const TREE_INDENT = 20;
const TREE_LINE = 16;

/**
 * A row. `leaf` (a sub-project's row): its sub-tasks are not rows under it; they count in its status place, as a
 * collapsed row's do, and it is the current row while one of them is open.
 */
function Node({ s, depth, tree, leaf }: { s: SessionInfo; depth: number; tree: TreeProps; leaf?: SessionInfo[] }) {
  const kids = leaf ? [] : (tree.childrenOf.get(s.id) ?? []);
  const all = leaf ?? (kids.length ? descendantsOf(s.id, tree.childrenOf) : []);
  // Rows with something going on below them (or the open session) start expanded.
  const open =
    s.id in tree.expanded ? tree.expanded[s.id] === true : tree.openByDefault.has(s.id) || all.some((k) => isRunning(k.status) || k.id === tree.activeId);
  const active = !tree.settingsOpen && (s.id === tree.activeId || Boolean(leaf?.some((k) => k.id === tree.activeId)));
  // One status place per row: its own most pressing state (anything else it has is said on hover);
  // collapsed, the most pressing of it and everything below it, with the counts on hover.
  // A project's row is the project, not a conversation: it shows no state, its own or of what is below it.
  // What goes on in a project is on the rows under it (a project with something running or waiting opens itself).
  const isProject = s.role === 'manager' && !leaf;
  const said = (x: SessionInfo, isActive: boolean) => slotsOf(x, { active: isActive, unseenDone: tree.unseenDone.has(x.id) });
  const own = isProject ? [] : said(s, active);
  const below = !isProject && (leaf ? all.length : kids.length && !open) ? all.flatMap((k) => said(k, !tree.settingsOpen && k.id === tree.activeId)) : [];
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
        style={{ paddingLeft: depth * TREE_INDENT }}
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
              <button type="button" className="tree-twisty" aria-label={open ? t('收起 {name}', { name }) : t('展开 {name}', { name })} title={open ? tc('tree', '收起') : tc('tree', '展开')} aria-expanded={open} onClick={toggle}>
                <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
              </button>
            ) : null}
            {s.projectId && tree.pinned.has(s.projectId) ? (
              <span className="tree-pin" title={t('已置顶')} onClick={() => tree.onOpen(s.id)}>
                <Icon name="pin" size={12} />
              </span>
            ) : null}
            {more ? null : <StatusSlot slot={slot} {...(below.length ? { text: rollupText([...own, ...below]) } : own.length > 1 ? { text: own.map((x) => x.text).join(' · ') } : {})} onClick={() => tree.onOpen(s.id)} />}
          </>
        )}
        {more ? (
          <button type="button" className="tree-more" aria-label={t('更多')} title={t('更多')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(e) => more(s, e.currentTarget)}>
            <Icon name="more" size={16} />
          </button>
        ) : null}
      </div>
      {/* What is under a row hangs on a line from it: down its left side, the last one's end turning in. */}
      {open && kids.length ? (
        <div className="tree-kids" style={{ '--tree-line-x': `${depth * TREE_INDENT + TREE_LINE}px` } as CSSProperties}>
          {kids.map((k) => (
            <div key={k.id} className="tree-branch">
              <Node s={k} depth={depth + 1} tree={tree} />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * A project's row as the row menu takes it (rename, pin, delete, 新子项目 act on the project): a project holding
 * sub-projects has a menu like one with a conversation of its own.
 */
export function projectRowSession(p: ProjectInfo): SessionInfo {
  return { id: p.id, parentId: null, parentChain: [], role: 'manager', projectId: p.id, title: p.name, status: 'idle', providerId: '', model: '', cwd: p.folder, costUsd: 0, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

/**
 * A project holding sub-projects. Its name opens the project's page; the arrow shows or hides its sub-projects
 * (shown at first), each one row: its manager's conversation. Its menu (right-click, F2, 更多 while its page is open)
 * is a project's.
 */
function ProjectRow({ p, subs, tree, current, onOpenProject, leafOf }: { p: ProjectInfo; subs: SessionInfo[]; tree: TreeProps; current: boolean; onOpenProject(id: string): void; leafOf(s: SessionInfo): SessionInfo[] }) {
  const open = p.id in tree.expanded ? tree.expanded[p.id] === true : true;
  // The page is open: no conversation row is the current one (elsewhere), this one is.
  const active = current;
  const toggle = () => tree.setExpanded(p.id, !open);
  const s = projectRowSession(p);
  const menuOpen = tree.menuFor === p.id;
  const more = active && tree.toggleMenu && tree.hasMenu(s) && tree.editing !== p.id ? tree.toggleMenu : null;
  return (
    <>
      <div
        className={['tree-row', active ? 'is-active' : '', menuOpen ? 'is-menu-open' : ''].filter(Boolean).join(' ')}
        onContextMenu={(e) => {
          if (!tree.startRename || !tree.hasMenu(s) || tree.editing === p.id) return;
          e.preventDefault();
          tree.startRename(s, { x: e.clientX, y: e.clientY });
        }}
      >
        {tree.editing === p.id ? (
          <RenameField initial={p.name} onDone={(v) => tree.finishRename(s, v)} />
        ) : (
        <>
        <button
          type="button"
          className="tree-open"
          onClick={() => onOpenProject(p.id)}
          onDoubleClick={() => {
            if (tree.startRename && tree.canRename(s)) tree.startRename(s);
          }}
          onKeyDown={(e) => {
            if (subs.length && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && open !== (e.key === 'ArrowRight')) {
              e.preventDefault();
              toggle();
            } else if (e.key === 'F2' && tree.startRename && tree.hasMenu(s)) {
              e.preventDefault();
              tree.startRename(s);
            }
          }}
          aria-current={active ? 'page' : undefined}
          title={p.name}
          data-tip-clipped=".tree-title"
        >
          <span className="tree-title">{p.name}</span>
        </button>
        {subs.length ? (
          <button type="button" className="tree-twisty" aria-label={open ? t('收起 {name}', { name: p.name }) : t('展开 {name}', { name: p.name })} title={open ? tc('tree', '收起') : tc('tree', '展开')} aria-expanded={open} onClick={toggle}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
          </button>
        ) : null}
        {tree.pinned.has(p.id) ? (
          <span className="tree-pin" title={t('已置顶')} onClick={() => onOpenProject(p.id)}>
            <Icon name="pin" size={12} />
          </span>
        ) : null}
        </>
        )}
        {more ? (
          <button type="button" className="tree-more" aria-label={t('更多')} title={t('更多')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={(e) => more(s, e.currentTarget)}>
            <Icon name="more" size={16} />
          </button>
        ) : null}
      </div>
      {open && subs.length ? (
        <div className="tree-kids" style={{ '--tree-line-x': `${TREE_LINE}px` } as CSSProperties}>
          {subs.map((k) => (
            <div key={k.id} className="tree-branch">
              <Node s={k} depth={1} tree={tree} leaf={leafOf(k)} />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

export function Sidebar({
  sessions,
  activeId,
  onOpen,
  onNewChat,
  onNewProject,
  onNewSubProject,
  onSettings,
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
  notice = null,
  account = '',
  onAccount,
  elsewhere = false,
  projectInfos,
  onOpenProject,
  projectPageId = null,
}: SidebarProps) {
  const me = account ? letterBadge(account, account) : null;
  /** The account's menu: the button it opens above, and how wide the bottom row is drawn (the menu is no narrower). */
  const [meMenu, setMeMenu] = useState<{ anchor: HTMLElement; width: number } | null>(null);
  /**
   * The account's button (its letter, as a plugin without an icon has; the account after it in the full sidebar)
   * and the menu it opens above. In the column of icons the menu is as wide as its items.
   */
  const accountButton = (withName: boolean) =>
    account ? (
      <button
          type="button"
          className={meMenu ? 'side-action side-me is-active' : 'side-action side-me'}
          onClick={(e) => {
            if (!onAccount) return onSettings();
            const b = e.currentTarget;
            // from the account's left edge to the gear's right edge: the row as it is drawn
            const end = withName ? (b.nextElementSibling?.getBoundingClientRect().right ?? b.getBoundingClientRect().right) : b.getBoundingClientRect().right;
            setMeMenu((m) => (m ? null : { anchor: b, width: end - b.getBoundingClientRect().left }));
          }}
          aria-label={t('账号 {account}', { account })}
          aria-haspopup={onAccount ? 'menu' : undefined}
          aria-expanded={onAccount ? !!meMenu : undefined}
          title={account}
          {...(withName ? { 'data-tip-clipped': '.side-action-text' } : {})}
        >
          <span className="plugin-badge side-avatar" style={{ background: me!.colour }} aria-hidden>
            {me!.letter}
          </span>
          {withName ? <span className="side-action-text">{account}</span> : null}
        </button>
    ) : null;
  const accountMenu =
    meMenu && onAccount && account ? (
      <div className="account-menu" style={{ '--account-menu-width': `${meMenu.width}px` } as CSSProperties}>
        <ContextMenu x={0} y={0} side="above" anchor={meMenu.anchor} items={accountMenuItems(account, onAccount)} onClose={() => setMeMenu(null)} />
      </div>
    ) : null;
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
  // Projects, each a project holding sub-projects or a conversation of its own (as before).
  const projectList = useMemo(() => {
    if (!projectInfos) return null;
    const byId = new Map(sessions.map((x) => [x.id, x]));
    const active = projectInfos.filter((p) => p.status === 'active');
    const rank = (id: string) => pinOrder.get(id) ?? Infinity;
    const tops = active.filter((p) => !p.parentId);
    type Row = { kind: 'holder'; p: ProjectInfo; subs: SessionInfo[]; at: string } | { kind: 'chat'; s: SessionInfo; at: string; id: string };
    const rows: Row[] = [];
    for (const p of tops) {
      const subs = active
        .filter((c) => c.parentId === p.id)
        .map((c) => byId.get(c.managerSessionId))
        .filter((x): x is SessionInfo => Boolean(x))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (!p.managerSessionId || subs.length) rows.push({ kind: 'holder', p, subs, at: [p.updatedAt, ...subs.map((x) => x.updatedAt)].sort().at(-1)! });
      else {
        const s = byId.get(p.managerSessionId);
        if (s) rows.push({ kind: 'chat', s, at: s.updatedAt, id: p.id });
      }
    }
    // A manager the backend lists no project for (started by another manager): a row of its own, as before.
    const listed = new Set(active.map((p) => p.managerSessionId));
    for (const s of projects) if (!listed.has(s.id)) rows.push({ kind: 'chat', s, at: s.updatedAt, id: s.projectId ?? s.id });
    const idOf = (r: Row) => (r.kind === 'holder' ? r.p.id : r.id);
    return rows.sort((a, b) => rank(idOf(a)) - rank(idOf(b)) || b.at.localeCompare(a.at));
  }, [projectInfos, sessions, projects, pinOrder]);
  /** A sub-project's sub-tasks, at any depth (its row's status place counts them). */
  const leafOf = (s: SessionInfo) => descendantsOf(s.id, childrenOf);

  // One set of rules with the name in the title bar (row-menu).
  const subIds = new Set((projectInfos ?? []).filter((p) => p.parentId).map((p) => p.id));
  const actions: RowActions = {
    pinned,
    ...(onRename ? { onRename } : {}),
    ...(onPin ? { onPin } : {}),
    ...(onRenameProject ? { onRenameProject } : {}),
    ...(onDeleteProject ? { onDeleteProject } : {}),
    ...(onDeleteChat ? { onDeleteChat } : {}),
    ...(onNewSubProject ? { onNewSubProject, isSubProject: (pid: string) => subIds.has(pid) } : {}),
  };
  const [expanded, setExpandedState] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ s: SessionInfo; x: number; y: number; anchor?: HTMLElement } | null>(null);
  const tree: TreeProps = {
    childrenOf,
    activeId,
    // Another view (settings, inbox) is open: no row is the current one.
    settingsOpen: settingsOpen || Boolean(inbox?.open) || Boolean(elsewhere),
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
    ...(onRename || onPin || onRenameProject || onDeleteProject || onDeleteChat || onNewSubProject
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
  const [followedPage, setFollowedPage] = useState<string | null>(null);
  if (projectPageId !== followedPage) {
    setFollowedPage(projectPageId);
    if (projectPageId) setListTab('projects');
  }
  if (compact) {
    // Only actions here; the lists (对话, 项目) come with the full sidebar, slid out by resting on this column.
    return (
      <nav className="sidebar is-rail" aria-label={tc('tab', '对话')}>
        {/* As tall as the tabs of the full sidebar, so the icons below sit where their rows do. */}
        <div className="side-tabs-space" aria-hidden />
        {/* In the scrolling part, like the full sidebar's rows: a window too short for all of them scrolls them away. */}
        <div className="sidebar-scroll">
        <div className="sidebar-top">
          <button type="button" className="side-action" onClick={onNewChat} aria-label={t('新对话')} title={t('新对话')}>
            <Icon name="newChat" />
          </button>
          {inbox ? (
            <button type="button" className={inbox.open ? 'side-action is-active' : 'side-action'} onClick={inbox.onOpen} aria-current={inbox.open ? 'page' : undefined} aria-label={inbox.count ? t('收件箱，{n} 封待确认', { n: inbox.count }) : t('收件箱')} title={t('收件箱')}>
              <Icon name="inbox" />
              {inbox.count ? <span className="rail-badge">{inbox.count}</span> : null}
            </button>
          ) : null}
        </div>
        </div>
        {pluginPages.length ? (
          <section className="tree-section side-plugins" aria-label={t('插件')}>
            <h2 className="tree-heading rail-sep" aria-hidden>
              {t('插件')}
            </h2>
            {pluginPages.map((p) => (
              <button key={p.key} type="button" className={p.open ? 'side-action is-active' : 'side-action'} onClick={p.onOpen} aria-current={p.open ? 'page' : undefined} aria-label={p.title} title={p.title}>
                {p.icon ? <img className="side-plugin-icon" src={p.icon} alt="" /> : <Icon name="plugin" />}
              </button>
            ))}
          </section>
        ) : null}
        {notice}
        <div className="sidebar-bottom">
          {accountButton(false)}
          <button type="button" className={settingsOpen ? 'side-action is-active' : 'side-action'} onClick={onSettings} aria-current={settingsOpen ? 'page' : undefined} aria-label={t('设置')} title={t('设置')}>
            <Icon name="settings" />
          </button>
          {accountMenu}
        </div>
      </nav>
    );
  }

  return (
    <nav className="sidebar" aria-label={tc('tab', '对话')}>
      {/* 对话 and 项目 as two tabs right under the brand row, each half the width. */}
      <div className="tabs side-tabs" role="tablist" aria-label={t('列表')}>
        {(['chats', 'projects'] as const).map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={listTab === tab} className={listTab === tab ? 'tab is-on' : 'tab'} onClick={() => setListTab(tab)}>
            {tab === 'chats' ? tc('tab', '对话') : tc('tab', '项目')}
          </button>
        ))}
      </div>
      {/* 新对话 and 收件箱 scroll with the list (a short window scrolls them away); the tabs and 设置 stay. */}
      <div className="sidebar-scroll">
      <div className="sidebar-top">
        <button type="button" className="side-action" onClick={onNewChat}>
          <Icon name="newChat" />
          <span>{t('新对话')}</span>
        </button>
        {inbox ? (
          <button type="button" className={inbox.open ? 'side-action is-active' : 'side-action'} onClick={inbox.onOpen} aria-current={inbox.open ? 'page' : undefined}>
            <Icon name="inbox" />
            <span>{t('收件箱')}</span>
            {inbox.count ? (
              <span className="side-count" aria-label={t('{n} 封待确认', { n: inbox.count })} title={t('{n} 封待确认', { n: inbox.count })}>
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
            {projectList
              ? projectList.map((r) =>
                  r.kind === 'holder' ? (
                    <ProjectRow key={r.p.id} p={r.p} subs={r.subs} tree={tree} current={projectPageId === r.p.id} onOpenProject={(id) => onOpenProject?.(id)} leafOf={leafOf} />
                  ) : (
                    <Node key={r.s.id} s={r.s} depth={0} tree={tree} leaf={leafOf(r.s)} />
                  ),
                )
              : projects.map((p) => <Node key={p.id} s={p} depth={0} tree={tree} />)}
            {onNewProject ? (
              <button type="button" className="side-action side-new-project" onClick={onNewProject}>
                <Icon name="plus" />
                <span>{t('新项目')}</span>
              </button>
            ) : null}
          </section>
        )}
      </div>
      </div>
      {pluginPages.length ? (
        <section className="tree-section side-plugins" aria-label={t('插件')}>
          <h2 className="tree-heading">{t('插件')}</h2>
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
      {notice}
      <div className={account ? 'sidebar-bottom has-account' : 'sidebar-bottom'}>
        {account ? (
          <>
            {/* The account opens its menu above; the gear the settings as before. */}
            {accountButton(true)}
            <button
              type="button"
              className={['side-action', 'side-gear', SETTINGS_WORD ? 'has-word' : '', settingsOpen ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={onSettings}
              aria-current={settingsOpen ? 'page' : undefined}
              aria-label={t('设置')}
              title={t('设置')}
            >
              <Icon name="settings" />
              {SETTINGS_WORD ? <span>{t('设置')}</span> : null}
            </button>
            {accountMenu}
          </>
        ) : (
          <button type="button" className={settingsOpen ? 'side-action is-active' : 'side-action'} onClick={onSettings} aria-current={settingsOpen ? 'page' : undefined}>
            <Icon name="settings" />
            <span>{t('设置')}</span>
          </button>
        )}
      </div>
    </nav>
  );
}
