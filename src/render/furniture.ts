// Procedural street furniture and dressing models. Every model is one non-indexed geometry with a vertex colour per
// part (one material, one instanced draw per cell), its origin at its foot, and `userData.parts` naming what it is made
// of (tests check the parts and the fit against the older, simpler models).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** A street lamp's luminaire point (props.ts LAMP_HEAD). */
interface Head { readonly y: number; readonly reach: number }

type Rgb = number;

/** Collects parts, each one colour, into a model. */
export class ModelBuilder {
  private readonly geos: THREE.BufferGeometry[] = [];
  readonly parts: string[] = [];

  add(part: string, geo: THREE.BufferGeometry, color: Rgb = 0xffffff, shade = 1): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    const c = new THREE.Color(color).multiplyScalar(shade);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geos.push(g);
    this.parts.push(part);
    return this;
  }

  build(name: string): THREE.BufferGeometry {
    const m = mergeGeometries(this.geos, false);
    if (!m) throw new Error(`${name}: mergeGeometries failed`);
    for (const g of this.geos) g.dispose();
    m.name = name;
    m.userData.parts = [...this.parts];
    m.computeBoundingBox();
    m.computeBoundingSphere();
    return m;
  }
}

/** A cylinder standing on y (its foot), centred at (x, z). */
export function cyl(rt: number, rb: number, h: number, seg: number, x = 0, y = 0, z = 0, open = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rt, rb, h, seg, 1, open).translate(x, y + h / 2, z);
}

/** A box centred at (x, y, z). */
export function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

/** A round bar from a to b. */
export function bar(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 6): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r, r, d.length(), seg, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

/** A square bar from a to b, `w` thick. */
function beam(a: THREE.Vector3, b: THREE.Vector3, w: number, d = w): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(w, len, d);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** The same surface seen from its other side (winding and normals reversed), for thin sheets drawn from both sides. */
export function flipped(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const name of ['position', 'normal', 'uv'] as const) {
    const a = g.getAttribute(name);
    if (!a) continue;
    for (let i = 0; i < a.count; i += 3) {
      for (let k = 0; k < a.itemSize; k++) {
        const t = a.getComponent(i + 1, k);
        a.setComponent(i + 1, k, a.getComponent(i + 2, k));
        a.setComponent(i + 2, k, t);
      }
    }
  }
  const n = g.getAttribute('normal');
  if (n) for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}

// ---------------------------------------------------------------------------------------------------------------------
// Street furniture

/** The lamp standard: a cast base, a tapered pole with collars and the arm out to the head (LAMP_HEAD). */
export function lampPoleGeometry(head: Head): THREE.BufferGeometry {
  const { y, reach } = head;
  const b = new ModelBuilder();
  b.add('base', cyl(0.19, 0.21, 0.07, 8), 0xffffff, 0.72);
  b.add('base', cyl(0.165, 0.18, 0.36, 8, 0, 0.07, 0, true), 0xffffff, 0.78);
  b.add('base', cyl(0.11, 0.165, 0.09, 8, 0, 0.43, 0, true), 0xffffff, 0.78);
  b.add('pole', cyl(0.065, 0.1, 6.03, 10, 0, 0.52, 0, true));
  b.add('collar', cyl(0.1, 0.1, 0.06, 10, 0, 0.6, 0, true), 0xffffff, 0.8);
  b.add('collar', cyl(0.078, 0.078, 0.05, 10, 0, 4.6, 0, true), 0xffffff, 0.8);
  b.add('cap', new THREE.SphereGeometry(0.072, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 6.55, 0));
  const curve = new THREE.QuadraticBezierCurve3(v3(0, 6.3, 0), v3(0, 6.75, 0.3), v3(0, y + 0.12, reach - 0.32));
  b.add('arm', new THREE.TubeGeometry(curve, 8, 0.045, 6));
  // A slim brace under the arm.
  b.add('arm', new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(v3(0, 5.8, 0.05), v3(0, 6.05, 0.45), v3(0, 6.5, 0.72)), 5, 0.018, 4), 0xffffff, 0.85);
  return b.build('lamp-pole');
}

