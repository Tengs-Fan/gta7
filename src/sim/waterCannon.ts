// The fire truck's water cannon: held fire at its wheel sprays water where the camera looks (the gun's control in other
// vehicles). Fires within the jet's reach and cone take water; a burning car the jet plays on for SOAK_TIME is put out.

import type { Vehicle } from './entities';
import type { Sim } from './sim';
import { registerSystem } from './systems';

/** Reach of the jet on the ground (m), and the half-angle of the cone it soaks (rad). */
export const JET_REACH = 26;
export const JET_CONE = 0.3;
/** Seconds of water that put out a burning car nobody's job looks after. */
export const SOAK_TIME = 1.5;

export interface WaterJet {
  /** The nozzle, on the cab roof. */
  ox: number;
  oy: number;
  oz: number;
  /** Where it points: a unit vector, its pitch kept between JET_PITCH_MIN and JET_PITCH_MAX. */
  dx: number;
  dy: number;
  dz: number;
  /** How far from the nozzle it comes down (m, on the ground): JET_REACH, or nearer when aimed down. */
  reach: number;
  /** The sim frame it sprays in (a jet from an earlier frame has stopped). */
  frame: number;
}

const JET_PITCH_MIN = -0.25;
const JET_PITCH_MAX = 0.45;

const jets = new WeakMap<Vehicle, WaterJet>();
const soaked = new WeakMap<Vehicle, number>();

/** The jet `v` sprays in sim frame `frame` (the latest one), or null. */
export function waterJetOf(v: Vehicle, frame: number): WaterJet | null {
  const jet = jets.get(v);
  return jet && jet.frame === frame ? jet : null;
}

/** Whether the ground point (x, z) is in the jet: within JET_REACH of the nozzle and JET_CONE of its heading. */
export function jetReaches(jet: WaterJet, x: number, z: number, radius = 0): boolean {
  const dx = x - jet.ox;
  const dz = z - jet.oz;
  const d = Math.hypot(dx, dz);
  if (d > jet.reach + radius) return false;
  if (d < 2 + radius) return true;
  const h = Math.hypot(jet.dx, jet.dz) || 1;
  const cos = (dx * jet.dx + dz * jet.dz) / (d * h);
  return Math.acos(Math.max(-1, Math.min(1, cos))) <= JET_CONE + Math.atan2(radius, d);
}

function updateJets(sim: Sim, dt: number): void {
  for (const slot of sim.players) {
    const p = slot.character;
    const v = p.vehicle;
    if (!v || !v.spec.waterCannon) continue;
    const inp = slot.input;
    const on = (inp.fire || inp.firePressed) && v.driver === p && v.drivable && !slot.down && slot.controlLock <= 0;
    if (!on) {
      jets.delete(v);
      continue;
    }
    const h = Math.hypot(inp.aimDir.x, inp.aimDir.z);
    const yaw = h > 1e-6 ? Math.atan2(inp.aimDir.x, inp.aimDir.z) : v.heading;
    const pitch = Math.max(JET_PITCH_MIN, Math.min(JET_PITCH_MAX, Math.asin(Math.max(-1, Math.min(1, inp.aimDir.y))) + 0.12));
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const rise = v.spec.height + 0.15;
    // Aimed down, the stream meets the ground where a line along its pitch would, a third further for its arc.
    const reach = pitch < 0 ? Math.min(JET_REACH, (rise / -Math.tan(pitch)) * 1.35) : JET_REACH;
    jets.set(v, {
      reach,
      ox: v.pos.x + fx * 0.6,
      oy: v.pos.y + rise,
      oz: v.pos.z + fz * 0.6,
      dx: Math.sin(yaw) * Math.cos(pitch),
      dy: Math.sin(pitch),
      dz: Math.cos(yaw) * Math.cos(pitch),
      frame: sim.frame,
    });
  }
  // Whatever the jets play on: a burning car is put out after SOAK_TIME of water (a job's fires are its own business).
  for (const v of sim.vehicles) {
    if (v.removed || !v.burning || v.destroyed || v.missionTag === 'fire') continue;
    let wet = false;
    for (const slot of sim.players) {
      const truck = slot.character.vehicle;
      const jet = truck ? waterJetOf(truck, sim.frame) : null;
      if (jet && truck !== v && jetReaches(jet, v.pos.x, v.pos.z, v.halfL)) wet = true;
    }
    if (!wet) continue;
    const t = (soaked.get(v) ?? 0) + dt;
    soaked.set(v, t);
    if (t >= SOAK_TIME) {
      v.burning = false;
      v.burnTimer = 0;
      v.health = Math.max(v.health, 1);
      soaked.delete(v);
    }
  }
}

registerSystem({ id: 'waterCannon', slot: 'afterPlayers', update: updateJets });
