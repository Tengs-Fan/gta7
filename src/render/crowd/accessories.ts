// Accessories added to the character models: hats, glasses, the police kit, bags and jewellery. Built in the rig's rest
// pose (rig.ts), fitted to the body they are put on (measured from the fitted model), each rigid on one rig bone.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BONE, REST, SLOT, type RigBone, type Slot } from './rig';
import type { AccessoryId } from './looks';

/** Where accessories go on a fitted body (rest pose, metres). */
export interface BodyMeasure {
  /** Skull (skin of the head) and everything on the head (hair, hats of the model). */
  skull: THREE.Box3;
  headTop: THREE.Box3;
  /** Eye centres' height and the front of the face at the eyes. */
  eyeY: number;
  eyeX: number;
  faceZ: number;
  /** Waist at belt height: half width, front and back. */
  beltY: number;
  waistX: number;
  waistFront: number;
  waistBack: number;
  /** Chest front and back at the chest bone's height, and its half width. */
  chestY: number;
  chestFront: number;
  chestBack: number;
  chestX: number;
  /** Neck base radius. */
  neckR: number;
}

export interface AccessoryPart {
  geometry: THREE.BufferGeometry;
  bone: RigBone;
  slot: Slot;
  color: number;
}

/** Non-indexed, position + normal only (merged later with the attributes of a character geometry). */
function clean(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(ng.attributes)) if (k !== 'position' && k !== 'normal') ng.deleteAttribute(k);
  return ng;
}

function merge(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(gs.map(clean), false);
  if (!m) throw new Error('accessory merge failed');
  return m;
}

const part = (geometry: THREE.BufferGeometry, bone: RigBone, slot: Slot, color = 0xffffff): AccessoryPart => ({ geometry: clean(geometry), bone, slot, color });

/** A dome over the top of the head from height `base`, wrapping the skull and hair. */
function dome(m: BodyMeasure, base: number, lift: number, grow: number): THREE.BufferGeometry {
  const b = m.headTop;
  const cx = (b.min.x + b.max.x) / 2;
  const cz = (b.min.z + b.max.z) / 2 + 0.004;
  const rx = (b.max.x - b.min.x) / 2 + grow;
  const rz = (b.max.z - b.min.z) / 2 + grow;
  const ry = b.max.y - base + lift;
  return new THREE.SphereGeometry(1, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(rx, ry, rz).translate(cx, base, cz);
}

/** Half disc in front (z > 0), `len` out from the dome's front edge. */
function brim(m: BodyMeasure, y: number, len: number, droop: number, thick = 0.012): THREE.BufferGeometry {
  const b = m.headTop;
  const rx = (b.max.x - b.min.x) / 2 + 0.012;
  const front = b.max.z + 0.006;
  const g = new THREE.CylinderGeometry(1, 1, thick, 20, 1, false, -Math.PI / 2, Math.PI);
  g.scale(rx, 1, len).rotateX(droop).translate((b.min.x + b.max.x) / 2, y, front - len * 0.15);
  return g;
}

/** A ring round the body (axis y) at height y: half widths rx, rz, centred at cz, `h` tall and `t` thick. */
function band(rx: number, rz: number, cz: number, y: number, h: number, t: number, seg = 20): THREE.BufferGeometry {
  const outer = new THREE.CylinderGeometry(1, 1, h, seg, 1, true).scale(rx + t, 1, rz + t);
  const top = new THREE.RingGeometry(1, 1 + t / Math.max(rx, 0.01), seg).rotateX(-Math.PI / 2).scale(rx, 1, rz).translate(0, h / 2, 0);
  return merge([outer, top]).translate(0, y, cz);
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

function rounded(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  // A box with its edges softened by squashing a low-poly sphere into it.
  const s = new THREE.SphereGeometry(1, 10, 8);
  const p = s.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i);
    const vy = p.getY(i);
    const vz = p.getZ(i);
    const k = 0.62;
    const f = (a: number) => Math.sign(a) * Math.pow(Math.abs(a), k);
    p.setXYZ(i, f(vx) * w / 2, f(vy) * h / 2, f(vz) * d / 2);
  }
  s.computeVertexNormals();
  return s.translate(x, y, z);
}

