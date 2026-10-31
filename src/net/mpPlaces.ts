// The places a multiplayer client marks in the world and what standing on one says: the head-to-head Street Run
// starts, and the single-player places (contacts, the safehouse, properties, Lou's export board, gun shops, the Gull
// Regatta at the Marina, AzuraLink's stations) with the reason they do nothing here. The server's sim gives the same
// answer if E is pressed there. Pure TypeScript.

import { MP_NO_MONORAIL } from '../sim/activities/monorail';
import { places } from '../sim/activities/places';
import { MP_NO_REGATTA } from '../sim/activities/regatta';
import { streetRunCourses } from '../sim/activities/streetRun';
import { FOR_SALE, monorailMarker, MP_NO_EXPORT, MP_NO_PROPERTY, MP_NO_SAVE, type Marker } from '../sim/interactions';
import { CONTACTS, contactColorNumber, contactUnlocked } from '../sim/missions/contacts';
import { STORY } from '../sim/missions';
import { MP_NO_STORY } from '../sim/missions/runner';
import { Progress } from '../sim/progress';
import type { InteractionsView, PlayerView } from '../sim/viewState';
import type { Sim } from '../sim/sim';
import type { StaticWorld } from '../world/staticWorld';
import { RACE_START_REACH } from './lobby';

export const MP_NO_SHOP = 'Bang Bang Guns is closed in multiplayer.';

/** As a contact's marker in single player (MissionSystem's MARKER_RADIUS). */
const CONTACT_RADIUS = 2.1;

function markersOf(world: StaticWorld): Marker[] {
  const out: Marker[] = [];
  const fresh = new Progress();
  for (const c of CONTACTS) {
    // The contacts a new game knows: a locked one stays out of sight, as in single player.
    if (!contactUnlocked(STORY, fresh, c.id)) continue;
    const poi = world.layout.pois.find((p) => p.id === c.poiId);
    if (poi) out.push({ id: `mp:${c.id}`, kind: 'mission', x: poi.x, z: poi.z, radius: CONTACT_RADIUS, label: MP_NO_STORY, color: contactColorNumber(c), ref: c.id });
  }
  for (const poi of world.layout.pois) {
    if (poi.kind === 'safehouse') out.push({ id: poi.id, kind: 'save', x: poi.x, z: poi.z, radius: 1.5, label: MP_NO_SAVE, color: 0x55ccff, ref: poi.id });
    if (poi.kind === 'gunshop') out.push({ id: poi.id, kind: 'gunshop', x: poi.x, z: poi.z, radius: 1.5, label: MP_NO_SHOP, color: 0xff8a1f, ref: poi.id });
    if (poi.kind === 'marina') out.push({ id: 'regatta', kind: 'regatta', x: poi.x, z: poi.z, radius: 1.5, label: MP_NO_REGATTA, color: 0x50f1d1, ref: 'regatta' });
  }
  const at = places(world);
  out.push({ id: 'export_board', kind: 'exportBoard', x: at.exportBoard.x, z: at.exportBoard.z, radius: 1.5, label: MP_NO_EXPORT, color: 0xffa020, ref: 'carExport' });
  out.push({ id: 'garage', kind: 'garage', x: at.garageMarker.x, z: at.garageMarker.z, radius: 1.5, label: MP_NO_PROPERTY, color: 0x3fd96b, ref: 'garage', blip: { color: FOR_SALE, label: 'G' } });
  out.push({ id: 'pier_arcade', kind: 'business', x: at.arcade.x, z: at.arcade.z, radius: 1.5, label: MP_NO_PROPERTY, color: 0x3fd96b, ref: 'business', blip: { color: FOR_SALE, label: '$' } });
  const bay = at.customsBay;
  out.push({ id: 'azura_customs', kind: 'customs', x: (bay.minX + bay.maxX) / 2, z: (bay.minZ + bay.maxZ) / 2, radius: 0, label: '', color: 0xb36bff, ref: 'customs', blip: { color: '#b36bff', label: 'C' } });
  world.layout.monorail.stations.forEach((s, i) => out.push(monorailMarker(s.foot, i, MP_NO_MONORAIL)));
  // The course list is built from the road graph alone, which streetRunCourses reads off a Sim.
  for (const c of streetRunCourses({ roads: world.roads } as unknown as Sim)) {
    out.push({ id: `race:${c.id}`, kind: 'streetRun', x: c.start.x, z: c.start.z, radius: 8, label: `Press T to race ${c.name} head-to-head`, color: 0x50f1d1, ref: c.id });
  }
  return out;
}

/** The InteractionsView of a multiplayer client. */
export function multiplayerInteractions(world: StaticWorld): InteractionsView {
  const markers = markersOf(world);
  const current = (slot: PlayerView): Marker | null => {
    const p = slot.character;
    if (slot.down || (p.state !== 'normal' && p.state !== 'inVehicle')) return null;
    const at = slot.pos();
    for (const m of markers) {
      const d = Math.hypot(m.x - at.x, m.z - at.z);
      if (m.kind === 'streetRun' ? d <= RACE_START_REACH : p.state === 'normal' && d <= m.radius) return m;
    }
    return null;
  };
  return {
    markers,
    current,
    canSave: () => false,
    prompt: (slot) => (slot ? current(slot)?.label || null : null),
    priceOf: () => 0,
    buy: () => 'Not available in multiplayer.',
  } as InteractionsView;
}
