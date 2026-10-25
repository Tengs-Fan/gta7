// Mission 3 characters: the skinned models (render/crowd/) drawn from the segment crowd's own pose. Looks and body
// types, joints against the segment skeleton, guns and grips, hitboxes, idle motion, the near pool and the batched
// crowd, fades, and the software and no-asset fallbacks. The models load from disk (src/assets) through the test
// helper; CrowdView runs headless on the canvas stubs.

import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadAssetsFromDisk, unloadAssets } from '../../src/render/assets/testing';
import { CrowdView, PED_FADE_IN, SKIN_RANGE } from '../../src/render/crowd';
import { buildLookTemplates, type LookTemplate } from '../../src/render/crowd/characterModels';
import { bodyTypeOf, LOOKS, lookOf, slotColors } from '../../src/render/crowd/looks';
import { BODY_TYPES, BONE, drawnJoint, FLOATS_PER_CHAR, IDLE_ELBOW, PALM, REST, RIG, RIG_BONES, skinPoint } from '../../src/render/crowd/rig';
import { characterDepthMaterial, characterMaterial } from '../../src/render/crowd/shader';
import { CROWD_MAX, NEAR_MAX, NEAR_RANGE } from '../../src/render/crowd/skinnedCrowd';
import { stepCharacter } from '../../src/sim/characterPhysics';
import { Character } from '../../src/sim/entities';
import { SKELETON, weaponPose, WEAPON_POINTS } from '../../src/sim/pose';
import { isGun, type WeaponId } from '../../src/sim/specs';
import { BASE_LOOK, compareJoints, flat, personFor, poseCases, runPose, segmentJoints, skinnedJoints } from '../support/characterRig';
import { makeSim } from './helpers';

vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

let templates: LookTemplate[];
beforeAll(async () => {
  await loadAssetsFromDisk({ filter: (e) => e.kind === 'character' || e.kind === 'animation' });
  templates = buildLookTemplates()!;
});
afterAll(() => unloadAssets());

const views = () => {
  const seg = new CrowdView();
  seg.useModels(false);
  const skin = new CrowdView();
  return { seg, skin };
};

type Gun = Exclude<WeaponId, 'fists'>;
const GUNS = Object.keys(WEAPON_POINTS) as Gun[];

