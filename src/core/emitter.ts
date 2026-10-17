/**
 * Minimal strongly typed event emitter. Listeners run synchronously inside emit() (sim events fire in the
 * middle of Sim.update), so one that throws is isolated: the others still run and emit() returns normally.
 */
export class Emitter<Events extends object> {
  private handlers = new Map<keyof Events, Array<(payload: never) => void>>();
  /** Exceptions thrown by listeners so far. Each listener's first one per event type is logged. */
  errors = 0;
  private readonly reported = new WeakMap<object, Set<keyof Events>>();

  on<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): () => void {
    let list = this.handlers.get(type);
    if (!list) {
      list = [];
      this.handlers.set(type, list);
    }
    list.push(fn as (payload: never) => void);
    return () => this.off(type, fn);
  }

  off<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn as (payload: never) => void);
    if (i >= 0) list.splice(i, 1);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const list = this.handlers.get(type);
    if (!list || list.length === 0) return;
    // Copy so handlers may unsubscribe while being dispatched.
    for (const fn of list.slice()) {
      try {
        (fn as (p: Events[K]) => void)(payload);
      } catch (err) {
        this.listenerFailed(type, fn, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }

  /** Counts a listener's exception and logs it, once per listener and event type (it may fire every frame). */
  private listenerFailed(type: keyof Events, fn: object, err: unknown): void {
    this.errors++;
    let types = this.reported.get(fn);
    if (!types) {
      types = new Set();
      this.reported.set(fn, types);
    }
    if (types.has(type)) return;
    types.add(type);
    console.error('GTA7 listener error', type, err);
  }
}
