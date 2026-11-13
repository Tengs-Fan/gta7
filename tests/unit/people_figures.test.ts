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
    // A shoulder line that falls away from the neck: 4 cm lower where the arms start than at the collar.
    expect(0.648 - 0.606).toBeGreaterThan(0.035);
    expect(girthAt(g.torso, 0.606).x).toBeGreaterThan(0.17);
    // It ends inside the waistband, which is the hips' and wider than it.
    g.torso.computeBoundingBox();
    expect(g.torso.boundingBox!.min.y).toBeGreaterThan(0);
    expect(girthAt(g.hips, 0.076).x).toBeGreaterThan(girthAt(g.torso, 0.06).x + 0.008);
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
    for (const [name, geo] of Object.entries(g)) if (name !== 'torso' && name !== 'hips') expect(geo.hasAttribute('positionB'), name).toBe(false);
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

  it('a person costs about what he did: under 3,400 triangles dressed plainly, 4,000 at most', () => {
    const t = (name: keyof typeof g): number => tris(g[name]);
    const plain = t('torso') + t('hips') + t('head') + t('face') + t('hair') + t('neck') + 2 * (t('upperArm') + t('forearm') + t('hand') + t('thigh') + t('shin') + t('shoe'));
    const most = plain + 2 * (t('sleeve') + t('shortLeg')) + Math.max(t('hairLong'), t('hairTail'), t('hairFull'), t('hairSweep'));
    console.log(`[people] ${plain} triangles dressed plainly, ${most} at most (2,884 before round 9)`);
    expect(plain).toBeLessThan(3400);
    expect(most).toBeLessThanOrEqual(4000);
  });
});

describe('the figure in the crowd', () => {
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

  it('what someone wears is his by his id: the same on any screen, a town of men and women, sleeves and legs long and short', () => {
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
      expect(d.hair! + d.hat!).toBe(1);
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
        // Cut to the man's torso, a jacket's panels are not put on hers.
        expect(d.jacketTrim).toBe(0);
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
        expect(d.jacketTrim).toBe(0);
      } else expect(colourAt(arm, 0)).toBe(c.appearance.shirt);
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
    expect([me.sleeve, me.shortLeg, me.jacketTrim, me.shirtInset]).toEqual([0, 0, 1, 1]);
    const cv = new CrowdView();
    cv.sync([sim.player], sim.player.pos.x, sim.player.pos.z, 1 / 60, sim.player.id);
    expect(parts(cv).torso!.shape![0]).toBe(0);
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
