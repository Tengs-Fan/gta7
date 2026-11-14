// How the people move (round 9): someone standing about rests on one leg with his feet planted, an arm swings
// forward with the other leg, no knee or elbow bends past its limit or the wrong way at any speed, each person's own
// way of walking is his every time, and a turn is led by the head while a gun stays where the simulation has it.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { characterGeometries } from '../../src/render/characterGeometry';
import { CrowdView } from '../../src/render/crowd';
import { isWoman } from '../../src/sim/appearance';
import { stepCharacter, type CharacterPhysicsHost } from '../../src/sim/characterPhysics';
import { Character, type Appearance } from '../../src/sim/entities';
import { makeTrunk, trunkPose } from '../../src/sim/pose';
import { wrapAngle } from '../../src/core/math';
import type { StaticWorld } from '../../src/world/staticWorld';

await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

type Part = { mesh: THREE.InstancedMesh; n: number };
const parts = (cv: CrowdView): Record<string, Part> => (cv as unknown as { parts: Record<string, Part> }).parts;
const matrixAt = (p: Part, i: number): THREE.Matrix4 => {
  const m = new THREE.Matrix4();
  p.mesh.getMatrixAt(i, m);
  return m;
};
const origin = (m: THREE.Matrix4): THREE.Vector3 => new THREE.Vector3().setFromMatrixPosition(m);
const axis = (m: THREE.Matrix4): THREE.Vector3 => new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
const deg = THREE.MathUtils.radToDeg;

const flat: CharacterPhysicsHost = {
  world: { groundHeight: () => 0, bounds: { worldMinX: -1e5, worldMaxX: 1e5, worldMinZ: -1e5, worldMaxZ: 1e5 } } as unknown as StaticWorld,
  onCharacterHitByVehicle: () => {},
  onCharacterLanded: () => {},
  onCharacterSplash: () => {},
};

const LOOK: Appearance = { skin: 0xc68642, shirt: 0x2a2c33, pants: 0x34557f, hair: 0x15110e, hat: 0, height: 1, build: 1 };

/** Ids 1..n: civilians, about half of them women. */
const IDS = Array.from({ length: 40 }, (_, i) => i + 1);

function person(id: number, height = 1, build = 1): Character {
  return new Character(id, 'civilian', 0, 0, 0, { ...LOOK, height, build });
}

/** Heights and builds across those the game gives people (randomAppearance; a riot squad's build is 1.18). */
const HEIGHTS = [0.9, 1, 1.07];
const BUILDS = [0.88, 1, 1.18];

/** (x left, y up, z forward) of a world point relative to a character and its heading. */
function local(c: Character, p: THREE.Vector3): THREE.Vector3 {
  const dx = p.x - c.pos.x;
  const dz = p.z - c.pos.z;
  const h = c.heading;
  return new THREE.Vector3(dx * Math.cos(h) - dz * Math.sin(h), p.y - c.pos.y, dx * Math.sin(h) + dz * Math.cos(h));
}

/** Bottom corners of the shoe box in its own frame. */
const SOLE = [-0.075, 0.075].flatMap((x) => [-0.07, 0.19].map((z) => new THREE.Vector3(x, -0.075, z)));
const soleLow = (m: THREE.Matrix4): number => Math.min(...SOLE.map((p) => p.clone().applyMatrix4(m).y));
/** The shoe's sole as modelled (its rounded outline), in its own frame. */
const OUTLINE = (() => {
  const pos = characterGeometries().shoe.getAttribute('position');
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < -0.06) out.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  return out;
})();
/** How far from the character's centre his shoe's sole reaches. */
const soleFar = (c: Character, m: THREE.Matrix4): number => Math.max(...OUTLINE.map((p) => p.clone().applyMatrix4(m)).map((p) => Math.hypot(p.x - c.pos.x, p.z - c.pos.z)));