/** The cobra head: a low dome on a closed rim round the lens, a clamp where the arm enters and a photocell on top. */
export function lampHeadGeometry(head: Head): THREE.BufferGeometry {
  const { y, reach } = head;
  const b = new ModelBuilder();
  b.add('head', new THREE.SphereGeometry(1, 14, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.18, 0.15, 0.39).translate(0, y + 0.05, reach));
  b.add('head', new THREE.CylinderGeometry(1, 1, 1, 14, 1, true).scale(0.18, 0.04, 0.39).translate(0, y + 0.03, reach), 0xffffff, 0.85);
  b.add('clamp', new THREE.CylinderGeometry(0.06, 0.07, 0.16, 8).rotateX(Math.PI / 2).translate(0, y + 0.11, reach - 0.3), 0xffffff, 0.8);
  b.add('photocell', cyl(0.035, 0.04, 0.05, 8, 0, y + 0.18, reach - 0.12), 0x6a6e72);
  return b.build('lamp-head');
}

/** The lens plate set in the head's underside: its underside is the head point. */
export function lampLensGeometry(head: Head): THREE.BufferGeometry {
  const { y, reach } = head;
  const g = box(0.26, 0.025, 0.56, 0, y + 0.0125, reach);
  g.name = 'lamp-lens';
  return g;
}

/** Signal bulb centres in the signal's frame (the head faces local +z); PropsView puts its bulbs here. */
export function signalBulbAt(k: number): [number, number, number] {
  return [0, 4.88 - k * 0.33, 0.21];
}

/** A traffic signal: base, pole, the three-lens head with a backplate, rimmed lenses under hooded visors, and a cap. */
export function signalPoleGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('base', cyl(0.15, 0.16, 0.05, 10), 0xffffff, 0.85);
  b.add('pole', cyl(0.085, 0.11, 5.2, 8, 0, 0, 0, true));
  b.add('head', box(0.36, 1.05, 0.28, 0, 4.55, 0.05));
  b.add('backplate', box(0.46, 1.2, 0.02, 0, 4.55, -0.1), 0x1a1b1d);
  for (let k = 0; k < 3; k++) {
    const [, by, bz] = signalBulbAt(k);
    b.add('lens', new THREE.RingGeometry(0.105, 0.13, 10).translate(0, by, bz - 0.02), 0xffffff, 0.7);
    // An open hood over the top half of the lens, 11 cm deep.
    b.add('visor', new THREE.CylinderGeometry(0.135, 0.135, 0.11, 8, 1, true, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).translate(0, by, bz + 0.055 - 0.01), 0xffffff, 0.9);
  }
  b.add('cap', box(0.42, 0.06, 0.36, 0, 5.1, 0.05));
  return b.build('signal-pole');
}

/** A fire hydrant: base flange, barrel, top ring, bonnet with its operating nut, two hose nozzles with caps and a pumper. */
export function hydrantGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const red = 0xffffff;
  b.add('base', cyl(0.19, 0.2, 0.07, 12, 0, 0, 0, true), red, 0.8);
  b.add('body', cyl(0.15, 0.16, 0.5, 12, 0, 0.07, 0, true), red);
  b.add('ring', cyl(0.175, 0.175, 0.045, 12, 0, 0.55, 0), red, 0.85);
  b.add('bonnet', new THREE.SphereGeometry(0.15, 12, 3, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.95, 1).translate(0, 0.58, 0), red);
  b.add('nut', cyl(0.035, 0.04, 0.08, 5, 0, 0.72, 0), 0xb0aea8);
  for (const s of [-1, 1]) {
    b.add('nozzle', new THREE.CylinderGeometry(0.05, 0.055, 0.08, 8, 1, true).rotateZ(Math.PI / 2).translate(s * 0.19, 0.38, 0), red, 0.9);
    b.add('cap', new THREE.CylinderGeometry(0.065, 0.065, 0.04, 6).rotateZ(Math.PI / 2).translate(s * 0.25, 0.38, 0), 0xd8d4c8);
  }
  b.add('nozzle', new THREE.CylinderGeometry(0.06, 0.065, 0.05, 8, 1, true).rotateX(Math.PI / 2).translate(0, 0.33, 0.175), red, 0.9);
  b.add('cap', new THREE.CylinderGeometry(0.075, 0.075, 0.035, 6).rotateX(Math.PI / 2).translate(0, 0.33, 0.215), 0xd8d4c8);
  return b.build('hydrant');
}

const WOOD = 0x9a6a3e;
const IRON = 0x2b2d31;

