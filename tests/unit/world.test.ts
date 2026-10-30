import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CURB_H, SWIM_DEPTH, WATER_Y } from '../../src/world/constants';
import { cellBlock, generateCity, PARAPET_H, rectContains, rectsOverlap, rectCX, rectCZ, waterAt } from '../../src/world/layout';
import { SIGNAL_CYCLE } from '../../src/world/roads';
import { StaticWorld } from '../../src/world/staticWorld';
import { legacyLane } from './helpers';

const world = new StaticWorld();
const L = world.layout;

describe('city layout', () => {
  it('is deterministic for a seed', () => {
    const a = generateCity(7);
    const b = generateCity(7);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    const c = generateCity(8);
    expect(JSON.stringify(c)).not.toEqual(JSON.stringify(a));
  });

  it('has a reasonable amount of content', () => {
    // 100 cells: three superblocks cover eight of them, and ten are sea.
    expect(L.blocks.length).toBe(85);
    expect(L.buildings.length).toBeGreaterThan(250);
    expect(L.props.length).toBeGreaterThan(800);
    expect(L.parking.length).toBeGreaterThan(40);
    expect(L.openSpots.length).toBeGreaterThan(40);
    expect(L.ramps.length).toBe(5);
  });

  it('keeps every building inside a block lot', () => {
    for (const b of L.buildings) {
      const inside = L.blocks.some((bl) => rectContains(bl.lot, b.rect.minX, b.rect.minZ, 0.01) && rectContains(bl.lot, b.rect.maxX, b.rect.maxZ, 0.01));
      expect(inside, `building ${b.id}`).toBe(true);
      for (const t of b.tiers) {
        expect(t.minX).toBeGreaterThanOrEqual(b.rect.minX - 1e-6);
        expect(t.maxX).toBeLessThanOrEqual(b.rect.maxX + 1e-6);
        expect(t.y1).toBeGreaterThan(t.y0);
      }
      expect(b.height).toBeGreaterThan(4);
    }
  });

  it('never overlaps buildings with each other or with garages', () => {
    for (let i = 0; i < L.buildings.length; i++) {
      for (let j = i + 1; j < L.buildings.length; j++) {
        expect(rectsOverlap(L.buildings[i]!.rect, L.buildings[j]!.rect), `${i} vs ${j}`).toBe(false);
      }
      for (const g of L.garages) expect(rectsOverlap(L.buildings[i]!.rect, g.rect)).toBe(false);
    }
  });

  it('places every special point of interest exactly once', () => {
    const ids = L.pois.map((p) => p.id).sort();
    expect(ids).toEqual(['bank', 'dex', 'guns_south', 'guns_west', 'hospital', 'lou', 'marina', 'police', 'safehouse', 'spray_docks', 'spray_hill', 'spray_south', 'vera']);
    for (const p of L.pois) {
      expect(world.isFree(p.x, p.z, 0.6), `poi ${p.id} marker blocked`).toBe(true);
      expect(world.waterDepth(p.x, p.z)).toBeLessThan(0);
    }
  });

  it('keeps garage bays drivable and their entrances open', () => {
    for (const g of L.garages) {
      const poi = L.pois.find((p) => p.id === g.poi)!;
      expect(poi.bay).not.toBeNull();
      const bay = poi.bay!;
      expect(world.isFree(rectCX(bay), rectCZ(bay), 2.0), `${g.poi} bay`).toBe(true);
      // Walk from the bay centre out through the opening to the road: must stay free for a car-width circle.
      const ox = Math.sin(poi.heading);
      const oz = Math.cos(poi.heading);
      for (let d = 0; d <= 16; d += 1) {
        const x = rectCX(bay) + ox * d;
        const z = rectCZ(bay) + oz * d;
        expect(world.isFree(x, z, 1.4), `${g.poi} entrance blocked at ${d}`).toBe(true);
      }
      expect(world.isOnRoad(rectCX(bay) + ox * 16, rectCZ(bay) + oz * 16)).toBe(true);
    }
  });

  it('puts parking spots and open spots on free land', () => {
    for (const s of L.parking) {
      expect(world.isFree(s.x, s.z, 1.2), `parking ${s.x},${s.z}`).toBe(true);
      expect(world.isOnRoad(s.x, s.z)).toBe(false);
    }
    for (const s of L.openSpots) {
      expect(world.isFree(s.x, s.z, 0.5), `open spot ${s.x},${s.z}`).toBe(true);
    }
  });

  it('keeps stunt ramp corridors clear', () => {
    for (const r of L.ramps) {
      const fx = Math.sin(r.heading);
      const fz = Math.cos(r.heading);
      for (let a = -45; a <= 80; a += 2.5) {
        if (Math.abs(a) < r.length / 2 + 0.5) continue;
        const x = r.x + fx * a;
        const z = r.z + fz * a;
        expect(world.isFree(x, z, 2.2), `ramp ${r.id} corridor at ${a}`).toBe(true);
      }
      const tx = r.x + fx * (r.length / 2 - 0.2);
      const tz = r.z + fz * (r.length / 2 - 0.2);
      expect(world.groundHeight(tx, tz) - world.baseGround(tx, tz)).toBeGreaterThan(r.height * 0.9);
      expect(world.waterDepth(r.x, r.z)).toBeLessThan(0);
    }
  });
});

