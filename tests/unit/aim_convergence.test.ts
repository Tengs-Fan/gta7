// Point-blank aim convergence: within about 3 m the player's aim turns from the crosshair ray's yaw towards the point
// the crosshair is on, so the gun (beside and below the shoulder camera) shoots what the crosshair shows; smoothly, and
// only up close.

import { describe, expect, it } from 'vitest';
import type { V3 } from '../../src/core/math';
import { wrapAngle } from '../../src/core/math';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import type { WeaponId } from '../../src/sim/specs';
import { input, makeSim, step, teleport } from './helpers';

const DT = 1 / 60;
const DEG = 180 / Math.PI;

function openRoad(sim: Sim): { x: number; z: number; h: number } {
  for (const pr of sim.world.grid.colliders) if (pr.breakable || pr.tag === 'tree') pr.broken = true;
  for (const lane of sim.roads.lanes) {
    if (lane.length < 60) continue;
    const s = lane.length / 2;
    const x = lane.sx + lane.dx * s;
    const z = lane.sz + lane.dz * s;
    const rx = -Math.cos(lane.heading);
    const rz = Math.sin(lane.heading);
    let open = true;
    for (let a = -10; a <= 24 && open; a++) for (let l = -4; l <= 4 && open; l++) open = sim.world.isFree(x + lane.dx * a + rx * l, z + lane.dz * a + rz * l, 0.5);
    if (open) return { x, z, h: lane.heading };
  }
  throw new Error('no open road');
}

function stand(sim: Sim) {
  const r = openRoad(sim);
  teleport(sim, r.x, r.z);
  sim.player.heading = r.h;
  return { h: r.h, fx: Math.sin(r.h), fz: Math.cos(r.h), rx: -Math.cos(r.h), rz: Math.sin(r.h) };
}

/** The aimed shoulder camera (2.4 m back, 0.62 m right of the player) looking along yaw and pitch. */
function shoulderAim(sim: Sim, yaw: number, pitch: number, over: Partial<PlayerInput> = {}): PlayerInput {
  const p = sim.player;
  const vx = Math.sin(yaw) * Math.cos(pitch);
  const vy = Math.sin(pitch);
  const vz = Math.cos(yaw) * Math.cos(pitch);
  const headY = p.pos.y + 1.58 * p.appearance.height;
  const ox = p.pos.x - vx * 2.4 - Math.cos(yaw) * 0.62;
  const oz = p.pos.z - vz * 2.4 + Math.sin(yaw) * 0.62;
  const o = { x: ox, y: Math.max(headY - vy * 2.4 + 0.18, sim.world.groundHeight(ox, oz) + 0.35), z: oz };
  return input({ aimOrigin: o, aimDir: { x: vx, y: vy, z: vz }, cameraYaw: yaw, aim: true, ...over });
}

/** The shoulder camera turned so that its crosshair ray runs through `target`. */
function crosshairOn(sim: Sim, target: V3, over: Partial<PlayerInput> = {}): PlayerInput {
  let yaw = Math.atan2(target.x - sim.player.pos.x, target.z - sim.player.pos.z);
  let pitch = 0;
  for (let i = 0; i < 80; i++) {
    const o = shoulderAim(sim, yaw, pitch).aimOrigin;
    yaw = Math.atan2(target.x - o.x, target.z - o.z);
    pitch = Math.atan2(target.y - o.y, Math.hypot(target.x - o.x, target.z - o.z));
  }
  return shoulderAim(sim, yaw, pitch, over);
}

