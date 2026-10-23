// The sim as one player slot sees it. Code written for the single player (activity defs, stunt bonuses) reads
// sim.player, sim.progress, sim.wanted, sim.playerPos() and emits player-scoped events; run for slot k through this
// view, those names mean slot k's and its events carry slot k's playerId. Slot 0's view is the sim itself, so single
// player runs exactly the code it always did.

import { PLAYER_SCOPED_EVENTS } from './events';
import type { PlayerSlot } from './playerSlot';
import type { Sim } from './sim';

const views = new WeakMap<Sim, Map<number, Sim>>();

/** `sim` seen from slot `id` (resolved on each access, so a slot id reused by a later player maps to that player). */
export function slotSim(sim: Sim, slot: PlayerSlot): Sim {
  if (slot.id === 0) return sim;
  let byId = views.get(sim);
  if (!byId) {
    byId = new Map();
    views.set(sim, byId);
  }
  let view = byId.get(slot.id);
  if (!view) {
    view = makeView(sim, slot.id);
    byId.set(slot.id, view);
  }
  return view;
}

function makeView(sim: Sim, id: number): Sim {
  const slotOf = (): PlayerSlot => sim.players.find((s) => s.id === id) ?? sim.players[0]!;
  const events = new Proxy(sim.events, {
    get(target, key) {
      if (key === 'emit') {
        return (type: string, payload: object) => {
          const tagged = PLAYER_SCOPED_EVENTS.has(type) ? { ...payload, ...slotOf().tag } : payload;
          (target.emit as (t: string, p: unknown) => void).call(target, type, tagged);
        };
      }
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return new Proxy(sim, {
    get(target, key, receiver) {
      switch (key) {
        case 'player':
          return slotOf().character;
        case 'playerCtl':
          return slotOf().ctl;
        case 'wanted':
          return slotOf().wanted;
        case 'progress':
          return slotOf().progress;
        case 'cheats':
          return slotOf().cheats;
        case 'cam':
          return slotOf().cam;
        case 'camDir':
          return slotOf().camDir;
        case 'lastInput':
          return slotOf().input;
        case 'controlLock':
          return slotOf().controlLock;
        case 'deathKind':
          return slotOf().deathKind;
        case 'deathTimer':
          return slotOf().deathTimer;
        case 'deathLevel':
          return slotOf().deathLevel;
        case 'playerDown':
          return slotOf().down;
        case 'playerPos':
          return (pid?: number) => (pid === undefined ? slotOf().pos() : target.playerPos(pid));
        case 'events':
          return events;
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
    set(target, key, value) {
      if (key === 'controlLock') {
        slotOf().controlLock = value as number;
        return true;
      }
      return Reflect.set(target, key, value);
    },
  });
}
