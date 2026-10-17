// Static city geometry: terrain, roads, markings, sidewalks, buildings, roofs,
// coast, piers, ramps, garages and signs. Everything is merged per material.

import * as THREE from 'three';
import { Rng } from '../core/rng';
import { BEACH_W, BOARDWALK_W, CROSSWALK_W, CURB_H, DECK_SLAB, LANE_W, SEABED_Y, SIDEWALK_W, WATER_Y } from '../world/constants';
import { rectCX, rectCZ, rectD, rectW, sandHeight, type Building, type FacadeStyle, type GroundKind, type Side } from '../world/layout';
import type { StaticWorld } from '../world/staticWorld';
import { GeoBuilder, hexToRgb, scaleRgb, type RGB } from './geo';
import { FACADE_CELL, FACADE_COLS, FACADE_ROWS, facadeTextures, groundTexture, helipadTexture, signTexture } from './textures';

const STYLES: FacadeStyle[] = ['glassBlue', 'glassTeal', 'office', 'brick', 'stucco', 'house', 'warehouse', 'hotel'];

/** Pastel / neutral tints per style (multiplied with the texture). */
const STYLE_TINTS: Record<FacadeStyle, number[]> = {
  glassBlue: [0xffffff, 0xe8f0ff, 0xdfe8f5],
  glassTeal: [0xffffff, 0xe6fff8],
  office: [0xffffff, 0xf3ead8, 0xe6e0d0, 0xd9d4c8],
  brick: [0xffffff, 0xe8d0c0, 0xd6c4b8],
  stucco: [0xffffff, 0xffe9d2, 0xe9f4ff, 0xfff4c9, 0xf5dce8, 0xdff5e1],
  house: [0xfff1dc, 0xffd9c4, 0xd9ecff, 0xfff6b8, 0xe7d2ff, 0xd2f5dc, 0xffffff, 0xf2c9b0],
  warehouse: [0xffffff, 0xd8e2ea, 0xe8e0d0],
  hotel: [0xffffff, 0xfff5e6, 0xeaf6ff],
};

const GROUND_TEX: Record<GroundKind, 'grass' | 'plaza' | 'asphalt' | 'dirt'> = {
  grass: 'grass',
  yard: 'grass',
  plaza: 'plaza',
  parking: 'asphalt',
  dirt: 'dirt',
};

export interface CityMaterials {
  facades: Map<FacadeStyle, THREE.MeshStandardMaterial>;
  signs: THREE.MeshStandardMaterial[];
}

export class CityView {
  readonly group = new THREE.Group();
  readonly materials: CityMaterials = { facades: new Map(), signs: [] };

  constructor(private readonly world: StaticWorld) {
    this.group.name = 'city';
    this.buildBuildings();
    this.buildGround();
    this.buildRoads();
    this.buildCoast();
    this.buildStructures();
  }

