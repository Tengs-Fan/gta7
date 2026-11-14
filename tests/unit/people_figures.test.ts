// The people as drawn (round 9): limbs that share a ball at each joint with no band to mark it, shoulders drawn inside
// and below the simulation's joints with the hands still where it puts them, a man's and a woman's figure out of one
// batch, sleeves and trouser legs long or short, hair worn five ways, and someone standing idle who is not a post.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { BARE_ARM, characterGeometries, DRAWN_SHOULDER, WOMAN } from '../../src/render/characterGeometry';
import { CrowdView } from '../../src/render/crowd';
import { isWoman } from '../../src/sim/appearance';
import type { Character } from '../../src/sim/entities';
import { shoulderSpread, SKELETON, weaponPose } from '../../src/sim/pose';
import type { Sim } from '../../src/sim/sim';
import { makeSim, world } from './helpers';

await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

interface Part {
  mesh: THREE.InstancedMesh;
  n: number;
  shape?: Float32Array;
  trim?: Float32Array;
  style?: Float32Array;
}

const parts = (cv: CrowdView): Record<string, Part> => (cv as unknown as { parts: Record<string, Part> }).parts;
const matrixAt = (p: Part, i: number): THREE.Matrix4 => {
  const m = new THREE.Matrix4();
  p.mesh.getMatrixAt(i, m);
  return m;
};
const origin = (m: THREE.Matrix4): THREE.Vector3 => new THREE.Vector3().setFromMatrixPosition(m);
const colourAt = (p: Part, i: number): number => {
  const c = new THREE.Color();
  p.mesh.getColorAt(i, c);
  return c.getHex();
};
const tris = (g: THREE.BufferGeometry): number => (g.getIndex()?.count ?? g.getAttribute('position').count) / 3;

/** The widest a part is (across x or z) among its vertices within `near` of height y. */
function girthAt(g: THREE.BufferGeometry, y: number, near = 0.004): { x: number; z: number } {
  const p = g.getAttribute('position');
  let x = 0;
  let z = 0;
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(p.getY(i) - y) > near) continue;
    x = Math.max(x, Math.abs(p.getX(i)));
    z = Math.max(z, Math.abs(p.getZ(i)));
  }
  return { x, z };
}

function shades(g: THREE.BufferGeometry): { min: number; max: number } {
  const c = g.getAttribute('color');
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < c.count; i++) {
    min = Math.min(min, c.getX(i));
    max = Math.max(max, c.getX(i));
  }
  return { min, max };
}

/** A sim with `n` civilians standing in a row on the beach, nobody else, and their ids. */
function row(n: number, role: 'civilian' | 'cop' | 'swat' | 'gang' = 'civilian'): { sim: Sim; people: Character[] } {
  const sim = makeSim({ world: world() });
  const b = sim.world.layout.bounds;
  const people: Character[] = [];
  for (let i = 0; i < n; i++) {
    const c = sim.spawnCharacter(role, b.beachStartX + 30 + (i % 20) * 1.2, (b.landMinZ + b.landMaxZ) / 2 + Math.floor(i / 20) * 1.2);
    c.brain = null;
    people.push(c);
  }
  return { sim, people };
}

/** One character drawn alone: the parts he put, by name, with their counts. */
function drawn(c: Character, local = -1): Record<string, number> {
  const cv = new CrowdView();
  cv.sync([c], c.pos.x, c.pos.z, 1 / 60, local);
  return Object.fromEntries(Object.entries(parts(cv)).map(([k, p]) => [k, p.mesh.count]));
}

