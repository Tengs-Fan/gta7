// AzuraLink drawn: the beam and its pylons (one mesh), the two stations (platforms under a canopy, stair towers and a sign
// counting down to the next train) and the three-car train, moved each frame to where the timetable puts it (sim time,
// world/monorail.ts), with lit windows and an underglow after dark and doors that open on the platform side while it
// stands at a station. A dozen draws in all; the light pool the train throws on the canal is the tier's (railGlow).

import * as THREE from 'three';
import { formatTime, smoothstep } from '../core/math';
import { SEABED_Y, WATER_Y } from '../world/constants';
import { BEAM_OVERRUN, CAR_GAP, CAR_HEIGHT, CAR_LENGTH, CAR_WIDTH, nextDeparture, PLATFORM_SLAB, TOWER_H, TRAIN_DWELL, TRAIN_LENGTH, trainAt, type Monorail, type MonorailStation } from '../world/monorail';
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
/** The concrete's tints: the beam and towers, the pylons, a door's dark opening, the platform's yellow line. */
const BEAM: RGB = [0.86, 0.86, 0.84];
const PIER: RGB = [0.74, 0.74, 0.72];
const OPENING: RGB = [0.1, 0.1, 0.11];
const SAFETY: RGB = [0.95, 0.78, 0.12];
const SIGN_W = 5;
const SIGN_H = 1.9;

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
    const under = top - BEAM_D;
    for (const p of m.pylons) {
      prism(g, p.x, p.z, PYLON_R, SEABED_Y, under - HEAD_D, 10, PIER);
      // Under a platform the head reaches out beneath it, a post holding the platform's slab.
      const s = m.stations.find((st) => p.z > st.platform[0]!.minZ && p.z < st.platform[0]!.maxZ);
      const reach = s ? s.side * (CAR_WIDTH / 2 + 2.6) : 0;
      box(g, p.x - 1.3 + Math.min(0, reach), under - HEAD_D, p.z - 0.6, p.x + 1.3 + Math.max(0, reach), under, p.z + 0.6, PIER, true);
      if (s) box(g, p.x + reach - 0.4, under, p.z - 0.4, p.x + reach + 0.4, top - PLATFORM_SLAB, p.z + 0.4, PIER);
    }
    return g.build();
  }

  /** A station: platform and walkway slabs, the canopy on its posts, railings, the tower with its doors and glazing. */
  private buildStation(m: Monorail, s: MonorailStation, g: GeoBuilder, steel: GeoBuilder, lit: GeoBuilder, glass: GeoBuilder): void {
    const y = m.beamY;
    const [plat, walk] = s.platform as [typeof s.tower, typeof s.tower];
    const edge = s.side > 0 ? plat.minX : plat.maxX;
    const outer = s.side > 0 ? plat.maxX : plat.minX;
    for (const r of s.platform) box(g, r.minX, y - PLATFORM_SLAB, r.minZ, r.maxX, y, r.maxZ, BEAM, true);
    // The yellow line along the platform's edge.
    box(g, edge + s.side * 0.15, y, plat.minZ + 0.3, edge + s.side * 0.45, y + 0.012, plat.maxZ - 0.3, SAFETY);
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
    const wallX = s.side > 0 ? t.minX : t.maxX;
    box(g, wallX, y, walk.minZ + 0.6, wallX - s.side * 0.05, y + 2.4, walk.maxZ - 0.6, OPENING);
    box(glass, far, 5.2, tz - 0.6, far + s.side * 0.05, TOWER_H - 2, tz + 0.6, WHITE);
    // Toward the city.
    const land = -Math.sign(s.z);
    const face = land > 0 ? t.maxZ : t.minZ;
    const fx = (t.minX + t.maxX) / 2;
    for (const dx of [-1.8, 1.8]) box(glass, fx + dx - 0.45, 1.4, face, fx + dx + 0.45, TOWER_H - 2, face + land * 0.05, WHITE);
  }

  /** The sign over a tower's door: the line's name, the station's, and the next train. */
  private addSign(m: Monorail, s: MonorailStation, i: number): void {
    const [c, ctx] = canvas(512, 192);
    const texture = toTexture(c, true, false);
    const face = new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: 0.5, roughness: 0.6 });
    const sign: Sign = { ctx, texture, face, name: s.name.toUpperCase(), text: '' };
    this.signs.push(sign);
    this.drawSign(sign, signLine(m, i, 0));
    const panel = new THREE.Mesh(new THREE.BoxGeometry(SIGN_W, SIGN_H, 0.12), [this.steel, this.steel, this.steel, this.steel, face, this.steel]);
    panel.name = 'monorail-sign';
    const t = s.tower;
    panel.position.set((s.side > 0 ? t.maxX : t.minX) + s.side * 0.08, 2.8 + SIGN_H / 2, (t.minZ + t.maxZ) / 2);
    panel.rotation.y = (s.side * Math.PI) / 2;
    panel.castShadow = true;
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
    const wy0 = y + 1.15;
    const wy1 = y + 2.35;
    for (let k = 0; k < 3; k++) {
      const cz = (k - 1) * (CAR_LENGTH + CAR_GAP);
      const za = cz - CAR_LENGTH / 2;
      const zb = cz + CAR_LENGTH / 2;
      // A nose on the outer end of either end car: a low bonnet and a raked windscreen.
      const noseA = k === 0;
      const noseB = k === 2;
      const ba = noseA ? za + 2.2 : za;
      const bb = noseB ? zb - 2.2 : zb;
      box(body, -hw, y + 0.05, ba, hw, top - 0.2, bb, WHITE, true);
      box(body, -hw + 0.12, top - 0.2, ba + 0.3, hw - 0.12, top, bb - 0.3, ROOF);
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
        // The bonnet, the windscreen raked back from it to the roof, and its sides.
        box(body, -hw, y + 0.05, zBody, hw, y + 1.3, zEnd, WHITE, true);
        const ze = zEnd - d * 0.3;
        const glassUv = [0, 0, 1, 0, 1, 1, 0, 1];
        if (d < 0) win.quad(hw, y + 1.3, ze, -hw, y + 1.3, ze, -hw, top - 0.2, zBody, hw, top - 0.2, zBody, glassUv);
        else win.quad(-hw, y + 1.3, ze, hw, y + 1.3, ze, hw, top - 0.2, zBody, -hw, top - 0.2, zBody, glassUv);
        for (const s of [-1, 1]) {
          const x = s * hw;
          if (s * d < 0) body.tri(x, y + 1.3, ze, x, top - 0.2, zBody, x, y + 1.3, zBody, [0, 0, 1, 1, 1, 0], WHITE);
          else body.tri(x, y + 1.3, ze, x, y + 1.3, zBody, x, top - 0.2, zBody, [0, 0, 1, 0, 1, 1], WHITE);
          box(lamps, s * 0.6, y + 0.6, zEnd, s * 1.15, y + 0.85, zEnd + d * 0.05);
        }
        box(lamps, -0.35, y + 1.05, zEnd, 0.35, y + 1.2, zEnd + d * 0.05);
      }
      // The gangway to the next car.
      if (k < 2) box(body, -1, y + 0.2, zb, 1, y + 2.6, zb + CAR_GAP, SKIRT);
    }
    return { body: body.build(), windows: win.build(), north: north.build(), south: south.build(), glow: glow.build() };
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
    this.pool.visible = on;
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
      for (const sign of this.signs) sign.face.emissiveIntensity = 0.5 + night * 1.6;
    }
    this.signs.forEach((sign, i) => {
      const text = signLine(m, i, t);
      if (text !== sign.text) this.drawSign(sign, text);
    });
  }

}