describe('looks and body types (VAL-CHR-001)', () => {
  it('every look builds a skinned geometry from its model with its accessories', () => {
    expect(templates).not.toBeNull();
    expect(templates.length).toBe(LOOKS.length);
    for (const t of templates) {
      const g = t.geometry;
      for (const a of ['position', 'normal', 'color', 'slot', 'skinIndex', 'skinWeight']) expect(g.getAttribute(a), `${t.look.id} ${a}`).toBeTruthy();
      expect(g.index, t.look.id).toBeTruthy();
      const si = g.getAttribute('skinIndex');
      for (let i = 0; i < si.count * 4; i++) expect((si.array as Uint16Array)[i]!).toBeLessThan(RIG_BONES);
    }
  });

  it('every role gets a skinned look, purely from id, role, gang and appearance', () => {
    const sim = makeSim();
    const roles = ['player', 'civilian', 'cop', 'swat', 'gang', 'mission'] as const;
    const groupOf: Record<string, string[]> = {};
    for (const role of roles) {
      for (let i = 0; i < 40; i++) {
        const c = sim.spawnCharacter(role, i, 0);
        if (role === 'gang' && i % 2) c.gang = 'halcones';
        const look = lookOf(c);
        expect(LOOKS[look], role).toBeTruthy();
        expect(lookOf(c), 'stable').toBe(look);
        // A copy with the same fields (another client, a reloaded save) gets the same look.
        expect(lookOf({ id: c.id, role: c.role, gang: c.gang, appearance: { ...c.appearance } })).toBe(look);
        (groupOf[role] ??= []).push(LOOKS[look]!.group);
      }
    }
    const rngBefore = JSON.stringify(sim.rng);
    for (const c of sim.characters) lookOf(c), bodyTypeOf(c);
    expect(JSON.stringify(sim.rng)).toBe(rngBefore);
    expect(new Set(groupOf.cop)).toEqual(new Set(['cop']));
    expect(new Set(groupOf.swat)).toEqual(new Set(['swat']));
    expect(new Set(groupOf.player)).toEqual(new Set(['player']));
    expect(new Set(groupOf.gang)).toEqual(new Set(['tiburones', 'halcones']));
    console.log('per-role look groups', JSON.stringify(Object.fromEntries(Object.entries(groupOf).map(([k, v]) => [k, [...new Set(v)]]))));
  });

  it('there are at least 10 civilian looks, each a different model or accessory set', () => {
    const civ = LOOKS.filter((l) => l.group === 'civilian');
    const keys = new Set(civ.map((l) => `${l.model}|${[...l.accessories].sort().join(',')}`));
    expect(civ.length).toBeGreaterThanOrEqual(10);
    expect(keys.size).toBe(civ.length);
    expect(new Set(civ.map((l) => l.model)).size).toBeGreaterThanOrEqual(10);
  });

  it('cops wear a brimmed cap, a duty belt and a radio as geometry; SWAT armour; the two gangs differ', () => {
    for (const l of LOOKS.filter((x) => x.group === 'cop')) for (const a of ['policeCap', 'dutyBelt', 'radio', 'badge']) expect(l.accessories, l.id).toContain(a);
    const cop = templates.find((t) => t.look.id === 'cop')!;
    const plain = templates.find((t) => t.look.id === 'casual')!;
    // The kit adds vertices on the head (cap), the hips (belt) and the chest (radio).
    const onBone = (t: LookTemplate, b: number) => {
      const si = t.geometry.getAttribute('skinIndex');
      let n = 0;
      for (let i = t.bodyVertices; i < si.count; i++) if (si.getX(i) === b) n++;
      return n;
    };
    expect(onBone(cop, BONE.head)).toBeGreaterThan(50);
    expect(onBone(cop, BONE.hips)).toBeGreaterThan(50);
    expect(onBone(cop, BONE.chest)).toBeGreaterThan(10);
    expect(onBone(plain, BONE.head)).toBe(0);
    // The brim reaches out in front of the face.
    const pos = cop.geometry.getAttribute('position');
    let front = -Infinity;
    for (let i = cop.bodyVertices; i < pos.count; i++) if (pos.getY(i) > cop.measure.eyeY) front = Math.max(front, pos.getZ(i));
    expect(front).toBeGreaterThan(cop.measure.faceZ + 0.04);
    expect(LOOKS.find((l) => l.group === 'swat')!.model).toBe('char.swat');
    const t = LOOKS.filter((l) => l.group === 'tiburones');
    const h = LOOKS.filter((l) => l.group === 'halcones');
    const sample = (gang: 'tiburones' | 'halcones', look: (typeof LOOKS)[number]) => slotColors({ id: 3, role: 'gang', gang, appearance: { ...BASE_LOOK, shirt: gang === 'halcones' ? 0x7b1424 : 0x0e7c7b } }, look, []);
    expect(sample('tiburones', t[0]!)).not.toEqual(sample('halcones', h[0]!));
    expect(new Set(t.map((l) => l.id)).size + new Set(h.map((l) => l.id)).size).toBe(t.length + h.length);
  });

  it('four body types; over 500 civilians every civilian look and body type is used by at least 2 %, by both sexes', () => {
    expect(BODY_TYPES.length).toBe(4);
    const sim = makeSim();
    const looks = new Map<string, number>();
    const bodies = new Map<number, number>();
    const bodiesBySex = { f: new Set<number>(), m: new Set<number>() };
    for (let i = 0; i < 500; i++) {
      const c = sim.spawnCharacter('civilian', i, 0);
      const l = LOOKS[lookOf(c)]!;
      const b = bodyTypeOf(c);
      looks.set(l.id, (looks.get(l.id) ?? 0) + 1);
      bodies.set(b, (bodies.get(b) ?? 0) + 1);
      bodiesBySex[l.female ? 'f' : 'm'].add(b);
    }
    console.log('look histogram over 500 civilians', JSON.stringify(Object.fromEntries(looks)), 'body types', JSON.stringify(Object.fromEntries([...bodies].map(([k, v]) => [BODY_TYPES[k]!.id, v]))));
    for (const l of LOOKS.filter((x) => x.group === 'civilian')) expect(looks.get(l.id) ?? 0, l.id).toBeGreaterThanOrEqual(10);
    for (let b = 0; b < 4; b++) expect(bodies.get(b) ?? 0, BODY_TYPES[b]!.id).toBeGreaterThanOrEqual(10);
    expect(bodiesBySex.f.size).toBeGreaterThanOrEqual(3);
    expect(bodiesBySex.m.size).toBe(4);
  });

  it('hair is modelled on at least 5 civilian looks, hands have a thumb and fingers, and at least 3 accessory types appear', () => {
    const hairy = templates.filter((t) => t.look.group === 'civilian' && t.model.primitives.some((p) => t.look.slots[p.material] === 'hair' && p.geometry.getAttribute('position').count > 500));
    expect(new Set(hairy.map((t) => t.look.model)).size).toBeGreaterThanOrEqual(5);
    const kinds = new Set(LOOKS.filter((l) => l.group === 'civilian').flatMap((l) => l.accessories));
    expect(kinds.size).toBeGreaterThanOrEqual(3);
    // A hand: the vertices on the hand bone reach out past the palm in a fan (fingers) and a thumb set apart.
    const t = templates[0]!;
    const pos = t.geometry.getAttribute('position');
    const si = t.geometry.getAttribute('skinIndex');
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < t.bodyVertices; i++) if (si.getX(i) === BONE.handL) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i));
    expect(pts.length).toBeGreaterThanOrEqual(80);
    // Fingers reach well past the palm; the thumb stands off them towards the front, with a gap between.
    const reach = Math.max(...pts.map((p) => p.x - REST.handL[0]));
    expect(reach).toBeGreaterThan(0.1);
    const thumb = pts.filter((p) => p.z - REST.handL[2] > 0.045 && p.x - REST.handL[0] < 0.08);
    const fingers = pts.filter((p) => p.x - REST.handL[0] > 0.09 && p.z - REST.handL[2] < 0.03);
    expect(thumb.length).toBeGreaterThanOrEqual(4);
    expect(fingers.length).toBeGreaterThanOrEqual(16);
    expect(Math.min(...thumb.map((p) => Math.min(...fingers.map((q) => p.distanceTo(q)))))).toBeGreaterThan(0.005);
  });
});

