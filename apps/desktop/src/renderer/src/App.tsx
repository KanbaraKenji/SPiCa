// The window: title bar, left sidebar, main pane (conversation or settings), right detail panel.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopBridge } from '../../shared/bridge';
import { AgentStore, displayTitle, friendlyError, useAgent } from './store/agent';
import { ShellStore, useShell } from './store/shell';
import { computeLayout, panelWidths, toggleAction, type Floating } from './shell/layout';
import { Resizer } from './shell/Resizer';
import { ConfirmDialog } from './ui/Dialog';
import { FilePreview, usePreview } from './shell/FilePreview';
import { PluginPage, type PluginTheme } from './shell/PluginFrame';
import { FONT_UI, pluginThemeVars, type PluginView } from '../../shared/plugin-view';
import { deriveTokens, schemeOf } from '../../shared/skin';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { APP_NAME } from '../../shared/app-identity';
import { sidebarBannerHeight, wordmarkProps } from './app-wordmark';
import { useViewportWidth } from './shell/useViewportWidth';
import { Sidebar } from './shell/Sidebar';
import { DetailPanel } from './shell/DetailPanel';
import { Conversation, type ConversationActions, type WaitingChild } from './chat/Conversation';
import type { ComposerTools } from './chat/Composer';
import type { ProviderView } from '../../shared/providers';
import { SettingsView, type SettingsTab } from './settings/SettingsView';
import { NewProjectDialog } from './shell/NewProjectDialog';
import { NoticeBar, useBackendState, useUpdateState } from './shell/NoticeBar';
import { InboxView, type InboxProject } from './shell/InboxView';
import { MailStore, useMail } from './store/mail';
import { needsYou, unseenByManager } from '../../shared/mail';
import type { MailItem } from '@spica/protocol';
import { Icon } from './ui/Icon';
import { SpicaBanner } from '@spica/brand/react';

/** The sidebar's wordmark: 22 px high, smaller for a long app name. */
const BANNER_HEIGHT = sidebarBannerHeight();

export interface AppProps {
  version?: string;
  bridge: DesktopBridge;
  shell: ShellStore;
  agent: AgentStore;
  /** Created here when not given (tests pass their own). */
  mail?: MailStore;
}

