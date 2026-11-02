// Las Lomas County's roadside oddities (world/country/oddities.ts): the telephone poles stand clear of every road, junction
// mouth, drive, the town and each other, their wires hang clear over the road, and every pole is solid; the statics, the
// mailboxes and the signs stand on the county's own land in the open, clear of roads, plots and one another.

import { describe, expect, it } from 'vitest';
import { COUNTRY_ROADS, onCountyLand, plotAt } from '../../src/world/country';
import { FIRE_ROAD } from '../../src/world/country/hills';
import { insulator, inFrame, isMown, ODDITY_CLEAR, POLE, ROADSIDE, SIGN_TEXT, sagAt } from '../../src/world/country/oddities';
import { blocksCamera, makeRayHit, type StaticCollider } from '../../src/world/colliders';
import { mkRect, rectContains, rectsOverlap, type Rect } from '../../src/world/layout';
import { rectClearance, roadClearance } from './farm_helpers';
import { world } from './helpers';

const W = world();
const L = W.layout;
const country = L.country;
const odd = country.oddities;

/** The shortest distance (m) from (x, z) to the segment (ax, az)-(bx, bz). */
function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}

describe('the telephone poles', () => {
  it('line the county roads on its land, flat and dry, clear of the town, off the causeway and the bridge', () => {
    // Not a ceiling on how many: a farm or a place added to the county may have poles of its own.
    expect(odd.poles.length).toBeGreaterThan(45);
    for (const p of odd.poles) {
      const at = `pole at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`;
      expect(onCountyLand(country, p.x, p.z), at).toBe(true);
      expect(p.x, `${at} off the causeway and the bridge`).toBeLessThanOrEqual(-712);
      expect(rectContains(country.plots.find((q) => q.id === 'drycreek')!.rect, p.x, p.z), `${at} in town`).toBe(false);
      // Flat: the ground is level a couple of metres round its foot, and the pole stands on it; dry: not under the sea or a creek.
      expect(p.y, at).toBe(0);
      for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) expect(W.groundHeight(p.x + dx, p.z + dz), `${at} level`).toBe(0);
      expect(W.waterDepth(p.x, p.z), `${at} dry`).toBeLessThan(0);
    }
    // Poles of every county road but the causeway, whose stretch on the land is a single span of the highway's.
    const per = COUNTRY_ROADS.map((r) => odd.poles.filter((p) => segDistToRoad(p.x, p.z, r.pts) < r.width / 2 + POLE.off + 0.5).length);
    expect(per.filter((n) => n > 8).length).toBeGreaterThanOrEqual(3);
  });

  it('extend to the valley\'s roads, the Pass Road and the Valley Loop, and stay out of the lake\'s and the farms\' drives', () => {
    const inValley = odd.poles.filter((q) => q.x < -1560);
    expect(inValley.length).toBeGreaterThan(50);
    // The loop's 2.4 km take one every 40 m but where a junction, a drive or a lane's mouth is; the pass road's stretch across the ridge is the county's.
    for (const [name, most] of [['Valley Loop', 40], ['Coyote Pass Road', 6]] as const) {
      const road = COUNTRY_ROADS.find((r) => r.name === name)!;
      const along = odd.poles.filter((q) => segDistToRoad(q.x, q.z, road.pts) < road.width / 2 + POLE.off + 0.5);
      expect(along.length, name).toBeGreaterThanOrEqual(most);
    }
    // None within reach of a lane's mouth or a drive, in the valley as elsewhere.
    for (const q of inValley) for (const a of country.approaches) expect(rectContains(a.rect, q.x, q.z, a.pad), `pole at ${q.x.toFixed(1)}, ${q.z.toFixed(1)}`).toBe(false);
  });

  it(`stand ${POLE.off} m off the road's edge, never in a junction's mouth or within reach of an approach: a farm's drive, sign or mailbox, the drive-in's or Gravel Gulch's drive, the fire road's turn-off`, () => {
    for (const p of odd.poles) {
      const at = `pole at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`;
      expect(roadClearance(p.x, p.z), at).toBeGreaterThan(POLE.off - 0.5);
      for (const v of country.graph.vertices) if (v.half > 0) expect(Math.max(Math.abs(p.x - v.x), Math.abs(p.z - v.z)) - v.half, `${at} by junction ${v.id}`).toBeGreaterThanOrEqual(POLE.clear);
      for (const a of country.approaches) expect(rectContains(a.rect, p.x, p.z, a.pad), `${at} by an approach at ${a.rect.minX}, ${a.rect.minZ}`).toBe(false);
    }
    // Every drive the county has is on the list the poles keep off, whoever added it.
    const listed = (x: number, z: number) => country.approaches.some((a) => rectContains(a.rect, x, z));
    for (const f of country.farms.farmsteads) {
      const [ax, az, bx, bz] = f.drive;
      for (const [x, z] of [[ax, az], [bx, bz], [f.sign.x, f.sign.z], [f.mailbox.x, f.mailbox.z]] as const) expect(listed(x, z), `${f.id}'s drive, sign or mailbox`).toBe(true);
    }
    for (const d of [country.places.driveIn.drive, country.places.track.drive]) expect(listed(d.minX, d.minZ) && listed(d.maxX, d.maxZ), 'a place\'s drive').toBe(true);
    expect(listed(...FIRE_ROAD[0]!), 'the fire road\'s turn-off').toBe(true);
    // The valley's: the vineyard's and the ranch's drives with their signs, gate and mailboxes, and the lake's and the wood's lanes where they leave the loop, with their signs.
    const farm = country.valley;
    for (const e of [farm.vineyard.winery, farm.ranch]) {
      const [ax, az, bx, bz] = e.drive;
      for (const [x, z] of [[ax, az], [bx, bz], [e.mailbox.x, e.mailbox.z]] as const) expect(listed(x, z), 'a valley farm\'s drive or mailbox').toBe(true);
    }
    expect(listed(farm.vineyard.winery.sign.x, farm.vineyard.winery.sign.z), 'the winery\'s sign').toBe(true);
    expect(listed(farm.ranch.gate.x, farm.ranch.gate.z), 'the ranch\'s gate').toBe(true);
    expect(country.lakeland.lanes.length).toBeGreaterThan(3);
    for (const lane of country.lakeland.lanes) expect(listed(lane.pts[0]!, lane.pts[1]!), 'a lane\'s mouth').toBe(true);
    for (const s of country.lakeland.signs) expect(listed(s.x, s.z), `the ${s.id} sign`).toBe(true);
  });

  it('keep clear of every other prop, building, hedge and solid of the county, and stand on its ground', () => {
    const near = (x: number, z: number, r: number) => (c: { minX: number; minZ: number; maxX: number; maxZ: number }) => x > c.minX - r && x < c.maxX + r && z > c.minZ - r && z < c.maxZ + r;
    for (const p of odd.poles) {
      for (const q of L.props.slice(country.firstProp)) expect(Math.hypot(p.x - q.x, p.z - q.z), `${q.kind} at ${q.x}, ${q.z}`).toBeGreaterThan(ODDITY_CLEAR - 0.5);
      for (const r of [...odd.solids.filter((s) => s.tag !== 'rock' || !s.round || s.y1 - s.y0 !== POLE.h).map((s) => s.rect), ...odd.pads]) expect(near(p.x, p.z, 1)(r), `an oddity at ${r.minX}, ${r.minZ}`).toBe(false);
      for (const b of L.buildings.filter((b) => b.district === 'country')) expect(near(p.x, p.z, 2)(b.rect), 'a building').toBe(false);
      for (const h of country.farms.hedges) expect(near(p.x, p.z, 1)(h), 'a hedge').toBe(false);
      // The only collider within a pole's own width is its own, a round one the pole's size, and it is solid.
      const found: StaticCollider[] = [];
      W.grid.query(p.x - POLE.base, p.z - POLE.base, p.x + POLE.base, p.z + POLE.base, (c) => {
        if (c.minX < p.x + POLE.base && c.maxX > p.x - POLE.base && c.minZ < p.z + POLE.base && c.maxZ > p.z - POLE.base) found.push(c);
      });
      expect(found.map((c) => [c.tag, c.circle, c.cx, c.cz]), `colliders at ${p.x}, ${p.z}`).toEqual([['rock', true, p.x, p.z]]);
      expect(found[0]!.r).toBeCloseTo(POLE.base, 9);
      expect(W.isFree(p.x, p.z, POLE.base - 0.01), 'the pole is solid').toBe(false);
      expect(W.groundHeight(p.x, p.z)).toBeCloseTo(p.y, 9);
    }
    const spacing = odd.poles.flatMap((p, i) => odd.poles.slice(i + 1).map((q) => Math.hypot(p.x - q.x, p.z - q.z)));
    expect(Math.min(...spacing)).toBeGreaterThan(POLE.gap * 0.6);
  });

  it('are solid and see-through (rocks, which camera, sight and shots pass), the height of the pole, appended after the places\' solids', () => {
    const poles = odd.solids.filter((s) => s.tag === 'rock' && s.round && s.y1 - s.y0 === POLE.h);
    expect(poles.length).toBe(odd.poles.length);
    const cs = W.grid.colliders;
    // The oddities' colliders are the last of the grid's, in order, and none of them breaks.
    const first = cs.length - odd.solids.length;
    expect(first).toBeGreaterThan(4000);
    for (const [k, s] of odd.solids.entries()) {
      const c = cs[first + k]!;
      expect([c.tag, c.circle, c.breakable, c.y0, c.y1]).toEqual([s.tag, s.round === true, false, s.y0, s.y1]);
    }
  });

  it('let a man\'s sight, a bullet and the camera\'s ray through at head height, where a bus stops all three', () => {
    const hit = makeRayHit();
    for (const p of odd.poles) {
      const at = `pole at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`;
      // A line across the pole's middle, 3 m each side of it: it does cross the pole, and nothing of the pole stops it.
      expect(W.grid.raycast(p.x - 3, 1.6, p.z, 1, 0, 0, 6, hit, () => true), `${at} is crossed`).toBe(true);
      expect(W.lineOfSight(p.x - 3, 1.6, p.z, p.x + 3, 1.6, p.z), `${at} sight`).toBe(true);
      expect(W.grid.raycast(p.x - 3, 1.6, p.z, 1, 0, 0, 6, hit, blocksCamera), `${at} camera`).toBe(false);
    }
    const bus = odd.statics.find((p) => p.kind === 'bus')!;
    expect(W.lineOfSight(bus.x - 8, 1.5, bus.z, bus.x + 8, 1.5, bus.z), 'sight through the bus').toBe(false);
    expect(W.grid.raycast(bus.x - 8, 1.5, bus.z, 1, 0, 0, 16, hit, blocksCamera), 'camera through the bus').toBe(true);
  });
});