describe('point-blank aim convergence', () => {
  it('aimed shots at the head, neck, chest and belly of an enemy all round the player at 0.4-1.5 m all hit (pistol and SMG)', () => {
    const rows: string[] = [];
    for (const weapon of ['pistol', 'smg'] as WeaponId[]) {
      const zones = { head: 0.93, neck: 0.86, chest: 0.7, belly: 0.55 } as const;
      for (const [zone, k] of Object.entries(zones)) {
        let shots = 0;
        let misses = 0;
        for (const ahead of [0.4, 0.55, 0.7, 0.85, 1.0, 1.2, 1.5]) {
          for (const side of [-0.4, -0.2, 0, 0.2, 0.4, 0.62, 0.8, 1.0]) {
            const sim = makeSim({ police: false });
            const f = stand(sim);
            const p = sim.player;
            p.inventory.give(weapon, 500);
            p.inventory.current = weapon;
            const e = sim.spawnCharacter('gang', p.pos.x + f.fx * ahead + f.rx * side, p.pos.z + f.fz * ahead + f.rz * side);
            e.owner = 'mission';
            e.persistent = true;
            e.armor = 1e6;
            const tgt = () => ({ x: e.pos.x, y: e.pos.y + k * e.height, z: e.pos.z });
            step(sim, 0.2, () => crosshairOn(sim, tgt()));
            let hits = 0;
            let n = 0;
            sim.events.on('shot', (ev) => {
              if (ev.shooter !== p) return;
              n++;
              if (ev.hit === 'flesh') hits++;
            });
            for (let i = 0; i < 3; i++) {
              sim.update(DT, crosshairOn(sim, tgt(), { fire: true, firePressed: true }));
              step(sim, 0.35, () => crosshairOn(sim, tgt()));
            }
            shots += n;
            misses += n - hits;
          }
        }
        rows.push(`${weapon} ${zone}: ${misses}/${shots} missed`);
        // Baseline before convergence: 33/168 head and neck shots missed (an enemy pushed to 0.7 m, 62 deg right).
        expect(shots, `${weapon} ${zone}`).toBe(168);
        expect(misses, `${weapon} ${zone}`).toBe(0);
      }
    }
    console.log(`[aim]\n${rows.join('\n')}`);
  });

  /**
   * The camera held still while whatever the crosshair is on comes nearer: an enemy kept on the crosshair ray `a` m
   * ahead of the player (along the ray), from 4 m to 0.3 m in 3 s (1.2 m/s, a walk). Returns the player's aim yaw each frame, the
   * camera yaw, and the point the crosshair is on.
   */
  function sweep(weapon: WeaponId) {
    const sim = makeSim({ police: false });
    const f = stand(sim);
    const p = sim.player;
    p.inventory.give(weapon, 500);
    p.inventory.current = weapon;
    const home = { x: p.pos.x, z: p.pos.z };
    const inp = shoulderAim(sim, f.h, -0.2);
    const e = sim.spawnCharacter('gang', home.x + f.fx * 4, home.z + f.fz * 4);
    e.owner = 'mission';
    e.persistent = true;
    e.armor = 1e6;
    const o = inp.aimOrigin;
    const d = inp.aimDir;
    const flat = Math.hypot(d.x, d.z);
    const depth = ((home.x - o.x) * d.x + (home.z - o.z) * d.z) / flat;
    const trace: Array<{ a: number; yaw: number; dist: number; toPoint: number }> = [];
    const frames = 180;
    for (let i = 0; i <= frames; i++) {
      const a = 4 - (3.7 * i) / frames;
      // The enemy's axis on the crosshair ray, `a` m past the player's depth along it.
      const x = o.x + (d.x / flat) * (depth + a);
      const z = o.z + (d.z / flat) * (depth + a);
      teleport(sim, home.x, home.z);
      e.pos.x = x;
      e.pos.z = z;
      e.vel.x = 0;
      e.vel.z = 0;
      sim.update(DT, inp);
      const dist = Math.hypot(x - home.x, z - home.z);
      trace.push({ a, yaw: p.aimYaw, dist, toPoint: Math.atan2(x - p.pos.x, z - p.pos.z) });
    }
    return { trace, camYaw: f.h };
  }

  it.each(['pistol', 'smg'] as WeaponId[])('%s: the aim blends in from 3 m, never steps more than 2 deg a frame, and points at the crosshair point within 1 m', (weapon) => {
    const { trace, camYaw } = sweep(weapon);
    let maxStep = 0;
    let maxBlend = 0;
    for (let i = 1; i < trace.length; i++) {
      const stepYaw = Math.abs(wrapAngle(trace[i]!.yaw - trace[i - 1]!.yaw));
      maxStep = Math.max(maxStep, stepYaw);
      if (trace[i]!.dist > 1) maxBlend = Math.max(maxBlend, stepYaw);
    }
    console.log(`[converge] ${weapon}: largest aim yaw step ${(maxStep * DEG).toFixed(2)} deg per frame (${(maxBlend * DEG).toFixed(2)} deg while blending in, 3 to 1 m)`);
    expect(maxStep * DEG).toBeLessThanOrEqual(2);
    for (const s of trace) {
      // The camera does not move: beyond about 3 m the aim is the camera ray's yaw, exactly.
      if (s.dist > 3.05) expect(s.yaw, `at ${s.dist.toFixed(2)} m`).toBeCloseTo(camYaw, 12);
      if (s.dist < 0.95) expect(Math.abs(wrapAngle(s.yaw - s.toPoint)) * DEG, `at ${s.dist.toFixed(2)} m`).toBeLessThan(1);
    }
    // It does turn: by tens of degrees at the end.
    expect(Math.abs(wrapAngle(trace[trace.length - 1]!.yaw - camYaw)) * DEG).toBeGreaterThan(30);
  });

  it('far away, and with fists, the aim stays on the camera ray', () => {
    for (const weapon of ['pistol', 'fists'] as WeaponId[]) {
      const sim = makeSim({ police: false });
      const f = stand(sim);
      const p = sim.player;
      if (weapon !== 'fists') p.inventory.give(weapon, 50);
      p.inventory.current = weapon;
      const dist = weapon === 'fists' ? 1 : 6;
      const e = sim.spawnCharacter('gang', p.pos.x + f.fx * dist + f.rx * 0.62, p.pos.z + f.fz * dist + f.rz * 0.62);
      e.owner = 'mission';
      e.persistent = true;
      e.armor = 1e6;
      const tgt = () => ({ x: e.pos.x, y: e.pos.y + 0.9 * e.height, z: e.pos.z });
      for (let i = 0; i < 30; i++) {
        const inp = crosshairOn(sim, tgt());
        sim.update(DT, inp);
        expect(p.aimYaw, weapon).toBe(Math.atan2(inp.aimDir.x, inp.aimDir.z));
      }
    }
  });
});
