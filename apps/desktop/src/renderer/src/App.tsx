// The window: title bar, left sidebar, main pane (conversation or settings), right detail panel.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DesktopBridge } from '../../shared/bridge';
import { AgentStore, displayTitle, friendlyError, useAgent } from './store/agent';
import { ShellStore, useShell } from './store/shell';
import { computeLayout, toggleAction, type Floating } from './shell/layout';
import { useViewportWidth } from './shell/useViewportWidth';
import { Sidebar } from './shell/Sidebar';
import { DetailPanel } from './shell/DetailPanel';
import { Conversation, type ConversationActions } from './chat/Conversation';
import { SettingsView, type SettingsTab } from './settings/SettingsView';
import { NewProjectDialog } from './shell/NewProjectDialog';
import { NoticeBar, useBackendState, useUpdateState } from './shell/NoticeBar';
import { InboxView, type InboxProject } from './shell/InboxView';
import { MailStore, useMail } from './store/mail';
import { needsYou, unseenByManager } from '../../shared/mail';
import type { MailItem } from '@spica/protocol';
import { Icon } from './ui/Icon';
import { SpicaBanner, SpicaMark } from '@spica/brand/react';

export interface AppProps {
  version?: string;
  bridge: DesktopBridge;
  shell: ShellStore;
  agent: AgentStore;
  /** Created here when not given (tests pass their own). */
  mail?: MailStore;
}

type View = 'chat' | 'settings' | 'inbox';

/** Role template of the core's mail sorting thread; it lives in the inbox, not the sidebar. */
const MAIL_TRIAGE_TEMPLATE = 'mail-triage';

/** What the core's standing top-level agent is called until someone renames it. */
const TOP_AGENT_TITLE = '助理';

