/** Minimal strongly typed event emitter. Listeners run synchronously inside emit() (sim events fire in the middle of Sim.update). */
export class Emitter<Events extends object> {
  private handlers = new Map<keyof Events, Array<(payload: never) => void>>();

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
    for (const fn of list.slice()) (fn as (p: Events[K]) => void)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
