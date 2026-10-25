// Planing hulls for the boat models (boatModels.ts): a vee bottom from the keel to a hard chine, flared topsides up to
// the sheer, a bow drawn in to a raked stem and a flat transom, from a few numbers per hull. Also the open cockpit's
// inside (gunwale cap, liner, sole, inner transom), a foredeck with its bulkhead, the waterline outline at rest and
// the foam ring laid along it. Hull frame: +x left, +y up from the waterline, +z forward, the hull from -length/2
// (transom) to +length/2 (stem).

import * as THREE from 'three';
import { gridSurface, mirrorX, sheet, V } from './shapeKit';

export interface HullSpec {
  length: number;
  /** Beam at the sheer, amidships. */
  beam: number;
  /** Keel depth below the waterline, aft of keelRise. */
  draft: number;
  /** Deadrise (rad) keel to chine amidships; it steepens towards the bow. */
  deadrise: number;
  /** Sheer height above the waterline at the transom and at the stem. */
  sheerAft: number;
  sheerBow: number;
  /** Chine half-beam as a share of the sheer's. */
  chine: number;
  /** Where (0 transom .. 1 stem) the sides start drawing in, and how full the bow stays (exponent; lower is finer). */
  shoulder: number;
  entry: number;
  /** Where the keel starts to rise to the stem. */
  keelRise: number;
  /** Transom half-beam as a share of the widest. */
  transom: number;
}

export interface HullSection {
  z: number;
  keel: number;
  chineX: number;
  chineY: number;
  sheerX: number;
  sheerY: number;
}

/** The hull's section at t (0 transom .. 1 stem). */
export function hullSection(h: HullSpec, t: number): HullSection {
  const z = -h.length / 2 + t * h.length;
  const f = t < h.shoulder ? 1 - (1 - h.transom) * (1 - t / h.shoulder) ** 2 : 1 - ((t - h.shoulder) / (1 - h.shoulder)) ** h.entry;
  const sheerX = (h.beam / 2) * Math.max(0, f);
  const sheerY = h.sheerAft + (h.sheerBow - h.sheerAft) * t * t;
  const u = t < h.keelRise ? 0 : (t - h.keelRise) / (1 - h.keelRise);
  const keel = -h.draft + (h.draft + h.sheerBow * 0.5) * u ** 1.8;
  const dr = h.deadrise + (1.1 - h.deadrise) * Math.max(0, (t - 0.45) / 0.55) ** 1.5;
  const chineX = sheerX * h.chine;
  const chineY = Math.min(keel + chineX * Math.tan(dr), sheerY - 0.25 * (sheerY - keel));
  return { z, keel, chineX, chineY, sheerX, sheerY };
}

/** Station positions (t), closer together at the bow where the hull curves most. */
export function stations(n: number): number[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const s = i / n;
    return 1 - (1 - s) ** 1.35;
  });
}

/** Points of the outer skin's left half at section s: keel, bottom, chine, topside, sheer. */
function skinPoints(s: HullSection): THREE.Vector3[] {
  const midB = V(s.chineX * 0.5, s.keel + (s.chineY - s.keel) * 0.47, s.z);
  const midT = V(s.chineX + (s.sheerX - s.chineX) * 0.62, s.chineY + (s.sheerY - s.chineY) * 0.5, s.z);
  return [V(0, s.keel, s.z), midB, V(s.chineX, s.chineY, s.z), midT, V(s.sheerX, s.sheerY, s.z)];
}

export interface HullSkin {
  /** Topsides (chine to sheer, both sides) and the transom: the painted part. */
  topsides: THREE.BufferGeometry;
  transom: THREE.BufferGeometry;
  /** Bottom (keel to chine, both sides). */
  bottom: THREE.BufferGeometry;
}

/** The outer skin from stations ts (transom to stem). */
export function hullSkin(h: HullSpec, ts: readonly number[]): HullSkin {
  const secs = ts.map((t) => hullSection(h, t));
  const pts = secs.map(skinPoints);
  const bottomL = gridSurface(pts.map((p) => p.slice(0, 3)), V(1, -1, 0));
  const topL = gridSurface(pts.map((p) => p.slice(2)), V(1, 0, 0));
  // Transom: a fan over the stern section, both halves.
  const s0 = pts[0]!;
  const ring = [...s0.slice(1).reverse().map((p) => V(-p.x, p.y, p.z)), ...s0];
  // From the left sheer round the bottom to the right sheer... and across the top.
  const centre = V(0, (secs[0]!.keel + secs[0]!.sheerY) / 2, secs[0]!.z);
  const pos: number[] = [centre.x, centre.y, centre.z];
  for (const p of ring) pos.push(p.x, p.y, p.z);
  const idx: number[] = [];
  for (let i = 0; i < ring.length; i++) idx.push(0, 1 + i, 1 + ((i + 1) % ring.length));
  const transom = sheet(pos, idx, V(0, 0, -1));
  return { topsides: merge2(topL, mirrorX(topL)), transom, bottom: merge2(bottomL, mirrorX(bottomL)) };
}

function merge2(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const ga = a.index ? a.toNonIndexed() : a;
  const gb = b.index ? b.toNonIndexed() : b;
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const x = ga.getAttribute(name).array as Float32Array;
    const y = gb.getAttribute(name).array as Float32Array;
    const arr = new Float32Array(x.length + y.length);
    arr.set(x, 0);
    arr.set(y, x.length);
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  return out;
}

/** Half-beam of the outer skin at height y in section s (0 if the section lies wholly above y). */
export function skinHalfBeamAt(s: HullSection, y: number): number {
  const p = skinPoints(s);
  if (y <= p[0]!.y) return 0;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i]!;
    const b = p[i + 1]!;
    if ((y - a.y) * (y - b.y) <= 0 && a.y !== b.y) return a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
  }
  return p[p.length - 1]!.x;
}