  private add(geo: THREE.BufferGeometry, mat: THREE.Material, opts: { shadow?: boolean; receive?: boolean; name?: string } = {}): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = opts.shadow ?? false;
    m.receiveShadow = opts.receive ?? true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    if (opts.name) m.name = opts.name;
    this.group.add(m);
    return m;
  }

  // ---------------------------------------------------------------------------
  // Buildings

  private buildBuildings(): void {
    const layout = this.world.layout;
    const builders = new Map<FacadeStyle, GeoBuilder>();
    for (const s of STYLES) builders.set(s, new GeoBuilder(true));
    const roofs = new GeoBuilder(true);
    const rng = new Rng(4242);

    for (const b of layout.buildings) {
      const gb = builders.get(b.style)!;
      const cell = FACADE_CELL[b.style];
      const tints = STYLE_TINTS[b.style];
      const tint = hexToRgb(tints[Math.floor(b.tint * tints.length) % tints.length]!);
      const shade = 0.88 + rng.next() * 0.14;
      const color = scaleRgb(tint, shade);
      const offU = Math.floor(rng.next() * FACADE_COLS) / FACADE_COLS;
      const offV = Math.floor(rng.next() * FACADE_ROWS) / FACADE_ROWS;
      for (const t of b.tiers) {
        const uv = { kind: 'facade' as const, w: cell.w * FACADE_COLS, h: cell.h * FACADE_ROWS, offU, offV, baseY: CURB_H };
        gb.box(t.minX, t.y0, t.minZ, t.maxX, t.y1, t.maxZ, { uv, color, top: false });
        if (b.roof === 'gable' && t === b.tiers[b.tiers.length - 1]) this.gable(roofs, t, b, color);
        else {
          const rc = scaleRgb([0.55, 0.54, 0.52], 0.85 + rng.next() * 0.3);
          roofs.flat(t.minX, t.minZ, t.maxX, t.maxZ, t.y1, { kind: 'world', scale: 6 }, rc);
          // Parapet lip.
          const lip = 0.6;
          const lc: RGB = [color[0] * 0.8, color[1] * 0.8, color[2] * 0.8];
          if (rectW(t) > 6 && rectD(t) > 6) {
            roofs.box(t.minX, t.y1, t.minZ, t.maxX, t.y1 + lip, t.minZ + 0.3, { uv: { kind: 'world', scale: 4 }, color: lc });
            roofs.box(t.minX, t.y1, t.maxZ - 0.3, t.maxX, t.y1 + lip, t.maxZ, { uv: { kind: 'world', scale: 4 }, color: lc });
            roofs.box(t.minX, t.y1, t.minZ + 0.3, t.minX + 0.3, t.y1 + lip, t.maxZ - 0.3, { uv: { kind: 'world', scale: 4 }, color: lc });
            roofs.box(t.maxX - 0.3, t.y1, t.minZ + 0.3, t.maxX, t.y1 + lip, t.maxZ - 0.3, { uv: { kind: 'world', scale: 4 }, color: lc });
          }
        }
      }
      if (b.sign) this.addSign(b, b.sign.text, b.sign.color, b.sign.side);
    }

    STYLES.forEach((style, i) => {
      const tex = facadeTextures(style, 100 + i);
      const glass = style === 'glassBlue' || style === 'glassTeal';
      const mat = new THREE.MeshStandardMaterial({
        map: tex.map,
        emissiveMap: tex.emissive,
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0,
        roughnessMap: tex.rough,
        roughness: 1,
        metalness: glass ? 0.25 : 0.02,
        vertexColors: true,
        envMapIntensity: glass ? 1.4 : 0.6,
      });
      this.materials.facades.set(style, mat);
      const geo = builders.get(style)!.build();
      if (geo.getAttribute('position').count > 0) this.add(geo, mat, { shadow: true, name: `facade-${style}` });
    });
    const roofMat = new THREE.MeshStandardMaterial({ map: groundTexture('roof'), vertexColors: true, roughness: 0.92, metalness: 0 });
    this.add(roofs.build(), roofMat, { shadow: true, name: 'roofs' });
  }

  /** Pitched roof along the longer side. */
  private gable(gb: GeoBuilder, t: { minX: number; minZ: number; maxX: number; maxZ: number; y1: number }, b: Building, wallColor: RGB): void {
    const w = t.maxX - t.minX;
    const d = t.maxZ - t.minZ;
    const h = Math.min(w, d) * 0.35;
    const y = t.y1;
    const roofCol: RGB = b.tint > 0.5 ? [0.55, 0.22, 0.18] : [0.32, 0.33, 0.36];
    const uv = [0, 0, 1, 0, 1, 1, 0, 1];
    const o = 0.4; // eaves overhang
    if (w >= d) {
      const zm = (t.minZ + t.maxZ) / 2;
      gb.quad(t.minX - o, y - 0.1, t.maxZ + o, t.maxX + o, y - 0.1, t.maxZ + o, t.maxX + o, y + h, zm, t.minX - o, y + h, zm, uv, roofCol);
      gb.quad(t.maxX + o, y - 0.1, t.minZ - o, t.minX - o, y - 0.1, t.minZ - o, t.minX - o, y + h, zm, t.maxX + o, y + h, zm, uv, roofCol);
      gb.tri(t.minX, y, t.minZ, t.minX, y, t.maxZ, t.minX, y + h, zm, [0, 0, 1, 0, 0.5, 1], wallColor);
      gb.tri(t.maxX, y, t.maxZ, t.maxX, y, t.minZ, t.maxX, y + h, zm, [0, 0, 1, 0, 0.5, 1], wallColor);
    } else {
      const xm = (t.minX + t.maxX) / 2;
      gb.quad(t.maxX + o, y - 0.1, t.maxZ + o, t.maxX + o, y - 0.1, t.minZ - o, xm, y + h, t.minZ - o, xm, y + h, t.maxZ + o, uv, roofCol);
      gb.quad(t.minX - o, y - 0.1, t.minZ - o, t.minX - o, y - 0.1, t.maxZ + o, xm, y + h, t.maxZ + o, xm, y + h, t.minZ - o, uv, roofCol);
      gb.tri(t.minX, y, t.maxZ, t.maxX, y, t.maxZ, xm, y + h, t.maxZ, [0, 0, 1, 0, 0.5, 1], wallColor);
      gb.tri(t.maxX, y, t.minZ, t.minX, y, t.minZ, xm, y + h, t.minZ, [0, 0, 1, 0, 0.5, 1], wallColor);
    }
  }

  private addSign(b: Building, text: string, color: string, side: Side): void {
    const tex = signTexture(text, color);
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.4, roughness: 0.6, transparent: false });
    this.materials.signs.push(mat);
    const r = b.rect;
    const along = side === 'N' || side === 'S' ? rectW(r) : rectD(r);
    const w = Math.min(along * 0.8, 16);
    const h = w * (192 / 1024);
    const geo = new THREE.PlaneGeometry(w, h);
    const m = new THREE.Mesh(geo, mat);
    const y = Math.min(b.height - h / 2 - 0.5, 6 + h / 2);
    const off = 0.08;
    switch (side) {
      case 'S':
        m.position.set(rectCX(r), y, r.maxZ + off);
        break;
      case 'N':
        m.position.set(rectCX(r), y, r.minZ - off);
        m.rotation.y = Math.PI;
        break;
      case 'E':
        m.position.set(r.maxX + off, y, rectCZ(r));
        m.rotation.y = Math.PI / 2;
        break;
      case 'W':
        m.position.set(r.minX - off, y, rectCZ(r));
        m.rotation.y = -Math.PI / 2;
        break;
    }
    m.updateMatrix();
    m.matrixAutoUpdate = false;
    this.group.add(m);
  }

  // ---------------------------------------------------------------------------
  // Ground: sidewalks, lots, promenade

  private buildGround(): void {
    const layout = this.world.layout;
    const walk = new GeoBuilder(false);
    const curbs = new GeoBuilder(false);
    const patches = new Map<string, GeoBuilder>();
    const patch = (k: string) => {
      let g = patches.get(k);
      if (!g) {
        g = new GeoBuilder(false);
        patches.set(k, g);
      }
      return g;
    };
    const y = CURB_H;
    const sw = SIDEWALK_W;
    for (const blk of layout.blocks) {
      const r = blk.rect;
      // Sidewalk ring (4 non-overlapping strips).
      walk.flat(r.minX, r.minZ, r.maxX, r.minZ + sw, y, { kind: 'world', scale: 4 });
      walk.flat(r.minX, r.maxZ - sw, r.maxX, r.maxZ, y, { kind: 'world', scale: 4 });
      walk.flat(r.minX, r.minZ + sw, r.minX + sw, r.maxZ - sw, y, { kind: 'world', scale: 4 });
      walk.flat(r.maxX - sw, r.minZ + sw, r.maxX, r.maxZ - sw, y, { kind: 'world', scale: 4 });
      // Curb faces.
      curbs.wall(r.minX, r.maxZ, r.maxX, r.maxZ, 0, y, { kind: 'world', scale: 2 });
      curbs.wall(r.maxX, r.maxZ, r.maxX, r.minZ, 0, y, { kind: 'world', scale: 2 });
      curbs.wall(r.maxX, r.minZ, r.minX, r.minZ, 0, y, { kind: 'world', scale: 2 });
      curbs.wall(r.minX, r.minZ, r.minX, r.maxZ, 0, y, { kind: 'world', scale: 2 });
    }
    for (const gp of layout.ground) {
      const tex = GROUND_TEX[gp.kind];
      patch(tex).flat(gp.rect.minX, gp.rect.minZ, gp.rect.maxX, gp.rect.maxZ, y + 0.004, { kind: 'world', scale: tex === 'plaza' ? 6 : 8 });
    }
    // Parking bay lines.
    const lines = new GeoBuilder(false);
    for (const s of layout.parking) {
      const fx = Math.sin(s.heading);
      const fz = Math.cos(s.heading);
      const sx = Math.cos(s.heading);
      const sz = -Math.sin(s.heading);
      for (const side of [-1, 1]) {
        const cx = s.x + sx * side * 1.6;
        const cz = s.z + sz * side * 1.6;
        const ax = cx - fx * 2.5;
        const az = cz - fz * 2.5;
        const bx = cx + fx * 2.5;
        const bz = cz + fz * 2.5;
        quadLine(lines, ax, az, bx, bz, 0.12, y + 0.012);
      }
    }

    // Outer land around the city: sidewalk ring + promenade strips + boardwalk.
    const b = layout.bounds;
    const prom = patch('plaza');
    const wood = new GeoBuilder(false);
    walk.flat(b.cityMinX - sw, b.cityMinZ - sw, b.cityMaxX + sw, b.cityMinZ, y, { kind: 'world', scale: 4 });
    walk.flat(b.cityMinX - sw, b.cityMaxZ, b.cityMaxX + sw, b.cityMaxZ + sw, y, { kind: 'world', scale: 4 });
    walk.flat(b.cityMinX - sw, b.cityMinZ, b.cityMinX, b.cityMaxZ, y, { kind: 'world', scale: 4 });
    walk.flat(b.cityMaxX, b.cityMinZ, b.cityMaxX + sw, b.cityMaxZ, y, { kind: 'world', scale: 4 });
    curbs.wall(b.cityMinX, b.cityMinZ, b.cityMaxX, b.cityMinZ, 0, y, { kind: 'world', scale: 2 });
    curbs.wall(b.cityMaxX, b.cityMaxZ, b.cityMinX, b.cityMaxZ, 0, y, { kind: 'world', scale: 2 });
    curbs.wall(b.cityMinX, b.cityMaxZ, b.cityMinX, b.cityMinZ, 0, y, { kind: 'world', scale: 2 });
    curbs.wall(b.cityMaxX, b.cityMinZ, b.cityMaxX, b.cityMaxZ, 0, y, { kind: 'world', scale: 2 });
    prom.flat(b.landMinX, b.landMinZ, b.cityMinX - sw, b.landMaxZ, y, { kind: 'world', scale: 6 });
    prom.flat(b.cityMinX - sw, b.landMinZ, b.beachStartX, b.cityMinZ - sw, y, { kind: 'world', scale: 6 });
    prom.flat(b.cityMinX - sw, b.cityMaxZ + sw, b.beachStartX, b.landMaxZ, y, { kind: 'world', scale: 6 });
    wood.flat(b.cityMaxX + sw, b.cityMinZ - sw, b.beachStartX, b.cityMaxZ + sw, y, { kind: 'world', scale: 4 });

    const mat = (tex: THREE.Texture, rough = 0.95) => new THREE.MeshStandardMaterial({ map: tex, roughness: rough, metalness: 0 });
    this.add(walk.build(), mat(groundTexture('sidewalk')), { name: 'sidewalks' });
    this.add(curbs.build(), mat(groundTexture('concrete')), { name: 'curbs' });
    this.add(wood.build(), mat(groundTexture('wood')), { name: 'boardwalk' });
    for (const [k, g] of patches) {
      const m = mat(groundTexture(k as 'grass' | 'plaza' | 'asphalt' | 'dirt'), k === 'asphalt' ? 0.9 : 0.97);
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -1;
      this.add(g.build(), m, { name: `ground-${k}` });
    }
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.add(lines.build(), lineMat, { name: 'parking-lines' });
  }

  // ---------------------------------------------------------------------------
  // Roads

  private buildRoads(): void {
    const roads = this.world.roads;
    const asphalt = new GeoBuilder(false);
    const white = new GeoBuilder(false);
    const yellow = new GeoBuilder(false);
    const yM = 0.02;
    for (const n of roads.nodes) asphalt.flat(n.x - n.halfX, n.z - n.halfZ, n.x + n.halfX, n.z + n.halfZ, 0, { kind: 'world', scale: 8 });
    for (const s of roads.segments) {
      asphalt.flat(s.minX, s.minZ, s.maxX, s.maxZ, 0, { kind: 'world', scale: 8 });
      const line = s.line;
      const c = line.pos;
      // Markings run between the crosswalk bands.
      const a0 = (s.vertical ? s.minZ : s.minX) + CROSSWALK_W;
      const a1 = (s.vertical ? s.maxZ : s.maxX) - CROSSWALK_W;
      const L = (a: number, o: number) => (s.vertical ? { x: c + o, z: a } : { x: a, z: c + o });
      // Centre line(s).
      if (line.lanes === 2) {
        for (const o of [-0.16, 0.16]) {
          const p = L(a0, o);
          const q = L(a1, o);
          quadLine(yellow, p.x, p.z, q.x, q.z, 0.12, yM);
        }
        // Dashed lane dividers.
        for (const o of [-LANE_W, LANE_W]) {
          for (let a = a0 + 2; a + 3 <= a1; a += 9) {
            const p = L(a, o);
            const q = L(a + 3, o);
            quadLine(white, p.x, p.z, q.x, q.z, 0.12, yM);
          }
        }
      } else {
        for (let a = a0 + 1; a + 4 <= a1; a += 7) {
          const p = L(a, 0);
          const q = L(a + 4, 0);
          quadLine(yellow, p.x, p.z, q.x, q.z, 0.13, yM);
        }
      }
      // Edge lines.
      for (const o of [-(line.width / 2 - 0.35), line.width / 2 - 0.35]) {
        const p = L(a0, o);
        const q = L(a1, o);
        quadLine(white, p.x, p.z, q.x, q.z, 0.1, yM);
      }
    }
    // Stop lines and zebra crossings.
    for (const n of roads.nodes) {
      for (let d = 0; d < 4; d++) {
        if (n.neighbors[d]! < 0) continue;
        const vertical = d === 0 || d === 2;
        const sign = d === 0 || d === 3 ? -1 : 1;
        const halfAlong = vertical ? n.halfZ : n.halfX;
        const width = vertical ? n.halfX * 2 : n.halfZ * 2;
        const c0 = halfAlong;
        const c1 = halfAlong + CROSSWALK_W;
        // Zebra: stripes parallel to the road.
        for (let o = -width / 2 + 0.6; o <= width / 2 - 0.6; o += 1.2) {
          const a = c0 + 0.4;
          const b = c1 - 0.4;
          if (vertical) quadLine(white, n.x + o, n.z + sign * a, n.x + o, n.z + sign * b, 0.55, yM);
          else quadLine(white, n.x + sign * a, n.z + o, n.x + sign * b, n.z + o, 0.55, yM);
        }
        // Stop line across the incoming half (traffic arriving from direction d drives on its right).
        const sl = c1 + 0.3;
        if (vertical) {
          // Arriving from north (d=0 side) travels south; its lanes are on the west half.
          const x0 = d === 0 ? n.x - width / 2 + 0.2 : n.x + 0.3;
          const x1 = d === 0 ? n.x - 0.3 : n.x + width / 2 - 0.2;
          quadLine(white, x0, n.z + sign * sl, x1, n.z + sign * sl, 0.45, yM);
        } else {
          const z0 = d === 1 ? n.z - width / 2 + 0.2 : n.z + 0.3;
          const z1 = d === 1 ? n.z - 0.3 : n.z + width / 2 - 0.2;
          quadLine(white, n.x + sign * sl, z0, n.x + sign * sl, z1, 0.45, yM);
        }
      }
    }
    const roadMat = new THREE.MeshStandardMaterial({ map: groundTexture('asphalt'), roughness: 0.88, metalness: 0 });
    this.add(asphalt.build(), roadMat, { name: 'roads' });
    const mk = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.add(white.build(), mk(0xe6e6e0), { name: 'markings-white' });
    this.add(yellow.build(), mk(0xe8b923), { name: 'markings-yellow' });
  }

  // ---------------------------------------------------------------------------
  // Coast

  private buildCoast(): void {
    const b = this.world.layout.bounds;
    const sand = new GeoBuilder(false);
    const walls = new GeoBuilder(false);
    const end = sandHeight(b, b.beachEndX);
    // Sloped beach in strips so the slope reads well under shadows.
    const steps = 10;
    for (let i = 0; i < steps; i++) {
      const x0 = b.beachStartX + (BEACH_W * i) / steps;
      const x1 = b.beachStartX + (BEACH_W * (i + 1)) / steps;
      const y0 = sandHeight(b, x0);
      const y1 = sandHeight(b, x1);
      const s = 1 / 8;
      sand.quad(x0, y0, b.landMaxZ, x1, y1, b.landMaxZ, x1, y1, b.landMinZ, x0, y0, b.landMinZ, [x0 * s, -b.landMaxZ * s, x1 * s, -b.landMaxZ * s, x1 * s, -b.landMinZ * s, x0 * s, -b.landMinZ * s]);
    }
    // Drop-off into deep water.
    sand.quad(b.beachEndX, end, b.landMaxZ, b.beachEndX + 25, SEABED_Y, b.landMaxZ, b.beachEndX + 25, SEABED_Y, b.landMinZ, b.beachEndX, end, b.landMinZ, [0, 0, 1, 0, 1, 1, 0, 1]);
    // Quay walls (W, N, S) and the beach's north/south edges.
    const bottom = SEABED_Y;
    walls.wall(b.landMinX, b.landMinZ, b.landMinX, b.landMaxZ, bottom, CURB_H, { kind: 'world', scale: 3 });
    walls.wall(b.beachStartX, b.landMinZ, b.landMinX, b.landMinZ, bottom, CURB_H, { kind: 'world', scale: 3 });
    walls.wall(b.landMinX, b.landMaxZ, b.beachStartX, b.landMaxZ, bottom, CURB_H, { kind: 'world', scale: 3 });
    for (let i = 0; i < steps; i++) {
      const x0 = b.beachStartX + (BEACH_W * i) / steps;
      const x1 = b.beachStartX + (BEACH_W * (i + 1)) / steps;
      walls.quad(x1, bottom, b.landMinZ, x0, bottom, b.landMinZ, x0, sandHeight(b, x0), b.landMinZ, x1, sandHeight(b, x1), b.landMinZ, [0, 0, 1, 0, 1, 1, 0, 1]);
      walls.quad(x0, bottom, b.landMaxZ, x1, bottom, b.landMaxZ, x1, sandHeight(b, x1), b.landMaxZ, x0, sandHeight(b, x0), b.landMaxZ, [0, 0, 1, 0, 1, 1, 0, 1]);
    }
    const sandMat = new THREE.MeshStandardMaterial({ map: groundTexture('sand'), roughness: 1, metalness: 0 });
    this.add(sand.build(), sandMat, { name: 'beach' });
    this.add(walls.build(), new THREE.MeshStandardMaterial({ map: groundTexture('concrete', 3), roughness: 0.95 }), { name: 'quay' });

    // Piers.
    const deck = new GeoBuilder(false);
    const pillars: THREE.Vector3[] = [];
    for (const d of this.world.layout.decks) {
      deck.box(d.rect.minX, d.y - DECK_SLAB, d.rect.minZ, d.rect.maxX, d.y, d.rect.maxZ, { uv: { kind: 'world', scale: 4 }, bottom: true });
      for (let x = d.rect.minX + 2; x < d.rect.maxX; x += 7) {
        for (const z of [d.rect.minZ + 0.6, d.rect.maxZ - 0.6]) if (WATER_Y > this.world.baseGround(x, z) - 0.1) pillars.push(new THREE.Vector3(x, d.y, z));
      }
    }
    this.add(deck.build(), new THREE.MeshStandardMaterial({ map: groundTexture('wood', 2), roughness: 0.9 }), { shadow: true, name: 'piers' });
    if (pillars.length > 0) {
      const pg = new THREE.CylinderGeometry(0.25, 0.25, 1, 6);
      pg.translate(0, -0.5, 0);
      const pm = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.9 }), pillars.length);
      const m = new THREE.Matrix4();
      pillars.forEach((p, i) => {
        const h = p.y - SEABED_Y;
        m.makeScale(1, h, 1);
        m.setPosition(p.x, p.y - DECK_SLAB, p.z);
        pm.setMatrixAt(i, m);
      });
      pm.instanceMatrix.needsUpdate = true;
      pm.computeBoundingSphere();
      this.group.add(pm);
    }
  }

  // ---------------------------------------------------------------------------
  // Garages, ramps, helipads

  private buildStructures(): void {
    const layout = this.world.layout;
    const garageGeo = new GeoBuilder(true);
    for (const g of layout.garages) {
      const col = hexToRgb(g.color);
      for (const w of g.walls) garageGeo.box(w.minX, 0, w.minZ, w.maxX, g.height, w.maxZ, { uv: { kind: 'world', scale: 3 }, color: col });
      garageGeo.box(g.rect.minX - 0.3, g.height, g.rect.minZ - 0.3, g.rect.maxX + 0.3, g.height + 0.4, g.rect.maxZ + 0.3, { uv: { kind: 'world', scale: 3 }, color: scaleRgb(col, 0.7), bottom: true });
      const poi = layout.pois.find((p) => p.id === g.poi)!;
      const text = poi.kind === 'spray' ? 'SPRAY SHACK' : "LOU'S AUTO";
      const color = poi.kind === 'spray' ? '#5cff9d' : '#ff9a5c';
      const fake: Building = { id: -1, rect: g.rect, height: g.height + 3.2, tiers: [], style: 'office', roof: 'flat', tint: 0, district: 'docks', roofProps: [], sign: null };
      this.addSign(fake, text, color, g.side);
    }
    this.add(garageGeo.build(), new THREE.MeshStandardMaterial({ map: groundTexture('metal'), vertexColors: true, roughness: 0.7, metalness: 0.2 }), { shadow: true, name: 'garages' });

    // Stunt ramps: sloped plate plus side panels with hazard colours.
    const plate = new GeoBuilder(false);
    const sides = new GeoBuilder(true);
    for (const r of layout.ramps) {
      const fx = Math.sin(r.heading);
      const fz = Math.cos(r.heading);
      const sx = Math.cos(r.heading);
      const sz = -Math.sin(r.heading);
      const hw = r.width / 2;
      const hl = r.length / 2;
      const base = this.world.baseGround(r.x, r.z);
      const P = (along: number, side: number, h: number): [number, number, number] => [r.x + fx * along + sx * side, base + h, r.z + fz * along + sz * side];
      const a = P(-hl, -hw, 0.02);
      const bq = P(-hl, hw, 0.02);
      const c = P(hl, hw, r.height);
      const d = P(hl, -hw, r.height);
      plate.quad(...a, ...bq, ...c, ...d, [0, 0, 1, 0, 1, 3, 0, 3]);
      // Back face and side triangles.
      const e = P(hl, hw, 0);
      const f = P(hl, -hw, 0);
      sides.quad(...d, ...c, ...e, ...f, [0, 0, 1, 0, 1, 1, 0, 1], [0.9, 0.75, 0.1]);
      sides.tri(...bq, ...e, ...c, [0, 0, 1, 0, 1, 1], [0.95, 0.8, 0.1]);
      sides.tri(...a, ...d, ...f, [0, 0, 1, 1, 1, 0], [0.95, 0.8, 0.1]);
    }
    const plateMat = new THREE.MeshStandardMaterial({ map: groundTexture('metal', 5), roughness: 0.55, metalness: 0.5, side: THREE.DoubleSide });
    this.add(plate.build(), plateMat, { shadow: true, name: 'ramps' });
    this.add(sides.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }), { shadow: true, name: 'ramp-sides' });

    // Helipads on rooftops.
    const pads = layout.buildings.flatMap((b) => b.roofProps.filter((p) => p.kind === 'helipad'));
    if (pads.length > 0) {
      const g = new GeoBuilder(false);
      for (const p of pads) {
        const h = p.w / 2;
        g.quad(p.x - h, p.y + 0.06, p.z + h, p.x + h, p.y + 0.06, p.z + h, p.x + h, p.y + 0.06, p.z - h, p.x - h, p.y + 0.06, p.z - h, [0, 0, 1, 0, 1, 1, 0, 1]);
      }
      this.add(g.build(), new THREE.MeshStandardMaterial({ map: helipadTexture(), roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), { name: 'helipads' });
    }
  }

  /** Night factor 0..1. */
  update(night: number): void {
    for (const m of this.materials.facades.values()) m.emissiveIntensity = night * 1.4;
    for (const m of this.materials.signs) m.emissiveIntensity = 0.35 + night * 3.2;
  }
}