/** A park bench: seven wooden slats (four in the seat, three in the back) on two cast-iron side frames with armrests. */
export function benchGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  [-0.165, -0.075, 0.015, 0.105].forEach((z, i) => b.add('slat', box(1.8, 0.035, 0.08, 0, 0.445, z), WOOD, 0.92 + (i % 2) * 0.08));
  // The back leans 14 degrees.
  const lean = 0.25;
  [0.6, 0.73, 0.86].forEach((y, i) => b.add('slat', box(1.8, 0.085, 0.028, 0, y, -0.19 - (y - 0.5) * lean).rotateX(0), WOOD, 0.95 + (i % 2) * 0.06));
  for (const x of [-0.78, 0.78]) {
    b.add('leg', beam(v3(x, 0, 0.15), v3(x, 0.66, 0.12), 0.045), IRON);
    b.add('leg', beam(v3(x, 0, -0.16), v3(x, 0.94, -0.24), 0.045), IRON);
    b.add('frame', box(0.045, 0.04, 0.4, x, 0.415, -0.02), IRON);
    b.add('armrest', box(0.06, 0.035, 0.42, x, 0.665, -0.01), IRON);
    b.add('foot', box(0.07, 0.02, 0.1, x, 0.01, 0.15), IRON);
    b.add('foot', box(0.07, 0.02, 0.1, x, 0.01, -0.16), IRON);
  }
  b.add('frame', box(1.56, 0.03, 0.03, 0, 0.12, -0.02), IRON);
  return b.build('bench');
}

/** A litter bin: base ring, ribbed body, rolled rim and a domed lid with its slot. */
export function binGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('base', cyl(0.25, 0.26, 0.06, 12, 0, 0, 0, true), 0xffffff, 0.7);
  b.add('body', cyl(0.27, 0.25, 0.82, 12, 0, 0.06, 0, true));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.add('rib', box(0.04, 0.78, 0.025, Math.sin(a) * 0.268, 0.47, Math.cos(a) * 0.268).rotateY(0), 0xffffff, 0.82);
  }
  b.add('rim', new THREE.TorusGeometry(0.278, 0.025, 3, 12).rotateX(Math.PI / 2).translate(0, 0.885, 0), 0xffffff, 0.8);
  b.add('lid', new THREE.SphereGeometry(0.27, 12, 3, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.4, 1).translate(0, 0.89, 0), 0xffffff, 0.92);
  b.add('slot', box(0.24, 0.05, 0.04, 0, 0.93, 0.21), 0x111111);
  return b.build('bin');
}

/** A short street or mooring bollard with a rounded cap and a light band. */
export function bollardGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('post', cyl(0.13, 0.15, 0.42, 12), 0x3a3d42);
  b.add('band', cyl(0.135, 0.135, 0.05, 12, 0, 0.3, 0), 0xd9c35a);
  b.add('cap', new THREE.SphereGeometry(0.19, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.5, 1).translate(0, 0.42, 0), 0x2e3135);
  return b.build('bollard');
}

/** A 2.4 m run of deck railing (centred on its post): a post, a top rail and a mid rail, along local x. */
export const RAIL_RUN = 2.4;
export function railGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('post', box(0.09, 1.05, 0.09, 0, 0.525, 0), 0xe8e4da, 0.92);
  b.add('post', box(0.12, 0.04, 0.12, 0, 1.07, 0), 0xe8e4da, 0.85);
  b.add('rail', box(RAIL_RUN, 0.06, 0.07, 0, 1.0, 0), 0xe8e4da);
  b.add('rail', box(RAIL_RUN, 0.04, 0.04, 0, 0.55, 0), 0xe8e4da, 0.9);
  return b.build('rail');
}

// ---------------------------------------------------------------------------------------------------------------------
// Beach and yard dressing

export function umbrellaGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('pole', cyl(0.022, 0.026, 2.35, 6), 0xf0ede6);
  // Alternating panels: the instance colour tints the white ones.
  const seg = 8;
  for (let i = 0; i < seg; i++) {
    const panel = new THREE.ConeGeometry(1.15, 0.38, seg, 1, true, (i / seg) * Math.PI * 2, (Math.PI * 2) / seg).translate(0, 2.2, 0);
    b.add('canopy', panel.clone(), i % 2 ? 0xffffff : 0xf4f1ea);
    b.add('canopy', flipped(panel), i % 2 ? 0xffffff : 0xf4f1ea, 0.75);
  }
  b.add('finial', new THREE.SphereGeometry(0.04, 6, 4).translate(0, 2.42, 0), 0xf0ede6);
  return b.build('umbrella');
}

