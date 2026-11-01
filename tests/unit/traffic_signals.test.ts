// Traffic signals: the time left in each light (the countdowns), what the walk heads show against what pedestrians do,
// which approaches get a mast arm, a bracket or Dry Creek's span wire, the arms' clearance over the tallest vehicle,
// and the signals' meshes within the props' budget.
import { describe, expect, it } from 'vitest';
import { LIT, quadLit, signalCount, walkShow } from '../../src/render/signalHeads';
import { PED_WALK, SIGNAL_CYCLE, SIGNAL_GREEN, SIGNAL_HALF, SIGNAL_YELLOW, type Axis } from '../../src/world/roads';
import { freshWorld } from './helpers';

const W = freshWorld();
const roads = W.roads;
const signalled = roads.nodes.filter((n) => n.signal && n.degree > 0);
const AXES = ['NS', 'EW'] as const;

describe('the time left in a light', () => {
  const n = signalled[7]!;
  /** The sim time at which the junction is `c` seconds into its cycle. */
  const at = (c: number) => c - n.offset;

  it('counts each light down from its full length at the junction\'s own offset', () => {
    expect(roads.signalTimeLeft(n.id, 'NS', at(0))).toBeCloseTo(SIGNAL_GREEN, 9);
    expect(roads.signalTimeLeft(n.id, 'EW', at(0))).toBeCloseTo(SIGNAL_HALF, 9);
    expect(roads.signalTimeLeft(n.id, 'NS', at(SIGNAL_GREEN))).toBeCloseTo(SIGNAL_YELLOW, 9);
    // Red after the yellow: through the all-red, the other axis's whole half and its all-red.
    expect(roads.signalTimeLeft(n.id, 'NS', at(SIGNAL_GREEN + SIGNAL_YELLOW))).toBeCloseTo(SIGNAL_CYCLE - SIGNAL_GREEN - SIGNAL_YELLOW, 9);
    expect(roads.signalTimeLeft(n.id, 'NS', at(SIGNAL_HALF))).toBeCloseTo(SIGNAL_HALF, 9);
    expect(roads.signalTimeLeft(n.id, 'EW', at(SIGNAL_HALF))).toBeCloseTo(SIGNAL_GREEN, 9);
    // EW in its all-red, half a second before NS's green: its red runs on through all of NS's half.
    expect(roads.signalTimeLeft(n.id, 'EW', at(SIGNAL_CYCLE - 0.5))).toBeCloseTo(SIGNAL_HALF + 0.5, 9);
    // Before the clock starts and many cycles on, the same.
    expect(roads.signalTimeLeft(n.id, 'NS', at(3) - 5 * SIGNAL_CYCLE)).toBeCloseTo(SIGNAL_GREEN - 3, 6);
    expect(roads.signalTimeLeft(n.id, 'NS', at(3) + 4000 * SIGNAL_CYCLE)).toBeCloseTo(SIGNAL_GREEN - 3, 6);
  });

  it('the light holds for exactly the time left at every signalised junction, and changes then', () => {
    let checked = 0;
    for (const node of signalled) {
      for (const axis of AXES) {
        for (let t = -40; t < 2 * SIGNAL_CYCLE; t += 0.37) {
          const left = roads.signalTimeLeft(node.id, axis, t)!;
          const now = roads.signalState(node.id, axis, t);
          expect(left).toBeGreaterThan(0);
          expect(left).toBeLessThanOrEqual(SIGNAL_CYCLE - SIGNAL_GREEN - SIGNAL_YELLOW + 1e-9);
          expect(roads.signalState(node.id, axis, t + left - 1e-6), `${node.id} ${axis} ${t}`).toBe(now);
          expect(roads.signalState(node.id, axis, t + left + 1e-6), `${node.id} ${axis} ${t}`).not.toBe(now);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(30000);
  });

  it('pedestrians walk with the green beside them for PED_WALK seconds', () => {
    for (const node of signalled) {
      for (const crossed of AXES) {
        const beside: Axis = crossed === 'NS' ? 'EW' : 'NS';
        for (let t = 0; t < SIGNAL_CYCLE; t += 0.25) {
          const left = roads.signalTimeLeft(node.id, beside, t)!;
          const green = roads.signalState(node.id, beside, t) === 'green';
          expect(roads.pedCanCross(node.id, crossed, t)).toBe(green && left > SIGNAL_GREEN - PED_WALK);
        }
      }
    }
  });

  it('is unknown while the junction is held', () => {
    roads.holdSignal(n.id, 'EW');
    for (const axis of AXES) expect(roads.signalTimeLeft(n.id, axis, at(3))).toBeNull();
    roads.releaseSignal(n.id);
    expect(roads.signalTimeLeft(n.id, 'NS', at(3))).toBeCloseTo(SIGNAL_GREEN - 3, 9);
  });
});

describe('the countdown beside a head', () => {
  const n = signalled[11]!;
  const at = (c: number) => c - n.offset;
  /** The two digits a countdown shows (null: unlit), and their colour. */
  const shown = (axis: Axis, t: number) => {
    const show = { state: roads.signalState(n.id, axis, t), count: signalCount(roads, n.id, axis, t), walks: [] };
    const digits = [0, 1].map((k) => quadLit({ kind: 'count', k }, show, [0, 0]));
    return { digits: digits.map(([tile, lit]) => (lit === LIT.off ? null : tile)), colour: digits.find(([, lit]) => lit !== LIT.off)?.[1] ?? null };
  };

  it('shows the whole seconds left in the red or the green, from the light\'s full length down to 1', () => {
    expect(signalCount(roads, n.id, 'NS', at(0))).toBe(SIGNAL_GREEN);
    expect(signalCount(roads, n.id, 'NS', at(0.01))).toBe(SIGNAL_GREEN);
    expect(signalCount(roads, n.id, 'NS', at(SIGNAL_GREEN - 0.01))).toBe(1);
    // The red starts the instant the yellow ends, at its full 18 s, and reads 1 in its last second.
    expect(signalCount(roads, n.id, 'NS', at(SIGNAL_GREEN + SIGNAL_YELLOW))).toBe(18);
    expect(signalCount(roads, n.id, 'NS', at(SIGNAL_GREEN + SIGNAL_YELLOW + 0.5))).toBe(18);
    expect(signalCount(roads, n.id, 'NS', at(SIGNAL_GREEN + SIGNAL_YELLOW + 1))).toBe(17);
    expect(signalCount(roads, n.id, 'NS', at(SIGNAL_CYCLE - 0.01))).toBe(1);
    expect(signalCount(roads, n.id, 'EW', at(0))).toBe(SIGNAL_HALF);
    expect(signalCount(roads, n.id, 'EW', at(SIGNAL_HALF))).toBe(SIGNAL_GREEN);
  });

  it('two red digits for the red, one green digit under 10, nothing in the yellow or while held', () => {
    expect(shown('NS', at(SIGNAL_GREEN + SIGNAL_YELLOW + 0.5))).toEqual({ digits: [1, 8], colour: LIT.countRed });
    expect(shown('NS', at(3.5))).toEqual({ digits: [null, 8], colour: LIT.countGreen });
    expect(shown('NS', at(0.5))).toEqual({ digits: [1, 1], colour: LIT.countGreen });
    expect(shown('NS', at(SIGNAL_GREEN + 1))).toEqual({ digits: [null, null], colour: null });
    roads.holdSignal(n.id, 'NS');
    expect(signalCount(roads, n.id, 'NS', at(3.5))).toBeNull();
    expect(signalCount(roads, n.id, 'EW', at(3.5))).toBeNull();
    expect(shown('EW', at(3.5))).toEqual({ digits: [null, null], colour: null });
    roads.releaseSignal(n.id);
  });
});

describe('the walk heads', () => {
  it('show the walking figure exactly while pedestrians may start across, the hand otherwise, at every junction', () => {
    let walks = 0;
    let flashes = 0;
    for (const node of signalled) {
      for (const crossed of AXES) {
        const beside: Axis = crossed === 'NS' ? 'EW' : 'NS';
        for (let t = -3; t < SIGNAL_CYCLE + 3; t += 0.05) {
          const w = walkShow(roads, node.id, crossed, t);
          const may = roads.pedCanCross(node.id, crossed, t);
          expect(w.symbol === 'walk', `${node.id} ${crossed} ${t}`).toBe(may);
          if (may) {
            walks++;
            // Counting down the walk: 6 at its start, 1 in its last second.
            expect(w.count).toBe(Math.ceil(roads.signalTimeLeft(node.id, beside, t)! - (SIGNAL_GREEN - PED_WALK)));
            expect(w.count).toBeGreaterThanOrEqual(1);
            expect(w.count).toBeLessThanOrEqual(PED_WALK);
          } else if (roads.signalState(node.id, beside, t) === 'green') {
            // The rest of the green beside them: the hand flashes, counting the green down.
            flashes++;
            expect(w.symbol).toBe(((t % 1) + 1) % 1 < 0.5 ? 'hand' : 'dark');
            expect(w.count).toBe(Math.ceil(roads.signalTimeLeft(node.id, beside, t)!));
          } else expect(w).toEqual({ symbol: 'hand', count: null });
        }
      }
    }
    expect(walks).toBeGreaterThan(1000);
    expect(flashes).toBeGreaterThan(1000);
  });

  it('a held junction walks people across the road it stops and keeps them off the one it holds green, with no count', () => {
    const n = signalled[3]!;
    roads.holdSignal(n.id, 'NS');
    for (let t = 0; t < SIGNAL_CYCLE; t += 0.5) {
      expect(walkShow(roads, n.id, 'EW', t)).toEqual({ symbol: 'walk', count: null });
      expect(walkShow(roads, n.id, 'NS', t)).toEqual({ symbol: 'hand', count: null });
      expect(roads.pedCanCross(n.id, 'EW', t)).toBe(true);
      expect(roads.pedCanCross(n.id, 'NS', t)).toBe(false);
    }
    roads.releaseSignal(n.id);
  });
});
