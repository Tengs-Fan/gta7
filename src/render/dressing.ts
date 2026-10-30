// Where the render-only dressing goes: beach things on Ocean Beach, yard things round the houses, railings and
// bollards on the piers, the iron fence round the cemetery, and the furnishing of the enterable garages. Pure placement from the static world (no three.js,
// no sim randomness: hashes of positions), so tests check it directly. None of it is solid: the world's colliders, the
// spawns and the markers never see it, and it keeps clear of every one of them.
import { mkRect, rectContains, rectsOverlap, sandHeight, type Building, type Rect, type Side } from '../world/layout';
import type { StaticWorld } from '../world/staticWorld';
import { places } from '../sim/activities/places';
import { attractionOf } from '../world/attractions';

export type DressingKind =
  | 'umbrella' | 'towel' | 'lounger' | 'lifeguard' | 'volleyball' | 'surfboard'
  | 'fence' | 'mailbox' | 'shrub' | 'planter' | 'wheelie'
  | 'rail' | 'bollard' | 'ironfence'
  | 'workbench' | 'toolwall' | 'shelving' | 'wallshelf' | 'tyres' | 'tyrerack' | 'drum' | 'chest' | 'jack' | 'poster' | 'lamphousing' | 'lamptube';

export type DressingArea = 'beach' | 'yard' | 'deck' | 'garage' | 'cemetery';

export interface DressingItem {
  kind: DressingKind;
  area: DressingArea;
  x: number;
  y: number;
  z: number;
  /** Turn about +y: the model's local +z then points along (sin rot, cos rot). */
  rot: number;
  /** Packed RGB tint (white: the model's own colours). */
  color: number;
  /** Lots: the yard's building id; garages: the garage's index in garageSpecs. */
  owner: number;
  /** Half extents (m) of the footprint along the model's local x and z, for the clearance checks. */
  hx: number;
  hz: number;
  /** Wall-mounted: the origin is the back of the footprint, which stands 2 hz out along the facing. */
  back: boolean;
}

/** Footprint half extents of each kind in its own frame (x across, z along its facing). */
export const DRESSING_SIZE: Readonly<Record<DressingKind, readonly [number, number]>> = {
  umbrella: [1.15, 1.15], towel: [0.4, 0.85], lounger: [0.32, 1.05], lifeguard: [1.35, 1.35], volleyball: [4.7, 0.2], surfboard: [0.28, 0.15],
  fence: [1.0, 0.06], mailbox: [0.12, 0.25], shrub: [0.6, 0.45], planter: [0.3, 0.3], wheelie: [0.31, 0.38],
  rail: [1.2, 0.06], bollard: [0.19, 0.19], ironfence: [1.2, 0.06],
  workbench: [1.0, 0.35], toolwall: [1.0, 0.04], shelving: [0.8, 0.25], wallshelf: [0.8, 0.13], tyres: [0.34, 0.34], tyrerack: [0.84, 0.1],
  drum: [0.3, 0.3], chest: [0.52, 0.25], jack: [0.17, 0.75], poster: [0.62, 0.02], lamphousing: [0.65, 0.13], lamptube: [0.6, 0.08],
};

/** Deterministic 0..1 from integers (the city's own hash, so nothing depends on load order). */
function hash01(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    let k = Math.imul(Math.round(x) | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const PALETTE = [0xe74c3c, 0x2e86c1, 0xf4d03f, 0x27ae60, 0xe67e22, 0x8e44ad, 0x16a085, 0xf06292];

/** World footprint corners of an item. */
export function footprint(it: Pick<DressingItem, 'x' | 'z' | 'rot' | 'hx' | 'hz' | 'back'>): Array<[number, number]> {
  const c = Math.cos(it.rot), s = Math.sin(it.rot);
  const x = it.x + (it.back ? s * it.hz : 0);
  const z = it.z + (it.back ? c * it.hz : 0);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([a, b]) => [x + a * it.hx * c + b * it.hz * s, z - a * it.hx * s + b * it.hz * c]);
}

function rectOf(it: Pick<DressingItem, 'x' | 'z' | 'rot' | 'hx' | 'hz' | 'back'>): Rect {
  const pts = footprint(it);
  return mkRect(Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])));
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-9 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/**
 * What the dressing outside the garages keeps clear of: the drivable roads, the sidewalks' walking lines and the
 * crossings (the pedestrian graph, where pedestrians spawn and walk), parked-car slots, POI markers and bays, the
 * activity places, pickups and collectibles, ramps, garages and every prop's collider.
 */
