// Shared rate limiter: max concurrent calls plus requests per minute.
// One instance per model endpoint, shared by every session in the runtime.
import { abortError } from './util.ts';

export interface LimiterConfig {
  /** Max calls in flight at once. 0 or undefined = unlimited. */
  maxConcurrent?: number;
  /** Max calls started within any 60 s window. 0 or undefined = unlimited. */
  requestsPerMinute?: number;
}

export interface Lease {
  release(): void;
}

interface Waiter {
  resolve: (lease: Lease) => void;
  reject: (err: Error) => void;
  onPosition?: (position: number) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class RateLimiter {
  #cfg: LimiterConfig;
  #active = 0;
  #starts: number[] = [];
  #queue: Waiter[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #now: () => number;

  constructor(cfg: LimiterConfig = {}, now: () => number = Date.now) {
    this.#cfg = cfg;
    this.#now = now;
  }

  /** Change the limits while running; waiters are released at once if the new limits allow it. */
  configure(cfg: LimiterConfig): void {
    this.#cfg = { ...cfg };
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#pump();
  }

  get config(): LimiterConfig {
    return { ...this.#cfg };
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  /**
   * Wait for a slot. `onPosition` is called with the 1-based queue position
   * whenever it changes (not called if a slot is free immediately).
   */
  acquire(opts: { signal?: AbortSignal; onPosition?: (position: number) => void } = {}): Promise<Lease> {
    if (opts.signal?.aborted) return Promise.reject(abortError(opts.signal));
    return new Promise<Lease>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...opts };
      if (opts.signal) {
        waiter.onAbort = () => {
          const i = this.#queue.indexOf(waiter);
          if (i >= 0) {
            this.#queue.splice(i, 1);
            reject(abortError(opts.signal));
            this.#notifyPositions();
          }
        };
        opts.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
      this.#pump();
      if (this.#queue.includes(waiter)) waiter.onPosition?.(this.#queue.length);
    });
  }

  #canStart(): number {
    const max = this.#cfg.maxConcurrent ?? 0;
    if (max > 0 && this.#active >= max) return Infinity;
    const rpm = this.#cfg.requestsPerMinute ?? 0;
    if (rpm > 0) {
      const now = this.#now();
      this.#starts = this.#starts.filter((t) => now - t < 60_000);
      if (this.#starts.length >= rpm) return 60_000 - (now - this.#starts[0]!) + 1;
    }
    return 0;
  }

  #pump(): void {
    let changed = false;
    while (this.#queue.length > 0) {
      const wait = this.#canStart();
      if (wait === Infinity) break;
      if (wait > 0) {
        if (!this.#timer) {
          this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.#pump();
          }, wait);
        }
        break;
      }
      const w = this.#queue.shift()!;
      changed = true;
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      this.#active++;
      this.#starts.push(this.#now());
      let released = false;
      w.resolve({
        release: () => {
          if (released) return;
          released = true;
          this.#active--;
          this.#pump();
        },
      });
    }
    if (changed) this.#notifyPositions();
  }

  #notifyPositions(): void {
    this.#queue.forEach((w, i) => w.onPosition?.(i + 1));
  }
}
