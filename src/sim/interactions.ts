// Markers the player can use on foot (gun shops, safehouse, mission starts)
// and drive-in garages (Spray Shack).

import { rectContains, type Poi } from '../world/layout';
import { getActivity } from './activities';
import { places } from './activities/places';
import { formatMoney } from '../core/math';
import { BUSINESS_DAILY, BUSINESS_NAME, BUSINESS_PRICE, buyProperty, GARAGE_PRICE, GARAGE_SLOTS, propertyState, storedCars } from './properties';
import { Inventory } from './entities';
import type { PlayerSlot } from './playerSlot';
import type { Sim } from './sim';
import type { PlayerView } from './viewState';
import { WEAPONS, type WeaponId } from './specs';
import { HELI_SIGHT } from './wanted';

export type MarkerKind = 'mission' | 'gunshop' | 'save' | 'exportBoard' | 'courier' | 'garage' | 'business' | 'customs';

export interface Marker {
  id: string;
  kind: MarkerKind;
  x: number;
  z: number;
  radius: number;
  label: string;
  color: number;
  /** Mission markers carry the mission id. */
  ref: string;
  /** A radar and map icon for the place (properties), or none. */
  blip?: { color: string; label: string };
}

/** Property icons: grey while for sale, green once owned. */
const FOR_SALE = '#9aa3ad';
const OWNED = '#3fd96b';

export interface ShopItem {
  id: string;
  label: string;
  price: number;
  weapon: WeaponId | null;
  ammo: number;
}

export const SPRAY_COST = 100;

/** Whether `ammo` more rounds of `weapon` would add any (Inventory.give caps a gun's reserve): a full gun takes no more. */
function roomFor(inv: Inventory, weapon: WeaponId, ammo: number): boolean {
  const s = inv.slots.get(weapon);
  if (!s) return true;
  const probe = new Inventory();
  probe.slots.set(weapon, { ...s });
  probe.give(weapon, ammo);
  return probe.total(weapon) > inv.total(weapon);
}

export function shopItems(): ShopItem[] {
  const items: ShopItem[] = [];
  for (const id of ['pistol', 'smg', 'shotgun', 'rifle', 'rocket'] as const) {
    const w = WEAPONS[id];
    items.push({ id: `buy:${id}`, label: w.name, price: w.price, weapon: id, ammo: w.ammoPack });
  }
  items.push({ id: 'armor', label: 'Body Armor', price: 300, weapon: null, ammo: 0 });
  items.push({ id: 'health', label: 'First Aid', price: 80, weapon: null, ammo: 0 });
  return items;
}

export class Interactions {
  readonly markers: Marker[] = [];
  /** The spray bay each slot's car is in and has been served at. */
  private readonly sprayBusy = new Map<number, string | null>();

  constructor(private readonly sim: Sim) {
    for (const poi of sim.world.layout.pois) {
      if (poi.kind === 'gunshop') this.markers.push({ id: poi.id, kind: 'gunshop', x: poi.x, z: poi.z, radius: 1.5, label: 'Press E to shop at Bang Bang Guns', color: 0xff8a1f, ref: poi.id });
      if (poi.kind === 'safehouse') this.markers.push({ id: poi.id, kind: 'save', x: poi.x, z: poi.z, radius: 1.5, label: 'Press E to save your game', color: 0x55ccff, ref: poi.id });
    }
    const at = places(sim.world);
    this.markers.push({ id: 'export_board', kind: 'exportBoard', x: at.exportBoard.x, z: at.exportBoard.z, radius: 1.5, label: "Press E to take Lou's export list", color: 0xffa020, ref: 'carExport' });
    // On the sidewalk by the courier office's stop, which a car or bike pulls up at (Activities' job prompt).
    this.markers.push({ id: 'garage', kind: 'garage', x: at.garageMarker.x, z: at.garageMarker.z, radius: 1.5, label: '', color: 0x3fd96b, ref: 'garage', blip: { color: FOR_SALE, label: 'G' } });
    this.markers.push({ id: 'pier_arcade', kind: 'business', x: at.arcade.x, z: at.arcade.z, radius: 1.5, label: '', color: 0x3fd96b, ref: 'business', blip: { color: FOR_SALE, label: '$' } });
    // The drive-in bay: a beam over it, never a prompt on foot (radius 0).
    const bay = at.customsBay;
    this.markers.push({ id: 'azura_customs', kind: 'customs', x: (bay.minX + bay.maxX) / 2, z: (bay.minZ + bay.maxZ) / 2, radius: 0, label: '', color: 0xb36bff, ref: 'customs', blip: { color: '#b36bff', label: 'C' } });
    this.markers.push({ id: 'courier_office', kind: 'courier', x: at.courier.x + 3.6, z: at.courier.z, radius: 1.5, label: 'Azura Express: stop a car or bike here and press T for a courier run', color: 0xffd23d, ref: 'courier' });
  }

