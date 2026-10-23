// Round 2, characters cluster: the jointed rig and its planted-foot gait, the action poses, the muzzle at
// the drawn barrel tip, and drivers and passengers drawn in their seats. CrowdView runs headless with the
// canvas and WebGL stubs of fix_render.test.ts (copied: vi.mock cannot be shared between files).

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CameraController, chaseOffset, CHASE_TARGET_Y } from '../../src/render/camera';
import { CrowdView, OCCUPANT_RANGE } from '../../src/render/crowd';
import { gait, makeGaitOut, makeTwoBone, solveTwoBone } from '../../src/render/gait';
import { cabinLayout, VehicleView } from '../../src/render/vehicleView';
import { makeBrain } from '../../src/sim/brains';
import { stepCharacter, SWIM_FLOAT, type CharacterPhysicsHost } from '../../src/sim/characterPhysics';
import { Character, type Appearance, type Vehicle } from '../../src/sim/entities';
import { strideLength, weaponPose, WEAPON_POINTS } from '../../src/sim/pose';
import type { Sim } from '../../src/sim/sim';
import { VEHICLE_SPECS, type VehicleKind, type WeaponId } from '../../src/sim/specs';
import { WATER_Y } from '../../src/world/constants';
import type { StaticWorld } from '../../src/world/staticWorld';
import { makeSim, world } from './helpers';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  const ctx2d = (): unknown => {
    const store: Record<string | symbol, unknown> = {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      measureText: () => ({ width: 100 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
    // Every other 2D call is a no-op; property writes are kept.
    return new Proxy(store, {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: (o, k, v) => {
        o[k] = v;
        return true;
      },
    });
  };
  const canvas = (): Record<string, unknown> => ({
    width: 300,
    height: 150,
    clientWidth: 1280,
    clientHeight: 720,
    style: {},
    getContext: (kind: string) => (kind === '2d' ? ctx2d() : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    readonly domElement: unknown;
    readonly info = { autoReset: true, reset: () => {}, render: { calls: 0, triangles: 0 }, programs: [] as unknown[], memory: { geometries: 0, textures: 0 } };
    readonly shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas;
    }
    setPixelRatio(): void {}
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    setEffects(): void {}
    compile(): void {}
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

type Part = { mesh: THREE.InstancedMesh; n: number };
type Gun = Exclude<WeaponId, 'fists'>;
const GUNS: Gun[] = ['pistol', 'smg', 'shotgun', 'rifle', 'rocket'];

function parts(cv: CrowdView): Record<string, Part> {
  return (cv as unknown as { parts: Record<string, Part> }).parts;
}

function weaponPart(cv: CrowdView, id: Gun): Part {
  return (cv as unknown as { weapons: Map<WeaponId, Part> }).weapons.get(id)!;
}

function matrixAt(p: Part, i: number): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  p.mesh.getMatrixAt(i, m);
  return m;
}

function all(p: Part): THREE.Matrix4[] {
  return Array.from({ length: p.mesh.count }, (_, i) => matrixAt(p, i));
}

function origin(m: THREE.Matrix4): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixPosition(m);
}

/** Unit long axis (local +y) of a limb box. */
function axis(m: THREE.Matrix4): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
}

/** Centroid of a geometry's vertices on its front (max z) or back (min z) face, in its own frame. */
function faceCentre(geo: THREE.BufferGeometry, front: boolean): THREE.Vector3 {
  const pos = geo.getAttribute('position');
  let ext = front ? -Infinity : Infinity;
  for (let i = 0; i < pos.count; i++) ext = front ? Math.max(ext, pos.getZ(i)) : Math.min(ext, pos.getZ(i));
  const c = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getZ(i) - ext) > 1e-6) continue;
    c.x += pos.getX(i);
    c.y += pos.getY(i);
    c.z += pos.getZ(i);
    n++;
  }
  return c.divideScalar(n);
}

/** (x left, y up, z forward) of a world point relative to a character and its heading. */
function local(c: Character, p: THREE.Vector3): THREE.Vector3 {
  const dx = p.x - c.pos.x;
  const dz = p.z - c.pos.z;
  const h = c.heading;
  return new THREE.Vector3(dx * Math.cos(h) - dz * Math.sin(h), p.y - c.pos.y, dx * Math.sin(h) + dz * Math.cos(h));
}

const LOOK: Appearance = { skin: 0xc68642, shirt: 0x2a2c33, pants: 0x34557f, hair: 0x15110e, hat: 0, height: 1, build: 1 };

function person(id = 1, role: 'civilian' | 'player' = 'civilian'): Character {
  return new Character(id, role, 0, 0, 0, { ...LOOK });
}

/** Flat, endless ground for stepping one character's physics. */
const flat: CharacterPhysicsHost = {
  world: { groundHeight: () => 0, bounds: { worldMinX: -1e5, worldMaxX: 1e5, worldMinZ: -1e5, worldMaxZ: 1e5 } } as unknown as StaticWorld,
  onCharacterHitByVehicle: () => {},
  onCharacterLanded: () => {},
  onCharacterSplash: () => {},
};

/** Bottom corners and bottom-face centre of the shoe box, in its own frame. */
const SOLE = [-0.075, 0.075].flatMap((x) => [-0.07, 0.19].map((z) => new THREE.Vector3(x, -0.075, z)));
const SOLE_MID = new THREE.Vector3(0, -0.075, 0.06);

function soleLow(m: THREE.Matrix4): number {
  return Math.min(...SOLE.map((p) => p.clone().applyMatrix4(m).y));
}

/** Walks `c` (heading 0) at `speed` along (mx, mz) on flat ground, sampling the drawn rig at 240 Hz for 2 s after 1 s to settle. */
function walkSamples(speed: number, mx: number, mz: number, aiming: boolean, sample: (cv: CrowdView, c: Character) => void): void {
  const cv = new CrowdView();
  const c = person();
  c.aiming = aiming;
  c.aimYaw = 0;
  c.moveX = mx;
  c.moveZ = mz;
  c.moveSpeed = speed;
  const dt = 1 / 240;
  for (let i = 0; i < 720; i++) {
    stepCharacter(c, dt, flat);
    cv.sync([c], c.pos.x, c.pos.z, dt);
    if (i >= 240) sample(cv, c);
  }
}

/** A sim with one character on open ground (no one else within reach of its weapon). */
function lone(): { sim: Sim; c: Character } {
  const sim = makeSim({ world: world() });
  const b = sim.world.layout.bounds;
  const c = sim.spawnCharacter('gang', b.beachStartX + 30, (b.landMinZ + b.landMaxZ) / 2);
  c.brain = null;
  c.heading = 0.7;
  c.aimYaw = 0.7;
  return { sim, c };
}

function finiteMatrices(cv: CrowdView): boolean {
  const ps = [...Object.values(parts(cv)), ...GUNS.map((g) => weaponPart(cv, g))];
  return ps.every((p) => all(p).every((m) => m.elements.every(Number.isFinite)));
}