describe('ground and water', () => {
  it('reports road, curb and sea heights', () => {
    const v = L.vLines[4]!;
    const h = L.hLines[4]!;
    expect(world.groundHeight(v.pos, rectCZ(cellBlock(L, 4, 4)!.rect))).toBe(0);
    expect(world.groundHeight(rectCX(cellBlock(L, 4, 4)!.rect), h.pos)).toBe(0);
    const blk = cellBlock(L, 5, 5)!;
    expect(world.groundHeight(blk.rect.minX + 1, rectCZ(blk.rect))).toBe(CURB_H);
    expect(world.waterDepth(L.bounds.landMinX - 20, 0)).toBeGreaterThan(5);
    expect(world.waterDepth(L.bounds.beachEndX + 20, 0)).toBeGreaterThan(5);
    // Dry sand near the boardwalk, water further out.
    expect(world.waterDepth(L.bounds.beachStartX + 5, -200)).toBeLessThan(0);
    expect(world.waterDepth(L.bounds.beachStartX + 80, -200)).toBeGreaterThan(0.5);
  });

  it('names zones', () => {
    const dt = cellBlock(L, 4, 4)!;
    expect(world.zoneName(rectCX(dt.rect), rectCZ(dt.rect))).toBe('Downtown');
    expect(world.zoneName(L.bounds.beachStartX + 20, 0)).toBe('Ocean Beach');
    expect(world.zoneName(L.bounds.landMinX - 50, 0)).toBe('San Azura Bay');
  });
});