  /** The marker under the player (on foot), if any. `slot` is slot 0 by default. */
  current(slot: PlayerView = this.sim.players[0]!): Marker | null {
    const p = slot.character;
    if (p.state !== 'normal' || slot.down) return null;
    for (const m of this.markers) {
      if (Math.hypot(m.x - p.pos.x, m.z - p.pos.z) <= m.radius) return m;
    }
    return null;
  }

  /** The safehouse can restore health and save now; an exited vehicle job can be ended by saving. */
  canSave(slot: PlayerView = this.sim.players[0]!): boolean {
    const sim = this.sim;
    return !slot.down && slot.wanted.level === 0 && !sim.missions.active && sim.activities.job?.kind !== 'rampage';
  }

  /** HUD prompt for the marker under the player, or for retrying a failed mission. */
  prompt(slot: PlayerView = this.sim.players[0]!): string | null {
    const sim = this.sim;
    const m = this.current(slot);
    if (!m) return this.vehiclePrompt(slot) ?? this.retryPrompt(slot);
    if (m.kind === 'mission') {
      if (sim.missions.active) return null;
      return this.startBlock(slot, false) ?? m.label;
    }
    if (m.kind === 'garage' || m.kind === 'business') return this.propertyPrompt(m.kind);
    if (m.kind === 'exportBoard') return sim.activities.job?.kind === 'carExport' ? "Press E to read Lou's export list" : m.label;
    if (m.kind === 'save') {
      // As interact() would answer, before E is pressed.
      if (slot.wanted.level > 0) return 'Lose the cops before saving.';
      if (sim.missions.active) return "You can't save during a mission.";
      if (sim.activities.job?.kind === 'rampage') return "You can't save during a rampage.";
    }
    return m.label;
  }

  /**
   * Why a mission cannot be started (or `retry`, retried) right now, as the prompt says it; null if it can. On a
   * rampage: starting a mission would call it off.
   */
  private startBlock(slot: PlayerView, retry: boolean): string | null {
    const sim = this.sim;
    if (slot.wanted.level > 0) return retry ? 'Lose the cops before retrying.' : 'Lose the cops before starting a mission.';
    if (sim.activities.job?.kind === 'rampage') return 'Finish the rampage first.';
    return null;
  }

  /**
   * In a vehicle over a contact's marker, which only works on foot: E is the horn there (see Input), so the
   * prompt says to get out. The car's body may cover the marker without its centre being on it.
   */
  private vehiclePrompt(slot: PlayerView): string | null {
    const sim = this.sim;
    const p = slot.character;
    const v = p.vehicle;
    if (!v || p.state !== 'inVehicle' || slot.down || sim.missions.active) return null;
    for (const m of this.markers) {
      if (m.kind !== 'mission' || Math.hypot(m.x - v.pos.x, m.z - v.pos.z) > m.radius + v.halfW + 0.5) continue;
      const def = sim.missions.defs.find((d) => d.id === m.ref);
      return this.startBlock(slot, false) ?? `Get out of the vehicle to start "${def?.title ?? ''}"`;
    }
    return null;
  }

  /** Offers the retry of a mission that just failed (markers under the player come first). */
  private retryPrompt(slot: PlayerView): string | null {
    const sim = this.sim;
    const def = sim.missions.retryOffer();
    // Failed with the police on him: the offer opens once they are lost.
    if (!def) return sim.missions.retryAfterCops() ? 'Lose the cops before retrying.' : null;
    const p = slot.character;
    const block = this.startBlock(slot, true);
    if (block) return block;
    // In a vehicle the key is the horn (see Input), so the retry is taken on foot.
    if (p.state === 'inVehicle') return `Get out of the vehicle to retry "${def.title}"`;
    if (!p.onFoot) return null;
    return `Press E to retry "${def.title}"`;
  }

