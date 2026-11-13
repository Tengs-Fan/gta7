// Low-poly, rounded people built once and shared by the crowd's instanced batches.
// Pivots and envelopes follow sim/pose: silhouette changes must never move an IK joint.
//
// Every limb ends in a dome centred on its joint, the same size as the dome of the limb it meets there: bent or
// straight, an elbow or a knee is one rounded surface, with no gap and no band to mark it. (The limbs were tubes with
// a darkened ring at each end, which read as a doll's joints from any distance, on shoulders 71 cm across.)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SKELETON } from '../sim/pose';

export type CharacterPartName =
  | 'torso' | 'hips' | 'head' | 'face' | 'hair' | 'hairSweep' | 'hat' | 'neck' | 'upperArm' | 'forearm' | 'hand' | 'thigh' | 'shin' | 'shoe'
  | 'shirtInset' | 'jacketTrim' | 'badge' | 'glasses' | 'sleeve' | 'shortLeg'
  | 'hairLong' | 'hairTail' | 'hairFull';

/** A woman's shoulders, arms and legs against a man's (CrowdView): the drawn spread of the shoulders and the limbs' girth. */
export const WOMAN = { shoulders: 0.9, arm: 0.88, leg: 0.94 } as const;

/**
 * Where the arms are drawn from, in the torso's own frame (CrowdView.shoulders): nearer the spine and lower than the
 * joints sim/pose aims guns from (SKELETON.shoulderX, shoulderY), which stand 57 cm apart at the height of the collar.
 * Hands still go where the simulation puts them: an arm drawn from here reaches the same grip, wheel or phone.
 */
export const DRAWN_SHOULDER = { x: 0.185, pad: 0.045, drop: 0.035 } as const;
/** How much slimmer than its sleeve or trouser leg a bare arm or leg is drawn (CrowdView.bone's girth). */
export const BARE_ARM = 0.86;
export const BARE_LEG = 0.84;

/** Height, half width, half depth, depth offset, and linear colour multiplier. */
type Ring = readonly [number, number, number, number?, number?];

/** The torso's cross-section: a superellipse, a little squarer than round. */
const TORSO_ROUND = 0.84;
// Waist to collar: it ends inside the trousers' waistband (the hips, below). The shoulders slope from the collar down
// to the arms (drawn 3.5 cm under the simulation's joints), and the chest is deeper than the waist: seen from behind,
// where a player sees his own most, it tapers.
const TORSO: readonly Ring[] = [
  [.02, .157, .109, 0, .8], [.06, .16, .113, 0, .9], [.1, .158, .113],
  [.17, .156, .112], [.28, .166, .121, .004], [.40, .184, .131, .006],
  [.48, .2, .130, .004], [.535, .214, .122, .001], [.575, .214, .109, -.003],
  [.606, .184, .093, -.006], [.630, .108, .076, -.006], [.648, .064, .062, -.004, .66],
];

// A woman's: narrower across the shoulders and at the waist, fuller at the chest and the hip.
const TORSO_F: readonly Ring[] = [
  [.02, .152, .106, 0, .8], [.06, .154, .109, 0, .9], [.1, .148, .107],
  [.17, .136, .102], [.28, .146, .112, .006], [.385, .164, .128, .016],
  [.46, .174, .123, .008], [.525, .19, .113, .001], [.568, .19, .101, -.003],
  [.602, .162, .088, -.006], [.630, .096, .07, -.006], [.648, .058, .058, -.004, .66],
];

/** Where the torso's surface is at height y, x across it: its front (or its back) z. */
function torsoZ(x: number, y: number, back = false): number {
  let j = 1;
  while (j < TORSO.length - 1 && TORSO[j]![0] < y) j++;
  const a = TORSO[j - 1]!;
  const b = TORSO[j]!;
  const t = THREE.MathUtils.clamp((y - a[0]) / (b[0] - a[0]), 0, 1);
  const w = THREE.MathUtils.lerp(a[1], b[1], t);
  const d = THREE.MathUtils.lerp(a[2], b[2], t);
  const z = THREE.MathUtils.lerp(a[3] ?? 0, b[3] ?? 0, t);
  const side = Math.min(1, Math.abs(x) / w) ** (1 / TORSO_ROUND);
  return z + (back ? -1 : 1) * d * Math.sqrt(1 - side * side) ** TORSO_ROUND;
}

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

/**
 * A limb: rings in ascending y, its ends rounded off by a dome `bottom` and `top` high (0: capped flat). A dome as
 * high as the end ring is wide is a ball on that ring's centre, which is how two limbs share a joint.
 */