describe('jointed rig and planted-foot gait', () => {
  it.each([
    [1.9, 0.7, 0.35],
    [4.3, 0.7, 1.0],
    [7.4, 0.45, 1.0],
  ])('at %f m/s a sole is on the ground at least %f of the time, never below it, and the planted foot does not slide', (speed, minContact, maxSlide) => {
    let samples = 0;
    let contact = 0;
    let lowest = Infinity;
    let slide = 0;
    let slideN = 0;
    const last: Array<THREE.Vector3 | null> = [null, null];
    walkSamples(speed, 0, 1, false, (cv) => {
      const shoe = parts(cv).shoe!;
      expect(shoe.mesh.count).toBe(2);
      const ms = [matrixAt(shoe, 0), matrixAt(shoe, 1)];
      const lows = ms.map(soleLow);
      const mids = ms.map((m) => SOLE_MID.clone().applyMatrix4(m));
      const low = Math.min(lows[0]!, lows[1]!);
      lowest = Math.min(lowest, low);
      samples++;
      if (low <= 0.03) {
        contact++;
        const k = lows[0]! <= lows[1]! ? 0 : 1;
        const prev = last[k];
        if (prev) {
          slide += Math.hypot(mids[k]!.x - prev.x, mids[k]!.z - prev.z) * 240;
          slideN++;
        }
      }
      last[0] = mids[0]!;
      last[1] = mids[1]!;
    });
    expect(contact / samples).toBeGreaterThanOrEqual(minContact);
    expect(lowest).toBeGreaterThan(-0.01);
    expect(slide / slideN).toBeLessThan(maxSlide);
  });

  it('a sprint bends the swing knee past 70 degrees and the elbows past 60, and a jog has a flight phase', () => {
    let knee = 0;
    let elbow = 0;
    walkSamples(7.4, 0, 1, false, (cv) => {
      const p = parts(cv);
      for (let i = 0; i < 2; i++) {
        knee = Math.max(knee, axis(matrixAt(p.thigh!, i)).angleTo(axis(matrixAt(p.shin!, i))));
        elbow = Math.max(elbow, axis(matrixAt(p.upperArm!, i)).angleTo(axis(matrixAt(p.forearm!, i))));
      }
    });
    expect(knee).toBeGreaterThan((70 * Math.PI) / 180);
    expect(elbow).toBeGreaterThan((60 * Math.PI) / 180);
    // Both feet off the ground at times when jogging, never both at a walk (no scissor split in the air).
    let airborne = 0;
    walkSamples(4.3, 0, 1, false, (cv) => {
      const shoe = parts(cv).shoe!;
      if (Math.min(soleLow(matrixAt(shoe, 0)), soleLow(matrixAt(shoe, 1))) > 0.03) airborne++;
    });
    expect(airborne).toBeGreaterThan(0);
  });

  it('aimed sideways steps swing the legs sideways, and backpedalling keeps the planted foot in place', () => {
    const range = { x: [Infinity, -Infinity], z: [Infinity, -Infinity] };
    walkSamples(2.8, 1, 0, true, (cv, c) => {
      expect(c.heading).toBe(0);
      for (let i = 0; i < 2; i++) {
        const m = SOLE_MID.clone().applyMatrix4(matrixAt(parts(cv).shoe!, i)).sub(new THREE.Vector3(c.pos.x, 0, c.pos.z));
        range.x = [Math.min(range.x[0]!, m.x), Math.max(range.x[1]!, m.x)];
        range.z = [Math.min(range.z[0]!, m.z), Math.max(range.z[1]!, m.z)];
      }
    });
    expect(range.x[1]! - range.x[0]!).toBeGreaterThan(1.5 * (range.z[1]! - range.z[0]!));
    // Backwards: the phase runs the stance the other way, so the planted foot stays put.
    let slide = 0;
    let n = 0;
    let last: THREE.Vector3 | null = null;
    let lastK = -1;
    walkSamples(2.8, 0, -1, true, (cv) => {
      const shoe = parts(cv).shoe!;
      const lows = [soleLow(matrixAt(shoe, 0)), soleLow(matrixAt(shoe, 1))];
      const k = lows[0]! <= lows[1]! ? 0 : 1;
      const mid = SOLE_MID.clone().applyMatrix4(matrixAt(shoe, k));
      if (last && lastK === k && lows[k]! <= 0.03) {
        slide += Math.hypot(mid.x - last.x, mid.z - last.z) * 240;
        n++;
      }
      last = mid;
      lastK = k;
    });
    expect(slide / n).toBeLessThan(0.35);
  });

  it('the gait phase advances one cycle per stride and holds while standing', () => {
    for (const speed of [1.45, 3, 4.3, 7.4]) {
      const c = person();
      c.moveZ = 1;
      c.moveSpeed = speed;
      for (let i = 0; i < 240; i++) stepCharacter(c, 1 / 240, flat);
      const z0 = c.pos.z;
      const p0 = c.animPhase;
      for (let i = 0; i < 480; i++) stepCharacter(c, 1 / 240, flat);
      expect((c.animPhase - p0) / (2 * Math.PI)).toBeCloseTo((c.pos.z - z0) / strideLength(speed), 3);
    }
    const still = person();
    still.animPhase = 1.234;
    for (let i = 0; i < 60; i++) stepCharacter(still, 1 / 60, flat);
    expect(still.animPhase).toBe(1.234);
  });

  it('a corpse lies with its arms relaxed at its sides one second after death, not in a T', () => {
    const { sim, c } = lone();
    const cv = new CrowdView();
    sim.combat.kill(c, null, 'bullet', 0, 0);
    for (let i = 0; i < 60; i++) cv.sync([c], c.pos.x, c.pos.z, 1 / 60);
    const p = parts(cv);
    const down = axis(matrixAt(p.torso!, 0)).negate();
    expect(p.upperArm!.mesh.count).toBe(2);
    for (let i = 0; i < 2; i++) {
      const arm = axis(matrixAt(p.upperArm!, i)).negate();
      expect(arm.angleTo(down)).toBeLessThan(1.0);
    }
    // Lying on the ground, the torso near horizontal.
    expect(Math.abs(axis(matrixAt(p.torso!, 0)).y)).toBeLessThan(0.2);
    expect(finiteMatrices(cv)).toBe(true);
  });

  it('the gait and the two-bone IK stay finite for every speed, phase, direction and degenerate target', () => {
    const out = makeGaitOut();
    const nums = (o: unknown): number[] => (typeof o === 'number' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(nums) : []);
    for (let v = 0; v <= 12; v += 0.25) {
      for (let k = 0; k < 24; k++) {
        for (const strafe of [0, 0.8, Math.PI / 2, 2.4, Math.PI, -Math.PI / 2]) {
          for (const scale of [0.9, 1, 1.07]) {
            gait((k / 24) * 2 * Math.PI, v, strafe, out, scale, 1.1);
            const values = nums({ hipY: out.hipY, chestYaw: out.chestYaw, lean: out.lean, legs: out.legs, arms: out.arms });
            expect(values.length).toBeGreaterThan(30);
            expect(values.every(Number.isFinite)).toBe(true);
          }
        }
      }
    }
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      gait(bad, bad, bad, out);
      expect([out.hipY, ...out.legs.flatMap((l) => [l.knee.x, l.knee.y, l.knee.z, l.kneeFlex])].every(Number.isFinite)).toBe(true);
    }
    const ik = makeTwoBone();
    const cases: number[][] = [
      [0, 0, 0, 0, 0, 0, 0, 0, 1], // target on the root
      [0, 0, 0, 0, -0.5, 0, 0, -1, 0], // pole along the chain
      [0, 0, 0, 5, 3, -2, 0, 0, 1], // far out of reach
      [0, 0, 0, 0.001, 0, 0, 0, 0, 0], // folded, no pole
      [0, 0, 0, Number.NaN, 0, 0, 0, 0, 1],
      [0, 0, 0, 0, -0.6, 0.2, Number.NaN, 0, Infinity],
    ];
    for (const [rx, ry, rz, tx, ty, tz, px, py, pz] of cases) {
      solveTwoBone(rx!, ry!, rz!, tx!, ty!, tz!, 0.43, 0.39, px!, py!, pz!, ik);
      expect([ik.mx, ik.my, ik.mz, ik.ex, ik.ey, ik.ez].every(Number.isFinite)).toBe(true);
      // Bone lengths are kept whatever the target.
      expect(Math.hypot(ik.mx - rx!, ik.my - ry!, ik.mz - rz!)).toBeCloseTo(0.43, 6);
      expect(Math.hypot(ik.ex - ik.mx, ik.ey - ik.my, ik.ez - ik.mz)).toBeCloseTo(0.39, 6);
    }
    // In reach, the chain ends exactly on the target with the knee bent towards the pole.
    solveTwoBone(0, 0.86, 0, 0.1, 0.1, 0.2, 0.43, 0.39, 0, 0, 1, ik);
    expect(ik.reached).toBe(true);
    expect(Math.hypot(ik.ex - 0.1, ik.ey - 0.1, ik.ez - 0.2)).toBeLessThan(1e-9);
    expect(ik.mz).toBeGreaterThan(0.2);
  });

  it('every state is drawn with finite matrices: standing, walking, jumping, knocked, swimming, climbing in, cowering', () => {
    const { sim, c } = lone();
    const cv = new CrowdView();
    const states: Array<(c: Character) => void> = [
      () => {},
      (x) => { x.speed = 3; x.vel.x = 3; x.animPhase = 2; },
      (x) => { x.onGround = false; x.vel.y = 4; },
      (x) => { x.onGround = true; x.state = 'knocked'; },
      (x) => { x.state = 'swimming'; x.speed = 2; },
      (x) => { x.state = 'swimming'; x.speed = 0; },
      (x) => { x.state = 'entering'; },
      (x) => { x.state = 'normal'; x.brain = makeBrain('cower'); },
      (x) => { x.brain = null; x.inventory.give('rifle', 30); x.inventory.current = 'rifle'; x.aiming = true; x.aimPitch = 1.3; },
    ];
    for (const set of states) {
      set(c);
      for (let i = 0; i < 20; i++) cv.sync([c], c.pos.x, c.pos.z, 1 / 60);
      expect(finiteMatrices(cv)).toBe(true);
      expect(parts(cv).torso!.mesh.count).toBe(1);
    }
    expect(sim.player.removed).toBe(false);
  });
});

/** Draws one upright character standing still, after letting the pose settle. */
function drawn(c: Character, others: Character[] = []): CrowdView {
  const cv = new CrowdView();
  for (let i = 0; i < 30; i++) cv.sync([c, ...others], c.pos.x, c.pos.z, 1 / 60);
  return cv;
}

/**
 * The left and right shoulder joints and hand centres of the only character drawn. Each arm writes its
 * upper arm and hand at the same instance index; the shoulders tell the sides apart.
 */
