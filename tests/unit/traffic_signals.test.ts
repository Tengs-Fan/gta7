// Traffic signals: the time left in each light (the countdowns), what the walk heads show against what pedestrians do,
// which approaches get a mast arm, a bracket or Dry Creek's span wire, the arms' clearance over the tallest vehicle,
// and the signals' meshes within the props' budget.
import { describe, expect, it } from 'vitest';
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