/** Each drawn leg and arm of the only character drawn, its joints in his own frame, left first. */
function limbs(cv: CrowdView, c: Character) {
  const p = parts(cv);
  const legs = [0, 1].map((i) => ({
    hip: local(c, origin(matrixAt(p.thigh!, i))),
    knee: local(c, origin(matrixAt(p.shin!, i))),
    ankle: local(c, origin(matrixAt(p.shoe!, i))),
    flex: deg(axis(matrixAt(p.thigh!, i)).angleTo(axis(matrixAt(p.shin!, i)))),
    sole: soleLow(matrixAt(p.shoe!, i)),
  }));
  const arms = [0, 1].map((i) => ({
    shoulder: local(c, origin(matrixAt(p.upperArm!, i))),
    elbow: local(c, origin(matrixAt(p.forearm!, i))),
    hand: local(c, origin(matrixAt(p.hand!, i))),
    flex: deg(axis(matrixAt(p.upperArm!, i)).angleTo(axis(matrixAt(p.forearm!, i)))),
  }));
  if (legs[0]!.hip.x < legs[1]!.hip.x) legs.reverse();
  if (arms[0]!.shoulder.x < arms[1]!.shoulder.x) arms.reverse();
  return { legs, arms };
}

/** Sagittal angle (deg, + forward of straight down) of the direction from a to b. */
const pitch = (a: THREE.Vector3, b: THREE.Vector3): number => deg(Math.atan2(b.z - a.z, a.y - b.y));

/** Walks `c` straight ahead at `speed` on flat ground, calling `sample` every 240 Hz step after 1 s to settle. */
function walk(c: Character, speed: number, seconds: number, sample: (cv: CrowdView) => void, cv = new CrowdView()): void {
  c.moveX = Math.sin(c.heading);
  c.moveZ = Math.cos(c.heading);
  c.moveSpeed = speed;
  const dt = 1 / 240;
  for (let i = 0; i < 240 * (1 + seconds); i++) {
    stepCharacter(c, dt, flat);
    cv.sync([c], c.pos.x, c.pos.z, dt);
    if (i >= 240) sample(cv);
  }
}

describe('standing about', () => {
  it('he rests on one leg, the other knee bent and that foot forward, both soles flat on the ground inside his collision circle', () => {
    let women = 0;
    for (const id of IDS) {
      for (const [height, build] of HEIGHTS.flatMap((h) => BUILDS.map((b) => [h, b] as const))) {
        const c = person(id, height, build);
        if (height === 1 && build === 1 && isWoman(c)) women++;
        const cv = new CrowdView();
        for (let i = 0; i < 120; i++) cv.sync([c], 0, 0, 1 / 60);
        const { legs } = limbs(cv, c);
        const [straight, bent] = legs[0]!.flex < legs[1]!.flex ? [legs[0]!, legs[1]!] : [legs[1]!, legs[0]!];
        const label = `id ${id} height ${height} build ${build}`;
        expect(straight.flex, label).toBeLessThan(8);
        expect(bent.flex, label).toBeGreaterThan(10);
        expect(bent.flex, label).toBeLessThan(25);
        expect(bent.ankle.z - straight.ankle.z, label).toBeGreaterThan(0.015);
        // The hips over the leg he stands on.
        const mid = (legs[0]!.hip.x + legs[1]!.hip.x) / 2;
        expect(Math.sign(mid), label).toBe(Math.sign(straight.hip.x));
        // Both soles on the ground: none under it, neither lifted.
        const p = parts(cv);
        for (let i = 0; i < 2; i++) {
          const low = soleLow(matrixAt(p.shoe!, i));
          expect(low, label).toBeGreaterThan(-0.005);
          expect(low, label).toBeLessThan(0.01);
          expect(soleFar(c, matrixAt(p.shoe!, i)), label).toBeLessThan(c.radius);
        }
      }
    }
    // Men and women both.
    expect(women).toBeGreaterThan(IDS.length * 0.25);
    expect(women).toBeLessThan(IDS.length * 0.75);
  });

  it('with a gun in hand his trunk is where the simulation has it, his feet still set as he stands', () => {
    const c = person(4);
    c.inventory.give('pistol', 30);
    c.inventory.current = 'pistol';
    const cv = new CrowdView();
    for (let i = 0; i < 120; i++) cv.sync([c], 0, 0, 1 / 60);
    const t = trunkPose(c, makeTrunk());
    const torso = origin(matrixAt(parts(cv).torso!, 0));
    expect(torso.distanceTo(new THREE.Vector3(c.pos.x, c.pos.y + t.y, c.pos.z))).toBeLessThan(1e-6);
    const { legs } = limbs(cv, c);
    expect(Math.max(legs[0]!.flex, legs[1]!.flex)).toBeGreaterThan(10);
    expect(Math.min(legs[0]!.sole, legs[1]!.sole)).toBeLessThan(0.01);
  });
});