function arms(cv: CrowdView, c: Character): { hands: { left: THREE.Vector3; right: THREE.Vector3 }; shoulders: { left: THREE.Vector3; right: THREE.Vector3 } } {
  const p = parts(cv);
  expect(p.upperArm!.mesh.count).toBe(2);
  expect(p.hand!.mesh.count).toBe(2);
  const sh = all(p.upperArm!).map(origin);
  const hd = all(p.hand!).map(origin);
  const l = local(c, sh[0]!).x > local(c, sh[1]!).x ? 0 : 1;
  return { hands: { left: hd[l]!, right: hd[1 - l]! }, shoulders: { left: sh[l]!, right: sh[1 - l]! } };
}

describe('action poses', () => {
  function armed(w: Gun): { sim: Sim; c: Character } {
    const r = lone();
    r.c.inventory.give(w, 200);
    r.c.inventory.current = w;
    return r;
  }

  it('a cowering ped crouches with both hands over the head; one held at gunpoint stands with its hands up', () => {
    const { sim, c } = lone();
    const standing = drawn(c);
    const headStand = new THREE.Vector3(0, 0.15, 0).applyMatrix4(matrixAt(parts(standing).head!, 0)).y - c.pos.y;
    c.brain = makeBrain('cower');
    const cv = drawn(c);
    const head = new THREE.Vector3(0, 0.15, 0).applyMatrix4(matrixAt(parts(cv).head!, 0)).y - c.pos.y;
    const { hands, shoulders } = arms(cv, c);
    expect(head).toBeLessThan(1.2);
    expect(hands.left.y).toBeGreaterThan(shoulders.left.y);
    expect(hands.right.y).toBeGreaterThan(shoulders.right.y);
    // The player points a gun at him: hands up, standing.
    const p = sim.player;
    p.pos.x = c.pos.x - Math.sin(0.3) * 5;
    p.pos.z = c.pos.z - Math.cos(0.3) * 5;
    p.inventory.give('pistol', 20);
    p.inventory.current = 'pistol';
    p.aiming = true;
    p.aimYaw = 0.3;
    p.heading = 0.3;
    c.brain.threat = null;
    const up = new CrowdView();
    for (let i = 0; i < 30; i++) up.sync([p, c], c.pos.x, c.pos.z, 1 / 60, p.id);
    const heads = all(parts(up).head!).map((m) => new THREE.Vector3(0, 0.15, 0).applyMatrix4(m));
    const pedHead = heads.reduce((a, b) => (a.distanceTo(new THREE.Vector3(c.pos.x, a.y, c.pos.z)) < b.distanceTo(new THREE.Vector3(c.pos.x, b.y, c.pos.z)) ? a : b));
    expect(pedHead.y - c.pos.y).toBeGreaterThan(headStand - 0.15);
    const pedHands = all(parts(up).hand!).map(origin).filter((h) => Math.hypot(h.x - c.pos.x, h.z - c.pos.z) < 0.8);
    expect(pedHands.length).toBe(2);
    for (const h of pedHands) expect(h.y).toBeGreaterThan(pedHead.y);
    // Not aimed at (the player looks away): back to the crouch.
    p.aimYaw = 0.3 + Math.PI / 2;
    for (let i = 0; i < 5; i++) up.sync([p, c], c.pos.x, c.pos.z, 1 / 60, p.id);
    const crouched = all(parts(up).head!).map((m) => new THREE.Vector3(0, 0.15, 0).applyMatrix4(m).y - c.pos.y);
    expect(Math.min(...crouched)).toBeLessThan(1.2);
  });

  it.each([
    ['pistol', 0.08],
    ['shotgun', 0.2],
  ] as const)('a %s shot kicks the muzzle up by at least %f rad', (w, kick) => {
    const { c } = armed(w);
    c.aiming = true;
    c.aimPitch = 0;
    const pitch = (cv: CrowdView) => Math.asin(new THREE.Vector3().setFromMatrixColumn(matrixAt(weaponPart(cv, w), 0), 2).normalize().y);
    const still = pitch(drawn(c));
    c.shotTimer = 0.06;
    const cv = new CrowdView();
    cv.sync([c], c.pos.x, c.pos.z, 1 / 60);
    expect(pitch(cv) - still).toBeGreaterThanOrEqual(kick);
  });

  it.each(['pistol', 'smg', 'rifle', 'shotgun'] as const)('reloading the %s brings the off hand to the weapon, aiming or not', (w) => {
    const { c } = armed(w);
    const torsoYaw = (cv: CrowdView) => {
      const f = new THREE.Vector3(0, 0, 1).transformDirection(matrixAt(parts(cv).torso!, 0));
      return Math.atan2(f.x, f.z);
    };
    c.aiming = true;
    const stance = torsoYaw(drawn(c));
    for (const aim of [false, true]) {
      c.aiming = aim;
      c.reloadTimer = 1;
      c.reloadWeapon = w;
      const cv = drawn(c);
      const wm = matrixAt(weaponPart(cv, w), 0);
      const geo = weaponPart(cv, w).mesh.geometry;
      geo.computeBoundingBox();
      const { hands } = arms(cv, c);
      const inWeapon = hands.left.clone().applyMatrix4(wm.clone().invert());
      expect(geo.boundingBox!.distanceToPoint(inWeapon)).toBeLessThan(0.15);
      // Lowered and tilted compared with aiming.
      const dir = new THREE.Vector3().setFromMatrixColumn(wm, 2).normalize();
      expect(Math.asin(dir.y)).toBeLessThan(-0.3);
      // Aiming through a reload keeps the stance: the torso does not swing round.
      if (aim) expect(Math.abs(torsoYaw(cv) - stance)).toBeLessThan(0.05);
    }
    c.reloadTimer = 0;
  });

  it.each(['rifle', 'shotgun', 'smg'] as const)('aiming the %s puts its stock in the right shoulder and the left hand on the forend', (w) => {
    const { c } = armed(w);
    c.aiming = true;
    for (const pitch of [-0.5, 0, 0.6]) {
      c.aimPitch = pitch;
      const cv = drawn(c);
      const wm = matrixAt(weaponPart(cv, w), 0);
      const stock = faceCentre(weaponPart(cv, w).mesh.geometry, false).applyMatrix4(wm);
      const { hands, shoulders } = arms(cv, c);
      expect(stock.distanceTo(shoulders.right)).toBeLessThan(0.12);
      const fore = new THREE.Vector3(WEAPON_POINTS[w].fore.x, WEAPON_POINTS[w].fore.y, WEAPON_POINTS[w].fore.z).applyMatrix4(wm);
      expect(hands.left.distanceTo(fore)).toBeLessThan(0.1);
      const grip = new THREE.Vector3(WEAPON_POINTS[w].grip.x, WEAPON_POINTS[w].grip.y, WEAPON_POINTS[w].grip.z).applyMatrix4(wm);
      expect(hands.right.distanceTo(grip)).toBeLessThan(0.1);
    }
  });

  it('the rocket launcher rests on the right shoulder, the tube centre above it', () => {
    const { c } = armed('rocket');
    c.aiming = true;
    for (const pitch of [-0.4, 0, 0.5]) {
      c.aimPitch = pitch;
      const cv = drawn(c);
      const tube = new THREE.Vector3(0, 0.08, 0.2).applyMatrix4(matrixAt(weaponPart(cv, 'rocket'), 0));
      const { shoulders } = arms(cv, c);
      expect(tube.y).toBeGreaterThan(shoulders.right.y);
      expect(local(c, tube).x).toBeLessThan(0);
    }
  });

  it('punches thrown through combat go right jab, left jab, right hook, each with its own arm pose', () => {
    const { sim, c } = lone();
    // Each punch drawn at its peak, after CombatSystem.melee has counted the combo on.
    const poses: number[][] = [];
    const reach: Array<{ left: number; right: number; twist: number }> = [];
    for (let k = 0; k < 4; k++) {
      c.fireCooldown = 0;
      sim.combat.melee(c);
      c.punchTimer = 0.16;
      const cv = drawn(c);
      const { hands } = arms(cv, c);
      const f = new THREE.Vector3(0, 0, 1).transformDirection(matrixAt(parts(cv).torso!, 0));
      reach.push({ left: local(c, hands.left).z, right: local(c, hands.right).z, twist: Math.atan2(f.x, f.z) - c.heading });
      poses.push([...all(parts(cv).upperArm!), ...all(parts(cv).forearm!)].flatMap((m) => m.elements));
    }
    // meleeCombo 0 (the first punch) and 1 extend different hands.
    expect(reach[0]!.right).toBeGreaterThan(reach[0]!.left + 0.2);
    expect(reach[1]!.left).toBeGreaterThan(reach[1]!.right + 0.2);
    // The hook turns the shoulders through to the left, more than either jab.
    expect(reach[2]!.twist).toBeGreaterThan(0.35);
    expect(Math.abs(reach[0]!.twist)).toBeLessThan(0.25);
    const differ = (a: number[], b: number[]) => a.some((x, i) => Math.abs(x - b[i]!) > 0.05);
    expect(differ(poses[0]!, poses[1]!)).toBe(true);
    expect(differ(poses[1]!, poses[2]!)).toBe(true);
    expect(differ(poses[0]!, poses[2]!)).toBe(true);
    // The fourth starts the combo again.
    expect(differ(poses[0]!, poses[3]!)).toBe(false);
  });
});