export function App({ bridge, shell, agent, version = '', mail: mailProp }: AppProps) {
  const { settings } = useShell(shell);
  const state = useAgent(agent);
  const [mailStore] = useState(() => mailProp ?? new MailStore(bridge));
  const mail = useMail(mailStore);
  useEffect(() => {
    void mailStore.reload();
    return bridge.backend.onRestarted(() => void mailStore.reload());
  }, [bridge, mailStore]);
  const width = useViewportWidth();
  const [floating, setFloating] = useState<Floating>(null);
  const [view, setView] = useState<View>('chat');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  /** The new-project dialog; from a 「新事务」 mail it carries the mail and the suggested name. */
  const [newProject, setNewProject] = useState<null | { name?: string; mailId?: string }>(null);
  const update = useUpdateState(bridge);
  const backendState = useBackendState(bridge, agent);
  const installUpdate = () => void bridge.updates.run('install');
  // Whether any model is configured; checked at start and whenever settings close.
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (view !== 'chat') return;
    let alive = true;
    bridge.providers
      .list()
      .then((l) => {
        if (alive) setModelReady(l.items.length > 0);
      })
      .catch(() => {
        if (alive) setModelReady(null);
      });
    return () => {
      alive = false;
    };
  }, [bridge, view]);
  const layout = computeLayout(width, settings.panels, floating);

  const toggle = useCallback(
    (side: 'left' | 'right') => {
      const next = toggleAction(side, window.innerWidth, shell.settings.panels, floating);
      if (next.prefs !== shell.settings.panels) shell.update({ panels: next.prefs });
      setFloating(next.floating);
    },
    [floating, shell],
  );

  // Shortcuts: Ctrl+B sidebar, Ctrl+Alt+B details, Esc closes a floating panel or settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggle(e.altKey ? 'right' : 'left');
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        if (floating) setFloating(null);
        else if (view !== 'chat') setView('chat');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, floating, view]);

  // A notice belongs to what was on screen; moving elsewhere clears it, and it fades after a while.
  useEffect(() => {
    agent.dismissNotice();
  }, [agent, view, state.activeId]);
  useEffect(() => {
    if (!state.notice) return;
    const t = setTimeout(() => agent.dismissNotice(), 8000);
    return () => clearTimeout(t);
  }, [agent, state.notice]);

  // Screenshot script hook (only set when the script asks for a different view).
  useEffect(() => {
    window.__spicaShots = {
      setView: (v) => {
        const tab: SettingsTab | null = v === 'settings' ? 'appearance' : v === 'models' || v === 'plugins' || v === 'about' || v === 'general' ? v : null;
        if (tab) setSettingsTab(tab);
        setView(tab ? 'settings' : v === 'inbox' ? 'inbox' : 'chat');
      },
    };
    return () => {
      delete window.__spicaShots;
    };
  }, []);

  // A project manager is shown under its project's name.
  const sessions = useMemo(() => {
    const byManager = new Map(state.projects.map((p) => [p.managerSessionId, p.name]));
    return state.sessions.filter((s) => s.templateId !== MAIL_TRIAGE_TEMPLATE && s.id !== mail.threadId).map((s) => ({
      ...s,
      title: byManager.get(s.id) ?? (s.id === state.topId && !s.title ? TOP_AGENT_TITLE : displayTitle(s, state.firstLines)),
    }));
  }, [state.sessions, state.firstLines, state.projects, state.topId, mail.threadId]);
  // Projects for the inbox: the core's list, plus any project manager it did not list (demo data).
  const inboxProjects = useMemo<InboxProject[]>(() => {
    const out: InboxProject[] = state.projects.filter((p) => p.status === 'active').map((p) => ({ id: p.id, name: p.name, managerSessionId: p.managerSessionId }));
    for (const s of sessions) {
      if (s.role === 'manager' && s.projectId && !out.some((p) => p.id === s.projectId)) out.push({ id: s.projectId, name: s.title ?? '', managerSessionId: s.id });
    }
    return out;
  }, [state.projects, sessions]);
  const unseen = useMemo(() => unseenByManager(mail.items, settings.mailSeen), [mail.items, settings.mailSeen]);
  const sidebarNotes = useMemo(() => new Map([...unseen.keys()].map((sid) => [sid, '有新来信'])), [unseen]);
  const inboxCount = mail.items.filter(needsYou).length;
  // Looking at a project's conversation clears its 「有新来信」.
  useEffect(() => {
    if (view === 'chat' && state.activeId && unseen.has(state.activeId)) {
      shell.update({ mailSeen: { ...shell.settings.mailSeen, [state.activeId]: new Date().toISOString() } });
    }
  }, [view, state.activeId, unseen, shell]);
  const mailById = useMemo(() => {
    const map = new Map(mail.items.map((m) => [m.id, m]));
    return (mid: string): MailItem | undefined => map.get(mid);
  }, [mail.items]);
  const session = sessions.find((s) => s.id === state.activeId);
  const parent = session?.parentId ? sessions.find((s) => s.id === session.parentId) : undefined;
  const transcript = agent.transcript(state.activeId);
  // The project the open session belongs to: its manager, or any sub-agent below it.
  const project = useMemo(() => {
    if (!session) return undefined;
    const chain = [session.id, ...session.parentChain];
    return state.projects.find((p) => chain.includes(p.managerSessionId));
  }, [session, state.projects]);
  useEffect(() => {
    if (project) void agent.loadProject(project.id);
  }, [agent, project]);
  const totalCost = useMemo(() => state.sessions.reduce((n, s) => n + s.costUsd, 0), [state.sessions]);

  const openSession = (id: string) => {
    setView('chat');
    if (layout.left === 'floating') setFloating(null);
    void agent.open(id);
  };
  const openFile = (path: string) => {
    if (!state.activeId) return;
    bridge
      .openFile(state.activeId, path)
      .then((err) => {
        if (err) agent.state.set((v) => ({ ...v, notice: err }));
      })
      .catch((err: unknown) => agent.state.set((v) => ({ ...v, notice: friendlyError(err) })));
  };
  const id = state.activeId;
  const actions: ConversationActions = {
    send: (text) => void agent.send(id, text),
    stop: () => id && void agent.stop(id),
    answer: (callId, a) => id && void agent.answer(id, callId, a),
    confirm: (callId, ok) => id && void agent.confirm(id, callId, ok),
    openFile,
    openSession: (sid) => openSession(sid),
    resume: () => id && void agent.resume(id),
    ...(mail.supported ? { mailById, openInbox: () => setView('inbox') } : {}),
  };

  const leftShown = layout.left !== 'hidden';
  const rightShown = layout.right !== 'hidden';
  const title = view === 'settings' ? '设置' : view === 'inbox' ? '收件箱' : (session?.title ?? '');

  const sidebarToggle = (
    <button type="button" className={leftShown ? 'icon-btn is-on' : 'icon-btn'} onClick={() => toggle('left')} aria-label={leftShown ? '收起侧栏' : '展开侧栏'} aria-pressed={leftShown} title="侧栏（Ctrl+B）">
      <Icon name="sidebar" />
    </button>
  );

  // Frame (like Claude Desktop): the sidebar runs the full height of the window
  // with the brand and its own toggle at the top; the title bar covers only the
  // main pane and the detail panel.
  return (
    <div className="app" data-left={layout.left} data-right={view === 'chat' ? layout.right : 'hidden'}>
      {leftShown ? (
        <div className={`panel panel-left is-${layout.left}`}>
          <div className="sidebar-head">
            <SpicaBanner height={22} className="sidebar-brand" />
            {sidebarToggle}
          </div>
          <Sidebar
            sessions={sessions}
            activeId={state.activeId}
            onOpen={openSession}
            onNewChat={() => {
              setView('chat');
              setFloating(null);
              agent.newChat();
            }}
            onSettings={() => {
              setView((v) => (v === 'settings' ? 'chat' : 'settings'));
              setFloating(null);
            }}
            settingsOpen={view === 'settings'}
            topId={state.topId}
            onRename={(sid, title) => void agent.rename(sid, title)}
            {...(bridge.agent.createProject && !shell.demo ? { onNewProject: () => setNewProject({}) } : {})}
            {...(mail.supported
              ? {
                  inbox: {
                    count: inboxCount,
                    open: view === 'inbox',
                    onOpen: () => {
                      setView((v) => (v === 'inbox' ? 'chat' : 'inbox'));
                      setFloating(null);
                    },
                  },
                  notes: sidebarNotes,
                }
              : {})}
          />
        </div>
      ) : null}

      <div className="column">
      <header className="titlebar">
        {layout.left === 'docked' ? null : (
          <div className="titlebar-left">
            <span className="titlebar-brand" aria-hidden>
              <SpicaMark size={18} />
            </span>
            {sidebarToggle}
          </div>
        )}
        <div className="titlebar-title">
          {view === 'chat' && parent ? (
            <>
              <button type="button" className="crumb" onClick={() => openSession(parent.id)} title={`回到 ${parent.title}`}>
                {parent.title}
              </button>
              <Icon name="chevronRight" size={12} className="crumb-sep" />
            </>
          ) : null}
          <span className="titlebar-text" title={title}>
            {title}
          </span>
        </div>
        {/* Updates, announcements and backend recovery live in the title bar's free
            space: nothing in the window is covered and nothing moves. */}
        <NoticeBar
          backend={backendState}
          onRetryBackend={() => bridge.backend.retry()}
          update={update}
          settings={settings}
          onInstall={installUpdate}
          onDismissNotice={(nid) => shell.update({ dismissedNotices: [...settings.dismissedNotices, nid] })}
        />
        <div className="titlebar-right">
          {view === 'chat' ? (
            <button type="button" className={rightShown ? 'icon-btn is-on' : 'icon-btn'} onClick={() => toggle('right')} aria-label={rightShown ? '收起详情' : '展开详情'} aria-pressed={rightShown} title="详情（Ctrl+Alt+B）">
              <Icon name="detail" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="body">
        <main className="main">
          {view === 'settings' ? (
            <SettingsView
              shell={shell}
              providers={bridge.providers}
              plugins={bridge.plugins}
              version={version}
              update={update}
              onCheckUpdate={() => void bridge.updates.run('check')}
              onInstallUpdate={installUpdate}
              tab={settingsTab}
              onTab={setSettingsTab}
              workflows={bridge.workflows}
              pickFolder={() => bridge.pickFolder('选择工作流文件夹')}
              onBackendRestarted={bridge.backend.onRestarted}
              projects={inboxProjects}
              exportUsageLog={bridge.exportUsageLog}
              showInFolder={bridge.showInFolder}
            />
          ) : view === 'inbox' ? (
            <InboxView
              mail={mail}
              prefs={settings.mail}
              projects={inboxProjects}
              onPoll={() => void mailStore.pollNow()}
              onAccept={(mid) => void mailStore.feedback(mid, 'accept')}
              onIgnore={(mid) => void mailStore.feedback(mid, 'ignore')}
              onMove={(mid, pid) => void mailStore.feedback(mid, 'reassign', pid)}
              {...(bridge.agent.createProject && !shell.demo
                ? { onNewProject: (m: MailItem) => setNewProject({ mailId: m.id, ...(m.triage?.suggestion ? { name: m.triage.suggestion } : {}) }) }
                : {})}
              onOpenSession={openSession}
              onOpenSettings={() => {
                setSettingsTab('general');
                setView('settings');
              }}
              onDismissProblem={() => mailStore.dismissProblem()}
            />
          ) : state.loaded ? (
            <Conversation
              session={session}
              transcript={transcript}
              actions={actions}
              demo={shell.demo}
              needsModel={modelReady === false && !shell.demo}
              onSetupModel={() => {
                setSettingsTab('models');
                setView('settings');
              }}
            />
          ) : (
            <div className="conversation" />
          )}
          {state.notice ? (
            <div className="toast" role="alert">
              <span>{state.notice}</span>
              <button type="button" className="icon-btn" onClick={() => agent.dismissNotice()} aria-label="关闭提示">
                <Icon name="close" size={14} />
              </button>
            </div>
          ) : null}
        </main>

        {rightShown && view === 'chat' ? (
          <div className={`panel panel-right is-${layout.right}`}>
            <DetailPanel
              session={session}
              parent={parent}
              transcript={transcript}
              globalCostUsd={totalCost}
              onOpenFile={openFile}
              onOpenSession={openSession}
              project={project}
              activity={project ? (state.activity[project.id] ?? []) : []}
              onClose={layout.right === 'floating' ? () => setFloating(null) : undefined}
            />
          </div>
        ) : null}

        {floating === 'right' ? <div className="scrim scrim-panel" onMouseDown={() => setFloating(null)} aria-hidden /> : null}
      </div>
      </div>

      {floating === 'left' ? <div className="scrim scrim-panel scrim-app" onMouseDown={() => setFloating(null)} aria-hidden /> : null}

      {newProject ? (
        <NewProjectDialog
          {...(newProject.name ? { initialName: newProject.name } : {})}
          onPickFolder={() => bridge.pickFolder('选择项目文件夹')}
          onCreate={async (input) => {
            const mailId = newProject.mailId;
            // A project started from a mail: the mail moves into it (its manager gets it).
            const problem = await agent.createProject(input, mailId ? (p) => mailStore.feedback(mailId, 'reassign', p.id) : undefined);
            if (!problem) {
              setNewProject(null);
              setView('chat');
              setFloating(null);
            }
            return problem;
          }}
          onClose={() => setNewProject(null)}
        />
      ) : null}
    </div>
  );
}