export function towelGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  for (let k = 0; k < 5; k++) b.add('towel', box(0.8, 0.012, 0.34, 0, 0.006, -0.68 + k * 0.34), k % 2 ? 0xffffff : 0xf2efe8, k % 2 ? 1 : 0.9);
  return b.build('towel');
}

export function loungerGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const frame = 0xe9e7e2;
  for (const x of [-0.3, 0.3]) {
    b.add('frame', beam(v3(x, 0.3, -0.85), v3(x, 0.3, 0.55), 0.04), frame);
    b.add('frame', beam(v3(x, 0.3, 0.55), v3(x, 0.85, 1.0), 0.04), frame);
    for (const z of [-0.8, 0.45]) b.add('leg', beam(v3(x, 0, z), v3(x, 0.3, z), 0.04), frame);
  }
  for (let k = 0; k < 7; k++) b.add('slat', box(0.56, 0.025, 0.16, 0, 0.33, -0.78 + k * 0.2), 0xffffff, 0.95);
  for (let k = 0; k < 3; k++) {
    const t = (k + 0.5) / 3;
    b.add('slat', box(0.56, 0.025, 0.16, 0, 0.33 + t * 0.53, 0.58 + t * 0.42).rotateX(0), 0xffffff, 0.95);
  }
  return b.build('lounger');
}

export function lifeguardGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const white = 0xf2efe6;
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) b.add('leg', beam(v3(x * 1.05, 0, z * 1.05), v3(x * 0.9, 2.0, z * 0.9), 0.12), white);
  b.add('brace', beam(v3(-1.0, 0.6, -1.0), v3(1.0, 1.6, -1.0), 0.06), white, 0.9);
  b.add('brace', beam(v3(-1.0, 1.6, 1.0), v3(1.0, 0.6, 1.0), 0.06), white, 0.9);
  b.add('deck', box(2.6, 0.12, 2.6, 0, 2.06, 0), 0xc9b48c);
  b.add('hut', box(1.9, 1.5, 1.7, 0, 2.87, -0.25), 0xe14b3b);
  b.add('window', box(1.5, 0.55, 0.02, 0, 3.1, 0.61), 0x29384a);
  b.add('roof', new THREE.ConeGeometry(1.65, 0.7, 4).rotateY(Math.PI / 4).translate(0, 3.97, -0.25), 0xf4d03f);
  b.add('rail', box(2.6, 0.06, 0.06, 0, 3.0, 1.27), white);
  for (const x of [-1.27, 1.27]) b.add('rail', box(0.06, 0.06, 2.6, x, 3.0, 0), white);
  for (let k = 0; k < 7; k++) b.add('ramp', box(0.9, 0.05, 0.3, 0, 0.3 * k, 1.5 + (6 - k) * 0.28), 0xc9b48c);
  b.add('ramp', beam(v3(-0.45, 0, 3.3), v3(-0.45, 2.0, 1.3), 0.06), white);
  b.add('ramp', beam(v3(0.45, 0, 3.3), v3(0.45, 2.0, 1.3), 0.06), white);
  return b.build('lifeguard');
}

/** A beach volleyball net, 9 m between its posts along local x. */
export function volleyballGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  for (const x of [-4.6, 4.6]) b.add('post', cyl(0.05, 0.06, 2.55, 8, x, 0, 0), 0xe9e7e2);
  b.add('net', box(9.1, 0.9, 0.012, 0, 2.0, 0), 0x2b2b2b);
  b.add('tape', box(9.1, 0.06, 0.02, 0, 2.43, 0), 0xffffff);
  b.add('ball', new THREE.SphereGeometry(0.11, 10, 6).translate(1.2, 0.11, 1.6), 0xf4e6a8);
  return b.build('volleyball');
}

export function surfboardGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  // Stood up in the sand, leaning back a little.
  b.add('board', new THREE.SphereGeometry(1, 12, 6).scale(0.27, 1.05, 0.045).translate(0, 0.95, 0).rotateX(-0.12), 0xffffff);
  b.add('stripe', new THREE.SphereGeometry(1, 10, 4).scale(0.05, 0.9, 0.05).translate(0, 0.98, 0).rotateX(-0.12), 0x1d2a3a);
  return b.build('surfboard');
}