type View = 'chat' | 'settings' | 'inbox' | 'plugin';

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
  /** The file shown in the right panel instead of the details, if any. */
  const [preview, setPreview] = useState<{ sessionId: string | null; path: string } | null>(null);
  const previewInfo = usePreview(bridge.preview, preview);
  /** The project the user asked to delete (waiting for the confirmation). */
  const [deletingProject, setDeletingProject] = useState<null | { id: string; name: string }>(null);
  const update = useUpdateState(bridge);
  const backendState = useBackendState(bridge, agent);
  const installUpdate = () => void bridge.updates.run('install');
  // Whether any model is configured; checked at start and whenever settings close.
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [models, setModels] = useState<ProviderView[]>([]);
  useEffect(() => {
    if (view !== 'chat') return;
    let alive = true;
    bridge.providers
      .list()
      .then((l) => {
        if (!alive) return;
        setModelReady(l.items.length > 0);
        setModels(l.items);
      })
      .catch(() => {
        if (alive) setModelReady(null);
      });
    return () => {
      alive = false;
    };
  }, [bridge, view]);
  // 主页: the empty page before any conversation is open, and whatever Spica opens
  // by itself at start (the assistant's main conversation) until you open a
  // conversation yourself. The right panel starts closed there and opening it
  // lasts only this visit; conversations keep the saved choice (他 2026-11-10).
  // Not before the list has loaded, so start-up does not jump.
  // The conversation open when the list loaded; once another one is open (picked,
  // or a new one started) that is over for this run.
  const [launch, setLaunch] = useState<{ id: string | null; over: boolean } | null>(null);
  if (state.loaded && launch === null) setLaunch({ id: state.activeId, over: false });
  else if (launch && !launch.over && state.activeId && state.activeId !== launch.id) setLaunch({ ...launch, over: true });
  const atHome = view === 'chat' && state.loaded && (!state.activeId || (launch !== null && !launch.over && state.activeId === launch.id));
  const [homeRight, setHomeRight] = useState(false);
  if (!atHome && homeRight) setHomeRight(false);
  const panelPrefs = atHome ? { ...settings.panels, right: homeRight } : settings.panels;
  const layout = computeLayout(width, panelPrefs, floating);
  // Panel widths: what the user dragged them to (live while dragging), giving way when the window narrows.
  const [dragging, setDragging] = useState<{ side: 'left' | 'right'; width: number } | null>(null);
  // A main process older than this setting (dev build not restarted yet) does not send it.
  const savedWidths0 = settings.panelWidths ?? DEFAULT_SETTINGS.panelWidths;
  // A preview needs room: the right panel is at least 520 wide while it shows one (if the window allows).
  const savedWidths = preview ? { ...savedWidths0, right: Math.max(savedWidths0.right, 520) } : savedWidths0;
  const widths = panelWidths(width, layout, dragging ? { ...savedWidths, [dragging.side]: dragging.width } : savedWidths);
  const resizer = (side: 'left' | 'right') =>
    layout[side] === 'docked' ? (
      <Resizer
        side={side}
        width={widths[side]}
        onPreview={(w) => setDragging(w === null ? null : { side, width: w })}
        onCommit={(w) => shell.update({ panelWidths: { ...savedWidths0, [side]: w } })}
      />
    ) : null;

  // The sidebar slid out from the left edge (see below).
  const [peeking, setPeeking] = useState(false);
  const toggle = useCallback(
    (side: 'left' | 'right') => {
      const saved = shell.settings.panels;
      const prefs = atHome ? { ...saved, right: homeRight } : saved;
      const next = toggleAction(side, window.innerWidth, prefs, floating);
      if (atHome && side === 'right') setHomeRight(next.prefs.right);
      else if (next.prefs !== prefs) shell.update({ panels: atHome ? { ...next.prefs, right: saved.right } : next.prefs });
      setFloating(next.floating);
      // Opened or closed on purpose: no longer a peek from the edge.
      setPeeking(false);
    },
    [floating, shell, atHome, homeRight],
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

  // Sidebar collapsed: resting the pointer on the window's left edge slides it out
  // for a moment (like Claude Desktop); it goes away once the pointer leaves it.
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPeekTimer = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = null;
  };
  const peekSoon = () => {
    clearPeekTimer();
    peekTimer.current = setTimeout(() => {
      setPeeking(true);
      setFloating('left');
    }, 120);
  };
  const unpeekSoon = () => {
    clearPeekTimer();
    if (!peekOpen) return;
    peekTimer.current = setTimeout(() => {
      setPeeking(false);
      setFloating((f) => (f === 'left' ? null : f));
    }, 300);
  };
  useEffect(() => clearPeekTimer, []);
  // Only a sidebar the edge opened goes away on its own.
  const peekOpen = peeking && floating === 'left';

  // A floating panel closes when you press anywhere else. No dark layer behind it: the
  // window stays as it was, and that press still reaches what it was meant for.
  useEffect(() => {
    if (!floating) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      // Its own toggle button flips it itself.
      if (el?.closest('.panel.is-floating, [data-panel-toggle]')) return;
      setFloating(null);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [floating]);

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
  // Sub-agents under the open conversation that wait for the user: said under the status line,
  // so a parent that "waits for its sub-tasks" does not look stuck.
  const waiting = useMemo<WaitingChild[]>(() => {
    const id = state.activeId;
    if (!id) return [];
    return sessions
      .filter((s) => s.parentChain.includes(id) && (s.status === 'awaiting_confirm' || s.status === 'awaiting_answer'))
      .map((s) => ({ id: s.id, title: s.title ?? '子任务', status: s.status as WaitingChild['status'] }));
  }, [sessions, state.activeId]);
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

  /** Opens the right panel for something to show there (on 主页 only for this visit). */
  const showRight = (home: boolean) => {
    const prefs = home ? { ...settings.panels, right: homeRight } : settings.panels;
    if (computeLayout(width, prefs, floating).right !== 'hidden') return;
    const wanted = { ...prefs, right: true };
    if (computeLayout(width, wanted).right !== 'docked') setFloating('right');
    else if (home) setHomeRight(true);
    else shell.update({ panels: wanted });
  };

  const openSession = (id: string) => {
    setView('chat');
    if (layout.left === 'floating') setFloating(null);
    void agent.open(id);
  };
  // Files open in the right panel (read-only preview); 用系统程序打开 there hands them to Windows.
  const previewFile = (path: string) => {
    setPreview({ sessionId: state.activeId, path });
    showRight(atHome);
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
  // Plugin pages: sidebar ones open in the main pane, panel ones as tabs in the right panel.
  const [pluginViews, setPluginViews] = useState<PluginView[]>([]);
  const [pluginsChanged, setPluginsChanged] = useState(0);
  const [openPlugin, setOpenPlugin] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<string>('detail');
  const [pluginAsk, setPluginAsk] = useState<{ title: string; resolve(ok: boolean): void } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void bridge.pluginViews
        .list()
        .then((v) => alive && setPluginViews(v))
        .catch(() => undefined);
    load();
    const offChanged = bridge.plugins.onChanged(() => {
      load();
      setPluginsChanged((n) => n + 1);
    });
    const offRestart = bridge.backend.onRestarted(load);
    return () => {
      alive = false;
      offChanged();
      offRestart();
    };
  }, [bridge]);
  const viewKey = (v: PluginView) => `${v.plugin}/${v.id}`;
  const sidebarPages = pluginViews.filter((v) => v.placement === 'sidebar');
  const panelPages = pluginViews.filter((v) => v.placement === 'panel');
  const openPluginView = view === 'plugin' ? sidebarPages.find((v) => viewKey(v) === openPlugin) : undefined;
  const panelPluginView = rightTab === 'detail' ? undefined : panelPages.find((v) => viewKey(v) === rightTab);
  const skinNow = shell.activeSkin();
  const pluginTheme: PluginTheme = { mode: schemeOf(skinNow.bg), vars: pluginThemeVars(deriveTokens(skinNow), FONT_UI) };
  const pluginProps = (v: PluginView) => ({
    view: v,
    theme: pluginTheme,
    changed: pluginsChanged,
    call: (tool: string, args: unknown, confirmed: boolean) => bridge.pluginViews.call(v.plugin, v.id, tool, args, confirmed),
    confirm: (tool: string) => new Promise<boolean>((resolve) => setPluginAsk({ title: `「${v.pluginTitle}」要执行「${tool}」，这一步做了就撤不回。继续吗？`, resolve })),
    openFile: async (path: string) => {
      const abs = await bridge.pluginViews.file(v.plugin, path);
      if (!abs) return '只能打开这个插件自己文件夹里的文件。';
      setPreview({ sessionId: null, path: abs });
      setView('chat');
      showRight(!state.activeId);
      return null;
    },
    notify: (text: string) => agent.state.set((s) => ({ ...s, notice: `${v.pluginTitle}：${text}` })),
    exists: async (plugin: string, path: string) => (await bridge.pluginViews.file(plugin, path)) !== null,
  });

  const id = state.activeId;
  const usingDefaultModel = models.find((p) => p.isDefault) ?? models[0];

  // The model mail is sorted with (the core says so in mail.configured; else the default model).
  const triage = mail.triageModel ?? (usingDefaultModel ? { providerId: usingDefaultModel.id, model: usingDefaultModel.model } : null);
  const mailModelLabel = triage ? `${models.find((p) => p.id === triage.providerId)?.name ?? triage.providerId} · ${triage.model}` : '';

  // The input box's controls: what the next message goes out with.
  const draft = state.draft;
  const topCwd = state.sessions.find((s) => s.id === state.topId)?.cwd ?? '';
  const modelOptions = models.flatMap((p) => [...new Set([p.model, p.strongModel].filter(Boolean))].map((m) => ({ providerId: p.id, model: m, label: `${p.name} · ${m}` })));
  const using = session ? { providerId: session.providerId, model: session.model } : draft.providerId && draft.model ? { providerId: draft.providerId, model: draft.model } : null;
  const usingDefault = usingDefaultModel;
  const shown = using ?? (usingDefault ? { providerId: usingDefault.id, model: usingDefault.model } : null);
  const composerTools: ComposerTools = {
    pickFiles: () => bridge.pickFiles('添加附件'),
    pathForFile: bridge.pathForFile,
    ...(session
      ? {}
      : {
          folder: {
            path: draft.cwd || topCwd,
            name: (draft.cwd || topCwd).split(/[\\/]/).filter(Boolean).pop() || '默认文件夹',
            onPick: () =>
              void bridge.pickFolder('选择这个对话的工作文件夹').then((dir) => {
                if (dir) agent.setDraft({ cwd: dir });
              }),
          },
        }),
    approval: session
      ? { mode: session.approvalMode ?? 'manual', onChange: (m) => void agent.setApproval(session.id, m) }
      : { mode: draft.approvalMode, onChange: (m) => agent.setDraft({ approvalMode: m }) },
    ...(shown
      ? {
          model: {
            label: shown.model,
            options: modelOptions.map((o) => ({
              label: o.label,
              current: o.providerId === shown.providerId && o.model === shown.model,
              onPick: () => (session ? void agent.setModel(session.id, o.providerId, o.model) : agent.setDraft({ providerId: o.providerId, model: o.model })),
            })),
          },
        }
      : {}),
    // No ring until the model's 上下文上限 is known (set in 设置 › 模型).
    ...(session && typeof session.contextTokens === 'number' && session.contextWindow ? { context: { tokens: session.contextTokens, window: session.contextWindow } } : {}),
  };

  const actions: ConversationActions = {
    send: (text, files) => void agent.send(id, text, files ?? []),
    stop: () => id && void agent.stop(id),
    answer: (callId, a) => id && void agent.answer(id, callId, a),
    confirm: (callId, ok) => id && void agent.confirm(id, callId, ok),
    openFile: previewFile,
    openSession: (sid) => openSession(sid),
    resume: () => id && void agent.resume(id),
    ...(mail.supported ? { mailById, openInbox: () => setView('inbox') } : {}),
  };

  const leftShown = layout.left !== 'hidden';
  const rightShown = layout.right !== 'hidden';
  const title = view === 'settings' ? '设置' : view === 'inbox' ? '收件箱' : view === 'plugin' ? (openPluginView?.title ?? '') : (session?.title ?? '');

  const sidebarToggle = (
    <button type="button" data-panel-toggle className={leftShown ? 'icon-btn is-on' : 'icon-btn'} onClick={() => toggle('left')} aria-label={leftShown ? '收起侧栏' : '展开侧栏'} aria-pressed={leftShown} title="侧栏（Ctrl+B）">
      <Icon name="sidebar" />
    </button>
  );

  // Frame (like Claude Desktop): the sidebar runs the full height of the window
  // with the brand and its own toggle at the top; the title bar covers only the
  // main pane and the detail panel.
  return (
    <div className="app" data-left={layout.left} data-right={view === 'chat' ? layout.right : 'hidden'}>
      {layout.left === 'hidden' ? <div className="peek-edge" onMouseEnter={peekSoon} onMouseLeave={clearPeekTimer} aria-hidden /> : null}
      {leftShown ? (
        <div
          className={`panel panel-left is-${layout.left}`}
          style={{ width: widths.left }}
          {...(peekOpen ? { onMouseEnter: clearPeekTimer, onMouseLeave: unpeekSoon } : {})}
        >
          {resizer('left')}
          <div className="sidebar-head">
            <SpicaBanner height={BANNER_HEIGHT} className="sidebar-brand" {...wordmarkProps} />
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
            pluginPages={sidebarPages.map((v) => ({
              key: viewKey(v),
              title: v.title,
              ...(v.icon ? { icon: `spica-plugin://${v.plugin}/${v.icon.replace(/^\/+/, '')}` } : {}),
              open: view === 'plugin' && openPlugin === viewKey(v),
              onOpen: () => {
                setOpenPlugin(viewKey(v));
                setView('plugin');
                setFloating(null);
              },
            }))}
            pinned={settings.pinnedProjects ?? []}
            onPin={(pid, pin) => {
              const now = (settings.pinnedProjects ?? []).filter((x) => x !== pid);
              shell.update({ pinnedProjects: pin ? [...now, pid] : now });
            }}
            {...(bridge.agent.renameProject ? { onRenameProject: (pid: string, name: string) => void agent.renameProject(pid, name) } : {})}
            {...(bridge.agent.deleteProject ? { onDeleteProject: (pid: string, name: string) => setDeletingProject({ id: pid, name }) } : {})}
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
        {layout.left === 'docked' ? null : <div className="titlebar-left">{sidebarToggle}</div>}
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
            <button type="button" data-panel-toggle className={rightShown ? 'icon-btn is-on' : 'icon-btn'} onClick={() => toggle('right')} aria-label={rightShown ? '收起详情' : '展开详情'} aria-pressed={rightShown} title="详情（Ctrl+Alt+B）">
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
              onBack={() => setView('chat')}
              workflows={bridge.workflows}
              pickFolder={() => bridge.pickFolder('选择工作流文件夹')}
              onBackendRestarted={bridge.backend.onRestarted}
              projects={inboxProjects}
              exportUsageLog={bridge.exportUsageLog}
              showInFolder={bridge.showInFolder}
              mailModel={mailModelLabel}
              networkState={bridge.network}
              pickFiles={bridge.pickFiles}
              {...(shell.demo ? {} : { localConnect: bridge.localConnect })}
            />
          ) : view === 'plugin' ? (
            openPluginView ? (
              <PluginPage key={viewKey(openPluginView)} {...pluginProps(openPluginView)} />
            ) : (
              <div className="plugin-page plugin-missing">
                <p>这个插件页面已经不在了（插件可能被停用或卸载）。</p>
              </div>
            )
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
              waiting={waiting}
              composerTools={composerTools}
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
          <div className={`panel panel-right is-${layout.right}`} style={{ width: widths.right }}>
            {resizer('right')}
            {panelPages.length && !preview ? (
              <div className="tabs right-tabs" role="tablist" aria-label="右栏">
                <button type="button" role="tab" aria-selected={!panelPluginView} className={!panelPluginView ? 'tab is-on' : 'tab'} onClick={() => setRightTab('detail')}>
                  详情
                </button>
                {panelPages.map((v) => (
                  <button key={viewKey(v)} type="button" role="tab" aria-selected={rightTab === viewKey(v)} className={rightTab === viewKey(v) ? 'tab is-on' : 'tab'} onClick={() => setRightTab(viewKey(v))} title={v.pluginTitle}>
                    {v.title}
                  </button>
                ))}
              </div>
            ) : null}
            {panelPluginView && !preview ? (
              <PluginPage key={viewKey(panelPluginView)} {...pluginProps(panelPluginView)} />
            ) : preview ? (
              <FilePreview
                info={previewInfo}
                onOpenExternal={(p) => {
                  if (preview.sessionId) {
                    void bridge.openFile(preview.sessionId, p).then((err) => err && agent.state.set((v) => ({ ...v, notice: err })));
                  }
                }}
                onClose={() => setPreview(null)}
              />
            ) : (
            <DetailPanel
              session={session}
              parent={parent}
              transcript={transcript}
              globalCostUsd={totalCost}
              onOpenFile={openFile}
              onPreviewFile={previewFile}
              onOpenSession={openSession}
              project={project}
              activity={project ? (state.activity[project.id] ?? []) : []}
              onClose={layout.right === 'floating' ? () => setFloating(null) : undefined}
              hideHeading={panelPages.length > 0}
            />
            )}
          </div>
        ) : null}

      </div>
      </div>


      {pluginAsk ? (
        <ConfirmDialog
          title={pluginAsk.title}
          confirmLabel="继续"
          danger
          onCancel={() => {
            pluginAsk.resolve(false);
            setPluginAsk(null);
          }}
          onConfirm={() => {
            pluginAsk.resolve(true);
            setPluginAsk(null);
          }}
        />
      ) : null}

      {deletingProject ? (
        <ConfirmDialog
          title={`删除项目「${deletingProject.name}」？`}
          detail={`只删 ${APP_NAME} 里的这个项目和它的对话记录；项目文件夹和里面的文件不会动。`}
          confirmLabel="删除"
          danger
          onCancel={() => setDeletingProject(null)}
          onConfirm={() => {
            const pid = deletingProject.id;
            setDeletingProject(null);
            void agent.deleteProject(pid).then((problem) => {
              if (problem) return;
              const pins = settings.pinnedProjects ?? [];
              if (pins.includes(pid)) shell.update({ pinnedProjects: pins.filter((x) => x !== pid) });
            });
          }}
        />
      ) : null}

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