describe('drawn joints match the segment skeleton (VAL-CHR-002)', () => {
  it('every body type, height and build, in every pose: every mapped joint within 2 cm, feet on the ground, no NaN', () => {
    const sizes: Array<[number, number]> = [[0.9, 0.88], [1.0, 1.0], [1.07, 1.18]];
    const report: string[] = [];
    let worst = 0;
    let id = 100;
    for (let bt = 0; bt < BODY_TYPES.length; bt++) {
      for (const [height, build] of sizes) {
        let typeMax = 0;
        let typeWorst = '';
        let sum = 0;
        let n = 0;
        for (const pc of poseCases()) {
          const { seg, skin } = views();
          const sim = pc.needsSim ? makeSim() : null;
          const c = personFor(++id, { height, build });
          if (sim) {
            const p = sim.player;
            c.pos.x = p.pos.x;
            c.pos.z = p.pos.z;
            c.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
            sim.characters.push(c);
          }
          skin.bodyOverride.set(c.id, bt);
          runPose(pc, c, seg, skin, sim);
          const a = segmentJoints(seg, c);
          const b = skinnedJoints(skin, c.id);
          expect(b, pc.name).not.toBeNull();
          for (const k of pc.skip ?? []) a.delete(k);
          const e = compareJoints(a, b!);
          expect(e.nan, pc.name).toBe(false);
          expect(e.compared, pc.name).toBeGreaterThanOrEqual(pc.skip ? 13 : 17);
          expect(e.max, `${BODY_TYPES[bt]!.id} h${height} b${build} ${pc.name} ${e.worst}`).toBeLessThanOrEqual(0.02);
          if (pc.name.startsWith('walk')) for (const s of ['L', 'R']) expect(Math.abs(a.get('ankle' + s)!.y - b!.get('ankle' + s)!.y)).toBeLessThanOrEqual(0.02);
          if (e.max > typeMax) {
            typeMax = e.max;
            typeWorst = `${pc.name}:${e.worst}`;
          }
          sum += e.mean;
          n++;
        }
        worst = Math.max(worst, typeMax);
        report.push(`${BODY_TYPES[bt]!.id} h${height} b${build}: max ${(typeMax * 1000).toFixed(1)} mm (${typeWorst}), mean ${((sum / n) * 1000).toFixed(2)} mm over ${n} poses`);
      }
    }
    console.log('joint error vs segment crowd\n' + report.join('\n'));
    expect(worst).toBeLessThanOrEqual(0.02);
  });
});