function lensFrames(m: BodyMeasure, filled: boolean): THREE.BufferGeometry[] {
  const gs: THREE.BufferGeometry[] = [];
  const z = m.faceZ + 0.008;
  for (const side of [1, -1]) {
    const x = side * m.eyeX;
    if (filled) gs.push(new THREE.CylinderGeometry(0.026, 0.024, 0.006, 14).rotateX(Math.PI / 2).scale(1.15, 0.85, 1).translate(x, m.eyeY, z));
    else gs.push(new THREE.TorusGeometry(0.024, 0.0035, 5, 16).scale(1.15, 0.9, 1).translate(x, m.eyeY, z));
    // Temple arm back to the ear.
    gs.push(box(0.005, 0.006, 0.11, side * (m.eyeX + 0.03), m.eyeY + 0.006, z - 0.055));
  }
  gs.push(box(0.022, 0.005, 0.005, 0, m.eyeY + 0.006, z));
  return gs;
}

export function accessory(id: AccessoryId, m: BodyMeasure): AccessoryPart[] {
  const head = m.headTop;
  switch (id) {
    case 'cap': {
      const base = m.eyeY + 0.045;
      return [part(merge([dome(m, base, 0.01, 0.012), box(0.02, 0.012, 0.02, (head.min.x + head.max.x) / 2, head.max.y + 0.014, (head.min.z + head.max.z) / 2)]), 'head', SLOT.hat), part(brim(m, base + 0.004, 0.085, 0.14), 'head', SLOT.hat)];
    }
    case 'beanie': {
      const base = m.eyeY + 0.04;
      return [part(merge([dome(m, base, 0.035, 0.014), band((head.max.x - head.min.x) / 2 + 0.012, (head.max.z - head.min.z) / 2 + 0.012, (head.min.z + head.max.z) / 2, base + 0.015, 0.03, 0.008)]), 'head', SLOT.hat)];
    }
    case 'policeCap': {
      // Peaked patrol cap: a flat crown wider than the band, a black band and visor, a gold cap badge.
      const base = m.eyeY + 0.042;
      const cx = (head.min.x + head.max.x) / 2;
      const cz = (head.min.z + head.max.z) / 2;
      const rx = (head.max.x - head.min.x) / 2 + 0.014;
      const rz = (head.max.z - head.min.z) / 2 + 0.014;
      const top = Math.max(head.max.y + 0.02, base + 0.1);
      const crown = new THREE.CylinderGeometry(1.12, 1, top - base - 0.03, 20, 1, false).scale(rx, 1, rz * 1.04).translate(cx, (top + base + 0.03) / 2, cz + 0.008);
      const lid = new THREE.CylinderGeometry(1.12, 1.12, 0.012, 20).scale(rx, 1, rz * 1.04).translate(cx, top, cz + 0.008);
      const bandG = new THREE.CylinderGeometry(1, 1, 0.035, 20, 1, false).scale(rx + 0.002, 1, rz + 0.002).translate(cx, base + 0.015, cz);
      return [
        part(merge([crown, lid]), 'head', SLOT.hat),
        part(merge([bandG, brim(m, base + 0.002, 0.075, 0.32, 0.01)]), 'head', SLOT.fixed, 0x0b0b0d),
        part(new THREE.CylinderGeometry(0.016, 0.016, 0.006, 6).rotateX(Math.PI / 2).translate(cx, base + 0.055, head.max.z + 0.014), 'head', SLOT.fixed, 0xd9b44a),
      ];
    }
    case 'glasses':
      return [part(merge(lensFrames(m, false)), 'head', SLOT.fixed, 0x1c1c1e)];
    case 'sunglasses':
      return [part(merge(lensFrames(m, true)), 'head', SLOT.fixed, 0x101418)];
    case 'bandana': {
      const y = m.eyeY + 0.05;
      const rx = (m.skull.max.x - m.skull.min.x) / 2 + 0.006;
      const rz = (m.skull.max.z - m.skull.min.z) / 2 + 0.006;
      const cz = (m.skull.min.z + m.skull.max.z) / 2;
      const knot = box(0.03, 0.03, 0.03, 0, y - 0.005, m.skull.min.z - 0.012);
      const tails = box(0.02, 0.07, 0.008, 0.012, y - 0.045, m.skull.min.z - 0.018).rotateZ(0.15);
      return [part(merge([band(rx, rz, cz, y, 0.036, 0.006), knot, tails]), 'head', SLOT.hat)];
    }
    case 'dutyBelt': {
      const y = m.beltY;
      const cz = (m.waistFront + m.waistBack) / 2;
      const rz = (m.waistFront - m.waistBack) / 2 + 0.004;
      const rx = m.waistX + 0.004;
      const kit = [
        band(rx, rz, cz, y, 0.05, 0.012),
        // Holster on the right hip, pouches and cuff case round the front and left.
        rounded(0.05, 0.13, 0.06, -(rx + 0.02), y - 0.04, cz + 0.01),
        rounded(0.045, 0.055, 0.03, rx * 0.55, y, m.waistFront + 0.012),
        rounded(0.045, 0.055, 0.03, -rx * 0.55, y, m.waistFront + 0.012),
        rounded(0.04, 0.05, 0.035, rx + 0.012, y - 0.005, cz + 0.02),
      ];
      return [part(merge(kit), 'hips', SLOT.fixed, 0x111214), part(box(0.04, 0.03, 0.01, 0, y, m.waistFront + 0.016), 'hips', SLOT.fixed, 0xb8a46a)];
    }
    case 'radio': {
      // Shoulder mic on the left chest strap, the set on the belt side.
      const y = m.chestY + 0.06;
      return [part(merge([
        rounded(0.035, 0.06, 0.022, m.chestX * 0.55, y, m.chestFront + 0.012),
        box(0.006, 0.05, 0.006, m.chestX * 0.55 + 0.012, y + 0.05, m.chestFront + 0.012),
        new THREE.CylinderGeometry(0.004, 0.004, 0.16, 5).rotateZ(0.5).translate(m.chestX * 0.75, y - 0.06, m.chestFront + 0.004),
      ]), 'chest', SLOT.fixed, 0x15161a)];
    }
    case 'badge':
      return [part(new THREE.CylinderGeometry(0.026, 0.022, 0.006, 6).rotateX(Math.PI / 2).scale(1, 1.15, 1).translate(-m.chestX * 0.5, m.chestY + 0.05, m.chestFront + 0.008), 'chest', SLOT.fixed, 0xd6b24c)];
    case 'backpack': {
      const y = m.chestY - 0.06;
      const z = m.chestBack - 0.07;
      const straps = [1, -1].map((s) => box(0.035, 0.34, 0.012, s * m.chestX * 0.55, m.chestY - 0.02, m.chestFront + 0.002).rotateX(0.02));
      const over = [1, -1].map((s) => box(0.035, 0.012, m.chestFront - m.chestBack + 0.04, s * m.chestX * 0.55, m.chestY + 0.15, (m.chestFront + m.chestBack) / 2));
      return [part(rounded(0.3, 0.38, 0.15, 0, y, z), 'chest', SLOT.accent), part(merge([...straps, ...over]), 'chest', SLOT.fixed, 0x1d1f22)];
    }
    case 'shoulderBag': {
      const strap = box(0.03, 0.62, 0.012, 0, 0, 0).rotateZ(0.75).translate(0, m.chestY - 0.1, m.chestFront + 0.008);
      const back = box(0.03, 0.62, 0.012, 0, 0, 0).rotateZ(-0.75).translate(0, m.chestY - 0.1, m.chestBack - 0.008);
      return [part(rounded(0.2, 0.17, 0.07, -(m.waistX + 0.05), m.beltY - 0.06, (m.waistFront + m.waistBack) / 2), 'hips', SLOT.accent), part(merge([strap, back]), 'chest', SLOT.fixed, 0x2a221c)];
    }
    case 'chain':
      return [part(new THREE.TorusGeometry(m.neckR + 0.02, 0.006, 5, 22).rotateX(Math.PI / 2 - 0.35).translate(0, REST.neck[1] - 0.02, 0.012), 'chest', SLOT.fixed, 0xd4af37)];
    case 'watch': {
      const r = REST.handL;
      return [part(new THREE.CylinderGeometry(0.036, 0.036, 0.028, 12, 1, true).rotateZ(Math.PI / 2).translate(r[0] - 0.02, r[1], r[2]), 'handL', SLOT.fixed, 0x1a1a1a)];
    }
    case 'headset':
      return [];
  }
}

export const ACCESSORY_BONES = BONE;