describe('a gun in hand pins the trunk', () => {
  it('drawing a gun after standing about, the very next frame his trunk is the simulation’s', () => {
    const c = person(6);
    const cv = new CrowdView();
    for (let i = 0; i < 90; i++) cv.sync([c], 0, 0, 1 / 60);
    const rest = origin(matrixAt(parts(cv).torso!, 0));
    // At rest the renderer has moved his hips over the leg he stands on.
    expect(Math.hypot(rest.x - c.pos.x, rest.z - c.pos.z)).toBeGreaterThan(0.03);
    c.inventory.give('pistol', 30);
    c.inventory.current = 'pistol';
    cv.sync([c], 0, 0, 1 / 60);
    const t = trunkPose(c, makeTrunk());
    expect(origin(matrixAt(parts(cv).torso!, 0)).distanceTo(new THREE.Vector3(c.pos.x, c.pos.y + t.y, c.pos.z))).toBeLessThan(1e-6);
  });
});

describe('walking and running', () => {
  it.each([1.45, 2.8, 4.3, 7.4])('at %f m/s the arm swings forward with the other leg', (speed) => {
    for (const id of [1, 2, 3, 5, 8, 13]) {
      const c = person(id);
      const seen: Array<[number, number]> = [];
      walk(c, speed, 1, (cv) => {
        const { legs, arms } = limbs(cv, c);
        seen.push([legs[0]!.ankle.z - legs[1]!.ankle.z, arms[1]!.hand.z - arms[0]!.hand.z]);
      });
      // Near the ends of the stride, the hand on the side of the trailing foot is the one in front.
      const most = Math.max(...seen.map(([a]) => Math.abs(a)));
      const ends = seen.filter(([a]) => Math.abs(a) > 0.75 * most);
      expect(ends.length).toBeGreaterThan(20);
      for (const [ahead, hands] of ends) expect(Math.sign(hands), `id ${id}`).toBe(Math.sign(ahead));
    }
  });

  it('no knee or elbow bends past its limit or the wrong way, at any pace, for anyone', () => {
    const worst = { knee: 0, elbow: 0, kneeBack: 0, elbowBack: 0 };
    for (const id of IDS.filter((i) => i % 3 === 1)) {
      for (const speed of [0.5, 1.45, 1.9, 2.8, 4.3, 6.3, 7.4]) {
        const c = person(id, id % 2 ? 1.07 : 0.92);
        walk(c, speed, 0.6, (cv) => {
          const { legs, arms } = limbs(cv, c);
          for (const l of legs) {
            worst.knee = Math.max(worst.knee, l.flex);
            // A knee only folds forward: the shin turns back from the thigh, never ahead of it.
            if (l.flex > 3) worst.kneeBack = Math.max(worst.kneeBack, pitch(l.knee, l.ankle) - pitch(l.hip, l.knee));
          }
          for (const a of arms) {
            worst.elbow = Math.max(worst.elbow, a.flex);
            // An elbow only folds forward.
            if (a.flex > 3) worst.elbowBack = Math.max(worst.elbowBack, pitch(a.shoulder, a.elbow) - pitch(a.elbow, a.hand));
          }
        });
      }
    }
    expect(worst.knee).toBeLessThan(150);
    expect(worst.elbow).toBeLessThan(125);
    expect(worst.kneeBack).toBeLessThan(1);
    expect(worst.elbowBack).toBeLessThan(1);
  });

  it('a sprinter’s hands come up to his chest, never into his face', () => {
    let nearest = Infinity;
    for (const id of IDS) {
      for (const speed of [6.3, 7.4]) {
        const c = person(id);
        walk(c, speed, 0.5, (cv) => {
          const head = origin(matrixAt(parts(cv).head!, 0));
          // The head's middle, above the neck pivot it turns on.
          head.y += 0.12 * c.appearance.height;
          const hands = parts(cv).hand!;
          for (let i = 0; i < 2; i++) nearest = Math.min(nearest, origin(matrixAt(hands, i)).distanceTo(head));
        });
      }
    }
    // (0.35 m at the nearest, over 40 people.)
    expect(nearest).toBeGreaterThan(0.25);
  });

  it('a jogger’s hand goes back past his hip and comes forward to his chest, the elbow bent more in front', () => {
    const c = person(2);
    let back = Infinity;
    let front = -Infinity;
    let flexBack = 0;
    let flexFront = 0;
    walk(c, 4.3, 1, (cv) => {
      const { legs, arms } = limbs(cv, c);
      const hipZ = (legs[0]!.hip.z + legs[1]!.hip.z) / 2;
      for (const a of arms) {
        const z = a.hand.z - hipZ;
        if (z < back) {
          back = z;
          flexBack = a.flex;
        }
        if (z > front) {
          front = z;
          flexFront = a.flex;
        }
      }
    });
    expect(back).toBeLessThan(-0.03);
    expect(front).toBeGreaterThan(0.3);
    expect(flexFront).toBeGreaterThan(flexBack + 25);
  });
});

