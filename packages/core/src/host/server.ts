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

  async #handle(port: PortLike, msg: WireMessage): Promise<void> {
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
    for (const p of this.#ports) p.close?.();
    this.#ports.clear();
  }

  get runtime(): Runtime {
    return this.#rt;
  }
}