describe('the sea in the land', () => {
  it('cuts a cove, four bays, a harbour basin and a canal into the land, and a headland out of it', () => {
    expect(L.water.map((w) => w.name).sort()).toEqual(['Coral Bay', 'Cortez Canal', 'Gull Bay', 'Hillcrest Cove', 'Northshore Bay', 'Pelican Harbor', 'Port Basin']);
    for (const w of L.water) {
      for (const r of w.rects) {
        const x = rectCX(r);
        const z = rectCZ(r);
        if (L.decks.some((d) => rectContains(d.rect, x, z))) continue;
        expect(world.waterDepth(x, z), `${w.name} at ${x},${z}`).toBeGreaterThan(SWIM_DEPTH);
        expect(world.zoneName(x, z)).toBe(w.name);
      }
    }
    const point = L.headlands.find((h) => h.name === 'Azura Point')!;
    for (const r of point.rects) {
      expect(r.minZ).toBeLessThan(L.bounds.landMinZ);
      expect(world.groundHeight(rectCX(r), rectCZ(r))).toBe(CURB_H);
    }
    const lighthouse = L.props.find((p) => p.kind === 'lighthouse')!;
    expect(rectContains(point.rects[1]!, lighthouse.x, lighthouse.z)).toBe(true);
  });

  it('carries every street over the canal on a bridge, its footways fenced by parapets', () => {
    const canal = L.water.find((w) => w.name === 'Cortez Canal')!.bounds;
    const bridges = world.roads.live.filter((n) => rectContains(canal, n.x, n.z));
    expect(bridges.length).toBe(11);
    for (const n of bridges) {
      expect(n.neighbors[0]).toBe(-1);
      expect(n.neighbors[2]).toBe(-1);
      expect(n.signal).toBe(false);
      expect(world.groundHeight(n.x, n.z)).toBe(0);
      expect(world.isOnRoad(n.x, n.z)).toBe(true);
      for (const side of [-1, 1]) {
        const z = n.z + side * (n.halfZ + 2);
        expect(world.groundHeight(n.x, z), `footway of bridge ${n.id}`).toBe(CURB_H);
        // The parapet stands at the footway's outer edge: a body walking off it stops there.
        expect(world.isFree(n.x, n.z + side * (n.halfZ + 3.8), 0.3)).toBe(false);
      }
    }
    expect(PARAPET_H).toBeGreaterThan(0.9);
    // Nothing on foot or in a car crosses the canal anywhere but on a bridge.
    for (const lane of world.roads.lanes) expect(rectContains(canal, lane.sx, lane.sz) || rectContains(canal, lane.ex, lane.ez)).toBe(false);
  });

  it('keeps people, props, parking and pickups out of the water', () => {
    const dry = (x: number, z: number) => !waterAt(L, x, z) || L.decks.some((d) => rectContains(d.rect, x, z));
    for (const n of world.walk.nodes) {
      expect(dry(n.x, n.z), `walk node ${n.id}`).toBe(true);
      for (const e of n.edges) {
        const m = world.walk.nodes[e.to]!;
        for (let t = 0; t <= 1; t += 0.05) expect(dry(n.x + (m.x - n.x) * t, n.z + (m.z - n.z) * t), `walk edge ${n.id}-${e.to}`).toBe(true);
      }
    }
    for (const p of L.props) if (p.kind !== 'boat') expect(waterAt(L, p.x, p.z), `${p.kind} at ${p.x},${p.z}`).toBeNull();
    for (const p of [...L.parking, ...L.openSpots]) expect(world.waterDepth(p.x, p.z)).toBeLessThan(0);
    // The moored boats float in the basin, the cranes stand on its wharf.
    const basin = L.water.find((w) => w.name === 'Port Basin')!;
    expect(L.props.filter((p) => p.kind === 'boat' && waterAt(L, p.x, p.z) === basin).length).toBe(4);
    for (const c of L.props.filter((p) => p.kind === 'crane')) {
      expect(world.groundHeight(c.x, c.z)).toBe(CURB_H);
      expect(world.waterDepth(c.x, c.z + 40)).toBeGreaterThan(WATER_Y + 5);
    }
  });
});