describe('guns and grips (VAL-CHR-003)', () => {
  type Part = { mesh: THREE.InstancedMesh };
  const weaponMatrix = (cv: CrowdView, gun: Gun): THREE.Matrix4 | null => {
    const w = (cv as unknown as { weapons: Map<WeaponId, Part> }).weapons.get(gun) ?? (cv as unknown as { weapons: Map<WeaponId, Part> }).weapons.get('pistol')!;
    if (w.mesh.count < 1) return null;
    const m = new THREE.Matrix4();
    w.mesh.getMatrixAt(0, m);
    return m;
  };
  /** The palm centre of the drawn right hand (wrist bone carried along the hand by SKELETON.hand). */
  const palm = (cv: CrowdView, id: number): THREE.Vector3 => {
    const b = cv.models!.bonesOf(id)!;
    const r = REST.handR;
    return skinPoint(b.data, b.offset, BONE.handR, r[0] - PALM, r[1], r[2], new THREE.Vector3()).add(b.root);
  };

  it('for every gun, body type and pose (idle, aim at 3 pitches, firing) the muzzle is the sim muzzle and the grip hand holds the grip', () => {
    const rows: string[] = [];
    let id = 900;
    for (const gun of GUNS) {
      let maxTip = 0;
      let maxGrip = 0;
      for (let bt = 0; bt < BODY_TYPES.length; bt++) {
        for (const mode of ['idle', 'aim--0.5', 'aim-0', 'aim-0.7', 'fire'] as const) {
          const skin = new CrowdView();
          const c = personFor(++id);
          skin.bodyOverride.set(c.id, bt);
          c.inventory.give(gun, 500);
          c.inventory.current = gun;
          c.aiming = mode !== 'idle';
          c.aimPitch = mode.startsWith('aim') ? Number(mode.slice(4)) : 0;
          c.aimYaw = 0;
          for (let i = 0; i < 40; i++) {
            if (mode === 'fire' && i === 39) c.shotTimer = 0.07;
            skin.sync([c], c.pos.x + 4, c.pos.z, 1 / 60);
          }
          const m = weaponMatrix(skin, gun)!;
          const pts = WEAPON_POINTS[gun];
          const tip = new THREE.Vector3(pts.tip.x, pts.tip.y, pts.tip.z).applyMatrix4(m);
          const pose = weaponPose(c);
          const dTip = Math.hypot(tip.x - pose.tip.x, tip.y - pose.tip.y, tip.z - pose.tip.z);
          const grip = new THREE.Vector3(pts.grip.x, pts.grip.y, pts.grip.z).applyMatrix4(m);
          const dGrip = palm(skin, c.id).distanceTo(grip);
          expect(dTip, `${gun} ${mode} tip`).toBeLessThanOrEqual(0.02);
          expect(dGrip, `${gun} ${BODY_TYPES[bt]!.id} ${mode} grip`).toBeLessThanOrEqual(0.02);
          maxTip = Math.max(maxTip, dTip);
          maxGrip = Math.max(maxGrip, dGrip);
        }
      }
      rows.push(`${gun}: muzzle max ${(maxTip * 1000).toFixed(1)} mm, grip max ${(maxGrip * 1000).toFixed(1)} mm`);
    }
    console.log('gun tips and grips\n' + rows.join('\n'));
    expect(GUNS.every((g) => isGun(g))).toBe(true);
  });
});

/** Every vertex of a template skinned with a drawn bone block (world space). */
function skinVertices(t: LookTemplate, data: Float32Array, offset: number, root: THREE.Vector3, count = t.bodyVertices): THREE.Vector3[] {
  const pos = t.geometry.getAttribute('position');
  const si = t.geometry.getAttribute('skinIndex');
  const sw = t.geometry.getAttribute('skinWeight');
  const out: THREE.Vector3[] = [];
  const p = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w <= 0) continue;
      skinPoint(data, offset, si.getComponent(i, k), pos.getX(i), pos.getY(i), pos.getZ(i), p);
      v.addScaledVector(p, w);
    }
    out.push(v.clone().add(root));
  }
  return out;
}

