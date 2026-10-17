// Markers the player can use on foot (gun shops, safehouse, mission starts)
// and drive-in garages (Spray Shack).

import { rectContains, type Poi } from '../world/layout';
import type { Sim } from './sim';
import { WEAPONS, type WeaponId } from './specs';

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
  private sprayBusy: string | null = null;

  constructor(private readonly sim: Sim) {
    for (const poi of sim.world.layout.pois) {
      if (poi.kind === 'gunshop') this.markers.push({ id: poi.id, kind: 'gunshop', x: poi.x, z: poi.z, radius: 1.5, label: 'Press E to shop at Bang Bang Guns', color: 0xff8a1f, ref: poi.id });
      if (poi.kind === 'safehouse') this.markers.push({ id: poi.id, kind: 'save', x: poi.x, z: poi.z, radius: 1.5, label: 'Press E to save your game', color: 0x55ccff, ref: poi.id });
    }
  }

  /** The marker under the player (on foot), if any. */
  current(): Marker | null {
    const sim = this.sim;
    const p = sim.player;
    if (p.state !== 'normal' || sim.playerDown) return null;
    for (const m of this.markers) {
      if (Math.hypot(m.x - p.pos.x, m.z - p.pos.z) <= m.radius) return m;
    }
    return null;
  }

  /** HUD prompt for the marker under the player, or for retrying a failed mission. */
  prompt(): string | null {
    const m = this.current();
    if (!m) return this.retryPrompt();
    if (m.kind === 'mission' && (this.sim.missions.active || this.sim.wanted.level > 0)) {
      return this.sim.wanted.level > 0 ? 'Lose the cops before starting a mission.' : null;
    }
    return m.label;
  }

  /** Offers the retry of a mission that just failed (markers under the player come first). */
  private retryPrompt(): string | null {
    const sim = this.sim;
    const def = sim.missions.retryOffer();
    if (!def) return null;
    const p = sim.player;
    // In a vehicle the key is the horn (see Input), so the retry is taken on foot.
    if (p.state === 'inVehicle') return `Get out of the vehicle to retry "${def.title}"`;
    if (!p.onFoot) return null;
    if (sim.wanted.level > 0) return 'Lose the cops before retrying.';
    return `Press E to retry "${def.title}"`;
  }

  interact(): void {
    const sim = this.sim;
    const m = this.current();
    if (!m) {
      sim.missions.retryNow();
      return;
    }
    switch (m.kind) {
      case 'gunshop':
        sim.events.emit('shopOpen', { poi: m.ref });
        break;
      case 'save':
        if (sim.wanted.level > 0) {
          sim.events.emit('message', { text: "You can't save while the cops are after you.", duration: 3 });
          return;
        }
        if (sim.missions.active) {
          sim.events.emit('message', { text: "You can't save during a mission.", duration: 3 });
          return;
        }
        sim.player.health = sim.player.maxHealth;
        sim.events.emit('saveRequested', { poi: m.ref });
        break;
      case 'mission':
        if (sim.wanted.level > 0 || sim.missions.active) return;
        sim.missions.start(m.ref);
        break;
    }
  }

  /** Gun shop purchase. Returns an error message or null on success. */
  buy(itemId: string): string | null {
    const sim = this.sim;
    const item = shopItems().find((i) => i.id === itemId);
    if (!item) return 'Unknown item.';
    const p = sim.player;
    let price = item.price;
    if (item.weapon && p.inventory.has(item.weapon)) price = WEAPONS[item.weapon].ammoPrice;
    if (item.id === 'armor' && p.armor >= 100) return 'You are already wearing armor.';
    if (item.id === 'health' && p.health >= p.maxHealth) return 'You are already healthy.';
    if (!sim.progress.spend(price)) return "You can't afford that.";
    if (item.weapon) {
      const had = p.inventory.has(item.weapon);
      p.inventory.give(item.weapon, item.ammo);
      if (!had) p.inventory.current = item.weapon;
    } else if (item.id === 'armor') {
      p.armor = 100;
    } else if (item.id === 'health') {
      p.health = p.maxHealth;
    }
    sim.events.emit('money', { amount: -price });
    return null;
  }

  /** Price the shop shows for an item right now (ammo refill if already owned). */
  priceOf(item: ShopItem): number {
    if (item.weapon && this.sim.player.inventory.has(item.weapon)) return WEAPONS[item.weapon].ammoPrice;
    return item.price;
  }

  update(_dt: number): void {
    const sim = this.sim;
    const p = sim.player;
    const v = p.vehicle;
    if (!v || sim.playerDown) {
      this.sprayBusy = null;
      return;
    }
    let inside: Poi | null = null;
    for (const poi of sim.world.layout.pois) {
      if (poi.kind === 'spray' && poi.bay && rectContains(poi.bay, v.pos.x, v.pos.z)) inside = poi;
    }
    if (!inside) {
      this.sprayBusy = null;
      return;
    }
    if (this.sprayBusy === inside.id || v.speed > 4) return;
    this.sprayBusy = inside.id;
    // A mission has pinned a minimum wanted level (The Big Score): a respray would wipe it.
    if (sim.wanted.floor > 0) {
      sim.events.emit('message', { text: "Spray Shack: not with the whole city watching. Nobody's touching this car.", duration: 3.5 });
      return;
    }
    const wanted = sim.wanted.level > 0;
    const damaged = v.health < v.spec.health * 0.98 || v.burning;
    if (!wanted && !damaged) {
      sim.events.emit('message', { text: "Spray Shack: your ride's already clean. Come back with some heat.", duration: 3.5 });
      return;
    }
    if (!v.drivable) return;
    if (!sim.progress.spend(SPRAY_COST)) {
      sim.events.emit('message', { text: `No money, no spray! ($${SPRAY_COST})`, duration: 3 });
      return;
    }
    sim.controlLock = 2.2;
    sim.events.emit('fade', { duration: 2.2 });
    v.health = v.spec.health;
    v.burning = false;
    v.burnTimer = 0;
    const colors = v.spec.colors.filter((c) => c !== v.color);
    if (colors.length > 0) v.color = sim.rng.pick(colors);
    sim.wanted.clear();
    sim.events.emit('sprayed', { cost: SPRAY_COST });
    sim.events.emit('money', { amount: -SPRAY_COST });
    sim.events.emit('message', { text: wanted ? 'New paint, new plates. The cops have lost you.' : 'Good as new.', duration: 3.5 });
  }
}