describe('setting off and stopping', () => {
  it.each([0, 0.13, 0.27])('stopping from a walk %f s into a stride, one foot steps into his stance and the other stays down', (at) => {
    const c = person(1);
    const cv = new CrowdView();
    walk(c, 1.45, at, () => {}, cv);
    c.moveSpeed = 0;
    const travel = [0, 0];
    const slid = [0, 0];
    const high = [0, 0];
    const last: Array<THREE.Vector3 | null> = [null, null];
    for (let i = 0; i < 240; i++) {
      stepCharacter(c, 1 / 240, flat);
      cv.sync([c], c.pos.x, c.pos.z, 1 / 240);
      const shoe = parts(cv).shoe!;
      for (let k = 0; k < 2; k++) {
        const m = matrixAt(shoe, k);
        const o = origin(m);
        const low = soleLow(m);
        high[k] = Math.max(high[k]!, low);
        if (last[k]) {
          const d = Math.hypot(o.x - last[k]!.x, o.z - last[k]!.z);
          travel[k]! += d;
          if (low < 0.01) slid[k]! += d;
        }
        last[k] = o;
      }
    }
    const stepper = high[0]! > high[1]! ? 0 : 1;
    const stands = 1 - stepper;
    // The foot he stands on never leaves the ground (its every movement counts as sliding), the other is lifted.
    expect(high[stands]).toBeLessThan(0.01);
    expect(high[stepper]).toBeGreaterThan(0.025);
    // (0.34, 0.15 and 0.16 m; both feet slid 0.58, 0.33 and 0.16 m before the step.)
    expect(travel[stands]! + slid[stepper]!).toBeLessThan(0.36);
  });
});

describe('everyone his own way', () => {
  /** The arm swing (m of hand travel along the walk) and the hands' height at mid-swing, walking at 1.45 m/s. */
  function swing(id: number): { travel: number; drawn: number[] } {
    const c = person(id);
    let lo = Infinity;
    let hi = -Infinity;
    const drawn: number[] = [];
    walk(c, 1.45, 1, (cv) => {
      const { arms } = limbs(cv, c);
      lo = Math.min(lo, arms[0]!.hand.z);
      hi = Math.max(hi, arms[0]!.hand.z);
      drawn.push(...matrixAt(parts(cv).forearm!, 0).elements);
    });
    return { travel: hi - lo, drawn };
  }

  it('the same person walks the same way every time, and people differ', () => {
    const a = swing(7);
    const b = swing(7);
    expect(b.drawn).toEqual(a.drawn);
    const travels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => swing(id).travel);
    expect(Math.max(...travels) - Math.min(...travels)).toBeGreaterThan(0.06);
  });
});

