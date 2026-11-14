// The street's ground detail, render-only: grass verges in front of the house lots, tactile pads where the crossings land,
// cast-iron grates round the sidewalk trees, the kerbs of the quays and the county roads' mouths (render/city/verges.ts,
// ground.ts, roads.ts, surfaces.ts). They stay on the drawn sidewalks, clear of the walking lines, the crossings and one
// another, and the tyres roar on a verge as on any lawn.

import { describe, expect, it } from 'vitest';
import { softGroundRects } from '../../src/audio/audio';
import { quayKerb, TACTILE_TO, tactilePads } from '../../src/render/city/ground';
import { gratedTrees, TREE_GRATE_HALF, treeGrate } from '../../src/render/city/roads';
import { decodeKerb, KERB_DECODE_GLSL, padKerb } from '../../src/render/city/surfaces';
import { KERBSTONE_W, LAWN_OVERHANG, VERGE_FROM, VERGE_TO, vergesOf } from '../../src/render/city/verges';
import { GeoBuilder } from '../../src/render/geo';
import { CROSSWALK_W, CURB_H, PED_INSET, SIDEWALK_W } from '../../src/world/constants';
import { mkRect, rectContains, rectsMinus, rectsOverlap, waterAt, type Block, type Rect } from '../../src/world/layout';
import { world } from './helpers';

const blockOf = (blocks: readonly Block[], r: Rect): Block | undefined =>
  blocks.find((b) => r.minX >= b.rect.minX - 1e-6 && r.maxX <= b.rect.maxX + 1e-6 && r.minZ >= b.rect.minZ - 1e-6 && r.maxZ <= b.rect.maxZ + 1e-6);

/** Distance (m) in from the nearest kerb of the block's rectangle. */
const inFrom = (b: Block, x: number, z: number): number => Math.min(x - b.rect.minX, b.rect.maxX - x, z - b.rect.minZ, b.rect.maxZ - z);

describe('grass verges', () => {
  const layout = world().layout;
  const verges = vergesOf(layout);

  it('run in front of the house lots of Hillcrest and Westside, between the kerbstones and the footpath', () => {
    expect(verges.length).toBeGreaterThan(100);
    const districts = new Set<string>();
    for (const v of verges) {
      const b = blockOf(layout.blocks, v.rect)!;
      expect(b, JSON.stringify(v.rect)).toBeDefined();
      districts.add(b.district);
      // The strip's inner face is VERGE_FROM from the kerb, its outer face VERGE_TO: the kerbstones stay paved.
      const across = Math.min(v.rect.maxX - v.rect.minX, v.rect.maxZ - v.rect.minZ);
      expect(across).toBeCloseTo(VERGE_TO - VERGE_FROM, 6);
      expect(inFrom(b, v.rect.minX, v.rect.minZ)).toBeGreaterThanOrEqual(VERGE_FROM - 1e-6);
      expect(inFrom(b, v.rect.maxX, v.rect.maxZ)).toBeGreaterThanOrEqual(VERGE_FROM - 1e-6);
      // A yard lies behind it, across the sidewalk.
      const yard = layout.ground.some((g) => g.kind === 'yard' && blockOf(layout.blocks, g.rect) === b && (v.rect.maxX - v.rect.minX > v.rect.maxZ - v.rect.minZ ? g.rect.minX <= v.rect.minX + 1e-6 && g.rect.maxX >= v.rect.maxX - 1e-6 : g.rect.minZ <= v.rect.minZ + 1e-6 && g.rect.maxZ >= v.rect.maxZ - 1e-6));
      expect(yard).toBe(true);
    }
    expect([...districts].sort()).toEqual(['hillcrest', 'westside']);
  });

  it('leave the walking lines and the crossings paved', () => {
    // People walk PED_INSET in from the kerb; half a body's width stays on the footpath.
    expect(VERGE_TO).toBeLessThanOrEqual(PED_INSET - 0.3);
    for (const v of verges) {
      const b = blockOf(layout.blocks, v.rect)!;
      const alongX = v.rect.maxX - v.rect.minX > v.rect.maxZ - v.rect.minZ;
      const a0 = alongX ? v.rect.minX - b.rect.minX : v.rect.minZ - b.rect.minZ;
      const a1 = alongX ? b.rect.maxX - v.rect.maxX : b.rect.maxZ - v.rect.maxZ;
      expect(Math.min(a0, a1), JSON.stringify(v.rect)).toBeGreaterThanOrEqual(CROSSWALK_W);
    }
    // No two verges overlap (neighbouring lots' verges meet end to end).
    for (let i = 0; i < verges.length; i++) {
      for (let j = i + 1; j < verges.length; j++) {
        const a = verges[i]!.rect;
        const c = verges[j]!.rect;
        const overlap = Math.min(a.maxX, c.maxX) - Math.max(a.minX, c.minX) > 1e-6 && Math.min(a.maxZ, c.maxZ) - Math.max(a.minZ, c.minZ) > 1e-6;
        expect(overlap).toBe(false);
      }
    }
  });

  it('fray only on the footpath side, by at most LAWN_OVERHANG', () => {
    for (const v of verges) {
      const r = v.rect;
      const [x0, z0, x1, z1] = v.edge;
      // Signed distance inside the edge rectangle at each side's midpoint: one side frays (-LAWN_OVERHANG), the rest are well inside.
      const mids = [
        Math.min(r.minX - x0, x1 - r.minX),
        Math.min(r.maxX - x0, x1 - r.maxX),
        Math.min(r.minZ - z0, z1 - r.minZ),
        Math.min(r.maxZ - z0, z1 - r.maxZ),
      ];
      expect(mids.filter((f) => Math.abs(f + LAWN_OVERHANG) < 1e-6)).toHaveLength(1);
      expect(mids.filter((f) => f >= 0.99)).toHaveLength(3);
      // The fraying side faces the footpath: the side further from the kerb.
      const b = blockOf(layout.blocks, r)!;
      const k = mids.findIndex((f) => Math.abs(f + LAWN_OVERHANG) < 1e-6);
      const side = [r.minX, r.maxX, r.minZ, r.maxZ][k]!;
      const at = k < 2 ? inFrom(b, side, (r.minZ + r.maxZ) / 2) : inFrom(b, (r.minX + r.maxX) / 2, side);
      expect(at).toBeCloseTo(VERGE_TO, 6);
    }
  });
});