/** A 2 m run of white picket fence along local x: a post, two rails and eight pointed pickets, flat boards seen from both sides. */
export const FENCE_RUN = 2;
export function fenceGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const white = 0xf3f1ea;
  const board = (part: string, g: THREE.BufferGeometry, shade: number) => {
    b.add(part, g.clone(), white, shade);
    b.add(part, flipped(g), white, shade * 0.9);
  };
  b.add('post', box(0.08, 1.05, 0.08, -FENCE_RUN / 2 + 0.04, 0.525, 0), white, 0.92);
  for (const y of [0.32, 0.78]) board('rail', new THREE.PlaneGeometry(FENCE_RUN, 0.07).translate(0, y, -0.025), 0.86);
  const picket = new THREE.Shape();
  picket.moveTo(-0.0375, 0);
  picket.lineTo(0.0375, 0);
  picket.lineTo(0.0375, 0.86);
  picket.lineTo(0, 0.95);
  picket.lineTo(-0.0375, 0.86);
  picket.closePath();
  for (let k = 0; k < 8; k++) board('picket', new THREE.ShapeGeometry(picket).translate(-FENCE_RUN / 2 + 0.17 + k * 0.235, 0, 0), 1);
  return b.build('fence');
}

export function mailboxGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('post', box(0.08, 1.0, 0.08, 0, 0.5, 0), 0x6b4a2b);
  b.add('box', box(0.2, 0.16, 0.46, 0, 1.08, 0), 0xffffff);
  b.add('box', new THREE.CylinderGeometry(0.1, 0.1, 0.46, 10, 1, false, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).translate(0, 1.16, 0), 0xffffff);
  b.add('flag', box(0.015, 0.2, 0.05, 0.11, 1.2, -0.12), 0xd03a2a);
  return b.build('mailbox');
}

/** A clipped garden shrub: a lumpy low mass. */
export function shrubGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const lumps: Array<[number, number, number, number]> = [[0, 0.32, 0, 0.42], [0.3, 0.26, 0.08, 0.3], [-0.28, 0.24, -0.06, 0.3], [0.05, 0.5, -0.05, 0.28]];
  lumps.forEach(([x, y, z, r], i) => {
    const g = new THREE.IcosahedronGeometry(r, 0);
    const p = g.getAttribute('position');
    for (let k = 0; k < p.count; k++) {
      const n = 1 + 0.08 * Math.sin(p.getX(k) * 17 + i) * Math.sin(p.getZ(k) * 13 - p.getY(k) * 9);
      p.setXYZ(k, p.getX(k) * n + x, Math.max(0, p.getY(k) * n * 0.85 + y), p.getZ(k) * n + z);
    }
    g.computeVertexNormals();
    b.add('shrub', g, 0x3f6b2c, 0.85 + i * 0.06);
  });
  return b.build('shrub');
}

export function planterGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('pot', cyl(0.3, 0.24, 0.42, 10, 0, 0, 0, true), 0xb4643c);
  b.add('soil', new THREE.CircleGeometry(0.28, 10).rotateX(-Math.PI / 2).translate(0, 0.4, 0), 0x3b2a1d);
  const colors = [0xe0425b, 0xf2c14e, 0xffffff, 0xd96bd6];
  for (let k = 0; k < 6; k++) {
    const a = k * 2.4;
    const r = 0.05 + (k % 3) * 0.07;
    b.add('leaves', new THREE.OctahedronGeometry(0.11, 0).translate(Math.sin(a) * r, 0.47 + (k % 2) * 0.05, Math.cos(a) * r), 0x3e6e2e);
    b.add('flower', new THREE.OctahedronGeometry(0.055, 0).translate(Math.sin(a) * r, 0.58 + (k % 2) * 0.05, Math.cos(a) * r), colors[k % colors.length]!);
  }
  return b.build('planter');
}