describe('turning', () => {
  it('the head leads a turn, the chest follows it ahead of the hips and he leans into it; with a gun the chest is the simulation’s', () => {
    const turn = (armed: boolean, speed = 1.45) => {
      const c = person(3);
      if (armed) {
        c.inventory.give('pistol', 30);
        c.inventory.current = 'pistol';
      }
      const cv = new CrowdView();
      let head = 0;
      let chest = 0;
      let bank = 0;
      walk(c, speed, 0.25, () => {}, cv);
      // Turning left at 9 rad/s, as a walker steers round a corner.
      for (let i = 0; i < 24; i++) {
        c.heading += 9 / 240;
        c.moveX = Math.sin(c.heading);
        c.moveZ = Math.cos(c.heading);
        stepCharacter(c, 1 / 240, flat);
        cv.sync([c], c.pos.x, c.pos.z, 1 / 240);
      }
      const p = parts(cv);
      const yaw = (m: THREE.Matrix4) => {
        const f = new THREE.Vector3(0, 0, 1).transformDirection(m);
        return Math.atan2(f.x, f.z);
      };
      head = yaw(matrixAt(p.head!, 0)) - c.heading;
      bank = local(c, new THREE.Vector3().setFromMatrixColumn(matrixAt(p.torso!, 0), 1).add(c.pos)).x;
      chest = yaw(matrixAt(p.torso!, 0)) - trunkPose(c, makeTrunk()).chestYaw;
      return { head, chest, bank };
    };
    const free = turn(false);
    expect(free.head).toBeGreaterThan(0.2);
    expect(free.chest).toBeGreaterThan(0.08);
    expect(free.head).toBeGreaterThan(free.chest);
    // Moving, he leans into the turn (his chest tips to his left, the way he turns); faster, further.
    expect(free.bank).toBeGreaterThan(0.01);
    expect(turn(false, 4.3).bank).toBeGreaterThan(free.bank);
    const armed = turn(true);
    expect(armed.head).toBeGreaterThan(0.2);
    expect(Math.abs(armed.chest)).toBeLessThan(1e-6);
    expect(Math.abs(armed.bank)).toBeLessThan(0.02);
  });

  /** His head's turn relative to his hips (rad), as drawn. */
  const headTurn = (cv: CrowdView, c: Character): number => {
    const f = new THREE.Vector3(0, 0, 1).transformDirection(matrixAt(parts(cv).head!, 0));
    return Math.atan2(f.x, f.z) - c.heading;
  };

  it('a heading changed while he lies, swims or the game is paused is no turn when he is up again', () => {
    for (const away of ['knocked', 'swimming', 'paused'] as const) {
      const c = person(5);
      const cv = new CrowdView();
      for (let i = 0; i < 30; i++) cv.sync([c], 0, 0, 1 / 60);
      const still = headTurn(cv, c);
      if (away === 'paused') {
        c.heading += 2;
        cv.sync([c], 0, 0, 0);
      } else {
        c.state = away;
        for (let i = 0; i < 30; i++) {
          c.heading += 0.05;
          cv.sync([c], 0, 0, 1 / 60);
        }
        c.state = 'normal';
      }
      // Up again, every frame drawn upright (from lying the body comes up over a few) his head faces where his hips do. (The glance of someone
      // standing about moves a little in between.)
      let worst = 0;
      for (let i = 0; i < 30; i++) {
        cv.sync([c], 0, 0, 1 / 60);
        const f = new THREE.Vector3(0, 0, 1).transformDirection(matrixAt(parts(cv).head!, 0));
        if (Math.abs(f.y) < 0.2) worst = Math.max(worst, Math.abs(wrapAngle(headTurn(cv, c) - still)));
      }
      expect(worst, away).toBeLessThan(0.05);
    }
  });

  it('putting a gun away mid-turn, the lean comes back over a few frames, not in one', () => {
    const c = person(3);
    c.inventory.give('pistol', 30);
    c.inventory.current = 'pistol';
    const cv = new CrowdView();
    walk(c, 4.3, 0.25, () => {}, cv);
    const bank = () => local(c, new THREE.Vector3().setFromMatrixColumn(matrixAt(parts(cv).torso!, 0), 1).add(c.pos)).x;
    let worst = 0;
    let was = NaN;
    for (let i = 0; i < 60; i++) {
      if (i === 10) c.inventory.current = 'fists';
      c.heading += 9 / 240;
      c.moveX = Math.sin(c.heading);
      c.moveZ = Math.cos(c.heading);
      stepCharacter(c, 1 / 240, flat);
      cv.sync([c], c.pos.x, c.pos.z, 1 / 240);
      const now = bank();
      if (i > 10) worst = Math.max(worst, Math.abs(now - was));
      was = now;
    }
    expect(was).toBeGreaterThan(0.05);
    expect(worst).toBeLessThan(0.01);
  });
});
