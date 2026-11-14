// Exterior fittings share a single material atlas and draw. Geometry stays in vehicle-local space so the same
// deformation that crumples a door also carries its seams, handle, trim and mirror with it.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { VEHICLE_SPECS, type VehicleKind } from '../sim/specs';
import { type Pt, topAt } from './vehicleGeometry';

/** Atlas cells: rubber, satin metal, enamel registration plate, mirror. */
type Finish = 0 | 1 | 2 | 3;

export interface ExteriorProfile {
  body: readonly Pt[];
  cabin: readonly Pt[];
  cabinInset: number;
  wheelR: number;
  wheelFront: number;
  wheelRear: number;
  lightY: number;
  rearSeats: boolean;
  /** Glazed panes on the profile (the first a box van's or the bus's windscreen), and how far their glass stands off it. */
  panes?: ReadonlyArray<{ readonly a: Pt; readonly b: Pt; readonly x0: number; readonly x1: number }>;
  paneOut?: number;
}

/** Signed width of the pressed side panel. Keep the shoulder and wheel arch dimensions; tuck the sill in. */
export function bodySideX(halfWidth: number, height: number, y: number): number {
  const waist = THREE.MathUtils.clamp((y / height - 0.22) / 0.37, 0, 1);
  return halfWidth - 0.075 * (1 - waist) * (1 - waist);
}

/** Narrow the upper greenhouse: a real roof is slimmer than the doors. The middle of the cabin stays fixed so
 * the steering wheel and rider attachment frame retain their exact simulation coordinates. */
export function cabinSideX(x: number, y: number, height: number, halfWidth: number): number {
  const upper = THREE.MathUtils.smoothstep(y / height, 0.66, 1.02);
  const across = THREE.MathUtils.clamp((Math.abs(x) / halfWidth - 0.48) / 0.52, 0, 1);
  return x - Math.sign(x) * 0.12 * upper * across;
}

export function taperCabin(g: THREE.BufferGeometry, kind: VehicleKind): void {
  if (kind === 'bus' || kind === 'van' || kind === 'swat') return;
  const s = VEHICLE_SPECS[kind];
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) p.setX(i, cabinSideX(p.getX(i), p.getY(i), s.height, s.width / 2));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
}

export function sculptBody(g: THREE.BufferGeometry, kind: VehicleKind, profile: ExteriorProfile): THREE.BufferGeometry {
  const s = VEHICLE_SPECS[kind];
  // Tall commercial vehicles have vertical load-bearing sides; cars get a pressed sill and subtle beltline crown.
  if (kind !== 'bus' && kind !== 'van' && kind !== 'swat' && kind !== 'pickup' && !s.bodyProfile?.straightSides) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const scale = bodySideX(s.width / 2, s.height, y) / (s.width / 2);
      p.setX(i, x * scale);
      // A shallow crowned bonnet catches a broad sky highlight, with its panel edges at the original height.
      const z = p.getZ(i);
      if (z > profile.cabin[0]![0] + 0.04 && y > topAt(profile.body, z) - 0.01) {
        const fade = THREE.MathUtils.smoothstep(z - profile.cabin[0]![0], 0.04, 0.23);
        p.setY(i, y + Math.max(0, Math.min(0.055, s.height * 0.695 - y)) * Math.max(0, 1 - (x / (s.width / 2)) ** 2) * fade);
      }
    }
    g.computeVertexNormals();
  }
  taperCabin(g, kind);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** How a body's nose or tail is rounded in plan: its corners draw back by `bow` and its flanks in by `pinch` (m). */
interface EndRound {
  readonly bow: number;
  readonly pinch: number;
}

type EndRounds = { readonly front: EndRound; readonly rear: EndRound };

/**
 * Plan-view rounding per kind, front and rear: cars get a rounded nose and a softer tail, the sports car the most;
 * load-carrying ends (a pickup's tailgate, a box body's back doors) stay nearly square.
 */
const END_ROUND: Readonly<Partial<Record<VehicleKind, EndRounds>>> = (() => {
  const car: EndRounds = { front: { bow: 0.11, pinch: 0.06 }, rear: { bow: 0.08, pinch: 0.05 } };
  const box: EndRounds = { front: { bow: 0.07, pinch: 0.035 }, rear: { bow: 0.025, pinch: 0.01 } };
  return {
    compact: { front: { bow: 0.12, pinch: 0.07 }, rear: { bow: 0.07, pinch: 0.05 } },
    sedan: car,
    taxi: car,
    police: car,
    sports: { front: { bow: 0.16, pinch: 0.1 }, rear: { bow: 0.08, pinch: 0.06 } },
    muscle: { front: { bow: 0.08, pinch: 0.04 }, rear: { bow: 0.06, pinch: 0.04 } },
    pickup: { front: { bow: 0.09, pinch: 0.05 }, rear: { bow: 0.02, pinch: 0 } },
    van: box,
    swat: { front: { bow: 0.05, pinch: 0.03 }, rear: { bow: 0.02, pinch: 0 } },
    bus: { front: { bow: 0.06, pinch: 0.03 }, rear: { bow: 0.04, pinch: 0.02 } },
    ambulance: box,
    firetruck: box,
  };
})();

/** Exponent of the bow across the width: flat over the middle, drawing back towards the corners. */
const BOW_POWER = 2.5;
const SQUARE: EndRound = { bow: 0, pinch: 0 };