describe('road network', () => {
  const roads = world.roads;

  it('builds the grid of intersections and lanes', () => {
    expect(roads.nodes.length).toBe(121);
    expect(roads.lanes.length).toBeGreaterThan(500);
    for (const lane of roads.lanes) {
      expect(lane.length).toBeGreaterThan(40);
      expect(lane.turns.length).toBeGreaterThan(0);
      expect(lane.turns.some((t) => t.legal)).toBe(true);
      for (const t of lane.turns) {
        expect(t.pts[0]).toBeCloseTo(lane.ex, 6);
        expect(t.pts[1]).toBeCloseTo(lane.ez, 6);
        expect(t.pts[t.pts.length - 2]).toBeCloseTo(t.to.sx, 6);
        expect(t.pts[t.pts.length - 1]).toBeCloseTo(t.to.sz, 6);
        expect(t.to.from).toBe(lane.to);
      }
    }
  });

  it('lays every lane on the road surface away from obstacles', () => {
    for (const lane of roads.lanes) {
      for (let s = 0; s <= lane.length; s += 5) {
        const x = lane.sx + lane.dx * s;
        const z = lane.sz + lane.dz * s;
        expect(world.isOnRoad(x, z), `lane ${lane.id}`).toBe(true);
        expect(world.isFree(x, z, 1.0), `lane ${lane.id} at ${s}`).toBe(true);
      }
      for (const t of lane.turns) {
        for (let i = 0; i < t.pts.length; i += 2) {
          expect(world.isOnRoad(t.pts[i]!, t.pts[i + 1]!)).toBe(true);
        }
      }
    }
  });

  it('reaches every live junction from every other', () => {
    const live = roads.live.map((n) => n.id);
    for (const goal of [live[0]!, live[Math.floor(live.length / 2)]!, live[live.length - 1]!]) {
      const field = roads.distanceField(goal);
      for (const id of live) expect(field[id], `junction ${id} to ${goal}`).toBeLessThan(Infinity);
    }
    for (const n of roads.nodes) if (n.degree === 0) expect(roads.live).not.toContain(n);
  });

  it('finds routes between any two intersections', () => {
    const live = roads.live;
    for (let k = 0; k < 200; k++) {
      const a = live[(k * 37) % live.length]!.id;
      const b = live[(k * 91 + 13) % live.length]!.id;
      const route = roads.findRoute(a, b);
      expect(route).not.toBeNull();
      expect(route![0]).toBe(a);
      expect(route![route!.length - 1]).toBe(b);
      for (let i = 1; i < route!.length; i++) expect(roads.nodes[route![i - 1]!]!.neighbors).toContain(route![i]);
    }
  });

  it('never shows green to both axes', () => {
    for (const node of roads.nodes) {
      if (!node.signal) continue;
      for (let t = 0; t < SIGNAL_CYCLE * 2; t += 0.25) {
        const ns = roads.signalState(node.id, 'NS', t);
        const ew = roads.signalState(node.id, 'EW', t);
        expect(ns === 'red' || ew === 'red').toBe(true);
        if (roads.pedCanCross(node.id, 'NS', t)) expect(ns).toBe('red');
        if (roads.pedCanCross(node.id, 'EW', t)) expect(ew).toBe('red');
      }
    }
  });

  it('finds the nearest lane respecting heading', () => {
    const lane = legacyLane(world, 123);
    const x = lane.sx + lane.dx * 20;
    const z = lane.sz + lane.dz * 20;
    const r = roads.nearestLane(x, z, lane.heading);
    expect(r.lane.id).toBe(lane.id);
    expect(r.s).toBeCloseTo(20, 4);
  });
});

describe('sidewalk graph', () => {
  const walk = world.walk;
  it('is connected', () => {
    const seen = new Set<number>([0]);
    const queue = [0];
    while (queue.length) {
      const n = queue.shift()!;
      for (const e of walk.nodes[n]!.edges) {
        if (!seen.has(e.to)) {
          seen.add(e.to);
          queue.push(e.to);
        }
      }
    }
    expect(seen.size).toBe(walk.nodes.length);
  });

  it('keeps walking edges off the roads and crosswalks linked to signals', () => {
    for (const n of walk.nodes) {
      for (const e of n.edges) {
        const m = walk.nodes[e.to]!;
        const mx = (n.x + m.x) / 2;
        const mz = (n.z + m.z) / 2;
        if (e.crosswalk) {
          expect(e.roadNode).toBeGreaterThanOrEqual(0);
          expect(world.isOnRoad(mx, mz)).toBe(true);
        } else {
          expect(world.isOnRoad(mx, mz), `walk edge ${n.id}-${e.to}`).toBe(false);
        }
      }
    }
  });
});