describe('the wires', () => {
  it('string every pole to the next of its road within the span a wire may reach, none across a junction two poles wide', () => {
    expect(odd.spans.length).toBeGreaterThan(odd.poles.length * 0.7);
    for (const s of odd.spans) {
      const a = odd.poles[s.a]!;
      const b = odd.poles[s.b]!;
      const len = Math.hypot(a.x - b.x, a.z - b.z);
      expect(len, `span ${s.a}-${s.b}`).toBeLessThanOrEqual(POLE.maxSpan);
      expect(len).toBeGreaterThan(POLE.gap * 0.6);
    }
  });

  it('hang as a catenary, 5 m and more over the ground at the middle of the longest span', () => {
    expect(sagAt(40, 0)).toBeCloseTo(0, 9);
    expect(sagAt(40, 1)).toBeCloseTo(0, 9);
    // About L^2 / (8 c) at mid-span, symmetric about it.
    expect(sagAt(40, 0.5)).toBeCloseTo(40 ** 2 / (8 * POLE.sag), 1);
    expect(sagAt(40, 0.3)).toBeCloseTo(sagAt(40, 0.7), 9);
    for (const s of odd.spans) {
      const a = odd.poles[s.a]!;
      const b = odd.poles[s.b]!;
      const len = Math.hypot(a.x - b.x, a.z - b.z);
      for (let k = 0; k < POLE.wires.length; k++) {
        const [, ay] = insulator(a, k);
        expect(ay - sagAt(len, 0.5), `span ${s.a}-${s.b}`).toBeGreaterThan(5);
      }
    }
  });
});

