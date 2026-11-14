// AzuraLink drawn: the beam and its pylons (one mesh), the two stations (platforms under a canopy, stair towers and a sign
// counting down to the next train) and the three-car train, moved each frame to where the timetable puts it (sim time,
// world/monorail.ts), with lit windows and an underglow after dark and doors that open on the platform side while it
// stands at a station. A dozen draws in all; the light pool the train throws on the canal is the tier's (railGlow).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { formatTime, smoothstep } from '../core/math';
import { SEABED_Y, WATER_Y } from '../world/constants';
import { BEAM_OVERRUN, CAR_GAP, CAR_HEIGHT, CAR_LENGTH, CAR_WIDTH, nextDeparture, PLATFORM_SLAB, TOWER_H, TRAIN_DWELL, TRAIN_LENGTH, trainAt, type Monorail, type MonorailStation } from '../world/monorail';
import type { Rect } from '../world/layout';
import type { StaticWorld } from '../world/staticWorld';
import { GeoBuilder, type RGB } from './geo';
import { groundSurface } from './textures';
import { canvas, toTexture } from './textures/misc';

/** The beam's section (m): its width and depth under the running surface. */
const BEAM_W = 0.9;
const BEAM_D = 1.5;
/** A pylon's radius (its collider's, world/staticWorld.ts) and the depth of the head the beam rests on. */
const PYLON_R = 0.9;
const HEAD_D = 1;
/** The canopy over a platform, from this high over its floor (m). */
const CANOPY_Y = 3.4;
/** Seconds the doors take to open once the train has stopped, and to close before it leaves. */
const DOORS_OPEN = 1.5;
const DOORS_CLOSE = 2;
/** Each car's two doors per side, their middles this far (m) from the car's, each of two leaves. */
const DOOR_AT = 2.6;
const LEAF_W = 0.7;
const LEAF_H = 2.15;
/** The livery. */
const WHITE: RGB = [0.92, 0.93, 0.94];
const TEAL: RGB = [0.02, 0.55, 0.6];
const SKIRT: RGB = [0.16, 0.18, 0.2];
const ROOF: RGB = [0.62, 0.65, 0.68];
const GLASS_DARK: RGB = [0.08, 0.1, 0.12];
/** The nose's windscreen, painted on its shell: near black, as the shell's sheen lifts it (0.08 read light grey). */
const WINDSCREEN: RGB = [0.008, 0.01, 0.014];
/** The concrete's tints: the beam and towers, the pylons, a door's dark opening, the platform's yellow line. */
const BEAM: RGB = [0.86, 0.86, 0.84];
const PIER: RGB = [0.74, 0.74, 0.72];
const OPENING: RGB = [0.1, 0.1, 0.11];
const SAFETY: RGB = [0.95, 0.78, 0.12];
/** The sign over a tower's door: its size, how far it stands out from the wall, and its bottom edge (m). */
const SIGN_W = 5;
const SIGN_H = 1.9;
const SIGN_D = 0.12;
const SIGN_Y = 2.8;

/** A prism of `sides` faces round (cx, cz), radius r, from y0 to y1. */
function prism(g: GeoBuilder, cx: number, cz: number, r: number, y0: number, y1: number, sides: number, color: RGB): void {
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const x0 = cx + Math.cos(a0) * r;
    const z0 = cz - Math.sin(a0) * r;
    const x1 = cx + Math.cos(a1) * r;
    const z1 = cz - Math.sin(a1) * r;
    g.wall(x0, z0, x1, z1, y0, y1, { kind: 'world', scale: 3 }, color, (i * 2 * Math.PI * r) / sides);
  }
}

const box = (g: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: RGB = WHITE, bottom = false) =>
  g.box(Math.min(x0, x1), y0, Math.min(z0, z1), Math.max(x0, x1), y1, Math.max(z0, z1), { uv: { kind: 'world', scale: 3 }, color, bottom });

