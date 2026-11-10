// Serve a Runtime over a port: requests call the backend API, events are
// pushed in order and kept in a ring buffer for replay after a reconnect.
import { createAgentApi } from '../api.ts';
import type { Runtime } from '../runtime.ts';
import type { CoreEvent } from '../types.ts';
import type { PortLike, WireMessage, WireReady } from './wire.ts';

export interface BackendServerOptions {
  /** Events kept for eventsSince(). Default 5000. */
  bufferSize?: number;
  /** Extra methods (e.g. probeProvider with provider construction). */
  extraMethods?: Record<string, (...params: unknown[]) => unknown>;
}

/** Backend methods available over the wire: AgentApi plus a few host helpers. */
export type BackendMethods = Record<string, (...params: never[]) => unknown>;

export class BackendServer {
  readonly #rt: Runtime;
  readonly #ports = new Set<PortLike>();
  readonly #buffer: CoreEvent[] = [];
  readonly #size: number;
  readonly #methods: Record<string, (...params: unknown[]) => unknown>;
  readonly #off: () => void;
  #nextHost = 1;
  readonly #hostPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(rt: Runtime, opts: BackendServerOptions = {}) {
    this.#rt = rt;
    this.#size = opts.bufferSize ?? 5000;
    const api = createAgentApi(rt) as unknown as Record<string, (...p: unknown[]) => unknown>;
    this.#methods = {
      ...Object.fromEntries(Object.entries(api).map(([k, fn]) => [k, (...p: unknown[]) => fn(...p)])),
      /** Events with seq > `since` still in the buffer; `complete` is false when older ones were dropped. */
      eventsSince: (since: unknown) => {
        const s = Number(since) || 0;
        const first = this.#buffer[0]?.seq ?? Infinity;
        return { events: this.#buffer.filter((e) => e.seq > s), complete: s + 1 >= first || this.#buffer.length === 0 };
      },
      workflowErrors: () => [...rt.workflowErrors],
      ...opts.extraMethods,
    };
    this.#off = rt.events.on((event) => {
      this.#buffer.push(event);
      if (this.#buffer.length > this.#size) this.#buffer.splice(0, this.#buffer.length - this.#size);
      for (const p of this.#ports) p.post({ t: 'event', event });
    });
  }

  /** Attach a host connection. A port can be replaced (e.g. after the window reloads). */
  attach(port: PortLike, ready?: Omit<WireReady, 't'>): void {
    this.#ports.add(port);
    port.onMessage((msg: WireMessage) => void this.#handle(port, msg));
    if (ready) port.post({ t: 'ready', ...ready });
  }

  detach(port: PortLike): void {
    this.#ports.delete(port);
  }

  /**
   * Call a method the host registered (connectBackend's hostMethods) on the most
   * recently attached host. Rejects with code 'host_unavailable' when there is no
   * host or it does not have the method, 'timeout' when it does not answer.
   */
  callHost(method: string, params: unknown[] = [], timeoutMs = 30_000): Promise<unknown> {
    const port = [...this.#ports].at(-1);
    if (!port) return Promise.reject(hostError('host_unavailable', 'no window is connected to this backend'));
    return new Promise((resolve, reject) => {
      const id = this.#nextHost++;
      const timer = setTimeout(() => {
        this.#hostPending.delete(id);
        reject(hostError('timeout', `the window did not answer ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.#hostPending.set(id, { resolve, reject, timer });
      port.post({ t: 'hreq', id, method, params });
    });
  }

  async #handle(port: PortLike, msg: WireMessage): Promise<void> {
    if (msg.t === 'hres') {
      const p = this.#hostPending.get(msg.id);
      if (!p) return;
      this.#hostPending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(hostError(msg.error.code === 'unknown_method' ? 'host_unavailable' : msg.error.code, msg.error.message));
      else p.resolve(msg.result ?? undefined);
      return;
    }
    if (msg.t !== 'req') return;
    const fn = this.#methods[msg.method];
    if (!fn) {
      port.post({ t: 'res', id: msg.id, error: { code: 'unknown_method', message: `unknown method ${msg.method}` } });
      return;
    }
    try {
      const result = await fn(...(msg.params ?? []));
      port.post({ t: 'res', id: msg.id, result: result === undefined ? null : result });
    } catch (err) {
      port.post({ t: 'res', id: msg.id, error: { code: 'failed', message: err instanceof Error ? err.message : String(err) } });
    }
  }

  close(): void {
    this.#off();
    for (const [id, p] of this.#hostPending) {
      clearTimeout(p.timer);
      p.reject(hostError('host_unavailable', 'backend closed'));
      this.#hostPending.delete(id);
    }
    for (const p of this.#ports) p.close?.();
    this.#ports.clear();
  }

  get runtime(): Runtime {
    return this.#rt;
  }
}

function hostError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
