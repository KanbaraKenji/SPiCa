// Wire protocol between the backend process (the core) and its host (the
// Electron main process, or a test). Messages are plain JSON-able objects
// sent over a MessagePort-like channel.
import type { CoreEvent } from '../types.ts';

/** host → core: call a backend method. */
export interface WireRequest {
  t: 'req';
  id: number;
  method: string;
  params: unknown[];
}

/** core → host: the result of a request. */
export interface WireResponse {
  t: 'res';
  id: number;
  result?: unknown;
  error?: { code: string; message: string };
}

/** core → host: an event from the runtime, in order (global `seq`). */
export interface WireEvent {
  t: 'event';
  event: CoreEvent;
}

/** core → host: the backend finished starting (after restore()). */
export interface WireReady {
  t: 'ready';
  restored: { sessions: number; interrupted: string[]; awaiting: string[] };
  /** Problems with configuration (bad workflow files, ...), for the UI. */
  warnings: string[];
}

export type WireMessage = WireRequest | WireResponse | WireEvent | WireReady;

/**
 * Minimal port: Electron's MessagePortMain and Node's worker_threads
 * MessagePort both fit through the adapters below.
 */
export interface PortLike {
  post(msg: WireMessage): void;
  onMessage(cb: (msg: WireMessage) => void): void;
  close?(): void;
}

/** Node worker_threads MessagePort (message data passed directly). */
export function nodePort(port: {
  postMessage(v: unknown): void;
  on(ev: 'message', cb: (v: unknown) => void): unknown;
  close?(): void;
  unref?(): void;
}): PortLike {
  return {
    post: (m) => port.postMessage(m),
    onMessage: (cb) => void port.on('message', (v) => cb(v as WireMessage)),
    close: () => port.close?.(),
  };
}

/** Electron MessagePortMain (message data in `event.data`; needs start()). */
export function electronPort(port: {
  postMessage(v: unknown): void;
  on(ev: 'message', cb: (e: { data: unknown }) => void): unknown;
  start(): void;
  close(): void;
}): PortLike {
  return {
    post: (m) => port.postMessage(m),
    onMessage: (cb) => {
      port.on('message', (e) => cb(e.data as WireMessage));
      port.start();
    },
    close: () => port.close(),
  };
}