/** The car body's half-section from the skirt's top round to the roof's crown (x out from the middle, y up from the beam). */
function bodySection(hw: number): Array<[number, number]> {
  return [[hw - 0.12, 0.05], [hw - 0.02, 0.14], [hw, 0.3], [hw, 2.5], [hw - 0.05, 2.68], [hw - 0.2, 2.86], [hw - 0.45, 2.99], [hw - 0.85, CAR_HEIGHT - 0.02], [0, CAR_HEIGHT]];
}

/**
 * The car's shell lofted along z through `rings` (each a z, a scale across, and a height the section's top is squeezed
 * to): the half-section mirrored, smooth across its curve, with a vertex colour from `paint(x, y, ring)`. The shell is
 * open at its ends; the noses close themselves and the gangways cover the rest.
 */
function shell(rings: ReadonlyArray<{ z: number; sx: number; top: number }>, hw: number, y0: number, paint: (x: number, y: number, ring: number) => RGB): THREE.BufferGeometry {
  const half = bodySection(hw);
  // Turn round: from the left skirt up over the roof and down to the right skirt.
  const pts: Array<[number, number]> = [...half.map(([x, y]) => [-x, y] as [number, number]), ...half.slice(0, -1).reverse()];
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const n = pts.length;
  rings.forEach((r, ri) => {
    const squeeze = (y: number) => (y <= 1.3 ? y : 1.3 + (y - 1.3) * ((r.top - 1.3) / (CAR_HEIGHT - 1.3)));
    for (let k = 0; k < n; k++) {
      const [x, y] = pts[k]!;
      const [xp, yp] = pts[Math.max(0, k - 1)]!;
      const [xn, yn] = pts[Math.min(n - 1, k + 1)]!;
      // The profile's outward normal: its tangent turned a quarter (the profile runs over the top from -x to +x).
      let nx = -(yn - yp);
      let ny = xn - xp;
      const l = Math.hypot(nx, ny) || 1;
      nx /= l;
      ny /= l;
      const yy = squeeze(y);
      pos.push(x * r.sx, y0 + yy, r.z);
      nrm.push(nx, ny, 0);
      const c = paint(x, yy, ri);
      col.push(c[0], c[1], c[2]);
      uv.push(0, 0);
    }
    if (ri === 0) return;
    const a = (ri - 1) * n;
    const b = ri * n;
    const forward = r.z > rings[ri - 1]!.z;
    for (let k = 0; k + 1 < n; k++) {
      if (forward) idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
      else idx.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  // Along a nose the shell narrows and falls: its normals from the surface itself, so they lean forward (the profile's
  // alone face up there, and the sky's sheen at that grazing angle lit the windscreen light grey). Where the tip's
  // squeezed rows leave a vertex no area round it, the profile's normal stays.
  if (rings.length > 2) {
    const own = g.getAttribute('normal').clone();
    g.computeVertexNormals();
    const n = g.getAttribute('normal');
    for (let i = 0; i < n.count; i++) {
      const l = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
      if (!(l > 0.5)) n.setXYZ(i, own.getX(i), own.getY(i), own.getZ(i));
    }
  }
  return g;
}

/** What a station's sign says at sim time `t`. */
export function signLine(m: Monorail, station: number, t: number): string {
  const s = trainAt(m, t);
  return s.station === station ? `Now boarding ${formatTime(s.dwell)}` : `Next train ${formatTime(nextDeparture(m, station, t))}`;
}

/** How far the doors stand open (0 shut .. 1 open) `dwell` seconds before the train leaves a station. */
export function doorsOpen(dwell: number): number {
  if (dwell <= 0) return 0;
  return Math.min(smoothstep(TRAIN_DWELL, TRAIN_DWELL - DOORS_OPEN, dwell), smoothstep(0, DOORS_CLOSE, dwell));
}

interface Sign {
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  face: THREE.MeshStandardMaterial;
  name: string;
  text: string;
}

export class MonorailView {
  readonly group = new THREE.Group();
  /** The train, at the beam's line; its z follows the timetable. */
  readonly train = new THREE.Group();
  private readonly concrete: THREE.MeshStandardMaterial;
  private readonly steel = new THREE.MeshStandardMaterial({ color: 0x37414b, roughness: 0.45, metalness: 0.55 });
  /** The platforms' light strips and the towers' stair windows: dark glass by day, lit after dark. */
  private readonly lit = new THREE.MeshStandardMaterial({ color: 0x24303a, roughness: 0.2, metalness: 0.4, emissive: 0xffe4b5, emissiveIntensity: 0 });
  private readonly glazing = new THREE.MeshStandardMaterial({ color: 0x2c3e4a, roughness: 0.08, metalness: 0.7, emissive: 0xffd9a0, emissiveIntensity: 0 });
  private readonly body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.25 });
  private readonly windows = new THREE.MeshStandardMaterial({ color: 0x2a3e4c, roughness: 0.1, metalness: 0.6, emissive: 0xffe0a6, emissiveIntensity: 0 });
  /** The lamps at either end: white ahead, red behind, by the way it runs. */
  private readonly northLamps = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, emissive: 0xffffff, emissiveIntensity: 0 });
  private readonly southLamps = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, emissive: 0xffffff, emissiveIntensity: 0 });
  private readonly glow = new THREE.MeshBasicMaterial({ color: 0x000000 });
  private readonly pool: THREE.Mesh;
  /** The tier's railGlow: the pool shows when it is on and after dark (an additive plane at opacity 0 still draws). */
  private poolOn = true;
  private readonly doors: THREE.InstancedMesh;
  private readonly signs: Sign[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly line: Monorail;
  private doorOpen = -1;
  private doorSide = 0;
  private night = -1;
  private lampDir = 0;

  constructor(world: StaticWorld) {
    const m = world.layout.monorail;
    this.line = m;
    this.group.name = 'monorail';
    const surface = groundSurface('concrete', 7);
    this.concrete = new THREE.MeshStandardMaterial({ map: surface.map, roughnessMap: surface.rough, normalMap: surface.normal, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 1, vertexColors: true });
    this.addStatic(this.buildLine(m), this.concrete, 'monorail-beam', true);
    const st = new GeoBuilder(true);
    const steel = new GeoBuilder(false);
    const lit = new GeoBuilder(false);
    const glass = new GeoBuilder(false);
    for (const s of m.stations) this.buildStation(m, s, st, steel, lit, glass);
    this.addStatic(st.build(), this.concrete, 'monorail-stations', true);
    this.addStatic(steel.build(), this.steel, 'monorail-steel', true);
    this.addStatic(lit.build(), this.lit, 'monorail-lights', false);
    this.addStatic(glass.build(), this.glazing, 'monorail-glazing', false);
    m.stations.forEach((s, i) => this.addSign(m, s, i));

    this.train.name = 'monorail-train';
    this.train.position.set(m.x, 0, m.z0);
    const { body, windows, north, south, glow } = this.buildTrain(m.beamY);
    this.addTo(this.train, body, this.body, 'train-body', true);
    this.addTo(this.train, windows, this.windows, 'train-windows', false);
    this.addTo(this.train, north, this.northLamps, 'train-lamps-north', false);
    this.addTo(this.train, south, this.southLamps, 'train-lamps-south', false);
    this.addTo(this.train, glow, this.glow, 'train-underglow', false);
    const leaf = new GeoBuilder(true);
    box(leaf, -0.02, -LEAF_H / 2, -LEAF_W / 2, 0.02, LEAF_H / 2, LEAF_W / 2, WHITE);
    box(leaf, -0.035, 0.05, -LEAF_W / 2 + 0.1, 0.035, LEAF_H / 2 - 0.15, LEAF_W / 2 - 0.1, GLASS_DARK);
    this.doors = new THREE.InstancedMesh(leaf.build(), this.body, 3 * 2 * 2 * 2);
    this.doors.name = 'train-doors';
    this.doors.castShadow = true;
    this.doors.frustumCulled = false;
    this.train.add(this.doors);
    this.setDoors(0, 1);
    // The light the underglow throws on the water under the train.
    const poolTex = this.poolTexture();
    this.pool = new THREE.Mesh(new THREE.PlaneGeometry(9, TRAIN_LENGTH + 8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: poolTex, color: 0x5fe8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.pool.name = 'train-pool';
    this.pool.position.y = WATER_Y + 0.3;
    this.pool.renderOrder = 2;
    this.train.add(this.pool);
    this.group.add(this.train);
  }

  private addStatic(geo: THREE.BufferGeometry, mat: THREE.Material, name: string, shadow: boolean): void {
    const mesh = this.addTo(this.group, geo, mat, name, shadow);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }

  private addTo(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, name: string, shadow: boolean): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /** The beam from end to end and every pylon under it, with the head it rests on. */
  private buildLine(m: Monorail): THREE.BufferGeometry {
    const g = new GeoBuilder(true);
    const top = m.beamY;
    const z0 = m.z0 - TRAIN_LENGTH / 2 - BEAM_OVERRUN;
    const z1 = m.z1 + TRAIN_LENGTH / 2 + BEAM_OVERRUN;
    box(g, m.x - BEAM_W / 2, top - BEAM_D, z0, m.x + BEAM_W / 2, top, z1, BEAM, true);
    // The running surface the train's tyres have darkened, and the expansion joints over the pylons.
    box(g, m.x - BEAM_W / 2 + 0.06, top, z0, m.x + BEAM_W / 2 - 0.06, top + 0.01, z1, [0.42, 0.42, 0.41]);
    for (const p of m.pylons) box(g, m.x - BEAM_W / 2 - 0.01, top - BEAM_D, p.z - 0.03, m.x + BEAM_W / 2 + 0.01, top + 0.012, p.z + 0.03, [0.3, 0.3, 0.3]);
    const under = top - BEAM_D;
    for (const p of m.pylons) {
      prism(g, p.x, p.z, PYLON_R, SEABED_Y, under - HEAD_D, 10, PIER);
      // Under a platform the head reaches out beneath it, a post holding the platform's slab.
      const s = m.stations.find((st) => p.z > st.platform[0]!.minZ && p.z < st.platform[0]!.maxZ);
      const reach = s ? s.side * (CAR_WIDTH / 2 + 2.6) : 0;
      // A hammerhead: the slab the beam bears on over a haunch tapering down into the column, two dark bearing pads.
      const x0 = p.x - 1.3 + Math.min(0, reach);
      const x1 = p.x + 1.3 + Math.max(0, reach);
      box(g, x0, under - HEAD_D * 0.45, p.z - 0.7, x1, under, p.z + 0.7, PIER, true);
      const hy = under - HEAD_D * 0.45;
      const ly = under - HEAD_D * 1.4;
      const c = (x: number, yy: number, z: number) => [x, yy, z] as const;
      const haunch: Array<[readonly [number, number, number], readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]]> = [
        [c(x0, hy, p.z - 0.7), c(x1, hy, p.z - 0.7), c(p.x + PYLON_R, ly, p.z - 0.6), c(p.x - PYLON_R, ly, p.z - 0.6)],
        [c(x1, hy, p.z + 0.7), c(x0, hy, p.z + 0.7), c(p.x - PYLON_R, ly, p.z + 0.6), c(p.x + PYLON_R, ly, p.z + 0.6)],
        [c(x1, hy, p.z - 0.7), c(x1, hy, p.z + 0.7), c(p.x + PYLON_R, ly, p.z + 0.6), c(p.x + PYLON_R, ly, p.z - 0.6)],
        [c(x0, hy, p.z + 0.7), c(x0, hy, p.z - 0.7), c(p.x - PYLON_R, ly, p.z - 0.6), c(p.x - PYLON_R, ly, p.z + 0.6)],
      ];
      for (const [a, b, d, e] of haunch) g.quad(...a, ...b, ...d, ...e, [0, 0, 1, 0, 1, 1, 0, 1], PIER);
      for (const dz of [-0.35, 0.35]) box(g, m.x - BEAM_W / 2 - 0.05, under - 0.12, p.z + dz - 0.2, m.x + BEAM_W / 2 + 0.05, under + 0.001, p.z + dz + 0.2, SKIRT);
      if (s) box(g, p.x + reach - 0.4, under, p.z - 0.4, p.x + reach + 0.4, top - PLATFORM_SLAB, p.z + 0.4, PIER);
    }
    return g.build();
  }

  /** A station: platform and walkway slabs, the canopy on its posts, railings, the tower with its doors and glazing. */
  private buildStation(m: Monorail, s: MonorailStation, g: GeoBuilder, steel: GeoBuilder, lit: GeoBuilder, glass: GeoBuilder): void {
    const y = m.beamY;
    const [plat, walk] = s.platform as [Rect, Rect];
    const edge = s.side > 0 ? plat.minX : plat.maxX;
    const outer = s.side > 0 ? plat.maxX : plat.minX;
    for (const r of s.platform) box(g, r.minX, y - PLATFORM_SLAB, r.minZ, r.maxX, y, r.maxZ, BEAM, true);
    // The yellow line along the platform's edge.
    box(g, edge + s.side * 0.15, y, plat.minZ + 0.3, edge + s.side * 0.45, y + 0.03, plat.maxZ - 0.3, SAFETY);
    // The canopy, reaching out over the gap to the train, on posts along the outer edge; its light strip under it.
    const cy = y + CANOPY_Y;
    box(steel, edge - s.side * 0.6, cy, plat.minZ, outer + s.side * 0.3, cy + 0.18, plat.maxZ, WHITE, true);
    for (let z = plat.minZ + 0.6; z <= plat.maxZ - 0.5; z += (plat.maxZ - plat.minZ - 1.2) / 5) {
      if (z > walk.minZ - 0.3 && z < walk.maxZ + 0.3) continue;
      box(steel, outer - s.side * 0.35, y, z - 0.09, outer - s.side * 0.17, cy, z + 0.09);
    }
    box(lit, (edge + outer) / 2 - 0.2, cy - 0.05, plat.minZ + 1, (edge + outer) / 2 + 0.2, cy, plat.maxZ - 1, WHITE, true);
    // Railings: the platform's outer edge either side of the walkway and its two ends, the walkway's two sides.
    const rail = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(1, Math.round(len / 1.8));
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const z = z0 + ((z1 - z0) * k) / n;
        box(steel, x - 0.03, y, z - 0.03, x + 0.03, y + 1.05, z + 0.03, WHITE);
      }
      for (const h of [0.5, 1.05]) box(steel, Math.min(x0, x1) - 0.03, y + h - 0.04, Math.min(z0, z1) - 0.03, Math.max(x0, x1) + 0.03, y + h + 0.02, Math.max(z0, z1) + 0.03, WHITE);
    };
    const ox = outer - s.side * 0.1;
    rail(ox, plat.minZ + 0.1, ox, walk.minZ);
    rail(ox, walk.maxZ, ox, plat.maxZ - 0.1);
    rail(edge + s.side * 0.6, plat.minZ + 0.1, ox, plat.minZ + 0.1);
    rail(edge + s.side * 0.6, plat.maxZ - 0.1, ox, plat.maxZ - 0.1);
    const wx0 = outer;
    const wx1 = s.side > 0 ? walk.maxX : walk.minX;
    rail(wx0, walk.minZ + 0.1, wx1, walk.minZ + 0.1);
    rail(wx0, walk.maxZ - 0.1, wx1, walk.maxZ - 0.1);
    // The tower: a parapet round its roof over the line's teal band, slots of stair windows, the door at the foot of the
    // stairs on the side away from the canal (under the sign, addSign) and the one onto the walkway.
    const t = s.tower;
    box(g, t.minX, 0, t.minZ, t.maxX, TOWER_H - 1.4, t.maxZ, BEAM);
    box(g, t.minX - 0.04, TOWER_H - 1.4, t.minZ - 0.04, t.maxX + 0.04, TOWER_H - 0.7, t.maxZ + 0.04, TEAL);
    box(g, t.minX, TOWER_H - 0.7, t.minZ, t.maxX, TOWER_H, t.maxZ, BEAM);
    box(g, t.minX - 0.15, TOWER_H, t.minZ - 0.15, t.maxX + 0.15, TOWER_H + 0.5, t.maxZ + 0.15, PIER);
    const far = s.side > 0 ? t.maxX : t.minX;
    const tz = (t.minZ + t.maxZ) / 2;
    box(g, far, 0.15, tz - 0.9, far + s.side * 0.05, 2.55, tz + 0.9, OPENING);
    // The sign's steel back plate (its printed face is addSign's).
    box(steel, far, SIGN_Y, tz - SIGN_W / 2, far + s.side * SIGN_D, SIGN_Y + SIGN_H, tz + SIGN_W / 2);
    const wallX = s.side > 0 ? t.minX : t.maxX;
    box(g, wallX, y, walk.minZ + 0.6, wallX - s.side * 0.05, y + 2.4, walk.maxZ - 0.6, OPENING);
    box(glass, far, 5.2, tz - 0.6, far + s.side * 0.05, TOWER_H - 2, tz + 0.6, WHITE);
    // Toward the city.
    const land = -Math.sign(s.z);
    const face = land > 0 ? t.maxZ : t.minZ;
    const fx = (t.minX + t.maxX) / 2;
    for (const dx of [-1.8, 1.8]) box(glass, fx + dx - 0.45, 1.4, face, fx + dx + 0.45, TOWER_H - 2, face + land * 0.05, WHITE);
  }

  /** The printed face of the sign over a tower's door: the line's name, the station's, and the next train. */
  private addSign(m: Monorail, s: MonorailStation, i: number): void {
    const [c, ctx] = canvas(512, 192);
    const texture = toTexture(c, true, false);
    const face = new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: 0.5, roughness: 0.6 });
    const sign: Sign = { ctx, texture, face, name: s.name.toUpperCase(), text: '' };
    this.signs.push(sign);
    this.drawSign(sign, signLine(m, i, 0));
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(SIGN_W, SIGN_H), face);
    panel.name = 'monorail-sign';
    const t = s.tower;
    panel.position.set((s.side > 0 ? t.maxX : t.minX) + s.side * (SIGN_D + 0.02), SIGN_Y + SIGN_H / 2, (t.minZ + t.maxZ) / 2);
    panel.rotation.y = (s.side * Math.PI) / 2;
    panel.matrixAutoUpdate = false;
    panel.updateMatrix();
    this.group.add(panel);
  }

  private drawSign(s: Sign, text: string): void {
    s.text = text;
    const ctx = s.ctx;
    ctx.fillStyle = '#0c1a24';
    ctx.fillRect(0, 0, 512, 192);
    ctx.fillStyle = '#0aa5ad';
    ctx.fillRect(0, 0, 512, 76);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 58px Anton, Impact, "Arial Black", sans-serif';
    ctx.fillText('AzuraLink', 18, 40, 330);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffd23d';
    ctx.fillText('$5', 494, 40, 120);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#d8e6ee';
    ctx.font = '600 34px Rajdhani, "Arial Narrow", sans-serif';
    ctx.fillText(s.name, 18, 102, 476);
    ctx.fillStyle = '#ffb02e';
    ctx.font = '700 44px "Courier New", monospace';
    ctx.fillText(text, 18, 152, 476);
    s.texture.needsUpdate = true;
  }

  /** The three cars nose to tail along local z (north first), with their windows, the lamps at both ends and the underglow. */
  private buildTrain(y: number): { body: THREE.BufferGeometry; windows: THREE.BufferGeometry; north: THREE.BufferGeometry; south: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
    const body = new GeoBuilder(true);
    const win = new GeoBuilder(false);
    const north = new GeoBuilder(false);
    const south = new GeoBuilder(false);
    const glow = new GeoBuilder(false);
    const hw = CAR_WIDTH / 2;
    const top = y + CAR_HEIGHT;
    const shells: THREE.BufferGeometry[] = [];
    /** A flat panel closing the shell's section at z, facing `d` (squeezed to `squash` across and `roof` tall at a nose's tip). */
    const endCap = (g: GeoBuilder, z: number, d: number, squash = 1, roof = CAR_HEIGHT) => {
      const half = bodySection(hw).map(([x, yy]) => [x * squash, yy <= 1.3 ? yy : 1.3 + (yy - 1.3) * ((roof - 1.3) / (CAR_HEIGHT - 1.3))] as const);
      const pts = [...half.map(([x, yy]) => [-x, yy] as const), ...half.slice(0, -1).reverse()];
      const cy = y + 0.7;
      for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, ay] = pts[k]!;
        const [bx, by] = pts[k + 1]!;
        // Where the nose's tip squeezes the section flat, its triangles have no area (and no normal): left out.
        if (Math.abs(ax * (by - 0.7) - bx * (ay - 0.7)) < 1e-6) continue;
        if (d > 0) g.tri(0, cy, z, bx, y + by, z, ax, y + ay, z, [0, 0, 0, 0, 0, 0], WHITE);
        else g.tri(0, cy, z, ax, y + ay, z, bx, y + by, z, [0, 0, 0, 0, 0, 0], WHITE);
      }
    };
    const wy0 = y + 1.15;
    const wy1 = y + 2.35;
    for (let k = 0; k < 3; k++) {
      const cz = (k - 1) * (CAR_LENGTH + CAR_GAP);
      const za = cz - CAR_LENGTH / 2;
      const zb = cz + CAR_LENGTH / 2;
      // A nose on the outer end of either end car.
      const noseA = k === 0;
      const noseB = k === 2;
      const ba = noseA ? za + 2.2 : za;
      const bb = noseB ? zb - 2.2 : zb;
      // The shell along the car, its roof's curve grey, closed flat where a gangway meets it.
      shells.push(shell([{ z: ba, sx: 1, top: CAR_HEIGHT }, { z: bb, sx: 1, top: CAR_HEIGHT }], hw, y, (_x, yy) => (yy > 2.62 ? ROOF : WHITE)));
      if (!noseA) endCap(body, za, -1);
      if (!noseB) endCap(body, zb, 1);
      box(body, -0.7, top, cz - 1.6, 0.7, top + 0.32, cz + 1.6, ROOF);
      for (const s of [-1, 1]) {
        // Skirts down either side of the beam, the livery's stripe, and the window band between the doors.
        box(body, s * 0.55, y - 0.95, za + 0.4, s * hw, y + 0.05, zb - 0.4, SKIRT);
        box(body, s * hw, y + 0.8, za + (noseA ? 0.3 : 0.1), s * (hw + 0.04), y + 1.05, zb - (noseB ? 0.3 : 0.1), TEAL);
        const gaps = [cz - DOOR_AT - LEAF_W - 0.1, cz - DOOR_AT + LEAF_W + 0.1, cz + DOOR_AT - LEAF_W - 0.1, cz + DOOR_AT + LEAF_W + 0.1];
        const panes: Array<[number, number]> = [[ba + 0.4, gaps[0]!], [gaps[1]!, gaps[2]!], [gaps[3]!, bb - 0.4]];
        for (const [p0, p1] of panes) box(win, s * hw, wy0, p0, s * (hw + 0.04), wy1, p1, WHITE);
        box(glow, s * (hw - 0.1), y - 0.99, za + 0.5, s * (hw + 0.02), y - 0.93, zb - 0.5, WHITE);
      }
      for (const [nose, zEnd, zBody, lamps] of [[noseA, za, ba, north], [noseB, zb, bb, south]] as const) {
        if (!nose) continue;
        const d = Math.sign(zEnd - zBody);
        // The nose: the shell drawn on 2.2 m, narrowing a little and its roof falling in a quarter ellipse to the
        // headlamps' panel, the windscreen dark across its upper half; a flat panel closes its tip.
        const rings = [0, 0.3, 0.55, 0.75, 0.9, 1].map((t) => ({ z: zBody + d * 2.2 * t, sx: 1 - 0.12 * t * t, top: 1.3 + (CAR_HEIGHT - 1.3) * Math.sqrt(Math.max(0, 1 - t * t)) }));
        shells.push(shell(rings, hw, y, (x, yy, ri) => (ri >= 1 && ri <= 4 && yy > 1.5 && Math.abs(x) < hw - 0.25 ? WINDSCREEN : yy > 2.62 ? ROOF : WHITE)));
        endCap(body, zEnd, d, 1 - 0.12, 1.3);
        for (const s of [-1, 1]) box(lamps, s * 0.6, y + 0.6, zEnd, s * 1.15, y + 0.85, zEnd + d * 0.05);
        box(lamps, -0.35, y + 1.05, zEnd, 0.35, y + 1.2, zEnd + d * 0.05);
      }
      // The gangway to the next car.
      if (k < 2) box(body, -1, y + 0.2, zb, 1, y + 2.6, zb + CAR_GAP, SKIRT);
    }
    const merged = mergeGeometries([body.build(), ...shells], false);
    if (!merged) throw new Error('mergeGeometries failed');
    return { body: merged, windows: win.build(), north: north.build(), south: south.build(), glow: glow.build() };
  }

  private poolTexture(): THREE.CanvasTexture {
    const [c, ctx] = canvas(64, 128);
    const g = ctx.createRadialGradient(32, 64, 4, 32, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 128);
    return toTexture(c, true, false);
  }

  /** The doors' leaves, `open` of the way open on the platform's `side` (1 east, -1 west); shut on the other. */
  private setDoors(open: number, side: number): void {
    if (open === this.doorOpen && side === this.doorSide) return;
    this.doorOpen = open;
    this.doorSide = side;
    const y = this.line.beamY + 0.1 + LEAF_H / 2;
    let i = 0;
    for (let k = 0; k < 3; k++) {
      const cz = (k - 1) * (CAR_LENGTH + CAR_GAP);
      for (const s of [-1, 1]) {
        const o = s === side ? open : 0;
        for (const d of [-1, 1]) {
          for (const l of [-1, 1]) {
            this.matrix.makeTranslation(s * (CAR_WIDTH / 2 + 0.07), y, cz + d * DOOR_AT + l * (LEAF_W / 2 + 0.95 * LEAF_W * o));
            this.doors.setMatrixAt(i++, this.matrix);
          }
        }
      }
    }
    this.doors.instanceMatrix.needsUpdate = true;
  }

  /** The pool of light under the train on the canal (the tier's railGlow). */
  setGlow(on: boolean): void {
    this.poolOn = on;
    this.pool.visible = on && this.night > 0.01;
  }

  /** Places the train at sim time `t`, opens its doors at a station, lights it by `night` (0 day .. 1 night) and updates the signs. */
  update(t: number, night: number): void {
    const m = this.line;
    const s = trainAt(m, t);
    this.train.position.z = s.z;
    this.setDoors(doorsOpen(s.dwell), s.station < 0 ? 0 : m.stations[s.station]!.side);
    if (s.dir !== this.lampDir) {
      this.lampDir = s.dir;
      this.northLamps.emissive.setHex(s.dir < 0 ? 0xffffff : 0xff2a1a);
      this.southLamps.emissive.setHex(s.dir > 0 ? 0xffffff : 0xff2a1a);
    }
    if (Math.abs(night - this.night) > 0.01) {
      this.night = night;
      this.windows.emissiveIntensity = night * 1.5;
      this.lit.emissiveIntensity = night * 2.2;
      this.glazing.emissiveIntensity = night * 0.55;
      this.northLamps.emissiveIntensity = 0.4 + night * 2.6;
      this.southLamps.emissiveIntensity = 0.4 + night * 2.6;
      this.glow.color.setRGB(0.05 + night * 0.25, 0.2 + night * 1.6, 0.25 + night * 1.9);
      (this.pool.material as THREE.MeshBasicMaterial).opacity = night * 0.5;
      this.pool.visible = this.poolOn && night > 0.01;
      for (const sign of this.signs) sign.face.emissiveIntensity = 0.5 + night * 1.6;
    }
    this.signs.forEach((sign, i) => {
      const text = signLine(m, i, t);
      if (text !== sign.text) this.drawSign(sign, text);
    });
  }

}