describe('hitboxes and combat are unchanged (VAL-CHR-004)', () => {
  // combat.ts: standing body cylinder BODY_R up to NECK of the height, head cylinder HEAD_R from there to the top.
  const BODY_R = 0.36;
  const HEAD_R = 0.16;
  const NECK = 0.86;

  it('the head bone lies in the head capsule, and at least 90 % of body vertices within 8 cm of the capsules (idle, walk, aim, every body type)', () => {
    const rows: string[] = [];
    const cases = poseCases().filter((p) => ['idle', 'walk-0', 'walk-4', 'pistol-aim-0', 'rifle-aim-0.6'].includes(p.name));
    let id = 2000;
    for (let bt = 0; bt < BODY_TYPES.length; bt++) {
      for (const pc of cases) {
        for (const look of [0, 1, 8, 16]) {
          const { seg, skin } = views();
          const c = personFor(++id);
          skin.bodyOverride.set(c.id, bt);
          skin.lookOverride.set(c.id, look);
          runPose(pc, c, seg, skin, null);
          const b = skin.models!.bonesOf(c.id)!;
          const head = drawnJoint(b.data, b.offset, BONE.head, b.root, new THREE.Vector3());
          const h = c.height;
          const r = Math.hypot(head.x - c.pos.x, head.z - c.pos.z);
          expect(r, `${pc.name} head radius`).toBeLessThanOrEqual(HEAD_R);
          expect(head.y - c.pos.y).toBeGreaterThanOrEqual(NECK * h);
          expect(head.y - c.pos.y).toBeLessThanOrEqual(h);
          const vs = skinVertices(templates[look]!, b.data, b.offset, b.root);
          let inside = 0;
          for (const v of vs) {
            const y = v.y - c.pos.y;
            const rr = Math.hypot(v.x - c.pos.x, v.z - c.pos.z);
            const dy = y < 0 ? -y : y > h ? y - h : 0;
            const R = y <= NECK * h ? BODY_R : Math.max(HEAD_R, rr <= BODY_R && y <= NECK * h + 0.08 ? BODY_R : HEAD_R);
            const d = Math.hypot(Math.max(0, rr - R), dy);
            if (d <= 0.08) inside++;
          }
          const share = inside / vs.length;
          expect(share, `${BODY_TYPES[bt]!.id} ${pc.name} ${LOOKS[look]!.id}`).toBeGreaterThanOrEqual(0.9);
          if (look === 0) rows.push(`${BODY_TYPES[bt]!.id} ${pc.name}: ${(share * 100).toFixed(1)} % of ${vs.length} vertices within 8 cm`);
        }
      }
    }
    console.log('vertices in the hit capsules\n' + rows.join('\n'));
  });
});

describe('idle and ambient motion (VAL-CHR-006)', () => {
  const sampleIdle = (id: number, seconds: number) => {
    const skin = new CrowdView();
    const c = personFor(id);
    const frames: Array<{ q: THREE.Quaternion[]; headYaw: number }> = [];
    for (let i = 0; i < 30; i++) skin.sync([c], 4, 0, 1 / 60);
    for (let i = 0; i < seconds * 60; i++) {
      stepCharacter(c, 1 / 60, flat);
      skin.sync([c], 4, 0, 1 / 60);
      const b = skin.models!.bonesOf(c.id)!;
      const q = RIG.map((_, j) => {
        const m = new THREE.Matrix4().fromArray(b.data, b.offset + j * 16);
        return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m));
      });
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q[BONE.head]!);
      frames.push({ q, headYaw: Math.atan2(fwd.x, fwd.z) });
    }
    return frames;
  };

  it('over 4 s a standing character moves at least 3 bones by 2 to 15 degrees peak to peak, out of phase with another', () => {
    const a = sampleIdle(31, 4);
    const moving: string[] = [];
    for (let j = 0; j < RIG_BONES; j++) {
      const q0 = a[0]!.q[j]!;
      let maxAngle = 0;
      for (const f of a) for (const g of a) maxAngle = Math.max(maxAngle, f.q[j]!.angleTo(g.q[j]!));
      const deg = THREE.MathUtils.radToDeg(maxAngle);
      void q0;
      if (deg >= 2 && deg <= 15) moving.push(`${RIG[j]} ${deg.toFixed(1)}°`);
      expect(deg, RIG[j]).toBeLessThanOrEqual(15);
    }
    console.log('idle peak-to-peak rotation', moving.join(', '));
    expect(moving.length).toBeGreaterThanOrEqual(3);
    const b = sampleIdle(57, 4);
    const ya = a.map((f) => f.headYaw);
    const yb = b.map((f) => f.headYaw);
    const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
    const ma = mean(ya);
    const mb = mean(yb);
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < ya.length; i++) {
      num += (ya[i]! - ma) * (yb[i]! - mb);
      da += (ya[i]! - ma) ** 2;
      db += (yb[i]! - mb) ** 2;
    }
    const corr = num / Math.sqrt(da * db);
    console.log('head yaw correlation between two idle characters', corr.toFixed(3));
    expect(corr).toBeLessThan(0.8);
  });

  it('the idle arms hang within 15 degrees of vertical with a slight elbow bend (softer than the bare segment pose)', () => {
    const skin = new CrowdView();
    const c = personFor(41);
    for (let i = 0; i < 90; i++) skin.sync([c], 4, 0, 1 / 60);
    const b = skin.models!.bonesOf(c.id)!;
    for (const [sh, el, wr] of [[BONE.armL, BONE.foreL, BONE.handL], [BONE.armR, BONE.foreR, BONE.handR]] as const) {
      const s = drawnJoint(b.data, b.offset, sh, b.root, new THREE.Vector3());
      const e = drawnJoint(b.data, b.offset, el, b.root, new THREE.Vector3());
      const w = drawnJoint(b.data, b.offset, wr, b.root, new THREE.Vector3());
      const upper = e.clone().sub(s).normalize();
      const fore = w.clone().sub(e).normalize();
      const fromVertical = THREE.MathUtils.radToDeg(upper.angleTo(new THREE.Vector3(0, -1, 0)));
      const bend = THREE.MathUtils.radToDeg(upper.angleTo(fore));
      expect(fromVertical).toBeLessThanOrEqual(15);
      expect(bend).toBeGreaterThanOrEqual(5 + THREE.MathUtils.radToDeg(IDLE_ELBOW) * 0.5);
      expect(bend).toBeLessThanOrEqual(35);
      console.log(`idle arm: ${fromVertical.toFixed(1)}° from vertical, elbow bend ${bend.toFixed(1)}°`);
    }
  });

  it('is presentation only: the same seed gives the same sim with the models and their idle motion on or off', () => {
    const run = (models: boolean) => {
      const sim = makeSim({ ambient: true });
      const cv = new CrowdView();
      cv.useModels(models);
      for (let i = 0; i < 240; i++) {
        sim.update(1 / 60, { ...neutral() });
        const p = sim.player.pos;
        cv.sync(sim.characters, p.x, p.z, 1 / 60, sim.player.id);
      }
      return JSON.stringify(sim.characters.map((c) => [c.id, c.pos.x.toFixed(5), c.pos.z.toFixed(5), c.heading.toFixed(5), c.state]));
    };
    expect(run(true)).toBe(run(false));
  });
});