describe('tree grates', () => {
  const w = world();
  const layout = w.layout;
  const grated = gratedTrees(layout, w.roads);
  const verges = vergesOf(layout);
  const pads = tactilePads(layout, w.roads);

  it('sit under every sidewalk tree whose grate fits behind the kerbstones, outside a verge and clear of the tactile pads', () => {
    expect(grated.length).toBeGreaterThan(150);
    const square = (t: { x: number; z: number }) => mkRect(t.x - TREE_GRATE_HALF, t.z - TREE_GRATE_HALF, t.x + TREE_GRATE_HALF, t.z + TREE_GRATE_HALF);
    for (const t of grated) {
      const b = layout.blocks.find((k) => rectContains(k.rect, t.x, t.z))!;
      const d = inFrom(b, t.x, t.z);
      expect(d - TREE_GRATE_HALF).toBeGreaterThanOrEqual(KERBSTONE_W);
      expect(d + TREE_GRATE_HALF).toBeLessThanOrEqual(SIDEWALK_W);
      expect(verges.some((v) => rectContains(v.rect, t.x, t.z))).toBe(false);
      // A grate and a pad are both a centimetre over the paving: they must never share ground.
      expect(pads.some((p) => rectsOverlap(p.rect, square(t)))).toBe(false);
      expect(layout.props.some((p) => (p.kind === 'tree' || p.kind === 'palm') && p.x === t.x && p.z === t.z)).toBe(true);
    }
    // Every other sidewalk tree is left out for one of those reasons, none for another.
    for (const p of layout.props) {
      if (p.kind !== 'tree' && p.kind !== 'palm') continue;
      const b = layout.blocks.find((k) => rectContains(k.rect, p.x, p.z));
      if (!b || grated.some((t) => t.x === p.x && t.z === p.z)) continue;
      const d = inFrom(b, p.x, p.z);
      const reason = d - TREE_GRATE_HALF < KERBSTONE_W || d + TREE_GRATE_HALF > SIDEWALK_W || verges.some((v) => rectContains(v.rect, p.x, p.z)) || pads.some((t) => rectsOverlap(t.rect, square(p)));
      expect(reason, `${p.kind} at ${p.x},${p.z}`).toBe(true);
    }
    // Hillcrest's street trees stand in its verges.
    const hill = layout.props.filter((p) => p.kind === 'tree' && layout.blocks.some((k) => k.district === 'hillcrest' && rectContains(k.rect, p.x, p.z) && inFrom(k, p.x, p.z) < 2));
    expect(hill.filter((p) => verges.some((v) => rectContains(v.rect, p.x, p.z))).length).toBeGreaterThan(hill.length / 2);
  });

  it('keep clear of the lamps, hydrants, benches and bins beside them', () => {
    for (const t of grated) {
      for (const p of layout.props) {
        if (p.kind !== 'lamp' && p.kind !== 'hydrant' && p.kind !== 'bench' && p.kind !== 'bin') continue;
        expect(Math.max(Math.abs(p.x - t.x), Math.abs(p.z - t.z)), `${p.kind} at ${p.x},${p.z}`).toBeGreaterThan(TREE_GRATE_HALF + 0.2);
      }
    }
  });

  it('are 17 flush quads within the grate, above the paving', () => {
    const g = new GeoBuilder(true);
    treeGrate(g, 10, -4, CURB_H);
    const geo = g.build();
    expect(geo.index!.count / 6).toBe(17);
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      expect(Math.abs(pos.getX(i) - 10)).toBeLessThanOrEqual(TREE_GRATE_HALF + 1e-6);
      expect(Math.abs(pos.getZ(i) + 4)).toBeLessThanOrEqual(TREE_GRATE_HALF + 1e-6);
      expect(pos.getY(i) - CURB_H).toBeGreaterThanOrEqual(0.009 - 1e-6);
      expect(pos.getY(i) - CURB_H).toBeLessThanOrEqual(0.0125);
    }
  });
});