  /**
   * The player in `slot` (slot 0 by default) presses E. Story missions belong to slot 0 only, so a marker that starts
   * one does nothing for another slot.
   */
  interact(slot: PlayerView = this.sim.players[0]!): void {
    const sim = this.sim;
    const m = this.current(slot);
    if (!m) {
      if (slot.id !== 0) return;
      // E commits the player's exit. A taxi/vigilante job may still be waiting for FIXMYRIDE's
      // opening F to be undone, but it must not silently block the retry advertised on screen.
      if (sim.missions.retryOffer() && !this.startBlock(slot, true) && slot.character.onFoot) this.finishExitedJob();
      sim.missions.retryNow();
      return;
    }
    switch (m.kind) {
      case 'gunshop':
        sim.events.emit('shopOpen', { poi: m.ref, ...slot.tag });
        break;
      case 'save':
        if (slot.wanted.level > 0) {
          sim.events.emit('message', { text: "You can't save while the cops are after you.", duration: 3, ...slot.tag });
          return;
        }
        if (sim.missions.active) {
          sim.events.emit('message', { text: "You can't save during a mission.", duration: 3, ...slot.tag });
          return;
        }
        // A rampage continues on foot: the heal is no free top-up mid-fight.
        if (sim.activities.job?.kind === 'rampage') {
          sim.events.emit('message', { text: "You can't save during a rampage.", duration: 3, ...slot.tag });
          return;
        }
        if (slot.id === 0) this.finishExitedJob();
        slot.character.health = slot.character.maxHealth;
        sim.events.emit('saveRequested', { poi: m.ref, ...slot.tag });
        break;
      case 'mission':
        if (slot.id !== 0 || sim.missions.active || this.startBlock(slot, false)) return;
        sim.missions.start(m.ref);
        break;
      case 'exportBoard':
        // The list belongs to slot 0's job, as the other jobs do.
        if (slot.id !== 0) return;
        if (sim.activities.job?.kind !== 'carExport') {
          if (sim.missions.active) sim.events.emit('message', { text: 'Finish the mission first.', duration: 3 });
          else if (sim.activities.busy) sim.events.emit('message', { text: 'Finish what you are doing first.', duration: 3 });
          else sim.activities.startExport();
        }
        sim.events.emit('screenOpen', { screen: 'exportBoard', ...slot.tag });
        break;
      case 'courier':
      case 'customs':
        break;
      case 'garage':
      case 'business': {
        if (slot.id !== 0) return;
        const err = propertyState(sim.progress)[m.kind === 'garage' ? 'garage' : 'business'] ? null : buyProperty(sim, m.kind);
        if (err) sim.events.emit('message', { text: err, duration: 3 });
        break;
      }
    }
  }

  /** What a property's marker says: its price while for sale, what it does once owned. */
  private propertyPrompt(kind: 'garage' | 'business'): string {
    const sim = this.sim;
    const s = propertyState(sim.progress);
    if (kind === 'garage') {
      return s.garage
        ? `Your garage: ${storedCars(sim).length}/${GARAGE_SLOTS} cars stored. Park a car in a bay and get out to store it.`
        : `Press E to buy the garage for ${formatMoney(GARAGE_PRICE)} (stores ${GARAGE_SLOTS} cars)`;
    }
    return s.business
      ? `${BUSINESS_NAME}: yours. ${formatMoney(BUSINESS_DAILY)} a day, collected at the safehouse (${formatMoney(s.uncollected)} waiting).`
      : `Press E to buy the ${BUSINESS_NAME} for ${formatMoney(BUSINESS_PRICE)} (${formatMoney(BUSINESS_DAILY)} a day)`;
  }

  /** An on-foot interaction confirms the exit instead of keeping its vehicle job alive for a possible cheat. */
  private finishExitedJob(): void {
    const sim = this.sim;
    const job = sim.activities.job;
    if (sim.player.onFoot && job && job.kind !== 'rampage' && !getActivity(job.kind)?.onFoot) {
      sim.activities.exitUndoable = false;
      sim.activities.toggleJob();
    }
  }

  /** Gun shop purchase. Returns an error message or null on success. */
  buy(itemId: string, slot: PlayerView = this.sim.players[0]!): string | null {
    const sim = this.sim;
    const item = shopItems().find((i) => i.id === itemId);
    if (!item) return 'Unknown item.';
    const p = slot.character;
    let price = item.price;
    if (item.weapon && p.inventory.has(item.weapon)) price = WEAPONS[item.weapon].ammoPrice;
    if (item.id === 'armor' && p.armor >= 100) return 'You are already wearing armor.';
    if (item.id === 'health' && p.health >= p.maxHealth) return 'You are already healthy.';
    if (item.weapon && !roomFor(p.inventory, item.weapon, item.ammo)) return "You can't carry any more.";
    if (!slot.progress.spend(price)) return "You can't afford that.";
    if (item.weapon) {
      const had = p.inventory.has(item.weapon);
      p.inventory.give(item.weapon, item.ammo);
      if (!had) p.inventory.current = item.weapon;
    } else if (item.id === 'armor') {
      p.armor = 100;
    } else if (item.id === 'health') {
      p.health = p.maxHealth;
    }
    sim.events.emit('money', { amount: -price, ...slot.tag });
    return null;
  }

