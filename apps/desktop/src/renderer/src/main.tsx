import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Root } from './shell/Root';
import { installZoomInput } from './shell/zoomInput';
import { localDay, splashFor } from '../../shared/settings';
import { enabledModels } from '../../shared/providers';
import { AgentStore } from './store/agent';
import { ShellStore } from './store/shell';
import { CloseAsk } from './ui/CloseDialog';
import { TextMenu, type EditCommand } from './ui/TextMenu';
import '@spica/brand/styles.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Read settings before the first paint so the window opens in the right skin and size.
async function start(el: HTMLElement): Promise<void> {
  const bridge = window.spica;
  const state = await bridge.getShellState();
  installZoomInput((step) => bridge.zoom(step));
  const edit = (command: EditCommand) => bridge.edit(command);
  const shell = new ShellStore(bridge, state);
  // The full opening animation plays once a day by default; later launches only flash the mark.
  const today = localDay();
  // Loading again after the page was lost (main/page-recovery.ts): straight back to the conversation, no animation.
  const splash = state.automated || state.reopen ? 'none' : splashFor(state.settings, today);
  if (splash === 'full') shell.update({ splashShownOn: today });
  const agent = new AgentStore(bridge);
  // No model set up yet (a first start): the store does not ask the core for its top conversation, which it could
  // not make without one. Not known (the list could not be read): as before.
  const providers = await bridge.providers.list().catch(() => null);
  const hasModel = providers === null || providers.items.some((p) => enabledModels(p.models).length > 0);
  // A start that opens on 新对话 (main/autostart.ts startsOnNewChat): the empty window once the list is in.
  const ready = agent.init(state.reopen?.sessionId ?? undefined, { hasModel }).then(() => {
    if (state.startOnNewChat) agent.newChat();
  });
  const version = await bridge.getAppInfo().then((i) => i.version).catch(() => '');
  createRoot(el).render(
    <StrictMode>
      <Root splash={splash} ready={ready} version={version}>
        <App bridge={bridge} shell={shell} agent={agent} version={version} />
        <CloseAsk bridge={bridge} />
        <TextMenu edit={edit} />
      </Root>
    </StrictMode>,
  );
}

void start(root);
