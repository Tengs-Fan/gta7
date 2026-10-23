// Live-source bookkeeping: how many sources each feature has started and how many are still playing.
// Tests read it to check that long play does not pile up nodes.

export class NodeTally {
  readonly started: Record<string, number> = {};
  readonly live: Record<string, number> = {};

  /** Counts `src` under `kind` until it ends; disconnects it then so its subgraph can be collected. */
  track(kind: string, src: AudioScheduledSourceNode): void {
    this.started[kind] = (this.started[kind] ?? 0) + 1;
    this.live[kind] = (this.live[kind] ?? 0) + 1;
    src.onended = () => {
      this.live[kind] = Math.max(0, (this.live[kind] ?? 1) - 1);
      try {
        src.disconnect();
      } catch {
        // Already disconnected.
      }
    };
  }

  /** Sources still playing, over every kind. */
  get total(): number {
    let n = 0;
    for (const k in this.live) n += this.live[k]!;
    return n;
  }
}
