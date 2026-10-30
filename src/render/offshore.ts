// Smuggler's Key (world/offshore.ts): the broken stone walls of Fort Contraband's battery, its two guns, the fishing boat
// wrecked on the rocks and the island's signboards. Built once from the world, a handful of draws, the same on every
// tier; the walls are solid in the sim, the rest is dressing nothing collides with.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import type { Offshore } from '../world/offshore';
import type { StaticWorld } from '../world/staticWorld';
import { mooredBoat } from './boatModels';
import { paletteMaterial } from './shapeKit';

/** Merges geometries of one vertex layout, each painted `color` (vertex colours, no uvs). */
function painted(parts: Array<[THREE.BufferGeometry, number]>): THREE.BufferGeometry {
  const c = new THREE.Color();
  const geos = parts.map(([g, color]) => {
    const geo = g.index ? g.toNonIndexed() : g;
    geo.deleteAttribute('uv');
    c.setHex(color);
    const n = geo.getAttribute('position').count;
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) rgb.set([c.r, c.g, c.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    return geo;
  });
  const m = mergeGeometries(geos, false);
  if (!m) throw new Error('mergeGeometries failed');
  return m;
}

/** Weathered coral stone, a little lighter or darker block by block, some of it greened by the damp. */
function stone(rng: Rng): number {
  return new THREE.Color(0x7d766a).multiplyScalar(rng.range(0.62, 1.04)).lerp(new THREE.Color(0x535349), rng.next() * rng.next() * 0.8).getHex();
}

/** Courses of a battery wall (m). */
const COURSE = 0.5;

/**
 * The battery's walls as courses of rough-cut blocks laid with staggered joints, each block a little proud of or
 * sunk into the face. The courses thin out towards the top, broken off unevenly (never above the solid's height), and
 * fallen blocks lie at their foot either side.
 */
function wallGeometry(o: Offshore): THREE.BufferGeometry {
  const rng = new Rng(0x0f027);
  const parts: Array<[THREE.BufferGeometry, number]> = [];
  for (const s of o.solids) {
    const alongX = s.maxX - s.minX >= s.maxZ - s.minZ;
    const len = alongX ? s.maxX - s.minX : s.maxZ - s.minZ;
    const t = alongX ? s.maxZ - s.minZ : s.maxX - s.minX;
    const courses = Math.ceil((s.y1 - s.y0) / COURSE - 1e-6);
    // How far up the wall still stands along its length: whole at first, then crumbling at a few places.
    const stands = (a: number) => {
      const k = Math.floor(a / 1.6);
      return courses - (hashOf(s.minX, s.minZ, k) < 0.35 ? 1 + Math.floor(hashOf(k, s.maxX, s.maxZ) * 2) : 0);
    };
    for (let c = 0; c < courses; c++) {
      const y0 = s.y0 + c * COURSE;
      const y1 = Math.min(s.y1, y0 + COURSE);
      let a = c % 2 === 0 ? 0 : -rng.range(0.3, 0.6);
      while (a < len) {
        const b = Math.min(len, a + rng.range(0.75, 1.35));
        const from = Math.max(0, a);
        a = b;
        if (c > 0 && c >= stands((from + b) / 2)) continue;
        const w = b - from - 0.05;
        const depth = t + rng.range(-0.06, 0.08);
        const h = y1 - y0 - 0.04;
        const g = new THREE.BoxGeometry(alongX ? w : depth, h, alongX ? depth : w);
        const off = rng.range(-0.03, 0.03);
        const cx = alongX ? s.minX + (from + b) / 2 : (s.minX + s.maxX) / 2 + off;
        const cz = alongX ? (s.minZ + s.maxZ) / 2 + off : s.minZ + (from + b) / 2;
        g.translate(cx, y0 + 0.02 + h / 2, cz);
        parts.push([g, stone(rng)]);
      }
    }
    // Rubble fallen off the top.
    for (let k = 0; k < Math.round(len / 1.6); k++) {
      const along = rng.range(0, len);
      const out = (t / 2 + rng.range(0.2, 1.6)) * (rng.chance(0.5) ? 1 : -1);
      const cx = alongX ? s.minX + along : (s.minX + s.maxX) / 2 + out;
      const cz = alongX ? (s.minZ + s.maxZ) / 2 + out : s.minZ + along;
      const size = rng.range(0.16, 0.42);
      const g = new THREE.IcosahedronGeometry(size, 0).scale(1.2, 0.6, 0.9).rotateY(rng.range(0, Math.PI));
      g.translate(cx, s.y0 + size * 0.3, cz);
      parts.push([g, stone(rng)]);
    }
  }
  return painted(parts);
}

/** Deterministic 0..1 from a few numbers. */
function hashOf(a: number, b: number, c: number): number {
  let h = Math.imul(Math.round(a * 10) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(b * 10) | 0, 0x165667b1) ^ Math.imul(Math.round(c * 10) | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** An old muzzle-loader on its wooden carriage, pointing along +z, its trunnions 1 m up. */
function cannonGeometry(): THREE.BufferGeometry {
  const iron = 0x2b2622;
  const wood = 0x5a4130;
  const parts: Array<[THREE.BufferGeometry, number]> = [
    [new THREE.CylinderGeometry(0.17, 0.27, 2.7, 14).rotateX(Math.PI / 2).translate(0, 1, 0.45), iron],
    [new THREE.CylinderGeometry(0.22, 0.22, 0.14, 14).rotateX(Math.PI / 2).translate(0, 1, 1.75), iron],
    [new THREE.SphereGeometry(0.16, 10, 8).translate(0, 1, -0.98), iron],
    [new THREE.CylinderGeometry(0.07, 0.07, 0.7, 8).rotateZ(Math.PI / 2).translate(0, 1, 0.1), iron],
  ];
  for (const x of [-0.3, 0.3]) parts.push([new THREE.BoxGeometry(0.14, 0.7, 1.5).translate(x, 0.6, -0.05), wood]);
  for (const z of [0.45, -0.55]) {
    parts.push([new THREE.CylinderGeometry(0.05, 0.05, 0.86, 6).rotateZ(Math.PI / 2).translate(0, 0.3, z), iron]);
    for (const x of [-0.42, 0.42]) parts.push([new THREE.CylinderGeometry(0.3, 0.3, 0.1, 12).rotateZ(Math.PI / 2).translate(x, 0.3, z), wood]);
  }
  return painted(parts);
}

/** Black stencilled letters on weathered whitewash, one sign per row of the atlas. */
function signAtlas(signs: Offshore['signs']): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256 * signs.length;
  const ctx = c.getContext('2d');
  if (ctx) {
    signs.forEach((s, k) => {
      const y0 = k * 256;
      ctx.fillStyle = '#e4dccb';
      ctx.fillRect(0, y0, 512, 256);
      ctx.strokeStyle = '#3a2a1c';
      ctx.lineWidth = 10;
      ctx.strokeRect(8, y0 + 8, 496, 240);
      ctx.fillStyle = '#211a14';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      s.lines.forEach((line, i) => {
        ctx.font = i === 0 ? '700 58px Anton, Impact, sans-serif' : '600 34px Rajdhani, sans-serif';
        ctx.fillText(line, 256, y0 + (i === 0 ? 70 : 70 + 26 + i * 48), 470);
      });
    });
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class OffshoreView {
  readonly group = new THREE.Group();
  private readonly textures: THREE.Texture[] = [];

  constructor(world: StaticWorld) {
    this.group.name = 'offshore';
    const o = world.layout.offshore;
    const walls = new THREE.Mesh(wallGeometry(o), new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95, flatShading: true }));
    walls.name = 'keyWalls';
    walls.castShadow = true;
    walls.receiveShadow = true;
    this.group.add(walls);

    const gun = cannonGeometry();
    const at = new THREE.Matrix4();
    const guns = mergeGeometries(o.cannons.map((c) => gun.clone().applyMatrix4(at.makeRotationY(c.rot).setPosition(c.x, world.groundHeight(c.x, c.z), c.z))), false);
    if (!guns) throw new Error('mergeGeometries failed');
    const cannons = new THREE.Mesh(guns, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.7, metalness: 0.35 }));
    cannons.name = 'keyCannons';
    cannons.castShadow = true;
    cannons.receiveShadow = true;
    this.group.add(cannons);

    for (const w of o.wrecks) {
      const boat = mooredBoat(0x7b8f86, paletteMaterial());
      boat.name = 'keyWreck';
      boat.position.set(w.x, w.y, w.z);
      boat.rotation.set(w.pitch, w.rot + Math.PI / 2, w.roll, 'YXZ');
      this.group.add(boat);
    }

    // Each board on two posts, its face printed from the atlas (one row per sign).
    const tex = signAtlas(o.signs);
    this.textures.push(tex);
    const boards: Array<[THREE.BufferGeometry, number]> = [];
    const faces: THREE.BufferGeometry[] = [];
    o.signs.forEach((s, k) => {
      const y = world.groundHeight(s.x, s.z);
      const place = new THREE.Matrix4().makeRotationY(s.rot).setPosition(s.x, y, s.z);
      boards.push([new THREE.BoxGeometry(2.6, 1.3, 0.08).translate(0, 1.55, 0).applyMatrix4(place), 0x7a5c40]);
      for (const x of [-1.05, 1.05]) boards.push([new THREE.BoxGeometry(0.12, 2.2, 0.12).translate(x, 1.1, -0.1).applyMatrix4(place), 0x5a4130]);
      const face = new THREE.PlaneGeometry(2.44, 1.16).translate(0, 1.55, 0.045);
      const uv = face.getAttribute('uv') as THREE.BufferAttribute;
      const rows = o.signs.length;
      for (let i = 0; i < uv.count; i++) uv.setY(i, (rows - 1 - k + uv.getY(i)) / rows);
      faces.push(face.applyMatrix4(place));
    });
    const boardMesh = new THREE.Mesh(painted(boards), new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85 }));
    boardMesh.name = 'keySignBoards';
    boardMesh.castShadow = true;
    const faceGeo = mergeGeometries(faces, false);
    if (!faceGeo) throw new Error('mergeGeometries failed');
    const faceMesh = new THREE.Mesh(faceGeo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
    faceMesh.name = 'keySigns';
    this.group.add(boardMesh, faceMesh);
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.name !== 'hull' && o.name !== 'fittings') o.geometry.dispose();
    });
    for (const t of this.textures) t.dispose();
  }
}