function limb(rings: readonly Ring[], segments: number, roundness: number, bottom: number, top: number): THREE.BufferGeometry {
  const dome = (r: Ring, h: number, sign: number): Ring[] =>
    [0.55, 0.9].map((t) => {
      const k = Math.sqrt(1 - t * t);
      return [r[0] + sign * h * t, r[1] * k, r[2] * k, r[3] ?? 0, r[4] ?? 1] as const;
    });
  const out: Ring[] = [];
  if (bottom > 0) out.push(...dome(rings[0]!, bottom, -1).reverse());
  out.push(...rings);
  if (top > 0) out.push(...dome(rings[rings.length - 1]!, top, 1));
  return profile(out, segments, roundness);
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
  for (let i = 0; i < p.count; i++) p.setZ(i, torsoZ(p.getX(i), p.getY(i)) + lift);
  g.computeVertexNormals();
  // Other components are indexed when merged; this panel can share sequential indices without welds.
  g.setIndex(Array.from({ length: p.count }, (_, i) => i));
  return paint(g, hex);
}

export function characterGeometries(): Record<CharacterPartName, THREE.BufferGeometry> {
  const K = SKELETON;
  // The torso and the hips each carry a second shape, a woman's, ring for ring: CrowdView blends to it per person
  // (the `positionB` and `normalB` attributes), so men and women share one batch of each.
  const second = (g: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry => {
    if (b.getAttribute('position').count !== g.getAttribute('position').count) throw new Error('The two shapes of a part must match vertex for vertex');
    g.setAttribute('positionB', b.getAttribute('position').clone());
    g.setAttribute('normalB', b.getAttribute('normal').clone());
    b.dispose();
    return g;
  };
  const torso = second(profile(TORSO, 14, TORSO_ROUND), profile(TORSO_F, 14, .88));
  // The seat and the waistband, which is outside what is worn above it and a shade darker along its top, as a belt is.
  const hips = second(
    profile([[-.078, .1, .084, 0, .92], [-.05, .172, .11, -.004], [-.01, .187, .119, -.004], [.04, .18, .12], [.072, .172, .121], [.076, .173, .122, 0, .52], [.094, .169, .12, 0, .52]], 12, .84),
    profile([[-.078, .1, .084, 0, .92], [-.05, .178, .112, -.005], [-.01, .193, .122, -.007], [.04, .184, .12, -.003], [.072, .168, .117], [.076, .169, .118, 0, .52], [.094, .162, .114, 0, .52]], 12, .88),
  );
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
  // Worn over the cap of hair every bare head has: what falls from it behind the ears to the shoulders, one mass
  // turning with the head; a tail tied back from the crown down the nape; or a full head of it, standing off the skull
  // all round (and under the roof a rider's head is fitted to).
  const hairLong = profile([[-.075, .094, .058, -.056, .78], [-.02, .11, .07, -.05, .9], [.06, .12, .082, -.04], [.15, .121, .09, -.03], [.225, .112, .096, -.018]], 12, .9);
  const hairTail = merge([
    paint(new THREE.SphereGeometry(1, 8, 5).scale(.03, .105, .036).rotateX(-.3).translate(0, .14, -.128), 0xffffff),
    ellipsoid(.034, .03, .034, 0, .245, -.112),
  ]);
  const hairFull = profile([[.168, .121, .116, -.012, .82], [.205, .129, .126, -.008], [.25, .127, .124, -.006], [.295, .108, .106, -.006], [.325, .07, .07, -.006], [.337, .02, .022, -.006]], 12, .95, true);
  {
    // Open over the face: the front of its lower rings lifts to the hairline, as the cap's does.
    const q = hairFull.getAttribute('position');
    for (let i = 0; i < q.count; i++) {
      const front = q.getZ(i) / .126;
      if (front > .25 && q.getY(i) < .245) q.setY(i, THREE.MathUtils.lerp(q.getY(i), .245, THREE.MathUtils.smoothstep(front, .25, .7)));
    }
    hairFull.computeVertexNormals();
  }
  const hat = merge([
    profile([[.267, .123, .128, 0, .62], [.285, .124, .129], [.323, .116, .122], [.35, .083, .091], [.36, .032, .036]], 12),
    // A thin curved bill remains below the roof-clearance envelope used by seated riders.
    ellipsoid(.12, .012, .102, 0, .274, .129, 0xd0d0d0),
    box(.055, .028, .006, 0, .316, .123, 0xc9c9c9),
  ]);
  const neck = profile([[.585, .06, .058, 0, .8], [.64, .051, .052], [.69, .047, .048]], 10);
  // Arms: the shoulder's ball and the elbow's on the upper arm, the elbow's and the wrist's on the forearm; a little
  // fuller in front above the elbow and behind below it. Drawn as a sleeve; bare, CrowdView draws them slimmer.
  const ELBOW = .043;
  const upperArm = limb([
    [-K.upperArm, ELBOW, ELBOW + .002], [-.235, .046, .05, .002], [-.14, .052, .057, .004],
    [-.06, .055, .06, .003], [0, .052, .056],
  ], 8, 1, ELBOW, .03);
  const forearm = limb([
    [-K.forearm, .029, .031], [-.2, .033, .035, -.001], [-.12, .04, .043, -.003],
    [-.05, .044, .047, -.003], [0, ELBOW, ELBOW + .002],
  ], 8, 1, .029, ELBOW);
  // A sleeve to above the elbow, worn over a bare arm: its hem a shade darker.
  const sleeve = limb([
    [-.135, .06, .064, .003, .7], [-.118, .061, .066, .003], [-.06, .06, .065, .003], [0, .056, .06],
  ], 8, 1, 0, .033);
  // The hand hangs with its palm to the thigh: thin across the body, broad fore and aft, the thumb in front.
  const hand = merge([
    limb([[-.088, .013, .026, .002], [-.058, .017, .037, .002], [-.02, .02, .041, .001], [.02, .022, .036], [.05, .027, .03]], 6, .8, .012, 0),
    paint(new THREE.SphereGeometry(1, 5, 3).scale(.013, .034, .015).rotateX(.5).translate(0, -.012, .044), 0xf2e7dd),
  ]);
  // Legs, as trouser legs: the hip's ball and the knee's on the thigh, the knee's on the shin, the calf behind it.
  const KNEE = .064;
  // (Narrower across than it is deep where it leaves the seat, so two of them side by side are no wider than the hips.)
  const thigh = limb([
    [-K.thigh, KNEE, KNEE + .003, .002], [-.36, .07, .075, .004], [-.24, .08, .089, .006],
    [-.1, .082, .098, .006], [0, .078, .096, .004],
  ], 10, .9, KNEE, .06);
  const shin = limb([
    [-K.shin - .02, .053, .056, 0, .6], [-K.shin + .012, .054, .058, 0, .82], [-.3, .056, .06, -.003],
    [-.19, .061, .067, -.008], [-.09, .064, .07, -.006], [0, KNEE, KNEE + .003, .002],
  ], 10, .9, 0, KNEE);
  // Shorts' leg, to above the knee, over a bare thigh.
  const shortLeg = limb([
    [-.285, .095, .105, .006, .7], [-.262, .096, .106, .006], [-.1, .092, .106, .006], [0, .086, .102, .004],
  ], 10, .9, 0, .06);
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
    panel([[-.0045, .1], [.0045, .1], [.0045, .16], [.0045, .29], [.0045, .45], [-.0045, .45], [-.0045, .29], [-.0045, .16]], .006, 0xb0b7ba),
    box(.045, .008, .007, -.105, .263, torsoZ(.105, .263) + .003, 0xc4c8c8),
    box(.045, .008, .007, .105, .263, torsoZ(.105, .263) + .003, 0xc4c8c8),
    // Rear yoke seam and waist ribbing make the player's back readable during play.
    box(.27, .009, .007, 0, .46, torsoZ(0, .46, true), 0x7e8792),
    box(.25, .012, .007, 0, .112, torsoZ(0, .112, true), 0xa1a7ad),
  ]);
  const badge = merge([
    ellipsoid(.026, .033, .007, .1, .455, torsoZ(.1, .455) + .003, 0xd5b564),
    box(.061, .014, .009, -.1, .455, torsoZ(.1, .455) + .003, 0xb2bfca),
    box(.044, .084, .017, -.1, .37, torsoZ(.1, .37) + .006, 0x1e2933),
    paint(profile([[.066, .172, .124], [.098, .171, .123]], 14, .84), 0x242830),
    box(.04, .029, .013, 0, .082, .13, 0xadb3ad),
  ]);
  const glasses = merge([
    ellipsoid(.043, .024, .009, -.052, .179, .118, 0x182830),
    ellipsoid(.043, .024, .009, .052, .179, .118, 0x182830),
    box(.033, .007, .008, 0, .187, .124, 0x73766d),
    box(.007, .009, .1, -.102, .188, .065, 0x24282c),
    box(.007, .009, .1, .102, .188, .065, 0x24282c),
  ]);
  return { torso, hips, head, face, hair, hairSweep, hat, neck, upperArm, forearm, hand, thigh, shin, shoe, shirtInset, jacketTrim, badge, glasses, sleeve, shortLeg, hairLong, hairTail, hairFull };
}