describe('the muzzle is the drawn barrel tip', () => {
  it.each(GUNS)('%s: combat fires from weaponPose().tip, the end of the drawn barrel, at any aim pitch, lowered or reloading', (w) => {
    const { sim, c } = lone();
    c.inventory.give(w, 200);
    c.inventory.current = w;
    const check = () => {
      const m = sim.combat.muzzle(c, false);
      const tip = weaponPose(c).tip;
      expect(Math.hypot(m.x - tip.x, m.y - tip.y, m.z - tip.z)).toBeLessThan(1e-6);
      const cv = drawn(c);
      const part = weaponPart(cv, w);
      expect(part.mesh.count).toBe(1);
      const end = faceCentre(part.mesh.geometry, true).applyMatrix4(matrixAt(part, 0));
      expect(end.distanceTo(new THREE.Vector3(m.x, m.y, m.z))).toBeLessThan(0.05);
      return m;
    };
    c.aiming = true;
    const tips = [-0.5, 0, 0.6].map((pitch) => {
      c.aimPitch = pitch;
      return check();
    });
    // The barrel tip follows the aim up and down.
    expect(tips[0]!.y).toBeLessThan(tips[1]!.y);
    expect(tips[2]!.y).toBeGreaterThan(tips[1]!.y);
    c.aiming = false;
    check();
    if (w !== 'rocket') {
      c.reloadTimer = 1;
      c.reloadWeapon = w;
      check();
    }
  });

  it.each([
    ['pistol', true, 2.8],
    ['rifle', true, 4.3],
    ['rifle', false, 4.3],
    ['shotgun', false, 7.4],
  ] as const)('the drawn %s barrel stays on the simulated tip while walking (aiming %s, %f m/s)', (w, aim, speed) => {
    const cv = new CrowdView();
    const c = person();
    c.inventory.give(w, 100);
    c.inventory.current = w;
    c.aiming = aim;
    c.moveX = 0.3;
    c.moveZ = 1;
    c.moveSpeed = speed;
    const dt = 1 / 120;
    let worst = 0;
    let travel = 0;
    let prev: THREE.Vector3 | null = null;
    for (let i = 0; i < 360; i++) {
      stepCharacter(c, dt, flat);
      if (aim) c.aimYaw = c.heading = Math.atan2(c.vel.x, c.vel.z) - 0.3;
      cv.sync([c], c.pos.x, c.pos.z, dt);
      if (i < 180) continue;
      const part = weaponPart(cv, w);
      const end = faceCentre(part.mesh.geometry, true).applyMatrix4(matrixAt(part, 0));
      const tip = weaponPose(c).tip;
      worst = Math.max(worst, end.distanceTo(new THREE.Vector3(tip.x, tip.y, tip.z)));
      // The tip really moves with the stride (bob and counter-twist), so the match is not trivial.
      const rel = new THREE.Vector3(tip.x - c.pos.x, tip.y - c.pos.y, tip.z - c.pos.z);
      if (prev) travel = Math.max(travel, rel.distanceTo(prev));
      prev = rel;
    }
    expect(worst).toBeLessThan(0.01);
    expect(travel).toBeGreaterThan(1e-4);
  });

  it('the tip is where the aim points: ahead of the shooter and turning with the aim yaw', () => {
    const { sim, c } = lone();
    c.inventory.give('pistol', 20);
    c.inventory.current = 'pistol';
    c.aiming = true;
    for (const yaw of [0, 1, 2.5, -2]) {
      c.aimYaw = yaw;
      c.heading = yaw;
      const m = sim.combat.muzzle(c, false);
      const l = local(c, new THREE.Vector3(m.x, m.y, m.z));
      expect(l.z).toBeGreaterThan(0.45);
      expect(Math.abs(l.x)).toBeLessThan(0.15);
      expect(l.y).toBeGreaterThan(1.2);
    }
  });

  it('point blank, with someone nearer than the barrel reaches, the shot leaves from the chest instead', () => {
    const { sim, c } = lone();
    c.inventory.give('shotgun', 20);
    c.inventory.current = 'shotgun';
    c.aiming = true;
    const tip = weaponPose(c).tip;
    expect(sim.combat.muzzle(c, false)).toEqual(tip);
    const fx = Math.sin(c.aimYaw);
    const fz = Math.cos(c.aimYaw);
    const other = sim.spawnCharacter('civilian', c.pos.x + fx * 1.15, c.pos.z + fz * 1.15);
    const m = sim.combat.muzzle(c, false);
    expect(Math.hypot(m.x - tip.x, m.z - tip.z)).toBeGreaterThan(0.3);
    expect(local(c, new THREE.Vector3(m.x, m.y, m.z)).z).toBeCloseTo(0.55, 5);
    // Behind the shooter, or lying on the ground, he does not crowd the barrel.
    other.pos.x = c.pos.x - fx * 1.15;
    other.pos.z = c.pos.z - fz * 1.15;
    expect(sim.combat.muzzle(c, false)).toEqual(tip);
    other.pos.x = c.pos.x + fx * 1.15;
    other.pos.z = c.pos.z + fz * 1.15;
    other.state = 'dead';
    expect(sim.combat.muzzle(c, false)).toEqual(tip);
    // Standing beside him, clear of the barrel, a bystander does not move the muzzle either.
    other.state = 'normal';
    other.pos.x = c.pos.x + fx * 0.1 - fz * 1.2;
    other.pos.z = c.pos.z + fz * 0.1 + fx * 1.2;
    expect(sim.combat.muzzle(c, false)).toEqual(tip);
    // ...while someone at the crosshair's point-blank spot, on the shoulder camera's line 0.62 m to the right, does.
    other.pos.x = c.pos.x + fx * 0.65 - fz * 0.62;
    other.pos.z = c.pos.z + fz * 0.65 + fx * 0.62;
    expect(sim.combat.muzzle(c, false)).not.toEqual(tip);
  });
});

