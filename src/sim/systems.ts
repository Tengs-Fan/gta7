// Ordered extension points in Sim.update. The built-in steps keep their calls in sim.ts; a new system
// registers into one of these slots instead of editing the update body.

import type { Sim } from './sim';

/** In the order they run. Each runs right after the built-in step named beside it. */
export const SYSTEM_SLOTS = [
  /** After the clock, weather and input bookkeeping, before the player's controller. */
  'preInput',
  /** After PlayerController.update. */
  'afterPlayers',
  /** After vehicle AI, pedestrian AI and police decisions, before physics. */
  'afterTraffic',
  /** After the physics steps, sanitize and occupant sync. */
  'afterPhysics',
  /** After combat, character timers and wanted. */
  'afterCombat',
  /** After traffic/ped streaming, pickups and Interactions.update. */
  'afterInteractions',
  /** After activities and missions. */
  'afterMissions',
  /** At the very end of the update, after compaction and the final sanitize. */
  'late',
] as const;

export type SystemSlot = typeof SYSTEM_SLOTS[number];

export interface SimSystem {
  id: string;
  slot: SystemSlot;
  update(sim: Sim, dt: number): void;
  /** Called by Sim.resetSystems (a new game) so a system can drop state it keeps outside the sim. */
  reset?(sim: Sim): void;
}

/** Systems every new Sim installs. Order within a slot is registration order. */
const globalSystems: SimSystem[] = [];

export function registerSystem(system: SimSystem): void {
  if (globalSystems.some((s) => s.id === system.id)) throw new Error(`system already registered: ${system.id}`);
  globalSystems.push(system);
}

export function unregisterSystem(id: string): void {
  const i = globalSystems.findIndex((s) => s.id === id);
  if (i >= 0) globalSystems.splice(i, 1);
}

export function registeredSystems(): readonly SimSystem[] {
  return globalSystems;
}

/** The systems of one Sim, grouped by slot. */
export class SystemSlots {
  private readonly bySlot = new Map<SystemSlot, SimSystem[]>();

  add(system: SimSystem): void {
    if (!SYSTEM_SLOTS.includes(system.slot)) throw new Error(`unknown system slot: ${system.slot}`);
    if (this.all().some((s) => s.id === system.id)) throw new Error(`system already added: ${system.id}`);
    const list = this.bySlot.get(system.slot);
    if (list) list.push(system);
    else this.bySlot.set(system.slot, [system]);
  }

  remove(id: string): void {
    for (const list of this.bySlot.values()) {
      const i = list.findIndex((s) => s.id === id);
      if (i >= 0) list.splice(i, 1);
    }
  }

  run(slot: SystemSlot, sim: Sim, dt: number): void {
    const list = this.bySlot.get(slot);
    if (!list) return;
    for (const s of list) s.update(sim, dt);
  }

  reset(sim: Sim): void {
    for (const s of this.all()) s.reset?.(sim);
  }

  all(): SimSystem[] {
    return SYSTEM_SLOTS.flatMap((slot) => this.bySlot.get(slot) ?? []);
  }
}
