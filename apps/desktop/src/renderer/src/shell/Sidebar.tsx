// Left sidebar: conversations with the assistant, then each project with its
// sub-agents. Every row opens that session's conversation.
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
  onSettings(): void;
  settingsOpen: boolean;
}

function byRecent(a: SessionInfo, b: SessionInfo): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function waitingForYou(s: SessionInfo): boolean {
  return s.status === 'awaiting_answer' || s.status === 'awaiting_confirm';
}

/** Collapsed project summary: only counts that are not zero. */
export function projectSummary(children: SessionInfo[]): string {
  const running = children.filter((c) => c.status === 'thinking' || c.status === 'tool').length;
  const queued = children.filter((c) => c.status === 'queued').length;
  const waiting = children.filter(waitingForYou).length;
  const parts: string[] = [];
  if (waiting) parts.push(`${waiting} 个等你`);
  if (running) parts.push(`${running} 个在跑`);
  if (queued) parts.push(`${queued} 个排队`);
  return parts.join(' · ');
}

function Row({ s, active, depth, onOpen }: { s: SessionInfo; active: boolean; depth: number; onOpen(id: string): void }) {
  return (
    <button
      type="button"
      className={active ? 'tree-row is-active' : 'tree-row'}
      style={{ paddingLeft: 10 + depth * 18 }}
      onClick={() => onOpen(s.id)}
      aria-current={active ? 'page' : undefined}
      title={s.title}
    >
      <StatusMark status={s.status} />
      <span className="tree-title">{s.title}</span>
    </button>
  );
}

export function Sidebar({ sessions, activeId, onOpen, onNewChat, onSettings, settingsOpen }: SidebarProps) {
  const { chats, projects, childrenOf } = useMemo(() => {
    const chats = sessions.filter((s) => s.role === 'top' && !s.parentId).sort(byRecent);
    const projects = sessions.filter((s) => s.role === 'manager').sort(byRecent);
    const childrenOf = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      if (!s.parentId || s.role === 'manager') continue;
      const list = childrenOf.get(s.parentId) ?? [];
      list.push(s);
      childrenOf.set(s.parentId, list);
    }
    for (const list of childrenOf.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { chats, projects, childrenOf };
  }, [sessions]);

  // Projects with something going on start expanded; the rest start collapsed.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isExpanded = (p: SessionInfo) => {
    if (p.id in expanded) return expanded[p.id] === true;
    const kids = childrenOf.get(p.id) ?? [];
    return kids.some((k) => isRunning(k.status) || k.id === activeId);
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
        {chats.length ? (
          <section className="tree-section">
            <h2 className="tree-heading">对话</h2>
            {chats.map((s) => (
              <Row key={s.id} s={s} depth={0} active={!settingsOpen && s.id === activeId} onOpen={onOpen} />
            ))}
          </section>
        ) : null}
        {projects.length ? (
          <section className="tree-section">
            <h2 className="tree-heading">项目</h2>
            {projects.map((p) => {
              const kids = childrenOf.get(p.id) ?? [];
              const open = isExpanded(p);
              const summary = open ? '' : projectSummary(kids);
              const active = !settingsOpen && p.id === activeId;
              return (
                <div key={p.id} className="tree-project">
                  <div className={active ? 'tree-row tree-project-row is-active' : 'tree-row tree-project-row'}>
                    {kids.length ? (
                      <button
                        type="button"
                        className="tree-twisty"
                        aria-label={open ? `收起 ${p.title}` : `展开 ${p.title}`}
                        aria-expanded={open}
                        onClick={() => setExpanded((e) => ({ ...e, [p.id]: !open }))}
                      >
                        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
                      </button>
                    ) : (
                      <span className="tree-twisty" aria-hidden />
                    )}
                    <button type="button" className="tree-project-open" onClick={() => onOpen(p.id)} aria-current={active ? 'page' : undefined} title={p.title}>
                      <span className="tree-title">{p.title}</span>
                      {summary ? <span className={/等你/.test(summary) ? 'tree-summary is-waiting' : 'tree-summary'}>{summary}</span> : <StatusMark status={p.status} />}
                    </button>
                  </div>
                  {open
                    ? kids.map((k) => <Row key={k.id} s={k} depth={1} active={!settingsOpen && k.id === activeId} onOpen={onOpen} />)
                    : null}
                </div>
              );
            })}
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
