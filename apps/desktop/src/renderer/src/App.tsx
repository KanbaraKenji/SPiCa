// The window: title bar, left sidebar, main pane (conversation or settings), right detail panel.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DesktopBridge } from '../../shared/bridge';
import { AgentStore, friendlyError, useAgent } from './store/agent';
import { ShellStore, useShell } from './store/shell';
import { computeLayout, toggleAction, type Floating } from './shell/layout';
import { useViewportWidth } from './shell/useViewportWidth';
import { Sidebar } from './shell/Sidebar';
import { DetailPanel } from './shell/DetailPanel';
import { Conversation, type ConversationActions } from './chat/Conversation';
import { SettingsView } from './settings/SettingsView';
import { Icon } from './ui/Icon';
import { SpicaMark } from './mark/SpicaMark';

export interface AppProps {
  bridge: DesktopBridge;
  shell: ShellStore;
  agent: AgentStore;
}

type View = 'chat' | 'settings';

export function App({ bridge, shell, agent }: AppProps) {
  const { settings } = useShell(shell);
  const state = useAgent(agent);
  const width = useViewportWidth();
  const [floating, setFloating] = useState<Floating>(null);
  const [view, setView] = useState<View>('chat');
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
        else if (view === 'settings') setView('chat');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, floating, view]);

  // Screenshot script hook (only set when the script asks for a different view).
  useEffect(() => {
    window.__spicaShots = { setView: (v) => setView(v === 'settings' ? 'settings' : 'chat') };
    return () => {
      delete window.__spicaShots;
    };
  }, []);

  const session = state.sessions.find((s) => s.id === state.activeId);
  const parent = session?.parentId ? state.sessions.find((s) => s.id === session.parentId) : undefined;
  const transcript = agent.transcript(state.activeId);
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
    send: (text) => id && void agent.send(id, text),
    stop: () => id && void agent.stop(id),
    answer: (callId, a) => id && void agent.answer(id, callId, a),
    confirm: (callId, ok) => id && void agent.confirm(id, callId, ok),
    openFile,
  };

  const leftShown = layout.left !== 'hidden';
  const rightShown = layout.right !== 'hidden';
  const title = view === 'settings' ? '设置' : (session?.title ?? '');

  return (
    <div className="app" data-left={layout.left} data-right={view === 'chat' ? layout.right : 'hidden'}>
      <header className="titlebar">
        <div className="titlebar-left">
          <span className="titlebar-brand" aria-hidden>
            <SpicaMark size={18} />
          </span>
          <button type="button" className={leftShown ? 'icon-btn is-on' : 'icon-btn'} onClick={() => toggle('left')} aria-label={leftShown ? '收起侧栏' : '展开侧栏'} aria-pressed={leftShown} title="侧栏（Ctrl+B）">
            <Icon name="sidebar" />
          </button>
        </div>
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
        <div className="titlebar-right">
          {view === 'chat' ? (
            <button type="button" className={rightShown ? 'icon-btn is-on' : 'icon-btn'} onClick={() => toggle('right')} aria-label={rightShown ? '收起详情' : '展开详情'} aria-pressed={rightShown} title="详情（Ctrl+Alt+B）">
              <Icon name="detail" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="body">
        {leftShown ? (
          <div className={`panel panel-left is-${layout.left}`}>
            <Sidebar
              sessions={state.sessions}
              activeId={state.activeId}
              onOpen={openSession}
              onNewChat={() => {
                setView('chat');
                setFloating(null);
                void agent.newChat();
              }}
              onSettings={() => {
                setView((v) => (v === 'settings' ? 'chat' : 'settings'));
                setFloating(null);
              }}
              settingsOpen={view === 'settings'}
            />
          </div>
        ) : null}

        <main className="main">
          {view === 'settings' ? (
            <SettingsView shell={shell} />
          ) : state.loaded ? (
            <Conversation session={session} transcript={transcript} actions={actions} />
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
              onClose={layout.right === 'floating' ? () => setFloating(null) : undefined}
            />
          </div>
        ) : null}

        {floating ? <div className="scrim scrim-panel" onMouseDown={() => setFloating(null)} aria-hidden /> : null}
      </div>
    </div>
  );
}
