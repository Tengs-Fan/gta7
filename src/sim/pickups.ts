// World pickups: health, armour, weapons, dropped cash, hidden packages and rampage icons.

import { WATER_Y } from '../world/constants';
import { Pickup, type PickupKind } from './entities';
import type { Sim } from './sim';
import { WEAPONS, type WeaponId } from './specs';

export const PACKAGE_COUNT = 20;
export const PACKAGE_REWARD = 100;
export const PACKAGE_BONUS = 25000;

export class PickupSystem {
  constructor(private readonly sim: Sim) {
    this.placeWorldPickups();
  }

  /** Deterministic placement on spread-out open spots. */
  private placeWorldPickups(): void {
    const sim = this.sim;
    const spots = sim.world.layout.openSpots.filter((s) => sim.world.isFree(s.x, s.z, 0.6) && sim.world.waterDepth(s.x, s.z) < -0.1);
    const chosen = farthestPointOrder(spots, 7);
    let i = 0;
    const next = () => chosen[i++ % chosen.length]!;
    for (let k = 0; k < PACKAGE_COUNT; k++) {
      const s = next();
      this.add('package', s.x, s.z, 1, null, 0, `pkg:${k}`);
    }
    const add = (kind: PickupKind, n: number, amount: number, weapon: WeaponId | null, respawn: number) => {
      for (let k = 0; k < n; k++) {
        const s = next();
        this.add(kind, s.x, s.z, amount, weapon, respawn, `${kind}:${weapon ?? ''}:${k}`);
      }
    };
    add('health', 8, 100, null, 90);
    add('armor', 5, 100, null, 120);
    add('weapon', 4, 36, 'pistol', 150);
    add('weapon', 2, 90, 'smg', 180);
    add('weapon', 2, 16, 'shotgun', 180);
    add('weapon', 1, 90, 'rifle', 240);
    add('weapon', 1, 3, 'rocket', 300);
    for (let k = 0; k < 3; k++) {
      const s = next();
      this.add('rampage', s.x, s.z, 0, null, 0, `rampage:${k}`);
    }
    this.syncCollected();
  }

  private add(kind: PickupKind, x: number, z: number, amount: number, weapon: WeaponId | null, respawn: number, tag: string): Pickup {
    const y = this.sim.world.groundHeight(x, z);
    const p = new Pickup(this.sim.newId(), kind, { x, y, z }, amount, weapon, respawn, tag);
    this.sim.pickups.push(p);
    return p;
  }

  /** Hides packages and rampages that the progress says are done (after loading a save). */
  syncCollected(): void {
    const prog = this.sim.progress;
    for (const p of this.sim.pickups) {
      if (p.kind === 'package') p.active = !prog.packages.includes(packageIndex(p.tag));
      if (p.kind === 'rampage') p.active = !prog.rampages.includes(p.tag);
    }
  }

  /** A mission parcel (Hot Delivery), picked up on foot; the mission removes it when it ends. */
  addMissionParcel(x: number, z: number): Pickup {
    return this.add('parcel', x, z, 0, null, 0, 'parcel');
  }

  dropMoney(x: number, z: number, amount: number): void {
    const sim = this.sim;
    if (sim.world.waterDepth(x, z) > 0) return;
    const p = this.add('money', x, z, amount, null, 0, 'drop');
    p.pos.y = Math.max(p.pos.y, WATER_Y);
    p.expires = sim.time + 30;
  }

  update(dt: number): void {
    const sim = this.sim;
    const pl = sim.player;
    const pp = sim.playerPos();
    for (const p of sim.pickups) {
      if (p.removed) continue;
      if (sim.time > p.expires) {
        p.removed = true;
        continue;
      }
      if (!p.active) {
        if (p.respawn > 0) {
          p.respawnTimer -= dt;
          if (p.respawnTimer <= 0) p.active = true;
        }
        continue;
      }
      if (!pl.alive || sim.playerDown) continue;
      const onFoot = pl.state === 'normal';
      if (!onFoot && p.kind !== 'money') continue;
      const reach = pl.vehicle ? 2.6 : 1.3;
      if (Math.hypot(p.pos.x - pp.x, p.pos.z - pp.z) > reach || Math.abs(p.pos.y - pp.y) > 2.2) continue;
      if (this.collect(p)) {
        sim.events.emit('pickup', { kind: p.kind, x: p.pos.x, y: p.pos.y, z: p.pos.z });
        if (p.respawn > 0) {
          p.active = false;
          p.respawnTimer = p.respawn;
        } else if (p.kind === 'money') {
          p.removed = true;
        } else {
          p.active = false;
        }
      }
    }
  }

