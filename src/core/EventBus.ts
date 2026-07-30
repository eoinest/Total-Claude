/**
 * Minimal typed pub/sub. Subsystems communicate through this rather than holding
 * direct references to each other, which keeps them independently testable and
 * lets the fan-out modules stay decoupled.
 */

export type Handler<T> = (payload: T) => void;

export class EventBus<Events extends Record<string, unknown>> {
  private map = new Map<keyof Events, Set<Handler<never>>>();
  /** Events queued during dispatch, flushed after the current dispatch completes. */
  private deferred: Array<() => void> = [];
  private dispatching = 0;

  on<K extends keyof Events>(key: K, fn: Handler<Events[K]>): () => void {
    let set = this.map.get(key);
    if (!set) {
      set = new Set();
      this.map.set(key, set);
    }
    set.add(fn as Handler<never>);
    return () => this.off(key, fn);
  }

  once<K extends keyof Events>(key: K, fn: Handler<Events[K]>): () => void {
    const off = this.on(key, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  off<K extends keyof Events>(key: K, fn: Handler<Events[K]>): void {
    this.map.get(key)?.delete(fn as Handler<never>);
  }

  emit<K extends keyof Events>(key: K, payload: Events[K]): void {
    const set = this.map.get(key);
    if (!set || set.size === 0) return;
    // Re-entrant emits are deferred so handlers can safely publish follow-ups.
    if (this.dispatching > 0) {
      this.deferred.push(() => this.emit(key, payload));
      return;
    }
    this.dispatching++;
    try {
      for (const fn of set) {
        try {
          (fn as Handler<Events[K]>)(payload);
        } catch (err) {
          console.error(`[EventBus] handler for "${String(key)}" threw:`, err);
        }
      }
    } finally {
      this.dispatching--;
      if (this.dispatching === 0 && this.deferred.length) {
        const queue = this.deferred;
        this.deferred = [];
        for (const run of queue) run();
      }
    }
  }

  clear(): void {
    this.map.clear();
    this.deferred.length = 0;
  }
}
