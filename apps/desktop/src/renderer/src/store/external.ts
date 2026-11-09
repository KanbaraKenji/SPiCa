// Tiny external store for useSyncExternalStore: one value, many subscribers.
export class Store<T> {
  #value: T;
  #listeners = new Set<() => void>();

  constructor(initial: T) {
    this.#value = initial;
  }

  get = (): T => this.#value;

  set(next: T | ((prev: T) => T)): void {
    const value = typeof next === 'function' ? (next as (prev: T) => T)(this.#value) : next;
    if (Object.is(value, this.#value)) return;
    this.#value = value;
    for (const l of this.#listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}