/** The distance (m) from a point to a road's centre line. */
function segDistToRoad(x: number, z: number, pts: readonly number[]): number {
  let best = Infinity;
  for (let k = 2; k < pts.length; k += 2) best = Math.min(best, segDist(x, z, pts[k - 2]!, pts[k - 1]!, pts[k]!, pts[k + 1]!));
  return best;
}

describe('the static oddities', () => {
  const placed = (kind: string) => odd.statics.filter((p) => p.kind === kind);
  /** Each static oddity's solids, a rectangle each (a round one by its square). */
  const solidsOf = (p: { x: number; z: number }) => odd.solids.filter((s) => s.tag !== 'rock' || !s.round || s.y1 - s.y0 !== POLE.h).filter((s) => rectContains(mkRect(p.x - 12, p.z - 12, p.x + 12, p.z + 12), s.rect.minX, s.rect.minZ));

  it('are one cow and her stand, the diner sign, Bigfoot and his plaque, a pickup, a bus, the hives and the payphone', () => {
    expect(odd.statics.map((p) => p.kind)).toEqual(['cow', 'stand', 'diner', 'bigfoot', 'plaque', 'pickup', 'bus', 'hives', 'payphone']);
  });

  it('stand in the open on the county\'s land: off every plot, building, hedge and road, clear of each other and of every older solid', () => {
    const rects: Array<{ what: string; r: Rect }> = odd.solids.filter((s) => !(s.tag === 'rock' && s.round && s.y1 - s.y0 === POLE.h)).map((s) => ({ what: `${s.tag} solid at ${s.rect.minX.toFixed(1)}, ${s.rect.minZ.toFixed(1)}`, r: s.rect }));
    expect(rects.length).toBe(12);
    for (const { what, r } of rects) {
      for (const [x, z] of [[r.minX, r.minZ], [r.maxX, r.maxZ]] as const) {
        expect(onCountyLand(country, x, z), what).toBe(true);
        expect(plotAt(country, x, z)?.kind ?? 'open', what).not.toMatch(/town|farm|venue/);
      }
      expect(rectClearance(r), `${what} off the roads`).toBeGreaterThanOrEqual(2);
      for (const b of L.buildings.filter((b) => b.district === 'country')) expect(rectsOverlap(b.rect, r), `${what} in a building`).toBe(false);
      for (const h of country.farms.hedges) expect(rectsOverlap(h, r), `${what} in a hedge`).toBe(false);
      // Not on a ramp's run-out either (fix_progress_world keeps every solid off them), nor in water.
      expect(W.waterDepth((r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2), what).toBeLessThan(0);
    }
    for (const [i, a] of rects.entries()) for (const b of rects.slice(i + 1)) if (a.what.split(' ')[0] !== 'rock') expect(rectsOverlap(a.r, b.r) && a.r !== b.r && Math.hypot(a.r.minX - b.r.minX, a.r.minZ - b.r.minZ) > 0.1, `${a.what} and ${b.what}`).toBe(false);
    // And clear of the older county's props and the places' solids.
    for (const p of L.props.slice(country.firstProp, odd.firstProp)) for (const { what, r } of rects) expect(rectContains(r, p.x, p.z, 0.3), `${p.kind} in ${what}`).toBe(false);
    for (const s of country.places.solids) for (const { what, r } of rects) expect(rectsOverlap(s.rect, r), `${what} in a place's solid`).toBe(false);
  });

  it('keep every solid off the ground it stands at its own height, so the farm cow is a cow and the bus a bus', () => {
    const cow = placed('cow')[0]!;
    const [deck, tongue] = solidsOf(cow);
    expect(deck!.y1 - deck!.y0).toBeGreaterThan(5.5);
    expect(tongue!.y1).toBeLessThan(1.2);
    // Her trailer lies along the road she faces: east, 12 m off the highway's south edge.
    expect(deck!.rect.maxX - deck!.rect.minX).toBeGreaterThan(8);
    expect(deck!.rect.minZ - 276).toBeGreaterThan(9);
    const bus = solidsOf(placed('bus')[0]!)[0]!;
    expect(bus.rect.maxX - bus.rect.minX).toBeGreaterThan(10);
    expect(bus.y1).toBeGreaterThan(3);
  });

  it('lay Bigfoot\'s gravel pull-off against the highway\'s west leg, his statue and plaque on it, clear of the ridge\'s foot', () => {
    expect(odd.pads.length).toBe(1);
    const pad = odd.pads[0]!;
    expect(pad.maxX).toBeLessThan(-1338);
    for (const p of [...placed('bigfoot'), ...placed('plaque')]) expect(rectContains(pad, p.x, p.z), p.kind).toBe(true);
    // The rises are flat 12 m off the road's edge: so is all the pad.
    for (const [x, z] of [[pad.minX, pad.minZ], [pad.minX, pad.maxZ]] as const) expect(W.baseGround(x, z)).toBe(0);
    expect(rectClearance(pad)).toBeGreaterThanOrEqual(0);
  });

  it('put the payphone alone, 20 m north of Hollister Lane\'s northmost straight, its answering spot in front of it, free to stand on', () => {
    const ph = odd.payphone;
    const lane = COUNTRY_ROADS[2]!;
    expect(ph.z).toBeLessThan(-520 - 15);
    expect(roadClearance(ph.x, ph.z)).toBeGreaterThan(12);
    expect(lane.name).toBe('Hollister Lane');
    expect(Math.hypot(ph.at.x - ph.x, ph.at.z - ph.z)).toBeCloseTo(1.3, 9);
    expect(W.isFree(ph.at.x, ph.at.z, 0.4)).toBe(true);
    // Nothing but sea and corn for a quarter of a kilometre.
    for (const p of odd.statics) if (p.kind !== 'payphone') expect(Math.hypot(p.x - ph.x, p.z - ph.z)).toBeGreaterThan(250);
  });
});

describe('the mailboxes and the signs', () => {
  const props = L.props.slice(odd.firstProp).filter((p) => p.kind === 'roadside');

  it('are six mailboxes of six makes (one a fish) across Creek Road from the dairy\'s drive, and three signs', () => {
    expect(props.length).toBe(9);
    expect(props.slice(0, 6).map((p) => ROADSIDE[p.color]!.name).sort()).toEqual(['barn', 'birdhouse', 'churn', 'fish', 'mailbox', 'rusty']);
    expect(props.slice(6).map((p) => ROADSIDE[p.color]!.name)).toEqual(['eggs', 'honey', 'slow']);
    const dairy = country.farms.farmsteads.find((f) => f.id === 'dairy')!;
    for (const p of props.slice(0, 6)) {
      expect(p.x).toBeGreaterThan(-835);
      expect(Math.abs(p.z - dairy.mailbox.z)).toBeLessThan(20);
      // Every one faces the road, give or take a little.
      expect(Math.sin(p.rot)).toBeLessThan(-0.9);
    }
    expect(SIGN_TEXT[6]).toEqual(['FRESH', 'EGGS']);
    expect(SIGN_TEXT[7]).toEqual(['HONEY', '(ASK THE BEES)']);
    expect(SIGN_TEXT[8]).toEqual(['SLOW:', 'KIDS, DOGS, GOATS, GRANDPA']);
  });

  it('stand on the ground at the roadside, clear of the road and of each other, and break like street furniture', () => {
    for (const [i, p] of props.entries()) {
      expect(roadClearance(p.x, p.z), `${ROADSIDE[p.color]!.name}`).toBeGreaterThan(2);
      expect(onCountyLand(country, p.x, p.z)).toBe(true);
      for (const q of props.slice(i + 1)) expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeGreaterThan(2);
      const c = W.grid.colliders[W.propColliders[L.props.indexOf(p)]!]!;
      expect([c.circle, c.breakable, c.propIndex, c.y1 - c.y0, c.r]).toEqual([true, true, L.props.indexOf(p), ROADSIDE[p.color]!.h, ROADSIDE[p.color]!.w / 2]);
      expect(W.breakCollider(c)).toBe(L.props.indexOf(p));
    }
    W.resetBroken();
  });

  it('are as wide to a car as they are across: a sign\'s circle takes in both its posts, so a car clipping one end of the board meets it', () => {
    for (const p of props.slice(6)) {
      const { name, w } = ROADSIDE[p.color]!;
      // The board runs along (cos rot, -sin rot), its posts 0.1 m in from each end and 0.05 m behind it (render/country/roadside.ts).
      for (const s of [-1, 1]) {
        const along = s * (w / 2 - 0.1);
        const x = p.x + Math.cos(p.rot) * along - Math.sin(p.rot) * 0.05;
        const z = p.z - Math.sin(p.rot) * along - Math.cos(p.rot) * 0.05;
        expect(W.isFree(x, z, 0.05), `${name}'s post at ${along}`).toBe(false);
      }
    }
  });
});

describe('the crop circle', () => {
  const cc = odd.cropCircle;
  const field = country.farms.fields[cc.field]!;

  it('is mown into the wheat of Halfmoon Acres, inside its rectangle, a disc, rings and six discs between them', () => {
    expect(field.crop).toBe('wheat');
    expect(plotAt(country, cc.cx, cc.cz)?.id).toBe('acres');
    for (const [x, z] of [[cc.cx - cc.radius, cc.cz - cc.radius], [cc.cx + cc.radius, cc.cz + cc.radius]] as const) expect(rectContains(field.rect, x, z, -2)).toBe(true);
    expect(cc.mown.length).toBe(10);
    expect(Math.max(...cc.mown.map((m) => Math.hypot(m.cx - cc.cx, m.cz - cc.cz) + m.r1))).toBeLessThanOrEqual(cc.radius + 1e-9);
    expect(isMown(cc, cc.cx, cc.cz)).toBe(true);
    expect(isMown(cc, cc.cx + 13, cc.cz)).toBe(false);
    expect(isMown(cc, cc.cx + 19, cc.cz)).toBe(true);
    expect(isMown(cc, cc.cx + cc.radius + 2, cc.cz)).toBe(false);
    const sat = inFrame({ kind: 'cow', x: cc.cx, z: cc.cz, rot: 0 }, 36, 0);
    expect(isMown(cc, sat.x, sat.z)).toBe(true);
  });
});