/**
 * Rounds a body's nose and tail in plan beyond its wheel arches, so a car reads as a moulded shell instead of an
 * extruded slab. One shape moves the body, its glass, fittings and lamps alike (and so its shadow and far versions),
 * and leaves everything between the arches (the cabin, the seats, the wheels) where it was.
 */
export class EndRounding {
  private readonly hw: number;
  private readonly half: number;
  private readonly zFront: number;
  private readonly zRear: number;
  private readonly front: EndRound;
  private readonly rear: EndRound;

  /** `square`: no rounding (an imported body has its own shape). */
  constructor(kind: VehicleKind, p: ExteriorProfile, archGap: number, square = false) {
    const s = VEHICLE_SPECS[kind];
    this.hw = s.width / 2;
    this.half = s.length / 2;
    this.front = (!square && END_ROUND[kind]?.front) || SQUARE;
    this.rear = (!square && END_ROUND[kind]?.rear) || SQUARE;
    // The rounding starts where the arch behind the nose (ahead of the tail) ends.
    this.zFront = Math.min(this.half - 0.2, p.wheelFront * s.length + p.wheelR + archGap);
    this.zRear = Math.max(-this.half + 0.2, p.wheelRear * s.length - p.wheelR - archGap);
  }

  /** How far into its rounded end z lies: 0 between the arches, 1 at the end face and beyond. */
  private reach(z: number): number {
    const t = z >= 0 ? (z - this.zFront) / (this.half - this.zFront) : (this.zRear - z) / (this.zRear + this.half);
    const c = THREE.MathUtils.clamp(t, 0, 1);
    return c * c * (3 - 2 * c);
  }

  /** Moves the vehicle-local point v (x across, z along) onto the rounded shape. */
  apply(v: THREE.Vector3): THREE.Vector3 {
    const e = this.reach(v.z);
    if (e === 0) return v;
    const end = v.z >= 0 ? this.front : this.rear;
    const across = Math.min(1, Math.abs(v.x) / this.hw);
    v.z -= Math.sign(v.z) * end.bow * across ** BOW_POWER * e;
    v.x *= 1 - (end.pinch / this.hw) * e * e;
    return v;
  }

  /**
   * Rounds every vertex of `g` in place and refreshes its bounds; `flat` recomputes its (faceted) normals, otherwise
   * the smooth normals of round fittings are kept (the rounding turns a surface by a few degrees at most).
   */
  geometry(g: THREE.BufferGeometry, flat = true): THREE.BufferGeometry {
    const p = g.getAttribute('position');
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      this.apply(v.fromBufferAttribute(p, i));
      p.setXYZ(i, v.x, v.y, v.z);
    }
    if (flat && g.getAttribute('normal')) g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  /**
   * The rounded x of a flank point that stood at |x| = `x` before the rounding and lies at `z` after it (solving for its
   * z before the rounding, which the bow moved), with the sign of `x`.
   */
  flankX(x: number, z: number): number {
    let z0 = z;
    const end = z >= 0 ? this.front : this.rear;
    const across = Math.min(1, Math.abs(x) / this.hw);
    for (let k = 0; k < 60; k++) z0 = z + Math.sign(z) * end.bow * across ** BOW_POWER * this.reach(z0);
    const e = this.reach(z0);
    return x * (1 - (end.pinch / this.hw) * e * e);
  }

  /** The turn (rad, about +y) that squares a part at x on the front (or rear) end face to the rounded face there. */
  yaw(x: number, front: boolean): number {
    const end = front ? this.front : this.rear;
    const across = Math.min(1, Math.abs(x) / this.hw);
    const slope = (end.bow * BOW_POWER * across ** (BOW_POWER - 1)) / this.hw / (1 - end.pinch / this.hw);
    return Math.sign(x) * Math.atan(slope);
  }
}

/**
 * Tyre tones (linear, times the tyre material's white): worn black tread, a lighter moulded sidewall and the raised
 * lettering band round it, so a close-up reads as rubber with a sidewall instead of one flat black ring.
 */
export const TYRE_TREAD = 0.012;
export const TYRE_SIDEWALL = 0.034;
export const TYRE_LETTERING = 0.16;