describe('the figure', () => {
  const g = characterGeometries();

  it('two limbs meet in one ball: the elbow and the knee are as wide on either side of the joint', () => {
    const elbowUp = girthAt(g.upperArm, -SKELETON.upperArm);
    const elbowDown = girthAt(g.forearm, 0);
    expect(elbowUp.x).toBeGreaterThan(0.03);
    expect(Math.abs(elbowUp.x - elbowDown.x)).toBeLessThan(0.001);
    expect(Math.abs(elbowUp.z - elbowDown.z)).toBeLessThan(0.001);
    const kneeUp = girthAt(g.thigh, -SKELETON.thigh);
    const kneeDown = girthAt(g.shin, 0);
    expect(kneeUp.x).toBeGreaterThan(0.05);
    expect(Math.abs(kneeUp.x - kneeDown.x)).toBeLessThan(0.001);
    expect(Math.abs(kneeUp.z - kneeDown.z)).toBeLessThan(0.001);
    // And each rounds off beyond its joint by about that ball's radius, so a bent joint has no gap.
    for (const [limb, at, r] of [[g.upperArm, -SKELETON.upperArm, elbowUp.x], [g.thigh, -SKELETON.thigh, kneeUp.x]] as const) {
      limb.computeBoundingBox();
      expect(at - limb.boundingBox!.min.y).toBeGreaterThan(r * 0.8);
      expect(at - limb.boundingBox!.min.y).toBeLessThan(r * 1.2);
    }
  });

  it('no joint is marked: arms and thighs are one shade from end to end', () => {
    for (const name of ['upperArm', 'forearm', 'thigh'] as const) {
      const s = shades(g[name]);
      expect(s.min, name).toBeGreaterThan(0.99);
      expect(s.max, name).toBeLessThan(1.01);
    }
    // A hem is the one place cloth is darker: a trouser leg's, a short sleeve's, a pair of shorts'.
    for (const name of ['shin', 'sleeve', 'shortLeg'] as const) expect(shades(g[name]).min, name).toBeLessThan(0.85);
  });

  it('arms taper from the shoulder to the wrist and legs from the hip to the ankle', () => {
    expect(girthAt(g.upperArm, 0).x).toBeGreaterThan(girthAt(g.upperArm, -SKELETON.upperArm).x + 0.005);
    expect(girthAt(g.forearm, 0).x).toBeGreaterThan(girthAt(g.forearm, -SKELETON.forearm).x + 0.01);
    expect(girthAt(g.thigh, 0).z).toBeGreaterThan(girthAt(g.thigh, -SKELETON.thigh).z + 0.02);
    // The calf is behind the shin: its fullest ring sits back from the knee's.
    const p = g.shin.getAttribute('position');
    let back = 0;
    for (let i = 0; i < p.count; i++) if (p.getY(i) < -0.05 && p.getY(i) > -0.25) back = Math.min(back, p.getZ(i));
    expect(-back).toBeGreaterThan(girthAt(g.shin, -SKELETON.shin + 0.012).z + 0.008);
  });

  it('the torso tapers from the shoulders to the waist and slopes from the collar to the arms', () => {
    const shoulders = girthAt(g.torso, 0.535).x;
    const waist = girthAt(g.torso, 0.17).x;
    const collar = girthAt(g.torso, 0.648).x;
    expect(shoulders).toBeGreaterThan(waist + 0.04);
    expect(collar).toBeLessThan(0.08);
    // A shoulder line that falls away from the neck: where the torso is 17 cm out from the spine (the arms start
    // there) its top is 3.5 cm and more under the collar's.
    const p = g.torso.getAttribute('position');
    let top = -Infinity;
    let out = -Infinity;
    for (let i = 0; i < p.count; i++) {
      top = Math.max(top, p.getY(i));
      if (Math.abs(p.getX(i)) >= 0.17) out = Math.max(out, p.getY(i));
    }
    expect(top - out).toBeGreaterThan(0.035);
    expect(top - out).toBeLessThan(0.08);
    // It ends inside the waistband, which is the hips' and wider than it.
    g.torso.computeBoundingBox();
    expect(g.torso.boundingBox!.min.y).toBeGreaterThan(0);
    expect(girthAt(g.hips, 0.094).x).toBeGreaterThan(girthAt(g.torso, 0.06).x + 0.008);
  });

  it("the torso and the hips carry a woman's shape too, vertex for vertex: narrower shoulders and waist, fuller chest and hip", () => {
    for (const name of ['torso', 'hips'] as const) {
      const a = g[name].getAttribute('position');
      const b = g[name].getAttribute('positionB');
      expect(b, name).toBeDefined();
      expect(b.count, name).toBe(a.count);
      expect(g[name].getAttribute('normalB').count, name).toBe(a.count);
    }
    const second = (name: 'torso' | 'hips'): THREE.BufferGeometry => {
      const s = new THREE.BufferGeometry();
      s.setAttribute('position', g[name].getAttribute('positionB'));
      return s;
    };
    const tf = second('torso');
    expect(girthAt(tf, 0.525).x).toBeLessThan(girthAt(g.torso, 0.535).x - 0.015);
    expect(girthAt(tf, 0.17).x).toBeLessThan(girthAt(g.torso, 0.17).x - 0.015);
    expect(girthAt(second('hips'), -0.01).x).toBeGreaterThan(girthAt(g.hips, -0.01).x);
    // No other part has a second shape.
    // Nor do the parts that lie on them, the collar and an untucked hem, lack one; no other part has a second shape.
    for (const name of ['collar', 'hem', 'head'] as const) expect(g[name].getAttribute('positionB').count, name).toBe(g[name].getAttribute('position').count);
    for (const [name, geo] of Object.entries(g)) if (!['torso', 'hips', 'collar', 'hem', 'head'].includes(name)) expect(geo.hasAttribute('positionB'), name).toBe(false);
    // Her jaw is narrower than his.
    const jaw = (attr: 'position' | 'positionB'): number => {
      const q = g.head.getAttribute(attr);
      let x = 0;
      for (let i = 0; i < q.count; i++) if (Math.abs(q.getY(i) - 0.065) < 0.004) x = Math.max(x, Math.abs(q.getX(i)));
      return x;
    };
    expect(jaw('positionB')).toBeLessThan(jaw('position') - 0.005);
  });

  it('every way of wearing hair stays under the roof a rider is fitted to (vehicleView HEAD_TOPS: 0.34 up, 0.14 back)', () => {
    for (const name of ['hair', 'hairSweep', 'hairFull', 'hairLong', 'hairTail'] as const) {
      g[name].computeBoundingBox();
      expect(g[name].boundingBox!.max.y, name).toBeLessThanOrEqual(0.34);
      const p = g[name].getAttribute('position');
      // Above the ears nothing reaches further back than the envelope; a tail and long hair hang below it.
      for (let i = 0; i < p.count; i++) if (p.getY(i) > 0.27) expect(p.getZ(i), name).toBeGreaterThan(-0.141);
    }
  });

  it('the hair covers the head from its hairline up, and a cap covers the hair: neither pokes through the other', () => {
    const mesh = (geo: THREE.BufferGeometry) => new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const head = mesh(g.head);
    const ray = new THREE.Raycaster();
    const from = new THREE.Vector3(0, 0.2, -0.005);
    const far = (m: THREE.Mesh, d: THREE.Vector3): number => {
      ray.set(from, d);
      const hits = ray.intersectObject(m);
      return hits.length ? hits[hits.length - 1]!.distance : -Infinity;
    };
    for (const [name, rise] of [['hair', 0.75], ['hairSweep', 0.75], ['hairFull', 0.75], ['hat', 1.0]] as const) {
      const cover = mesh(g[name]);
      for (let a = 0; a < 32; a++) {
        for (const up of [rise, 1.1, 1.35]) {
          const d = new THREE.Vector3(Math.sin((a / 32) * Math.PI * 2) * Math.cos(up), Math.sin(up), Math.cos((a / 32) * Math.PI * 2) * Math.cos(up));
          // Looking out from inside the head, the head's surface comes before the hair's or the cap's.
          expect(far(cover, d), `${name} at ${a}, ${up}`).toBeGreaterThan(far(head, d));
        }
      }
    }
    // The cap of hair stays inside a hat's band, so a hat over it shows none of it through its crown.
    // (The hat's crown is its first part: rings of 13 vertices, the band at the bottom.)
    const hat = g.hat.getAttribute('position');
    const rings: Array<[number, number, number]> = [];
    for (let r = 0; r * 13 + 12 < hat.count && (r === 0 || hat.getY(r * 13) > rings[r - 1]![0]); r++) {
      let w = 0;
      let d = 0;
      for (let i = r * 13; i < r * 13 + 13; i++) { w = Math.max(w, Math.abs(hat.getX(i))); d = Math.max(d, Math.abs(hat.getZ(i))); }
      rings.push([hat.getY(r * 13), w, d]);
    }
    const band = (y: number): [number, number] => {
      let j = 1;
      while (j < rings.length - 1 && rings[j]![0] < y) j++;
      const a = rings[j - 1]!;
      const b = rings[j]!;
      const t = THREE.MathUtils.clamp((y - a[0]) / (b[0] - a[0]), 0, 1);
      return [THREE.MathUtils.lerp(a[1], b[1], t), THREE.MathUtils.lerp(a[2], b[2], t)];
    };
    const hair = g.hair.getAttribute('position');
    for (let i = 0; i < hair.count; i++) {
      const y = hair.getY(i);
      if (y < 0.27) continue;
      const [w, d] = band(Math.min(y, 0.35));
      expect((hair.getX(i) / (w * 0.96)) ** 2 + (hair.getZ(i) / (d * 0.96)) ** 2, `hair vertex ${i} at ${y}`).toBeLessThan(1);
    }
  });

  it('the head is within the cap and the hair: no higher than their crowns, inside a cap band, under the crown of the hair', () => {
    const p = g.head.getAttribute('position');
    const hair = g.hair.getAttribute('position');
    let crown = 0;
    for (let i = 0; i < hair.count; i++) crown = Math.max(crown, hair.getY(i));
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      expect(y).toBeLessThan(crown);
      // A cap's band is 12.3 cm across and 12.8 cm deep from 26.7 cm up.
      if (y > 0.267) expect((p.getX(i) / 0.123) ** 2 + (p.getZ(i) / 0.128) ** 2).toBeLessThan(1);
    }
  });

  it('every vertex of every part has a normal of length one, in both shapes (one of no length shades as NaN, and the bloom blacks the frame with it)', () => {
    for (const [name, geo] of Object.entries(g)) {
      for (const attr of ['normal', 'normalB'] as const) {
        const n = geo.getAttribute(attr);
        if (!n) continue;
        for (let i = 0; i < n.count; i++) {
          const len = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
          expect(len, `${name}.${attr} vertex ${i}`).toBeGreaterThan(0.99);
          expect(len, `${name}.${attr} vertex ${i}`).toBeLessThan(1.01);
        }
      }
      const q = geo.getAttribute('position');
      for (let i = 0; i < q.count; i++) expect(Number.isFinite(q.getX(i) + q.getY(i) + q.getZ(i)), `${name}.position vertex ${i}`).toBe(true);
    }
  });

  it('a person costs about what he did: under 3,600 triangles dressed plainly, 4,600 at most (no distance level draws him cheaper)', () => {
    const t = (name: keyof typeof g): number => tris(g[name]);
    const plain = t('torso') + t('hips') + t('head') + t('face') + t('hair') + t('neck') + 2 * (t('upperArm') + t('forearm') + t('hand') + t('thigh') + t('shin') + t('shoe') + t('shoulder'));
    // (A hat is worn over the cap of hair, or over long hair instead of it.)
    const most = plain + 2 * (t('sleeve') + t('shortLeg')) + Math.max(t('hairLong'), t('hairTail'), t('hairFull'), t('hairSweep'), t('hat'), t('hat') + t('hairLong') - t('hair')) + t('collar') + t('hem') + t('glasses');
    console.log(`[people] ${plain} triangles dressed plainly, ${most} at most (2,884 before round 9, 3,308 and 3,900 after its first pass)`);
    expect(plain).toBeLessThan(3600);
    expect(most).toBeLessThanOrEqual(4600);
  });
});

