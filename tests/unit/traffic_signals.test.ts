// Traffic signals: the time left in each light (the countdowns), what the walk heads show against what pedestrians do,
// which approaches get a mast arm, a bracket or Dry Creek's span wire, the arms' clearance over the tallest vehicle,
// and the signals' meshes within the props' budget.
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { chaseOffset, CHASE_TARGET_Y } from '../../src/render/camera';
import { lensAt, signalGeometry, signalLayout, type SignalStyle } from '../../src/render/furniture';
import { OCCLUDER_AXIS } from '../../src/render/occluderFade';
import { PropsView, SIGNAL_UPLOAD_RANGES } from '../../src/render/props';
import { hasOpposite, LIT, quadLit, showKey, showScratch, signalCount, signalQuads, signalShow, signalStyle, walkAxes, walkShow, type QuadRole } from '../../src/render/signalHeads';
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

describe('what a signal shows', () => {
  it('is written into one scratch show, equal to what its parts say, whatever the time', () => {
    const scratch = showScratch();
    let flashing = 0;
    for (const p of signals.filter((_, k) => k % 7 === 0)) {
      const own = axisOf(p.dir as Dir);
      const cross: Axis = own === 'NS' ? 'EW' : 'NS';
      for (let t = -5; t < SIGNAL_CYCLE + 5; t += 0.43) {
        const show = signalShow(roads, p, t, scratch);
        expect(show).toBe(scratch);
        expect(show).toEqual({ state: roads.signalState(p.node, own, t), count: signalCount(roads, p.node, own, t), walks: [walkShow(roads, p.node, own, t), walkShow(roads, p.node, cross, t)] });
        if (show.walks[0]!.symbol === 'dark') flashing++;
      }
    }
    expect(flashing).toBeGreaterThan(10);
    // The key changes with anything shown.
    const a = showKey(signalShow(roads, signals[0]!, 3.2, scratch));
    expect(showKey(signalShow(roads, signals[0]!, 3.2, scratch))).toBe(a);
    expect(showKey(signalShow(roads, signals[0]!, 4.4, scratch))).not.toBe(a);
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
      const over = layout.heads.filter((h) => h.across && !h.back).map((h) => world(p, [h.x, h.y, h.z]));
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
      const h = signalLayout('span').heads.find((q) => q.y > 6);
      const at = world(p, [h!.x, h!.y, h!.z]);
      const inner = roads.lanes.find((l) => l.to === p.node && l.dir === p.dir && l.index === 0)!;
      const across = (v: { x: number; z: number }) => (axisOf(p.dir as Dir) === 'NS' ? v.x : v.z);
      expect(Math.abs(across(at) - across({ x: inner.ex, z: inner.ez })), `${p.dir}`).toBeLessThan(0.05);
      // Inside the junction's box, facing the traffic coming in.
      const node = roads.nodes[p.node]!;
      expect(Math.max(Math.abs(at.x - node.x), Math.abs(at.z - node.z))).toBeLessThan(node.halfX);
    }
  });

  it('Dry Creek\'s wooden poles carry a head and its countdown too, standing off the pole as far as its walk heads, serving the lanes by the kerb', () => {
    const span = signalLayout('span');
    const [pole] = span.heads;
    // Like the steel pole's (and in the same place on it, bar the stand-off), with its small countdown under it.
    for (const style of ['mast', 'bracket'] as const) {
      const near = signalLayout(style).heads[0]!;
      expect([pole!.y, pole!.turn, pole!.lens, pole!.gap, pole!.across]).toEqual([near.y, near.turn, near.lens, near.gap, near.across]);
      expect(pole!.z).toBeGreaterThan(near.z);
    }
    expect(span.counts[0]).toMatchObject({ y: signalLayout('mast').counts[0]!.y, h: signalLayout('mast').counts[0]!.h });
    expect(span.heads.length).toBe(2);
    expect(span.counts.length).toBe(2);
    // Each approach has it on the kerb side of the head hanging over its inner lane, so no farther from the outer lane
    // (a highway's two-lane approaches: the pole's head is the one by the outer lane).
    for (const p of signals.filter((q) => signalStyle(roads, q) === 'span')) {
      const across = (v: { x: number; z: number }) => (axisOf(p.dir as Dir) === 'NS' ? v.x : v.z);
      const kerb = across(world(p, [pole!.x, pole!.y, pole!.z]));
      const hanging = across(world(p, [span.heads[1]!.x, span.heads[1]!.y, span.heads[1]!.z]));
      const lanes = roads.lanes.filter((l) => l.to === p.node && l.dir === p.dir);
      const outer = across({ x: lanes[lanes.length - 1]!.ex, z: lanes[lanes.length - 1]!.ez });
      expect(Math.abs(kerb - outer), `${p.dir}`).toBeLessThanOrEqual(Math.abs(kerb - hanging) + 1e-9);
    }
  });

  it('nothing over the road hangs lower than 2.5 m over the tallest vehicle, or any chase camera at rest on its normal or far zoom', () => {
    const tallest = Math.max(...Object.values(VEHICLE_SPECS).map((s) => s.height));
    // The chase cameras' height over the road at rest (the view level), from their look point CHASE_TARGET_Y up the vehicle.
    const cameras = Object.entries(VEHICLE_SPECS).filter(([, s]) => s.class !== 'boat').flatMap(([name, s]) => [false, true].map((far) => ({ name: `${name}${far ? ' far' : ''}`, up: s.height * CHASE_TARGET_Y + chaseOffset(s, 0, far).up })));
    const highest = cameras.reduce((a, b) => (b.up > a.up ? b : a));
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
      console.log(`[signals] ${style}: lowest over the road ${low.toFixed(2)} m (tallest vehicle ${tallest} m, highest chase camera ${highest.name} ${highest.up.toFixed(2)} m)`);
      expect(over).toBeGreaterThan(100);
      expect(low).toBeGreaterThan(tallest + 2.5);
      for (const c of cameras) expect(low, c.name).toBeGreaterThan(c.up + 0.1);
    }
  });

  it('the dissolve axis runs up to the top of every pole, the steel ones and Dry Creek\'s wooden ones', () => {
    for (const style of STYLES) {
      const g = signalGeometry(style);
      g.computeBoundingBox();
      expect(g.boundingBox!.max.y, style).toBeLessThanOrEqual(OCCLUDER_AXIS.signal.to);
      expect(g.boundingBox!.max.y, style).toBeGreaterThan(OCCLUDER_AXIS.signal.to - 2);
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
    // Two hangers on each head over the road and one on the countdown between them, whatever height they hang at.
    for (const style of ['mast', 'bracket'] as const) {
      const layout = signalLayout(style);
      const over = layout.heads.filter((h) => h.across && !h.back).length;
      expect((signalGeometry(style).userData.parts as string[]).filter((n) => n === 'hanger').length, style).toBe(2 * over + layout.counts.filter((c) => c.over && !c.back).length);
    }
    expect(signalGeometry('span').userData.parts).toEqual(expect.arrayContaining(['pole', 'wire', 'hanger', 'head', 'lens', 'visor', 'backplate', 'border', 'count', 'walk']));
  });
});