describe('drivers and passengers', () => {
  /** The cabin: the glasshouse's footprint from the floor up to its roof, in the view's own frame. */
  function cabinBox(view: VehicleView, v: Vehicle): THREE.Box3 {
    const cab = ((view as unknown as { cabin?: THREE.Mesh }).cabin ?? view.group.getObjectByName('glass')) as THREE.Mesh;
    cab.geometry.computeBoundingBox();
    const b = cab.geometry.boundingBox!.clone();
    b.min.y = 0.2;
    expect(b.max.y).toBeGreaterThan(v.spec.height * 0.9);
    return b;
  }

  function sedanWithTwo(): { sim: Sim; v: Vehicle; driver: Character; passenger: Character } {
    const sim = makeSim({ world: world() });
    const b = sim.world.layout.bounds;
    const v = sim.spawnVehicle('sedan', b.beachStartX + 30, (b.landMinZ + b.landMaxZ) / 2, 0.3);
    const driver = sim.spawnCharacter('civilian', v.pos.x, v.pos.z);
    const passenger = sim.spawnCharacter('civilian', v.pos.x, v.pos.z);
    sim.seat(driver, v, 0);
    sim.seat(passenger, v, 1);
    return { sim, v, driver, passenger };
  }

  /** Torso and head centres, in the vehicle view's frame. */
  function seatedPoints(cv: CrowdView, view: VehicleView): THREE.Vector3[] {
    view.group.updateMatrixWorld(true);
    const inv = view.group.matrixWorld.clone().invert();
    const p = parts(cv);
    return [
      ...all(p.torso!).map((m) => new THREE.Vector3(0, 0.33, 0).applyMatrix4(m)),
      ...all(p.head!).map((m) => new THREE.Vector3(0, 0.15, 0).applyMatrix4(m)),
    ].map((q) => q.applyMatrix4(inv));
  }

  it('a sedan with a driver and a passenger shows both, seated inside the cabin, and they move with the car', () => {
    const { v, driver, passenger } = sedanWithTwo();
    const view = new VehicleView('sedan');
    view.bind(v);
    view.sync(v, 1 / 60, 0, 0);
    const cv = new CrowdView();
    cv.sync([driver, passenger], v.pos.x + 8, v.pos.z, 1 / 60);
    expect(parts(cv).torso!.mesh.count).toBe(2);
    expect(parts(cv).head!.mesh.count).toBe(2);
    expect(parts(cv).shin!.mesh.count).toBe(0);
    expect(parts(cv).shoe!.mesh.count).toBe(0);
    const box = cabinBox(view, v);
    const before = seatedPoints(cv, view);
    for (const q of before) expect(box.containsPoint(q)).toBe(true);
    // The heads sit above the doors, below the roof; the driver on the left (+x), the passenger on the right.
    const heads = before.slice(2);
    for (const h of heads) {
      expect(h.y).toBeGreaterThan(v.spec.height * 0.64);
      expect(h.y + 0.18).toBeLessThan(box.max.y);
    }
    expect(Math.max(heads[0]!.x, heads[1]!.x)).toBeGreaterThan(0.25);
    expect(Math.min(heads[0]!.x, heads[1]!.x)).toBeLessThan(-0.25);
    // Turned a quarter, rolled 0.3 rad and pitched: the occupants keep their place in the car.
    v.heading += Math.PI / 2;
    v.roll = 0.3;
    v.pitch = -0.12;
    for (const c of [driver, passenger]) c.heading = v.heading;
    view.sync(v, 1 / 60, 0, 0);
    cv.sync([driver, passenger], v.pos.x + 8, v.pos.z, 1 / 60);
    const after = seatedPoints(cv, view);
    // Instance matrices are float32 and the car is ~600 m from the origin: equal to a millimetre.
    for (let i = 0; i < after.length; i++) expect(after[i]!.distanceTo(before[i]!)).toBeLessThan(1e-3);
    // Braking hard dips the body on its springs: the riders go with it, keeping their place in the cabin.
    v.forwardSpeed = 20;
    view.sync(v, 1 / 60, 0, 0);
    for (let i = 0; i < 40; i++) {
      v.forwardSpeed -= 0.3;
      view.sync(v, 1 / 60, 0, 0);
    }
    expect(Math.abs(view.group.rotation.x + v.pitch)).toBeGreaterThan(0.01);
    cv.sync([driver, passenger], v.pos.x + 8, v.pos.z, 1 / 60);
    const leaned = seatedPoints(cv, view);
    for (let i = 0; i < leaned.length; i++) expect(leaned[i]!.distanceTo(before[i]!)).toBeLessThan(1e-3);
  });

  // Cars: bikes and boats have no roof (their riders: w1_vehicle_views.test.ts).
  it.each((Object.keys(VEHICLE_SPECS) as VehicleKind[]).filter((k) => VEHICLE_SPECS[k].class === 'car'))('a %s seats the tallest rider in a cap under its roof, and the shortest with his head in the windows', (kind) => {
    const sim = makeSim({ world: world() });
    const b = sim.world.layout.bounds;
    const v = sim.spawnVehicle(kind, b.beachStartX + 30, (b.landMinZ + b.landMaxZ) / 2, 0.3);
    const view = new VehicleView(kind);
    view.bind(v);
    view.sync(v, 1 / 60, 0, 0);
    view.group.updateMatrixWorld(true);
    const inv = view.group.matrixWorld.clone().invert();
    const cab = ((view as unknown as { cabin?: THREE.Mesh }).cabin ?? view.group.getObjectByName('glass')) as THREE.Mesh;
    cab.geometry.computeBoundingBox();
    const glass = cab.geometry.boundingBox!;
    const seated = (height: number, hat: number): THREE.Matrix4[] => {
      const riders: Character[] = [];
      for (let i = 0; i <= v.passengers.length; i++) {
        const c = sim.spawnCharacter('civilian', v.pos.x, v.pos.z);
        c.appearance.height = height;
        c.appearance.hat = hat;
        sim.seat(c, v, i);
        riders.push(c);
      }
      const cv = new CrowdView();
      cv.sync(riders, v.pos.x, v.pos.z, 1 / 60);
      for (const c of riders) sim.unseat(c);
      return all(parts(cv).head!);
    };
    for (const m of seated(1.07, 0x222222)) {
      const capTop = new THREE.Vector3(0, 0.365, 0).applyMatrix4(m).applyMatrix4(inv);
      expect(capTop.y).toBeLessThan(glass.max.y - 0.01);
    }
    seated(0.9, 0).forEach((m, seat) => {
      const head = new THREE.Vector3(0, 0.15, 0).applyMatrix4(m).applyMatrix4(inv);
      expect(head.y).toBeGreaterThan(glass.min.y + 0.15);
      // The front seats sit by the windows (a SWAT van's rear bench is in its windowless back).
      if (seat > 1) return;
      expect(head.z).toBeGreaterThan(glass.min.z);
      expect(head.z).toBeLessThan(glass.max.z);
    });
  });

  it(`occupants are drawn within ${OCCUPANT_RANGE} m only, never in wrecks or burning cars, and the seated player unless hidden`, () => {
    const { sim, v, driver, passenger } = sedanWithTwo();
    const count = (cv: CrowdView) => parts(cv).head!.mesh.count;
    const cv = new CrowdView();
    cv.sync([driver, passenger], v.pos.x + 61, v.pos.z, 1 / 60);
    expect(count(cv)).toBe(0);
    cv.sync([driver, passenger], v.pos.x + 59, v.pos.z, 1 / 60);
    expect(count(cv)).toBe(2);
    v.burning = true;
    cv.sync([driver, passenger], v.pos.x, v.pos.z, 1 / 60);
    expect(count(cv)).toBe(0);
    v.burning = false;
    v.destroyed = true;
    cv.sync([driver, passenger], v.pos.x, v.pos.z, 1 / 60);
    expect(count(cv)).toBe(0);
    v.destroyed = false;
    // The player at the wheel.
    sim.unseat(driver);
    driver.removed = true;
    sim.seat(sim.player, v, 0);
    cv.sync([sim.player, passenger], v.pos.x, v.pos.z, 1 / 60);
    expect(count(cv)).toBe(2);
    cv.hiddenId = sim.player.id;
    cv.sync([sim.player, passenger], v.pos.x, v.pos.z, 1 / 60);
    expect(count(cv)).toBe(1);
  });

  it('the driver turns the wheel with the steering and a gun shows only while firing from the car', () => {
    const { sim, v, driver, passenger } = sedanWithTwo();
    v.heading = 0;
    const handsLocal = (cv: CrowdView) => {
      const hs = all(parts(cv).hand!).map(origin).map((h) => new THREE.Vector3(h.x - v.pos.x, h.y - v.pos.y, h.z - v.pos.z));
      // Driver's hands: the two nearest the driver's side of the car (+x).
      return hs.sort((a, b) => b.x - a.x).slice(0, 2).sort((a, b) => b.x - a.x);
    };
    const cv = new CrowdView();
    driver.heading = 0;
    v.steer = 0;
    cv.sync([driver], v.pos.x, v.pos.z, 1 / 60);
    const [l0, r0] = handsLocal(cv);
    expect(Math.abs(l0!.y - r0!.y)).toBeLessThan(0.02);
    v.steer = 1;
    cv.sync([driver], v.pos.x, v.pos.z, 1 / 60);
    const [l1, r1] = handsLocal(cv);
    expect(l1!.y - l0!.y).toBeGreaterThan(0.06);
    expect(r1!.y - r0!.y).toBeLessThan(-0.06);
    expect(l1!.distanceTo(l0!)).toBeLessThan(0.13);
    // Holding a pistol: hidden in the car until it fires.
    driver.inventory.give('pistol', 20);
    driver.inventory.current = 'pistol';
    cv.sync([driver], v.pos.x, v.pos.z, 1 / 60);
    expect(weaponPart(cv, 'pistol').mesh.count).toBe(0);
    driver.shotTimer = 0.06;
    driver.aimYaw = Math.PI / 2;
    driver.aimPitch = 0;
    cv.sync([driver], v.pos.x, v.pos.z, 1 / 60);
    expect(weaponPart(cv, 'pistol').mesh.count).toBe(1);
    // Out of the driver's window on the car's left, pointing where he aims, its tip where vehicle shots leave.
    const gun = origin(matrixAt(weaponPart(cv, 'pistol'), 0));
    expect(gun.x - v.pos.x).toBeGreaterThan(v.halfW * 0.6);
    const muzzle = sim.combat.muzzle(driver, true);
    const tip = new THREE.Vector3(0, 0, 0.21).applyMatrix4(matrixAt(weaponPart(cv, 'pistol'), 0));
    expect(tip.distanceTo(new THREE.Vector3(muzzle.x, muzzle.y, muzzle.z))).toBeLessThan(0.08);
    // A passenger on the right shoots out of his own window, not from inside the cabin.
    passenger.inventory.give('pistol', 20);
    passenger.inventory.current = 'pistol';
    passenger.shotTimer = 0.06;
    passenger.aimYaw = -Math.PI / 2;
    passenger.aimPitch = 0;
    driver.shotTimer = 0;
    cv.sync([driver, passenger], v.pos.x, v.pos.z, 1 / 60);
    expect(weaponPart(cv, 'pistol').mesh.count).toBe(1);
    const pgun = origin(matrixAt(weaponPart(cv, 'pistol'), 0));
    expect(pgun.x - v.pos.x).toBeLessThan(-v.halfW * 0.6);
  });
});

// ---------------------------------------------------------------------------
// Round 2 fix pass: one seat frame for the riders CrowdView draws and the interior VehicleView builds (cabinLayout),
// window guns that match the vehicle muzzle, swimming shooters, and standing legs.

