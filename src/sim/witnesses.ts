// Witnesses: a crime the police did not see (WantedSystem.crime, a 'cop' witness crime) that a civilian did is phoned
// in by him a few seconds later, and then counts as if the police had seen it. Stopping him first (killing or knocking
// him down) loses the call; running away from the scene does not. One call per incident, however many saw it.
// Runs only while sim.streetCrime.witnesses is on, from its own random generator.

import { Rng } from '../core/rng';
import type { Character } from './entities';
import type { PlayerSlot } from './playerSlot';
import type { Sim } from './sim';
import type { SimSystem } from './systems';
import { CRIMES, type CrimeType } from './wanted';

/** A civilian this close (m) with a clear line of sight sees the crime. */
export const WITNESS_RANGE = 32;
/** The call gets through this long (s) after the crime: CALL_MIN to CALL_MAX. */
export const CALL_MIN = 3.5;
export const CALL_MAX = 7.5;
/** Further crimes by the same player this soon (s) and this close (m) to a call under way are the same incident. */
const INCIDENT_TIME = 12;
const INCIDENT_DIST = 30;

export interface WitnessCall {
  id: number;
  slot: PlayerSlot;
  caller: Character;
  /** The gravest crime of the incident so far, and where it happened. */
  type: CrimeType;
  x: number;
  z: number;
  at: number;
  due: number;
  /** 'calling', 'reported' (the stars came), or 'lost' (the caller was stopped). */
  state: 'calling' | 'reported' | 'lost';
  endedAt: number;
}

export class WitnessSystem implements SimSystem {
  readonly id = 'witnesses';
  readonly slot = 'afterCombat' as const;
  readonly calls: WitnessCall[] = [];
  /** Every call made (also those over), for tests and telemetry. */
  readonly log: WitnessCall[] = [];
  private readonly rng: Rng;
  private ids = 0;

  constructor(private readonly sim: Sim) {
    this.rng = new Rng(((sim.seed * 1597334677) ^ 0x77697473) >>> 0);
  }

  reset(): void {
    this.calls.length = 0;
  }

  /** A crime by `slot`'s player at (x, z) that no officer saw: the nearest civilian who did takes out his phone. */
  witnessed(type: CrimeType, x: number, z: number, slot: PlayerSlot): void {
    const sim = this.sim;
    const open = this.calls.find((c) => c.state === 'calling' && c.slot === slot && sim.time - c.at < INCIDENT_TIME && Math.hypot(c.x - x, c.z - z) < INCIDENT_DIST);
    if (open) {
      if (CRIMES[type].heat > CRIMES[open.type].heat) open.type = type;
      return;
    }
    const culprit = slot.character;
    let best: Character | null = null;
    let bd = WITNESS_RANGE;
    const y = sim.world.groundHeight(x, z) + 1.2;
    for (const c of sim.characters) {
      if (c.removed || !c.alive || c.role !== 'civilian' || !c.brain || c.state !== 'normal' || c.brain.mode === 'stand') continue;
      const d = Math.hypot(c.pos.x - x, c.pos.z - z);
      // The one he is beating up (the crime is where he stands) is in no state to call.
      if (c.lastHitBy === culprit && d < 1.5) continue;
      if (d >= bd) continue;
      if (!sim.world.lineOfSight(c.pos.x, c.pos.y + 1.6, c.pos.z, x, y, z)) continue;
      bd = d;
      best = c;
    }
    if (!best) return;
    const call: WitnessCall = { id: ++this.ids, slot, caller: best, type, x, z, at: sim.time, due: sim.time + this.rng.range(CALL_MIN, CALL_MAX), state: 'calling', endedAt: -1 };
    this.calls.push(call);
    this.log.push(call);
    best.phoneTimer = call.due - sim.time;
    const b = best.brain!;
    // Standing about, he stops to call; already running, he calls as he runs.
    if (b.mode !== 'flee' && b.mode !== 'fight') {
      b.mode = 'phone';
      b.modeTimer = call.due - sim.time + 1;
      best.heading = Math.atan2(x - best.pos.x, z - best.pos.z);
    }
    sim.events.emit('witnessCall', { caller: best, x, z, started: true });
  }

  /**
   * The player of `slot` left the world (multiplayer): his calls under way are lost. Slot 0 is reused by the next player
   * to join, who must not get the stars for what the last one did.
   */
  forget(slot: PlayerSlot): void {
    for (const call of this.calls) {
      if (call.state !== 'calling' || call.slot !== slot) continue;
      call.state = 'lost';
      call.endedAt = this.sim.time;
      call.caller.phoneTimer = 0;
      this.sim.events.emit('witnessCall', { caller: call.caller, x: call.x, z: call.z, started: false });
    }
    for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i]!.state !== 'calling') this.calls.splice(i, 1);
  }

  update(sim: Sim, _dt: number): void {
    for (const call of this.calls) {
      if (call.state !== 'calling') continue;
      const c = call.caller;
      // Killed or knocked down, the call is lost; gone off out of sight (despawned far away), it still goes through.
      if ((!c.removed && (!c.alive || c.state === 'knocked' || c.state === 'dead')) || call.slot.down) {
        call.state = 'lost';
        call.endedAt = sim.time;
        c.phoneTimer = 0;
        sim.events.emit('witnessCall', { caller: c, x: call.x, z: call.z, started: false });
        continue;
      }
      c.phoneTimer = Math.max(0, call.due - sim.time);
      if (sim.time < call.due) continue;
      call.state = 'reported';
      call.endedAt = sim.time;
      c.phoneTimer = 0;
      call.slot.wanted.reported(call.type, call.x, call.z);
      if (!c.removed && c.brain?.mode === 'phone') sim.peds.flee(c, call.x, call.z, call.slot.character);
      sim.events.emit('witnessCall', { caller: c, x: call.x, z: call.z, started: false });
    }
    for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i]!.state !== 'calling') this.calls.splice(i, 1);
  }
}