describe('the backs of the mast arms\' heads', () => {
  it('a mast arm\'s heads each have a twin facing the opposite approach, on the back of their backplates, and so has its countdown', () => {
    const mast = signalLayout('mast');
    const fronts = mast.heads.filter((h) => h.across && !h.back);
    const backs = mast.heads.filter((h) => h.back);
    expect(fronts.length).toBe(2);
    expect(backs.length).toBe(2);
    fronts.forEach((f, k) => {
      const b = backs[k]!;
      expect([b.x, b.y, b.across, b.lens, b.gap]).toEqual([f.x, f.y, f.across, f.lens, f.gap]);
      expect(b.turn).toBe(Math.PI);
      expect(b.z).toBe(-f.z);
      // Red is on the viewer's left from either side: the back's red lens is at the front's yellow's other side.
      expect(lensAt(b, 0)[0]).toBeCloseTo(lensAt(f, 2)[0], 9);
    });
    const [front, back] = mast.counts.filter((c) => c.over);
    expect([back!.x, back!.y, back!.back, back!.turn, back!.z]).toEqual([front!.x, front!.y, true, Math.PI, -front!.z]);
    // The twin takes its front's housing: one box with a hood on each face.
    const parts = signalGeometry('mast').userData.parts as string[];
    expect(parts.filter((n) => n === 'count').length).toBe(2 + 2 + 1);
    // Only the mast arms have them: a bracket's one head and Dry Creek's hang over their own lane for their own approach.
    for (const style of ['bracket', 'span'] as const) {
      expect(signalLayout(style).heads.some((h) => h.back), style).toBe(false);
      expect(signalLayout(style).counts.some((c) => c.back), style).toBe(false);
    }
  });

  it('show what their approach\'s own signal shows: the same lens, the same digits, and a T junction\'s stem has no one to see them', () => {
    const props = new PropsView(W);
    const priv = props as unknown as { signalSlots: Array<{ first: number; roles: readonly QuadRole[]; blank: readonly boolean[] }>; signalLit: THREE.InstancedMesh };
    const lit = priv.signalLit.geometry.getAttribute('aLit');
    const size = priv.signalLit.geometry.getAttribute('aSize');
    let masts = 0;
    let dead = 0;
    for (const t of [3.3, 9.9, 20.5, 27.1]) {
      props.update(0, 0, t);
      signals.forEach((p, i) => {
        if (signalStyle(roads, p) !== 'mast') return;
        const layout = signalLayout('mast');
        const slot = priv.signalSlots[i]!;
        // Each over-lane head's lenses and its twin's.
        for (let k = 0; k < 3; k++) {
          for (const [front, back] of [[1, 3], [2, 4]] as const) {
            const f = slot.first + slot.roles.findIndex((r) => r.kind === 'lens' && r.head === front && r.k === k);
            const b = slot.first + slot.roles.findIndex((r) => r.kind === 'lens' && r.head === back && r.k === k);
            expect([lit.getX(b), lit.getY(b)], `${p.node} ${p.dir} lens ${k}`).toEqual([lit.getX(f), lit.getY(f)]);
          }
        }
        // The countdown: its second and third faces (the pole's is the first) show the same digits.
        const digits = slot.roles.flatMap((r, j) => (r.kind === 'count' ? [slot.first + j] : []));
        expect(digits.length).toBe(6);
        for (let k = 0; k < 2; k++) expect([lit.getX(digits[4 + k]!), lit.getY(digits[4 + k]!)]).toEqual([lit.getX(digits[2 + k]!), lit.getY(digits[2 + k]!)]);
        // Blank where no traffic comes the other way.
        const opposite = roads.lanes.some((l) => l.to === p.node && l.dir === (p.dir + 2) % 4);
        expect(hasOpposite(roads, p), `${p.node} ${p.dir}`).toBe(opposite);
        layout.heads.forEach((h, head) => {
          if (!h.back) return;
          for (let k = 0; k < 3; k++) {
            const j = slot.roles.findIndex((r) => r.kind === 'lens' && r.head === head && r.k === k);
            expect(size.getX(slot.first + j) > 0, `${p.node} ${p.dir} back head ${head}`).toBe(opposite);
            expect(slot.blank[j]).toBe(!opposite);
          }
        });
        for (const j of [4, 5]) expect(size.getX(digits[j]!) > 0).toBe(opposite);
        masts++;
        if (!opposite) dead++;
      });
    }
    console.log(`[signals] ${masts} mast signal frames checked, ${dead} of them with no opposite approach`);
    expect(masts).toBeGreaterThan(400);
    expect(dead).toBeGreaterThan(0);
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

  it('a walk head is a 16 inch one: a 0.30 m figure and 0.23 m digits on a box about 0.7 x 0.42 m', () => {
    for (const style of STYLES) {
      const layout = signalLayout(style);
      const quads = signalQuads(layout).filter((q) => q.role.kind === 'walk' || q.role.kind === 'walkCount');
      expect(quads.length).toBe(3 * layout.walks.length);
      for (const q of quads) {
        const f = layout.walks[(q.role as { walk: number }).walk]!;
        // Along the face from its centre, in the face's own frame (onFace).
        const u = (q.at[0] - f.x) * Math.cos(f.turn) - (q.at[2] - f.z) * Math.sin(f.turn);
        if (q.role.kind === 'walk') expect([q.w, q.h]).toEqual([0.3, 0.3]);
        else expect([q.w, q.h]).toEqual([0.115, 0.23]);
        // Inside the box, with a margin.
        expect(Math.abs(u) + q.w / 2, `${style} ${q.role.kind}`).toBeLessThan(0.35 - 0.04);
        expect(q.h / 2).toBeLessThan(0.21 - 0.04);
      }
    }
  });

  it('a T junction collapses its spare walk head, the one facing no crosswalk, on every instance, in its model and its shadow', () => {
    const props = new PropsView(W);
    const priv = props as unknown as { refs: Map<number, Array<{ mesh: THREE.InstancedMesh; index: number }>>; signalPropIndex: number[]; signalProps: Prop[] };
    let spare = 0;
    priv.signalProps.forEach((p, k) => {
      const { mesh, index } = priv.refs.get(priv.signalPropIndex[k]!)![0]!;
      const off = mesh.geometry.getAttribute('aSpareOff');
      expect(mesh.geometry.getAttribute('aSpare'), mesh.geometry.name).toBeDefined();
      expect(off.getX(index), `${p.node} ${p.dir}`).toBe(walkAxes(roads, p)[1] === null ? 1 : 0);
      spare += off.getX(index);
      expect(mesh.customDepthMaterial?.customProgramCacheKey()).toBe('gta7-signal-depth');
    });
    // The 30 of them: no new meshes, so the props' budget holds (m3_props counts it).
    expect(spare).toBe(30);
    // Only the second walk head's vertices are flagged: a walk head's two boxes and its clamp.
    for (const style of STYLES) {
      const flags = signalGeometry(style).getAttribute('aSpare');
      let flagged = 0;
      for (let i = 0; i < flags.count; i++) flagged += flags.getX(i);
      expect(flagged, style).toBe(3 * 36);
    }
    // The two materials collapse them to the instance's foot.
    const mesh = priv.refs.get(priv.signalPropIndex[0]!)![0]!.mesh;
    for (const mat of [mesh.material as THREE.Material, mesh.customDepthMaterial!]) {
      const lib = mat instanceof THREE.MeshDepthMaterial ? THREE.ShaderLib.depth : THREE.ShaderLib.standard;
      const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
      mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      expect(shader.vertexShader, mat.type).toContain('if ( aSpare * aSpareOff > 0.5 ) transformed = vec3( 0.0 );');
    }
  });

  it('every crosswalk end at a signalised junction has a walk head facing the person waiting there, bar a pinned 66', () => {
    const heads = signals.flatMap((p) => signalLayout(signalStyle(roads, p)).walks.map((f, w) => ({ p, dir: facing(p, f.turn), axis: walkAxes(roads, p)[w] })));
    let ends = 0;
    let bare = 0;
    for (const a of W.walk.nodes) {
      for (const e of a.edges) {
        if (!e.crosswalk || !roads.nodes[e.roadNode]!.signal) continue;
        ends++;
        const b = W.walk.nodes[e.to]!;
        const back = new THREE.Vector3(a.x - b.x, 0, a.z - b.z).normalize();
        if (!heads.some((h) => h.p.node === e.roadNode && h.axis === e.axis && Math.hypot(h.p.x - b.x, h.p.z - b.z) < 3.2 && h.dir.dot(back) > 0.9)) bare++;
      }
    }
    // The 66 that have none, of 704. 32 are at a T junction's corner that has no approach and so no pole (a walk head
    // stands on the signal pole of the approach at its corner; its spare head faces along the kerb, not across the road
    // there). The other 34 are at corners whose approach the layout left without any signal: 18 approaches
    // (layout.ts re-lays the roads after the sea bodies and adds the bridged segments back, but the signals were
    // generated against the earlier road set, and its filter can only remove them), a layout bug apart from this
    // branch. Fixing either lowers the number: lower it here then.
    expect(ends).toBe(704);
    expect(bare).toBe(66);
    const approaches = new Set(signals.map((p) => `${p.node}/${p.dir}`));
    const unsignalled = new Set(roads.lanes.filter((l) => roads.nodes[l.to]!.signal && !approaches.has(`${l.to}/${l.dir}`)).map((l) => `${l.to}/${l.dir}`));
    expect(unsignalled.size).toBe(18);
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

describe('the lit buffers upload what changed', () => {
  /** The ranges of `attr` as sorted, merged [start, end) pairs, the way the renderer sends them. */
  const merged = (attr: THREE.BufferAttribute): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (const r of [...attr.updateRanges].sort((a, b) => a.start - b.start)) {
      const last = out[out.length - 1];
      if (last && r.start <= last[1]) last[1] = Math.max(last[1], r.start + r.count);
      else out.push([r.start, r.start + r.count]);
    }
    return out;
  };

  it('a frame sends the slices of the signals that changed, and the whole buffer when more than a few did', () => {
    const props = new PropsView(W);
    const priv = props as unknown as { signalLit: THREE.InstancedMesh; signalHalos: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> };
    const buffers = [priv.signalLit.geometry.getAttribute('aLit'), priv.signalHalos.geometry.getAttribute('color')] as THREE.BufferAttribute[];
    // The first frame writes every signal: all of both buffers.
    props.update(0, 1, 100);
    for (const attr of buffers) {
      expect(merged(attr), attr.array.length.toString()).toEqual([[0, attr.array.length]]);
      attr.clearUpdateRanges();
    }
    let partial = 0;
    let whole = 0;
    let still = 0;
    for (let f = 1; f <= 240; f++) {
      const before = buffers.map((attr) => Float32Array.from(attr.array));
      props.update(0, 1, 100 + f / 60);
      buffers.forEach((attr, b) => {
        const ranges = merged(attr);
        // Whatever changed is inside what is sent.
        for (let k = 0; k < attr.array.length; k++) {
          if (attr.array[k] !== before[b]![k]) expect(ranges.some(([from, to]) => k >= from && k < to), `buffer ${b} float ${k} at frame ${f}`).toBe(true);
        }
        expect(attr.updateRanges.length, `frame ${f}`).toBeLessThanOrEqual(SIGNAL_UPLOAD_RANGES + 1);
        if (b > 0) return;
        if (ranges.length === 0) still++;
        else if (ranges.length === 1 && ranges[0]![1] - ranges[0]![0] === attr.array.length) whole++;
        else partial++;
      });
      for (const attr of buffers) attr.clearUpdateRanges();
    }
    console.log(`[signals] 240 frames: ${still} unchanged, ${partial} with a few slices, ${whole} with the whole buffer`);
    expect(partial).toBeGreaterThan(20);
    expect(whole).toBeGreaterThan(0);
    // Most of the quads' buffer is never sent in a frame that sends slices.
    expect(partial + still).toBeGreaterThan(whole);
  });
});

describe('the signals\' lit quads on the software tier', () => {
  it('go with their pole\'s batch when the props are culled by distance, and come back with it', () => {
    const props = new PropsView(W, STATIC_CHUNK_SIZE);
    const priv = props as unknown as { signalLit: THREE.InstancedMesh; signalSlots: Array<{ first: number; roles: readonly QuadRole[]; pole: THREE.Object3D }> };
    const size = priv.signalLit.geometry.getAttribute('aSize');
    const whole = Float32Array.from(size.array);
    const drawn = (k: number) => {
      const slot = priv.signalSlots[k]!;
      let area = 0;
      for (let j = slot.first; j < slot.first + slot.roles.length; j++) area += size.getX(j) * size.getY(j);
      return area;
    };
    // Standing at one signal, with the 110 m cull the renderer uses on a software GPU.
    const at = signals[200]!;
    props.cull(at.x, at.z, 110, 110);
    let shown = 0;
    let hidden = 0;
    signals.forEach((p, k) => {
      const near = priv.signalSlots[k]!.pole.visible;
      expect(drawn(k) > 0, `${p.node} ${p.dir}`).toBe(near);
      if (near) shown++;
      else hidden++;
    });
    console.log(`[signals] culled at 110 m: ${shown} signals drawn, ${hidden} hidden`);
    expect(drawn(200)).toBeGreaterThan(0);
    expect(shown).toBeGreaterThan(3);
    expect(hidden).toBeGreaterThan(200);
    // A shown signal's quads are as they were built (a T junction's blank walk head stays blank).
    priv.signalSlots.forEach((slot, k) => {
      if (slot.pole.visible) for (let j = slot.first * 2; j < (slot.first + slot.roles.length) * 2; j++) expect(size.array[j], `${k} ${j}`).toBe(whole[j]);
    });
    // Nothing is culled on the hardware tiers' city reach: every quad is back.
    props.cull(at.x, at.z, Infinity, Infinity);
    expect(Array.from(size.array)).toEqual(Array.from(whole));
  });
});

describe('the signals\' glow at night', () => {
  it('a halo on every lens, lit in its colour only round the lens that is lit, at night, and dark round a knocked-over signal', () => {
    const props = new PropsView(W);
    const priv = props as unknown as { signalSlots: Array<{ halo: number; roles: readonly QuadRole[] }>; signalHalos: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>; signalPropIndex: number[]; occUniforms: Record<string, { value: unknown }> };
    const halos = priv.signalHalos;
    const pos = halos.geometry.getAttribute('position');
    const col = halos.geometry.getAttribute('color');
    const t = 7.3;
    props.update(0, 0, t);
    expect(halos.visible).toBe(false);
    props.update(0, 1, t);
    expect(halos.visible).toBe(true);
    expect(halos.material.customProgramCacheKey()).toBe('gta7-halo-facing');
    // Only toward a camera in front of its lens.
    const lib = THREE.ShaderLib.points;
    const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
    halos.material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('vColor *= smoothstep( -0.15, 0.5, dot( aFacing');
    expect(halos.geometry.getAttribute('aFacing').count).toBe(pos.count);
    // And dissolving with its signal's pole: on the pole's uniforms and axis, from the signal's foot.
    expect(shader.vertexShader).toContain('vColor *= min( smoothstep( uOccFade.x, uOccFade.y, occSegSeg( uOccCam, uOccSubject, occA, occB ) )');
    for (const u of ['uOccCam', 'uOccSubject', 'uOccFade']) expect(shader.uniforms[u], u).toBe(priv.occUniforms[u]);
    expect((shader.uniforms.uOccSpan as { value: THREE.Vector2 }).value.toArray()).toEqual([OCCLUDER_AXIS.signal.from, OCCLUDER_AXIS.signal.to]);
    const feet = halos.geometry.getAttribute('aFoot');
    expect(feet.count).toBe(pos.count);
    let lit = 0;
    signals.forEach((p, i) => {
      const slot = priv.signalSlots[i]!;
      const state = roads.signalState(p.node, axisOf(p.dir as Dir), t);
      signalLayout(signalStyle(roads, p)).heads.forEach((_, head) => {
        for (let k = 0; k < 3; k++) {
          const v = slot.halo + head * 3 + k;
          expect(new THREE.Vector3(pos.getX(v), pos.getY(v), pos.getZ(v)).distanceTo(props.signalLens(i, head, k).at)).toBeLessThan(1e-4);
          expect([feet.getX(v), feet.getY(v), feet.getZ(v)]).toEqual([p.x, p.y, p.z].map(Math.fround));
          const on = ['red', 'yellow', 'green'][k] === state;
          const c = [col.getX(v), col.getY(v), col.getZ(v)];
          if (!on) expect(c).toEqual([0, 0, 0]);
          else {
            lit++;
            // Its own colour's channel leads.
            expect(Math.max(...c)).toBe(c[k === 2 ? 1 : 0]);
          }
        }
      });
    });
    expect(lit).toBeGreaterThan(signals.length);
    const k = 5;
    props.breakProp(priv.signalPropIndex[k]!, 0, 1);
    props.update(0, 1, t);
    const slot = priv.signalSlots[k]!;
    for (let v = slot.halo; v < slot.halo + 3 * signalLayout(signalStyle(roads, signals[k]!)).heads.length; v++) expect([col.getX(v), col.getY(v), col.getZ(v)]).toEqual([0, 0, 0]);
    props.restoreAll();
    props.update(0, 1, t);
    expect([0, 1, 2].some((j) => col.getX(slot.halo + j) + col.getY(slot.halo + j) > 0)).toBe(true);
  });
});
