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
  | 'badge' | 'glasses' | 'sleeve' | 'shortLeg' | 'collar' | 'hem' | 'shoulder'
  | 'hairLong' | 'hairTail' | 'hairFull';

/** A woman's shoulders, arms and legs against a man's (CrowdView): the drawn spread of the shoulders and the limbs' girth. */
export const WOMAN = { shoulders: 0.9, arm: 0.88, leg: 0.94, badge: { x: 0.975, z: 0.95 } } as const;

/**
 * Where the arms are drawn from, in the torso's own frame (CrowdView.shoulders): nearer the spine and lower than the
 * joints sim/pose aims guns from (SKELETON.shoulderX, shoulderY), which stand 57 cm apart at the height of the collar.
 * Hands still go where the simulation puts them: an arm drawn from here reaches the same grip, wheel or phone.
 */
export const DRAWN_SHOULDER = { x: 0.185, pad: 0.045, drop: 0.035 } as const;
/** How much slimmer than its sleeve or trouser leg a bare arm or leg is drawn (CrowdView.bone's girth). */
export const BARE_ARM = 0.86;
export const BARE_LEG = 0.84;

/** Height, half width, half depth (in front), depth offset, linear colour multiplier, and half depth behind (else the same). */
type Ring = readonly [number, number, number, number?, number?, number?];

/** How far the neckline drops at the front of the throat (m). */
const NECKLINE = .024;

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

/** Where the torso's surface (a man's, or the rings given) is at height y, x across it: its front (or its back) z. */
function torsoZ(x: number, y: number, back = false, rings: readonly Ring[] = TORSO): number {
  let j = 1;
  while (j < rings.length - 1 && rings[j]![0] < y) j++;
  const a = rings[j - 1]!;
  const b = rings[j]!;
  const t = THREE.MathUtils.clamp((y - a[0]) / (b[0] - a[0]), 0, 1);
  const w = THREE.MathUtils.lerp(a[1], b[1], t);
  const d = THREE.MathUtils.lerp(a[2], b[2], t);
  const z = THREE.MathUtils.lerp(a[3] ?? 0, b[3] ?? 0, t);
  const side = Math.min(1, Math.abs(x) / w) ** (1 / TORSO_ROUND);
  return z + (back ? -1 : 1) * d * Math.sqrt(1 - side * side) ** TORSO_ROUND;
}

/**
 * A capped elliptical/superelliptical profile, with smooth normals round each ring. A roundness under 1 squares the
 * ring by raising sine and cosine to it, which leaves a cusp where either is zero (a ridge down each side); one of 2 or
 * more is the exponent of a squircle, |x|^n + |z|^n = 1, which is as square and smooth all round.
 */
