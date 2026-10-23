// Rolling statistics for the status report.

/** Keeps the last `size` samples; mean, percentile and max over them. */
export class Rolling {
  private readonly buf: Float64Array;
  private n = 0;
  private i = 0;

  constructor(readonly size = 600) {
    this.buf = new Float64Array(size);
  }

  add(v: number): void {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.size;
    if (this.n < this.size) this.n++;
  }

  get count(): number {
    return this.n;
  }

  mean(): number {
    if (this.n === 0) return 0;
    let s = 0;
    for (let k = 0; k < this.n; k++) s += this.buf[k]!;
    return s / this.n;
  }

  percentile(p: number): number {
    if (this.n === 0) return 0;
    const a = Array.from(this.buf.subarray(0, this.n)).sort((x, y) => x - y);
    return a[Math.min(this.n - 1, Math.max(0, Math.ceil((p / 100) * this.n) - 1))]!;
  }

  max(): number {
    let m = 0;
    for (let k = 0; k < this.n; k++) m = Math.max(m, this.buf[k]!);
    return m;
  }
}

/** Events per second over a sliding window of wall-clock time. */
export class RateMeter {
  private readonly times: number[] = [];
  private amounts: number[] = [];

  constructor(readonly windowMs = 5000) {}

  mark(now: number, amount = 1): void {
    this.times.push(now);
    this.amounts.push(amount);
    this.trim(now);
  }

  private trim(now: number): void {
    let k = 0;
    while (k < this.times.length && this.times[k]! < now - this.windowMs) k++;
    if (k > 0) {
      this.times.splice(0, k);
      this.amounts.splice(0, k);
    }
  }

  /** Count (or summed amount) per second over the window; `since` caps the window for a meter younger than it. */
  rate(now: number, since = -Infinity, sum = false): number {
    this.trim(now);
    const span = Math.min(this.windowMs, now - since);
    if (span <= 0) return 0;
    const total = sum ? this.amounts.reduce((a, b) => a + b, 0) : this.times.length;
    return (total * 1000) / span;
  }
}
