// The window: title bar, left sidebar, main pane (conversation or settings), right detail panel.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopBridge, PreviewInfo } from '../../shared/bridge';
import { AgentStore, displayTitle, friendlyError, useAgent } from './store/agent';
import { ShellStore, useShell } from './store/shell';
import { computeLayout, panelWidths, toggleFrom, type Floating } from './shell/layout';
import { Resizer } from './shell/Resizer';
import { ConfirmDialog } from './ui/Dialog';
import { FilePreview, usePreview } from './shell/FilePreview';
import { PluginPage, type PluginTheme } from './shell/PluginFrame';
import { FONT_UI, pluginThemeVars, type PluginView } from '../../shared/plugin-view';
import { deriveTokens, schemeOf } from '../../shared/skin';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { sidebarBannerHeight, wordmarkProps } from './app-wordmark';
import { useViewportWidth } from './shell/useViewportWidth';
import { Sidebar } from './shell/Sidebar';
import { canRename, commitRename, hasRowMenu, RenameField, rowMenuItems, type RowActions } from './shell/row-menu';
import { ContextMenu } from './ui/ContextMenu';
import { DetailPanel } from './shell/DetailPanel';
import { Conversation, type ConversationActions, type WaitingChild } from './chat/Conversation';
import { ConfirmTarget } from './chat/Blocks';
import type { ComposerTools } from './chat/Composer';
import { enabledModels, type ModelRef, type ProviderView } from '../../shared/providers';
import { SettingsView, type SettingsTab } from './settings/SettingsView';
import { NewProjectDialog } from './shell/NewProjectDialog';
import { NoticeBar, useBackendState, useUpdateState } from './shell/NoticeBar';
import { InboxView, type InboxProject } from './shell/InboxView';
import { MailStore, useMail } from './store/mail';
import { needsYou } from '../../shared/mail';
import { nextDoneNews, unseenDone } from './shell/row-status';
import type { MailItem, SessionInfo } from '@spica/protocol';
import { Icon } from './ui/Icon';
import { MaxButton } from './ui/MaxButton';
import { sidebarNews } from './shell/sidebar-news';
import { watchCover } from './ui/dim';
import { usePeek } from './shell/peek';
import { RailHead, SidebarHead, SidebarToggle } from './shell/SidebarToggle';
import { HoverTips } from './ui/HoverTips';
import { SpicaBanner } from '@spica/brand/react';
import { sameFolder } from './store/relocate';
import { APP_NAME } from '../../shared/app-identity';

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
  // A file to show in the right panel, or (inline) a page from an answer's HTML code block.
  const [preview, setPreview] = useState<{ sessionId: string | null; path: string; sheet?: number; inline?: PreviewInfo } | null>(null);
  const loadedPreview = usePreview(bridge.preview, preview && !preview.inline ? preview : null);
  const previewInfo = preview?.inline ?? loadedPreview;
  /** The project the user asked to delete (waiting for the confirmation). */
  const [deletingProject, setDeletingProject] = useState<null | { id: string; name: string }>(null);
  const [deletingChat, setDeletingChat] = useState<null | { id: string; name: string }>(null);
  const update = useUpdateState(bridge);
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
    if (view !== 'chat') return;
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
  }, [bridge, view, modelsChanged]);
  // 主页: the empty page before any conversation is open, and whatever Spica opens
  // by itself at start (the assistant's main conversation) until you open a
  // conversation yourself. The right panel starts closed there and opening it
  // lasts only this visit; conversations keep the saved choice.
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
      const next = toggleFrom(side, window.innerWidth, prefs, floating, peeking);
      if (atHome && side === 'right') setHomeRight(next.prefs.right);
      else if (next.prefs !== prefs) shell.update({ panels: atHome ? { ...next.prefs, right: saved.right } : next.prefs });
      setFloating(next.floating);
      // Opened or closed on purpose: no longer a peek from the edge.
      setPeeking(false);
    },
    [floating, shell, atHome, homeRight, peeking],
  );

  // The open conversation's name being edited in the title bar (its session id), and its menu there.
  const [titleEditing, setTitleEditing] = useState<string | null>(null);
  const [titleMenu, setTitleMenu] = useState<{ x: number; y: number } | null>(null);
  const openTitleMenu = (e: { preventDefault(): void; clientX: number; clientY: number }) => {
    e.preventDefault();
    setTitleMenu({ x: e.clientX, y: e.clientY });
  };

  // The right panel over the whole conversation (an expand button, Ctrl+Shift+\); for this visit only.
  const [rightMax, setRightMax] = useState(false);
  // Only while the right panel is there to show (set below, once the layout is known).
  const [canMax, setCanMax] = useState(false);

  // Shortcuts: Ctrl+B sidebar, Ctrl+Alt+B details, Ctrl+Shift+\ right panel over the conversation,
  // Esc closes a floating panel or settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggle(e.altKey ? 'right' : 'left');
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'Backslash') {
        if (!canMax) return;
        e.preventDefault();
        setRightMax((v) => !v);
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        if (floating) setFloating(null);
        else if (view !== 'chat') setView('chat');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, floating, view, canMax]);

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
      title: byManager.get(s.id) ?? displayTitle(s, state.firstLines),
    }));
  }, [state.sessions, state.firstLines, state.projects, mail.threadId]);
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
  const inboxCount = mail.items.filter(needsYou).length;
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
  // Opened from a history row or link: the message to show, and the conversation it was opened from (返回).
  // Kept while that conversation is open; going anywhere else ends it.
  const [found, setFound] = useState<{ sessionId: string; seq?: number; from: string | null; reached: boolean } | null>(null);
  if (found && !found.reached && state.activeId === found.sessionId) setFound({ ...found, reached: true });
  else if (found?.reached && state.activeId !== found.sessionId) setFound(null);
  const openFound = (id: string, seq?: number) => {
    setFound({ sessionId: id, ...(seq !== undefined ? { seq } : {}), from: state.activeId, reached: false });
    openSession(id);
  };
  // Files open in the right panel (read-only preview); 用系统程序打开 there hands them to Windows.
  const previewFile = (path: string) => {
    setPreview({ sessionId: state.activeId, path });
    showRight(atHome);
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
  const [pluginAsk, setPluginAsk] = useState<{ title: string; tool: string; args: unknown; resolve(ok: boolean): void } | null>(null);
  // 设置 › 插件: the plugin commands, and the system folder picker for 插件位置.
  const pluginsApi = useMemo(() => ({ ...bridge.plugins, pickFolder: () => bridge.pickFolder('选择插件文件夹') }), [bridge]);
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
  const openPluginView = view === 'plugin' ? sidebarPages.find((v) => viewKey(v) === openPlugin) : undefined;
  const panelPluginView = rightTab === 'detail' ? undefined : panelPages.find((v) => viewKey(v) === rightTab);
  const skinNow = shell.activeSkin();
  const pluginTheme: PluginTheme = { mode: schemeOf(skinNow.bg), vars: pluginThemeVars(deriveTokens(skinNow), FONT_UI) };
  const pluginProps = (v: PluginView) => ({
    view: v,
    theme: pluginTheme,
    changed: pluginsChanged,
    call: (tool: string, args: unknown, confirmed: boolean, callId: string) => bridge.pluginViews.call(v.plugin, v.id, tool, args, confirmed, callId),
    cancel: (callId: string) => bridge.pluginViews.cancel(callId),
    confirm: (tool: string, args: unknown) => new Promise<boolean>((resolve) => setPluginAsk({ title: `「${v.pluginTitle}」将执行「${tool}」，此操作不可撤销。`, tool, args, resolve })),
    openFile: async (path: string) => {
      const abs = await bridge.pluginViews.file(v.plugin, path);
      if (!abs) return '仅能打开插件自身文件夹中的文件。';
      setPreview({ sessionId: null, path: abs });
      setView('chat');
      showRight(!state.activeId);
      return null;
    },
    notify: (text: string) => agent.state.set((s) => ({ ...s, notice: `${v.pluginTitle}：${text}` })),
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
      const marks = [isRef(pointers.default, p.id, m.id) ? '默认' : '', isRef(pointers.strong, p.id, m.id) ? '强模型' : ''].filter(Boolean).join(' · ');
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
  // 选择工作文件夹 in a conversation (once): the user's own conversations, not in a project. With something said
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
          void bridge.pickFolder('选择工作文件夹').then((dir) => {
            if (!dir) return;
            if (transcript.items.length) setCwdAsk({ sessionId: s.id, dir, stay: sameFolder(s.cwd, shell.legacyDefaultCwd) });
            else void agent.chooseCwd(s.id, dir);
          }),
      },
    };
  };
  const composerTools: ComposerTools = {
    pickFiles: () => bridge.pickFiles('添加附件'),
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
              void bridge.pickFolder('选择工作文件夹').then((dir) => {
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
            ...(shownGone ? { note: '（已移除）' } : shownProvider ? { provider: shownProvider } : {}),
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
    send: (text, files) => void agent.send(id, text, files ?? []),
    stop: () => id && void agent.stop(id),
    answer: (callId, a) => id && void agent.answer(id, callId, a),
    confirm: (callId, ok) => id && void agent.confirm(id, callId, ok),
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
    openModelSettings: () => {
      setSettingsTab('models');
      setView('settings');
    },
    imageUrl: bridge.images.url,
    previewHtml: (title, html) => {
      setPreview({ sessionId: null, path: '', inline: { kind: 'html', name: title, path: '', size: html.length, text: html, truncated: false } });
      showRight(atHome);
    },
  };

  const foundView = (f: NonNullable<typeof found>) => {
    const from = f.from ? sessions.find((s) => s.id === f.from) : undefined;
    return {
      ...(f.seq !== undefined ? { seq: f.seq } : {}),
      ...(from && from.id !== f.sessionId
        ? {
            back: {
              title: from.title || '新对话',
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
  const rightShown = layout.right !== 'hidden';
  // Maximized only while the panel is there to show; closing it or leaving the conversation ends that.
  const rightCanMax = rightShown && view === 'chat';
  if (canMax !== rightCanMax) setCanMax(rightCanMax);
  if (rightMax && !rightCanMax) setRightMax(false);
  const panelMax = { on: rightMax, toggle: () => setRightMax((v) => !v) };
  const title = view === 'settings' ? '设置' : view === 'inbox' ? '收件箱' : view === 'plugin' ? (openPluginView?.title ?? '') : (session?.title ?? '');

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
    ...(bridge.agent.deleteSession ? { onDeleteChat: (s: SessionInfo) => setDeletingChat({ id: s.id, name: s.title || '新对话' }) } : {}),
  };
  // The open conversation's name in the title bar: a click edits it, a right-click opens its menu.
  const named = view === 'chat' ? session : undefined;

  const sidebarToggle = <SidebarToggle shown={leftShown} onToggle={() => toggle('left')} />;

  // The sidebar, full (docked or over the window) or as the column of icons left when it is closed.
  const sidebarEl = (compact: boolean) => (
    <Sidebar
      compact={compact}
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
      {...(bridge.agent.createProject && !shell.demo ? { onNewProject: () => setNewProject({}) } : {})}
      {...sidebarNews({
        inboxShown: mail.supported && mailSource,
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
    />
  );

  // Frame (like Claude Desktop): the sidebar runs the full height of the window
  // with the brand and its own toggle at the top; the title bar covers only the
  // main pane and the detail panel.
  return (
    <div className="app" data-left={layout.left} data-right={view === 'chat' ? layout.right : 'hidden'}>
      <HoverTips />
      {/* Sidebar closed: a column of icons stays. Resting on the toggle at its top opens the full
          sidebar over it for a moment, every row where its icon was; the icons themselves do not
          (a press on one goes straight to its page). */}
      {layout.left !== 'docked' ? (
        <div className="panel panel-rail" onMouseDown={peek.cancel}>
          <RailHead toggle={sidebarToggle} onRest={() => peek.openSoon(floating === 'left')} onLeave={peek.cancel} />
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
      <header className="titlebar">
        <div className="titlebar-title">
          {view === 'chat' && parent ? (
            <>
              <button type="button" className="crumb" onClick={() => openSession(parent.id)} title={`返回 ${parent.title}`}>
                {parent.title}
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
              plugins={pluginsApi}
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
              previewPages={previewPages}
            />
          ) : view === 'plugin' ? (
            openPluginView ? (
              <PluginPage key={viewKey(openPluginView)} {...pluginProps(openPluginView)} />
            ) : (
              <div className="plugin-page plugin-missing">
                <p>插件页面不可用（插件已停用或已卸载）。</p>
              </div>
            )
          ) : view === 'inbox' ? (
            <InboxView
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
              onOpenSettings={() => {
                setSettingsTab('plugins');
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
              {...(found && found.sessionId === state.activeId ? { found: foundView(found) } : {})}
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
              <button type="button" className="icon-btn" onClick={() => agent.dismissNotice()} aria-label="关闭提示" title="关闭">
                <Icon name="close" size={14} />
              </button>
            </div>
          ) : null}
        </main>

        {rightShown && view === 'chat' ? (
          <div className={`panel panel-right is-${layout.right}${rightMax ? ' is-max' : ''}`} style={rightMax ? undefined : { width: widths.right }}>
            {rightMax ? null : resizer('right')}
            {panelPages.length && !preview ? (
              <div className="right-head">
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
              {/* The panel over the conversation: at the end of the tab row (the preview and the details have their own heads). */}
              <MaxButton max={panelMax} />
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
                onReveal={(p) => void bridge.showInFolder(p).then(showNotice, (err: unknown) => showNotice(friendlyError(err)))}
                onSheet={(n) => setPreview((p) => (p ? { ...p, sheet: n } : p))}
                onClose={() => setPreview(null)}
                max={panelMax}
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
              max={panelPages.length ? undefined : panelMax}
            />
            )}
          </div>
        ) : null}

      </div>
      </div>


      {pluginAsk ? (
        <ConfirmDialog
          title={pluginAsk.title}
          detail={<ConfirmTarget name={pluginAsk.tool} input={pluginAsk.args} />}
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

      {deletingChat ? (
        <ConfirmDialog
          title={`删除对话「${deletingChat.name}」？`}
          detail="将删除这条对话的记录，助理以后查不到它；它产出的文件不会删除。"
          confirmLabel="删除"
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
          title={`将工作文件夹设为「${folderName(cwdAsk.dir)}」？`}
          detail={cwdAsk.stay ? `选定后不能更改；原来的文件留在「文档\\${APP_NAME}」。` : '选定后不能更改；这条对话已产生的文件会移到该文件夹。'}
          confirmLabel="选定"
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
          title={`删除项目「${deletingProject.name}」？`}
          detail={`将删除该项目及其对话记录，不会删除项目文件夹中的文件。`}
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
