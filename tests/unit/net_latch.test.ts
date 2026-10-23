// Input latching on the server (server/latch.ts): a client's 60 Hz inputs arrive with jitter (0, 1 or several between
// two server ticks) and every single-frame press reaches exactly one tick; held state follows the newest input; stale
// inputs are ignored; the ackSeq reported in snapshots is the last applied seq.

import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { neutralInput, type PlayerInput } from '../../src/sim/input';
import { EDGE_FLAGS, InputLatch, type EdgeFlag } from '../../server/latch';

describe('server input latching', () => {
  it('no press is lost or doubled under jittered arrival, held axes follow the newest input, ackSeq is exact', () => {
    const rng = new Rng(99);
    const latch = new InputLatch();
    const frames = 60 * 90;
    const sent: Record<EdgeFlag | 'selectSlot', number> = Object.fromEntries([...EDGE_FLAGS, 'selectSlot'].map((f) => [f, 0])) as never;
    const applied: Record<EdgeFlag | 'selectSlot', number> = Object.fromEntries([...EDGE_FLAGS, 'selectSlot'].map((f) => [f, 0])) as never;
    const slotsSent: number[] = [];
    const slotsApplied: number[] = [];
    // Client frames: at most one press per button per frame; a button is pressed again only after a release frame.
    const lastPress: Record<string, number> = {};
    const made: Array<{ seq: number; at: number; input: PlayerInput }> = [];
    for (let f = 0; f < frames; f++) {
      const inp = neutralInput();
      inp.moveX = Math.sin(f / 30);
      inp.throttle = (f % 97) / 96;
      inp.fire = f % 50 < 25;
      for (const flag of [...EDGE_FLAGS, 'selectSlot'] as const) {
        if (rng.chance(0.012) && (lastPress[flag] ?? -10) < f - 1) {
          lastPress[flag] = f;
          sent[flag]++;
          if (flag === 'selectSlot') {
            inp.selectSlot = rng.int(0, 5);
            slotsSent.push(inp.selectSlot);
          } else inp[flag] = true;
        }
      }
      // Jitter: each input is delayed 0-45 ms; a WebSocket keeps their order, so a late one holds up those behind it.
      const prev = made.length > 0 ? made[made.length - 1]!.at : 0;
      made.push({ seq: f + 1, at: Math.max(prev, f * (1000 / 60) + rng.range(0, 45)), input: inp });
    }
    const arrivals = made;
    let k = 0;
    let maxBetween = 0;
    let zeroBetween = 0;
    let acksChecked = 0;
    let lastApplied: PlayerInput | null = null;
    let newestSeqBeforeTick = 0;
    let newestInputBeforeTick: PlayerInput | null = null;
    // Server ticks at 60 Hz with a phase offset; snapshots every second tick.
    const ticks = frames + 10;
    for (let t = 0; t < ticks; t++) {
      const now = t * (1000 / 60) + 7;
      let between = 0;
      while (k < arrivals.length && arrivals[k]!.at <= now) {
        const a = arrivals[k++]!;
        if (latch.push(a.seq, a.input) && a.seq > newestSeqBeforeTick) {
          newestSeqBeforeTick = a.seq;
          newestInputBeforeTick = a.input;
        }
        between++;
      }
      maxBetween = Math.max(maxBetween, between);
      if (between === 0) zeroBetween++;
      const out = latch.next();
      lastApplied = out;
      for (const flag of EDGE_FLAGS) if (out[flag]) applied[flag]++;
      if (out.selectSlot >= 0) {
        applied.selectSlot++;
        slotsApplied.push(out.selectSlot);
      }
      // Held values come from the newest input received.
      if (newestInputBeforeTick) {
        expect(out.moveX).toBe(newestInputBeforeTick.moveX);
        expect(out.throttle).toBe(newestInputBeforeTick.throttle);
        expect(out.fire).toBe(newestInputBeforeTick.fire);
      }
      if (t % 2 === 1) {
        expect(latch.ackSeq).toBe(newestSeqBeforeTick);
        acksChecked++;
      }
    }
    const total = Object.values(sent).reduce((a, b) => a + b, 0);
    console.log(`[latch] ${frames} inputs, ${total} presses; per flag sent/applied: ${Object.keys(sent).map((f) => `${f} ${sent[f as EdgeFlag]}/${applied[f as EdgeFlag]}`).join(', ')}; up to ${maxBetween} inputs between ticks, ${zeroBetween} ticks with none; ${acksChecked} ackSeq checks`);
    expect(total).toBeGreaterThanOrEqual(500);
    for (const f of Object.keys(sent)) expect(applied[f as EdgeFlag], f).toBe(sent[f as EdgeFlag]);
    expect(slotsApplied).toEqual(slotsSent);
    expect(maxBetween).toBeGreaterThanOrEqual(2);
    expect(zeroBetween).toBeGreaterThan(0);
    expect(lastApplied).not.toBeNull();
  });

  it('two presses of one button between two ticks land on consecutive ticks', () => {
    const latch = new InputLatch();
    latch.push(1, { ...neutralInput(), jump: true });
    latch.push(2, neutralInput());
    latch.push(3, { ...neutralInput(), jump: true });
    expect(latch.next().jump).toBe(true);
    expect(latch.next().jump).toBe(true);
    expect(latch.next().jump).toBe(false);
  });

  it('an input with an older seq never overrides a newer one, and is not applied', () => {
    const latch = new InputLatch();
    latch.push(10, { ...neutralInput(), moveZ: 1 });
    expect(latch.push(9, { ...neutralInput(), moveZ: -1, jump: true })).toBe(false);
    expect(latch.push(10, { ...neutralInput(), moveZ: -1 })).toBe(false);
    const out = latch.next();
    expect(out.moveZ).toBe(1);
    expect(out.jump).toBe(false);
    expect(latch.ackSeq).toBe(10);
    expect(latch.stale).toBe(2);
  });

  it('a flood of presses is capped instead of building an unbounded backlog', () => {
    const latch = new InputLatch();
    for (let i = 1; i <= 2000; i++) latch.push(i, { ...neutralInput(), firePressed: true });
    let n = 0;
    for (let t = 0; t < 100; t++) if (latch.next().firePressed) n++;
    expect(n).toBeLessThanOrEqual(8);
    expect(latch.ackSeq).toBe(2000);
  });
});