function neutral() {
  // Imported lazily to keep the module graph small.
  return { moveX: 0, moveZ: 0, sprint: false, jump: false, fire: false, firePressed: false, aim: false, interact: false, cameraYaw: 0, aimOrigin: { x: 0, y: 0, z: 0 }, aimDir: { x: 0, y: 0, z: 1 } } as unknown as Parameters<ReturnType<typeof makeSim>['update']>[1];
}

describe('near pool and batched crowd (VAL-CHR-007)', () => {
  const crowdOf = (n: number, spread = 3) => {
    const chars: Character[] = [];
    for (let i = 0; i < n; i++) chars.push(personFor(5000 + i, {}, 'civilian'));
    chars.forEach((c, i) => {
      c.pos.x = (i % 20) * spread;
      c.pos.z = Math.floor(i / 20) * spread;
    });
    return chars;
  };

  it('at most NEAR_MAX SkinnedMeshes and one BatchedMesh, whatever the number of characters; one draw per pass each', () => {
    for (const n of [10, 60, 200]) {
      const cv = new CrowdView();
      const chars = crowdOf(n);
      for (let i = 0; i < 5; i++) cv.sync(chars, 0, 0, 1 / 60);
      const m = cv.models!;
      const skinned: THREE.SkinnedMesh[] = [];
      const batched: THREE.BatchedMesh[] = [];
      m.group.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.visible) skinned.push(o as THREE.SkinnedMesh);
        if ((o as THREE.BatchedMesh).isBatchedMesh) batched.push(o as THREE.BatchedMesh);
      });
      expect(skinned.length).toBeLessThanOrEqual(NEAR_MAX);
      expect(batched.length).toBe(1);
      // Each pool mesh is one geometry with one material (one draw), and so is the crowd (one multi-draw).
      for (const s of skinned) expect(Array.isArray(s.material)).toBe(false);
      expect(skinned.every((s) => s.geometry.groups.length <= 1)).toBe(true);
      expect(m.stats.near + m.stats.crowd).toBe(n);
      expect(m.stats.crowd).toBe(n - m.stats.near);
      console.log(`${n} characters: ${m.stats.near} SkinnedMeshes, ${m.stats.crowd} in the batched crowd (1 draw), bone update ${m.stats.boneMs.toFixed(2)} ms`);
    }
    expect(CROWD_MAX).toBeGreaterThanOrEqual(240);
  });

  it('a character moving between the pool and the crowd keeps his look and pose exactly', () => {
    const cv = new CrowdView();
    const c = personFor(77);
    for (let i = 0; i < 30; i++) cv.sync([c], 2, 0, 1 / 60);
    const near = cv.models!.where.get(c.id)!;
    expect(near.near).toBe(true);
    const a = cv.models!.bonesOf(c.id)!;
    const blockA = Float32Array.from(a.data.subarray(a.offset, a.offset + FLOATS_PER_CHAR));
    const rootA = a.root.clone();
    const lookA = cv.drawnLook(c.id)!.lookIndex;
    // Freeze the clock (dt 0) and step the camera out past NEAR_RANGE: he goes to the crowd.
    cv.sync([c], NEAR_RANGE + 3, 0, 0);
    const far = cv.models!.where.get(c.id)!;
    expect(far.near).toBe(false);
    const b = cv.models!.bonesOf(c.id)!;
    const blockB = b.data.subarray(b.offset, b.offset + FLOATS_PER_CHAR);
    expect(cv.drawnLook(c.id)!.lookIndex).toBe(lookA);
    expect(b.root.distanceTo(rootA)).toBeLessThan(1e-6);
    let maxJoint = 0;
    for (let j = 0; j < RIG_BONES; j++) maxJoint = Math.max(maxJoint, drawnJoint(blockA, 0, j, rootA, new THREE.Vector3()).distanceTo(drawnJoint(blockB, 0, j, b.root, new THREE.Vector3())));
    expect(maxJoint).toBeLessThan(0.02);
    console.log(`pool -> crowd: joints moved ${(maxJoint * 1000).toFixed(3)} mm, look kept`);
  });

  it('beyond SKIN_RANGE the segment crowd draws the far ones (no minor parts, no shadow); without models everyone', () => {
    const cv = new CrowdView();
    const near = personFor(301);
    const far = personFor(302);
    far.pos.x = SKIN_RANGE + 20;
    for (let i = 0; i < 5; i++) cv.sync([near, far], 0, 0, 1 / 60);
    const st = cv.characterStats();
    expect(st.segments).toBe(1);
    expect(st.skinnedMeshes + st.crowd).toBe(1);
    const parts = (cv as unknown as { parts: Record<string, { mesh: THREE.InstancedMesh }> }).parts;
    expect(parts.face!.mesh.count).toBe(0);
    expect(parts.torso!.mesh.castShadow).toBe(false);
    const plain = new CrowdView();
    plain.useModels(false);
    for (let i = 0; i < 5; i++) plain.sync([near, far], 0, 0, 1 / 60);
    expect(plain.characterStats().segments).toBe(2);
    expect(plain.models).toBeNull();
  });
});

