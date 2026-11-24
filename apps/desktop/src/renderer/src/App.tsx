// The window: title bar, left sidebar, main pane (conversation, inbox or a plugin page), right panels; settings as a dialog over it.
import { mcpApiOf } from './settings/mcp-api';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DesktopBridge } from '../../shared/bridge';
import { AgentStore, displayTitle, friendlyError, useAgent } from './store/agent';
import { ShellStore, useShell } from './store/shell';
import { centreShift, computeLayout, infoFits, monitorFits, panelWidths, previewFloats, previewMaxWidth, toggleFrom, type Floating, type Open } from './shell/layout';
import { Resizer } from './shell/Resizer';
import { ConfirmDialog } from './ui/Dialog';
import { FilePreview, usePreview } from './shell/FilePreview';
import { PluginPage, type PluginTheme } from './shell/PluginFrame';
import { PluginPreview, type PreviewFallback } from './shell/PluginPreview';
import { pressFile, type FilePress } from './shell/open-file';
import { BUILT_IN, chosenPreviewPage, fileExtension, previewerId, previewPagesFor } from '../../shared/previewers';
import { pluginThemeVars, type PluginView } from '../../shared/plugin-view';
import { uiFontFor } from './theme';
import { deriveTokens, schemeOf } from '../../shared/skin';
import { DEFAULT_SETTINGS, effectiveAccount, effectiveCallName } from '../../shared/settings';
import { sidebarBannerHeight, wordmarkProps } from './app-wordmark';
import { useViewportWidth } from './shell/useViewportWidth';
import { Sidebar } from './shell/Sidebar';
import { canRename, commitRename, hasRowMenu, RenameField, rowMenuItems, type RowActions } from './shell/row-menu';
import { ContextMenu } from './ui/ContextMenu';
import { DetailPanel } from './shell/DetailPanel';
import { ProjectPage } from './shell/ProjectPage';
import { runningJobs } from './shell/CommandJobs';
import { Conversation, type ConversationActions, type WaitingChild } from './chat/Conversation';
import { ConfirmTarget } from './chat/Blocks';
import { ChildSourceContext, type ChildSource } from './chat/ChildProgress';
import type { ComposerTools } from './chat/Composer';
import { enabledModels, type ModelRef, type ProviderView } from '../../shared/providers';
import { SettingsView, type SettingsTab } from './settings/SettingsView';
import { openProviderNext } from './settings/Models';
import type { PluginsTab } from './settings/Plugins';
import { NewProjectDialog } from './shell/NewProjectDialog';
import { NoticeBar, useBackendState, useUpdateState } from './shell/NoticeBar';
import { UpdateCard, UpdateRailButton, useUpdateNotice, type WaitingPlugin } from './shell/UpdateNotice';
import { ForcedUpdate } from './shell/ForcedUpdate';
import { InboxView, type InboxProject } from './shell/InboxView';
import type { UsageApi } from './settings/Usage';
import { MonitorView } from './shell/MonitorView';
import { ToolHistory } from './shell/ToolHistory';
import { PaneTabs } from './shell/PaneTabs';
import { BrowserPane } from './shell/BrowserPane';
import { LinkRouter } from './shell/links';
import { activate as activatePane, activeTab, closeTab as closePaneTab, NO_TABS, openFile as openPaneFile, openWeb as openPaneWeb, setOpen as setPaneOpen, tabName, updateActiveFile, updateWeb as updatePaneWeb, type FileRequest, type PaneTab, type PaneTabs as PaneTabsState } from './shell/pane-tabs';
import { MaxButton } from './ui/MaxButton';
import { MailStore, useMail } from './store/mail';
import { needsYou } from '../../shared/mail';
import { nextDoneNews, unseenDone } from './shell/row-status';
import type { MailItem, MemoryEntryInput, SessionInfo } from '@spica/protocol';
import { Icon } from './ui/Icon';
import { sidebarNews } from './shell/sidebar-news';
import { watchCover } from './ui/dim';
import { usePeek } from './shell/peek';
import { RailHead, SidebarHead, SidebarToggle } from './shell/SidebarToggle';
import { HoverTips } from './ui/HoverTips';
import { useEscape } from './ui/escape';
import { SpicaBanner } from '@spica/brand/react';
import { sameFolder } from './store/relocate';
import { APP_NAME } from '../../shared/app-identity';
import { getLocale, t, tc, tx } from '../../shared/i18n';
import { useLocale } from './i18n';
import type { ScheduleInfo } from '@spica/protocol';
import { SchedulesStore, schedulesNeedingYou, useSchedules } from './store/schedules';
import { RunCards, ScheduleDetail, ScheduleDialog, SchedulePage, TrayAsk } from './schedule/ScheduleViews';

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

/** 'project': the page of a project that holds sub-projects. */
type View = 'chat' | 'inbox' | 'plugin' | 'project' | 'schedule';

/** Role template of the core's mail sorting thread; it lives in the inbox, not the sidebar. */
const MAIL_TRIAGE_TEMPLATE = 'mail-triage';

/** What the core's standing top-level agent is called until someone renames it. */