/** A DoubleSide stand-in for a view's body mesh (seat backs, dash, wheel, floor, roof and pillars are all in it). */
function bodyOccluder(view: VehicleView): THREE.Mesh {
  view.group.updateMatrixWorld(true);
  const body = view.group.getObjectByName('body') as THREE.Mesh;
  const occ = new THREE.Mesh(body.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  occ.matrixWorld.copy(body.matrixWorld);
  occ.matrixAutoUpdate = false;
  return occ;
}

/** Share of `pts` that `from` sees past the body (the glass is see-through). */
function seenShare(occ: THREE.Mesh, from: THREE.Vector3, pts: THREE.Vector3[]): number {
  const ray = new THREE.Raycaster();
  let n = 0;
  for (const q of pts) {
    const dir = q.clone().sub(from);
    const d = dir.length();
    ray.set(from, dir.normalize());
    ray.far = d - 0.004;
    if (ray.intersectObject(occ, false).length === 0) n++;
  }
  return n / pts.length;
}

/** Points through a drawn head (instance matrix of the head part), up to the hair or cap top. */
function headGrid(m: THREE.Matrix4, hat: boolean): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let x = 0; x <= 4; x++) for (let y = 0; y <= 6; y++) for (let z = 0; z <= 4; z++) pts.push(new THREE.Vector3(-0.11 + 0.055 * x, 0.03 + ((hat ? 0.33 : 0.3) * y) / 6, -0.12 + 0.06 * z).applyMatrix4(m));
  return pts;
}

/** Distance from p to the nearest triangle of a mesh. */
function surfaceDistance(mesh: THREE.Mesh, p: THREE.Vector3): number {
  const pos = mesh.geometry.getAttribute('position');
  const tri = new THREE.Triangle();
  const q = new THREE.Vector3();
  let best = Infinity;
  for (let i = 0; i < pos.count; i += 3) {
    tri.set(
      new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld),
      new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(mesh.matrixWorld),
      new THREE.Vector3().fromBufferAttribute(pos, i + 2).applyMatrix4(mesh.matrixWorld),
    );
    tri.closestPointToPoint(p, q);
    best = Math.min(best, q.distanceTo(p));
  }
  return best;
}

/** A car of `kind` on the open beach, its view synced, with a rider of each look in every seat (look per call). */
function carWithRiders(kind: VehicleKind, look: Partial<Appearance>): { sim: Sim; v: Vehicle; view: VehicleView; riders: Character[]; cv: CrowdView } {
  const sim = makeSim({ world: world() });
  const b = sim.world.layout.bounds;
  const v = sim.spawnVehicle(kind, b.beachStartX + 30, (b.landMinZ + b.landMaxZ) / 2, 0);
  const view = new VehicleView(kind);
  view.bind(v);
  view.sync(v, 1 / 60, 0, 0);
  const riders: Character[] = [];
  for (let i = 0; i < v.spec.seats; i++) {
    const c = sim.spawnCharacter('civilian', v.pos.x, v.pos.z);
    Object.assign(c.appearance, { build: 1.05 }, look);
    sim.seat(c, v, i);
    riders.push(c);
  }
  const cv = new CrowdView();
  cv.sync(riders, v.pos.x, v.pos.z, 1 / 60);
  return { sim, v, view, riders, cv };
}

const SEE_THROUGH: VehicleKind[] = ['compact', 'sedan', 'taxi', 'police', 'sports', 'muscle', 'pickup'];
const LOOKS: Array<Partial<Appearance>> = [{ height: 0.9, hat: 0 }, { height: 1, hat: 0 }, { height: 1.07, hat: 0x222222 }];

describe('one seat frame for riders and car interiors', () => {
  it.each(SEE_THROUGH)('a %s shows every rider whole: no seat back or roof through the head, from the side or the front', (kind) => {
    for (const look of LOOKS) {
      const { v, view, riders, cv } = carWithRiders(kind, look);
      const occ = bodyOccluder(view);
      const heads = all(parts(cv).head!);
      expect(heads.length).toBe(riders.length);
      riders.forEach((c, i) => {
        const pts = headGrid(heads[i]!, look.hat !== 0);
        const centre = new THREE.Vector3(0, 0.15, 0).applyMatrix4(heads[i]!);
        const side = c.seat === 0 || c.seat === 2 ? 1 : -1;
        // Level with the head, 4 m out of his own window, and 4 m ahead of the car.
        const level = seenShare(occ, new THREE.Vector3(v.pos.x + side * 4, centre.y, centre.z), pts);
        expect(level, `${kind} ${look.height} seat ${c.seat} from the side`).toBeGreaterThanOrEqual(0.8);
        if (c.seat < 2) {
          const front = seenShare(occ, new THREE.Vector3(centre.x, centre.y, v.pos.z + v.halfL + 4), pts);
          expect(front, `${kind} ${look.height} seat ${c.seat} from the front`).toBeGreaterThanOrEqual(0.55);
        }
      });
    }
  });

  it.each(SEE_THROUGH)("the player's own head shows through the rear window of a %s from the chase camera, at rest, at speed and zoomed out", (kind) => {
    const { v, view, cv } = carWithRiders(kind, { height: 1.02, hat: 0 });
    const occ = bodyOccluder(view);
    const pts = headGrid(all(parts(cv).head!)[0]!, false);
    const s = v.spec;
    // Where camera.ts settles the chase camera (heading 0: behind is -z).
    for (const [k, far] of [[0, false], [1, false], [0, true]] as const) {
      const cam = chaseOffset(s, k, far);
      const share = seenShare(occ, new THREE.Vector3(v.pos.x, v.pos.y + s.height * CHASE_TARGET_Y + cam.up, v.pos.z - cam.back), pts);
      expect(share, `${kind} ${k ? 'at speed' : far ? 'zoomed out' : 'at rest'}`).toBeGreaterThanOrEqual(0.4);
    }
  });

  it.each(['sedan', 'sports', 'bus'] as const)('chaseOffset is where the real chase camera settles behind a %s', (kind) => {
    const sim = makeSim({ world: world() });
    const b = sim.world.layout.bounds;
    const v = sim.spawnVehicle(kind, b.beachStartX + 30, (b.landMinZ + b.landMaxZ) / 2, 0.6);
    sim.seat(sim.player, v, 0);
    const cc = new CameraController(16 / 9);
    cc.mode = 'play';
    for (const far of [false, true]) {
      cc.zoomLevel = far ? 1 : 0;
      for (let i = 0; i < 600; i++) cc.update(1 / 60, sim, false);
      const cam = chaseOffset(v.spec, 0, far);
      const want = new THREE.Vector3(v.pos.x - Math.sin(v.heading) * cam.back, v.pos.y + v.spec.height * CHASE_TARGET_Y + cam.up, v.pos.z - Math.cos(v.heading) * cam.back);
      expect(cc.camera.position.distanceTo(want), `${kind} ${far ? 'zoomed out' : 'normal'}`).toBeLessThan(0.01);
    }
  });

  it.each(SEE_THROUGH)('the driver of a %s holds the wheel the car draws', (kind) => {
    const { v, view, riders, cv } = carWithRiders(kind, { height: 1, hat: 0 });
    view.group.updateMatrixWorld(true);
    const body = view.group.getObjectByName('body') as THREE.Mesh;
    const hands = all(parts(cv).hand!).map(origin);
    // The driver's two hands are the first two (he is synced first): on the rim, above the cabin floor.
    for (const h of hands.slice(0, 2)) expect(surfaceDistance(body, h), kind).toBeLessThan(0.03);
    const layout = cabinLayout(kind)!;
    for (const h of hands.slice(0, 2)) expect(h.y - v.pos.y).toBeGreaterThan(layout.floor + 0.02);
    // Turning the wheel to either lock moves the hands round the rim, still on it and above the floor.
    for (const steer of [1, -1]) {
      v.steer = steer;
      cv.sync(riders, v.pos.x, v.pos.z, 1 / 60);
      const turned = all(parts(cv).hand!).map(origin).slice(0, 2);
      for (const h of turned) {
        expect(surfaceDistance(body, h)).toBeLessThan(0.03);
        expect(h.y - v.pos.y, `${kind} steer ${steer}`).toBeGreaterThan(layout.floor + 0.02);
      }
      expect(Math.abs(turned[0]!.y - turned[1]!.y)).toBeGreaterThan(0.1);
    }
    v.steer = 0;
  });

  it.each(SEE_THROUGH)('every rider of a %s, short or tall, capped or not, in front or behind, sits with his shoulders over the waistline and his legs inside the car', (kind) => {
    const layout = cabinLayout(kind)!;
    // The player is 1.02 tall. The tallest riders may sink a little lower to keep their heads under the roof, but never
    // so far that their shoulders go under the floor plate.
    for (const look of [...LOOKS, { height: 1.02, hat: 0 }, { height: 1.07, hat: 0 }]) {
      const { v, view, riders, cv } = carWithRiders(kind, look);
      const torsos = all(parts(cv).torso!);
      expect(torsos.length).toBe(riders.length);
      const clear = look.height! <= 1.02 ? 0.03 : 0;
      const label = (seat: number) => `${kind} height ${look.height}${look.hat ? ' capped' : ''} seat ${seat}`;
      riders.forEach((c, i) => {
        const top = new THREE.Vector3(0, 0.67, 0).applyMatrix4(torsos[i]!);
        expect(top.y - v.pos.y - layout.floor, label(c.seat)).toBeGreaterThanOrEqual(clear);
      });
      // Seated low enough for the head, a rider still keeps his thighs over the car's floor pan, not out under it.
      const body = view.group.getObjectByName('body') as THREE.Mesh;
      body.geometry.computeBoundingBox();
      const pan = v.pos.y + body.geometry.boundingBox!.min.y;
      const corner = new THREE.Vector3();
      all(parts(cv).thigh!).forEach((m, k) => {
        let low = Infinity;
        for (const x of [-0.085, 0.085]) for (const y of [-0.455, 0.035]) for (const z of [-0.085, 0.095]) low = Math.min(low, corner.set(x, y, z).applyMatrix4(m).y);
        expect(low, label(riders[k >> 1]!.seat)).toBeGreaterThanOrEqual(pan - 0.005);
      });
    }
  });

  it('nobody is drawn inside a van, a riot van or a bus, whose dark windows show nothing; a gun fired out of one is', () => {
    for (const kind of ['van', 'swat', 'bus'] as const) {
      const { riders, cv } = carWithRiders(kind, { height: 1, hat: 0 });
      expect(riders.length).toBeGreaterThan(0);
      expect(parts(cv).head!.mesh.count, kind).toBe(0);
      expect(parts(cv).torso!.mesh.count, kind).toBe(0);
      expect(parts(cv).hand!.mesh.count, kind).toBe(0);
      expect(cabinLayout(kind)).toBeNull();
    }
    const { v, riders, cv } = carWithRiders('swat', { height: 1, hat: 0x111111 });
    const crew = riders[1]!;
    crew.inventory.give('smg', 100);
    crew.inventory.current = 'smg';
    crew.shotTimer = 0.06;
    crew.aimYaw = v.heading - Math.PI / 2;
    crew.aimPitch = 0;
    cv.sync(riders, v.pos.x, v.pos.z, 1 / 60);
    expect(weaponPart(cv, 'smg').mesh.count).toBe(1);
    expect(parts(cv).head!.mesh.count).toBe(0);
  });
});