// Optional: `DUMP_MAP=1 npx vitest run tests/unit/world.test.ts` writes a top-down SVG for visual inspection.
if (process.env.DUMP_MAP) {
  it('dumps an svg map', () => {
    const b = L.bounds;
    const s = 1;
    const parts: string[] = [];
    const W = (b.worldMaxX - b.worldMinX) * s;
    const H = (b.worldMaxZ - b.worldMinZ) * s;
    const X = (x: number) => (x - b.worldMinX) * s;
    const Z = (z: number) => (z - b.worldMinZ) * s;
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
    parts.push(`<rect width="${W}" height="${H}" fill="#1b4f72"/>`);
    parts.push(`<rect x="${X(b.landMinX)}" y="${Z(b.landMinZ)}" width="${X(b.beachStartX) - X(b.landMinX)}" height="${Z(b.landMaxZ) - Z(b.landMinZ)}" fill="#9a9a90"/>`);
    parts.push(`<rect x="${X(b.beachStartX)}" y="${Z(b.landMinZ)}" width="${X(b.beachEndX) - X(b.beachStartX)}" height="${Z(b.landMaxZ) - Z(b.landMinZ)}" fill="#e8d8a0"/>`);
    for (const r of [...L.vLines.map((l) => ({ x: l.pos - l.width / 2, z: b.cityMinZ, w: l.width, h: b.cityMaxZ - b.cityMinZ })), ...L.hLines.map((l) => ({ x: b.cityMinX, z: l.pos - l.width / 2, w: b.cityMaxX - b.cityMinX, h: l.width }))]) {
      parts.push(`<rect x="${X(r.x)}" y="${Z(r.z)}" width="${r.w * s}" height="${r.h * s}" fill="#333"/>`);
    }
    const gc: Record<string, string> = { grass: '#4a8c3a', plaza: '#b8b2a6', parking: '#555', dirt: '#8d7a5a', yard: '#5c9a48' };
    for (const g of L.ground) parts.push(`<rect x="${X(g.rect.minX)}" y="${Z(g.rect.minZ)}" width="${(g.rect.maxX - g.rect.minX) * s}" height="${(g.rect.maxZ - g.rect.minZ) * s}" fill="${gc[g.kind]}"/>`);
    const bc: Record<string, string> = { glassBlue: '#3c78d8', glassTeal: '#45b0a0', office: '#c9b48f', brick: '#a0522d', stucco: '#efe6d2', house: '#e8b88a', warehouse: '#8a9aa8', hotel: '#f4f4f4' };
    for (const bd of L.buildings) parts.push(`<rect x="${X(bd.rect.minX)}" y="${Z(bd.rect.minZ)}" width="${(bd.rect.maxX - bd.rect.minX) * s}" height="${(bd.rect.maxZ - bd.rect.minZ) * s}" fill="${bc[bd.style]}" stroke="#000" stroke-width="0.4"/>`);
    for (const g of L.garages) for (const w of g.walls) parts.push(`<rect x="${X(w.minX)}" y="${Z(w.minZ)}" width="${(w.maxX - w.minX) * s}" height="${(w.maxZ - w.minZ) * s}" fill="#f0f"/>`);
    for (const d of L.decks) parts.push(`<rect x="${X(d.rect.minX)}" y="${Z(d.rect.minZ)}" width="${(d.rect.maxX - d.rect.minX) * s}" height="${(d.rect.maxZ - d.rect.minZ) * s}" fill="#8b5a2b"/>`);
    const pc: Record<string, string> = { tree: '#1e5a1e', palm: '#2e8b57', lamp: '#ff0', signal: '#f00', hydrant: '#f60', bench: '#630', bin: '#666', container: '#d35400', bush: '#3a7a2a' };
    for (const p of L.props) parts.push(`<circle cx="${X(p.x)}" cy="${Z(p.z)}" r="${p.kind === 'container' ? 2 : 0.8}" fill="${pc[p.kind] ?? '#fff'}"/>`);
    for (const r of L.ramps) parts.push(`<circle cx="${X(r.x)}" cy="${Z(r.z)}" r="5" fill="none" stroke="#f0f" stroke-width="2"/>`);
    for (const p of L.parking) parts.push(`<rect x="${X(p.x) - 1}" y="${Z(p.z) - 1}" width="2" height="2" fill="#0ff"/>`);
    for (const p of L.pois) parts.push(`<circle cx="${X(p.x)}" cy="${Z(p.z)}" r="4" fill="#ff1493"/><text x="${X(p.x) + 5}" y="${Z(p.z)}" font-size="10" fill="#fff">${p.id}</text>`);
    for (const lane of world.roads.lanes) parts.push(`<line x1="${X(lane.sx)}" y1="${Z(lane.sz)}" x2="${X(lane.ex)}" y2="${Z(lane.ez)}" stroke="#fff" stroke-width="0.3"/>`);
    parts.push('</svg>');
    writeFileSync(process.env.DUMP_MAP!, parts.join('\n'));
  });
}