describe('the figure in the crowd', () => {
  it('standing, nothing pokes through: the hands hang clear of the thighs, the right hand is the left mirrored', () => {
    const { people } = row(40);
    for (const c of people) {
      const cv = new CrowdView();
      for (let i = 0; i < 30; i++) cv.sync([c], c.pos.x, c.pos.z, 1 / 60);
      const p = parts(cv);
      const g2 = characterGeometries();
      for (const k of [0, 1]) {
        const hand = matrixAt(p.hand!, k);
        // Its mirror: the left hand's frame turns the right way, the right hand's is mirrored across.
        expect(Math.sign(hand.determinant())).toBe(k === 0 ? 1 : -1);
        const thigh = matrixAt(p.thigh!, k);
        const top = origin(thigh);
        const axis = new THREE.Vector3(0, -1, 0).transformDirection(thigh);
        // Every vertex of the hand is outside the thigh (a tube 9 cm round its axis at most, scaled by his girth).
        const girth = new THREE.Vector3().setFromMatrixColumn(thigh, 0).length();
        const q = g2.hand.getAttribute('position');
        const v = new THREE.Vector3();
        let nearest = Infinity;
        for (let i = 0; i < q.count; i++) {
          v.fromBufferAttribute(q, i).applyMatrix4(hand).sub(top);
          const along = v.dot(axis);
          nearest = Math.min(nearest, v.addScaledVector(axis, -along).length());
        }
        expect(nearest, `${c.id} hand ${k}`).toBeGreaterThan(0.085 * girth);
      }
    }
    const hand = parts(new CrowdView()).hand!.mesh.material as THREE.Material;
    expect(hand.side).toBe(THREE.DoubleSide);
  });

  it('the arms are drawn from inside and below the joints the simulation aims from, and a hand still holds the gun where it is', () => {
    const { sim, people } = row(1, 'swat');
    const c = people[0]!;
    c.heading = 0;
    const cv = new CrowdView();
    cv.sync([c], c.pos.x, c.pos.z, 1 / 60);
    const a = c.appearance;
    const sh = [0, 1].map((i) => origin(matrixAt(parts(cv).upperArm!, i)));
    const spread = Math.abs(sh[0]!.x - sh[1]!.x) / 2;
    expect(spread).toBeCloseTo(DRAWN_SHOULDER.x * a.build + DRAWN_SHOULDER.pad, 4);
    expect(spread).toBeLessThan(shoulderSpread(a.build) - 0.04);
    expect(sh[0]!.y - c.pos.y).toBeCloseTo((SKELETON.hipY + SKELETON.shoulderY - DRAWN_SHOULDER.drop) * a.height, 2);
    // Armed and aiming: the right hand is on the grip the simulation's pose gives, as before.
    c.inventory.give('pistol', 30);
    c.inventory.current = 'pistol';
    c.aiming = true;
    c.aimYaw = 0;
    c.aimPitch = 0;
    for (let i = 0; i < 20; i++) cv.sync([c], c.pos.x, c.pos.z, 1 / 60);
    const w = weaponPose(c);
    const hands = [0, 1].map((i) => origin(matrixAt(parts(cv).hand!, i)));
    const nearest = Math.min(...hands.map((h) => h.distanceTo(new THREE.Vector3(w.hand.x, w.hand.y, w.hand.z))));
    expect(nearest).toBeLessThan(0.06);
    void sim;
  });

  it('what someone wears is his by his id: the same each time he is drawn, a town of men and women, sleeves and legs long and short', () => {
    const { people } = row(400);
    let women = 0;
    let bare = 0;
    let shorts = 0;
    const hair: Record<string, number> = { hairSweep: 0, hairLong: 0, hairTail: 0, hairFull: 0 };
    for (const c of people) {
      const d = drawn(c);
      expect(drawn(c)).toEqual(d);
      // One body: a torso, hips, a head and a face, two of every limb, a cap of hair or a hat.
      expect([d.torso, d.hips, d.head, d.face, d.neck]).toEqual([1, 1, 1, 1, 1]);
      expect([d.upperArm, d.forearm, d.hand, d.thigh, d.shin, d.shoe]).toEqual([2, 2, 2, 2, 2, 2]);
      // The cap of hair, or long hair, under a hat too.
      expect(d.hair! + (d.hat ? d.hairLong! : 0)).toBe(1);
      expect([0, 1]).toContain(d.hat);
      expect([0, 2]).toContain(d.sleeve);
      expect([0, 2]).toContain(d.shortLeg);
      if (d.sleeve) bare++;
      if (d.shortLeg) shorts++;
      for (const k of Object.keys(hair)) hair[k]! += d[k]!;
      const cv = new CrowdView();
      cv.sync([c], c.pos.x, c.pos.z, 1 / 60);
      // A woman's figure for a woman (sim/appearance.ts isWoman, which her voice follows too), torso and hips alike.
      const shape = parts(cv).torso!.shape![0]!;
      expect(shape).toBe(isWoman(c) ? 1 : 0);
      expect(parts(cv).hips!.shape![0]).toBe(shape);
      if (shape === 1) {
        women++;
        // Her shoulders are drawn narrower.
        const sh = [0, 1].map((i) => origin(matrixAt(parts(cv).upperArm!, i)));
        expect(sh[0]!.distanceTo(sh[1]!) / 2).toBeCloseTo((DRAWN_SHOULDER.x * c.appearance.build + DRAWN_SHOULDER.pad) * WOMAN.shoulders, 4);
      }
      // Short sleeves: a bare arm (the skin's colour, drawn slimmer) under a sleeve of the shirt's; no jacket over them.
      const arm = parts(cv).upperArm!;
      if (d.sleeve) {
        expect(colourAt(arm, 0)).toBe(c.appearance.skin);
        expect(colourAt(parts(cv).sleeve!, 0)).toBe(c.appearance.shirt);
        expect(new THREE.Vector3().setFromMatrixColumn(matrixAt(arm, 0), 0).length()).toBeCloseTo(BARE_ARM * (shape === 1 ? WOMAN.arm : 1), 4);
        // No jacket (top 4) over short sleeves.
        expect(parts(cv).torso!.style![0]).not.toBe(4);
      } else expect(colourAt(arm, 0)).toBe(c.appearance.shirt);
      // A collar goes with a shirt or a jacket, and a hem worn over the belt has the top's colour and its woman's shape.
      expect(d.collar).toBe([2, 4].includes(parts(cv).torso!.style![0]!) ? 1 : 0);
      if (d.hem) {
        expect(colourAt(parts(cv).hem!, 0)).toBe(c.appearance.shirt);
        expect(parts(cv).hem!.shape![0]).toBe(shape);
      }
      // Two deltoids, in the shirt's colour.
      expect(d.shoulder).toBe(2);
      expect(colourAt(parts(cv).shoulder!, 0)).toBe(c.appearance.shirt);
      // Each sits on its arm's shoulder joint, whatever his build or hers.
      for (const i of [0, 1]) expect(origin(matrixAt(parts(cv).shoulder!, i)).distanceTo(origin(matrixAt(arm, i)))).toBeLessThan(1e-6);
      if (d.shortLeg) expect(colourAt(parts(cv).shin!, 0)).toBe(c.appearance.skin);
      else expect(colourAt(parts(cv).shin!, 0)).toBe(c.appearance.pants);
    }
    console.log(`[people] of 400 civilians: ${women} women, ${bare} in short sleeves, ${shorts} in shorts; hair ${JSON.stringify(hair)}`);
    expect(women).toBeGreaterThan(150);
    expect(women).toBeLessThan(250);
    expect(bare).toBeGreaterThan(170);
    expect(bare).toBeLessThan(270);
    expect(shorts).toBeGreaterThan(60);
    expect(shorts).toBeLessThan(140);
    for (const k of Object.keys(hair)) expect(hair[k], k).toBeGreaterThan(15);
  });

  it('the player and the law are covered: his jacket and jeans, their uniforms with trousers, a riot squad in long sleeves', () => {
    const sim = makeSim({ world: world() });
    const me = drawn(sim.player, sim.player.id);
    expect([me.sleeve, me.shortLeg, me.collar, me.hem]).toEqual([0, 0, 1, 1]);
    const cv = new CrowdView();
    cv.sync([sim.player], sim.player.pos.x, sim.player.pos.z, 1 / 60, sim.player.id);
    expect(parts(cv).torso!.shape![0]).toBe(0);
    {
      // His jacket (top 4) is zipped over the pale shirt; his jeans are stitched and belted.
      const p = parts(cv);
      expect(Array.from(p.torso!.style!.slice(0, 2))).toEqual([4, 1]);
      expect(Array.from(p.hips!.style!.slice(0, 2))).toEqual([1, 1]);
    }
    for (const c of row(120, 'cop').people) {
      const d = drawn(c);
      // Man or woman, an officer wears the badge.
      expect([d.shortLeg, d.badge]).toEqual([0, 1]);
    }
    for (const c of row(60, 'swat').people) {
      const d = drawn(c);
      expect([d.sleeve, d.shortLeg]).toEqual([0, 0]);
      expect(isWoman(c)).toBe(false);
    }
    // A quarter of the police and of a gang are women; a mission's people ("he" in every line about them) are men.
    const share = (role: 'cop' | 'gang' | 'mission' | 'civilian'): number => Array.from({ length: 2000 }, (_, id) => isWoman({ role, id })).filter(Boolean).length / 2000;
    expect(share('civilian')).toBeGreaterThan(0.46);
    expect(share('civilian')).toBeLessThan(0.54);
    expect(share('cop')).toBeGreaterThan(0.21);
    expect(share('cop')).toBeLessThan(0.29);
    expect(share('gang')).toBeGreaterThan(0.21);
    expect(share('gang')).toBeLessThan(0.29);
    expect(share('mission')).toBe(0);
    expect(isWoman(sim.player)).toBe(false);
  });

  it("a woman's narrower shoulders still reach the gun: an officer's hand is on the pistol's grip and on the rifle's, aimed", () => {
    const she = row(200, 'cop').people.find((c) => isWoman(c))!;
    expect(she).toBeDefined();
    she.heading = 0.4;
    for (const weapon of ['pistol', 'rifle'] as const) {
      she.inventory.give(weapon, 30);
      she.inventory.current = weapon;
      she.aiming = true;
      she.aimYaw = 0.4;
      she.aimPitch = 0;
      const cv = new CrowdView();
      for (let i = 0; i < 20; i++) cv.sync([she], she.pos.x, she.pos.z, 1 / 60);
      expect(parts(cv).torso!.shape![0]).toBe(1);
      const w = weaponPose(she);
      const hands = [0, 1].map((i) => origin(matrixAt(parts(cv).hand!, i)));
      const grip = new THREE.Vector3(w.hand.x, w.hand.y, w.hand.z);
      expect(Math.min(...hands.map((h) => h.distanceTo(grip))), weapon).toBeLessThan(0.06);
      // And a rifle's fore-end is in the other hand.
      if (weapon === 'rifle') {
        const fore = new THREE.Vector3(w.offHand.x, w.offHand.y, w.offHand.z);
        expect(Math.min(...hands.map((h) => h.distanceTo(fore)))).toBeLessThan(0.06);
      }
    }
  });

  it('the shaders take the two shapes and the edge light: every line the crowd adds to three\'s lands', () => {
    const cv = new CrowdView();
    const compile = (mat: THREE.Material, lib: { vertexShader: string; fragmentShader: string }) => {
      const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: {} };
      (mat.onBeforeCompile as (s: unknown, r: unknown) => void)(shader, null);
      return shader;
    };
    const torso = parts(cv).torso!.mesh;
    const arm = parts(cv).upperArm!.mesh;
    const shaped = compile(torso.material as THREE.Material, THREE.ShaderLib.standard);
    expect(shaped.vertexShader).toContain('attribute float instanceShape;');
    expect(shaped.vertexShader).toContain('transformed = mix( transformed, positionB, instanceShape );');
    expect(shaped.vertexShader).toContain('objectNormal = mix( objectNormal, normalB, instanceShape );');
    expect(shaped.vertexShader).toContain('vInstanceFade = instanceFade;');
    expect(shaped.fragmentShader).toContain('float nap = ');
    // A part with one shape has the fade and the edge light and no blend.
    const plain = compile(arm.material as THREE.Material, THREE.ShaderLib.standard);
    expect(plain.vertexShader).not.toContain('instanceShape');
    expect(plain.vertexShader).toContain('vInstanceFade = instanceFade;');
    expect(plain.fragmentShader).toContain('float nap = ');
    // Their shadows: the same blend, so a woman's shadow is her own shape.
    const depth = compile(torso.customDepthMaterial as THREE.Material, THREE.ShaderLib.depth);
    expect(depth.vertexShader).toContain('transformed = mix( transformed, positionB, instanceShape );');
    expect(compile(arm.customDepthMaterial as THREE.Material, THREE.ShaderLib.depth).vertexShader).not.toContain('instanceShape');
    // Every painted part's paint lands, on the Standard program and on the software tier's Lambert one.
    for (const lib of [THREE.ShaderLib.standard, THREE.ShaderLib.lambert]) {
      for (const [name, p] of Object.entries(parts(cv))) {
        if (!p.trim) continue;
        const sh = compile(p.mesh.material as THREE.Material, lib);
        expect(sh.vertexShader, name).toContain('vObj = transformed;');
        expect(sh.fragmentShader, name).toContain('diffuseColor.rgb = col;');
        expect(sh.fragmentShader, name).toContain('float pxFill(');
      }
    }
    // The hands, drawn from both sides: a mirrored (right) hand's faces count as its front.
    const hand = compile(parts(cv).hand!.mesh.material as THREE.Material, THREE.ShaderLib.standard);
    expect(hand.fragmentShader).toContain('float faceDirection = ( gl_FrontFacing ? 1.0 : - 1.0 ) * vMirror;');
    expect(hand.vertexShader).toContain('vMirror = sign( determinant( mat3( instanceMatrix ) ) );');
    // Two programs, not one: three keys a program on the text of its patch, or on the key a painted part names.
    const key = (m: THREE.Material) => m.customProgramCacheKey();
    expect(key(torso.material as THREE.Material)).not.toBe(key(arm.material as THREE.Material));
    expect(key(parts(cv).hips!.mesh.material as THREE.Material)).not.toBe(key(torso.material as THREE.Material));
  });

  it('someone standing idle breathes and looks about, to his own time, with his feet where they were; with a gun up he is still', () => {
    const { people } = row(2);
    const [a, b] = people as [Character, Character];
    const cv = new CrowdView();
    const sample = () => {
      cv.sync([a, b], a.pos.x, a.pos.z, 1 / 60);
      const p = parts(cv);
      const fwd = (i: number) => new THREE.Vector3(0, 0, 1).transformDirection(matrixAt(p.head!, i));
      return { head: [fwd(0), fwd(1)], shoe: origin(matrixAt(p.shoe!, 0)), chest: new THREE.Vector3(0, 1, 0).transformDirection(matrixAt(p.torso!, 0)) };
    };
    const first = sample();
    let turned = 0;
    let apart = 0;
    let breath = 0;
    for (let i = 0; i < 60 * 30; i++) {
      const s = sample();
      turned = Math.max(turned, s.head[0]!.angleTo(first.head[0]!));
      apart = Math.max(apart, Math.abs(s.head[0]!.angleTo(first.head[0]!) - s.head[1]!.angleTo(first.head[1]!)));
      breath = Math.max(breath, s.chest.angleTo(first.chest));
      expect(s.shoe.distanceTo(first.shoe)).toBeLessThan(1e-6);
    }
    expect(turned).toBeGreaterThan(0.15);
    expect(turned).toBeLessThan(0.7);
    expect(apart).toBeGreaterThan(0.05);
    expect(breath).toBeGreaterThan(0.005);
    expect(breath).toBeLessThan(0.05);
    // Setting off, his head does not snap round: it eases back to his way over half a second.
    {
      const { people: walkers } = row(1);
      const w = walkers[0]!;
      const view = new CrowdView();
      /** Which way the head faces in the chest's own frame: the glance, apart from whatever the walk does to the chest. */
      const head = () => {
        view.sync([w], w.pos.x, w.pos.z, 1 / 60);
        const q = parts(view);
        const chest = new THREE.Matrix4().extractRotation(matrixAt(q.torso!, 0)).invert();
        return new THREE.Vector3(0, 0, 1).transformDirection(matrixAt(q.head!, 0)).transformDirection(chest);
      };
      const ahead = new THREE.Vector3(0, 0, 1);
      // Stand until he is looking well to one side.
      let was = head();
      for (let i = 0; i < 60 * 60 && Math.abs(was.x) < 0.2; i++) was = head();
      expect(Math.abs(was.x)).toBeGreaterThanOrEqual(0.2);
      // Then walk: no frame turns the head by more than a couple of degrees.
      w.speed = 1.4;
      w.vel.x = Math.sin(w.heading) * 1.4;
      w.vel.z = Math.cos(w.heading) * 1.4;
      // (His head's turn to the side, apart from the nod the walk's lean gives it.)
      const yaw = (d: THREE.Vector3) => Math.atan2(d.x, d.z);
      let worst = 0;
      for (let i = 0; i < 90; i++) {
        const now = head();
        worst = Math.max(worst, Math.abs(yaw(now) - yaw(was)));
        was = now;
      }
      expect(worst).toBeLessThan(0.03);
      // And he ends up looking where he is going.
      expect(Math.abs(was.x)).toBeLessThan(0.03);
      void ahead;
    }
    // Aiming, the head is on the sights and the chest does not sway.
    a.inventory.give('pistol', 30);
    a.inventory.current = 'pistol';
    a.aiming = true;
    a.aimYaw = a.heading;
    for (let i = 0; i < 30; i++) sample();
    const held = sample();
    for (let i = 0; i < 120; i++) {
      const s = sample();
      expect(s.head[0]!.angleTo(held.head[0]!)).toBeLessThan(1e-6);
      expect(s.chest.angleTo(held.chest)).toBeLessThan(1e-6);
    }
  });
});