/** A wheelie bin, its lid hinged at the back (local -z) and its wheels there. */
export function wheelieBinGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('body', box(0.58, 0.95, 0.68, 0, 0.5, 0), 0xffffff);
  b.add('lid', box(0.62, 0.05, 0.74, 0, 1.0, 0.01), 0xffffff, 0.85);
  b.add('handle', box(0.5, 0.04, 0.05, 0, 0.98, -0.38), 0x222222);
  for (const x of [-0.27, 0.27]) b.add('wheel', new THREE.CylinderGeometry(0.1, 0.1, 0.05, 10).rotateZ(Math.PI / 2).translate(x, 0.1, -0.34), 0x1a1a1a);
  return b.build('wheelie');
}

// ---------------------------------------------------------------------------------------------------------------------
// Garage furnishing (render only: nothing here is solid)

export function workbenchGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('top', box(2.0, 0.06, 0.7, 0, 0.9, 0), 0x8a6a45);
  for (const x of [-0.94, 0.94]) for (const z of [-0.3, 0.3]) b.add('leg', box(0.06, 0.87, 0.06, x, 0.435, z), 0x4a5560);
  b.add('shelf', box(1.9, 0.03, 0.6, 0, 0.2, 0), 0x6e5536);
  b.add('vice', box(0.16, 0.12, 0.2, 0.75, 0.99, 0.22), 0x2f5d8a);
  b.add('toolbox', box(0.5, 0.22, 0.24, -0.5, 1.04, -0.12), 0xc0392b);
  b.add('can', cyl(0.07, 0.07, 0.2, 8, 0.2, 0.93, -0.2), 0xd9c35a);
  b.add('box', box(0.5, 0.3, 0.4, -0.4, 0.37, 0.02), 0xa8865a);
  return b.build('workbench');
}

/** A pegboard with tools, mounted on a wall (its back at local z = 0, facing +z). */
export function toolWallGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('board', box(2.0, 1.0, 0.03, 0, 0.5, 0.015), 0xa98d63);
  const tools: Array<[number, number, number, number, number]> = [[-0.8, 0.6, 0.05, 0.42, 0x8a8f96], [-0.6, 0.55, 0.05, 0.32, 0xc0392b], [-0.35, 0.62, 0.22, 0.05, 0x8a8f96], [-0.1, 0.5, 0.04, 0.5, 0x8a8f96], [0.15, 0.6, 0.05, 0.3, 0xf1c40f], [0.4, 0.55, 0.28, 0.06, 0x8a8f96], [0.7, 0.62, 0.06, 0.38, 0x2f5d8a], [0.85, 0.3, 0.12, 0.12, 0x222222]];
  for (const [x, y, w, h, c] of tools) b.add('tool', box(w, h, 0.03, x, y, 0.05), c);
  for (let k = 0; k < 6; k++) b.add('tool', box(0.03, 0.2, 0.03, -0.75 + k * 0.08, 0.2, 0.05), 0x8a8f96);
  return b.build('toolwall');
}

/** Freestanding shelving, 1.6 m long and `depth` deep, with boxes and cans; its back at local z = 0. */
export function shelvingGeometry(depth = 0.5): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const steel = 0x5e6a75;
  for (const x of [-0.78, 0.78]) for (const z of [0.02, depth - 0.02]) b.add('upright', box(0.04, 2.1, 0.04, x, 1.05, z), steel);
  const stuff = [0xa8865a, 0xc0392b, 0x2f5d8a, 0xd9c35a, 0x3a7d44, 0x8a8f96];
  [0.15, 0.65, 1.15, 1.65, 2.05].forEach((y, i) => {
    b.add('shelf', box(1.6, 0.03, depth, 0, y, depth / 2), steel, 0.9);
    if (i === 4) return;
    for (let k = 0; k < 4; k++) {
      const w = 0.22 + ((k + i) % 3) * 0.06;
      const h = 0.18 + ((k * 2 + i) % 3) * 0.08;
      b.add('box', box(w, h, Math.min(depth - 0.06, 0.34), -0.55 + k * 0.37, y + 0.015 + h / 2, depth / 2), stuff[(k + i * 2) % stuff.length]!);
    }
  });
  return b.build(depth < 0.4 ? 'wallshelf' : 'shelving');
}

/** A stack of four tyres lying flat. */
export function tyreStackGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  for (let k = 0; k < 4; k++) {
    b.add('tyre', new THREE.TorusGeometry(0.24, 0.1, 6, 14).rotateX(Math.PI / 2).translate(0.02 * (k % 2), 0.1 + k * 0.2, 0), 0x1c1c1c, 1 + (k % 2) * 0.15);
  }
  return b.build('tyres');
}