describe('window guns match where vehicle shots leave', () => {
  /**
   * What a shot from `from` (beside vehicle `v`, on the side `side`) passes on its way in, looking straight across the
   * car: the first mesh a ray from 3 m out hits ('glass' for a real window).
   */
  function seenThrough(view: VehicleView, v: Vehicle, from: THREE.Vector3, side: number): string | undefined {
    view.group.updateMatrixWorld(true);
    const lx = Math.cos(v.heading) * side;
    const lz = -Math.sin(v.heading) * side;
    const ray = new THREE.Raycaster(new THREE.Vector3(from.x + lx * 3, from.y, from.z + lz * 3), new THREE.Vector3(-lx, 0, -lz), 0, 6);
    return ray.intersectObject(view.group, true)[0]?.object.name;
  }

  it.each([
    ['police', 1, 'pistol'],
    ['sedan', 0, 'pistol'],
    ['sedan', 3, 'pistol'],
    ['taxi', 2, 'pistol'],
    ['van', 1, 'smg'],
    ['swat', 0, 'smg'],
    ['swat', 1, 'smg'],
    ['swat', 2, 'smg'],
    ['swat', 3, 'smg'],
    ['bus', 0, 'pistol'],
  ] as const)('a %s rider in seat %i fires a %s out of his own window: through glass, barrel end on the muzzle, a hand on the grip', (kind, seat, gun) => {
    const sim = makeSim({ world: world() });
    const b = sim.world.layout.bounds;
    const v = sim.spawnVehicle(kind, b.beachStartX + 30, (b.landMinZ + b.landMaxZ) / 2, 0.4);
    const view = new VehicleView(kind);
    view.bind(v);
    view.sync(v, 1 / 60, 0, 0);
    const riders: Character[] = [];
    for (let i = 0; i <= seat; i++) {
      const c = sim.spawnCharacter(kind === 'swat' ? 'swat' : 'cop', v.pos.x, v.pos.z);
      sim.seat(c, v, i);
      riders.push(c);
    }
    const shooter = riders[seat]!;
    shooter.inventory.give(gun, 100);
    shooter.inventory.current = gun;
    const side = seat === 0 || seat === 2 ? 1 : -1;
    const out = v.heading + (side > 0 ? Math.PI / 2 : -Math.PI / 2);
    // The real shot origin is outside one of the car's windows: looking across the car from beside it, glass, not a
    // painted panel (the riot van's crew in the back fire through its gun ports).
    const shot = sim.combat.muzzle(shooter, true);
    const from = new THREE.Vector3(shot.x, shot.y, shot.z);
    expect(seenThrough(view, v, from, side), `${kind} seat ${seat}`).toBe('glass');
    const cv = new CrowdView();
    // Out of his window, forward, backward, and back across the car.
    for (const yaw of [out, v.heading, v.heading + Math.PI, out + Math.PI]) {
      shooter.aimYaw = yaw;
      shooter.aimPitch = 0.05;
      // Past the full recoil: the drawn kick is small.
      shooter.shotTimer = 0.02;
      cv.sync(riders, v.pos.x, v.pos.z, 1 / 60);
      const part = weaponPart(cv, gun);
      expect(part.mesh.count).toBe(1);
      const m = matrixAt(part, 0);
      const tip = new THREE.Vector3(WEAPON_POINTS[gun].tip.x, WEAPON_POINTS[gun].tip.y, WEAPON_POINTS[gun].tip.z).applyMatrix4(m);
      // The drawn barrel end sits on the real shot origin.
      expect(tip.distanceTo(from), `${kind} seat ${seat} yaw ${(yaw - v.heading).toFixed(2)}`).toBeLessThan(0.1);
      const dir = new THREE.Vector3().setFromMatrixColumn(m, 2).normalize();
      const aim = new THREE.Vector3(Math.sin(yaw) * Math.cos(0.05), Math.sin(0.05), Math.cos(yaw) * Math.cos(0.05));
      expect(THREE.MathUtils.radToDeg(dir.angleTo(aim))).toBeLessThan(15);
      // A hand holds it: the rider's own in a car you can see into, a hand reaching out of the window of a dark one
      // (aimed back across the car, into it, the gun is only reached as far as the arm goes).
      if (yaw === out + Math.PI) continue;
      const grip = new THREE.Vector3(WEAPON_POINTS[gun].grip.x, WEAPON_POINTS[gun].grip.y, WEAPON_POINTS[gun].grip.z).applyMatrix4(m);
      const near = Math.min(...all(parts(cv).hand!).map((h) => origin(h).distanceTo(grip)));
      expect(near, `${kind} seat ${seat} yaw ${(yaw - v.heading).toFixed(2)}`).toBeLessThan(0.06);
    }
  });
});

describe('window guns on a slope', () => {
  it.each([
    ['swat', 1],
    ['swat', 2],
    ['swat', 3],
    ['van', 0],
    ['sedan', 3],
  ] as const)('up or down a ramp, a %s rider in seat %i still fires through his window as the car draws it', (kind, seat) => {
    for (const pitch of [0.25, -0.25]) {
      const sim = makeSim({ world: world() });
      const b = sim.world.layout.bounds;
      const v = sim.spawnVehicle(kind, b.beachStartX + 30, (b.landMinZ + b.landMaxZ) / 2, 0.4);
      v.pitch = pitch;
      const view = new VehicleView(kind);
      view.bind(v);
      view.sync(v, 1 / 60, 0, 0);
      view.group.updateMatrixWorld(true);
      const riders: Character[] = [];
      for (let i = 0; i <= seat; i++) {
        const c = sim.spawnCharacter(kind === 'swat' ? 'swat' : 'cop', v.pos.x, v.pos.z);
        sim.seat(c, v, i);
        riders.push(c);
      }
      const shot = sim.combat.muzzle(riders[seat]!, true);
      // Straight across the car from 3 m out, through the shot origin: glass.
      const side = seat === 0 || seat === 2 ? 1 : -1;
      const lx = Math.cos(v.heading) * side;
      const lz = -Math.sin(v.heading) * side;
      const ray = new THREE.Raycaster(new THREE.Vector3(shot.x + lx * 3, shot.y, shot.z + lz * 3), new THREE.Vector3(-lx, 0, -lz), 0, 6);
      expect(ray.intersectObject(view.group, true)[0]?.object.name, `${kind} seat ${seat} pitch ${pitch}`).toBe('glass');
    }
  });
});