export interface Cockpit {
  /** Height of the sole above the waterline, the liner's thickness in from the skin, and the open part's extent (t). */
  floor: number;
  wall: number;
  from: number;
  to: number;
}

/** The open cockpit's inside: gunwale cap, liner down to the sole, the sole, and the transom's inner face and cap. */
export function cockpitGeometry(h: HullSpec, c: Cockpit, n = 16): { cap: THREE.BufferGeometry; liner: THREE.BufferGeometry; sole: THREE.BufferGeometry; transomInner: THREE.BufferGeometry } {
  const ts = Array.from({ length: n + 1 }, (_, i) => c.from + ((c.to - c.from) * i) / n);
  const capRows: THREE.Vector3[][] = [];
  const linerRows: THREE.Vector3[][] = [];
  const soleRows: THREE.Vector3[][] = [];
  for (const t of ts) {
    const s = hullSection(h, t);
    const inX = Math.max(0.02, s.sheerX - c.wall);
    const footX = Math.max(0.02, Math.min(inX, skinHalfBeamAt(s, c.floor) - c.wall * 0.6));
    capRows.push([V(s.sheerX, s.sheerY, s.z), V(inX, s.sheerY, s.z)]);
    linerRows.push([V(inX, s.sheerY, s.z), V(inX * 0.97 + footX * 0.03, (s.sheerY + c.floor) / 2, s.z), V(footX, c.floor, s.z)]);
    soleRows.push([V(footX, c.floor, s.z), V(0, c.floor, s.z), V(-footX, c.floor, s.z)]);
  }
  const capL = gridSurface(capRows, V(0, 1, 0));
  const linerL = gridSurface(linerRows, V(-1, 0, 0));
  const sole = gridSurface(soleRows, V(0, 1, 0));
  // The transom's inside: from the sole up to the cap, across the stern, facing forward.
  const s0 = hullSection(h, c.from);
  const w = Math.max(0.02, s0.sheerX - c.wall);
  const f = Math.max(0.02, Math.min(w, skinHalfBeamAt(s0, c.floor) - c.wall * 0.6));
  const z = s0.z + 0.001;
  const transomInner = gridSurface([[V(-f, c.floor, z), V(f, c.floor, z)], [V(-w, s0.sheerY, z), V(w, s0.sheerY, z)]], V(0, 0, 1));
  return { cap: merge2(capL, mirrorX(capL)), liner: merge2(linerL, mirrorX(linerL)), sole, transomInner };
}

/** A cambered deck from t0 to the stem at the sheer, with its aft bulkhead down to `floor` (for a cockpit ahead of it). */
export function foredeckGeometry(h: HullSpec, t0: number, floor: number, camber: number, n = 12): { deck: THREE.BufferGeometry; bulkhead: THREE.BufferGeometry } {
  const ts = Array.from({ length: n + 1 }, (_, i) => t0 + ((1 - t0) * i) / n);
  const rows = ts.map((t) => {
    const s = hullSection(h, t);
    const row: THREE.Vector3[] = [];
    for (let k = 0; k <= 8; k++) {
      const x = s.sheerX * (1 - (2 * k) / 8);
      row.push(V(x, s.sheerY + camber * (1 - (x / Math.max(s.sheerX, 1e-6)) ** 2) * (s.sheerX / (h.beam / 2)), s.z));
    }
    return row;
  });
  const deck = gridSurface(rows, V(0, 1, 0));
  const s = hullSection(h, t0);
  const top: THREE.Vector3[] = [];
  const bottom: THREE.Vector3[] = [];
  for (let k = 0; k <= 8; k++) {
    const x = s.sheerX * (1 - (2 * k) / 8);
    top.push(V(x * 0.995, s.sheerY + camber * (1 - (x / s.sheerX) ** 2), s.z - 0.001));
    const fx = Math.min(Math.abs(x), skinHalfBeamAt(s, floor)) * Math.sign(x);
    bottom.push(V(fx, floor, s.z - 0.001));
  }
  const bulkhead = gridSurface([bottom, top], V(0, 0, -1));
  return { deck, bulkhead };
}

/** The waterline at rest (y = 0): a closed outline round the hull in (x, z), stern edge first, resampled to n points. */
export function waterline(h: HullSpec, n: number): THREE.Vector2[] {
  const ts = stations(48);
  const left: THREE.Vector2[] = [];
  let bowZ = h.length / 2;
  for (const t of ts) {
    const s = hullSection(h, t);
    if (s.keel >= 0) {
      // The keel rises out of the water between the last station and this one.
      const prev = hullSection(h, ts[Math.max(0, ts.indexOf(t) - 1)]!);
      bowZ = prev.z + ((0 - prev.keel) / (s.keel - prev.keel)) * (s.z - prev.z);
      break;
    }
    left.push(new THREE.Vector2(skinHalfBeamAt(s, 0), s.z));
  }
  const loop: THREE.Vector2[] = [...left, new THREE.Vector2(0, bowZ), ...left.slice().reverse().map((p) => new THREE.Vector2(-p.x, p.y))];
  // Resample by arc length.
  const lens = [0];
  for (let i = 1; i <= loop.length; i++) lens.push(lens[i - 1]! + loop[i % loop.length]!.distanceTo(loop[i - 1]!));
  const total = lens[lens.length - 1]!;
  const out: THREE.Vector2[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const d = (i / n) * total;
    while (lens[k + 1]! < d) k++;
    const a = loop[k]!;
    const b = loop[(k + 1) % loop.length]!;
    const f = (d - lens[k]!) / Math.max(1e-9, lens[k + 1]! - lens[k]!);
    out.push(new THREE.Vector2(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f));
  }
  return out;
}
