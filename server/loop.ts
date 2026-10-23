// Real-time paced fixed-step loop. Each wake runs the ticks the wall clock says are due, at most `maxCatchUp` of them,
// so a slow moment is made up with extra fixed ticks rather than a longer dt; a backlog longer than `maxLagMs` is
// dropped (the room slows down instead of spiralling).

export interface LoopOptions {
  hz: number;
  maxCatchUp: number;
  maxLagMs: number;
  now?: () => number;
}

export class FixedLoop {
  private t0 = 0;
  private done = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Ticks skipped because the loop fell further behind than maxLagMs. */
  dropped = 0;
  /** Most ticks run in one wake. */
  maxBurst = 0;
  private readonly now: () => number;

  constructor(private readonly tick: () => void, readonly opts: LoopOptions) {
    this.now = opts.now ?? (() => performance.now());
  }

  get ticks(): number {
    return this.done;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.t0 = this.now() - this.done * (1000 / this.opts.hz);
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.running) return;
    const nextAt = this.t0 + ((this.done + 1) * 1000) / this.opts.hz;
    this.timer = setTimeout(() => this.wake(), Math.max(0, nextAt - this.now()));
  }

  private wake(): void {
    this.timer = null;
    if (!this.running) return;
    const step = 1000 / this.opts.hz;
    let due = Math.floor((this.now() - this.t0) / step) - this.done;
    if (due * step > this.opts.maxLagMs) {
      const skip = due - this.opts.maxCatchUp;
      this.t0 += skip * step;
      this.dropped += skip;
      due = this.opts.maxCatchUp;
    }
    const n = Math.min(due, this.opts.maxCatchUp);
    this.maxBurst = Math.max(this.maxBurst, n);
    for (let i = 0; i < n && this.running; i++) {
      this.done++;
      this.tick();
    }
    this.schedule();
  }
}