describe('tactile pads', () => {
  const w = world();
  const layout = w.layout;
  const pads = tactilePads(layout, w.roads);
  const verges = vergesOf(layout);

  it('lie behind the kerbstones at both ends of the zebra crossings, on a sidewalk that is drawn', () => {
    // Drawn sidewalk: a block's ring, or the promenade's ring outside the city short of the water and the county roads' mouths.
    const b = layout.bounds;
    const ring = rectsMinus(
      [
        mkRect(b.cityMinX - SIDEWALK_W, b.cityMinZ - SIDEWALK_W, b.cityMaxX + SIDEWALK_W, b.cityMinZ),
        mkRect(b.cityMinX - SIDEWALK_W, b.cityMaxZ, b.cityMaxX + SIDEWALK_W, b.cityMaxZ + SIDEWALK_W),
        mkRect(b.cityMinX - SIDEWALK_W, b.cityMinZ, b.cityMinX, b.cityMaxZ),
        mkRect(b.cityMaxX, b.cityMinZ, b.cityMaxX + SIDEWALK_W, b.cityMaxZ),
      ],
      [...layout.water.flatMap((wt) => wt.rects), ...w.roads.mouths],
    );
    const drawn = (x: number, z: number) =>
      layout.blocks.some((k) => rectContains(k.rect, x, z) && inFrom(k, x, z) <= SIDEWALK_W) || (ring.some((r) => rectContains(r, x, z)) && !waterAt(layout, x, z));
    for (const p of pads) for (const [x, z] of [[p.rect.minX, p.rect.minZ], [p.rect.maxX, p.rect.minZ], [p.rect.minX, p.rect.maxZ], [p.rect.maxX, p.rect.maxZ]] as const) expect(drawn(x, z), `${x},${z}`).toBe(true);
    let crossings = 0;
    for (const n of w.roads.gridNodes) crossings += n.neighbors.filter((k) => k >= 0 && k < w.roads.gridNodeCount).length;
    // Most crossings land on two sidewalks; a bridge's or the sea's side has none.
    expect(pads.length).toBeGreaterThan(crossings * 1.5);
    expect(pads.length).toBeLessThanOrEqual(crossings * 2);
    for (const p of pads) {
      const [x0, z0, x1, z1] = p.kerb;
      const at = (x: number, z: number) => Math.abs(Math.min(x - x0, x1 - x, z - z0, z1 - z));
      const cx = (p.rect.minX + p.rect.maxX) / 2;
      const cz = (p.rect.minZ + p.rect.maxZ) / 2;
      // Across: from just behind the kerbstones to TACTILE_TO; along: the crossing's width, short of its ends.
      const across = Math.min(p.rect.maxX - p.rect.minX, p.rect.maxZ - p.rect.minZ);
      const along = Math.max(p.rect.maxX - p.rect.minX, p.rect.maxZ - p.rect.minZ);
      expect(across).toBeCloseTo(TACTILE_TO - KERBSTONE_W - 0.04, 6);
      expect(along).toBeCloseTo(CROSSWALK_W - 0.8, 6);
      expect(at(cx, cz)).toBeGreaterThan(KERBSTONE_W);
      expect(at(cx, cz)).toBeLessThan(TACTILE_TO);
      // On a block's sidewalk or the promenade ring, never in a verge.
      expect(verges.some((v) => rectContains(v.rect, cx, cz))).toBe(false);
    }
  });
});

