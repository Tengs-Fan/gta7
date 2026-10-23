// Routing sim events to clients: player-scoped events go to the player they concern, world events to the clients
// that are near them or see an entity they involve.

import { toNetEvent, type NetEvent, type NetRef } from '../src/net/protocol';
import { PLAYER_SCOPED_EVENTS } from '../src/sim/events';
import type { Viewer } from '../src/sim/snapshot';

/** Events about one player (HUD, money, wanted level, respawn, activities), not about the world. */
export { PLAYER_SCOPED_EVENTS };

/** World events heard further than the interest radius. */
const FAR_EVENTS: ReadonlyMap<string, number> = new Map([['explosion', 600]]);

export interface RoutedEvent {
  ev: NetEvent;
  tick: number;
  scoped: boolean;
  /** Position for distance filtering, when the event has one. */
  x: number | null;
  z: number | null;
  refs: number[];
}

const isRef = (v: unknown): v is NetRef => !!v && typeof v === 'object' && typeof (v as NetRef).$id === 'number';

/** `holderOf` maps a payload's sim playerId (undefined: slot 0) to the network playerId of the client controlling it. */
export function classifyEvent(type: string, payload: unknown, holderOf: (simPlayerId: number | undefined) => number): RoutedEvent {
  const scoped = PLAYER_SCOPED_EVENTS.has(type);
  const simPid = payload && typeof payload === 'object' ? (payload as { playerId?: unknown }).playerId : undefined;
  const ev = toNetEvent(type, payload, 0);
  ev.playerId = scoped ? holderOf(typeof simPid === 'number' ? simPid : undefined) : 0;
  const d = ev.data;
  let x: number | null = null;
  let z: number | null = null;
  if (typeof d.x === 'number' && typeof d.z === 'number') {
    x = d.x;
    z = d.z;
  } else if (typeof d.fx === 'number' && typeof d.fz === 'number') {
    x = d.fx;
    z = d.fz;
  }
  const refs: number[] = [];
  for (const v of Object.values(d)) if (isRef(v)) refs.push(v.$id);
  return { ev, tick: 0, scoped, x, z, refs };
}

export function eventRelevant(e: RoutedEvent, playerId: number, viewers: readonly Viewer[], interest: ReadonlySet<number>, radius: number): boolean {
  if (e.scoped) return e.ev.playerId === playerId;
  if (e.ev.type === 'lightning') return true;
  for (const id of e.refs) if (interest.has(id)) return true;
  if (e.x !== null && e.z !== null) {
    const r = FAR_EVENTS.get(e.ev.type) ?? radius;
    for (const v of viewers) if (Math.hypot(e.x - v.x, e.z - v.z) <= r) return true;
    return false;
  }
  // Nothing to place it by (and no entity the client knows): every client gets it.
  return e.refs.length === 0;
}
