// Per-client input latching between fixed server ticks. Held axes and buttons follow the newest input; every
// single-frame press reaches exactly one tick: presses are counted as they arrive and each tick takes at most one of
// each, so two presses of one button between two ticks land on consecutive ticks instead of merging into one.

import { neutralInput, type PlayerInput } from '../src/sim/input';

export const EDGE_FLAGS = ['firePressed', 'jump', 'enterExit', 'interact', 'job', 'hornPressed', 'reload', 'nextWeapon', 'prevWeapon'] as const;
export type EdgeFlag = (typeof EDGE_FLAGS)[number];

/** Presses queued per button at most (a flood of presses cannot build an unbounded backlog). */
const MAX_PENDING = 8;

export class InputLatch {
  private latest: PlayerInput = neutralInput();
  private readonly pending: Record<EdgeFlag, number> = Object.fromEntries(EDGE_FLAGS.map((f) => [f, 0])) as Record<EdgeFlag, number>;
  private readonly slots: number[] = [];
  /** Highest seq received (inputs at or below it are stale). */
  private received = 0;
  /** Highest seq whose input has been applied to a tick: reported back as the snapshot's ackSeq. */
  ackSeq = 0;
  /** Inputs accepted and ignored (stale) so far. */
  accepted = 0;
  stale = 0;
  /** Client tick the newest input was made against (its latest snapshot), for diagnostics. */
  clientTick = 0;

  /** Takes one client input; returns false (and ignores it) when its seq is not newer than the last one. */
  push(seq: number, input: PlayerInput, clientTick = 0): boolean {
    if (seq <= this.received) {
      this.stale++;
      return false;
    }
    this.received = seq;
    this.clientTick = clientTick;
    this.accepted++;
    this.latest = input;
    for (const f of EDGE_FLAGS) if (input[f] && this.pending[f] < MAX_PENDING) this.pending[f]++;
    if (input.selectSlot >= 0 && this.slots.length < MAX_PENDING) this.slots.push(input.selectSlot);
    return true;
  }

  /** The input for the next tick: the newest held state plus at most one of each queued press. */
  next(): PlayerInput {
    const l = this.latest;
    const out: PlayerInput = { ...l, aimOrigin: { ...l.aimOrigin }, aimDir: { ...l.aimDir } };
    for (const f of EDGE_FLAGS) {
      out[f] = this.pending[f] > 0;
      if (out[f]) this.pending[f]--;
    }
    out.selectSlot = this.slots.length > 0 ? this.slots.shift()! : -1;
    this.ackSeq = this.received;
    return out;
  }

  /** Forget held state and queued presses (a slot changing hands). Seq tracking stays. */
  clear(): void {
    this.latest = neutralInput();
    for (const f of EDGE_FLAGS) this.pending[f] = 0;
    this.slots.length = 0;
  }
}
