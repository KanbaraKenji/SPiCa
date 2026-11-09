import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Root } from './shell/Root';
import { installZoomInput } from './shell/zoomInput';
import { localDay, splashFor } from '../../shared/settings';
import { AgentStore } from './store/agent';
import { ShellStore } from './store/shell';
import '@spica/brand/styles.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Read settings before the first paint so the window opens in the right skin and size.
async function start(el: HTMLElement): Promise<void> {
  const bridge = window.spica;
  const state = await bridge.getShellState();
  installZoomInput((step) => bridge.zoom(step));
  const shell = new ShellStore(bridge, state);
  // The full opening animation plays once a day by default; later launches only flash the mark.
  const today = localDay();
  const splash = state.automated ? 'none' : splashFor(state.settings, today);
  if (splash === 'full') shell.update({ splashShownOn: today });
  const agent = new AgentStore(bridge);
  const ready = agent.init();
  const version = await bridge.getAppInfo().then((i) => i.version).catch(() => '');
  createRoot(el).render(
    <StrictMode>
      <Root splash={splash} ready={ready} version={version}>
        <App bridge={bridge} shell={shell} agent={agent} />
      </Root>
    </StrictMode>,
  );
}

void start(root);
