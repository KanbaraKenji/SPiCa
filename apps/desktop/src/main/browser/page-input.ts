// A page's WebContents as the agent uses it (browser/agent.ts). Input goes through the DevTools protocol
// (webContents.debugger): webContents.sendInputEvent works only while the window has the focus, which a window in
// the background or the hidden test window does not (tried). Focus is emulated so typing reaches the field.
// The person's own presses are told apart from the agent's: the page reports every mouse press (before-mouse-event,
// also for the protocol's), so a press that comes while the agent is not dispatching one is the person's.
import type { WebContents } from 'electron';
import type { AgentPage, CdpListener } from './agent';

/** One element's worth of the WebContents members used. */
export type PageContents = Pick<
  WebContents,
  'id' | 'isDestroyed' | 'isLoading' | 'getURL' | 'getTitle' | 'loadURL' | 'once' | 'removeListener' | 'executeJavaScriptInIsolatedWorld' | 'executeJavaScript' | 'capturePage' | 'debugger' | 'on'
>;

const wrapped = new WeakMap<object, AgentPage>();

export function agentPage(wc: PageContents, onHuman: (wcId: number) => void): AgentPage {
  const had = wrapped.get(wc);
  if (had) return had;
  let dispatching = 0;
  let ready: Promise<void> | null = null;
  const listeners = new Set<CdpListener>();
  // what the page's protocol sessions report (the console, the network, frames in other processes), to whoever listens
  wc.debugger.on('message', (_e, method, params, sessionId) => {
    for (const l of listeners) l(method, (params ?? {}) as Record<string, unknown>, sessionId || undefined);
  });
  // detached (the page went away, or another client took it): attached again at the next command
  wc.debugger.on('detach', () => {
    ready = null;
  });
  const attach = () => {
    ready ??= (async () => {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      for (const l of attachedHooks) await l().catch(() => undefined);
    })().catch((e: unknown) => {
      ready = null;
      throw e;
    });
    return ready;
  };
  const attachedHooks = new Set<() => Promise<void>>();
  wc.on('before-mouse-event', (_e, mouse) => {
    if (mouse.type === 'mouseDown' && dispatching === 0) onHuman(wc.id);
  });
  const page: AgentPage = {
    isDestroyed: () => wc.isDestroyed(),
    isLoading: () => wc.isLoading(),
    getURL: () => wc.getURL(),
    getTitle: () => wc.getTitle(),
    loadURL: (url) => wc.loadURL(url),
    once: (event, listener) => wc.once(event, listener),
    removeListener: (event, listener) => wc.removeListener(event, listener),
    executeJavaScriptInIsolatedWorld: (world, scripts) => wc.executeJavaScriptInIsolatedWorld(world, scripts),
    executeJavaScript: (code) => wc.executeJavaScript(code),
    capturePage: () => wc.capturePage(),
    async cdp(method, params, sessionId) {
      await attach();
      dispatching++;
      try {
        return await wc.debugger.sendCommand(method, params, sessionId);
      } finally {
        // the page reports the press a moment after the command returns
        setTimeout(() => dispatching--, 300);
      }
    },
    onCdp(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onAttached(hook) {
      attachedHooks.add(hook);
      // already attached: now; else when it is
      if (wc.debugger.isAttached() && ready) void ready.then(() => hook()).catch(() => undefined);
      return () => attachedHooks.delete(hook);
    },
  };
  wrapped.set(wc, page);
  return page;
}