/** Adds a tyre with round shoulders, circumferential grooves and a lettered sidewall, keeping the contact radius. */
export function tireGeometry(radius: number): THREE.BufferGeometry {
  const T = TYRE_TREAD;
  const S = TYRE_SIDEWALL;
  const Lt = TYRE_LETTERING;
  // [r, axial, tone]; the lettering band's points are doubled so its edges stay crisp.
  const wall = (sign: number): Array<[number, number, number]> => {
    const z = (h: number): number => sign * h;
    return [
      [radius * 0.63, z(0.114), S], [radius * 0.7, z(0.121), S],
      [radius * 0.74, z(0.124), S], [radius * 0.74, z(0.1255), Lt], [radius * 0.8, z(0.1285), Lt], [radius * 0.8, z(0.127), S],
      [radius * 0.84, z(0.13), S], [radius * 0.95, z(0.12), S],
    ];
  };
  const tread: Array<[number, number, number]> = [
    [radius, -0.09, T], [radius, -0.065, T], [radius * 0.985, -0.06, T], [radius * 0.985, -0.053, T],
    [radius, -0.048, T], [radius, -0.006, T], [radius * 0.985, 0, T], [radius, 0.006, T],
    [radius, 0.048, T], [radius * 0.985, 0.053, T], [radius * 0.985, 0.06, T], [radius, 0.065, T], [radius, 0.09, T],
  ];
  const section: Array<[number, number, number]> = [[0, -0.114, S], ...wall(-1), ...tread, ...wall(1).reverse(), [0, 0.114, S]];
  const g = new THREE.LatheGeometry(section.map(([r, h]) => new THREE.Vector2(r, h)), 28);
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  // LatheGeometry lays out (segments + 1) rings of the section's points in order.
  for (let i = 0; i < n; i++) colors.fill(section[i % section.length]![2], i * 3, i * 3 + 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.rotateZ(Math.PI / 2);
  return g;
}

/**
 * A farm tyre `radius` across its lugs: chevron lugs round its tread, two staggered rows of blocks leaning from the
 * middle out, standing 2.5 cm proud of a tread that much smaller (the wheel turns on the lugs' radius).
 */
export function lugTireGeometry(radius: number): THREE.BufferGeometry {
  const pieces = [tireGeometry(radius - 0.025)];
  const count = 22;
  for (let k = 0; k < count; k++) {
    for (const half of [-1, 1]) {
      const lug = new THREE.BoxGeometry(0.085, 0.035, 0.05);
      lug.rotateY(half * 0.45);
      lug.translate(half * 0.05, radius - 0.0175, 0);
      lug.rotateX(((k + (half > 0 ? 0.5 : 0)) / count) * Math.PI * 2);
      const n = lug.getAttribute('position').count;
      lug.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(TYRE_TREAD), 3));
      pieces.push(lug);
    }
  }
  const g = mergeGeometries(pieces)!;
  for (const piece of pieces) piece.dispose();
  return g;
}

/**
 * A lamp lens one unit wide, high and deep (as BoxGeometry(1, 1, 1)), scaled per lamp: a rounded rectangle whose face
 * (+z) bulges out over bevelled edges, so head and tail lamps read as moulded lenses rather than flat boxes.
 */
export function lensGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const w = 0.5;
  const h = 0.5;
  const r = 0.22;
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.4, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.12, bevelSegments: 3, curveSegments: 3 });
  g.computeBoundingBox();
  const b = g.boundingBox!;
  const size = b.getSize(new THREE.Vector3());
  const c = b.getCenter(new THREE.Vector3());
  g.translate(-c.x, -c.y, -c.z);
  g.scale(1 / size.x, 1 / size.y, 1 / size.z);
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Machined lip, open spokes, hub and wheel nuts on the wheel's outboard face (+x; the view turns the right-hand
 * wheels round), dished: the spokes run in from the lip to a hub sunk 1.5 cm behind it, over the rim's barrel (seen
 * between the spokes), a brake rotor and a dark inboard backing, in one wheel draw inside the tyre width. The inboard
 * face is the tyre's dark closed side: a second bright alloy there showed under the car as a pale disc through the
 * opposite wheel arch.
 */