/** Thin horizontal strip between two points (for markings). */
function quadLine(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, width: number, y: number): void {
  const dx = bx - ax;
  const dz = bz - az;
  const l = Math.hypot(dx, dz) || 1;
  // Right-hand normal so the quad faces up with CCW winding.
  const nx = (-dz / l) * (width / 2);
  const nz = (dx / l) * (width / 2);
  const ux = dx / l;
  const uz = dz / l;
  // Order: left-start, right-start... choose winding facing +Y.
  const p0 = [ax - nx, az - nz];
  const p1 = [ax + nx, az + nz];
  const p2 = [bx + nx, bz + nz];
  const p3 = [bx - nx, bz - nz];
  // Check orientation: cross((p1-p0),(p2-p0)).y must be > 0.
  const cy = (p1[1]! - p0[1]!) * (p2[0]! - p0[0]!) - (p1[0]! - p0[0]!) * (p2[1]! - p0[1]!);
  void ux;
  void uz;
  if (cy > 0) g.quad(p0[0]!, y, p0[1]!, p1[0]!, y, p1[1]!, p2[0]!, y, p2[1]!, p3[0]!, y, p3[1]!, [0, 0, 1, 0, 1, 1, 0, 1]);
  else g.quad(p3[0]!, y, p3[1]!, p2[0]!, y, p2[1]!, p1[0]!, y, p1[1]!, p0[0]!, y, p0[1]!, [0, 0, 1, 0, 1, 1, 0, 1]);
}

export { BOARDWALK_W };