describe('the kerb rectangle the sidewalk shader reads', () => {
  it('is decoded on the CPU as the shader decodes it: a pad reversed, every other strip as it is', () => {
    expect(KERB_DECODE_GLSL).toContain('bool pad = vGround.x > vGround.z;');
    expect(KERB_DECODE_GLSL).toContain('vec4 kr = pad ? vGround.zwxy : vGround;');
    const k: [number, number, number, number] = [-40, 12, 38, 90];
    expect(decodeKerb(padKerb(k))).toEqual({ pad: true, kerb: k });
    expect(decodeKerb(k)).toEqual({ pad: false, kerb: k });
    // A quay's far sides keep minX < maxX, so it never reads as a pad.
    expect(decodeKerb([-40 - 1e4, 12, 38, 90 + 1e4]).pad).toBe(false);
  });
});

describe('quays and mouths', () => {
  const w = world();
  const layout = w.layout;
  const roads = w.roads;
  const roadRects: Rect[] = [...roads.segments, ...roads.live.map((nd) => mkRect(nd.x - nd.halfX, nd.z - nd.halfZ, nd.x + nd.halfX, nd.z + nd.halfZ))];

  it("a quay's kerbs are its sides along a road; its sides at the water or another strip are pushed far out", () => {
    const b = layout.bounds;
    const paved = [...roadRects, ...layout.blocks.map((bl) => bl.rect)];
    let kerbs = 0;
    let far = 0;
    for (const wt of layout.water) {
      const inside = wt.area.map((r) => mkRect(Math.max(r.minX, b.cityMinX), Math.max(r.minZ, b.cityMinZ), Math.min(r.maxX, b.cityMaxX), Math.min(r.maxZ, b.cityMaxZ)));
      for (const r of rectsMinus(inside, [...wt.rects, ...paved])) {
        const k = quayKerb(r, roadRects);
        const sides = [
          [k[0], r.minX, mkRect(r.minX - 0.05, r.minZ + 0.05, r.minX, r.maxZ - 0.05)],
          [k[1], r.minZ, mkRect(r.minX + 0.05, r.minZ - 0.05, r.maxX - 0.05, r.minZ)],
          [k[2], r.maxX, mkRect(r.maxX, r.minZ + 0.05, r.maxX + 0.05, r.maxZ - 0.05)],
          [k[3], r.maxZ, mkRect(r.minX + 0.05, r.maxZ, r.maxX - 0.05, r.maxZ + 0.05)],
        ] as const;
        for (const [kept, own, beyond] of sides) {
          const road = roadRects.some((q) => rectsOverlap(q, beyond));
          expect(kept === own, `${JSON.stringify(r)}`).toBe(road);
          if (road) kerbs++;
          else far++;
        }
      }
    }
    expect(kerbs).toBeGreaterThan(5);
    expect(far).toBeGreaterThan(kerbs);
  });

  it("a county road's mouth runs through the promenade: no tactile pad lands in one", () => {
    const pads = tactilePads(layout, roads);
    expect(roads.mouths.length).toBeGreaterThan(0);
    for (const m of roads.mouths) for (const p of pads) expect(rectsOverlap(m, p.rect)).toBe(false);
  });
});

describe('tyres on the verges', () => {
  const layout = world().layout;
  const soft = softGroundRects(layout);

  it('roar as on a lawn on every verge, and as on paving on the footpath beside it', () => {
    for (const v of vergesOf(layout)) {
      const cx = (v.rect.minX + v.rect.maxX) / 2;
      const cz = (v.rect.minZ + v.rect.maxZ) / 2;
      expect(soft.some((r) => rectContains(r, cx, cz))).toBe(true);
      // The footpath half a metre past the verge's outer face is paving.
      const b = layout.blocks.find((k) => rectContains(k.rect, cx, cz))!;
      const alongX = v.rect.maxX - v.rect.minX > v.rect.maxZ - v.rect.minZ;
      const outward = alongX ? (cz - b.rect.minZ < b.rect.maxZ - cz ? 1 : -1) : cx - b.rect.minX < b.rect.maxX - cx ? 1 : -1;
      const fx = alongX ? cx : cx + outward * (VERGE_TO - VERGE_FROM);
      const fz = alongX ? cz + outward * (VERGE_TO - VERGE_FROM) : cz;
      expect(soft.some((r) => rectContains(r, fx, fz)), `${fx},${fz}`).toBe(false);
    }
  });
});