export function alloyGeometry(radius: number, kind: VehicleKind): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  const sporty = kind === 'sports' || kind === 'muscle';
  const rim = radius * (sporty ? 0.74 : 0.65);
  const count = sporty ? 5 : kind === 'pickup' || kind === 'swat' ? 6 : 7;
  /** The lip's face and the hub's, along the axle (m). */
  const lip = 0.128;
  const hubX = 0.113;
  {
    const ring = new THREE.TorusGeometry(rim - 0.012, 0.018, 5, 28);
    ring.rotateY(Math.PI / 2);
    ring.translate(lip, 0, 0);
    pieces.push(ring);
    const hub = new THREE.CylinderGeometry(rim * 0.22, rim * 0.24, 0.027, 14);
    hub.rotateZ(Math.PI / 2);
    hub.translate(hubX + 0.004, 0, 0);
    pieces.push(hub);
    // Each spoke from the hub (r 0.2 rim) out to under the lip (0.95 rim), leaning out to the face as it goes.
    const r0 = rim * 0.2;
    const r1 = rim * 0.95;
    const lean = Math.atan2(lip - 0.005 - hubX, r1 - r0);
    for (let k = 0; k < count; k++) {
      const angle = (k / count) * Math.PI * 2;
      const spoke = new THREE.BoxGeometry(0.024, Math.hypot(r1 - r0, lip - 0.005 - hubX), sporty ? 0.045 : 0.037);
      spoke.rotateZ(-lean);
      spoke.translate((hubX + lip - 0.005) / 2, (r0 + r1) / 2, 0);
      spoke.rotateX(angle);
      pieces.push(spoke);
      const nut = new THREE.CylinderGeometry(0.012, 0.012, 0.02, 6);
      nut.rotateZ(Math.PI / 2);
      nut.translate(hubX + 0.014, Math.cos(angle) * rim * 0.14, Math.sin(angle) * rim * 0.14);
      pieces.push(nut);
    }
  }
  for (const piece of pieces) {
    const colors = new Float32Array(piece.getAttribute('position').count * 3).fill(1);
    piece.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const tone = (g: THREE.BufferGeometry, r: number, gg = r, b = r): THREE.BufferGeometry => {
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([r, gg, b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  };
  // The rim's barrel, from the lip in to the rotor, a shade darker than the face.
  const barrel = new THREE.CylinderGeometry(rim - 0.02, rim - 0.02, lip - 0.07, 28, 1, true);
  // (Turned inside out: it is seen from within, between the spokes, and the rim's back faces are culled.)
  (barrel.getIndex()!.array as Uint16Array).reverse();
  const bn = barrel.getAttribute('normal');
  for (let i = 0; i < bn.count; i++) bn.setXYZ(i, -bn.getX(i), -bn.getY(i), -bn.getZ(i));
  barrel.rotateZ(Math.PI / 2);
  barrel.translate((lip + 0.07) / 2, 0, 0);
  pieces.push(tone(barrel, 0.55));
  const rotor = new THREE.CylinderGeometry(rim * 0.83, rim * 0.83, 0.008, 28);
  rotor.rotateZ(Math.PI / 2);
  rotor.translate(0.117, 0, 0);
  pieces.push(tone(rotor, 0.24));
  // A caliper over the rotor, red on the sporty kinds. The tyre's own closed side is the dark inboard backing.
  const caliper = new THREE.BoxGeometry(0.03, rim * 0.34, rim * 0.22);
  caliper.translate(0.105, rim * 0.55, -rim * 0.32);
  pieces.push(sporty ? tone(caliper, 0.75, 0.05, 0.03) : tone(caliper, 0.3));
  const result = mergeGeometries(pieces)!;
  for (const p of pieces) p.dispose();
  return result;
}

/** The box-bodied vans, whose backs are a pair of doors. */
const BACK_DOORS: ReadonlySet<VehicleKind> = new Set(['van', 'swat', 'ambulance']);

/**
 * Where a procedural body's tail lamps sit (x out from the middle, y up) and their lenses' width and height: tall
 * clusters up the back corners of the box vans, whose doors fill their backs, of the bus, beside its engine grille, and
 * of the fire engine, beside its ladder; a wide lamp beside the plate on the rest.
 */
export function tailLamp(kind: VehicleKind, half: number, lightY: number): { x: number; y: number; w: number; h: number } {
  if (BACK_DOORS.has(kind)) return { x: half - 0.13, y: lightY + 0.22, w: 0.15, h: 0.42 };
  if (kind === 'bus') return { x: half - 0.16, y: lightY + 0.35, w: 0.2, h: 0.5 };
  if (kind === 'firetruck') return { x: half - 0.16, y: lightY + 0.25, w: 0.17, h: 0.44 };
  return { x: half - 0.3, y: lightY + 0.05, w: 0.36, h: kind === 'sports' ? 0.085 : 0.14 };
}

export function exteriorGeometry(kind: VehicleKind, p: ExteriorProfile): THREE.BufferGeometry {
  const s = VEHICLE_SPECS[kind];
  const hw = s.width / 2;
  const L = s.length;
  const H = s.height;
  const commercial = p.cabinInset < 0;
  /** Box-bodied working vehicles: the vans, the bus, the ambulance and the fire engine. */
  const boxy = commercial || !!s.bodyProfile?.straightSides;
  const pieces: THREE.BufferGeometry[] = [];
  const add = (geo: THREE.BufferGeometry, finish: Finish, x = 0, y = 0, z = 0): void => {
    geo.translate(x, y, z);
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    const uv = g.getAttribute('uv');
    // Eight texels of gutter keep plate letters and dark trim from bleeding into neighbouring finishes.
    const cellX = finish % 2;
    const cellY = Math.floor(finish / 2);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (cellX + 0.03 + uv.getX(i) * 0.94) / 2, (cellY + 0.03 + uv.getY(i) * 0.94) / 2);
    pieces.push(g);
  };
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, finish: Finish = 0): void => {
    add(new THREE.BoxGeometry(w, h, d, Math.max(1, Math.ceil(w / 0.2)), Math.max(1, Math.ceil(h / 0.2)), Math.max(1, Math.ceil(d / 0.2))), finish, x, y, z);
  };
  const line = (a: THREE.Vector3, b: THREE.Vector3, radius: number, finish: Finish = 0): void => {
    const d = b.clone().sub(a);
    const g = new THREE.CylinderGeometry(radius, radius, d.length(), 5, Math.max(1, Math.ceil(d.length() / 0.18)));
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    const middle = a.clone().add(b).multiplyScalar(0.5);
    add(g, finish, middle.x, middle.y, middle.z);
  };
  // The Haymaker's narrow hood and cab carry fittings of their own.
  if (kind === 'tractor') {
    tractorKit(p, s.bodyProfile!.bodyWidth!, L, H, box, line, add);
    return merged(pieces);
  }
  const flank = (side: number, y: number): number => side * ((commercial || kind === 'pickup' || s.bodyProfile?.straightSides ? hw : bodySideX(hw, H, y)) + 0.008);
  const ly = p.lightY * H;
  // The body's end faces are at +-L/2 (vehicleView fits the profile and its bevel to the spec length): bumpers, plates
  // and grilles stand at most 3 cm proud of them.
  const end = L / 2 + 0.004;
  const sill = p.body[0]![1] + 0.035;
  const bumperY = Math.max(sill + 0.06, ly - 0.19);
  for (const endSign of [-1, 1]) {
    // Lower valance, bright bumper edge and a recessed number plate. The plate is a separate atlas region,
    // so its ivory enamel and dark lettering stay legible on every paint colour.
    box(0, bumperY, endSign * end, s.width * 0.82, 0.10, 0.034);
    if (kind !== 'sports' && kind !== 'swat') box(0, bumperY + 0.053, endSign * (end + 0.004), s.width * 0.83, 0.022, 0.038, 1);
    box(0, ly + (endSign < 0 ? 0.045 : -0.045), endSign * (end + 0.012), 0.46, 0.19, 0.024);
    const plate = new THREE.PlaneGeometry(0.40, 0.145, 3, 1);
    if (endSign < 0) plate.rotateY(Math.PI);
    add(plate, 2, 0, ly + (endSign < 0 ? 0.045 : -0.045), endSign * (end + 0.026));
  }
  // A grille with horizontal blades, divided intakes on sports cars, and a fine maker badge.
  box(0, ly + 0.12, end - 0.006, s.width * 0.43, 0.11, 0.035);
  for (let i = 0; i < 3; i++) box(0, ly + 0.081 + i * 0.034, end + 0.013, s.width * 0.40, 0.009, 0.011, 1);
  box(0, ly + 0.12, end + 0.023, 0.055, 0.061, 0.015, 1);
  // Black lamp surrounds make the bright lenses read as components in the fascia.
  for (const side of [-1, 1]) {
    const lensH = kind === 'sports' ? 0.12 : 0.19;
    box(side * (hw - 0.32), ly, end - 0.022, 0.40, lensH, 0.050);
    const tail = tailLamp(kind, hw, ly);
    box(side * tail.x, tail.y, -end + 0.022, tail.w + 0.04, tail.h + 0.05, 0.050);
    // Twin exhaust tips and the dark opening at the end of each tube.
    if (kind !== 'bus' && kind !== 'van' && (side < 0 || kind === 'sports' || kind === 'muscle')) {
      const pipe = new THREE.CylinderGeometry(0.038, 0.038, 0.14, 12, 1, true);
      pipe.rotateX(Math.PI / 2);
      add(pipe, 1, side * s.width * 0.29, bumperY - 0.075, -end + 0.05);
    }
    const frontDoor = p.cabin[0]![0] - 0.05;
    const rearLimit = Math.max(p.cabin[3]![0] + 0.12, p.wheelRear * L + p.wheelR + 0.13);
    const rearDoor = commercial ? (kind === 'bus' ? -L * 0.16 : p.cabin[3]![0]) : p.rearSeats ? -0.42 : rearLimit;
    const handleY = Math.min(topAt(p.body, rearDoor) - 0.08, H * 0.58);
    const low = Math.max(sill + 0.08, H * 0.28);
    const seam = (z: number, high: number): void => {
      const points = 5;
      for (let i = 0; i < points; i++) {
        const y0 = low + ((high - low) * i) / points;
        const y1 = low + ((high - low) * (i + 1)) / points;
        line(new THREE.Vector3(flank(side, y0), y0, z), new THREE.Vector3(flank(side, y1), y1, z), 0.007);
      }
    };
    seam(rearDoor, handleY + 0.06);
    seam(frontDoor, Math.min(H * 0.61, topAt(p.body, frontDoor) - 0.015));
    if (p.rearSeats) seam(rearLimit, handleY + 0.05);
    if (kind === 'ambulance' && side < 0) {
      // The kerb-side door into the patient compartment, just behind the cab, with its handle.
      const z1 = -0.09 * L - 0.12;
      const z0 = z1 - 0.6;
      const top = H * 0.86;
      seam(z0, top);
      seam(z1, top);
      line(new THREE.Vector3(flank(side, top), top, z0), new THREE.Vector3(flank(side, top), top, z1), 0.007);
      box(flank(side, H * 0.5), H * 0.5, z0 + 0.16, 0.029, 0.060, 0.22);
      box(flank(side, H * 0.5) + side * 0.019, H * 0.5 + 0.006, z0 + 0.16, 0.022, 0.025, 0.16, 1);
    }
    if (kind === 'van') {
      // A sliding door behind the cab's: its rear seam and top edge, its handle, and the track it runs back along.
      const slide = rearDoor - 1.1;
      const top = H * 0.86;
      seam(slide, top);
      line(new THREE.Vector3(flank(side, top), top, slide), new THREE.Vector3(flank(side, top), top, rearDoor), 0.007);
      line(new THREE.Vector3(flank(side, H * 0.6), H * 0.6, slide - 0.02), new THREE.Vector3(flank(side, H * 0.6), H * 0.6, -L / 2 + 0.2), 0.012);
      box(flank(side, H * 0.5), H * 0.5, slide + 0.16, 0.029, 0.060, 0.22);
      box(flank(side, H * 0.5) + side * 0.019, H * 0.5 + 0.006, slide + 0.16, 0.022, 0.025, 0.16, 1);
    }
    // Lower side sill only between the arches, leaving steering and spring travel unobstructed.
    const sillRear = p.wheelRear * L + p.wheelR + 0.13;
    const sillFront = p.wheelFront * L - p.wheelR - 0.13;
    if (boxy) {
      // The working vehicles wear dark rubbing strips along their flanks, between and outside the arches.
      const strip = (z0: number, z1: number): void => {
        if (z1 - z0 > 0.2) box(flank(side, sill), sill + 0.11, (z0 + z1) / 2, 0.03, 0.22, z1 - z0);
      };
      strip(sillRear, sillFront);
      strip(p.wheelFront * L + p.wheelR + 0.13, L / 2 - 0.12);
      strip(-L / 2 + 0.12, p.wheelRear * L - p.wheelR - 0.13);
    } else box(flank(side, sill), sill + 0.018, (sillRear + sillFront) / 2, 0.035, 0.055, sillFront - sillRear);
    const handles = p.rearSeats ? [rearDoor + 0.18, rearLimit + 0.18] : [rearDoor + 0.18];
    for (const z of handles) {
      box(flank(side, handleY), handleY, z, 0.029, 0.060, 0.22);
      box(flank(side, handleY) + side * 0.019, handleY + 0.006, z, 0.022, 0.025, 0.16, 1);
    }
    // The bright beltline runs below each side window, following the actual cabin profile.
    const cb = p.cabin[0]!;
    const rb = p.cabin[3]!;
    const cx = side * (hw - Math.max(0, p.cabinInset) + 0.018);
    line(new THREE.Vector3(cx, cb[1] + 0.025, cb[0]), new THREE.Vector3(cx, rb[1] + 0.025, rb[0]), 0.013, kind === 'swat' ? 0 : 1);
    // Mirror stem and aerodynamic capsule, kept close to the original body width.
    const mz = cb[0] - 0.13;
    const my = cb[1] + 0.10;
    box(side * (hw - 0.014), my - 0.015, mz, 0.16, 0.035, 0.08);
    const shell = new THREE.SphereGeometry(1, 10, 6);
    shell.scale(0.115, 0.072, 0.13);
    add(shell, 0, side * (hw + 0.055), my + 0.027, mz);
    const mirror = new THREE.PlaneGeometry(0.14, 0.082);
    mirror.rotateY(Math.PI);
    add(mirror, 3, side * (hw + 0.055), my + 0.027, mz - 0.116);
  }
  // Bonnet separation follows the shoulder instead of drawing arbitrary lines through the windscreen.
  if (!commercial) {
    const z0 = p.cabin[0]![0] + 0.08;
    const z1 = L * 0.43;
    if (z1 > z0) for (const side of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const za = z0 + ((z1 - z0) * i) / 6;
        const zb = z0 + ((z1 - z0) * (i + 1)) / 6;
        line(new THREE.Vector3(side * hw * 0.72, topAt(p.body, za) + 0.072, za), new THREE.Vector3(side * hw * 0.72, topAt(p.body, zb) + 0.072, zb), 0.006);
      }
    }
  }
  if (kind === 'sports') sportsKit(p, s.width, L, H, box, flank);
  if (kind === 'firetruck') fireEngineKit(p, s.width, L, H, box, flank);
  if (kind === 'bus') busKit(p, s.width, L, H, box);
  if (BACK_DOORS.has(kind)) backDoors(kind, s.width, L, H, ly, bumperY, box);
  if ((BACK_DOORS.has(kind) || kind === 'bus') && p.panes?.[0] && p.paneOut !== undefined) {
    // Wipers resting along the windscreen's foot, a centimetre off the glass.
    const w = p.panes[0];
    const dz = w.b[0] - w.a[0];
    const dy = w.b[1] - w.a[1];
    const len = Math.hypot(dz, dy);
    const off = p.paneOut + 0.012;
    const at = (x: number, t: number): THREE.Vector3 => new THREE.Vector3(x, w.a[1] + dy * t - (dz / len) * off, w.a[0] + dz * t + (dy / len) * off);
    const t = 0.09 / len;
    for (const [x0, x1] of [[w.x0 + 0.08, -0.06], [0.06, w.x1 - 0.2]] as const) line(at(x0, t), at(x1, t + 0.04 / len), 0.011);
  }
  if (BACK_DOORS.has(kind) && commercial) {
    // Rubber seals round the cab's side windows (cut into the flank; the ambulance's cab is a glass cabin).
    const c = p.cabin;
    for (const side of [-1, 1]) {
      for (let i = 0; i < c.length; i++) {
        const a = c[i]!;
        const b = c[(i + 1) % c.length]!;
        line(new THREE.Vector3(side * (hw + 0.006), a[1], a[0]), new THREE.Vector3(side * (hw + 0.006), b[1], b[0]), 0.014);
      }
    }
  }
  if (kind === 'muscle') {
    // A raised intake on the bonnet.
    const z = L * 0.22;
    box(0, topAt(p.body, z) + 0.1, z, s.width * 0.3, 0.07, 0.62);
    box(0, topAt(p.body, z) + 0.11, z + 0.3, s.width * 0.26, 0.05, 0.03, 1);
  }
  return merged(pieces);
}

