// Low-poly, rounded people built once and shared by the crowd's instanced batches.
// Pivots and envelopes follow sim/pose: silhouette changes must never move an IK joint.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SKELETON } from '../sim/pose';

export type CharacterPartName = 'torso' | 'hips' | 'head' | 'face' | 'hair' | 'hairSweep' | 'hat' | 'neck' | 'upperArm' | 'forearm' | 'hand' | 'thigh' | 'shin' | 'shoe' | 'shirtInset' | 'jacketTrim' | 'badge' | 'glasses';

/** Height, half width, half depth, depth offset, and linear colour multiplier. */
type Ring = readonly [number, number, number, number?, number?];

const TORSO: readonly Ring[] = [
  [-.035, .175, .112, 0, .63], [.005, .18, .12, 0, .75], [.045, .178, .122],
  [.14, .168, .119], [.29, .184, .13, .003], [.43, .213, .139, .002],
  [.53, .238, .13], [.58, .247, .114], [.615, .225, .096], [.64, .077, .065, 0, .65],
];

/** A capped elliptical/superelliptical profile, with smooth normals round each ring. */
function profile(rings: readonly Ring[], segments = 12, roundness = 1, openBottom = false): THREE.BufferGeometry {
  const p: number[] = [];
  const uv: number[] = [];
  const color: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j < rings.length; j++) {
    const [y, width, depth, z = 0, shade = 1] = rings[j]!;
    for (let i = 0; i <= segments; i++) {
      const a = i / segments * Math.PI * 2;
      const sx = Math.sin(a);
      const cz = Math.cos(a);
      p.push(Math.sign(sx) * Math.abs(sx) ** roundness * width, y, Math.sign(cz) * Math.abs(cz) ** roundness * depth + z);
      uv.push(i / segments, j / (rings.length - 1));
      color.push(shade, shade, shade);
      if (j && i) {
        const a0 = j * (segments + 1) + i;
        indices.push(a0 - 1, a0 - segments - 2, a0, a0, a0 - segments - 2, a0 - segments - 1);
      }
    }
  }
  for (const end of [0, rings.length - 1]) {
    if (!end && openBottom) continue;
    const [y, , , z = 0, shade = 1] = rings[end]!;
    const centre = p.length / 3;
    p.push(0, y, z); uv.push(.5, end ? 1 : 0); color.push(shade, shade, shade);
    for (let i = 0; i < segments; i++) {
      const a = end * (segments + 1) + i;
      if (end) indices.push(centre, a, a + 1);
      else indices.push(centre, a + 1, a);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  // The seam is duplicated for UVs; share its normal so it cannot appear as a vertical crease.
  const normals = g.getAttribute('normal');
  const n = new THREE.Vector3();
  for (let j = 0; j < rings.length; j++) {
    const a = j * (segments + 1);
    const b = a + segments;
    n.set(normals.getX(a) + normals.getX(b), normals.getY(a) + normals.getY(b), normals.getZ(a) + normals.getZ(b)).normalize();
    normals.setXYZ(a, n.x, n.y, n.z); normals.setXYZ(b, n.x, n.y, n.z);
  }
  return g;
}

/** Baked colour multiplies the instance tint, allowing seams and soles without more material draws. */
function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const a = new Float32Array(g.getAttribute('position').count * 3);
  for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

function ellipsoid(w: number, h: number, d: number, x: number, y: number, z: number, hex = 0xffffff): THREE.BufferGeometry {
  return paint(new THREE.SphereGeometry(1, 8, 5).scale(w, h, d).translate(x, y, z), hex);
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, hex = 0xffffff): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex);
}

function merge(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(gs, false);
  if (!g) throw new Error('Character geometry attributes must match');
  for (const part of gs) part.dispose();
  return g;
}

/** Thin cloth panel following the chest surface, rather than floating in front of its curved silhouette. */
function panel(points: readonly (readonly [number, number])[], lift: number, hex: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const flat = new THREE.ShapeGeometry(shape).toNonIndexed();
  const src = flat.getAttribute('position');
  const positions: number[] = [];
  // A few triangles spanning the whole collar would cut through the convex chest between vertices.
  // Subdivide before wrapping so the entire cloth surface follows the body.
  function subdivide(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, depth: number): void {
    if (!depth) { positions.push(ax, ay, 0, bx, by, 0, cx, cy, 0); return; }
    const abx = (ax + bx) / 2; const aby = (ay + by) / 2;
    const bcx = (bx + cx) / 2; const bcy = (by + cy) / 2;
    const cax = (cx + ax) / 2; const cay = (cy + ay) / 2;
    subdivide(ax, ay, abx, aby, cax, cay, depth - 1);
    subdivide(abx, aby, bx, by, bcx, bcy, depth - 1);
    subdivide(cax, cay, bcx, bcy, cx, cy, depth - 1);
    subdivide(abx, aby, bcx, bcy, cax, cay, depth - 1);
  }
  for (let i = 0; i < src.count; i += 3) subdivide(src.getX(i), src.getY(i), src.getX(i + 1), src.getY(i + 1), src.getX(i + 2), src.getY(i + 2), 2);
  flat.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(positions.flatMap((_, i) => i % 3 === 0 ? [positions[i]!, positions[i + 1]!] : []), 2));
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    let j = 1;
    while (j < TORSO.length - 1 && TORSO[j]![0] < y) j++;
    const a = TORSO[j - 1]!;
    const b = TORSO[j]!;
    const t = THREE.MathUtils.clamp((y - a[0]) / (b[0] - a[0]), 0, 1);
    const w = THREE.MathUtils.lerp(a[1], b[1], t);
    const d = THREE.MathUtils.lerp(a[2], b[2], t);
    const z = THREE.MathUtils.lerp(a[3] ?? 0, b[3] ?? 0, t);
    const side = Math.min(1, Math.abs(p.getX(i)) / w) ** (1 / .78);
    p.setZ(i, z + d * Math.sqrt(1 - side * side) ** .78 + lift);
  }
  g.computeVertexNormals();
  // Other components are indexed when merged; this panel can share sequential indices without welds.
  g.setIndex(Array.from({ length: p.count }, (_, i) => i));
  return paint(g, hex);
}