/** Four tyres hung flat against the wall on a rack (0.2 m deep, its back at local z = 0). */
export function tyreRackGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  for (const x of [-0.8, 0.8]) b.add('upright', box(0.04, 1.45, 0.03, x, 0.725, 0.015), 0x5e6a75);
  for (const y of [0.37, 1.08]) {
    b.add('rail', box(1.64, 0.035, 0.03, 0, y + 0.3, 0.03), 0x5e6a75);
    for (const x of [-0.4, 0.4]) b.add('tyre', new THREE.TorusGeometry(0.26, 0.085, 6, 16).translate(x, y, 0.1), 0x1c1c1c, 1 + (x > 0 ? 0.15 : 0));
  }
  return b.build('tyrerack');
}

export function drumGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('drum', cyl(0.29, 0.29, 0.88, 14), 0xffffff);
  for (const y of [0.03, 0.3, 0.6, 0.86]) b.add('hoop', new THREE.TorusGeometry(0.292, 0.012, 4, 14).rotateX(Math.PI / 2).translate(0, y, 0), 0xffffff, 0.75);
  b.add('lid', cyl(0.27, 0.27, 0.01, 14, 0, 0.88, 0), 0xffffff, 0.85);
  b.add('bung', cyl(0.03, 0.03, 0.02, 6, 0.15, 0.885, 0.05), 0x333333);
  return b.build('drum');
}

/** A rolling tool chest: drawers over a cabinet on casters. */
export function toolChestGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('cabinet', box(0.9, 0.62, 0.48, 0, 0.42, 0), 0xc0392b);
  b.add('chest', box(0.88, 0.42, 0.44, 0, 0.95, 0), 0xc0392b, 0.92);
  for (let k = 0; k < 6; k++) b.add('drawer', box(0.8, 0.012, 0.01, 0, 0.2 + k * 0.13 + (k > 3 ? 0.08 : 0), 0.245), 0x8a8f96);
  for (const x of [-0.38, 0.38]) for (const z of [-0.18, 0.18]) b.add('caster', new THREE.CylinderGeometry(0.05, 0.05, 0.03, 8).rotateZ(Math.PI / 2).translate(x, 0.05, z), 0x1a1a1a);
  b.add('handle', box(0.04, 0.04, 0.4, 0.5, 0.95, 0), 0x8a8f96);
  return b.build('chest');
}

/** A floor jack. */
export function jackGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('body', box(0.32, 0.14, 0.75, 0, 0.12, 0), 0xc0392b);
  b.add('saddle', cyl(0.07, 0.07, 0.05, 10, 0, 0.19, 0.3), 0x333333);
  b.add('handle', bar(v3(0, 0.15, -0.35), v3(0, 0.75, -1.05), 0.018), 0x333333);
  for (const x of [-0.14, 0.14]) for (const z of [-0.3, 0.3]) b.add('wheel', new THREE.CylinderGeometry(0.05, 0.05, 0.03, 8).rotateZ(Math.PI / 2).translate(x, 0.05, z), 0x1a1a1a);
  return b.build('jack');
}

/** A fluorescent ceiling fixture: the housing (this geometry) hangs from local y = 0 down; its tubes are lampTubeGeometry. */
export function lampHousingGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('housing', box(1.3, 0.06, 0.26, 0, -0.03, 0), 0xd6d8da);
  for (const x of [-0.55, 0.55]) b.add('chain', box(0.01, 0.3, 0.01, x, 0.15, 0), 0x777777);
  return b.build('lamphousing');
}

export function lampTubeGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  for (const z of [-0.06, 0.06]) b.add('tube', new THREE.CylinderGeometry(0.022, 0.022, 1.2, 6).rotateZ(Math.PI / 2).translate(0, -0.085, z), 0xffffff);
  return b.build('lamptube');
}

/** Two posters side by side on a wall (their back at local z = 0, facing +z), mapped from the posters texture. */
export function posterGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1.24, 0.86).translate(0, 0.43, 0.012);
  const b = new ModelBuilder();
  b.add('poster', g, 0xffffff);
  return b.build('poster');
}

/** Number of triangles of a geometry (indexed or not). */
export function triangles(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}
