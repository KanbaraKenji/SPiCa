// AgentApi on the host side: forwards calls over the port to the backend
// process and delivers its events. The desktop main process uses this in
// place of createAgentApi(runtime).
import type { AgentApi, CoreEvent } from '../types.ts';
import type { PortLike, WireMessage, WireReady } from './wire.ts';

export class BackendError extends Error {
  override name = 'BackendError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface BackendClient {
  /** The AgentApi, backed by the remote process. */
  api: AgentApi;
  /** Call any backend method (eventsSince, probe, ...). */
  call<T = unknown>(method: string, ...params: unknown[]): Promise<T>;
  onEvent(cb: (e: CoreEvent) => void): () => void;
  /** Resolves with the backend's ready message (restore summary, warnings). */
  ready: Promise<Omit<WireReady, 't'>>;
  /** Fail every pending call (e.g. the backend process died). */
  fail(reason: string): void;
}

const API_METHODS = [
  'createSession',
  'listSessions',
  'getSession',
  'getMessages',
  'getPending',
  'send',
  'steer',
  'answer',
  'confirm',
  'renameSession',
  'resume',
  'abort',
  'exportTraces',
  'getTopSession',
  'createProject',
  'listProjects',
  'getProject',
  'listMail',
  'pollMail',
  'mailFeedback',
] as const;

export function connectBackend(port: PortLike, opts: { timeoutMs?: number } = {}): BackendClient {
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(e: CoreEvent) => void>();
  let resolveReady!: (r: Omit<WireReady, 't'>) => void;
  const ready = new Promise<Omit<WireReady, 't'>>((r) => (resolveReady = r));

  port.onMessage((msg: WireMessage) => {
    if (msg.t === 'event') {
      for (const l of listeners) {
        try {
          l(msg.event);
        } catch {
          // listener errors stay on the host side
        }
      }
    } else if (msg.t === 'res') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new BackendError(msg.error.code, msg.error.message));
      else p.resolve(msg.result ?? undefined);
    } else if (msg.t === 'ready') {
      const { t: _t, ...rest } = msg;
      void _t;
      resolveReady(rest);
    }
  });

  const call = <T>(method: string, ...params: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            pending.delete(id);
            reject(new BackendError('timeout', `backend did not answer ${method}`));
          }, opts.timeoutMs)
        : undefined;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, ...(timer ? { timer } : {}) });
      port.post({ t: 'req', id, method, params });
    });

  const api = Object.fromEntries(API_METHODS.map((m) => [m, (...p: unknown[]) => call(m, ...p)])) as unknown as AgentApi;

  return {
    api,
    call,
    ready,
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    fail: (reason) => {
      for (const [id, p] of pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new BackendError('backend_gone', reason));
        pending.delete(id);
      }
    },
  };
}