function profile(rings: readonly Ring[], segments = 12, roundness = 1, openBottom = false): THREE.BufferGeometry {
  const p: number[] = [];
  const uv: number[] = [];
  const color: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j < rings.length; j++) {
    const [y, width, depth, z = 0, shade = 1, back = depth] = rings[j]!;
    for (let i = 0; i <= segments; i++) {
      const a = i / segments * Math.PI * 2;
      let sx = Math.sin(a);
      let cz = Math.cos(a);
      if (roundness >= 2) {
        const k = (Math.abs(sx) ** roundness + Math.abs(cz) ** roundness) ** (-1 / roundness);
        sx *= k;
        cz *= k;
      } else {
        sx = Math.sign(sx) * Math.abs(sx) ** roundness;
        cz = Math.sign(cz) * Math.abs(cz) ** roundness;
      }
      p.push(sx * width, y, cz * (cz < 0 ? back : depth) + z);
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
      return [r[0] + sign * h * t, r[1] * k, r[2] * k, r[3] ?? 0, r[4] ?? 1, (r[5] ?? r[2]) * k] as const;
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

function ellipsoid(w: number, h: number, d: number, x: number, y: number, z: number, hex = 0xffffff, around = 8, down = 5): THREE.BufferGeometry {
  return paint(new THREE.SphereGeometry(1, around, down).scale(w, h, d).translate(x, y, z), hex);
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
  // The neckline dips in front, so the throat shows between the collar and the jaw: with the collar level at 64.8 cm
  // over the hips the chin, 2.5 cm above it, hid the neck from the front.
  {
    for (const name of ['position', 'positionB'] as const) {
      const q = torso.getAttribute(name);
      for (let i = 0; i < q.count; i++) {
        if (q.getY(i) > .6 && q.getZ(i) > 0) q.setY(i, q.getY(i) - NECKLINE * Math.min(1, q.getZ(i) / .06) * (q.getY(i) - .6) / .048);
      }
    }
    torso.computeVertexNormals();
    const b = new THREE.BufferGeometry();
    b.setAttribute('position', torso.getAttribute('positionB'));
    b.setIndex(torso.getIndex());
    b.computeVertexNormals();
    torso.setAttribute('normalB', b.getAttribute('normal'));
  }
  // The seat and the waistband. Below the hip joints the seat tucks in behind the trouser legs in front (its front is
  // 2 to 3 cm behind theirs), so only the crotch shows between them, and stands out behind them as a seat does: drawn
  // round and as wide as the thighs in front, it read from the street as briefs worn over the trousers. The belt is the
  // band from 6.8 to 9.4 cm, a few millimetres proud of the cloth (its colour is the shader's: CrowdView clothShader).
  const hips = second(
    profile([
      [-.1, .03, .1, 0, 1, .06], [-.075, .085, .106, 0, 1, .09], [-.045, .15, .11, 0, 1, .108],
      [-.01, .182, .112, 0, 1, .124], [.03, .181, .116, 0, 1, .122], [.064, .174, .12],
      [.068, .177, .125], [.094, .175, .124], [.098, .166, .117],
    ], 12, .84),
    profile([
      [-.1, .03, .1, 0, 1, .062], [-.075, .09, .106, 0, 1, .096], [-.045, .158, .11, 0, 1, .114],
      [-.01, .19, .11, 0, 1, .128], [.03, .184, .112, 0, 1, .122], [.064, .168, .114, 0, 1, .116],
      [.068, .171, .118], [.094, .165, .117], [.098, .157, .11],
    ], 12, .88),
  );
  // Under the hip joints the front of the trousers narrows to the fly between the legs, and the legs take over: a full
  // seat in front, as wide as both thighs, read from the street as a pair of briefs worn over the trousers (round 9).
  for (const name of ['position', 'positionB'] as const) {
    const q = hips.getAttribute(name);
    for (let i = 0; i < q.count; i++) {
      const k = 1 - THREE.MathUtils.smoothstep(q.getY(i), -.06, .03);
      const front = Math.max(0, q.getZ(i)) / .1;
      // Behind, the seat's lower curve runs into the backs of the legs a little lower down.
      const seat = 1 - THREE.MathUtils.smoothstep(q.getY(i), -.085, -.015);
      const back = Math.max(0, -q.getZ(i)) / .1;
      q.setX(i, q.getX(i) * (1 - .72 * k * Math.min(1, front) - .5 * seat * Math.min(1, back)));
    }
  }
  hips.computeVertexNormals();
  {
    const b = new THREE.BufferGeometry();
    b.setAttribute('position', hips.getAttribute('positionB'));
    b.setIndex(hips.getIndex());
    b.computeVertexNormals();
    hips.setAttribute('normalB', b.getAttribute('normal'));
  }
  // Under the hip joints the seat's surface turns down to the crotch while the trouser legs it meets face out: lit as
  // modelled, it is a dark U between bright thighs. Its normals there face out as the legs' do, so the cloth reads as one.
  for (const name of ['normal', 'normalB'] as const) {
    const n = hips.getAttribute(name);
    const y = hips.getAttribute('position');
    for (let i = 0; i < n.count; i++) {
      const k = THREE.MathUtils.smoothstep(y.getY(i), -.1, .03);
      const h = Math.hypot(n.getX(i), n.getZ(i));
      // The pole under the crotch faces straight down and has no side to turn to, so it keeps its normal: turned, it is
      // a normal of no length, the triangles round it shade as NaN, and High's bloom spreads one such pixel over a
      // rectangle of the frame (black from whichever side the crotch shows).
      if (h < 1e-6) continue;
      const ny = n.getY(i) * k;
      const out = Math.sqrt(Math.max(0, 1 - ny * ny)) / h;
      n.setXYZ(i, n.getX(i) * out, ny, n.getZ(i) * out);
    }
  }
  const skull: readonly Ring[] = [
    [.025, .057, .062, .012, .88], [.045, .078, .088, .008], [.085, .099, .104, .003],
    [.145, .112, .112], [.205, .11, .112, -.004], [.255, .103, .102, -.008],
    [.285, .075, .077, -.01], [.297, .025, .032, -.01],
  ];
  // The head inside the skull's envelope above (which the hair, caps and roof clearances are fitted to), ring by ring
  // no wider, deeper or higher: a cranium rounded as a squircle (the skull's squared rings left a box from behind and a
  // ridge down each side), the back of it fuller than the face, and the cheeks narrowing to a jaw and a chin forward
  // of the neck. Height, half width, half depth in front, offset, shade, half depth behind.
  const cranium: readonly Ring[] = [
    [.03, .03, .022, .05, .9, .02], [.045, .054, .05, .036, .95, .05], [.065, .072, .074, .022, 1, .07],
    [.09, .087, .092, .012, 1, .088], [.12, .099, .1, .004, 1, .1], [.15, .106, .108, 0, 1, .108],
    [.185, .108, .109, -.003, 1, .11], [.215, .106, .106, -.005, 1, .108], [.245, .099, .095, -.008, 1, .1],
    [.268, .084, .078, -.01, 1, .085], [.285, .06, .054, -.01, 1, .062], [.295, .028, .025, -.01, 1, .03],
  ];
  const head = merge([
    profile(cranium, 14, 2.3),
    // Ears standing a little off the side of the head, turned to face forward, their rims a shade lighter.
    paint(new THREE.SphereGeometry(1, 6, 4).scale(.011, .032, .021).rotateY(-.4).translate(-.11, .15, -.008), 0xeee4da),
    paint(new THREE.SphereGeometry(1, 6, 4).scale(.011, .032, .021).rotateY(.4).translate(.11, .15, -.008), 0xeee4da),
    // The nose: a wedge from the bridge between the eyes to its tip, its wings either side of the base.
    profile([[.118, .013, .01, .104, .86], [.124, .02, .016, .111], [.135, .015, .02, .119], [.15, .01, .016, .117], [.17, .008, .012, .11], [.19, .007, .006, .103]], 6),
    ellipsoid(.029, .006, .007, 0, .083, .101, 0xc7aaa0, 8, 4),
  ]);
  const face = merge([
    // Small, recessed eyes with lids; whites are intentionally subtle rather than toy-like disks.
    ellipsoid(.022, .009, .006, -.046, .177, .102, 0xd4cabb, 8, 4),
    ellipsoid(.022, .009, .006, .046, .177, .102, 0xd4cabb, 8, 4),
    ellipsoid(.008, .008, .004, -.046, .177, .108, 0x201e1b, 6, 3),
    ellipsoid(.008, .008, .004, .046, .177, .108, 0x201e1b, 6, 3),
    box(.04, .008, .009, -.046, .199, .102, 0x382c26),
    box(.04, .008, .009, .046, .199, .102, 0x382c26),
    box(.036, .003, .006, 0, .09, .106, 0x6a4032),
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
  ], 8, 1, ELBOW, .012);
  const forearm = limb([
    [-K.forearm, .029, .031], [-.2, .033, .035, -.001], [-.12, .04, .043, -.003],
    [-.05, .044, .047, -.003], [0, ELBOW, ELBOW + .002],
  ], 8, 1, .029, ELBOW);
  // A sleeve to above the elbow, worn over a bare arm: its hem a shade darker.
  const sleeve = limb([
    [-.135, .06, .064, .003, .7], [-.118, .061, .066, .003], [-.06, .06, .065, .003], [0, .056, .06],
  ], 8, 1, 0, .014);
  // The hand hangs with its palm to the thigh: thin across the body, broad fore and aft, the thumb in front.
  const hand = merge([
    limb([[-.088, .013, .026, .002], [-.058, .017, .037, .002], [-.02, .02, .041, .001], [.02, .022, .036], [.05, .027, .03]], 6, .8, .012, 0),
    paint(new THREE.SphereGeometry(1, 5, 3).scale(.013, .034, .015).rotateX(.5).translate(0, -.012, .044), 0xf2e7dd),
  ]);
  // Legs, as trouser legs: the hip's ball and the knee's on the thigh, the knee's on the shin, the calf behind it.
  const KNEE = .064;
  // (Narrower across than it is deep where it leaves the seat, so two of them side by side are no wider than the hips.)
  const thigh = limb([
    [-K.thigh, KNEE, KNEE + .003, .002], [-.36, .07, .075, .004], [-.24, .081, .09, .006],
    [-.1, .085, .104, .008, 1, .1], [0, .083, .108, .006, 1, .1],
  ], 10, .9, KNEE, .06);
  const shin = limb([
    [-K.shin - .02, .053, .056, 0, .6], [-K.shin + .012, .054, .058, 0, .82], [-.3, .056, .06, -.003],
    [-.19, .061, .067, -.008], [-.09, .064, .07, -.006], [0, KNEE, KNEE + .003, .002],
  ], 10, .9, 0, KNEE);
  // Shorts' leg, to above the knee, over a bare thigh.
  const shortLeg = limb([
    [-.285, .095, .105, .006, .7], [-.262, .096, .106, .006], [-.1, .092, .106, .006], [0, .086, .102, .004],
  ], 10, .9, 0, .06);
  // The sole in the second colour (CrowdView's sole), the upper in the first: `trimMask` says which.
  const sole = (g: THREE.BufferGeometry, k: number): THREE.BufferGeometry => {
    g.setAttribute('trimMask', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(k), 1));
    return g;
  };
  const shoe = merge([
    // Flat sole obeys exactly the gait's heel/toe envelope; the uppers taper away from it.
    sole(paint(profile([[-K.ankleY, .075, (K.heel + K.toe) / 2, (K.toe - K.heel) / 2], [-.055, .075, .13, .06], [-.047, .071, .126, .06]], 12, .6), 0xe4e4e2), 1),
    sole(profile([[-.047, .068, .122, .058, .9], [-.04, .068, .122, .058], [-.013, .066, .116, .056], [.011, .06, .102, .04], [.024, .049, .07, .005, .92]], 12, .75), 0),
    sole(box(.058, .005, .009, 0, .014, .072, 0x8a8f94), 0),
    sole(box(.054, .005, .009, 0, .02, .052, 0x8a8f94), 0),
    sole(box(.048, .005, .009, 0, .026, .032, 0x8a8f94), 0),
  ]);
  // An untucked top's hem, hanging over the waistband: on the torso's frame, a man's and a woman's shape.
  const hem = second(
    profile([[.035, .186, .131, 0, .7], [.045, .187, .132], [.1, .181, .128], [.15, .165, .12], [.205, .152, .108]], 12, TORSO_ROUND, true),
    profile([[.035, .182, .127, 0, .7], [.045, .183, .128], [.1, .17, .121], [.15, .146, .109], [.205, .13, .1]], 12, .88, true),
  );
  // A shirt's or a jacket's collar: a band standing round the neck, folded down over itself, open in front where its
  // points lie on the chest. Its cross-section, as it goes round, from the inside foot to the outside edge.
  const collar = (() => {
    const p: number[] = [];
    const idx: number[] = [];
    const steps = 14;
    const open = .42;
    const section = (r: number, tip: number): Array<[number, number]> => [
      [r, .628], [r - .003, .668], [r + .004, .676], [r + .02 + .012 * tip, .64 - .045 * tip], [r + .028 + .016 * tip, .628 - .05 * tip],
    ];
    for (let i = 0; i <= steps; i++) {
      const a = open + (Math.PI * 2 - 2 * open) * i / steps;
      const end = Math.max(0, 1 - Math.min(i, steps - i) / 2);
      const ring = section(.062, end);
      for (const [r, y] of ring) p.push(Math.sin(a) * r, y - NECKLINE * .8 * Math.max(0, Math.cos(a)), Math.cos(a) * r * .95);
      if (i) {
        const n = ring.length;
        for (let k = 0; k < n; k++) {
          const a0 = (i - 1) * n + k;
          const a1 = (i - 1) * n + (k + 1) % n;
          idx.push(a0, a0 + n, a1, a1, a0 + n, a1 + n);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(p.length / 3 * 2), 2));
    const b = g.clone();
    const q = b.getAttribute('position');
    for (let i = 0; i < q.count; i++) q.setXYZ(i, q.getX(i) * .9, q.getY(i), q.getZ(i) * .92);
    b.computeVertexNormals();
    return second(paint(g, 0xffffff), b);
  })();
  // The deltoid: a cap over the top of each arm, on the chest's frame at the drawn shoulder (CrowdView.shoulders),
  // whose inside sinks into the torso's slope; it rounds the shoulder from the collar over the arm, where the arm's own
  // dome met the torso's side in a crease and read as a sleeve stuck on.
  const shoulder = profile([
    [-.07, .04, .045], [-.04, .053, .058], [-.015, .06, .064], [0, .056, .061], [.01, .044, .05], [.016, .016, .02],
  ], 8, .9, true);
  const badge = merge([
    ellipsoid(.026, .033, .007, .1, .455, torsoZ(.1, .455) + .003, 0xd5b564),
    box(.061, .014, .009, -.1, .455, torsoZ(.1, .455) + .003, 0xb2bfca),
    box(.044, .084, .017, -.1, .37, torsoZ(.1, .37) + .006, 0x1e2933),
    // The duty belt over the trousers' own: its buckle, a holster on the right hip with the grip showing, two
    // magazine pouches on the left of the buckle and a cuff case behind.
    paint(profile([[.062, .184, .132], [.1, .183, .131]], 14, .84), 0x1d2025),
    box(.04, .03, .012, 0, .081, .136, 0xb8bcb8),
    paint(profile([[-.12, .02, .028], [-.1, .025, .034], [.06, .027, .037], [.09, .028, .038]], 6, .8).translate(-.196, 0, .012), 0x17191c),
    box(.026, .052, .03, -.196, .108, .004, 0x2b2c2e),
    box(.028, .042, .022, .062, .074, .142, 0x1d2025),
    box(.028, .042, .022, .098, .074, .136, 0x1d2025),
    box(.052, .036, .026, .07, .078, -.142, 0x1d2025),
  ]);
  const glasses = merge([
    ellipsoid(.043, .024, .009, -.052, .179, .118, 0x182830),
    ellipsoid(.043, .024, .009, .052, .179, .118, 0x182830),
    box(.033, .007, .008, 0, .187, .124, 0x73766d),
    box(.007, .009, .1, -.102, .188, .065, 0x24282c),
    box(.007, .009, .1, .102, .188, .065, 0x24282c),
  ]);
  return { torso, hips, head, face, hair, hairSweep, hat, neck, upperArm, forearm, hand, thigh, shin, shoe, badge, glasses, sleeve, shortLeg, hairLong, hairTail, hairFull, collar, hem, shoulder };
}