describe('swimming shooters and standing legs', () => {
  it('a swimming shooter holds the gun up out of the water and fires from its drawn barrel end', () => {
    const sim = makeSim({ world: world() });
    const b = sim.world.layout.bounds;
    const cop = sim.spawnCharacter('cop', b.beachEndX + 40, (b.landMinZ + b.landMaxZ) / 2);
    cop.brain = null;
    cop.state = 'swimming';
    cop.pos.y = WATER_Y - SWIM_FLOAT;
    cop.inventory.give('pistol', 100);
    cop.inventory.current = 'pistol';
    cop.inventory.infinite = true;
    cop.aiming = true;
    for (const pitch of [0, 0.3, -0.8]) {
      cop.aimYaw = cop.heading + 0.2;
      cop.aimPitch = pitch;
      const m = sim.combat.muzzle(cop, false);
      expect(m.y, `pitch ${pitch}`).toBeGreaterThan(WATER_Y + 0.1);
      const tip = weaponPose(cop).tip;
      expect(Math.hypot(m.x - tip.x, m.y - tip.y, m.z - tip.z)).toBeLessThan(1e-6);
      const cv = drawn(cop);
      const part = weaponPart(cv, 'pistol');
      expect(part.mesh.count).toBe(1);
      const end = faceCentre(part.mesh.geometry, true).applyMatrix4(matrixAt(part, 0));
      expect(end.distanceTo(new THREE.Vector3(m.x, m.y, m.z))).toBeLessThan(0.05);
    }
    // The shot itself leaves above the surface.
    const p = sim.player;
    p.pos.x = cop.pos.x - 15;
    p.pos.z = cop.pos.z;
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    cop.aimPitch = 0;
    cop.fireCooldown = 0;
    let y = -Infinity;
    sim.events.on('weaponFired', (e) => {
      if (e.shooter === cop) y = e.y;
    });
    sim.combat.npcFire(cop, p, 1, false);
    expect(y).toBeGreaterThan(WATER_Y + 0.1);
  });

  it('standing still, the knees are all but straight', () => {
    for (const height of [0.9, 1, 1.07]) {
      const c = person();
      c.appearance.height = height;
      const cv = drawn(c);
      const p = parts(cv);
      for (let i = 0; i < 2; i++) {
        const flex = THREE.MathUtils.radToDeg(axis(matrixAt(p.thigh!, i)).angleTo(axis(matrixAt(p.shin!, i))));
        expect(flex, `height ${height}`).toBeLessThan(8);
      }
      // Still on the ground.
      expect(Math.min(soleLow(matrixAt(p.shoe!, 0)), soleLow(matrixAt(p.shoe!, 1)))).toBeLessThan(0.02);
    }
  });
});

// ---------------------------------------------------------------------------
// Round 2 fix pass 2: a natural walk on the straight-legged skeleton (hipY 0.894). Fitting the walk to straight legs
// doubled the hip and head bob (8.3 cm at 1.45 m/s, 10.8 cm aim-walking) and locked the stance knee straight.

describe('a natural walk over slightly bent stance knees', () => {
  /** Knee flex (degrees) of drawn leg i. */
  function kneeFlex(cv: CrowdView, i: number): number {
    return THREE.MathUtils.radToDeg(axis(matrixAt(parts(cv).thigh!, i)).angleTo(axis(matrixAt(parts(cv).shin!, i))));
  }

  it.each([
    [1.45, 0, 1, false, 0.055],
    [1.9, 0, 1, false, 0.06],
    [1.45, 0, -1, true, 0.055],
    [2.8, 0, 1, true, 0.07],
    [2.8, 0, -1, true, 0.07],
  ] as const)('walking at %f m/s along (%f, %f) (aiming %s), the head bobs at most %f m and a planted knee never locks', (speed, mx, mz, aiming, maxBob) => {
    let lo = Infinity;
    let hi = -Infinity;
    let planted = Infinity;
    walkSamples(speed, mx, mz, aiming, (cv) => {
      const head = origin(matrixAt(parts(cv).head!, 0));
      lo = Math.min(lo, head.y);
      hi = Math.max(hi, head.y);
      const shoe = parts(cv).shoe!;
      for (let i = 0; i < 2; i++) if (soleLow(matrixAt(shoe, i)) <= 0.01) planted = Math.min(planted, kneeFlex(cv, i));
    });
    // A natural walk's few centimetres, not a flat glide either.
    expect(hi - lo).toBeLessThanOrEqual(maxBob);
    expect(hi - lo).toBeGreaterThanOrEqual(0.025);
    expect(planted).toBeGreaterThanOrEqual(5);
  });

  it.each([0.4, 0.5, 0.6])('easing into a walk at %f m/s, no sole dips under the ground', (speed) => {
    let lowest = Infinity;
    walkSamples(speed, 0, 1, false, (cv) => {
      const shoe = parts(cv).shoe!;
      lowest = Math.min(lowest, soleLow(matrixAt(shoe, 0)), soleLow(matrixAt(shoe, 1)));
    });
    expect(lowest).toBeGreaterThan(-0.001);
  });

  it('through the middle of the stance the knee is slightly bent, neither locked nor crouched, forwards and backwards', () => {
    const out = makeGaitOut();
    for (const scale of [1, 1.07]) {
      for (const [speed, strafe] of [[1.45, 0], [1.9, 0], [2.8, 0], [1.45, Math.PI], [2.8, Math.PI]] as const) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let k = 0; k < 200; k++) {
          const u = k / 200;
          gait(u * 2 * Math.PI, speed, strafe, out, scale, 1);
          const leg = out.legs[0]!;
          const t = u / out.cycle.duty;
          if (!leg.planted || t < 0.4 || t > 0.6) continue;
          const flex = THREE.MathUtils.radToDeg(leg.kneeFlex);
          lo = Math.min(lo, flex);
          hi = Math.max(hi, flex);
        }
        const label = `${speed} m/s ${strafe ? 'backwards' : 'forwards'} height ${scale}`;
        expect(lo, label).toBeGreaterThanOrEqual(5);
        expect(hi, label).toBeLessThanOrEqual(25);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The local player is found by id, not as the first character with the player role.

describe('the crowd draws the local player by id', () => {
  /** The jacket CrowdView gives a character by chance (its salt 21), mirrored here to pick one that has none. */
  const hasChanceJacket = (id: number): boolean => {
    const x = Math.sin(id * 12.9898 + 21 * 78.233) * 43758.5453;
    return x - Math.floor(x) > 0.4;
  };

  function twoPlayers() {
    const sim = makeSim({ police: false });
    const home = sim.player.pos;
    // A second player character with no chance jacket, standing far from the local one and listed before it.
    let other = sim.addPlayer(home.x + 30, home.z).character;
    while (hasChanceJacket(other.id)) other = sim.addPlayer(home.x + 30, home.z).character;
    other.appearance = { ...sim.player.appearance, shirt: 0x112233, hair: 0x445566 };
    return { sim, local: sim.player, other };
  }

  /** The origins of the jacket insets drawn: only the player in the local seat wears one here. */
  const insets = (cv: CrowdView): THREE.Vector3[] => all(parts(cv).shirtInset!).map((m) => new THREE.Vector3().setFromMatrixPosition(m));
  const near = (p: THREE.Vector3, c: Character): boolean => Math.hypot(p.x - c.pos.x, p.z - c.pos.z) < 1.5;

  it('dresses the local player as the player even when another player character comes first', () => {
    const { local, other } = twoPlayers();
    for (const order of [[other, local], [local, other]]) {
      const cv = new CrowdView();
      cv.sync(order, local.pos.x, local.pos.z, 1 / 60, local.id);
      const found = insets(cv);
      expect(found.length).toBe(1);
      expect(near(found[0]!, local)).toBe(true);
    }
  });

  it('follows the id it is given: the other player is the local one for the other screen', () => {
    const { local, other } = twoPlayers();
    const cv = new CrowdView();
    cv.sync([other, local], other.pos.x, other.pos.z, 1 / 60, other.id);
    // The local player's jacket now sits on the other character; the first one (by chance, no jacket) has none of its own.
    const found = insets(cv).filter((p) => near(p, other));
    expect(found.length).toBe(1);
  });

  it('draws a player character that is not the local one as an ordinary character in its own appearance', () => {
    const { local, other } = twoPlayers();
    const cv = new CrowdView();
    cv.sync([other, local], local.pos.x, local.pos.z, 1 / 60, local.id);
    // The torso instances carry each character's shirt: the other player's is its own.
    const torso = parts(cv).torso!.mesh;
    const colors: number[] = [];
    const c = new THREE.Color();
    for (let i = 0; i < torso.count; i++) {
      torso.getColorAt!(i, c);
      colors.push(c.getHex());
    }
    expect(colors).toContain(new THREE.Color(0x112233).getHex());
    expect(colors).toContain(new THREE.Color(local.appearance.shirt).getHex());
    expect(parts(cv).hat!.mesh.count + parts(cv).hair!.mesh.count).toBeGreaterThanOrEqual(2);
  });

  it('with a single player the output is the same whichever way the local character is given', () => {
    const sim = makeSim({ police: false });
    const npc = sim.spawnCharacter('civilian', sim.player.pos.x + 3, sim.player.pos.z);
    const counts = (id: number) => {
      const cv = new CrowdView();
      for (let i = 0; i < 20; i++) cv.sync([sim.player, npc], sim.player.pos.x, sim.player.pos.z, 1 / 60, id);
      return Object.fromEntries(Object.entries(parts(cv)).map(([k, p]) => [k, p.mesh.count]));
    };
    expect(counts(sim.player.id)).toEqual(counts(sim.player.id));
    expect(counts(sim.player.id).shirtInset).toBeGreaterThanOrEqual(1);
    expect(counts(-1).torso).toBe(counts(sim.player.id).torso);
  });
});
