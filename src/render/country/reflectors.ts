// Reflector posts along Las Lomas County's roads (world/country): a white post with a black band and an amber reflector
// on either face every POST_GAP m along both edges of every county road on the land, clear of the junctions, of the
// fire road's turn-off and of Dry Creek (the one plot that comes up to the road, its sidewalks the town's own). They are drawn only (no collider), one mesh culled by cell with the rest of the county. After
// dark, the reflectors ahead of the player's lit car shine back at it, glows in LightSprites as bright as its headlights
// fall on them: on Low, with no headlight beam, they are what you steer by.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vehicle } from '../../sim/entities';
import { CROSSWALK_W } from '../../world/constants';
import { onCountyLand, plotAt } from '../../world/country';
import { FIRE_ROAD } from '../../world/country/hills';
import type { StaticWorld } from '../../world/staticWorld';
import type { LightSprites } from '../lightSprites';
import type { CountryView } from './index';

/** A post every POST_GAP m along each edge, POST_OUT m off it, POST_H tall, its reflector REFLECTOR_Y up. */
export const POST_GAP = 25;
const POST_OUT = 1.4;
const POST_H = 1.05;
const REFLECTOR_Y = 0.88;
/** Headlights reach a reflector this far (m) ahead, within this cone's cosine either side of the car's heading. */
const BEAM_REACH = 80;
const BEAM_COS = 0.88;

const WHITE = 0xe9e7e0;
const BAND = 0x1d1d1d;
const AMBER = 0xf0a020;

/** A reflector post: its foot, and the road's direction there (its reflectors face both ways along it). */
export interface ReflectorPost {
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
}

/** Where the posts stand: both edges of every county road, on the county's land, clear of junctions, the turn-off and the town. */
export function reflectorPosts(world: StaticWorld): ReflectorPost[] {
  const roads = world.roads;
  const country = world.layout.country;
  const junctions = roads.nodes.slice(roads.gridNodeCount).filter((n) => !roads.isBend(n));
  const [tx, tz] = FIRE_ROAD[0]!;
  const out: ReflectorPost[] = [];
  for (const { road } of roads.outerRoads) {
    let next = POST_GAP / 2;
    let s = 0;
    for (let k = 2; k < road.pts.length; k += 2) {
      const ax = road.pts[k - 2]!;
      const az = road.pts[k - 1]!;
      const bx = road.pts[k]!;
      const bz = road.pts[k + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      for (; next <= s + len; next += POST_GAP) {
        const t = next - s;
        for (const side of [-1, 1]) {
          const o = road.width / 2 + POST_OUT;
          const x = ax + dx * t - dz * o * side;
          const z = az + dz * t + dx * o * side;
          if (!onCountyLand(country, x, z) || x >= world.bounds.landMinX || plotAt(country, x, z)?.kind === 'town') continue;
          if (junctions.some((n) => Math.hypot(n.x - x, n.z - z) < n.halfX + CROSSWALK_W + 6)) continue;
          if (Math.hypot(tx - x, tz - z) < 12) continue;
          out.push({ x, y: world.groundHeight(x, z), z, dx, dz });
        }
      }
      s += len;
    }
  }
  return out;
}

/** The posts' glows, by the player's headlights. */
export class Reflectors {
  private readonly posts: ReflectorPost[];

  constructor(view: CountryView) {
    this.posts = reflectorPosts(view.world);
    const parts: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    const box = (w: number, h: number, d: number, y: number, color: number) => paint(new THREE.BoxGeometry(w, h, d).translate(0, y, 0), color);
    // One post along +z: the reflectors on its faces up and down the road.
    const post = mergeGeometries([box(0.11, POST_H, 0.11, POST_H / 2, WHITE), box(0.115, 0.1, 0.115, 0.68, BAND), box(0.08, 0.12, 0.125, REFLECTOR_Y, AMBER)], false)!;
    for (const p of this.posts) parts.push(post.clone().applyMatrix4(m.makeRotationY(Math.atan2(p.dx, p.dz)).setPosition(p.x, p.y, p.z)));
    const geo = mergeGeometries(parts, false)!;
    for (const g of [post, ...parts]) g.dispose();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 });
    mat.name = 'reflector-posts';
    view.add(geo, mat, { name: 'reflector-posts' });
  }

  get count(): number {
    return this.posts.length;
  }

  /**
   * Each frame: a glow on every reflector the lit car's headlights fall on, at `strength` (0..1, the night's) of full, as
   * it is nearer and more nearly dead ahead; none without a lit car.
   */
  glow(ls: LightSprites, car: Vehicle | null, strength: number): void {
    if (!car || strength <= 0) return;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    for (const p of this.posts) {
      const dx = p.x - car.pos.x;
      const dz = p.z - car.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > BEAM_REACH || d < 1) continue;
      const ahead = (dx * fx + dz * fz) / d;
      if (ahead < BEAM_COS) continue;
      ls.addReflector(p.x, p.y + REFLECTOR_Y, p.z, strength * THREE.MathUtils.smoothstep(ahead, BEAM_COS, 0.985) * (1 - d / BEAM_REACH) ** 0.5);
    }
  }
}

function paint(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const geo = g.toNonIndexed();
  g.dispose();
  const c = new THREE.Color(color);
  const n = geo.getAttribute('position').count;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) rgb.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  geo.deleteAttribute('uv');
  return geo;
}
