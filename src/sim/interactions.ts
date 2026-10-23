// Markers the player can use on foot (gun shops, safehouse, mission starts)
// and drive-in garages (Spray Shack).

import { rectContains, type Poi } from '../world/layout';
import { Inventory } from './entities';
import type { PlayerSlot } from './playerSlot';
import type { Sim } from './sim';
import type { PlayerView } from './viewState';
import { WEAPON_ORDER, WEAPONS, weaponKindOf, type WeaponId } from './specs';
import { HELI_SIGHT } from './wanted';

export type MarkerKind = 'mission' | 'gunshop' | 'save';

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
}

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
  // Every weapon with a price: the first guns in key order, then the newer weapons from the cheapest up.
  const sold = WEAPON_ORDER.filter((id) => WEAPONS[id] && WEAPONS[id].price > 0);
  const first = sold.slice(0, 5);
  const rest = sold.slice(5).sort((a, b) => WEAPONS[a].price - WEAPONS[b].price);
  for (const id of [...first, ...rest]) {
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
    }
  }

  /** An on-foot interaction confirms the exit instead of keeping its vehicle job alive for a possible cheat. */
  private finishExitedJob(): void {
    const sim = this.sim;
    if (sim.player.onFoot && sim.activities.job && sim.activities.job.kind !== 'rampage') {
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
    // A bat or a knife is bought once: there is no ammo to top up.
    if (item.weapon && p.inventory.has(item.weapon) && weaponKindOf(item.weapon) === 'melee') return `You already have the ${WEAPONS[item.weapon].name}.`;
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
