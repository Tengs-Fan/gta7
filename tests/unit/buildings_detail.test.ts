// The buildings' detail where a player looks: plaster walls that keep their grain but little of their stains, doorways
// set back behind the ground-floor fronts, piers between the bays, the houses' gables, chimneys and shutters, the
// hotels' and apartment blocks' balconies, the brick blocks' fire escapes and the parapets' coping; the windows fitted
// under each tier's roof, the stone podiums and the plant penthouses of the towers. All of it is
// render geometry in the existing batches (m3_buildings caps the city's meshes): no collider or footprint of its own.

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CityView } from '../../src/render/city';
import { balconyStep, everyBay, hasFireEscape, plainStreetSides } from '../../src/render/city/buildings';
import { createFacadeMaterial } from '../../src/render/city/facadeShader';
import { landmarkTowers } from '../../src/render/city/landmarks';
import { COPING_H, PARAPET_H, rooftopItems, storeys } from '../../src/render/city/rooftops';
import { BALCONY_DEPTH, BALCONY_SLAB, ESCAPE_DEPTH, ESCAPE_FLOOR, LADDER_DROP, SHUTTER, balconies, facadeRelief, fireEscape } from '../../src/render/cityArchitecture';
import { GeoBuilder } from '../../src/render/geo';
import { BANK_STEP_TOP, CELL_DESIGN, CELLS, DOOR_OPENING, DOOR_U, FACADE_CELL, FACADE_COLS, FACADE_LOOK, FACADE_ROWS, FACADE_TOP, FACADE_TOP_SCALE, FACADE_WINDOW, HOUSE_FIT_MIN_H, SHOP_AWNING_TOP, facadeWindowAt, facadeWindowFit } from '../../src/render/textures';
import { CURB_H } from '../../src/world/constants';
import type { FacadeStyle } from '../../src/world/layout';
import type { StaticWorld } from '../../src/world/staticWorld';
import { world } from './helpers';

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
    return new Proxy(store, {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: (o, k, v) => {
        o[k] = v;
        return true;
      },
    });
  };
  const canvas = (): Record<string, unknown> => ({
    width: 300,
    height: 150,
    clientWidth: 1280,
    clientHeight: 720,
    style: {},
    getContext: (kind: string) => (kind === '2d' ? ctx2d() : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

const STYLES: FacadeStyle[] = ['glassBlue', 'glassTeal', 'office', 'brick', 'stucco', 'house', 'warehouse', 'hotel'];

const meshes = (root: THREE.Object3D, name?: string): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && (!name || o.name === name)) out.push(o);
  });
  return out;
};

