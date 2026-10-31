// The Southgate Bridge's steel through-arch (world/country BRIDGE_ARCH): a parabolic rib over either parapet springing
// from a portal post at either end, hangers down to the deck's edges, struts across between the ribs high over the
// traffic and a portal beam at either end. One merged mesh; the deck and the parapets are the bay bridges' (city/coast).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SEABED_Y } from '../../world/constants';
import { BRIDGE_ARCH } from '../../world/country';
import type { CountryView } from './index';

/** The steel's paint, and the posts' a shade darker. */
const STEEL = 0x56706a;
const POST = 0x48605a;
/** The ribs' depth and width, the hangers' and the struts' sizes (m). */
const RIB = [1.1, 0.8] as const;
const HANGER = 0.14;
const STRUT = 0.45;
/** Height (m) of the ribs' springing on the posts, the portal beams' height, and the hangers' spacing. */
const SPRING = 3;
const PORTAL = BRIDGE_ARCH.postTop - 0.6;
const HANGER_GAP = 12;
/** Chords per rib. */
const RIB_STEPS = 28;

/** A box from a to b (its length along them) of the given cross-section, painted. */
function beam(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, color: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(w, h, len);
  g.deleteAttribute('uv');
  const m = new THREE.Matrix4().lookAt(b, a, Math.abs(b.y - a.y) > len * 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
  m.setPosition(a.clone().add(b).multiplyScalar(0.5));
  g.applyMatrix4(m);
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) rgb.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  return g;
}

/** The rib's height over the deck at x: a parabola from the springing on the posts up to the crown. */
export function ribHeight(x: number): number {
  const { x0, x1, rise } = BRIDGE_ARCH;
  const u = (2 * (x - x0)) / (x1 - x0) - 1;
  return SPRING + (rise - SPRING) * (1 - u * u);
}

export function buildBridge(view: CountryView): void {
  const { x0, x1, ribs, post, postTop } = BRIDGE_ARCH;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const parts: THREE.BufferGeometry[] = [];
  for (const z of ribs) {
    for (const x of [x0, x1]) parts.push(beam(V(x, SEABED_Y, z), V(x, postTop, z), post * 2, post * 2, POST));
    for (let i = 0; i < RIB_STEPS; i++) {
      const a = x0 + ((x1 - x0) * i) / RIB_STEPS;
      const b = x0 + ((x1 - x0) * (i + 1)) / RIB_STEPS;
      parts.push(beam(V(a, ribHeight(a), z), V(b, ribHeight(b), z), RIB[1], RIB[0], STEEL));
    }
    for (let x = x0 + HANGER_GAP; x < x1 - HANGER_GAP / 2; x += HANGER_GAP) parts.push(beam(V(x, 0.2, z), V(x, ribHeight(x), z), HANGER, HANGER, STEEL));
  }
  // Struts across between the ribs wherever they stand clear over the traffic, and a portal beam over either end.
  for (let x = x0 + HANGER_GAP / 2; x < x1; x += HANGER_GAP * 2) if (ribHeight(x) > PORTAL + 2) parts.push(beam(V(x, ribHeight(x), ribs[0]), V(x, ribHeight(x), ribs[1]), STRUT, STRUT, STEEL));
  for (const x of [x0, x1]) parts.push(beam(V(x, PORTAL, ribs[0]), V(x, PORTAL, ribs[1]), STRUT * 1.6, STRUT * 1.6, STEEL));
  const geo = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.45 });
  mat.name = 'bridge-arch';
  view.add(geo, mat, { shadow: true, name: 'bridge-arch', split: false });
}