  private collect(p: Pickup): boolean {
    const sim = this.sim;
    const pl = sim.player;
    const say = (text: string) => sim.events.emit('message', { text, duration: 2.5 });
    switch (p.kind) {
      case 'health':
        if (pl.health >= pl.maxHealth) return false;
        pl.health = pl.maxHealth;
        say('Health restored.');
        return true;
      case 'armor':
        if (pl.armor >= 100) return false;
        pl.armor = 100;
        say('Body armor.');
        return true;
      case 'weapon': {
        if (!p.weapon) return false;
        const had = pl.inventory.has(p.weapon);
        pl.inventory.give(p.weapon, p.amount);
        if (!had) pl.inventory.current = p.weapon;
        say(`${WEAPONS[p.weapon].name}${had ? ' ammo' : ''}.`);
        return true;
      }
      case 'money':
        sim.progress.addMoney(p.amount);
        sim.events.emit('money', { amount: p.amount });
        return true;
      case 'package': {
        const idx = packageIndex(p.tag);
        if (sim.progress.packages.includes(idx)) return false;
        sim.progress.packages.push(idx);
        const n = sim.progress.packages.length;
        sim.progress.addMoney(PACKAGE_REWARD);
        sim.events.emit('money', { amount: PACKAGE_REWARD });
        if (n >= PACKAGE_COUNT) {
          sim.progress.addMoney(PACKAGE_BONUS);
          sim.events.emit('money', { amount: PACKAGE_BONUS });
          sim.events.emit('big', { text: 'ALL PACKAGES FOUND', sub: `$${PACKAGE_BONUS.toLocaleString('en-US')} bonus`, style: 'passed', duration: 5 });
        } else {
          sim.events.emit('big', { text: `PACKAGE ${n} OF ${PACKAGE_COUNT}`, sub: '', style: 'info', duration: 3 });
        }
        return true;
      }
      case 'rampage':
        if (sim.missions.active || sim.activities.busy) {
          say('Finish what you are doing first.');
          return false;
        }
        return sim.activities.startRampage(p.tag);
      case 'parcel':
        // The mission script watches for it (see Hot Delivery).
        return true;
    }
  }

  /** Re-enables a rampage pickup after a failed attempt. */
  rearmRampage(tag: string, delay: number): void {
    for (const p of this.sim.pickups) {
      if (p.kind === 'rampage' && p.tag === tag) {
        p.active = false;
        p.respawnTimer = 0;
        p.expires = Infinity;
        // Use the respawn timer manually: pickups with respawn = 0 never come back by themselves.
        setTimeoutLike(this.sim, delay, () => {
          if (!this.sim.progress.rampages.includes(tag)) p.active = true;
        });
      }
    }
  }
}

export function packageIndex(tag: string): number {
  return Number(tag.split(':')[1] ?? -1);
}

/** Orders points so that each next point is as far as possible from the ones before. */
function farthestPointOrder<T extends { x: number; z: number }>(pts: T[], seed: number): T[] {
  if (pts.length === 0) return [];
  const out: T[] = [pts[seed % pts.length]!];
  const used = new Set<T>(out);
  const minD = pts.map((p) => Math.hypot(p.x - out[0]!.x, p.z - out[0]!.z));
  while (out.length < pts.length) {
    let bi = -1;
    let bd = -1;
    for (let i = 0; i < pts.length; i++) {
      if (used.has(pts[i]!)) continue;
      if (minD[i]! > bd) {
        bd = minD[i]!;
        bi = i;
      }
    }
    if (bi < 0) break;
    const p = pts[bi]!;
    out.push(p);
    used.add(p);
    for (let i = 0; i < pts.length; i++) minD[i] = Math.min(minD[i]!, Math.hypot(pts[i]!.x - p.x, pts[i]!.z - p.z));
  }
  return out;
}

/** Simulation-time delayed callback (no wall clock involved). */
export function setTimeoutLike(sim: Sim, delay: number, fn: () => void): void {
  sim.timers.push({ at: sim.time + delay, fn });
}