describe('building detail', () => {
  let W: StaticWorld;
  let city: CityView;
  beforeAll(() => {
    W = world();
    city = new CityView(W);
  });

  it("keeps at most 0.3 of the plaster's stains on the walls that use it, and the compiled facade divides them out", () => {
    for (const s of STYLES) {
      const look = FACADE_LOOK[s];
      expect(look.stain, s).toBeGreaterThanOrEqual(0);
      expect(look.stain, s).toBeLessThanOrEqual(1);
      if (look.set === 'white_plaster_02') expect(look.stain, s).toBeLessThanOrEqual(0.3);
    }
    const m = createFacadeMaterial('house', 1, { occupancy: { value: 0 }, time: { value: 0 } }, city.buildingU);
    const lib = THREE.ShaderLib.standard;
    const sh = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(sh, {} as THREE.WebGLRenderer);
    expect(sh.fragmentShader).toContain('textureLod(map, wuv');
    expect((sh.uniforms.uWallStain as { value: number }).value).toBe(FACADE_LOOK.house.stain);
  });

  it('sets every door back 0.1-0.7 m inside its cell, the revolving drum flush', () => {
    for (const [cell, u] of Object.entries(DOOR_U)) {
      const o = DOOR_OPENING[Number(cell)];
      if (Number(cell) === CELLS.lobbyRevolving) {
        expect(o).toBeUndefined();
        continue;
      }
      expect(o, `cell ${cell}`).toBeDefined();
      const design = Number(cell) < CELLS.lobbyRevolving ? CELL_DESIGN.shop : Number(cell) === CELLS.houseDoorA || Number(cell) === CELLS.houseDoorB ? CELL_DESIGN.house : CELL_DESIGN.lobby;
      expect(o!.x0).toBeGreaterThan(0.3);
      expect(o!.x1).toBeLessThan(design.w - 0.3);
      expect(o!.y1).toBeLessThan(design.h);
      expect(o!.depth).toBeGreaterThanOrEqual(0.1);
      expect(o!.depth).toBeLessThanOrEqual(0.7);
      // The door it opens round is the one DOOR_U names.
      expect(Math.abs((o!.x0 + o!.x1) / 2 / design.w - u)).toBeLessThan(0.01);
    }
  });

  it('draws the doorways behind the frontage plane: storefront vertices inside a footprint by no more than the deepest door', () => {
    const deepest = Math.max(...Object.values(DOOR_OPENING).map((o) => o.depth));
    const p = meshes(city.group, 'storefronts')[0]!.geometry.getAttribute('position');
    let set = 0;
    const bad: string[] = [];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      for (const b of W.layout.buildings) {
        const r = b.rect;
        if (x <= r.minX || x >= r.maxX || z <= r.minZ || z >= r.maxZ) continue;
        const inside = Math.min(x - r.minX, r.maxX - x, z - r.minZ, r.maxZ - z);
        if (inside > 0.05) set++;
        if (inside > deepest + 1e-3 && bad.length < 5) bad.push(`${b.id} ${x.toFixed(2)},${z.toFixed(2)} ${inside.toFixed(2)}`);
      }
    }
    console.log(`[buildings] storefront vertices set back ${set}`);
    expect(bad).toEqual([]);
    expect(set).toBeGreaterThan(4000);
  });

  it('gives every new face of the trim, decor, roofs and fronts a unit normal (a zero one lights as NaN and blanks the frame)', () => {
    for (const name of ['architectural-trim', 'ground-decor', 'roofs', 'storefronts']) {
      for (const m of meshes(city.group, name)) {
        const n = m.geometry.getAttribute('normal');
        let bad = 0;
        for (let i = 0; i < n.count; i++) if (Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) > 1e-3) bad++;
        expect(bad, name).toBe(0);
      }
    }
  });

  it('turns every wall, front and trim face out of its building: none on a wall plane faces in, no front faces into its wall', () => {
    // Each vertical face against the tier walls it stands by: a facade or front piece within 0.7 m inside a wall (its
    // doorway's recess) faces out of that wall or along it (a reveal); a trim or roof face on a wall's plane (within
    // 3 mm), which would be coplanar with the wall, faces out of it. A face turned the other way shows its back from
    // the street, or lets the sun through a gable.
    const tiers = W.layout.buildings.flatMap((b) => b.tiers);
    const check = (name: string, reach: number, above = 0.1) => {
      let faces = 0;
      const bad: string[] = [];
      for (const m of meshes(city.group).filter((o) => o.name.startsWith(name))) {
        const p = m.geometry.getAttribute('position');
        const nr = m.geometry.getAttribute('normal');
        const idx = m.geometry.index!;
        for (let f = 0; f < idx.count; f += 3) {
          const [a, b, c] = [idx.getX(f), idx.getX(f + 1), idx.getX(f + 2)];
          const ny = nr.getY(a);
          if (Math.abs(ny) > 0.1) continue;
          const x = (p.getX(a) + p.getX(b) + p.getX(c)) / 3;
          const y = (p.getY(a) + p.getY(b) + p.getY(c)) / 3;
          const z = (p.getZ(a) + p.getZ(b) + p.getZ(c)) / 3;
          for (const t of tiers) {
            if (y < t.y0 - 0.1 || y > t.y1 + above) continue;
            if (x < t.minX - 0.003 || x > t.maxX + 0.003 || z < t.minZ - 0.003 || z > t.maxZ + 0.003) continue;
            const edges: Array<[number, number, number]> = [
              [x - t.minX, -1, 0],
              [t.maxX - x, 1, 0],
              [z - t.minZ, 0, -1],
              [t.maxZ - z, 0, 1],
            ];
            const [d, ox, oz] = edges.reduce((m0, e) => (e[0] < m0[0] ? e : m0));
            if (d > reach) continue;
            faces++;
            if (nr.getX(a) * ox + nr.getZ(a) * oz < -0.2 && bad.length < 5) bad.push(`${m.name} at ${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)} normal ${nr.getX(a).toFixed(2)},${nr.getZ(a).toFixed(2)}`);
          }
        }
      }
      return { faces, bad };
    };
    const fronts = check('storefronts', 0.7);
    const walls = check('facade-', 0.7);
    const trim = check('architectural-trim', 0.003);
    // The parapets stand on the walls' planes over the roofs.
    const roofs = check('roofs', 0.003, PARAPET_H + 1.6);
    console.log(`[buildings] faces checked: fronts ${fronts.faces}, walls ${walls.faces}, trim on wall planes ${trim.faces}, roofs on wall planes ${roofs.faces}`);
    expect([...fronts.bad, ...walls.bad, ...trim.bad, ...roofs.bad]).toEqual([]);
    expect(fronts.faces).toBeGreaterThan(5000);
    expect(roofs.faces).toBeGreaterThan(1000);
  });

  it('raises the bank\'s doorway floor to its top step, so no pit opens between the steps and the doors', () => {
    const bank = W.layout.buildings.find((b) => b.special === 'bank')!;
    const door = city.entrances.get(bank.id)!;
    const r = bank.tiers[0]!;
    // Out of the wall at the door (+) and along it.
    // The highest level face under a probe point `o` m out of the wall (in, when negative) at the door.
    const top = (name: string, o: number) => {
      const [px, pz] = door.side === 'W' ? [r.minX - o, door.z] : door.side === 'E' ? [r.maxX + o, door.z] : door.side === 'N' ? [door.x, r.minZ - o] : [door.x, r.maxZ + o];
      let y = -Infinity;
      for (const m of meshes(city.group, name)) {
        const p = m.geometry.getAttribute('position');
        const n = m.geometry.getAttribute('normal');
        const idx = m.geometry.index!;
        for (let f = 0; f < idx.count; f += 3) {
          const v = [idx.getX(f), idx.getX(f + 1), idx.getX(f + 2)];
          if (n.getY(v[0]!) < 0.99) continue;
          const xs = v.map((k) => p.getX(k));
          const zs = v.map((k) => p.getZ(k));
          const fy = p.getY(v[0]!);
          if (px < Math.min(...xs) || px > Math.max(...xs) || pz < Math.min(...zs) || pz > Math.max(...zs) || fy > CURB_H + 1) continue;
          y = Math.max(y, fy);
        }
      }
      return y;
    };
    const steps = top('ground-decor', 0.15);
    const floor = top('storefronts', -0.25);
    expect(steps - CURB_H).toBeCloseTo(BANK_STEP_TOP, 3);
    expect(floor).toBeCloseTo(steps, 2);
  });

  it("puts balconies on the hotels' and some apartment blocks' street walls as buildBuildings selects them, within their depth, above the ground floor and any lower roof's coping, off the sign's wall", () => {
    const lm = new Set(landmarkTowers(W.layout).map((l) => l.id));
    let hotels = 0;
    let apartments = 0;
    const specials: string[] = [];
    for (const b of W.layout.buildings) {
      const every = balconyStep(b);
      if (every === 0 || lm.has(b.id)) continue;
      if (b.special) specials.push(b.special);
      const baseY = CURB_H + b.groundH;
      const cell = FACADE_CELL[b.style];
      for (const t of b.tiers) {
        const g = new GeoBuilder(true);
        const n = balconies(g, b, t, baseY, plainStreetSides(b), [1, 1, 1], every);
        if (b.style === 'hotel') hotels += n;
        else apartments += n;
        const p = g.build().getAttribute('position');
        const depth = BALCONY_DEPTH[b.style]!;
        const floor = t === b.tiers[0] ? baseY + cell.h - BALCONY_SLAB : t.y0 + PARAPET_H + COPING_H;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i);
          const z = p.getZ(i);
          const out = Math.max(t.minX - x, x - t.maxX, t.minZ - z, z - t.maxZ);
          expect(out).toBeLessThanOrEqual(depth + 1e-4);
          expect(p.getY(i), `building ${b.id}`).toBeGreaterThanOrEqual(floor - 1e-6);
          if (b.sign) {
            const past = { N: t.minZ - z, S: z - t.maxZ, W: t.minX - x, E: x - t.maxX }[b.sign.side];
            expect(past, `building ${b.id} sign wall`).toBeLessThanOrEqual(1e-3);
          }
        }
      }
    }
    console.log(`[buildings] hotel balconies ${hotels}, apartment balconies (every other window) ${apartments}, specials with balconies ${specials.join(',')}`);
    expect(specials).toEqual(['contactVera']);
    expect(hotels).toBeGreaterThan(100);
    expect(apartments).toBeGreaterThan(100);
  });

  it('hangs the string courses under the floor lines, so a balcony or landing floor covers their tops', () => {
    let lines = 0;
    for (const b of W.layout.buildings) {
      if (!['hotel', 'stucco', 'brick'].includes(b.style) || b.groundSides.length === 0) continue;
      const baseY = CURB_H + b.groundH;
      const cell = FACADE_CELL[b.style];
      for (const t of b.tiers) {
        const g = new GeoBuilder(true);
        facadeRelief(g, b, t, baseY, [1, 1, 1]);
        const geo = g.build();
        const p = geo.getAttribute('position');
        const idx = geo.index!;
        // The bands: faces running the length of a wall (the corner piers are 0.24 m wide).
        const bands: Array<[number, number]> = [];
        for (let f = 0; f < idx.count; f += 3) {
          const v = [idx.getX(f), idx.getX(f + 1), idx.getX(f + 2)];
          const span = Math.max(Math.max(...v.map((k) => p.getX(k))) - Math.min(...v.map((k) => p.getX(k))), Math.max(...v.map((k) => p.getZ(k))) - Math.min(...v.map((k) => p.getZ(k))));
          if (span > 1) bands.push([Math.min(...v.map((k) => p.getY(k))), Math.max(...v.map((k) => p.getY(k)))]);
        }
        for (let k = 1; baseY + k * cell.h < t.y1 - 0.8; k++) {
          const y = baseY + k * cell.h;
          if (Math.abs(y - t.y0) < 0.4) continue;
          lines++;
          for (const [lo, hi] of bands) expect(hi > y + 1e-3 && lo < y + 0.14, `building ${b.id} floor ${k}`).toBe(false);
        }
      }
    }
    expect(lines).toBeGreaterThan(500);
  });

  it("hangs every drawn fire escape's drop ladder at least 2.4 m over the pavement, clear of the shop awnings and the ground floor's cornice, within its landing's depth", () => {
    // An awning's top is SHOP_AWNING_TOP under the top of a 4.5 m shop band; the lowest landing stands ESCAPE_FLOOR over it.
    expect(LADDER_DROP - ESCAPE_FLOOR).toBeLessThan(SHOP_AWNING_TOP);
    let escapes = 0;
    for (const b of W.layout.buildings) {
      if (!hasFireEscape(b)) continue;
      const t = b.tiers[0]!;
      const baseY = CURB_H + b.groundH;
      const g = new GeoBuilder(true);
      if (fireEscape(g, b, t, baseY, plainStreetSides(b)) === 0) continue;
      escapes++;
      const p = g.build().getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        expect(p.getY(i) - CURB_H, `building ${b.id}`).toBeGreaterThanOrEqual(2.4);
        const out = Math.max(t.minX - p.getX(i), p.getX(i) - t.maxX, t.minZ - p.getZ(i), p.getZ(i) - t.maxZ);
        expect(out).toBeLessThanOrEqual(ESCAPE_DEPTH + 1e-4);
        // The cornice's lip over the ground floor: 0.10 to 0.17 m over the first storey's line, 0.24 m out.
        if (out < 0.25) expect(p.getY(i) > baseY + 0.1 && p.getY(i) < baseY + 0.17, `building ${b.id} lip`).toBe(false);
      }
    }
    console.log(`[buildings] fire escapes drawn ${escapes}`);
    expect(escapes).toBeGreaterThan(40);
  });

  it("shutters the houses' upper windows beside a window the facade draws, never in a street wall's ground floor or under the eaves", () => {
    // The shutters drawn (by their colour in the trim), each checked against the facade under it: the window
    // beside it is in a cell the shader paints a window in, at the uv of the drawn wall.
    const trimMeshes = meshes(city.group, 'architectural-trim');
    const walls = meshes(city.group, 'facade-house');
    const uvAt = (x: number, y: number, z: number): [number, number] | null => {
      for (const m of walls) {
        const p = m.geometry.getAttribute('position');
        const uv = m.geometry.getAttribute('uv');
        for (let i = 0; i + 3 < p.count; i += 4) {
          const [ax, ay, az, bx, bz, cy] = [p.getX(i), p.getY(i), p.getZ(i), p.getX(i + 1), p.getZ(i + 1), p.getY(i + 2)];
          const len = Math.hypot(bx - ax, bz - az);
          if (len < 1e-3) continue;
          const s = ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / len;
          const off = Math.abs((x - ax) * (bz - az) - (z - az) * (bx - ax)) / len;
          if (off > 0.03 || s < 0 || s > len || y < ay || y > cy) continue;
          const k = s / len;
          const h = (y - ay) / (cy - ay);
          return [uv.getX(i) + (uv.getX(i + 1) - uv.getX(i)) * k, uv.getY(i) + (uv.getY(i + 3) - uv.getY(i)) * h];
        }
      }
      return null;
    };
    let n = 0;
    const bad: string[] = [];
    for (const m of trimMeshes) {
      const p = m.geometry.getAttribute('position');
      const c = m.geometry.getAttribute('color');
      const isShutter = (k: number) => Math.abs(c.getX(k) - SHUTTER[0]) < 1e-4 && Math.abs(c.getY(k) - SHUTTER[1]) < 1e-4 && Math.abs(c.getZ(k) - SHUTTER[2]) < 1e-4;
      // Shutters are boxes of 20 vertices, drawn in runs among the other trim.
      for (let i = 0; i + 19 < p.count; ) {
        if (!isShutter(i)) {
          i++;
          continue;
        }
        const box = i;
        i += 20;
        let [x0, x1, y0, y1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
        for (let k = box; k < box + 20; k++) {
          [x0, x1, y0, y1, z0, z1] = [Math.min(x0, p.getX(k)), Math.max(x1, p.getX(k)), Math.min(y0, p.getY(k)), Math.max(y1, p.getY(k)), Math.min(z0, p.getZ(k)), Math.max(z1, p.getZ(k))];
        }
        // The wall's plane is 2 cm inside one face of the shutter (whichever has a wall); the window is 0.25 m past one end.
        const alongX = x1 - x0 > z1 - z0;
        const wy = (y0 + y1) / 2;
        let found = false;
        for (const sgn of [-1, 1]) {
          for (const pl of alongX ? [z0 + 0.02, z1 - 0.02] : [x0 + 0.02, x1 - 0.02]) {
            const px = alongX ? (sgn < 0 ? x0 - 0.25 : x1 + 0.25) : pl;
            const pz = alongX ? pl : sgn < 0 ? z0 - 0.25 : z1 + 0.25;
            const uv = uvAt(px, wy, pz);
            if (!uv) continue;
            const col = ((Math.floor(uv[0] * FACADE_COLS) % FACADE_COLS) + FACADE_COLS) % FACADE_COLS;
            const row = FACADE_ROWS - 1 - (((Math.floor(uv[1] * FACADE_ROWS) % FACADE_ROWS) + FACADE_ROWS) % FACADE_ROWS);
            if (facadeWindowAt('house', col, row)) found = true;
          }
        }
        n++;
        if (!found && bad.length < 5) bad.push(`${x0.toFixed(2)},${wy.toFixed(2)},${z0.toFixed(2)}`);
      }
    }
    console.log(`[buildings] shutters drawn ${n}`);
    expect(bad).toEqual([]);
    expect(n).toBeGreaterThan(300);
  });

  it("carries each wall's roof in its seed, so the shader knows where the cornice is: no facade vertex above it", () => {
    let quads = 0;
    const bad: string[] = [];
    for (const m of meshes(city.group).filter((o) => o.name.startsWith('facade-'))) {
      const p = m.geometry.getAttribute('position');
      const seed = m.geometry.getAttribute('aSeed');
      for (let i = 0; i < p.count; i += 4) {
        const roof = Math.floor(seed.getX(i)) / FACADE_TOP_SCALE;
        quads++;
        for (let k = i; k < i + 4 && k < p.count; k++) if (p.getY(k) > roof + 0.06 && bad.length < 5) bad.push(`${m.name} y ${p.getY(k).toFixed(2)} roof ${roof}`);
      }
    }
    expect(bad).toEqual([]);
    expect(quads).toBeGreaterThan(1000);
  });

  it('keeps every window head clear of its cornice or eaves, and fits the houses\' top windows under the eaves where they still stand 0.75 m tall', () => {
    // The cornice reaches 0.34 m under the roof (cityArchitecture.facadeRelief), the eaves' fascia 0.28 m.
    for (const [style, top] of Object.entries(FACADE_TOP)) expect(top.headroom, style).toBeGreaterThanOrEqual(style === 'house' ? 0.3 : 0.4);
    let cutBefore = 0;
    let dropped = 0;
    let houseTop = 0;
    let houseKept = 0;
    for (const b of W.layout.buildings) {
      if (b.district === 'country') continue;
      const baseY = CURB_H + (b.groundSides.length > 0 ? b.groundH : 0);
      const cell = FACADE_CELL[b.style];
      const win = FACADE_WINDOW[b.style];
      for (const t of b.tiers) {
        for (let k = Math.max(0, Math.floor((t.y0 - baseY) / cell.h)); baseY + k * cell.h + win.y0 * cell.h < t.y1; k++) {
          const y0 = baseY + k * cell.h;
          const fit = facadeWindowFit(b.style, y0, t.y1);
          const painted = y0 + win.y1 * cell.h;
          if (painted > t.y1 - 0.34 && y0 + win.y0 * cell.h < t.y1) cutBefore++;
          if (b.style === 'house' && painted > t.y1 - FACADE_TOP.house.headroom) {
            houseTop++;
            if (fit) houseKept++;
          }
          if (!fit) {
            dropped++;
            continue;
          }
          expect(y0 + fit.y1, `building ${b.id}`).toBeLessThanOrEqual(t.y1 - FACADE_TOP[b.style].headroom + 0.051);
          expect(fit.y1 - fit.y0).toBeGreaterThanOrEqual(Math.min(HOUSE_FIT_MIN_H, (win.y1 - win.y0) * cell.h) - 1e-9);
          if (b.style === 'house') expect(fit.y0).toBeGreaterThanOrEqual(0.3 - 1e-9);
        }
      }
    }
    console.log(`[buildings] window rows the cornice or eaves cut before ${cutBefore}, rows left out ${dropped}, houses' top windows fitted ${houseKept} of ${houseTop}`);
    expect(cutBefore).toBeGreaterThan(100);
    // The rest showed a sliver of window under the eaves, less than HOUSE_FIT_MIN_H once lowered.
    expect(houseKept / houseTop).toBeGreaterThan(0.4);
  });

  it('builds a stone podium under every three-tier glass tower, its office seed set to a pier at every bay', () => {
    for (let k = 0; k < 1000; k++) {
      const e = Math.round(everyBay(k / 1000) * 1000);
      expect(e % 3).toBe(2);
      expect(e).toBeLessThan(1000);
      expect(Math.abs(e - k)).toBeLessThanOrEqual(3);
    }
    const office = meshes(city.group, 'facade-office')[0]!.geometry.getAttribute('position');
    const towers = W.layout.buildings.filter((b) => (b.style === 'glassBlue' || b.style === 'glassTeal') && b.tiers.length >= 3);
    expect(towers.length).toBeGreaterThan(5);
    for (const b of towers.slice(0, 8)) {
      const t = b.tiers[0]!;
      let n = 0;
      for (let i = 0; i < office.count; i++) if (office.getX(i) >= t.minX - 1e-3 && office.getX(i) <= t.maxX + 1e-3 && office.getZ(i) >= t.minZ - 1e-3 && office.getZ(i) <= t.maxZ + 1e-3 && office.getY(i) <= t.y1 + 1e-3) n++;
      expect(n, `tower ${b.id}`).toBeGreaterThanOrEqual(16);
    }
  });

  it('puts a plant penthouse on most office and glass towers of eight storeys or more', () => {
    const lm = new Set(landmarkTowers(W.layout).map((l) => l.id));
    const towers = W.layout.buildings.filter((b) => ['office', 'glassBlue', 'glassTeal'].includes(b.style) && b.roof !== 'gable' && storeys(b) >= 8 && !lm.has(b.id));
    const with_ = towers.filter((b) => rooftopItems(b).some((it) => it.kind === 'plant'));
    console.log(`[buildings] towers of 8+ storeys ${towers.length}, with a plant penthouse ${with_.length}`);
    expect(with_.length / towers.length).toBeGreaterThan(0.8);
  });
});