function merged(pieces: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(pieces)!;
  for (const piece of pieces) piece.dispose();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

type BoxFn = (x: number, y: number, z: number, w: number, h: number, d: number, finish?: Finish) => void;
type LineFn = (a: THREE.Vector3, b: THREE.Vector3, radius: number, finish?: Finish) => void;
type AddFn = (geo: THREE.BufferGeometry, finish: Finish, x?: number, y?: number, z?: number) => void;

/**
 * The Haymaker's fittings, on its hood and cab `width` wide between its wheels: the grille and a bumper bar on the
 * nose, the front axle beam out to the wheels, the exhaust stack up the hood's side, the cab's corner posts, its
 * mirrors on arms and the step up to it, and the hitch and number plate on the back.
 */
function tractorKit(p: ExteriorProfile, width: number, L: number, H: number, box: BoxFn, line: LineFn, add: AddFn): void {
  const hw = width / 2;
  const end = L / 2 + 0.004;
  const sill = p.body[0]![1];
  // The grille under the head lamps, its slats, and a bumper bar under it.
  const g0 = sill + 0.2;
  const g1 = p.lightY * H - 0.12;
  box(0, (g0 + g1) / 2, end, width * 0.72, g1 - g0, 0.03);
  for (let y = g0 + 0.06; y < g1 - 0.03; y += 0.08) box(0, y, end + 0.012, width * 0.66, 0.025, 0.012, 1);
  box(0, sill + 0.08, end - 0.05, width * 0.9, 0.14, 0.12, 1);
  // The front axle beam under the hood, out to the wheel hubs.
  const fz = p.wheelFront * L;
  box(0, p.wheelR, fz, 1.75, 0.13, 0.15);
  // The exhaust stack up the hood's right side, ahead of the cab, with a bright cap.
  const cb = p.cabin[0]!;
  const ft = p.cabin[1]!;
  const rt = p.cabin[2]!;
  const rb = p.cabin[3]!;
  const ex = new THREE.Vector3(-hw + 0.12, topAt(p.body, cb[0] + 0.3), cb[0] + 0.3);
  line(ex, ex.clone().setY(ft[1] - 0.15), 0.05);
  box(ex.x, ft[1] - 0.12, ex.z, 0.13, 0.08, 0.13, 1);
  // The cab's four corner posts, just proud of its glass, and a rail round its waist.
  for (const side of [-1, 1]) {
    const x = side * (hw + 0.012);
    line(new THREE.Vector3(x, cb[1], cb[0]), new THREE.Vector3(x, ft[1], ft[0]), 0.035);
    line(new THREE.Vector3(x, rb[1], rb[0]), new THREE.Vector3(x, rt[1], rt[0]), 0.035);
    const waist = cb[1] + 0.45;
    line(new THREE.Vector3(x, waist, cb[0] - 0.05), new THREE.Vector3(x, waist, rb[0] + 0.05), 0.02, 1);
    // A mirror on an arm from the front post.
    const my = ft[1] - 0.45;
    box(side * (hw + 0.17), my, cb[0] - 0.04, 0.32, 0.03, 0.03, 1);
    box(side * (hw + 0.33), my, cb[0] - 0.04, 0.03, 0.24, 0.16);
  }
  // A step up to the cab on its left side, ahead of the rear wheel.
  for (const k of [0, 1]) box(hw + 0.1, sill + 0.15 + k * 0.33, cb[0] - 0.2, 0.22, 0.03, 0.34, 1);
  // The hitch and the number plate on the back.
  box(0, sill + 0.2, -end + 0.08, width * 0.5, 0.22, 0.16);
  box(0, sill + 0.2, -end - 0.01, 0.12, 0.12, 0.04, 1);
  box(0, sill + 0.5, -end + 0.01, 0.46, 0.19, 0.024);
  const plate = new THREE.PlaneGeometry(0.4, 0.145, 3, 1);
  plate.rotateY(Math.PI);
  add(plate, 2, 0, sill + 0.5, -end - 0.005);
}

/**
 * The fire engine's equipment body: satin aluminium roller shutters over its lockers (grooved across), between the
 * arches and over and behind the rear one, a broad chrome grille and bumper on the nose, a chrome rail at the waist of
 * the equipment body, and a ladder and a step on its back.
 */
function fireEngineKit(p: ExteriorProfile, width: number, L: number, H: number, box: BoxFn, flank: (side: number, y: number) => number): void {
  const archGap = 0.11;
  const rearArch0 = p.wheelRear * L - p.wheelR - archGap;
  const rearArch1 = p.wheelRear * L + p.wheelR + archGap;
  const cabBack = -0.07 * L;
  const top = 0.78 * H;
  const low = p.body[0]![1] + 0.12;
  const overArch = 2 * p.wheelR + archGap + 0.08;
  const lockers: Array<[number, number, number]> = [
    [rearArch1 + 0.08, cabBack - 0.1, low],
    [rearArch0 + 0.05, rearArch1 - 0.05, overArch],
    [-L / 2 + 0.12, rearArch0 - 0.08, low],
  ];
  for (const side of [-1, 1]) {
    for (const [z0, z1, y0] of lockers) {
      if (z1 - z0 < 0.3) continue;
      const x = flank(side, (y0 + top) / 2);
      box(x, (y0 + top) / 2, (z0 + z1) / 2, 0.025, top - y0, z1 - z0, 1);
      // The shutter's slats.
      for (let y = y0 + 0.1; y < top - 0.05; y += 0.1) box(x + side * 0.012, y, (z0 + z1) / 2, 0.008, 0.012, z1 - z0 - 0.04);
      // A lift bar along its foot.
      box(x + side * 0.02, y0 + 0.05, (z0 + z1) / 2, 0.02, 0.03, (z1 - z0) * 0.7, 1);
    }
    // The chrome rail along the top of the equipment body.
    box(flank(side, top + 0.06), top + 0.07, (cabBack - 0.1 - L / 2 + 0.12) / 2, 0.03, 0.03, cabBack - 0.1 + L / 2 - 0.12, 1);
  }
  // On its back, a satin ladder up to the roof on the left of the middle, and a satin step across its foot.
  const back = -L / 2 - 0.004;
  const ly0 = p.lightY * H;
  // (Within 3 cm of the back: VAL-CAR-002 holds the body to the sim's length.)
  for (const x of [0.12, 0.5]) box(x, (H * 0.3 + top + 0.1) / 2, back - 0.012, 0.03, top + 0.1 - H * 0.3, 0.024, 1);
  for (let y = H * 0.36; y < top + 0.05; y += 0.26) box(0.31, y, back - 0.016, 0.38, 0.022, 0.02, 1);
  box(0, ly0 - 0.3, back - 0.012, width * 0.86, 0.05, 0.03, 1);
  // Grille and bumper.
  const ly = p.lightY * H;
  box(0, ly + 0.28, L / 2 + 0.005, width * 0.56, 0.42, 0.024, 1);
  for (let i = 0; i < 6; i++) box(0, ly + 0.11 + i * 0.07, L / 2 + 0.022, width * 0.54, 0.018, 0.012);
  box(0, ly - 0.22, L / 2 + 0.012, width * 0.98, 0.16, 0.05, 1);
}

/**
 * A box van's back doors: the seam between the two leaves and along their top, satin handles either side of the seam
 * under the windows, and two dark hinges on each leaf's outer edge, over its tall lamp and under the roof.
 */
function backDoors(kind: VehicleKind, width: number, L: number, H: number, ly: number, bumperY: number, box: BoxFn): void {
  const hw = width / 2;
  const back = -L / 2 - 0.004;
  const top = H * 0.93;
  const foot = bumperY + 0.08;
  box(0, (foot + top) / 2, back, 0.016, top - foot, 0.012);
  box(0, top, back, width - 0.16, 0.014, 0.012);
  for (const side of [-1, 1]) {
    box(side * 0.075, H * 0.47, back - 0.012, 0.028, 0.16, 0.024, 1);
    const lamp = tailLamp(kind, hw, ly);
    for (const y of [lamp.y + lamp.h / 2 + 0.12, H * 0.86]) box(side * (hw - 0.07), y, back - 0.008, 0.05, 0.11, 0.022);
  }
}

/**
 * The bus's window pillars over its long side windows, its doors on the kerb side (its right, -x), satin rails framing
 * its window band, and the engine grille across its back.
 */
function busKit(p: ExteriorProfile, width: number, L: number, H: number, box: BoxFn): void {
  const fb = p.cabin[0]!;
  const ft = p.cabin[1]!;
  const rt = p.cabin[2]!;
  const y0 = fb[1];
  const y1 = ft[1];
  const hw = width / 2;
  const z0 = rt[0];
  const z1 = fb[0];
  const panes = Math.round((z1 - z0) / 1.25);
  for (const side of [-1, 1]) {
    for (let k = 1; k < panes; k++) {
      const z = z0 + ((z1 - z0) * k) / panes;
      box(side * (hw + 0.025), (y0 + y1) / 2, z, 0.02, y1 - y0, 0.09);
    }
  }
  // Two doors on the right: dark glazed leaves with a bright frame.
  const doors = [L * 0.4, -L * 0.02];
  for (const zc of doors) {
    box(-(hw + 0.02), H * 0.47, zc, 0.02, H * 0.74, 1.1, 1);
    box(-(hw + 0.03), H * 0.47, zc, 0.012, H * 0.7, 0.03);
  }
  // Satin rails under and over the window band, framing it (broken by the doors on the right).
  for (const side of [-1, 1]) {
    for (const [y, h] of [[y0 - 0.05, 0.06], [y1 + 0.05, 0.05]] as const) {
      const cuts = side < 0 && y < H * 0.84 ? doors.map((zc) => [zc - 0.58, zc + 0.58] as const) : [];
      let from = -L / 2 + 0.12;
      for (const [a, b] of [...cuts, [L / 2 - 0.12, L / 2] as const].sort((p, q) => p[0] - q[0])) {
        if (a - from > 0.1) box(side * (hw + 0.012), y, (from + a) / 2, 0.016, h, a - from, 1);
        from = b;
      }
    }
  }
  // The engine's louvred grille across the back, between the plate and the rear window.
  const back = -L / 2 - 0.004;
  const g0 = H * 0.3;
  const g1 = H * 0.48;
  box(0, (g0 + g1) / 2, back, width * 0.62, g1 - g0, 0.02);
  for (let y = g0 + 0.05; y < g1 - 0.02; y += 0.065) box(0, y, back - 0.012, width * 0.58, 0.018, 0.012, 1);
}

/** The sports car's aero kit: front splitter, side intakes ahead of the rear wheels, rear diffuser and bonnet vents. */
function sportsKit(p: ExteriorProfile, width: number, L: number, H: number, box: BoxFn, flank: (side: number, y: number) => number): void {
  const floor = p.body[0]![1] - 0.05;
  box(0, floor, L / 2 - 0.2, width * 0.9, 0.028, 0.42);
  for (let i = -2; i <= 2; i++) box(i * width * 0.12, floor + 0.05, -L / 2 + 0.12, 0.025, 0.11, 0.3);
  for (const side of [-1, 1]) {
    const y = H * 0.4;
    const z = p.wheelRear * L + p.wheelR + 0.42;
    box(flank(side, y) - side * 0.01, y, z, 0.03, 0.13, 0.46);
    box(flank(side, y) + side * 0.004, y + 0.075, z, 0.02, 0.018, 0.5, 1);
    // Twin vents on the bonnet, either side of its crown.
    const vz = L * 0.27;
    box(side * width * 0.2, topAt(p.body, vz) + 0.075, vz, width * 0.13, 0.02, 0.3);
  }
}