/** The time now, again each minute (the 定时任务 page says 今天 / 明天 and the next run). */
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function App({ bridge, shell, agent, version = '', mail: mailProp }: AppProps) {
  const { settings } = useShell(shell);
  const state = useAgent(agent);
  const [mailStore] = useState(() => mailProp ?? new MailStore(bridge));
  const mail = useMail(mailStore);
  useEffect(() => {
    void mailStore.reload();
    return bridge.backend.onRestarted(() => void mailStore.reload());
  }, [bridge, mailStore]);
  // 定时任务: the core's tasks, kept fresh by its events; the page, the form (new or a task to change), the clock.
  const [schedStore] = useState(() => new SchedulesStore(bridge));
  const scheds = useSchedules(schedStore);
  useEffect(() => {
    void schedStore.reload();
    return bridge.backend.onRestarted(() => void schedStore.reload());
  }, [bridge, schedStore]);
  const [schedForm, setSchedForm] = useState<null | { editing?: ScheduleInfo }>(null);
  const [trayAsk, setTrayAsk] = useState(false);
  const schedNow = useMinute();
  const loadRuns = useCallback((id: string) => bridge.agent.listScheduleRuns?.({ scheduleId: id, limit: 5 }) ?? Promise.resolve([]), [bridge]);
  const width = useViewportWidth();
  const [floating, setFloating] = useState<Floating>(null);
  const [view, setView] = useState<View>('chat');
  /** The project whose page is open (view 'project'). */
  const [projectPageId, setProjectPageId] = useState<string | null>(null);
  const openProjectRef = useRef<(id: string) => void>(() => undefined);
  // Settings: a dialog over whatever is open; it opens again on the section (and 插件's tab) it was left at.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [pluginsTab, setPluginsTab] = useState<PluginsTab>('installed');
  /** A settings row to bring into sight when the settings open (设置 › 常规 › 网络 from a failed download). */
  const [settingsReveal, setSettingsReveal] = useState<{ title: string; at: number } | undefined>(undefined);
  const openSettings = useCallback((tab?: SettingsTab, plugins?: PluginsTab) => {
    if (tab) setSettingsTab(tab);
    if (plugins) setPluginsTab(plugins);
    setSettingsOpen(true);
  }, []);
  /** The new-project dialog; from a 「新事务」 mail it carries the mail and the suggested name. */
  const [newProject, setNewProject] = useState<null | { name?: string; mailId?: string; parentId?: string }>(null);
  /** The file shown in the right panel instead of the details, if any. */
  // A file to show in the right panel, or (inline) a page from an answer's HTML code block.
  // The right panel's tabs: files and web pages side by side (shell/pane-tabs.ts). `preview` is the file shown;
  // its `opened`: when the file was asked for; asked for again (the same file pressed again), it is read again.
  const [pane, setPane] = useState<PaneTabsState>(NO_TABS);
  const shownTab = pane.open ? activeTab(pane) : undefined;
  const preview: FileRequest | null = shownTab?.kind === 'file' ? shownTab.req : null;
  /** A file to show (its tab, or a new one); null closes the panel; a function changes the file shown (another sheet). */
  const setPreview = (v: FileRequest | null | ((r: FileRequest) => FileRequest)) =>
    setPane((s) => (v === null ? setPaneOpen(s, false) : typeof v === 'function' ? updateActiveFile(s, v) : openPaneFile(s, v)));
  const [previewWay, setPreviewWay] = useState<{ key: string; id: string } | null>(null);
  const [previewFallback, setPreviewFallback] = useState<{ key: string; id: string; why: PreviewFallback } | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  /** The project the user asked to delete (waiting for the confirmation). */
  const [deletingProject, setDeletingProject] = useState<null | { id: string; name: string }>(null);
  const [deletingChat, setDeletingChat] = useState<null | { id: string; name: string }>(null);
  const update = useUpdateState(bridge);
  // plugins turned on but waiting for required settings (待设置): said where plugin updates are
  const [pluginsWaiting, setPluginsWaiting] = useState<WaitingPlugin[]>([]);
  const updateNotice = useUpdateNotice(update, pluginsWaiting);
  const backendState = useBackendState(bridge, agent);
  const installUpdate = () => void bridge.updates.run('install');
  // Whether any model is configured; checked at start and whenever settings close.
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [models, setModels] = useState<ProviderView[]>([]);
  const [pointers, setPointers] = useState<{ default: ModelRef | null; strong: ModelRef | null }>({ default: null, strong: null });
  // The core asks which conversation is open ('ui.activeSession') to put settings-change cards there too.
  useEffect(() => bridge.reportActiveSession(state.activeId), [bridge, state.activeId]);
  // The caption symbols follow what covers the page (the opening animation, a scrim).
  useEffect(() => watchCover(document, (c) => bridge.reportCover(c)), [bridge]);
  // A connected script changed the models (through the MCP service): look again.
  const [modelsChanged, setModelsChanged] = useState(0);
  useEffect(() => bridge.providers.onChanged(() => setModelsChanged((n) => n + 1)), [bridge]);
  useEffect(() => {
    if (view !== 'chat' || settingsOpen) return;
    let alive = true;
    bridge.providers
      .list()
      .then((l) => {
        if (!alive) return;
        setModelReady(l.items.length > 0);
        setModels(l.items);
        setPointers({ default: l.default ?? null, strong: l.strong ?? null });
      })
      .catch(() => {
        if (alive) setModelReady(null);
      });
    return () => {
      alive = false;
    };
  }, [bridge, view, settingsOpen, modelsChanged]);
  // 主页: the empty page before any conversation is open, and whatever Spica opens
  // by itself at start (the assistant's main conversation) until you open a
  // conversation yourself. The details panel starts closed there and opening it
  // lasts only this visit; conversations keep the saved choice. (The file preview
  // has no such rule: it is open while a file is shown, anywhere.)
  // Not before the list has loaded, so start-up does not jump.
  // The conversation open when the list loaded; once another one is open (picked,
  // or a new one started) that is over for this run.
  const [launch, setLaunch] = useState<{ id: string | null; over: boolean } | null>(null);
  if (state.loaded && launch === null) setLaunch({ id: state.activeId, over: false });
  else if (launch && !launch.over && state.activeId && state.activeId !== launch.id) setLaunch({ ...launch, over: true });
  const atHome = view === 'chat' && state.loaded && (!state.activeId || (launch !== null && !launch.over && state.activeId === launch.id));
  const [homeRight, setHomeRight] = useState(false);
  if (!atHome && homeRight) setHomeRight(false);
  // The panels around the conversation (shell/layout.ts): the sidebar, the file preview (open while a file is
  // shown), the details (详情, the saved switch panels.right) and, once switched on in 设置 › 关于, the 监控台
  // (panels.monitor).
  // The preview's place also shows 工具调用 X (the details' last row): the finished calls of this conversation.
  const [history, setHistory] = useState(false);
  const previewOpen = pane.open || history;
  const monitorOpen = settings.monitor ? Boolean(settings.panels.monitor) : undefined;
  // As Claude's Files: while the monitor or the preview is open the details give way at once (not docked); their
  // button then shows them as a small card over the conversation's top right (infoFloat). Their saved switch stays:
  // closed the monitor and the preview, the details are back beside the conversation.
  const infoBlocked = previewOpen || Boolean(monitorOpen);
  const [infoFloat, setInfoFloat] = useState(false);
  const open: Open = { left: settings.panels.left, info: !infoBlocked && (atHome ? homeRight : settings.panels.right), preview: previewOpen, ...(monitorOpen === undefined ? {} : { monitor: monitorOpen }) };
  // Panel widths: what the user dragged them to (live while dragging), giving way when the window narrows.
  const [dragging, setDragging] = useState<{ side: 'left' | 'preview'; width: number } | null>(null);
  // A main process older than these settings (dev build not restarted yet) does not send them.
  const savedWidths = { ...DEFAULT_SETTINGS.panelWidths, ...settings.panelWidths };
  // While an edge is dragged, everything follows the pointer: the conversation squeezed, the details gone, the
  // preview over the conversation, exactly as it will stay when the button is let go (nothing jumps then).
  const wantedWidths = dragging ? { ...savedWidths, [dragging.side]: dragging.width } : savedWidths;
  const layout = computeLayout(width, open, floating, wantedWidths);
  const widths = panelWidths(width, layout, wantedWidths);
  // The content column: at rest as if nothing were docked on the right, pushed left by a right panel (styles.css:
  // --centre-shift).
  const shift = centreShift(width, layout, widths, view === 'chat');
  const resizer = (side: 'left' | 'preview') =>
    layout[side] === 'docked' ? (
      <Resizer
        side={side}
        width={widths[side]}
        {...(side === 'preview' ? { max: previewMaxWidth(width, layout, widths) } : {})}
        onPreview={(w) => setDragging(w === null ? null : { side, width: w })}
        onCommit={(w) => shell.update({ panelWidths: { ...savedWidths, [side]: w } })}
      />
    ) : null;

  // The sidebar slid out from the left edge (see below).
  const [peeking, setPeeking] = useState(false);
  const toggle = useCallback(
    (side: 'left' | 'info') => {
      const saved = shell.settings.panels;
      const monitor = shell.settings.monitor ? Boolean(saved.monitor) : undefined;
      // the details given way to the monitor or the preview: their button shows or hides the small card
      if (side === 'info' && (previewOpen || monitor)) {
        setInfoFloat((v) => !v);
        return;
      }
      const now: Open = { left: saved.left, info: atHome ? homeRight : saved.right, preview: previewOpen, ...(monitor === undefined ? {} : { monitor }) };
      const next = toggleFrom(side, window.innerWidth, now, floating, peeking, { ...DEFAULT_SETTINGS.panelWidths, ...shell.settings.panelWidths });
      if (atHome && side === 'info') setHomeRight(next.open.info);
      else if (next.open !== now) shell.update({ panels: { ...saved, left: next.open.left, right: atHome ? saved.right : next.open.info } });
      setFloating(next.floating);
      // Opened or closed on purpose: no longer a peek from the edge.
      setPeeking(false);
    },
    [floating, shell, atHome, homeRight, peeking, previewOpen],
  );

  // The open conversation's name being edited in the title bar (its session id), and its menu there.
  const [titleEditing, setTitleEditing] = useState<string | null>(null);
  const [titleMenu, setTitleMenu] = useState<{ x: number; y: number } | null>(null);
  const openTitleMenu = (e: { preventDefault(): void; clientX: number; clientY: number }) => {
    e.preventDefault();
    setTitleMenu({ x: e.clientX, y: e.clientY });
  };

  // The file preview over the whole conversation (an expand button, Ctrl+Shift+\); for this visit only.
  const [rightMax, setRightMax] = useState(false);
  // Only while the preview is there to show (set below, once the layout is known).
  const [canMax, setCanMax] = useState(false);

  // Shortcuts: Ctrl+B sidebar, Ctrl+Alt+B details, Ctrl+Shift+\ the preview over the conversation.
  // Esc is ui/escape.ts's: each thing that opens over the window is a layer (see the useEscape calls below).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggle(e.altKey ? 'info' : 'left');
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'Backslash') {
        if (!canMax) return;
        e.preventDefault();
        setRightMax((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, canMax]);
  // A layer of Esc: the inbox or a plugin page in place of the conversation (back to it), under all the
  // others (a panel slid out over it goes first). The settings dialog is one through useModal; a slid-out panel below.
  useEscape(view !== 'chat', () => setView('chat'), { under: true });

  // Sidebar collapsed: resting the pointer on its toggle slides it out for a moment;
  // it goes away once the pointer leaves it. The icons of the column do not slide it out.
  const peek = usePeek(
    () => {
      setPeeking(true);
      setFloating('left');
    },
    () => {
      setPeeking(false);
      setFloating((f) => (f === 'left' ? null : f));
    },
  );
  // Only a sidebar the edge opened goes away on its own.
  const peekOpen = peeking && floating === 'left';
  // Esc puts a slid-out panel away. One slid out by resting on the toggle stays away while the pointer is still
  // there (it would slide out again at once); leaving the toggle ends that.
  const peekHeld = useRef(false);
  useEscape(floating !== null, () => {
    peek.cancel();
    setFloating(null);
    if (!peekOpen) return;
    peekHeld.current = true;
    // The pointer may have been anywhere on the panel: the first move that is not on the toggle ends the hold.
    const moved = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('.rail-toggle')) return;
      peekHeld.current = false;
      window.removeEventListener('pointermove', moved, true);
    };
    window.addEventListener('pointermove', moved, true);
  });

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
        const tab: SettingsTab | null = v === 'settings' ? 'appearance' : v === 'models' || v === 'usage' || v === 'plugins' || v === 'about' || v === 'general' ? v : null;
        // A settings view: the dialog open on that section, over the conversation.
        if (tab) setSettingsTab(tab);
        setSettingsOpen(tab !== null);
        setView(v === 'inbox' ? 'inbox' : 'chat');
      },
      openProject: (id) => openProjectRef.current(id),
    };
    return () => {
      delete window.__spicaShots;
    };
  }, []);

  // Memos holding words (a conversation's name when it has none) are made again in a new language.
  const locale = useLocale();
  // A project manager is shown under its project's name.
  const sessions = useMemo(() => {
    const byManager = new Map(state.projects.map((p) => [p.managerSessionId, p.name]));
    return state.sessions.filter((s) => s.templateId !== MAIL_TRIAGE_TEMPLATE && s.id !== mail.threadId).map((s) => ({
      ...s,
      title: byManager.get(s.id) ?? displayTitle(s, state.firstLines),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sessions, state.firstLines, state.projects, mail.threadId, locale]);
  // The 等待子任务 row opened: each sub-agent's name and plan, from its own conversation.
  const childSource = useMemo<ChildSource>(() => ({ parentId: state.activeId, sessions, transcripts: state.transcripts, load: (id) => void agent.load(id) }), [agent, state.activeId, sessions, state.transcripts]);
  // Sub-agents under the open conversation that wait for the user: said under the status line,
  // so a parent that "waits for its sub-tasks" does not look stuck.
  const waiting = useMemo<WaitingChild[]>(() => {
    const id = state.activeId;
    if (!id) return [];
    return sessions
      .filter((s) => s.parentChain.includes(id) && (s.status === 'awaiting_confirm' || s.status === 'awaiting_answer'))
      .map((s) => ({ id: s.id, title: s.title ?? t('子任务'), status: s.status as WaitingChild['status'] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, state.activeId, locale]);
  // Projects for the inbox: the core's list, plus any project manager it did not list (demo data).
  const inboxProjects = useMemo<InboxProject[]>(() => {
    const out: InboxProject[] = state.projects.filter((p) => p.status === 'active' && p.managerSessionId).map((p) => ({ id: p.id, name: p.name, managerSessionId: p.managerSessionId }));
    for (const s of sessions) {
      if (s.role === 'manager' && s.projectId && !out.some((p) => p.id === s.projectId)) out.push({ id: s.projectId, name: s.title ?? '', managerSessionId: s.id });
    }
    return out;
  }, [state.projects, sessions]);
  const schedCards = useMemo(() => schedulesNeedingYou(scheds.items), [scheds.items]);
  const inboxCount = mail.items.filter(needsYou).length + schedCards.length;
  // Finished sub-tasks not opened since they finished: news on their row. Opening one records it.
  const doneNews = useMemo(() => unseenDone(sessions, settings.doneNews ?? []), [sessions, settings.doneNews]);
  const statusBefore = useRef<Map<string, SessionInfo['status']> | null>(null);
  const [windowSince] = useState(() => new Date().toISOString());
  useEffect(() => {
    if (!state.loaded) return;
    const next = nextDoneNews(statusBefore.current, sessions, shell.settings.doneNews ?? [], view === 'chat' ? state.activeId : null, windowSince);
    const seen = (statusBefore.current ??= new Map());
    for (const s of sessions) seen.set(s.id, s.status);
    if (next) shell.update({ doneNews: next });
  }, [state.loaded, sessions, view, state.activeId, shell, windowSince]);
  const mailById = useMemo(() => {
    const map = new Map(mail.items.map((m) => [m.id, m]));
    return (mid: string): MailItem | undefined => map.get(mid);
  }, [mail.items]);
  const session = sessions.find((s) => s.id === state.activeId);
  const parent = session?.parentId ? sessions.find((s) => s.id === session.parentId) : undefined;
  const transcript = agent.transcript(state.activeId);
  // the 定时任务 this conversation runs for: set up to run here, or its last run is this conversation
  const schedOfSession = state.activeId ? scheds.items.find((s) => s.sessionId === state.activeId || s.lastRun?.sessionId === state.activeId) : undefined;
  // The project the open session belongs to: its manager, or any sub-agent below it.
  const project = useMemo(() => {
    if (!session) return undefined;
    const chain = [session.id, ...session.parentChain];
    return state.projects.find((p) => chain.includes(p.managerSessionId));
  }, [session, state.projects]);
  // Opening a project (its manager or anything under it) means its reports have been seen.
  const unreadProject = project?.unread ? project.id : null;
  useEffect(() => {
    if (unreadProject && view === 'chat') void bridge.markProjectRead(unreadProject).catch(() => undefined);
  }, [bridge, unreadProject, view]);
  useEffect(() => {
    if (project) void agent.loadProject(project.id);
  }, [agent, project]);
  const totalCost = useMemo(() => state.sessions.reduce((n, s) => n + s.costUsd, 0), [state.sessions]);
  const anyUnpriced = useMemo(() => state.sessions.some((s) => s.unpriced), [state.sessions]);

  /** A file to show (set just before): the preview beside the conversation when it fits, else over the window. */
  const showPreview = () => {
    if (previewFloats(width, open, savedWidths)) setFloating('preview');
    else if (floating === 'preview') setFloating(null);
  };
  // The screenshot script hook (above) also opens a file to show in the preview panel (an absolute path), for pictures of the panel.
  useEffect(() => {
    if (window.__spicaShots)
      window.__spicaShots.preview = (path) => {
        setPane((s) => openPaneFile(s, { sessionId: null, path, opened: Date.now() }));
        showPreview();
      };
  });
  // Closed, the panel keeps its tabs: the title bar's preview button opens it again on the tab last shown.
  const lastTab = pane.open ? undefined : activeTab(pane);
  const lastPreview = lastTab ?? null;
  const closePreview = () => {
    setPane((s) => setPaneOpen(s, false));
    // The workbooks kept for paging and going back to a sheet go with the panel.
    bridge.previewClosed();
    if (floating === 'preview') setFloating(null);
  };
  /** A web page in a new tab of the panel ('' : an empty one). */
  const openWebTab = (url: string) => {
    setPane((s) => openPaneWeb(s, url));
    setHistory(false);
    showPreview();
  };
  useEffect(() => bridge.browser.onOpenTab((url) => openWebTab(url)));
  // The agent's browser tools (main/browser/agent.ts) ask the window: open a tab for a conversation, show one, list a
  // conversation's tabs with their pages' ids. Kept in refs: the answer is given after React has drawn the change.
  const pagesRef = useRef(new Map<string, number>());
  // Agent tabs the person took over (pressed in the page, or 接手): the main process says so (main/browser/agent.ts).
  const [takenTabs, setTakenTabs] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(
    () =>
      bridge.browser.onTakeOver(({ tabId, taken }) =>
        setTakenTabs((s) => {
          const next = new Set(s);
          if (taken) next.add(tabId);
          else next.delete(tabId);
          return next;
        }),
      ),
    [bridge],
  );
  const paneRef = useRef(pane);
  const viewRef = useRef(view);
  const historyRef = useRef(history);
  useEffect(() => {
    paneRef.current = pane;
    viewRef.current = view;
    historyRef.current = history;
  });
  useEffect(
    () =>
      bridge.browser.onAgentAsk(({ id, op, args }) => {
        const reply = (answer: { ok: boolean; value?: unknown; error?: string }) => void bridge.browser.agentReply(id, answer);
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
        const info = (tab: PaneTab) => ({ tabId: tab.id, wcId: pagesRef.current.get(tab.id) ?? null, url: tab.kind === 'web' ? tab.url : '', title: tab.kind === 'web' ? tab.title : '' });
        // on screen: the panel open and drawn (the conversation view, not 工具调用 over it), the tab in front
        const onScreen = (tabId: string) => viewRef.current === 'chat' && !historyRef.current && paneRef.current.open && paneRef.current.active === tabId;
        const afterDraw = (f: () => void) => requestAnimationFrame(() => requestAnimationFrame(f));
        if (op === 'tabs') {
          reply({ ok: true, value: paneRef.current.tabs.filter((x) => x.kind === 'web' && x.agent === sessionId).map(info) });
        } else if (op === 'show') {
          const tabId = String(args.tabId ?? '');
          setPane((s) => activatePane(s, tabId));
          setHistory(false);
          showPreview();
          afterDraw(() => reply({ ok: true, value: onScreen(tabId) }));
        } else if (op === 'open') {
          if (viewRef.current !== 'chat') {
            reply({ ok: false, error: 'the person is on another page of the app (not a conversation); the browser panel is not there now' });
            return;
          }
          const url = String(args.url ?? '');
          const tabId = `t${paneRef.current.next}`;
          setPane((s) => openPaneWeb(s, url, sessionId));
          setHistory(false);
          showPreview();
          // the page exists once it reports its id
          const started = Date.now();
          const check = () => {
            const tab = paneRef.current.tabs.find((x) => x.id === tabId);
            if (tab && pagesRef.current.has(tabId)) reply({ ok: true, value: info(tab) });
            else if (Date.now() - started > 15_000) reply({ ok: false, error: 'the page did not start' });
            else setTimeout(check, 100);
          };
          afterDraw(check);
        } else reply({ ok: false, error: `unknown request ${String(op)}` });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bridge],
  );  // The screenshot script hook: a web page in a new tab of the panel.
  useEffect(() => {
    if (window.__spicaShots) window.__spicaShots.browse = (url) => openWebTab(url);
  });
  /**
   * The title bar's preview button: closes what is in the preview's place (the file, and 工具调用 if it is over it), or
   * opens again the file last shown there.
   */
  const togglePreview = () => {
    if (history || pane.open) {
      setHistory(false);
      closePreview();
    } else if (lastPreview) {
      setPane((s) => setPaneOpen(s, true));
      showPreview();
    }
  };

  /** A project's page in the main area; its sub-projects' activity loads behind it. */
  const openProject = (pid: string) => {
    setView('project');
    setProjectPageId(pid);
    setSettingsOpen(false);
    if (layout.left === 'floating') setFloating(null);
    for (const p of state.projects) if (p.parentId === pid || p.id === pid) void agent.loadProject(p.id);
  };
  // the screenshot hook (set once) reaches the latest one
  useEffect(() => {
    openProjectRef.current = openProject;
  });
  const openSession = (id: string) => {
    setView('chat');
    // From the settings (设置 › 记忆): the conversation is what is wanted now.
    setSettingsOpen(false);
    if (layout.left === 'floating') setFloating(null);
    void agent.open(id);
  };
  // Opened from a history row or link: the message to show, and the conversation it was opened from (返回).
  // Kept while that conversation is open; going anywhere else ends it.
  const [found, setFound] = useState<{ sessionId: string; seq?: number; from: string | null; reached: boolean } | null>(null);
  if (found && !found.reached && state.activeId === found.sessionId) setFound({ ...found, reached: true });
  else if (found?.reached && state.activeId !== found.sessionId) setFound(null);
  const openFound = (id: string, seq?: number) => {
    setFound({ sessionId: id, ...(seq !== undefined ? { seq } : {}), from: state.activeId, reached: false });
    openSession(id);
  };
  // 设置 › 记忆: an item's conversation, at the message it was saved from (no way back: it was opened from the settings).
  const memorySettings = agent.hasMemory
    ? {
        items: state.memories,
        entries: state.memoryEntries,
        api: {
          add: (text: string, entry: number | MemoryEntryInput) => agent.addMemory(text, entry),
          edit: (id: number, text: string) => agent.editMemory(id, text),
          editEntry: (id: number, entry: MemoryEntryInput) => agent.editMemoryEntry(id, entry),
          forget: (id: number) => agent.forgetMemory(id),
          deleteEntry: (id: number) => agent.deleteMemoryEntry(id),
          clear: () => agent.clearMemories(),
        },
        titleOf: (id: string) => {
          const s = sessions.find((x) => x.id === id);
          return s ? s.title || t('新对话') : undefined;
        },
        onOpenSession: (id: string, seq?: number) => {
          setFound({ sessionId: id, ...(seq !== undefined ? { seq } : {}), from: null, reached: false });
          openSession(id);
        },
        tidy: agent.hasTidy
          ? {
              runs: state.tidies,
              auto: settings.memoryAutoTidy,
              onAuto: (on: boolean) => shell.update({ memoryAutoTidy: on }),
              run: () => agent.tidyMemories(),
              undo: (id: number, change?: number) => agent.undoMemoryTidy(id, change),
            }
          : undefined,
        // The box at the bottom of an entry's page: a sentence for the model to change it.
        ask: agent.hasMemoryAsk
          ? {
              runs: state.memoryAsks,
              send: (target: { entry: number } | { item: number }, text: string) => agent.askMemory(target, text),
              stop: (id: number) => agent.stopMemoryTidy(id),
              undo: (id: number, change?: number) => agent.undoMemoryTidy(id, change),
              noModel: modelReady === false && !shell.demo,
            }
          : undefined,
      }
    : undefined;
  const memoryLines = useMemo(() => ({ items: state.memories, undo: (id: number) => agent.undoMemory(id) }), [state.memories, agent]);
  // Files open in the preview panel (read-only); 用系统程序打开 there hands them to Windows.
  // A press on a file: the preview, or its system program for a kind the panel does not show (shell/open-file.ts).
  const filePress = (sessionId: string | null): FilePress => ({
    pages: pluginViews.filter((v) => v.placement === 'preview'),
    open: (path) => bridge.openFile(sessionId, path),
    preview: (path) => setPreview({ sessionId, path, opened: Date.now() }),
    notice: (text) => agent.state.set((v) => ({ ...v, notice: text })),
  });
  const previewFile = (path: string) => {
    if (pressFile(path, filePress(state.activeId)) !== 'preview') return;
    setHistory(false);
    showPreview();
  };
  /** A line in the notice bar (null: nothing to say). */
  const showNotice = (text: string | null) => {
    if (text) agent.state.set((v) => ({ ...v, notice: text }));
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
  const [pluginAsk, setPluginAsk] = useState<{ plugin: string; tool: string; args: unknown; resolve(ok: boolean): void } | null>(null);
  // 设置 › 插件: the plugin commands, and the system folder picker for 插件位置.
  // 设置 › 用量: the core's request log summed up, the saved connections' names beside it.
  const usageApi = useMemo<UsageApi>(
    () => ({
      summary: (q) => bridge.usageSummary(q),
      providerNames: async () => Object.fromEntries((await bridge.providers.list()).items.map((p) => [p.id, p.name])),
      pluginNames: async () => Object.fromEntries((await bridge.plugins.run({ op: 'state' })).state.plugins.map((p) => [p.name, p.displayName.trim() || p.name])),
      saveCsv: (name, text) => bridge.saveCsv(name, text),
      showInFolder: (path) => void bridge.showInFolder(path),
    }),
    [bridge],
  );
  const pluginsApi = useMemo(
    () => ({
      ...bridge.plugins,
      pickFolder: () => bridge.pickFolder(t('选择插件文件夹')),
      // a folder or file field of a plugin's settings form
      pickPath: async (kind: 'folder' | 'file', title: string) => (kind === 'folder' ? bridge.pickFolder(title) : ((await bridge.pickFiles(title))[0] ?? null)),
    }),
    [bridge],
  );
  // 设置 › 插件 › MCP 服务 (absent from a bridge without it: no such tab)
  const mcpApi = useMemo(() => (bridge.mcp ? mcpApiOf(bridge.mcp, () => bridge.pickFolder(t('选择工作文件夹'))) : undefined), [bridge]);
  // 收件箱 shows only while a plugin that provides mail is on.
  const [mailSource, setMailSource] = useState(false);
  // 模拟模式 (设置 › 插件): the inbox says its mail is demo data.
  const [pluginMock, setPluginMock] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void bridge.pluginViews
        .list()
        .then((v) => alive && setPluginViews(v))
        .catch(() => undefined);
      void bridge.plugins
        .run({ op: 'state' })
        .then((r) => {
          if (!alive) return;
          setMailSource(r.state.plugins.some((p) => p.mail));
          setPluginMock(r.state.mock);
          setPluginsWaiting(r.state.plugins.filter((p) => p.waiting && p.config?.missing.length).map((p) => ({ displayName: p.displayName, missing: p.config!.missing.length })));
        })
        .catch(() => undefined);
    };
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
  const previewPages = pluginViews.filter((v) => v.placement === 'preview');
  // 预览方式 of the file shown: the app's own, or the plugin page chosen for its kind (设置 › 常规 › 文件预览), or
  // what the user picked in the preview's head for this file; and the line saying why the app's own is shown
  // after the page failed (per file and page; 重试 opens the page again).
  const fileKey = preview && !preview.inline ? `${preview.sessionId ?? ''}|${preview.path}` : '';
  const fileExt = fileKey && preview ? fileExtension(preview.path) : '';
  const filePages = previewPagesFor(fileExt, previewPages);
  const chosenPage = chosenPreviewPage(settings.previewers, fileExt, previewPages);
  const wayId = previewWay && previewWay.key === fileKey ? previewWay.id : chosenPage ? previewerId(chosenPage) : BUILT_IN;
  const wayPage = filePages.find((v) => previewerId(v) === wayId) ?? null;
  const fellBack = previewFallback && previewFallback.key === fileKey && previewFallback.id === wayId ? previewFallback : null;
  const pagePreview = wayPage && !fellBack ? wayPage : null;
  const loadedPreview = usePreview(bridge.preview, preview && !preview.inline && !pagePreview ? preview : null);
  const previewInfo = preview?.inline ?? loadedPreview;
  // An HTML file, or a page drawn from an answer, runs its scripts in the built-in browser: its address there, asked
  // for while it is shown and given back after (main/browser/local-pages.ts).
  const htmlKey = previewInfo?.kind === 'html' && shownTab ? `${shownTab.id}|${fileKey}` : '';
  const [htmlPage, setHtmlPage] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!htmlKey || !preview) return;
    let alive = true;
    let got: string | null = null;
    const inline = preview.inline?.kind === 'html' ? preview.inline : null;
    const ask = inline ? bridge.browser.localText(inline.name, inline.text) : bridge.browser.localPage(preview.sessionId, preview.path);
    void ask.then((url) => {
      if (!url) return;
      if (!alive) {
        void bridge.browser.release(url);
        return;
      }
      got = url;
      setHtmlPage({ key: htmlKey, url });
    });
    return () => {
      alive = false;
      if (got) void bridge.browser.release(got);
    };
    // asked again only for another page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [htmlKey]);
  const htmlUrl = htmlPage && htmlPage.key === htmlKey ? htmlPage.url : null;
  // What local pages tried to load from the web and were stopped, by the token in their address (shown in the file's row).
  const [blockedHosts, setBlockedHosts] = useState<Record<string, string[]>>({});
  useEffect(
    () =>
      bridge.browser.onBlocked(({ page, host }) =>
        setBlockedHosts((m) => (m[page]?.includes(host) ? m : { ...m, [page]: [...(m[page] ?? []), host] })),
      ),
    [bridge],
  );
  const htmlBlocked = (() => {
    if (!htmlUrl) return undefined;
    try {
      return blockedHosts[new URL(htmlUrl).host];
    } catch {
      return undefined;
    }
  })();
  const chooseWay = (id: string) => {
    setPreviewWay({ key: fileKey, id });
    setPreviewFallback(null);
    setPreviewAttempt((n) => n + 1);
  };
  const openPluginView = view === 'plugin' ? sidebarPages.find((v) => viewKey(v) === openPlugin) : undefined;
  const panelPluginView = rightTab === 'detail' ? undefined : panelPages.find((v) => viewKey(v) === rightTab);
  const skinNow = shell.activeSkin();
  const pluginTheme: PluginTheme = { mode: schemeOf(skinNow.bg), vars: pluginThemeVars(deriveTokens(skinNow), uiFontFor(settings.uiFont, settings.uiFont === 'system' ? navigator.language : getLocale())) };
  const pluginProps = (v: PluginView) => ({
    view: v,
    theme: pluginTheme,
    changed: pluginsChanged,
    call: (tool: string, args: unknown, confirmed: boolean, callId: string) => bridge.pluginViews.call(v.plugin, v.id, tool, args, confirmed, callId),
    cancel: (callId: string) => bridge.pluginViews.cancel(callId),
    confirm: (tool: string, args: unknown) => new Promise<boolean>((resolve) => setPluginAsk({ plugin: v.pluginTitle, tool, args, resolve })),
    openFile: async (path: string) => {
      const abs = await bridge.pluginViews.file(v.plugin, path);
      if (!abs) return '仅能打开插件自身文件夹中的文件。'; // i18n-skip: an answer to the plugin page's own code
      if (pressFile(abs, filePress(null)) !== 'preview') return null;
      setView('chat');
      showPreview();
      return null;
    },
    notify: (text: string) => agent.state.set((s) => ({ ...s, notice: t('{plugin}：{text}', { plugin: v.pluginTitle, text }) })),
    pick: bridge.pluginViews.pick,
    openFolder: bridge.openFolder,
    exists: async (plugin: string, path: string) => (await bridge.pluginViews.file(plugin, path)) !== null,
  });

  const id = state.activeId;
  // The model new conversations use: the settings' pointer (a connection may hold several models).
  // Only models in use (checked) are offered anywhere.
  const firstModel = models.find((p) => enabledModels(p.models).length);
  const defaultRef = pointers.default ?? (firstModel ? { connectionId: firstModel.id, model: enabledModels(firstModel.models)[0]!.id } : null);
  // The store starts the first conversation with 默认模型 as it is now.
  const defaultKey = defaultRef ? `${defaultRef.connectionId}\u0000${defaultRef.model}` : '';
  useEffect(() => {
    const [providerId, model] = defaultKey.split('\u0000');
    agent.setDefaultModel(providerId && model ? { providerId, model } : null);
  }, [agent, defaultKey]);

  // The model mail is sorted with (the core says so in mail.configured; else the default model).
  const triage = mail.triageModel ?? (defaultRef ? { providerId: defaultRef.connectionId, model: defaultRef.model } : null);
  const mailModelLabel = triage ? `${models.find((p) => p.id === triage.providerId)?.name ?? triage.providerId} · ${triage.model}` : '';

  // The input box's controls: what the next message goes out with.
  const draft = state.draft;
  // Every ticked model of every connection, by connection (its key tail tells two keys of one provider apart).
  const isRef = (r: ModelRef | null, providerId: string, model: string) => Boolean(r && r.connectionId === providerId && r.model === model);
  const modelOptions = models.flatMap((p) =>
    enabledModels(p.models).map((m) => {
      const marks = [isRef(pointers.default, p.id, m.id) ? t('默认') : '', isRef(pointers.strong, p.id, m.id) ? t('强模型') : ''].filter(Boolean).join(' · ');
      return { providerId: p.id, model: m.id, group: `${p.name}${p.keyMask ? ` · ${p.keyMask}` : ''}`, label: m.id, marks };
    }),
  );
  const using = session ? { providerId: session.providerId, model: session.model } : draft.providerId && draft.model ? { providerId: draft.providerId, model: draft.model } : null;
  const shown = using ?? (defaultRef ? { providerId: defaultRef.connectionId, model: defaultRef.model } : null);
  // Whether the model in use takes pictures: asked again when it changes or a turn ended in an error
  // (a refusal is remembered by the core).
  const [imagesAccepted, setImagesAccepted] = useState<{ key: string; ok: boolean | null } | null>(null);
  const shownKey = shown ? `${shown.providerId}	${shown.model}` : '';
  const turnError = transcript.error ?? '';
  useEffect(() => {
    if (!shown) return;
    let alive = true;
    void bridge.images
      .accepted(shown.providerId, shown.model)
      .then((ok) => alive && setImagesAccepted({ key: shownKey, ok }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shownKey stands for shown
  }, [bridge, shownKey, turnError]);
  // Whether each model in the 切换模型 menu takes pictures (asked once per model, kept for the visit).
  const [imageSupport, setImageSupport] = useState<Record<string, boolean | null>>({});
  const optionKeys = modelOptions.map((o) => `${o.providerId}|${o.model}`).join(',');
  useEffect(() => {
    let alive = true;
    for (const key of optionKeys.split(',')) {
      if (!key || key in imageSupport) continue;
      const [providerId = '', model = ''] = key.split('|');
      void bridge.images
        .accepted(providerId, model)
        .then((ok) => alive && setImageSupport((v) => ({ ...v, [key]: ok })))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionKeys stands for the options; asked once per model
  }, [bridge, optionKeys]);
  // Pictures already in this conversation: a model that cannot take them is not offered.
  const hasPictures = transcript.items.some((i) => i.kind === 'user' && i.attachments?.some((a) => a.image));
  // A conversation on a model that was unticked or whose connection was deleted.
  const shownGone = Boolean(shown && models.length && !modelOptions.some((o) => o.providerId === shown.providerId && o.model === shown.model));
  const shownProvider = shown ? models.find((p) => p.id === shown.providerId)?.name : undefined;
  const shownWindow = shown ? models.find((p) => p.id === shown.providerId)?.models.find((m) => m.id === shown.model)?.contextWindow : undefined;
  const ringWindow = session?.contextWindow || shownWindow || 0;
  // 选择文件夹 in a conversation (once): the user's own conversations, not in a project. With something said
  // already, a confirmation first (it cannot change afterwards, and what was made moves there).
  // `stay`: a conversation from 0.1.0-rc.2, still in the folder they all shared: its files stay there.
  const [cwdAsk, setCwdAsk] = useState<{ sessionId: string; dir: string; stay: boolean } | null>(null);
  const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  const sessionFolder = (s: SessionInfo): Pick<ComposerTools, 'folder'> => {
    // Chosen (or in a project): nothing under the box; the folder is in 详情.
    if (s.role !== 'top' || s.parentId || !s.canChooseCwd) return {};
    const busy = s.status === 'queued' || s.status === 'thinking' || s.status === 'tool' || s.status === 'awaiting_confirm' || s.status === 'awaiting_answer';
    return {
      folder: {
        path: '',
        name: '',
        busy,
        onPick: () =>
          void bridge.pickFolder(t('选择文件夹')).then((dir) => {
            if (!dir) return;
            if (transcript.items.length) setCwdAsk({ sessionId: s.id, dir, stay: sameFolder(s.cwd, shell.legacyDefaultCwd) });
            else void agent.chooseCwd(s.id, dir);
          }),
      },
    };
  };
  const composerTools: ComposerTools = {
    pickFiles: () => bridge.pickFiles(t('添加附件')),
    pathForFile: bridge.pathForFile,
    images: {
      fromPaste: bridge.images.fromPaste,
      prepare: bridge.images.prepare,
      accepted: imagesAccepted?.key === shownKey ? imagesAccepted.ok : null,
    },
    ...(session
      ? sessionFolder(session)
      : {
          folder: {
            // Shown once a folder is picked; until then only the button to pick one (no default folder is shown).
            path: draft.cwd ?? '',
            name: draft.cwd ? (draft.cwd.split(/[\\/]/).filter(Boolean).pop() ?? draft.cwd) : '',
            onPick: () =>
              void bridge.pickFolder(t('选择文件夹')).then((dir) => {
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
            ...(shownGone ? { note: t('（已移除）') } : shownProvider ? { provider: shownProvider } : {}),
            ...(hasPictures ? { hasPictures } : {}),
            options: modelOptions.map((o) => ({
              label: o.label,
              group: o.group,
              groupKey: o.providerId,
              marks: o.marks,
              images: imageSupport[`${o.providerId}|${o.model}`] ?? null,
              current: o.providerId === shown.providerId && o.model === shown.model,
              onPick: () => (session ? void agent.setModel(session.id, o.providerId, o.model) : agent.setDraft({ providerId: o.providerId, model: o.model })),
            })),
          },
        }
      : {}),
    // No ring until the model's 上下文上限 is known (set in 设置 › 模型).
    // The ring as soon as the model's 上下文上限 is known: empty before the first message, so the row does not shift.
    ...(ringWindow ? { context: { tokens: session?.contextTokens ?? 0, window: ringWindow, ...(session ? { detail: () => bridge.contextBreakdown(session.id) } : {}) } } : {}),
  };

  const actions: ConversationActions = {
    send: (text, files, suggested) => void agent.send(id, text, files ?? [], suggested === true),
    stop: () => id && void agent.stop(id),
    answer: (callId, a) => id && void agent.answer(id, callId, a),
    confirm: (callId, ok, always) => id && void agent.confirm(id, callId, ok, always === true),
    openFile: previewFile,
    openFolder: (path) => void bridge.openFolder(path).then(showNotice, (err: unknown) => showNotice(friendlyError(err))),
    revealFile: (path) => void bridge.showInFolder(path).then(showNotice, (err: unknown) => showNotice(friendlyError(err))),
    saveCsv: (text) =>
      bridge.saveCsv('', text).then(
        (r) => {
          if (r && 'error' in r) showNotice(r.error);
          return Boolean(r && 'file' in r);
        },
        (err: unknown) => {
          showNotice(friendlyError(err));
          return false;
        },
      ),
    openSession: (sid) => openSession(sid),
    openFound,
    resume: () => id && void agent.resume(id),
    regenerate: (messageId) => id && void agent.regenerate(id, messageId),
    ...(mail.supported ? { mailById, openInbox: () => setView('inbox') } : {}),
    // at the provider a stop named (a card's button passes its click event: no provider)
    openNetworkSettings: () => {
      openSettings('general');
      setSettingsReveal((prev) => ({ title: tc('network', '代理'), at: (prev?.at ?? 0) + 1 }));
    },
    openModelSettings: (providerId?: unknown) => {
      if (typeof providerId === 'string' && providerId) openProviderNext(providerId);
      openSettings('models');
    },
    imageUrl: bridge.images.url,
    previewHtml: (title, html) => {
      setPreview({ sessionId: null, path: '', inline: { kind: 'html', name: title, path: '', size: html.length, text: html, truncated: false } });
      setHistory(false);
      showPreview();
    },
  };

  const foundView = (f: NonNullable<typeof found>) => {
    const from = f.from ? sessions.find((s) => s.id === f.from) : undefined;
    return {
      ...(f.seq !== undefined ? { seq: f.seq } : {}),
      ...(from && from.id !== f.sessionId
        ? {
            back: {
              title: from.title || t('新对话'),
              onBack: () => {
                setFound(null);
                openSession(from.id);
              },
            },
          }
        : {}),
    };
  };

  const leftShown = layout.left !== 'hidden';
  const previewShown = layout.preview !== 'hidden';
  // the small card only while the details give way, on a conversation
  if (infoFloat && (!infoBlocked || view !== 'chat')) setInfoFloat(false);
  const infoShown = layout.info === 'docked' || infoFloat;
  // No room for the details (beside the conversation at 440): they are not shown at all, and their button cannot be
  // pressed; its hover says why. Their switch is kept: they come back when there is room. Given way to the monitor or
  // the preview, the button shows the small card instead.
  const infoRoom = infoBlocked || infoFits(width, open, wantedWidths);
  const lastName = lastTab ? tabName(lastTab) || t('新标签页') : '';
  const previewTip = pane.open ? t('预览') : lastPreview ? t('预览：{name}', { name: lastName }) : t('没有打开的预览：点对话里的文件打开');
  // A preview floating over a narrow window takes no room: there the window is what is too narrow.
  // The details closed while this conversation's background commands run: how many, on their button.
  const jobsRunning = view === 'chat' && !infoShown && infoRoom ? runningJobs(transcript.jobs) : 0;
  const infoTip = !infoRoom ? t('窗口太窄，放不下详情') : jobsRunning ? t('展开详情（{n} 个运行中）', { n: jobsRunning }) : t('详情（Ctrl+Alt+B）');
  // The 监控台 (switched on in 设置 › 关于): as the details, no room means not shown and a button that says why.
  const monitorShown = layout.monitor === 'docked';
  const monitorRoom = monitorOpen === undefined ? false : monitorFits(width, open, wantedWidths);
  const monitorTip = monitorRoom ? t('监控台') : layout.preview === 'docked' ? t('放不下监控台：把预览拖窄或关掉，或把窗口拉宽') : t('窗口太窄，放不下监控台');
  const toggleMonitor = () => {
    if (!monitorRoom) return;
    shell.update({ panels: { ...settings.panels, monitor: !settings.panels.monitor } });
  };
  // The monitor over the whole conversation (its head's 最大化), as the preview's; a layer of Esc.
  const [monitorMax, setMonitorMax] = useState(false);
  if (monitorMax && (!monitorShown || view !== 'chat')) setMonitorMax(false);
  useEscape(monitorMax, () => setMonitorMax(false));
  // The details' small card is a layer of Esc too; a press outside it (not on its button) closes it.
  useEscape(infoFloat, () => setInfoFloat(false));
  useEffect(() => {
    if (!infoFloat) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('.info-float, [data-panel-toggle], .context-menu')) return;
      setInfoFloat(false);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [infoFloat]);
  // Maximized only while the preview is there to show; closing it or leaving the conversation ends that.
  const rightCanMax = previewShown && view === 'chat' && !history;
  /**
   * 工具调用 X: opens the finished calls where the preview goes (over a file shown there, which comes back when it is
   * closed); pressed again, closes them. A file opened from the conversation or the details takes the place again.
   */
  const toggleHistory = () => {
    if (history) {
      setHistory(false);
      if (!pane.open && floating === 'preview') setFloating(null);
      return;
    }
    setHistory(true);
    showPreview();
  };
  if (canMax !== rightCanMax) setCanMax(rightCanMax);
  if (rightMax && !rightCanMax) setRightMax(false);
  const panelMax = { on: rightMax, toggle: () => setRightMax((v) => !v) };
  const webTabs = pane.tabs.filter((x): x is Extract<PaneTab, { kind: 'web' }> => x.kind === 'web');
  // An agent's tab shown while its conversation runs (acting), or after the person took it over (taken).
  const agentTab = shownTab?.kind === 'web' && shownTab.agent ? shownTab : null;
  const agentStatus = agentTab ? state.sessions.find((s) => s.id === agentTab.agent)?.status : undefined;
  const agentActing = agentStatus === 'queued' || agentStatus === 'thinking' || agentStatus === 'tool' || agentStatus === 'awaiting_confirm';
  const agentBar = agentTab
    ? takenTabs.has(agentTab.id)
      ? { mode: 'taken' as const, onTakeOver: () => undefined, onStop: () => undefined, onGiveBack: () => void bridge.browser.giveBack(agentTab.id) }
      : agentActing
        ? {
            mode: 'acting' as const,
            onTakeOver: () => {
              const wcId = pagesRef.current.get(agentTab.id);
              if (wcId !== undefined) void bridge.browser.takeOver(wcId);
            },
            onStop: () => void agent.stop(agentTab.agent!),
            onGiveBack: () => undefined,
          }
        : null
    : null;
  const paneStrip = (
    <PaneTabs
      tabs={pane.tabs}
      active={pane.active}
      onPick={(tabId) => setPane((s) => activatePane(s, tabId))}
      onClose={(tabId) => {
        setPane((s) => closePaneTab(s, tabId));
        if (pane.tabs.length === 1 && floating === 'preview') setFloating(null);
      }}
      onNew={() => openWebTab('')}
      max={panelMax}
      onClosePanel={closePreview}
    />
  );
  // The preview over the whole conversation is a layer of Esc too (back beside it).
  useEscape(rightMax, () => setRightMax(false));
  const pageProject = view === 'project' ? state.projects.find((p) => p.id === projectPageId) : undefined;
  const aboveProject = project?.parentId ? state.projects.find((p) => p.id === project.parentId) : undefined;
  const newProjectParent = newProject?.parentId ? state.projects.find((p) => p.id === newProject.parentId) : undefined;
  const title = view === 'inbox' ? t('收件箱') : view === 'schedule' ? t('定时任务') : view === 'plugin' ? (openPluginView?.title ?? '') : view === 'project' ? (pageProject?.name ?? '') : (session?.title ?? '');
  /**
   * In a project, a conversation's 子任务 in the details (the workers it sent out; a sub-task's
   * own ones in its details). Shown there, a finished one has been seen (its news dot goes).
   */
  const subTasks =
    session && (session.role === 'manager' || project)
      ? {
          tasks: sessions.filter((x) => x.parentId === session.id && x.role === 'worker'),
          transcriptOf: (sid: string) => state.transcripts[sid],
          load: (sid: string) => {
            void agent.load(sid);
            const news = settings.doneNews ?? [];
            if (news.includes(sid)) shell.update({ doneNews: news.filter((x) => x !== sid) });
          },
          stop: (sid: string) => void agent.stop(sid),
          open: openSession,
        }
      : undefined;

  // The details' content: docked beside the conversation, or in the small card over it (infoFloat).
  const detailsBody = (
    <>
      {panelPages.length ? (
        <div className="right-head panel-head">
        <div className="tabs right-tabs" role="tablist" aria-label={t('右栏')}>
          <button type="button" role="tab" aria-selected={!panelPluginView} className={!panelPluginView ? 'tab is-on' : 'tab'} onClick={() => setRightTab('detail')}>
            {t('详情')}
          </button>
          {panelPages.map((v) => (
            <button key={viewKey(v)} type="button" role="tab" aria-selected={rightTab === viewKey(v)} className={rightTab === viewKey(v) ? 'tab is-on' : 'tab'} onClick={() => setRightTab(viewKey(v))} title={v.pluginTitle}>
              {v.title}
            </button>
          ))}
        </div>
        </div>
      ) : null}
      {panelPluginView ? (
        <PluginPage key={viewKey(panelPluginView)} {...pluginProps(panelPluginView)} />
      ) : (
      <DetailPanel
        history={{ open: history, toggle: toggleHistory }}
        session={session}
        parent={parent}
        transcript={transcript}
        globalCostUsd={totalCost}
        globalUnpriced={anyUnpriced}
        onOpenFile={openFile}
        onPreviewFile={previewFile}
        onOpenSession={openSession}
        project={project}
        activity={project ? (state.activity[project.id] ?? []) : []}
        hideHeading={panelPages.length > 0}
        onStopJob={(jobId) => void agent.stopJob(jobId)}
        {...(subTasks ? { subTasks } : {})}
        {...(schedOfSession
          ? {
              extra: (
                <ScheduleDetail s={schedOfSession} now={schedNow} current={state.activeId ?? ''} loadRuns={loadRuns} onToggle={(on) => void schedStore.setEnabled(schedOfSession.id, on)} onOpenSession={openSession} />
              ),
            }
          : {})}
      />
      )}
    </>
  );

  // What can be done to a session by its name; the sidebar's rows and the name in the title bar share it.
  const rowActions: RowActions = {
    pinned: settings.pinnedProjects ?? [],
    onRename: (sid, name) => void agent.rename(sid, name),
    onPin: (pid, pin) => {
      const now = (settings.pinnedProjects ?? []).filter((x) => x !== pid);
      shell.update({ pinnedProjects: pin ? [...now, pid] : now });
    },
    ...(bridge.agent.renameProject ? { onRenameProject: (pid: string, name: string) => void agent.renameProject(pid, name) } : {}),
    ...(bridge.agent.deleteProject ? { onDeleteProject: (pid: string, name: string) => setDeletingProject({ id: pid, name }) } : {}),
    ...(bridge.agent.deleteSession ? { onDeleteChat: (s: SessionInfo) => setDeletingChat({ id: s.id, name: s.title || t('新对话') }) } : {}),
    ...(bridge.agent.createProject && !shell.demo
      ? { onNewSubProject: (pid: string) => setNewProject({ parentId: pid }), isSubProject: (pid: string) => Boolean(state.projects.find((p) => p.id === pid)?.parentId) }
      : {}),
  };
  // The open conversation's name in the title bar: a click edits it, a right-click opens its menu.
  const named = view === 'chat' ? session : undefined;

  // A downloaded update or plugins that can update: a card above the account row, an icon in the column of icons.
  const openPluginUpdates = () => {
    openSettings('plugins', 'installed');
    setFloating(null);
  };
  const sidebarToggle = <SidebarToggle shown={leftShown} onToggle={() => toggle('left')} />;

  // The sidebar, full (docked or over the window) or as the column of icons left when it is closed.
  const sidebarEl = (compact: boolean) => (
    <Sidebar
      compact={compact}
      notice={
        updateNotice ? (
          compact ? (
            <UpdateRailButton notice={updateNotice} onOpenSidebar={() => toggle('left')} onOpenPlugins={openPluginUpdates} />
          ) : (
            <UpdateCard notice={updateNotice} onInstall={installUpdate} onOpenPlugins={openPluginUpdates} />
          )
        ) : null
      }
      sessions={sessions}
      activeId={state.activeId}
      onOpen={openSession}
      onNewChat={() => {
        setView('chat');
        setFloating(null);
        agent.newChat();
      }}
      onSettings={() => {
        setSettingsOpen((o) => !o);
        setFloating(null);
      }}
      settingsOpen={settingsOpen}
      elsewhere={view === 'plugin' || view === 'project'}
      projectInfos={state.projects}
      onOpenProject={openProject}
      projectPageId={view === 'project' ? projectPageId : null}
      account={effectiveAccount(settings, shell.autoAccount)}
      onAccount={(where) => {
        openSettings(where === 'models' ? 'models' : undefined);
        setFloating(null);
      }}
      topId={state.topId}
      {...(rowActions.onRename ? { onRename: rowActions.onRename } : {})}
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
      pinned={rowActions.pinned}
      {...(rowActions.onPin ? { onPin: rowActions.onPin } : {})}
      {...(rowActions.onRenameProject ? { onRenameProject: rowActions.onRenameProject } : {})}
      {...(rowActions.onDeleteProject ? { onDeleteProject: rowActions.onDeleteProject } : {})}
      {...(rowActions.onDeleteChat ? { onDeleteChat: rowActions.onDeleteChat } : {})}
      {...(rowActions.onNewSubProject ? { onNewSubProject: rowActions.onNewSubProject } : {})}
      {...(bridge.agent.createProject && !shell.demo ? { onNewProject: () => setNewProject({}) } : {})}
      {...sidebarNews({
        inboxShown: (mail.supported && mailSource) || schedCards.length > 0,
        inbox: {
          count: inboxCount,
          open: view === 'inbox',
          onOpen: () => {
            setView((v) => (v === 'inbox' ? 'chat' : 'inbox'));
            setFloating(null);
          },
        },
      })}
      unseenDone={doneNews}
      {...(scheds.supported
        ? {
            schedule: {
              open: view === 'schedule',
              onOpen: () => {
                setView((v) => (v === 'schedule' ? 'chat' : 'schedule'));
                setFloating(null);
              },
            },
          }
        : {})}
    />
  );

  // Frame (like Claude Desktop): the sidebar runs the full height of the window
  // with the brand and its own toggle at the top; the title bar runs over the
  // conversation and both right panels.
  return (
    <div className="app" data-left={layout.left} data-preview={view === 'chat' ? layout.preview : 'hidden'} data-info={view === 'chat' ? layout.info : 'hidden'}>
      <HoverTips />
      <ForcedUpdate update={update} onRetry={() => void bridge.updates.run('check')} />
      {/* Sidebar closed: a column of icons stays. Resting on the toggle at its top opens the full
          sidebar over it for a moment, every row where its icon was; the icons themselves do not
          (a press on one goes straight to its page). */}
      {layout.left !== 'docked' ? (
        <div className="panel panel-rail" onMouseDown={peek.cancel}>
          <RailHead
            toggle={sidebarToggle}
            onRest={() => {
              if (!peekHeld.current) peek.openSoon(floating === 'left');
            }}
            onLeave={() => {
              peekHeld.current = false;
              peek.cancel();
            }}
          />
          {sidebarEl(true)}
        </div>
      ) : null}
      {leftShown ? (
        <div
          className={`panel panel-left is-${layout.left}`}
          style={{ width: widths.left }}
          {...(peekOpen ? { onMouseEnter: peek.cancel, onMouseLeave: () => peek.closeSoon(peekOpen) } : {})}
        >
          {resizer('left')}
          <SidebarHead peek={peekOpen} toggle={sidebarToggle} brand={<SpicaBanner height={BANNER_HEIGHT} className="sidebar-brand" {...wordmarkProps} />} />
          {sidebarEl(false)}
        </div>
      ) : null}

      <div className="column">
      {/* One title bar across the conversation, the details and the preview (the window's drag area, with the
          system buttons at its end); under it the conversation, then each right panel with its own head as its
          first row. */}
      <header className="titlebar">
        <div className="titlebar-title">
          {view === 'chat' && parent ? (
            <>
              <button type="button" className="crumb" onClick={() => openSession(parent.id)} title={t('返回 {title}', { title: parent.title ?? '' })}>
                {parent.title}
              </button>
              <Icon name="chevronRight" size={12} className="crumb-sep" />
            </>
          ) : null}
          {/* a sub-project's conversation: the project it belongs to before its name (its page) */}
          {view === 'chat' && !parent && aboveProject ? (
            <>
              <button type="button" className="crumb" onClick={() => openProject(aboveProject.id)} title={t('返回 {title}', { title: aboveProject.name })}>
                {aboveProject.name}
              </button>
              <Icon name="chevronRight" size={12} className="crumb-sep" />
            </>
          ) : null}
          {named && titleEditing === named.id ? (
            <RenameField
              className="input titlebar-rename"
              initial={title}
              onDone={(v) => {
                setTitleEditing(null);
                commitRename(named, v, rowActions);
              }}
            />
          ) : named && canRename(named, rowActions) ? (
            <button type="button" className="titlebar-text titlebar-name" title={title} data-tip-clipped="" onClick={() => setTitleEditing(named.id)} onContextMenu={openTitleMenu}>
              {title}
            </button>
          ) : (
            <span className="titlebar-text" title={title} data-tip-clipped="" {...(named && hasRowMenu(named, rowActions) ? { onContextMenu: openTitleMenu } : {})}>
              {title}
            </span>
          )}
          {named && titleMenu ? <ContextMenu x={titleMenu.x} y={titleMenu.y} items={rowMenuItems(named, rowActions, () => setTitleEditing(named.id))} onClose={() => setTitleMenu(null)} /> : null}
        </div>
        {/* Announcements and backend recovery live in the title bar's free space: nothing in the window is
            covered and nothing moves. Updates are in the side bar. */}
        <NoticeBar
          backend={backendState}
          onRetryBackend={() => bridge.backend.retry()}
          settings={settings}
          onDismissNotice={(nid) => shell.update({ dismissedNotices: [...settings.dismissedNotices, nid] })}
        />
        <div className="titlebar-right">
          {view === 'chat' ? (
            <>
              {/* 详情 and the preview each have their own button, as Claude's title bar: the details' list, then the
                  panel on the right (the preview, at the window's right edge). */}
              <button
                type="button"
                data-panel-toggle
                className={infoShown ? 'icon-btn is-on' : jobsRunning ? 'icon-btn has-badge' : 'icon-btn'}
                onClick={() => toggle('info')}
                aria-label={infoShown ? t('收起详情') : t('展开详情')}
                aria-pressed={infoShown}
                {...(infoRoom ? {} : { 'aria-disabled': true })}
                title={infoTip}
              >
                <Icon name="details" />
                {jobsRunning ? <span className="rail-badge">{jobsRunning}</span> : null}
              </button>
              {settings.monitor ? (
                <button
                  type="button"
                  data-panel-toggle
                  className={monitorShown ? 'icon-btn is-on' : 'icon-btn'}
                  onClick={toggleMonitor}
                  aria-label={monitorShown ? t('收起监控台') : t('展开监控台')}
                  aria-pressed={monitorShown}
                  {...(monitorRoom ? {} : { 'aria-disabled': true })}
                  title={monitorTip}
                >
                  <Icon name="terminal" />
                </button>
              ) : null}
              <button
                type="button"
                data-panel-toggle
                className={pane.open || history ? 'icon-btn is-on' : 'icon-btn'}
                onClick={togglePreview}
                aria-label={pane.open || history ? t('收起预览') : t('展开预览')}
                aria-pressed={pane.open || history}
                {...(pane.open || lastPreview ? {} : { 'aria-disabled': true })}
                title={previewTip}
              >
                <Icon name="detail" />
              </button>
            </>
          ) : null}
        </div>
      </header>
      <div className="body">
        <main className="main" style={{ '--centre-shift': `${shift}px` } as CSSProperties}>
          {view === 'plugin' ? (
            openPluginView ? (
              <PluginPage key={viewKey(openPluginView)} {...pluginProps(openPluginView)} />
            ) : (
              <div className="plugin-page plugin-missing">
                <p>{t('插件页面不可用（插件已停用或已卸载）。')}</p>
              </div>
            )
          ) : view === 'schedule' ? (
            <SchedulePage
              loaded={scheds.loaded}
              items={scheds.items}
              now={schedNow}
              onNew={() => setSchedForm({})}
              onEdit={(s) => setSchedForm({ editing: s })}
              onToggle={(id, on) => void schedStore.setEnabled(id, on)}
              onRunNow={(id) => void schedStore.runNow(id)}
              onDelete={(id) => void schedStore.remove(id)}
              onOpenSession={openSession}
              problem={scheds.problem}
              onDismissProblem={() => schedStore.dismissProblem()}
            />
          ) : view === 'inbox' ? (
            <InboxView
              mailShown={mail.supported && mailSource}
              {...(schedCards.length ? { before: <RunCards items={schedCards} now={schedNow} onOpen={openSession} onResume={(id) => void schedStore.setEnabled(id, true)} /> } : {})}
              mail={mail}
              mock={pluginMock}
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
              onOpenSettings={() => openSettings('plugins', 'installed')}
              onDismissProblem={() => mailStore.dismissProblem()}
            />
          ) : view === 'project' && pageProject ? (
            <ProjectPage
              project={pageProject}
              {...(() => {
                const manager = pageProject.managerSessionId ? sessions.find((x) => x.id === pageProject.managerSessionId) : undefined;
                return manager ? { own: { manager, below: sessions.filter((x) => x.parentChain.includes(manager.id)) } } : {};
              })()}
              subs={state.projects
                .filter((p) => p.parentId === pageProject.id)
                .flatMap((p) => {
                  const manager = sessions.find((x) => x.id === p.managerSessionId);
                  return manager ? [{ project: p, manager, below: sessions.filter((x) => x.parentChain.includes(manager.id)) }] : [];
                })}
              activity={state.projects
                .filter((p) => p.parentId === pageProject.id || p.id === pageProject.id)
                .flatMap((p) => (state.activity[p.id] ?? []).map((a) => ({ ...a, from: p.name })))
                .sort((a, b) => b.at.localeCompare(a.at))}
              onOpenSession={openSession}
              onOpenFolder={(f) => actions.openFolder?.(f)}
              {...(rowActions.onNewSubProject ? { onNewSubProject: () => rowActions.onNewSubProject?.(pageProject.id) } : {})}
            />
          ) : state.loaded ? (
            <ChildSourceContext.Provider value={childSource}>
            <Conversation
              session={session}
              transcript={transcript}
              actions={actions}
              demo={shell.demo}
              needsModel={modelReady === false && !shell.demo}
              waiting={waiting}
              composerTools={composerTools}
              memory={memoryLines}
              welcome={{ name: effectiveCallName(settings, shell.autoAccount) }}
              {...(found && found.sessionId === state.activeId ? { found: foundView(found) } : {})}
              onSetupModel={() => openSettings('models')}
            />
            </ChildSourceContext.Provider>
          ) : (
            <div className="conversation" />
          )}
          {infoFloat && view === 'chat' ? (
            <div className="info-float" role="dialog" aria-label={t('详情')}>
              {detailsBody}
            </div>
          ) : null}
          {state.notice ? (
            <div className="toast" role="alert">
              <span>{tx(state.notice)}</span>
              <button type="button" className="icon-btn" onClick={() => agent.dismissNotice()} aria-label={t('关闭提示')} title={t('关闭')}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ) : null}
        </main>

        {/* The details, between the conversation and the preview: a fixed width, no edge to drag, no 最大化 (no room:
            not shown; given way to the monitor or the preview: the small card over the conversation, in <main>). */}
        {layout.info !== 'hidden' && view === 'chat' ? (
          <div className="panel panel-right panel-info is-docked" style={{ width: widths.info }}>
            {detailsBody}
          </div>
        ) : null}

        {/* The 监控台, between the details and the preview: a fixed width, no edge to drag; never covered or floated
            (no room: not shown). Closed, it stops reading the log (MonitorView's watch ends with it). */}
        {monitorShown && view === 'chat' ? (
          <div className={`panel panel-right panel-monitor is-docked${monitorMax ? ' is-max' : ''}`} style={monitorMax ? undefined : { width: widths.monitor }}>
            {/* as the preview's head (and Claude's Files): 最大化 and 关闭 at its end */}
            <header className="panel-head monitor-head">
              <span className="detail-heading">{t('监控台')}</span>
              <MaxButton max={{ on: monitorMax, toggle: () => setMonitorMax((v) => !v) }} hint="" />
              <button type="button" className="icon-btn" onClick={() => { setMonitorMax(false); shell.update({ panels: { ...settings.panels, monitor: false } }); }} aria-label={t('关闭监控台')} title={t('关闭监控台')}>
                <Icon name="close" size={14} />
              </button>
            </header>
            <MonitorView api={bridge.monitor} showInFolder={(p) => void bridge.showInFolder(p)} />
          </div>
        ) : null}

        {/* The file preview, against the window's right edge: its left edge drags, its head has 最大化 and 关闭预览. */}
        {/* 工具调用 X in the preview's place: the same panel (its edge drags), no 最大化. */}
        {previewShown && view === 'chat' && history ? (
          <div
            className={`panel panel-right panel-preview is-${layout.preview}${widths.cover && layout.preview === 'docked' ? ' is-cover' : ''}`}
            style={{ width: widths.preview, ...(widths.cover && layout.preview === 'docked' ? { marginLeft: -widths.cover } : {}) }}
          >
            {resizer('preview')}
            <ToolHistory transcript={transcript} onClose={toggleHistory} />
          </div>
        ) : null}

        {previewShown && view === 'chat' && shownTab && !history ? (
          <div
            className={`panel panel-right panel-preview is-${layout.preview}${rightMax ? ' is-max' : ''}${widths.cover && layout.preview === 'docked' ? ' is-cover' : ''}`}
            style={rightMax ? undefined : { width: widths.preview, ...(widths.cover && layout.preview === 'docked' ? { marginLeft: -widths.cover } : {}) }}
          >
            {/* Wider than what is beside it allows, it lies over the details, then over the conversation's right part (kept at its 440 layout): pulled left by `cover`. */}
            {rightMax ? null : resizer('preview')}
            {preview ? (
            <FilePreview
              tabs={paneStrip}
              page={htmlUrl}
              zoom={bridge.browser}
              {...(htmlBlocked?.length ? { blocked: htmlBlocked } : {})}
              // A plugin page draws the file: the head still names it (and offers its buttons).
              info={pagePreview ? { kind: 'unsupported', name: preview.path.split(/[\\/]/).pop() ?? preview.path, path: preview.path, size: 0, message: '' } : previewInfo}
              loadingPath={preview.path}
              {...(filePages.length
                ? { source: { options: [{ id: BUILT_IN, label: t('自带预览') }, ...filePages.map((v) => ({ id: previewerId(v), label: v.title }))], value: fellBack ? BUILT_IN : wayId, onChange: chooseWay } }
                : {})}
              note={fellBack?.why.text ? { text: fellBack.why.text, ...(fellBack.why.retry ? { onRetry: () => chooseWay(wayId) } : {}) } : null}
              onOpenExternal={(p) => {
                // A file from a plugin page has no conversation: its path is whole.
                void bridge.openFile(preview.sessionId, p).then((err) => err && agent.state.set((v) => ({ ...v, notice: err })));
              }}
              onReveal={(p) => void bridge.showInFolder(p).then(showNotice, (err: unknown) => showNotice(friendlyError(err)))}
              onSheet={(n) => setPreview((p) => (p ? { ...p, sheet: n } : p))}
              loadRows={(from) => bridge.preview(preview.sessionId, preview.path, previewInfo?.kind === 'sheet' ? previewInfo.sheet : preview.sheet, from)}
              onClose={closePreview}
              max={panelMax}
            >
              {pagePreview ? (
                <PluginPreview
                  key={`${previewerId(pagePreview)}|${previewAttempt}|${preview.opened ?? 0}`}
                  {...pluginProps(pagePreview)}
                  file={{ sessionId: preview.sessionId, path: preview.path }}
                  loadFile={bridge.previewFile}
                  onFallback={(why) => setPreviewFallback({ key: fileKey, id: previewerId(pagePreview), why })}
                />
              ) : null}
            </FilePreview>
            ) : null}
            {webTabs.length ? (
              <BrowserPane
                tabs={webTabs}
                active={shownTab.kind === 'web' ? shownTab.id : null}
                strip={shownTab.kind === 'web' ? paneStrip : null}
                onChange={(tabId, patch) => setPane((s) => updatePaneWeb(s, tabId, patch))}
                onOpenExternal={(url) => void bridge.browser.openExternal(url).then(showNotice)}
                agent={agentBar}
                zoom={bridge.browser}
                onPage={(tabId, wcId) => {
                  if (wcId === null) pagesRef.current.delete(tabId);
                  else pagesRef.current.set(tabId, wcId);
                }}
              />
            ) : null}
          </div>
        ) : null}

      </div>
      </div>


      {/* Web addresses clicked in the window: 设置 › 常规 › 浏览器 › 打开网址 (the question, 应用内 or 系统浏览器). */}
      <LinkRouter
        setting={settings.linkOpen}
        open={(url, place) => {
          if (place === 'system') {
            void bridge.browser.openExternal(url).then(showNotice);
            return;
          }
          setSettingsOpen(false);
          setView('chat');
          openWebTab(url);
        }}
        remember={(place) => shell.update({ linkOpen: place })}
        incoming={bridge.browser.onLocalLink}
      />
      {pluginAsk ? (
        <ConfirmDialog
          title={t('「{plugin}」将执行「{tool}」，此操作不可撤销。', { plugin: pluginAsk.plugin, tool: pluginAsk.tool })}
          detail={<ConfirmTarget name={pluginAsk.tool} input={pluginAsk.args} />}
          confirmLabel={t('继续')}
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

      {deletingChat ? (
        <ConfirmDialog
          title={t('删除对话「{name}」？', { name: deletingChat.name })}
          detail={t('将删除这条对话的记录，助理以后查不到它；它产出的文件不会删除。')}
          confirmLabel={t('删除')}
          danger
          onCancel={() => setDeletingChat(null)}
          onConfirm={() => {
            const gone = deletingChat.id;
            setDeletingChat(null);
            // The open one goes: the one above it in the list, else a new conversation.
            const chats = sessions.filter((x) => x.role === 'top' && !x.parentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            const at = chats.findIndex((x) => x.id === gone);
            const above = at > 0 ? chats[at - 1] : undefined;
            const wasOpen = state.activeId === gone;
            void agent.deleteSession(gone).then((problem) => {
              if (problem || !wasOpen) return;
              if (above) openSession(above.id);
              else agent.newChat();
            });
          }}
        />
      ) : null}
      {cwdAsk ? (
        <ConfirmDialog
          title={t('将工作文件夹设为「{name}」？', { name: folderName(cwdAsk.dir) })}
          detail={cwdAsk.stay ? t('选定后不能更改；原来的文件留在「文档\\{app}」。', { app: APP_NAME }) : t('选定后不能更改；这条对话已产生的文件会移到该文件夹。')}
          confirmLabel={t('选定')}
          onCancel={() => setCwdAsk(null)}
          onConfirm={() => {
            const ask = cwdAsk;
            setCwdAsk(null);
            void agent.chooseCwd(ask.sessionId, ask.dir);
          }}
        />
      ) : null}
      {deletingProject ? (
        <ConfirmDialog
          title={t('删除项目「{name}」？', { name: deletingProject.name })}
          detail={
            state.projects.some((p) => p.parentId === deletingProject.id)
              ? t('将删除该项目、它的子项目及其对话记录，不会删除文件夹中的文件。')
              : t('将删除该项目及其对话记录，不会删除项目文件夹中的文件。')
          }
          confirmLabel={t('删除')}
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

      {schedForm ? (
        <ScheduleDialog
          {...(schedForm.editing ? { editing: schedForm.editing } : {})}
          now={schedNow}
          models={models.flatMap((p) => p.models.map((m) => ({ value: `${p.id}/${m.id}`, label: m.id, group: p.name })))}
          onPickFolder={() => bridge.pickFolder(t('选择文件夹'))}
          onSave={async (input) => {
            const first = scheds.items.length === 0 && !input.id;
            const problem = await schedStore.save(input);
            // the first one: once, × of the window may minimize to the tray instead (the tasks run while the app does)
            if (!problem && first && !settings.scheduleTrayAsked && settings.closeWindow !== 'tray') setTrayAsk(true);
            return problem;
          }}
          onClose={() => setSchedForm(null)}
        />
      ) : null}
      {trayAsk ? (
        <TrayAsk
          onYes={() => {
            shell.update({ closeWindow: 'tray', scheduleTrayAsked: true });
            setTrayAsk(false);
          }}
          onNo={() => {
            shell.update({ scheduleTrayAsked: true });
            setTrayAsk(false);
          }}
        />
      ) : null}

      {newProject ? (
        <NewProjectDialog
          {...(newProject.name ? { initialName: newProject.name } : {})}
          {...(newProjectParent ? { parent: { name: newProjectParent.name, folder: newProjectParent.folder } } : {})}
          onPickFolder={() => bridge.pickFolder(t('选择项目文件夹'))}
          onCreate={async (input) => {
            const mailId = newProject.mailId;
            // A project started from a mail: the mail moves into it (its manager gets it).
            const problem = await agent.createProject(
              { ...input, ...(newProjectParent ? { parentId: newProjectParent.id } : {}) },
              mailId ? (p) => mailStore.feedback(mailId, 'reassign', p.id) : undefined,
            );
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
      {settingsOpen ? (
        <SettingsView
          shell={shell}
          providers={bridge.providers}
          plugins={pluginsApi}
          {...(mcpApi ? { mcp: mcpApi } : {})}
          version={version}
          update={update}
          onCheckUpdate={() => void bridge.updates.run('check')}
          onInstallUpdate={installUpdate}
          tab={settingsTab}
          onTab={setSettingsTab}
          pluginsTab={pluginsTab}
          onPluginsTab={setPluginsTab}
          onClose={() => setSettingsOpen(false)}
          workflows={bridge.workflows}
          pickFolder={() => bridge.pickFolder(t('选择工作流文件夹'))}
          onBackendRestarted={bridge.backend.onRestarted}
          projects={inboxProjects}
          exportUsageLog={bridge.exportUsageLog}
          showInFolder={bridge.showInFolder}
          clearBrowsingData={bridge.browser.clearData}
          mailModel={mailModelLabel}
          networkState={bridge.network}
          {...(settingsReveal ? { reveal: settingsReveal } : {})}
          pickFiles={bridge.pickFiles}
          {...(shell.demo ? {} : { localConnect: bridge.localConnect })}
          previewPages={previewPages}
          pluginPages={{ views: pluginViews.filter((v) => v.placement === 'settings'), props: pluginProps }}
          {...(memorySettings ? { memory: memorySettings } : {})}
          usage={usageApi}
        />
      ) : null}
    </div>
  );
}
