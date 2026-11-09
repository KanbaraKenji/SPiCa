// Left sidebar: conversations with the assistant, then each project, each with
// the sub-agents it started (at any depth). Every row opens that session's
// conversation; the arrow in front only expands or collapses.
import { useMemo, useState } from 'react';
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
        <button type="button" className="tree-open" onClick={() => tree.onOpen(s.id)} aria-current={active ? 'page' : undefined} title={name}>
          <span className="tree-title">{name}</span>
          {summary ? <span className={/等你/.test(summary) ? 'tree-summary is-waiting' : 'tree-summary'}>{summary}</span> : <StatusMark status={s.status} />}
        </button>
      </div>
      {open ? kids.map((k) => <Node key={k.id} s={k} depth={depth + 1} tree={tree} />) : null}
    </>
  );
}

export function Sidebar({ sessions, activeId, onOpen, onNewChat, onNewProject, onSettings, settingsOpen, topId = null }: SidebarProps) {
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
  const tree: TreeProps = {
    childrenOf,
    activeId,
    settingsOpen,
    expanded,
    setExpanded: (id, open) => setExpandedState((e) => ({ ...e, [id]: open })),
    onOpen,
    openByDefault: new Set(top ? [top.id] : []),
  };

  return (
    <nav className="sidebar" aria-label="会话">
      <div className="sidebar-top">
        <button type="button" className="side-action" onClick={onNewChat}>
          <Icon name="plus" />
          <span>新对话</span>
        </button>
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
      <div className="sidebar-bottom">
        <button type="button" className={settingsOpen ? 'side-action is-active' : 'side-action'} onClick={onSettings} aria-current={settingsOpen ? 'page' : undefined}>
          <Icon name="settings" />
          <span>设置</span>
        </button>
      </div>
    </nav>
  );
}