describe('fades and dissolves (VAL-CHR-008)', () => {
  const fadeOf = (cv: CrowdView, id: number) => {
    const b = cv.models!.bonesOf(id)!;
    return b.data[b.offset + RIG_BONES * 16]!;
  };

  it('a new pedestrian starts at fade 0 and is whole within 0.3 to 1.0 s; the player is whole from the first frame', () => {
    for (const near of [true, false]) {
      const cv = new CrowdView();
      const c = personFor(400 + (near ? 0 : 1));
      const cam = near ? 3 : NEAR_RANGE + 10;
      cv.sync([c], cam, 0, 1 / 60);
      expect(fadeOf(cv, c.id)).toBe(0);
      let t = 0;
      while (fadeOf(cv, c.id) < 1 && t < 2) {
        cv.sync([c], cam, 0, 1 / 60);
        t += 1 / 60;
      }
      expect(t).toBeGreaterThanOrEqual(0.3);
      expect(t).toBeLessThanOrEqual(1.0);
      expect(t).toBeCloseTo(PED_FADE_IN, 1);
    }
    const cv = new CrowdView();
    const p = personFor(410, {}, 'player');
    cv.sync([p], 3, 0, 1 / 60, p.id);
    expect(fadeOf(cv, p.id)).toBe(1);
  });

  it('the surface shader dissolves near the lens and by fade; the shadow follows the fade and has no lens dissolve', () => {
    const compile = (m: THREE.Material, base: 'standard' | 'depth') => {
      const lib = THREE.ShaderLib[base];
      const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: { ...lib.uniforms } } as unknown as THREE.WebGLProgramParametersWithUniforms;
      m.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
      return shader;
    };
    const main = compile(characterMaterial(), 'standard');
    expect(main.fragmentShader).toMatch(/vCharFade < 1\.0 && lensBayer4/);
    expect(main.fragmentShader).toMatch(/vCharLens > 0\.5 && vViewPosition\.z < 0\.90/);
    const depth = compile(characterDepthMaterial(), 'depth');
    expect(depth.fragmentShader).toMatch(/vCharFade < 1\.0 && lensBayer4/);
    expect(depth.fragmentShader).not.toMatch(/vCharLens > 0\.5/);
    // Both read the batched crowd's bones and skin with them.
    expect(main.vertexShader).toMatch(/crowdBone\( charInst, skinIndex\.x \)/);
    expect(depth.vertexShader).toMatch(/crowdBone\( charInst, skinIndex\.x \)/);
    const cv = new CrowdView();
    expect(cv.models!.pool.every((s) => s.mesh.customDepthMaterial === cv.models!.nearDepth)).toBe(true);
    expect(cv.models!.batched.customDepthMaterial).toBe(cv.models!.crowdDepth);
  });

  it('a removed pedestrian fades out where he was; remote players are whole and not lens-dissolved', () => {
    const cv = new CrowdView();
    const c = personFor(420);
    const remote = personFor(421, {}, 'player');
    const local = personFor(422, {}, 'player');
    for (let i = 0; i < 60; i++) cv.sync([c, remote, local], 3, 0, 1 / 60, local.id);
    const lens = (id: number) => {
      const b = cv.models!.bonesOf(id)!;
      return b.data[b.offset + RIG_BONES * 16 + 1];
    };
    expect(lens(c.id)).toBe(1);
    expect(lens(local.id)).toBe(1);
    expect(lens(remote.id)).toBe(0);
    c.removed = true;
    cv.sync([c, remote, local], 3, 0, 0.2);
    expect(fadeOf(cv, c.id)).toBeGreaterThan(0);
    expect(fadeOf(cv, c.id)).toBeLessThan(1);
  });
});