export function characterGeometries(): Record<CharacterPartName, THREE.BufferGeometry> {
  const K = SKELETON;
  const torso = profile(TORSO, 12, .78);
  const hips = profile([[-.07, .105, .08], [-.025, .175, .112], [.045, .18, .116], [.065, .175, .113, 0, .48]], 12, .8);
  const skull: readonly Ring[] = [
    [.025, .057, .062, .012, .88], [.045, .078, .088, .008], [.085, .099, .104, .003],
    [.145, .112, .112], [.205, .11, .112, -.004], [.255, .103, .102, -.008],
    [.285, .075, .077, -.01], [.297, .025, .032, -.01],
  ];
  const head = merge([
    profile(skull, 12, .82),
    // Ears, a shaped nose and lower lip give the face a readable profile at three-quarter angles.
    ellipsoid(.018, .034, .023, -.111, .153, -.002, 0xe9e1d8),
    ellipsoid(.018, .034, .023, .111, .153, -.002, 0xe9e1d8),
    profile([[.112, .017, .014, .108, .88], [.132, .023, .025, .119], [.158, .013, .023, .117], [.193, .009, .005, .106]], 8),
    ellipsoid(.031, .006, .008, 0, .083, .105, 0xc7aaa0),
  ]);
  const face = merge([
    // Small, recessed eyes with lids; whites are intentionally subtle rather than toy-like disks.
    ellipsoid(.022, .009, .006, -.046, .177, .105, 0xd4cabb),
    ellipsoid(.022, .009, .006, .046, .177, .105, 0xd4cabb),
    ellipsoid(.008, .008, .004, -.046, .177, .111, 0x201e1b),
    ellipsoid(.008, .008, .004, .046, .177, .111, 0x201e1b),
    box(.04, .008, .009, -.046, .199, .108, 0x382c26),
    box(.04, .008, .009, .046, .199, .108, 0x382c26),
    box(.036, .003, .006, 0, .09, .112, 0x6a4032),
  ]);
  // Hair follows the skull, with a lower back edge and an open face; no rectangular helmet.
  const hair = profile([[.2, .11, .11], [.23, .11, .11], [.26, .1, .1], [.29, .07, .07], [.31, .04, .04], [.319, .008, .01, -.01]], 12, .82, true);
  const hp = hair.getAttribute('position');
  for (let row = 0; row < 6; row++) for (let i = 0; i <= 12; i++) {
    const angle = i / 12 * Math.PI * 2;
    const front = Math.cos(angle);
    const side = Math.sin(angle);
    const hairline = .205 + front * .047;
    const y = THREE.MathUtils.lerp(hairline, .319, row / 5);
    // Sample the skull at each point's actual height. Merely lowering a cap's back ring leaves
    // skin poking through the back of the head when the player is seen from the chase camera.
    let j = 1;
    while (j < skull.length - 1 && skull[j]![0] < y) j++;
    const a = skull[j - 1]!; const b = skull[j]!;
    const t = THREE.MathUtils.clamp((y - a[0]) / (b[0] - a[0]), 0, 1);
    const crown = y > .285 ? THREE.MathUtils.clamp((.324 - y) / .039, 0, 1) : 1;
    const width = y > .285 ? .081 * crown : THREE.MathUtils.lerp(a[1], b[1], t) + .007;
    const depth = y > .285 ? .084 * crown : THREE.MathUtils.lerp(a[2], b[2], t) + .008;
    const z = THREE.MathUtils.lerp(a[3] ?? 0, b[3] ?? 0, t);
    hp.setXYZ(row * 13 + i, Math.sign(side) * Math.abs(side) ** .82 * width, y, Math.sign(front) * Math.abs(front) ** .82 * depth + z);
  }
  hair.computeVertexNormals();
  const hairSweep = merge([
    profile([[.242, .106, .105, -.005], [.282, .107, .106, -.005], [.32, .081, .085], [.335, .035, .044]], 12),
    ellipsoid(.028, .072, .055, -.091, .21, -.033),
  ]);
  const hat = merge([
    profile([[.267, .123, .128, 0, .62], [.285, .124, .129], [.323, .116, .122], [.35, .083, .091], [.36, .032, .036]], 12),
    // A thin curved bill remains below the roof-clearance envelope used by seated riders.
    ellipsoid(.12, .012, .102, 0, .274, .129, 0xd0d0d0),
    box(.055, .028, .006, 0, .316, .123, 0xc9c9c9),
  ]);
  const neck = profile([[.592, .056, .055], [.653, .052, .051], [.687, .047, .047]], 10);
  const upperArm = profile([
    [-K.upperArm - .025, .054, .057, 0, .66], [-K.upperArm + .01, .057, .062],
    [-.19, .065, .071], [-.075, .077, .079], [.005, .071, .073], [.035, .041, .047],
  ], 10);
  const forearm = profile([
    [-K.forearm - .01, .044, .047, 0, .53], [-K.forearm + .025, .046, .05, 0, .61],
    [-.16, .059, .063], [-.06, .063, .067], [.015, .052, .056],
  ], 10);
  const hand = merge([
    profile([[-.09, .023, .025], [-.06, .037, .032], [-.01, .043, .035], [.03, .038, .033], [.05, .029, .027]], 8, .72),
    ellipsoid(.018, .032, .021, .034, .011, .002, 0xf2e7dd),
  ]);
  const thigh = profile([
    [-K.thigh - .025, .068, .073, .005, .79], [-.36, .077, .081, .003],
    [-.22, .083, .089, .003], [-.07, .085, .09, .005], [.018, .082, .088, .005], [.035, .065, .071, .005],
  ], 10, .85);
  const shin = profile([
    [-K.shin - .025, .059, .063, 0, .56], [-K.shin + .01, .061, .065, 0, .8],
    [-.25, .064, .071, -.005], [-.12, .073, .079, -.007], [.015, .066, .071], [.035, .054, .06],
  ], 10, .82);
  const shoe = merge([
    // Flat sole obeys exactly the gait's heel/toe envelope; the uppers taper away from it.
    paint(profile([[-K.ankleY, .075, (K.heel + K.toe) / 2, (K.toe - K.heel) / 2], [-.055, .075, .13, .06], [-.047, .071, .126, .06]], 12, .6), 0xc3c8c7),
    paint(profile([[-.047, .068, .122, .058], [-.013, .066, .116, .056], [.011, .06, .102, .04], [.024, .049, .07, .005]], 12, .75), 0x272d34),
    box(.065, .005, .009, 0, .014, .072, 0xa4b2b8),
    box(.06, .005, .009, 0, .02, .052, 0xa4b2b8),
    box(.053, .005, .009, 0, .026, .032, 0xa4b2b8),
  ]);
  const shirtInset = panel([[-.067, .622], [-.073, .565], [-.049, .492], [0, .47], [.049, .492], [.073, .565], [.067, .622]], .007, 0xffffff);
  const jacketTrim = merge([
    panel([[-.066, .619], [-.135, .578], [-.07, .48], [-.026, .53]], .013, 0xaab4bd),
    panel([[.066, .619], [.135, .578], [.07, .48], [.026, .53]], .013, 0xaab4bd),
    panel([[-.0045, .07], [.0045, .07], [.0045, .14], [.0045, .29], [.0045, .45], [-.0045, .45], [-.0045, .29], [-.0045, .14]], .006, 0xb0b7ba),
    box(.045, .008, .007, -.119, .263, .135, 0xc4c8c8),
    box(.045, .008, .007, .119, .263, .135, 0xc4c8c8),
    // Rear yoke seam and waist ribbing make the player's back readable during play.
    box(.31, .009, .007, 0, .448, -.132, 0x7e8792),
    box(.27, .012, .007, 0, .055, -.121, 0xa1a7ad),
  ]);
  const badge = merge([
    ellipsoid(.026, .033, .007, .108, .459, .143, 0xd5b564),
    box(.061, .014, .009, -.107, .459, .143, 0xb2bfca),
    box(.044, .084, .017, -.107, .378, .141, 0x1e2933),
    paint(profile([[.052, .18, .123], [.087, .177, .123]], 12, .78), 0x242830),
    box(.04, .029, .013, 0, .07, .132, 0xadb3ad),
  ]);
  const glasses = merge([
    ellipsoid(.043, .024, .009, -.052, .179, .118, 0x182830),
    ellipsoid(.043, .024, .009, .052, .179, .118, 0x182830),
    box(.033, .007, .008, 0, .187, .124, 0x73766d),
    box(.007, .009, .1, -.102, .188, .065, 0x24282c),
    box(.007, .009, .1, .102, .188, .065, 0x24282c),
  ]);
  return { torso, hips, head, face, hair, hairSweep, hat, neck, upperArm, forearm, hand, thigh, shin, shoe, shirtInset, jacketTrim, badge, glasses };
}
