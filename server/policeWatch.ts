// What the police do to each player of a room, for /status: rounds that passed a player and damage police dealt him,
// and for every police unit whom it works for and whom it actually targets. Validation reads it to tell "chasing
// player A" from "aiming at the bystander next to him" (VAL-MPX-002).

import type { Character, Vehicle } from '../src/sim/entities';
import type { Room } from './room';

/** A police round whose line passes this close (m) to a player's chest counts as aimed at him. */
const AIMED_AT = 2;
/** Rounds are only counted this far along their line (m); the police fire from 32 m at most. */
const RANGE = 80;

export interface PoliceTally {
  /** Police rounds whose line passed the player. */
  shotsAt: number;
  /** Damage events with this player as the victim and a police officer as the attacker. */
  hits: number;
  /** Health police fire took from him. */
  healthLost: number;
}

export interface PoliceUnitStatus {
  kind: 'car' | 'officer' | 'heli';
  id: number;
  /**
   * The player (name) whose pursuit the unit works for, or null when its slot has no player. A unit nobody has tagged
   * (an ambient patrol) works for slot 0 whatever his stars, so read it together with `active`.
   */
  works: string | null;
  /** The unit is in pursuit: a car driving the chase policy, an officer running down his target, a helicopter. */
  active: boolean;
  /** The player the unit's driver or brain targets right now, or null. */
  target: string | null;
  x: number;
  z: number;
}

export class PoliceWatch {
  private readonly tallies = new Map<number, PoliceTally>();

  constructor(private readonly room: Room) {}

  tally(playerId: number): PoliceTally {
    let t = this.tallies.get(playerId);
    if (!t) this.tallies.set(playerId, (t = { shotsAt: 0, hits: 0, healthLost: 0 }));
    return t;
  }

  onSimEvent(type: string, payload: unknown): void {
    if (type === 'weaponFired') {
      const e = payload as { shooter: Character | null; x: number; y: number; z: number; dx: number; dy: number; dz: number };
      if (!e.shooter?.isLaw) return;
      const len = Math.hypot(e.dx, e.dy, e.dz) || 1;
      for (const m of this.room.members.values()) {
        if (m.slot === null) continue;
        const c = this.room.slots.character(m.slot);
        if (!c.alive || c.removed) continue;
        const at = c.vehicle ?? c;
        const px = at.pos.x - e.x;
        const py = at.pos.y + 1 - e.y;
        const pz = at.pos.z - e.z;
        const along = (px * e.dx + py * e.dy + pz * e.dz) / len;
        if (along <= 0 || along > RANGE) continue;
        if (Math.hypot(px - (e.dx / len) * along, py - (e.dy / len) * along, pz - (e.dz / len) * along) < AIMED_AT) this.tally(m.playerId).shotsAt++;
      }
    } else if (type === 'damage') {
      const e = payload as { victim: Character; attacker: Character | null; healthLoss: number };
      if (!e.attacker?.isLaw) return;
      for (const m of this.room.members.values()) {
        if (m.slot === null || this.room.slots.character(m.slot) !== e.victim) continue;
        const t = this.tally(m.playerId);
        t.hits++;
        t.healthLost += e.healthLoss;
      }
    }
  }

  /** Every live police unit with the player it works for and the one it targets. */
  units(): PoliceUnitStatus[] {
    const room = this.room;
    const police = room.sim.police;
    const names = new Map<number, string>();
    const chars = new Map<Character | Vehicle, string>();
    for (const m of room.members.values()) {
      if (m.slot === null) continue;
      const c = room.slots.character(m.slot);
      names.set(room.sim.slotOf(c)?.id ?? -1, m.name);
      chars.set(c, m.name);
      if (c.vehicle) chars.set(c.vehicle, m.name);
    }
    const whom = (t: Character | Vehicle | null | undefined): string | null => (t ? chars.get(t) ?? null : null);
    const out: PoliceUnitStatus[] = [];
    const r1 = (v: number) => Math.round(v * 10) / 10;
    for (const v of room.sim.vehicles) {
      if (v.removed || v.owner !== 'police') continue;
      out.push({ kind: 'car', id: v.id, works: names.get(police.targetSlotOf(v)) ?? null, active: v.ai?.policy === 'chase', target: whom(v.ai?.target), x: r1(v.pos.x), z: r1(v.pos.z) });
    }
    for (const o of room.sim.characters) {
      if (o.removed || !o.alive || !o.isLaw || o.vehicle) continue;
      out.push({ kind: 'officer', id: o.id, works: names.get(police.targetSlotOf(o)) ?? null, active: o.brain?.mode === 'chase' || o.brain?.mode === 'fight', target: whom(o.brain?.target), x: r1(o.pos.x), z: r1(o.pos.z) });
    }
    for (const h of room.sim.helis) {
      if (h.removed) continue;
      out.push({ kind: 'heli', id: h.id, works: names.get(police.targetSlotOf(h)) ?? null, active: !h.crashing, target: null, x: r1(h.pos.x), z: r1(h.pos.z) });
    }
    return out;
  }
}