describe('bone update cost and fallbacks (VAL-CHR-009, VAL-CHR-011, VAL-CHR-012)', () => {
  it('drives 144 characters (pool full, the rest batched) in well under 2 ms a frame', () => {
    const cv = new CrowdView();
    const chars: Character[] = [];
    for (let i = 0; i < 144; i++) {
      const c = personFor(7000 + i);
      c.pos.x = (i % 12) * 1.5;
      c.pos.z = Math.floor(i / 12) * 1.5;
      c.moveZ = 1;
      c.moveSpeed = i % 3 ? 1.45 : 0;
      chars.push(c);
    }
    for (let i = 0; i < 30; i++) cv.sync(chars, 5, 5, 1 / 60);
    // The mean of the quietest of three 60-frame windows: the machine is shared, and a busy neighbour (or a GC) in one
    // window says nothing about this code.
    const means: number[] = [];
    for (let w = 0; w < 3; w++) {
      const times: number[] = [];
      for (let i = 0; i < 60; i++) {
        for (const c of chars) stepCharacter(c, 1 / 60, flat);
        cv.sync(chars, 5, 5, 1 / 60);
        times.push(cv.models!.stats.boneMs);
      }
      means.push(times.reduce((a, b) => a + b, 0) / times.length);
    }
    const mean = Math.min(...means);
    console.log(`bone matrices for ${cv.models!.stats.near} pool + ${cv.models!.stats.crowd} crowd characters: ${mean.toFixed(3)} ms mean (windows ${means.map((m) => m.toFixed(3)).join(', ')})`);
    expect(cv.models!.stats.near + cv.models!.stats.crowd).toBe(144);
    expect(mean).toBeLessThanOrEqual(2);
  });

  it('the software tier and a missing model use the segment crowd and create no SkinnedMesh', () => {
    const cv = new CrowdView();
    cv.useModels(false);
    const c = personFor(500);
    cv.sync([c], 3, 0, 1 / 60);
    let skinned = 0;
    cv.group.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned++;
    });
    expect(skinned).toBe(0);
    expect(cv.characterStats().segments).toBe(1);
  });

  it('the fitted feet keep the gait envelope: soles SKELETON.ankleY under the ankle, within the heel and toe reach', () => {
    for (const t of templates) {
      const pos = t.geometry.getAttribute('position');
      const si = t.geometry.getAttribute('skinIndex');
      const sw = t.geometry.getAttribute('skinWeight');
      let low = Infinity;
      let back = Infinity;
      let front = -Infinity;
      for (let i = 0; i < t.bodyVertices; i++) {
        if (si.getX(i) !== BONE.footL || sw.getX(i) < 0.9) continue;
        low = Math.min(low, pos.getY(i));
        back = Math.min(back, pos.getZ(i));
        front = Math.max(front, pos.getZ(i));
      }
      const ankle = REST.footL;
      expect(Math.abs(ankle[1] - low - SKELETON.ankleY), `${t.look.id} sole`).toBeLessThanOrEqual(0.012);
      expect(back - ankle[2], `${t.look.id} heel`).toBeGreaterThanOrEqual(-SKELETON.heel - 0.02);
      expect(front - ankle[2], `${t.look.id} toe`).toBeLessThanOrEqual(SKELETON.toe + 0.04);
    }
  });
});