export class DressingRules {
  private readonly cell = 16;
  private readonly walk = new Map<string, Array<[number, number, number, number]>>();
  private readonly points = new Map<string, Array<[number, number, number, string]>>();
  private readonly rects: Array<[Rect, number, string]> = [];

  constructor(private readonly world: StaticWorld) {
    const L = world.layout;
    const w = world.walk;
    for (const n of w.nodes) {
      for (const e of n.edges) {
        if (e.to < n.id) continue;
        const m = w.nodes[e.to]!;
        this.addSeg(n.x, n.z, m.x, m.z);
      }
    }
    for (const p of L.parking) this.addPoint(p.x, p.z, 3.2, 'parking');
    for (const p of L.pois) {
      this.addPoint(p.x, p.z, 4, `poi ${p.id}`);
      if (p.bay) this.rects.push([p.bay, 1, `bay ${p.id}`]);
    }
    for (const s of L.openSpots) this.addPoint(s.x, s.z, 3, 'pickup');
    L.props.forEach((q, i) => {
      const r = q.kind === 'tree' ? 0.32 * q.scale : q.kind === 'palm' ? 0.3 * q.scale : q.kind === 'bench' ? 0.95 : q.kind === 'container' ? Math.max(q.w, q.d) / 2 : q.kind === 'fountain' ? 3.6 : 0.35;
      this.addPoint(q.x, q.z, r + 0.45, `prop ${i} ${q.kind}`);
    });
    for (const r of L.ramps) {
      const half = Math.max(r.length, r.width) / 2 + 1.5;
      this.rects.push([mkRect(r.x - half, r.z - half, r.x + half, r.z + half), 0, `ramp ${r.id}`]);
    }
    for (const g of L.garages) this.rects.push([g.rect, 1.5, `garage ${g.poi}`]);
    const at = places(world);
    for (const d of at.depots) this.addPoint(d.x, d.z, 6, 'depot');
    this.addPoint(at.hospitalDrop.x, at.hospitalDrop.z, at.hospitalDrop.radius + 1, 'hospital drop');
    this.addPoint(at.courier.x, at.courier.z, at.courier.radius + 1, 'courier');
    this.addPoint(at.exportBoard.x, at.exportBoard.z, 3, 'export board');
    this.addPoint(at.garageMarker.x, at.garageMarker.z, 3, 'garage marker');
    this.addPoint(at.arcade.x, at.arcade.z, 3, 'arcade');
    this.rects.push([at.crane, 1, 'crane'], [at.garageArea, 1, 'safehouse garage'], [at.customsBay, 1, 'customs bay']);
  }

