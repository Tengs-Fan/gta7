// Las Lomas County's telephone poles and their wires (world/country/oddities.ts): a creosoted pole with a crossarm braced
// to it, four glass insulators on the arm and a cap on top, and between each pair of neighbouring poles four wires hung as
// catenaries. The poles are solid (their colliders are the oddities' solids), the wires only drawn. Two layers, one of poles
// (casting shadows) and one of wires, each cut into the county's cells and hidden with the rest of it past the fog.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { insulator, POLE, sagAt } from '../../world/country/oddities';
import { bar, box, cyl, ModelBuilder } from '../furniture';
import type { CountryView } from './index';

/** A wire's thickness (m): thicker than the real one, so that it holds together a hundred metres off. */
const WIRE_R = 0.022;
/** A wire is drawn as a chain of straight pieces this long (m) at most. */
const WIRE_STEP = 5;
const WIRE_COLOR = new THREE.Color(0x1a1c1e);

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A pole standing at the origin, its line along +z and its crossarm along x. */
export function poleGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const wood = 0x6a5238;
  const arm = 0x4f3b26;
  const glass = 0x9bd0c4;
  b.add('pole', new THREE.CylinderGeometry(POLE.top, POLE.base, POLE.h, 9, 1).translate(0, POLE.h / 2, 0), wood);
  b.add('cap', cyl(0, POLE.top * 1.15, 0.18, 9, 0, POLE.h, 0), arm);
  b.add('crossarm', box(POLE.arm, 0.11, 0.09, 0, POLE.armY, 0), arm);
  for (const s of [-1, 1]) b.add('brace', bar(v3(0, POLE.armY - 0.62, 0.02), v3(s * 0.62, POLE.armY - 0.04, 0.02), 0.028, 4), arm, 0.9);
  b.add('bolt', cyl(0.035, 0.035, 0.2, 6, 0, POLE.armY - 0.1, 0), 0x5b5f63);
  for (const across of POLE.wires) {
    b.add('pin', cyl(0.02, 0.025, 0.1, 5, across, POLE.armY + 0.05, 0), wood, 0.8);
    b.add('insulator', cyl(0.05, 0.075, 0.12, 7, across, POLE.wireY - 0.17, 0), glass);
    b.add('insulator', cyl(0.025, 0.05, 0.05, 7, across, POLE.wireY - 0.05, 0), glass, 0.9);
  }
  // The utility's tag, a steel plate chest high, on the roadward face.
  b.add('tag', box(0.12, 0.2, 0.02, 0, 3.1, POLE.base * 0.9), 0xb8bcbf);
  return b.build('telephone-pole');
}

/** The corners of a wire's square section, in its (u, w) frame, round the ring. */
const RING: ReadonlyArray<readonly [number, number]> = [[1, 1], [-1, 1], [-1, -1], [1, -1]];

/** The wires between the poles: every span's four, as square-section chains hung on the catenary of its length. */
export function wireGeometry(spans: ReadonlyArray<{ a: THREE.Vector3[]; b: THREE.Vector3[] }>): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const dir = new THREE.Vector3();
  const u = new THREE.Vector3();
  const w = new THREE.Vector3();
  const n = new THREE.Vector3();
  const corner = (p: THREE.Vector3, [cu, cw]: readonly [number, number]) => {
    pos.push(p.x + (u.x * cu + w.x * cw) * WIRE_R, p.y + (u.y * cu + w.y * cw) * WIRE_R, p.z + (u.z * cu + w.z * cw) * WIRE_R);
    nrm.push(n.x, n.y, n.z);
    col.push(WIRE_COLOR.r, WIRE_COLOR.g, WIRE_COLOR.b);
  };
  for (const s of spans) {
    for (let k = 0; k < s.a.length; k++) {
      const a = s.a[k]!;
      const b = s.b[k]!;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(2, Math.ceil(len / WIRE_STEP));
      const at = (i: number) => v3(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps - sagAt(len, i / steps), a.z + ((b.z - a.z) * i) / steps);
      let p = at(0);
      for (let i = 1; i <= steps; i++) {
        const q = at(i);
        dir.subVectors(q, p).normalize();
        u.crossVectors(dir, v3(0, 1, 0)).normalize();
        w.crossVectors(dir, u).normalize();
        // Four faces, each two triangles from one ring of the chain to the next, lit by the normal half way between its corners.
        for (let c = 0; c < 4; c++) {
          const c0 = RING[c]!;
          const c1 = RING[(c + 1) % 4]!;
          n.set(0, 0, 0).addScaledVector(u, c0[0] + c1[0]).addScaledVector(w, c0[1] + c1[1]).normalize();
          for (const [at0, at1] of [[p, c0], [q, c0], [q, c1], [p, c0], [q, c1], [p, c1]] as const) corner(at0, at1);
        }
        p = q;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.name = 'telephone-wires';
  return g;
}

/** The county's poles, and the wires between them. */
export function buildPoles(view: CountryView): void {
  const { poles, spans } = view.world.layout.country.oddities;
  const model = poleGeometry();
  const m = new THREE.Matrix4();
  const parts = poles.map((p) => model.clone().applyMatrix4(m.makeRotationY(p.rot).setPosition(p.x, p.y, p.z)));
  const geo = mergeGeometries(parts, false)!;
  for (const g of [model, ...parts]) g.dispose();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  mat.name = 'telephone-poles';
  view.add(geo, mat, { shadow: true, name: 'telephone-poles' });

  const ends = spans.map((s) => ({
    a: POLE.wires.map((_, k) => v3(...insulator(poles[s.a]!, k))),
    b: POLE.wires.map((_, k) => v3(...insulator(poles[s.b]!, k))),
  }));
  // Double-sided: a chain this thin is seen from every side, and its facets need no winding to be right.
  const wires = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
  wires.name = 'telephone-wires';
  view.add(wireGeometry(ends), wires, { shadow: false, name: 'telephone-wires' });
}