  /** Price the shop shows for an item right now (ammo refill if already owned). */
  priceOf(item: ShopItem, slot: PlayerView = this.sim.players[0]!): number {
    if (item.weapon && slot.character.inventory.has(item.weapon)) return WEAPONS[item.weapon].ammoPrice;
    return item.price;
  }

  update(_dt: number): void {
    for (const slot of this.sim.players) this.updateSpray(slot);
    const s = propertyState(this.sim.progress);
    for (const m of this.markers) {
      if (m.kind === 'garage' && m.blip) m.blip.color = s.garage ? OWNED : FOR_SALE;
      if (m.kind === 'business' && m.blip) m.blip.color = s.business ? OWNED : FOR_SALE;
    }
  }

  private updateSpray(slot: PlayerSlot): void {
    const sim = this.sim;
    const v = slot.character.vehicle;
    if (!v || slot.down) {
      this.sprayBusy.set(slot.id, null);
      return;
    }
    let inside: Poi | null = null;
    for (const poi of sim.world.layout.pois) {
      if (poi.kind === 'spray' && poi.bay && rectContains(poi.bay, v.pos.x, v.pos.z)) inside = poi;
    }
    if (!inside) {
      this.sprayBusy.set(slot.id, null);
      return;
    }
    if (this.sprayBusy.get(slot.id) === inside.id || v.speed > 4) return;
    this.sprayBusy.set(slot.id, inside.id);
    const wantedSys = slot.wanted;
    // A mission has pinned a minimum wanted level (The Big Score): a respray would wipe it.
    if (wantedSys.floor > 0) {
      sim.events.emit('message', { text: "Spray Shack: not with the whole city watching. Nobody's touching this car.", duration: 3.5, ...slot.tag });
      return;
    }
    const level = wantedSys.level;
    const wanted = level > 0;
    const damaged = v.health < v.spec.health * 0.98 || v.burning;
    if (!wanted && !damaged) {
      sim.events.emit('message', { text: "Spray Shack: your ride's already clean. Come back with some heat.", duration: 3.5, ...slot.tag });
      return;
    }
    if (!v.drivable) return;
    // New plates are no use to a car the police watched drive in: lose them first (stars flashing).
    // The roof hides the bay from above, so a helicopter that has him counts within its sight range.
    const bay = inside.bay!;
    const bx = (bay.minX + bay.maxX) / 2;
    const bz = (bay.minZ + bay.maxZ) / 2;
    const heli = sim.helis.some((h) => !h.removed && !h.destroyed && Math.hypot(h.pos.x - bx, h.pos.z - bz) <= HELI_SIGHT);
    if (wanted && !wantedSys.searching && (heli || wantedSys.copWitness(bx, bz, 40))) {
      sim.events.emit('message', { text: 'Spray Shack: They saw you drive in!', duration: 3.5, ...slot.tag });
      return;
    }
    // A repair costs the base price; a respray costs it once per star.
    const price = SPRAY_COST * Math.max(1, level);
    if (!slot.progress.spend(price)) {
      sim.events.emit('message', { text: `No money, no spray! ($${price})`, duration: 3, ...slot.tag });
      return;
    }
    slot.controlLock = 2.2;
    sim.events.emit('fade', { duration: 2.2, ...slot.tag });
    v.health = v.spec.health;
    v.burning = false;
    v.burnTimer = 0;
    const colors = v.spec.colors.filter((c) => c !== v.color);
    if (colors.length > 0) v.color = sim.rng.pick(colors);
    wantedSys.clear();
    sim.events.emit('sprayed', { cost: price, ...slot.tag });
    sim.events.emit('money', { amount: -price, ...slot.tag });
    sim.events.emit('message', { text: `${wanted ? 'New paint, new plates. The cops have lost you.' : 'Good as new.'} ($${price})`, duration: 3.5, ...slot.tag });
  }
}
