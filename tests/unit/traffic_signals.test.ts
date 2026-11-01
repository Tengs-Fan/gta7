// Traffic signals: the time left in each light (the countdowns), what the walk heads show against what pedestrians do,
// which approaches get a mast arm, a bracket or Dry Creek's span wire, the arms' clearance over the tallest vehicle,
// and the signals' meshes within the props' budget.
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { chaseOffset, CHASE_TARGET_Y } from '../../src/render/camera';
import { lensAt, signalGeometry, signalLayout, type SignalStyle } from '../../src/render/furniture';
import { PropsView } from '../../src/render/props';
import { LIT, quadLit, signalCount, signalStyle, walkAxes, walkShow, type QuadRole } from '../../src/render/signalHeads';
import { HARDWARE_CHUNK_SIZE, spatialKey, STATIC_CHUNK_SIZE } from '../../src/render/spatial';
import { VEHICLE_SPECS } from '../../src/sim/specs';
import { AVENUE_W, CURB_H, PROP_INSET } from '../../src/world/constants';
import type { Prop } from '../../src/world/layout';
import { axisOf, PED_WALK, SIGNAL_CYCLE, SIGNAL_GREEN, SIGNAL_HALF, SIGNAL_YELLOW, type Axis, type Dir } from '../../src/world/roads';
import { freshWorld } from './helpers';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  const ctx2d = (): unknown => {
    const store: Record<string | symbol, unknown> = {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      measureText: () => ({ width: 100 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
    return new Proxy(store, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  };
  const canvas = (): Record<string, unknown> => ({ width: 300, height: 150, clientWidth: 1280, clientHeight: 720, style: {}, getContext: (kind: string) => (kind === '2d' ? ctx2d() : null), addEventListener: () => {}, removeEventListener: () => {} });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

const W = freshWorld();
const roads = W.roads;
const signalled = roads.nodes.filter((n) => n.signal && n.degree > 0);
const AXES = ['NS', 'EW'] as const;
const signals = W.layout.props.filter((p) => p.kind === 'signal');
const STYLES: readonly SignalStyle[] = ['mast', 'bracket', 'span'];

/** A point in a signal's frame placed in the world, as PropsView.standard places the signal. */
function world(p: Prop, at: readonly [number, number, number]): THREE.Vector3 {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot), new THREE.Vector3(p.scale, p.scale, p.scale));
  return new THREE.Vector3(...at).applyMatrix4(m);
}

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

describe('which signals reach over the road', () => {
  it('a mast arm on every avenue approach, a bracket on every street\'s, the span wire at Las Lomas County\'s junction', () => {
    const counts: Record<SignalStyle, number> = { mast: 0, bracket: 0, span: 0 };
    for (const p of signals) {
      const style = signalStyle(roads, p);
      counts[style]++;
      const node = roads.nodes[p.node]!;
      const width = 2 * (axisOf(p.dir as Dir) === 'NS' ? node.halfX : node.halfZ);
      if (p.node >= roads.gridNodeCount) expect(style).toBe('span');
      else expect(style, `${p.node} ${p.dir}`).toBe(width >= AVENUE_W ? 'mast' : 'bracket');
    }
    console.log(`[signals] ${signals.length}: ${JSON.stringify(counts)}`);
    expect(counts.mast).toBeGreaterThan(100);
    expect(counts.bracket).toBeGreaterThan(100);
    expect(counts.span).toBe(4);
  });

  it('every city approach has a head hanging over the middle of each of its lanes, and nowhere else', () => {
    let heads = 0;
    for (const p of signals.filter((q) => q.node < roads.gridNodeCount)) {
      const layout = signalLayout(signalStyle(roads, p));
      const over = layout.heads.filter((h) => h.across).map((h) => world(p, [h.x, h.y, h.z]));
      const lanes = roads.lanes.filter((l) => l.to === p.node && l.dir === p.dir);
      expect(over.length, `${p.node} ${p.dir}`).toBe(lanes.length);
      const across = (v: { x: number; z: number }) => (axisOf(p.dir as Dir) === 'NS' ? v.x : v.z);
      for (const lane of lanes) {
        const miss = Math.min(...over.map((h) => Math.abs(across(h) - across({ x: lane.ex, z: lane.ez }))));
        expect(miss, `${p.node} ${p.dir} lane ${lane.index}`).toBeLessThan(0.05);
        heads++;
      }
    }
    expect(heads).toBeGreaterThan(400);
  });

  it('Dry Creek\'s heads hang from its span wires, each over the middle of its approach\'s inner lane', () => {
    const span = signals.filter((q) => signalStyle(roads, q) === 'span');
    expect(span.length).toBe(4);
    for (const p of span) {
      const [h] = signalLayout('span').heads;
      const at = world(p, [h!.x, h!.y, h!.z]);
      const inner = roads.lanes.find((l) => l.to === p.node && l.dir === p.dir && l.index === 0)!;
      const across = (v: { x: number; z: number }) => (axisOf(p.dir as Dir) === 'NS' ? v.x : v.z);
      expect(Math.abs(across(at) - across({ x: inner.ex, z: inner.ez })), `${p.dir}`).toBeLessThan(0.05);
      // Inside the junction's box, facing the traffic coming in.
      const node = roads.nodes[p.node]!;
      expect(Math.max(Math.abs(at.x - node.x), Math.abs(at.z - node.z))).toBeLessThan(node.halfX);
    }
  });

  it('nothing over the road hangs lower than 2.5 m over the tallest vehicle, or any chase camera at its normal zoom', () => {
    const tallest = Math.max(...Object.values(VEHICLE_SPECS).map((s) => s.height));
    // The chase camera's height over the road at rest, from its look point CHASE_TARGET_Y up the vehicle.
    const camera = Math.max(...Object.values(VEHICLE_SPECS).filter((s) => s.class !== 'boat').map((s) => s.height * CHASE_TARGET_Y + chaseOffset(s, 0, false).up));
    for (const style of STYLES) {
      const pos = signalGeometry(style).getAttribute('position');
      let low = Infinity;
      let over = 0;
      for (let i = 0; i < pos.count; i++) {
        // Past the road's edge, PROP_INSET from the pole: on a city signal's kerb, on Dry Creek's ground.
        if (pos.getX(i) >= -PROP_INSET) continue;
        over++;
        low = Math.min(low, pos.getY(i) + (style === 'span' ? 0 : CURB_H));
      }
      console.log(`[signals] ${style}: lowest over the road ${low.toFixed(2)} m (tallest vehicle ${tallest} m, highest chase camera ${camera.toFixed(2)} m)`);
      expect(over).toBeGreaterThan(100);
      expect(low).toBeGreaterThan(tallest + 2.5);
      expect(low).toBeGreaterThan(camera + 0.1);
    }
  });

  it('a mast arm or a bracket and its heads stay a few thousand triangles, standing on the ground', () => {
    for (const style of STYLES) {
      const g = signalGeometry(style);
      g.computeBoundingBox();
      const tris = g.getAttribute('position').count / 3;
      console.log(`[signals] ${style}: ${tris} triangles, ${g.boundingBox!.getSize(new THREE.Vector3()).toArray().map((v) => v.toFixed(2)).join(' x ')} m`);
      expect(tris).toBeLessThan(3000);
      expect(Math.abs(g.boundingBox!.min.y)).toBeLessThan(0.02);
    }
    for (const style of ['mast', 'bracket'] as const) expect(signalGeometry(style).userData.parts).toEqual(expect.arrayContaining(['pole', 'arm', 'head', 'lens', 'visor', 'backplate', 'border', 'count', 'walk']));
    expect(signalGeometry('span').userData.parts).toEqual(expect.arrayContaining(['pole', 'wire', 'hanger', 'head', 'lens', 'visor', 'backplate', 'border', 'count', 'walk']));
  });
});

describe('the signals\' meshes', () => {
  it('one model per style and cell, and every lit part citywide in one more', () => {
    for (const size of [HARDWARE_CHUNK_SIZE, STATIC_CHUNK_SIZE]) {
      const props = new PropsView(W, size);
      const meshes: THREE.InstancedMesh[] = [];
      props.group.traverse((o) => {
        if (o instanceof THREE.InstancedMesh && o.geometry.name.startsWith('signal-')) meshes.push(o);
      });
      const cells = (style: SignalStyle) => new Set(signals.filter((p) => signalStyle(roads, p) === style).map((p) => spatialKey(p.x, p.z, size))).size;
      const want = STYLES.reduce((n, style) => n + cells(style), 0) + 1;
      console.log(`[signals] ${meshes.length} signal meshes at ${size} m cells (${STYLES.map((s) => `${s} ${cells(s)}`).join(', ')}, lit 1)`);
      expect(meshes.length).toBe(want);
      // As many as the poles and bulbs drew before (a pole and a batch of bulbs per cell), or fewer.
      expect(meshes.length).toBeLessThanOrEqual(2 * new Set(signals.map((p) => spatialKey(p.x, p.z, size))).size);
      const lit = meshes.filter((m) => m.name === 'signal-lit');
      expect(lit.length).toBe(1);
      expect(lit[0]!.castShadow).toBe(false);
      expect((lit[0]!.material as THREE.Material).userData.contactShadow).toBe(false);
    }
  });

  it('every overhead lens sits on its head, drawn where the layout puts it', () => {
    const props = new PropsView(W);
    signals.slice(0, 40).forEach((p, i) => {
      const layout = signalLayout(signalStyle(roads, p));
      layout.heads.forEach((h, head) => {
        for (let k = 0; k < 3; k++) expect(props.signalLens(i, head, k).at.distanceTo(world(p, lensAt(h, k)))).toBeLessThan(0.02);
      });
    });
  });
});

describe('the walk heads on the poles', () => {
  /** Where a walk head of signal p faces, in the world. */
  const facing = (p: Prop, turn: number) => new THREE.Vector3(Math.sin(turn), 0, Math.cos(turn)).applyAxisAngle(new THREE.Vector3(0, 1, 0), p.rot);

  it('each faces across the crosswalk whose people it serves, on that crosswalk\'s light and axis; a T junction\'s spare one faces none', () => {
    let served = 0;
    let spare = 0;
    for (const p of signals) {
      const layout = signalLayout(signalStyle(roads, p));
      if (layout.walks.length === 0) continue;
      const axes = walkAxes(roads, p);
      layout.walks.forEach((f, w) => {
        const dir = facing(p, f.turn);
        // Crosswalks leaving from beside the pole in the direction the head faces.
        const across = W.walk.nodes
          .filter((a) => Math.hypot(a.x - p.x, a.z - p.z) < 3.2)
          .flatMap((a) => a.edges.filter((e) => e.crosswalk).map((e) => ({ a, e, b: W.walk.nodes[e.to]! })))
          .filter(({ a, b }) => new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize().dot(dir) > 0.9);
        if (axes[w] === null) {
          expect(across, `${p.node} ${p.dir} head ${w}`).toEqual([]);
          spare++;
          return;
        }
        expect(across.length, `${p.node} ${p.dir} head ${w}`).toBeGreaterThan(0);
        for (const { e } of across) {
          expect(e.roadNode, `${p.node} ${p.dir} head ${w}`).toBe(p.node);
          expect(e.axis, `${p.node} ${p.dir} head ${w}`).toBe(axes[w]);
        }
        served++;
      });
    }
    console.log(`[signals] ${served} walk heads over a crosswalk, ${spare} at T junctions facing none`);
    expect(served).toBeGreaterThan(500);
  });

  it('show the walking figure exactly when the people they face may start across, and blank where no crosswalk is', () => {
    const props = new PropsView(W);
    const priv = props as unknown as { signalSlots: Array<{ first: number; roles: readonly QuadRole[] }>; signalLit: THREE.InstancedMesh };
    const lit = priv.signalLit.geometry.getAttribute('aLit');
    const size = priv.signalLit.geometry.getAttribute('aSize');
    let checked = 0;
    for (let t = 0.3; t < SIGNAL_CYCLE; t += 1.7) {
      props.update(0, 0, t);
      signals.forEach((p, i) => {
        const slot = priv.signalSlots[i]!;
        const axes = walkAxes(roads, p);
        slot.roles.forEach((role, j) => {
          if (role.kind !== 'walk') return;
          const q = slot.first + j;
          const axis = axes[role.walk];
          if (axis === null) {
            expect(size.getX(q)).toBe(0);
            return;
          }
          expect(lit.getY(q) === LIT.walk, `${p.node} ${p.dir} head ${role.walk} at ${t}`).toBe(roads.pedCanCross(p.node, axis, t));
          checked++;
        });
      });
    }
    expect(checked).toBeGreaterThan(5000);
  });
});
