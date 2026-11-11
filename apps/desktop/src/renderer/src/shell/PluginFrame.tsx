// A plugin's page (views/<id>.json) in a sandboxed frame: scripts yes, but an
// opaque origin (no access to Spica's window, storage or other plugins), and the
// page's own CSP lets it load only its plugin's files. It talks to us through
// window.spica (a postMessage bridge); every call is answered for the plugin
// whose frame sent it, never for one named in the message.
import { useEffect, useRef, useState } from 'react';
import { pluginCallProblem, type PluginView, type PluginViewResult } from '../../../shared/plugin-view';

export interface PluginTheme {
  mode: 'light' | 'dark';
  vars: Record<string, string>;
}

export interface PluginFrameProps {
  view: PluginView;
  theme: PluginTheme;
  /** Changes when plugins change (enabled, updated...), so the page can refresh. */
  changed: number;
  /** `callId` names this call so it can be stopped while it runs. */
  call(tool: string, args: unknown, confirmed: boolean, callId: string): Promise<PluginViewResult>;
  /** Stops a call still running: its page is gone (closed, reloaded, its plugin turned off) and nobody takes the result. */
  cancel(callId: string): void;
  /** Asks the user before an irreversible tool runs; resolves to the answer. */
  /** Asks before a tool that needs confirmation runs; `args`: what it would run with (shown in full). */
  confirm(tool: string, args: unknown): Promise<boolean>;
  /** A file of this plugin, shown in the right panel; resolves to a problem in words, or null. */
  openFile(path: string): Promise<string | null>;
  notify(text: string, kind: 'info' | 'error'): void;
}

const CONFIRM = '[CONFIRM_REQUIRED]';

export function PluginFrame({ view, theme, changed, call, cancel, confirm, openFile, notify }: PluginFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const latest = useRef({ theme, call, cancel, confirm, openFile, notify });
  useEffect(() => {
    latest.current = { theme, call, cancel, confirm, openFile, notify };
  });
  // Tool calls of the page as it is now that have not come back. `page` counts the page's loads: an answer
  // for an earlier load is dropped (the new page numbers its calls from the start again).
  const running = useRef(new Set<string>());
  const page = useRef(0);
  const stopRunning = () => {
    for (const id of running.current) latest.current.cancel(id);
    running.current.clear();
  };

  const post = (msg: object) => ref.current?.contentWindow?.postMessage({ __spica: 1, ...msg }, '*');

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      // Only this frame's page, so only this plugin.
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const d = e.data as { __spica?: number; call?: string; id?: number; args?: Record<string, unknown> } | null;
      if (!d || d.__spica !== 1 || typeof d.call !== 'string') return;
      const { call: c, id = 0, args = {} } = d;
      // The page loaded again (its own reload, a navigation): what the page before it started is stopped.
      if (c === 'ready') {
        page.current += 1;
        stopRunning();
      }
      const from = page.current;
      const reply = (result: unknown) => from === page.current && post({ reply: id, result });
      const fail = (error: string) => from === page.current && post({ reply: id, error });
      const l = latest.current;
      // One tool call, known by an id while it runs so it can be stopped.
      const run = async (tool: string, toolArgs: unknown, confirmed: boolean) => {
        const callId = crypto.randomUUID();
        running.current.add(callId);
        try {
          return await l.call(tool, toolArgs, confirmed, callId);
        } finally {
          running.current.delete(callId);
        }
      };
      try {
        if (c === 'ready') {
          setReady(true);
          post({ event: { type: 'theme', mode: l.theme.mode, vars: l.theme.vars } });
        } else if (c === 'callTool') {
          const tool = String(args.tool ?? '');
          let r = await run(tool, args.args ?? {}, false);
          if (r.isError && r.content.startsWith(CONFIRM)) {
            if (!(await l.confirm(tool, args.args ?? {}))) {
              reply({ content: '用户已拒绝，未执行。', isError: true, declined: true });
              return;
            }
            // The page went away while the question was open: nothing is run for it.
            if (from !== page.current) return;
            r = await run(tool, args.args ?? {}, true);
          }
          const problem = r.isError ? pluginCallProblem(r.content) : null;
          reply(problem ? { ...r, content: problem } : r);
        } else if (c === 'openFile') {
          const problem = await l.openFile(String(args.path ?? ''));
          if (problem) fail(problem);
          else reply(null);
        } else if (c === 'notify') {
          l.notify(String(args.text ?? '').slice(0, 300), args.kind === 'error' ? 'error' : 'info');
          reply(null);
        } else {
          fail(`不支持的调用：${c}`);
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      // The page is closed (another view, the plugin turned off, the window's own reload).
      page.current += 1;
      stopRunning();
    };
  }, []);

  // Theme and plugin changes are pushed to a page that said it is ready.
  const themeKey = JSON.stringify(theme);
  useEffect(() => {
    if (ready) post({ event: { type: 'theme', mode: theme.mode, vars: theme.vars } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeKey, ready]);
  useEffect(() => {
    if (ready && changed) post({ event: { type: 'plugin.changed' } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed]);

  return (
    <iframe
      ref={ref}
      key={`${view.plugin}/${view.id}`}
      className="plugin-frame"
      title={`${view.pluginTitle} · ${view.title}`}
      src={`spica-plugin://${view.plugin}/${view.entry.replace(/^\/+/, '')}`}
      // Scripts and forms only: no same-origin (so no access to Spica), no popups, no top navigation.
      sandbox="allow-scripts allow-forms"
    />
  );
}

/** The page, or a sentence when its entry file cannot be loaded (plugin turned off, file missing). */
export function PluginPage(props: PluginFrameProps & { exists(plugin: string, path: string): Promise<boolean> }) {
  const { view, exists } = props;
  const key = `${view.plugin}/${view.entry}`;
  const [state, setState] = useState<{ key: string; ok: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    exists(view.plugin, view.entry)
      .then((ok) => alive && setState({ key, ok }))
      .catch(() => alive && setState({ key, ok: false }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!state || state.key !== key) return <div className="plugin-page" />;
  if (!state.ok) {
    return (
      <div className="plugin-page plugin-missing">
        <p>无法打开「{view.pluginTitle}」的页面：找不到 {view.entry}</p>
        <p className="settings-hint">插件不可用，请在 设置 › 插件 中查看状态。</p>
      </div>
    );
  }
  return (
    <div className="plugin-page">
      <PluginFrame {...props} />
    </div>
  );
}
