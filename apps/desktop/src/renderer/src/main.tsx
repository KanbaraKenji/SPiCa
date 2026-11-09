import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AgentStore } from './store/agent';
import { ShellStore } from './store/shell';
import '@spica/brand/styles.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Read settings before the first paint so the window opens in the right skin and size.
async function start(el: HTMLElement): Promise<void> {
  const bridge = window.spica;
  const shell = new ShellStore(bridge, await bridge.getShellState());
  const agent = new AgentStore(bridge);
  void agent.init();
  createRoot(el).render(
    <StrictMode>
      <App bridge={bridge} shell={shell} agent={agent} />
    </StrictMode>,
  );
}

void start(root);