  private key(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  private addSeg(ax: number, az: number, bx: number, bz: number): void {
    const c = this.cell;
    for (let cx = Math.floor(Math.min(ax, bx) / c) - 1; cx <= Math.floor(Math.max(ax, bx) / c) + 1; cx++) {
      for (let cz = Math.floor(Math.min(az, bz) / c) - 1; cz <= Math.floor(Math.max(az, bz) / c) + 1; cz++) {
        const k = this.key(cx, cz);
        let l = this.walk.get(k);
        if (!l) this.walk.set(k, l = []);
        l.push([ax, az, bx, bz]);
      }
    }
  }

  private addPoint(x: number, z: number, r: number, what: string): void {
    const c = this.cell;
    for (let cx = Math.floor((x - r) / c); cx <= Math.floor((x + r) / c); cx++) {
      for (let cz = Math.floor((z - r) / c); cz <= Math.floor((z + r) / c); cz++) {
        const k = this.key(cx, cz);
        let l = this.points.get(k);
        if (!l) this.points.set(k, l = []);
        l.push([x, z, r, what]);
      }
    }
  }

  /** Why an item breaks a rule, or null. Samples its footprint (corners, edge midpoints and centre). */
  violation(it: Pick<DressingItem, 'x' | 'z' | 'rot' | 'hx' | 'hz' | 'back'>): string | null {
    const pts = footprint(it);
    const samples: Array<[number, number]> = [[it.x, it.z], ...pts];
    for (let i = 0; i < 4; i++) samples.push([(pts[i]![0] + pts[(i + 1) % 4]![0]) / 2, (pts[i]![1] + pts[(i + 1) % 4]![1]) / 2]);
    const box = rectOf(it);
    for (const [x, z] of samples) {
      if (this.world.isOnRoad(x, z)) return 'road';
      const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
      for (const [ax, az, bx, bz] of this.walk.get(k) ?? []) if (segDist(x, z, ax, az, bx, bz) < 1.3) return 'walkway';
      for (const [px, pz, r, what] of this.points.get(k) ?? []) if (Math.hypot(x - px, z - pz) < r) return what;
    }
    for (const [r, pad, what] of this.rects) if (rectsOverlap(r, box, pad)) return what;
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Placement

function item(kind: DressingKind, area: DressingArea, x: number, y: number, z: number, rot: number, color = 0xffffff, owner = -1): DressingItem {
  const [hx, hz] = DRESSING_SIZE[kind];
  return { kind, area, x, y, z, rot, color, owner, hx, hz, back: WALL_MOUNTED.has(kind) };
}

/** Ocean Beach: umbrellas with towels and loungers on the dry sand by the boardwalk, nets, and lifeguard towers by the water. */
function beach(world: StaticWorld, rules: DressingRules, out: DressingItem[]): void {
  const b = world.layout.bounds;
  const x0 = b.beachStartX;
  const sand = (x: number) => sandHeight(b, x);
  const add = (it: DressingItem): boolean => {
    if (rules.violation(it)) return false;
    if (world.layout.decks.some((d) => rectsOverlap(d.rect, rectOf(it), 2))) return false;
    // An umbrella's canopy is overhead: only its pole keeps the others off.
    const r = (o: DressingItem) => (o.kind === 'umbrella' ? 0.25 : Math.max(o.hx, o.hz));
    if (out.some((o) => o.area === 'beach' && Math.hypot(o.x - it.x, o.z - it.z) < r(o) + r(it) + 0.3)) return false;
    out.push(it);
    return true;
  };
  // Lifeguard towers by the water every 120 m, each with a surfboard or two stood in the sand.
  for (let z = b.landMinZ + 70, k = 0; z < b.landMaxZ - 60; z += 120, k++) {
    for (let dz = 0; dz < 40; dz += 4) {
      const x = x0 + 31;
      if (!add(item('lifeguard', 'beach', x, sand(x), z + dz, -Math.PI / 2))) continue;
      for (let s = 0; s < 2; s++) {
        const sx = x - 0.4 + s * 0.7;
        add(item('surfboard', 'beach', sx, sand(sx), z + dz + 2.4 + s * 0.5, -Math.PI / 2 + (s - 0.5) * 0.5, PALETTE[(k + s * 3) % PALETTE.length]!));
      }
      break;
    }
  }
  // Two volleyball courts on the dry sand, the nets running across the beach.
  for (const [k, z] of [[0, b.landMinZ + 260], [1, b.landMaxZ - 300]] as const) {
    for (let dz = 0; dz < 60; dz += 6) {
      const x = x0 + 8.5;
      if (add(item('volleyball', 'beach', x, sand(x), z + dz, Math.PI / 2))) break;
    }
    void k;
  }
  for (let z = b.landMinZ + 40, k = 0; z < b.landMaxZ - 40; z += 4.5, k++) {
    const h = hash01(41, k);
    if (h < 0.12) continue;
    // Two loose rows: near the boardwalk and further out.
    const ux = x0 + (k % 2 ? 3.5 : 9) + hash01(42, k) * 3.5;
    const uz = z + (hash01(43, k) - 0.5) * 6;
    const color = PALETTE[Math.floor(hash01(44, k) * PALETTE.length)]!;
    if (!add(item('umbrella', 'beach', ux, sand(ux), uz, hash01(45, k) * 6.28, color))) continue;
    const tx = ux + 0.9 + hash01(46, k) * 0.4;
    add(item('towel', 'beach', tx, sand(tx) + 0.005, uz + 1.6 * (hash01(47, k) < 0.5 ? -1 : 1), (hash01(48, k) - 0.5) * 0.6, PALETTE[Math.floor(hash01(49, k) * PALETTE.length)]!));
    if (hash01(50, k) < 0.55) {
      const lx = ux - 1.2;
      add(item('lounger', 'beach', lx, sand(lx), uz - 1.9, Math.PI / 2 + (hash01(51, k) - 0.5) * 0.4, 0xffffff));
    } else {
      const tx2 = ux - 0.9;
      add(item('towel', 'beach', tx2, sand(tx2) + 0.005, uz + 1.4, (hash01(52, k) - 0.5) * 0.6, PALETTE[Math.floor(hash01(53, k) * PALETTE.length)]!));
    }
  }
}

function sideOutward(side: Side): [number, number] {
  return side === 'N' ? [0, -1] : side === 'S' ? [0, 1] : side === 'E' ? [1, 0] : [-1, 0];
}

/** The house lots: the yard each house stands in and the street side it faces. */
export function houseLots(world: StaticWorld): Array<{ building: Building; lot: Rect; front: Side }> {
  const L = world.layout;
  const out: Array<{ building: Building; lot: Rect; front: Side }> = [];
  for (const b of L.buildings) {
    if (b.style !== 'house' || b.special) continue;
    const yard = L.ground.find((g) => g.kind === 'yard' && rectContains(g.rect, (b.rect.minX + b.rect.maxX) / 2, (b.rect.minZ + b.rect.maxZ) / 2));
    const block = L.blocks.find((bl) => rectContains(bl.lot, (b.rect.minX + b.rect.maxX) / 2, (b.rect.minZ + b.rect.maxZ) / 2));
    if (!yard || !block) continue;
    const lot = yard.rect;
    // The street side: the lot edge on the block's edge, nearest the house.
    const gaps: Array<[Side, number]> = [
      ['N', lot.minZ - block.lot.minZ < 0.5 ? b.rect.minZ - lot.minZ : Infinity],
      ['S', block.lot.maxZ - lot.maxZ < 0.5 ? lot.maxZ - b.rect.maxZ : Infinity],
      ['W', lot.minX - block.lot.minX < 0.5 ? b.rect.minX - lot.minX : Infinity],
      ['E', block.lot.maxX - lot.maxX < 0.5 ? lot.maxX - b.rect.maxX : Infinity],
    ];
    gaps.sort((p, q) => p[1] - q[1]);
    if (!Number.isFinite(gaps[0]![1])) continue;
    out.push({ building: b, lot, front: gaps[0]![0] });
  }
  return out;
}

/** Yards: a fence down one side, a mailbox at the front edge, shrubs and a planter along the front wall, a wheelie bin. */
function yards(world: StaticWorld, rules: DressingRules, out: DressingItem[]): void {
  for (const { building: b, lot, front } of houseLots(world)) {
    const id = b.id;
    const fp = b.rect;
    const [ox, oz] = sideOutward(front);
    // Along the front: +a runs (tx, tz).
    const tx = -oz, tz = ox;
    const facing = Math.atan2(ox, oz);
    const ground = (x: number, z: number) => world.groundHeight(x, z);
    const add = (it: DressingItem): boolean => {
      if (rules.violation(it)) return false;
      const r = rectOf(it);
      if (rectsOverlap(r, fp, 0.15)) return false;
      if (!(r.minX >= lot.minX + 0.05 && r.maxX <= lot.maxX - 0.05 && r.minZ >= lot.minZ + 0.05 && r.maxZ <= lot.maxZ - 0.05)) return false;
      if (world.layout.buildings.some((o) => o !== b && rectsOverlap(o.rect, r, 0.3))) return false;
      out.push(it);
      return true;
    };
    // House front wall line and lot front edge, as distances along the outward axis.
    const wall = front === 'N' ? -fp.minZ : front === 'S' ? fp.maxZ : front === 'E' ? fp.maxX : -fp.minX;
    const edge = front === 'N' ? -lot.minZ : front === 'S' ? lot.maxZ : front === 'E' ? lot.maxX : -lot.minX;
    const cx = (fp.minX + fp.maxX) / 2, cz = (fp.minZ + fp.maxZ) / 2;
    const half = Math.abs(tx) > 0.5 ? (fp.maxX - fp.minX) / 2 : (fp.maxZ - fp.minZ) / 2;
    /** The point `o` out along the outward axis (as `wall` and `edge` measure it) and `a` along the front from the house's middle. */
    const place = (o: number, a: number): [number, number] => (Math.abs(ox) > 0.5 ? [ox * o, cz + tz * a] : [cx + tx * a, oz * o]);
    const h = (k: number) => hash01(id, k);
    // Mailbox: just inside the front edge, beside the path to the door.
    const ma = (half * 0.5 + 0.8) * (h(1) < 0.5 ? -1 : 1);
    const [mx, mz] = place(edge - 0.55, ma);
    add(item('mailbox', 'yard', mx, ground(mx, mz), mz, facing, PALETTE[Math.floor(h(2) * PALETTE.length)]!, id));
    // Shrubs along the front wall, leaving the door path in the middle clear.
    for (const s of [-1, 1]) {
      for (const f of [0.45, 0.8]) {
        if (f === 0.8 && half < 4) continue;
        const [sx, sz] = place(wall + 0.75, s * half * f);
        add(item('shrub', 'yard', sx, ground(sx, sz), sz, facing + h(10 + s * 3 + f * 10) * 0.6, 0xffffff, id));
      }
    }
    // A planter by the door.
    const [px, pz] = place(wall + 0.6, (h(3) < 0.5 ? -1 : 1) * 1.05);
    add(item('planter', 'yard', px, ground(px, pz), pz, 0, 0xffffff, id));
    // A wheelie bin beside the house, at its front corner.
    const side = h(4) < 0.5 ? -1 : 1;
    const [bx, bz] = place(wall - 0.9, side * (half + 0.75));
    add(item('wheelie', 'yard', bx, ground(bx, bz), bz, facing, h(5) < 0.5 ? 0x2e7d32 : 0x37474f, id));
    // A picket fence down the lot's +x or +z side (the neighbour has the other), from the front edge back.
    const sideEdge = Math.abs(tx) > 0.5 ? lot.maxX - 0.12 : lot.maxZ - 0.12;
    const depthMin = Math.abs(ox) > 0.5 ? lot.minX : lot.minZ;
    const depthMax = Math.abs(ox) > 0.5 ? lot.maxX : lot.maxZ;
    for (let d = depthMin + 0.6 + 1; d + 1 <= depthMax - 0.6; d += 2) {
      const fx = Math.abs(ox) > 0.5 ? d : sideEdge;
      const fz = Math.abs(ox) > 0.5 ? sideEdge : d;
      add(item('fence', 'yard', fx, ground(fx, fz), fz, Math.abs(ox) > 0.5 ? 0 : Math.PI / 2, 0xffffff, id));
    }
  }
}

/** Azura Pier: railings down both long edges (gaps at its landward end and round the Ferris wheel); the Marina's railings and bollards. */
function decks(world: StaticWorld, rules: DressingRules, out: DressingItem[]): void {
  const L = world.layout;
  const pier = L.decks.find((d) => d.name === 'Azura Pier');
  const ferris = L.props.find((p) => p.kind === 'ferris');
  const lamps = L.props.filter((p) => p.kind === 'lamp');
  if (pier) {
    const r = pier.rect;
    for (const [z, rot] of [[r.minZ + 0.1, 0], [r.maxZ - 0.1, Math.PI]] as const) {
      for (let x = r.minX + 6 + 1.2; x + 1.2 <= r.maxX - 0.2; x += 2.4) {
        if (ferris && Math.abs(x - ferris.x) < 14) continue;
        const it = item('rail', 'deck', x, pier.y, z, rot, 0xffffff);
        if (!rules.violation(it)) out.push(it);
      }
    }
    // The far end.
    for (let z = r.minZ + 1.3; z + 1.2 <= r.maxZ - 0.1; z += 2.4) {
      const it = item('rail', 'deck', r.maxX - 0.1, pier.y, z, Math.PI / 2, 0xffffff);
      if (!rules.violation(it)) out.push(it);
    }
  }
  // The Marina: railings along the main deck's open edges out over the water (gaps where the finger piers join, and
  // none on its landward stretch over the sand) and across the fingers' far ends; bollards on the fingers, where the
  // boats lie, and on the unrailed part of the main deck.
  const marina = L.decks.filter((d) => d.name === 'Marina');
  const main = marina.find((d) => d.rect.maxX - d.rect.minX > d.rect.maxZ - d.rect.minZ);
  const fingers = marina.filter((d) => d !== main);
  const railFrom = Math.min(...fingers.map((f) => f.rect.minX)) - MARINA_RAIL_LEAD;
  const railed = (x: number, z: number): boolean => !!main && x > railFrom && rectContains(main.rect, x, z, 0.01);
  if (main) {
    const r = main.rect;
    const joins = (x: number) => fingers.some((f) => x > f.rect.minX - RAIL_CLEAR && x < f.rect.maxX + RAIL_CLEAR && Math.abs(f.rect.minZ - r.maxZ) < 0.5);
    for (const [z, rot, edge] of [[r.minZ + 0.1, 0, 'min'], [r.maxZ - 0.1, Math.PI, 'max']] as const) {
      for (let x = railFrom + 1.2; x + 1.2 <= r.maxX - 0.2; x += 2.4) {
        if (edge === 'max' && (joins(x - 1.2) || joins(x + 1.2))) continue;
        const it = item('rail', 'deck', x, main.y, z, rot, 0xffffff);
        if (!rules.violation(it) && !lamps.some((l) => Math.hypot(l.x - x, l.z - z) < 1.4)) out.push(it);
      }
    }
    for (let z = r.minZ + 1.3; z + 1.2 <= r.maxZ - 0.1; z += 2.4) {
      const it = item('rail', 'deck', r.maxX - 0.1, main.y, z, Math.PI / 2, 0xffffff);
      if (!rules.violation(it)) out.push(it);
    }
  }
  for (const f of fingers) {
    const r = f.rect;
    const it = item('rail', 'deck', (r.minX + r.maxX) / 2, f.y, r.maxZ - 0.1, Math.PI, 0xffffff);
    if (!rules.violation(it)) out.push(it);
  }
  for (const d of marina) {
    const r = d.rect;
    const long = r.maxZ - r.minZ > r.maxX - r.minX;
    const len = long ? r.maxZ - r.minZ : r.maxX - r.minX;
    for (let t = 3; t < len - 2; t += 6) {
      for (const s of [0, 1]) {
        const x = long ? (s ? r.maxX - 0.3 : r.minX + 0.3) : r.minX + t;
        const z = long ? r.minZ + t : (s ? r.maxZ - 0.3 : r.minZ + 0.3);
        if (long ? false : x < L.bounds.beachStartX + 4 || railed(x, z)) continue;
        const it = item('bollard', 'deck', x, d.y, z, 0);
        if (!rules.violation(it) && !lamps.some((l) => Math.hypot(l.x - x, l.z - z) < 1)) out.push(it);
      }
    }
  }
}

/**
 * Eternal Palms Cemetery: wrought iron round its lot, a gap at the gate (and where a path's end keeps a pickup's spot
 * clear). Drawn only: people and cars pass through it, as through the yards' picket fences.
 */
function cemeteryFence(world: StaticWorld, rules: DressingRules, out: DressingItem[]): void {
  const { fence: r, gate } = attractionOf(world.layout, 'cemetery').anchors;
  const y = world.groundHeight((r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2);
  const run = DRESSING_SIZE.ironfence[0] * 2;
  const along = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.floor(len / run);
    const ux = (x1 - x0) / len;
    const uz = (z1 - z0) / len;
    const start = (len - n * run) / 2;
    for (let k = 0; k < n; k++) {
      const t = start + (k + 0.5) * run;
      const x = x0 + ux * t;
      const z = z0 + uz * t;
      if (z0 === z1 && z0 === r.minZ + 0.1 && x > gate.x0 - run / 2 && x < gate.x1 + run / 2) continue;
      const it = item('ironfence', 'cemetery', x, y, z, Math.atan2(uz, ux) === 0 ? 0 : Math.PI / 2, 0xffffff);
      if (!rules.violation(it)) out.push(it);
    }
  };
  along(r.minX, r.minZ + 0.1, r.maxX, r.minZ + 0.1);
  along(r.minX, r.maxZ - 0.1, r.maxX, r.maxZ - 0.1);
  along(r.minX + 0.1, r.minZ, r.minX + 0.1, r.maxZ);
  along(r.maxX - 0.1, r.minZ, r.maxX - 0.1, r.maxZ);
}

/** The Marina's main-deck railings start this far (m) landward of its first finger pier. */
const MARINA_RAIL_LEAD = 12;
/** Railings keep this far (m) clear of a finger pier's sides where it joins the main deck. */
const RAIL_CLEAR = 0.4;

// ---------------------------------------------------------------------------------------------------------------------
// Garages

/** An enterable garage as the furnishing sees it. Local frame: `u` across the opening, `w` in from the opening. */
export interface GarageSpec {
  name: string;
  /** Footprint, and the walls' inner faces in the local frame. */
  rect: Rect;
  /** World position of local (0, 0): the middle of the opening; (ax, az) is +u, (dx, dz) is +w (inwards). */
  ox: number;
  oz: number;
  ax: number;
  az: number;
  dx: number;
  dz: number;
  /** Inner half-width (u) and inner depth (w) between the walls; the roof's underside height. */
  halfWidth: number;
  depth: number;
  ceiling: number;
  /** Car bays in the local frame (u0, w0, u1, w1), clear up to `bayHeight` m, and the entrance strip's depth. */
  bays: Array<[number, number, number, number]>;
  bayHeight: number;
  entrance: number;
}

/** The safehouse garage's bays (places.garageBays): 3.4 m wide, for cars up to 5.4 m long. */
export const SAFEHOUSE_BAY_LENGTH = 5.4;
/** Lou's and the spray shacks: one drive-in lane down the middle. */
export const GARAGE_LANE = 3.6;

export function garageSpecs(world: StaticWorld): GarageSpec[] {
  const out: GarageSpec[] = [];
  for (const g of world.layout.garages) {
    const r = g.rect;
    const t = 0.5;
    // Opening on side g.side; w runs inward, u across (right-handed with y up: u = w x y).
    const [ox, oz] = sideOutward(g.side);
    const dx = -ox, dz = -oz;
    const ax = dz, az = -dx;
    const cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2;
    const width = Math.abs(ox) > 0.5 ? r.maxZ - r.minZ : r.maxX - r.minX;
    const depth = Math.abs(ox) > 0.5 ? r.maxX - r.minX : r.maxZ - r.minZ;
    const halfWidth = width / 2 - t;
    out.push({
      name: g.poi, rect: r, ox: cx + ox * depth / 2, oz: cz + oz * depth / 2, ax, az, dx, dz,
      halfWidth, depth: depth - t, ceiling: g.height, bays: [[-GARAGE_LANE / 2, 0, GARAGE_LANE / 2, depth - t]], bayHeight: 2.9, entrance: 1.5,
    });
  }
  const at = places(world);
  const a = at.garageArea;
  const bays = at.garageBays;
  // The carport opens to -x (the street); its back wall stands at +x, 0.12 m thick.
  const bx = bays[0]!.x;
  out.push({
    name: 'safehouse', rect: a, ox: a.minX, oz: (a.minZ + a.maxZ) / 2, ax: 0, az: -1, dx: 1, dz: 0,
    halfWidth: (a.maxZ - a.minZ) / 2, depth: a.maxX - a.minX - 0.12, ceiling: 3.1,
    bays: bays.map((s) => {
      const u = (a.minZ + a.maxZ) / 2 - s.z;
      return [u - 1.7, bx - SAFEHOUSE_BAY_LENGTH / 2 - a.minX, u + 1.7, bx + SAFEHOUSE_BAY_LENGTH / 2 - a.minX] as [number, number, number, number];
    }),
    bayHeight: 2.6, entrance: 0.6,
  });
  return out;
}

/** World point of a garage-local (u, w). */
export function garageWorld(g: GarageSpec, u: number, w: number): [number, number] {
  return [g.ox + g.ax * u + g.dx * w, g.oz + g.az * u + g.dz * w];
}

/** Heading that turns a model's local +z to face along garage-local direction (du, dw). */
function garageRot(g: GarageSpec, du: number, dw: number): number {
  const x = g.ax * du + g.dx * dw;
  const z = g.az * du + g.dz * dw;
  return Math.atan2(x, z);
}

/** Vertical extent (m) of each garage item's model above its origin, for the bay clearance (add the item's lift). */
export const GARAGE_ITEM_HEIGHT: Partial<Record<DressingKind, readonly [number, number]>> = {
  workbench: [0, 1.2], toolwall: [0, 1.0], shelving: [0, 2.1], wallshelf: [0, 2.1], tyres: [0, 0.9], tyrerack: [0, 1.45],
  drum: [0, 0.9], chest: [0, 1.2], jack: [0, 0.8], poster: [0, 0.86], lamphousing: [-0.1, 0.35], lamptube: [-0.15, 0],
};

function furnish(world: StaticWorld, out: DressingItem[]): void {
  garageSpecs(world).forEach((g, gi) => {
    const y = world.groundHeight(...garageWorld(g, 0, g.depth / 2));
    const put = (kind: DressingKind, u: number, w: number, du: number, dw: number, lift = 0, color = 0xffffff): void => {
        const [x, z] = garageWorld(g, u, w);
      out.push(item(kind, 'garage', x, y + lift, z, garageRot(g, du, dw), color, gi));
    };
    const H = g.halfWidth;
    if (g.name !== 'safehouse') {
      // Left wall (u = -H): workbench with the tool wall over it, then shelving and a tyre stack towards the back.
      put('workbench', -H + 0.36, g.depth * 0.36, 1, 0);
      put('toolwall', -H, g.depth * 0.36, 1, 0, 1.15);
      put('shelving', -H, g.depth * 0.68, 1, 0);
      put('tyres', -H + 0.4, g.depth - 0.45, 0, 1);
      put('tyres', -H + 1.15, g.depth - 0.45, 0, 1);
      // Right wall: tool chest, oil drums, a jack; posters on both walls; tyres in the back corner.
      put('chest', H - 0.27, g.depth * 0.3, -1, 0);
      put('drum', H - 0.35, g.depth * 0.52, 0, 1, 0, 0x2e86c1);
      put('drum', H - 0.35, g.depth * 0.52 + 0.65, 0, 1, 0, 0xc0392b);
      put('drum', H - 1.0, g.depth * 0.52 + 0.3, 0, 1, 0, 0x2e86c1);
      put('jack', H - 0.6, g.depth * 0.75, 0, -1);
      put('tyres', H - 0.4, g.depth - 0.45, 0, 1);
      put('poster', H, g.depth * 0.3, -1, 0, 1.45);
      put('poster', -H, g.depth * 0.68 + 1.1, 1, 0, 1.45);
      put('poster', -H + 1.9, g.depth, 0, -1, 1.5);
      // Two fluorescent fixtures under the roof, over the lane.
      for (const f of [0.35, 0.7]) {
        put('lamphousing', 0, g.depth * f, 0, 1, g.ceiling - 0.35);
        put('lamptube', 0, g.depth * f, 0, 1, g.ceiling - 0.35);
      }
    } else {
      // The carport's back wall: shallow shelving, a tool wall, a tyre rack and posters; lights under the roof.
      const back = g.depth;
      const u0 = -H + 1.2;
      put('wallshelf', u0, back, 0, -1);
      put('toolwall', u0 + 2.3, back, 0, -1, 1.15);
      put('tyrerack', u0 + 4.6, back - 0.02, 0, -1);
      put('wallshelf', u0 + 7, back, 0, -1);
      put('toolwall', u0 + 9.4, back, 0, -1, 1.15);
      put('tyrerack', u0 + 11.6, back - 0.02, 0, -1);
      for (const pu of [u0 + 3.45, u0 + 8.2, u0 + 10.6]) put('poster', pu, back, 0, -1, 1.45);
      for (const s of g.bays) {
        const u = (s[0] + s[2]) / 2;
        put('lamphousing', u, back * 0.55, 1, 0, g.ceiling - 0.12);
        put('lamptube', u, back * 0.55, 1, 0, g.ceiling - 0.12);
      }
    }
  });
}

/** Wall-mounted kinds whose back is their origin (they stand out from the wall along their facing). */
export const WALL_MOUNTED: ReadonlySet<DressingKind> = new Set(['toolwall', 'shelving', 'wallshelf', 'tyrerack', 'poster']);

let cache: WeakMap<StaticWorld, DressingItem[]> = new WeakMap();

/** Every dressing item of the world, in a fixed order. */
export function dressingItems(world: StaticWorld): DressingItem[] {
  const hit = cache.get(world);
  if (hit) return hit;
  const rules = new DressingRules(world);
  const out: DressingItem[] = [];
  beach(world, rules, out);
  yards(world, rules, out);
  decks(world, rules, out);
  cemeteryFence(world, rules, out);
  furnish(world, out);
  cache.set(world, out);
  return out;
}

/** Test hook: forget cached placements. */
export function resetDressingCache(): void {
  cache = new WeakMap();
}
