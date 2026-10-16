// Weapons, damage, deaths, burning vehicles, explosions and rockets.

import { rayCylinderY, rayObb3, type OBB } from '../core/collision';
import { clamp, type V3 } from '../core/math';
import { makeRayHit } from '../world/colliders';
import type { Character, Vehicle } from './entities';
import { Projectile } from './entities';
import type { HitKind } from './events';
import type { PlayerInput } from './input';
import type { Sim } from './sim';
import type { WeaponSpec } from './specs';
import { launchVehicle, vehicleObb } from './vehiclePhysics';

export type DamageKind = 'bullet' | 'melee' | 'explosion' | 'vehicle' | 'fall' | 'fire' | 'impact' | 'drown';

const hit = makeRayHit();
const obb: OBB = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };

interface RayResult {
  t: number;
  kind: HitKind;
  character: Character | null;
  vehicle: Vehicle | null;
  heli: number;
  nx: number;
  ny: number;
  nz: number;
}

export class CombatSystem {
  /** Vehicle -> who last damaged it (for crimes and stats on destruction). */
  private readonly damagedBy = new WeakMap<Vehicle, Character>();
  private fireWarnCooldown = 0;

  constructor(private readonly sim: Sim) {}

  update(dt: number): void {
    this.updateProjectiles(dt);
    this.updateBurning(dt);
    if (this.fireWarnCooldown > 0) this.fireWarnCooldown -= dt;
  }

  // ---------------------------------------------------------------------------
  // Firing

  muzzle(c: Character, fromVehicle: boolean): V3 {
    if (fromVehicle && c.vehicle) {
      const v = c.vehicle;
      const sx = Math.cos(v.heading);
      const sz = -Math.sin(v.heading);
      return { x: v.pos.x + sx * (v.halfW + 0.2), y: v.pos.y + v.spec.height * 0.75, z: v.pos.z + sz * (v.halfW + 0.2) };
    }
    const yaw = c.aiming ? c.aimYaw : c.heading;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    return { x: c.pos.x + fx * 0.55 - fz * 0.18, y: c.pos.y + c.height * 0.76, z: c.pos.z + fz * 0.55 + fx * 0.18 };
  }

  playerFire(p: Character, input: PlayerInput, fromVehicle: boolean): void {
    const w = p.inventory.spec();
    if (w.id === 'fists') {
      if (input.firePressed && !fromVehicle) this.melee(p);
      return;
    }
    if (p.reloadTimer > 0 || p.fireCooldown > 0) return;
    if (!w.auto && !input.firePressed) return;
    const slot = p.inventory.slot();
    if (slot.clip <= 0) {
      if (slot.ammo > 0) this.startReload(p);
      else if (input.firePressed) {
        // Out of ammo: switch back to fists.
        p.inventory.current = 'fists';
        this.sim.events.emit('message', { text: `Out of ammo for the ${w.name}.`, duration: 2 });
      }
      return;
    }
    slot.clip--;
    p.fireCooldown = 1 / w.rate;
    p.shotTimer = 0.07;
    p.aimHold = 1.0;
    this.sim.progress.stats.shotsFired++;
    const from = this.muzzle(p, fromVehicle);
    const target = this.cameraTarget(input.aimOrigin, input.aimDir, w.range + 8, p);
    let dx = target.x - from.x;
    let dy = target.y - from.y;
    let dz = target.z - from.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    const spreadMul = fromVehicle ? 1.6 : p.speed > 3 ? 1.5 : 1;
    if (w.projectile) {
      this.launchRocket(p, from, dx, dy, dz);
    } else {
      for (let i = 0; i < w.pellets; i++) {
        const d = this.spread(dx, dy, dz, w.spread * spreadMul);
        this.fireRay(p, from, d.x, d.y, d.z, w);
      }
    }
    this.sim.wanted.crime('gunfire', p.pos.x, p.pos.z);
    if (slot.clip === 0 && slot.ammo > 0) this.startReload(p);
  }

  /** NPC shooting at a target character (or the vehicle it is in). */
  npcFire(c: Character, target: Character, accuracy: number): void {
    const w = c.inventory.spec();
    if (w.id === 'fists' || c.fireCooldown > 0 || c.reloadTimer > 0) return;
    const slot = c.inventory.slot();
    if (slot.clip <= 0) {
      this.startReload(c);
      return;
    }
    if (!c.inventory.infinite) slot.clip--;
    else slot.clip = Math.max(0, slot.clip - 1);
    c.fireCooldown = (1 / w.rate) * (w.auto ? 1.4 : 2.2) + this.sim.rng.range(0, 0.25);
    c.shotTimer = 0.07;
    c.aimHold = 1.2;
    const from = this.muzzle(c, false);
    const tp = target.vehicle ? target.vehicle.pos : target.pos;
    const ty = target.vehicle ? tp.y + 0.9 : tp.y + target.height * 0.62;
    let dx = tp.x - from.x;
    let dy = ty - from.y;
    let dz = tp.z - from.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    dx /= dist;
    dy /= dist;
    dz /= dist;
    const tSpeed = target.vehicle ? target.vehicle.speed : target.speed;
    const err = w.spread + (1 - accuracy) * 0.075 + tSpeed * 0.004 + dist * 0.0009;
    for (let i = 0; i < w.pellets; i++) {
      const d = this.spread(dx, dy, dz, err);
      this.fireRay(c, from, d.x, d.y, d.z, w);
    }
    if (slot.clip === 0) this.startReload(c);
  }

  private spread(dx: number, dy: number, dz: number, angle: number): V3 {
    if (angle <= 0) return { x: dx, y: dy, z: dz };
    // Random direction inside a cone around d.
    const rng = this.sim.rng;
    const a = rng.next() * Math.PI * 2;
    const r = Math.sqrt(rng.next()) * Math.tan(angle);
    // Build an orthonormal basis.
    let ux = -dz;
    let uy = 0;
    let uz = dx;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-6) {
      ux = 1;
      uy = 0;
      uz = 0;
      ul = 1;
    }
    ux /= ul;
    uz /= ul;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;
    const ox = dx + (ux * Math.cos(a) + vx * Math.sin(a)) * r;
    const oy = dy + (uy * Math.cos(a) + vy * Math.sin(a)) * r;
    const oz = dz + (uz * Math.cos(a) + vz * Math.sin(a)) * r;
    const l = Math.hypot(ox, oy, oz) || 1;
    return { x: ox / l, y: oy / l, z: oz / l };
  }

  /** Point the crosshair ray hits first (ignoring the shooter). */
  cameraTarget(o: V3, d: V3, range: number, shooter: Character): V3 {
    const r = this.castRay(o.x, o.y, o.z, d.x, d.y, d.z, range + 12, shooter, true);
    const t = r.kind === 'none' ? range + 12 : r.t;
    return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
  }

  /** Nearest hit along a ray against world, vehicles, characters and helicopters. */
  castRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, range: number, ignore: Character | null, forAim = false): RayResult {
    const sim = this.sim;
    const res: RayResult = { t: range, kind: 'none', character: null, vehicle: null, heli: -1, nx: 0, ny: 1, nz: 0 };
    if (sim.world.grid.raycast(ox, oy, oz, dx, dy, dz, range, hit)) {
      res.t = hit.t;
      res.kind = 'world';
      res.nx = hit.nx;
      res.ny = hit.ny;
      res.nz = hit.nz;
    }
    // Ground plane hit (roads / beach).
    if (dy < -1e-4) {
      const tg = (sim.world.groundHeight(ox, oz) - oy) / dy;
      if (tg >= 0 && tg < res.t) {
        const gx = ox + dx * tg;
        const gz = oz + dz * tg;
        const tg2 = (sim.world.groundHeight(gx, gz) - oy) / dy;
        if (tg2 >= 0 && tg2 < res.t) {
          res.t = tg2;
          res.kind = 'world';
          res.nx = 0;
          res.ny = 1;
          res.nz = 0;
        }
      }
    }
    const ignoreVehicle = ignore?.vehicle ?? null;
    for (const v of sim.vehicles) {
      if (v.removed || v === ignoreVehicle) continue;
      const cx = v.pos.x - ox;
      const cz = v.pos.z - oz;
      const along = cx * dx + cz * dz;
      if (along < -6 || along > res.t + 6) continue;
      vehicleObb(v, obb);
      const t = rayObb3(ox, oy, oz, dx, dy, dz, obb, v.pos.y + 0.15, v.pos.y + v.spec.height, res.t);
      if (t >= 0 && t < res.t) {
        res.t = t;
        res.kind = 'vehicle';
        res.vehicle = v;
        res.character = null;
        res.nx = -dx;
        res.ny = -dy;
        res.nz = -dz;
      }
    }
    for (const c of sim.characters) {
      if (c.removed || c === ignore || c.state === 'inVehicle' || c.state === 'entering') continue;
      if (c.state === 'dead' && forAim) continue;
      const cx = c.pos.x - ox;
      const cz = c.pos.z - oz;
      const along = cx * dx + cz * dz;
      if (along < -1 || along > res.t + 1) continue;
      const lying = c.state === 'dead' || c.state === 'knocked';
      const top = c.state === 'swimming' ? c.pos.y + c.height : c.pos.y + (lying ? 0.45 : c.height);
      const bottom = c.state === 'swimming' ? c.pos.y + 0.9 : c.pos.y;
      const t = rayCylinderY(ox, oy, oz, dx, dy, dz, c.pos.x, c.pos.z, lying ? 0.6 : 0.36, bottom, top, res.t);
      if (t >= 0 && t < res.t) {
        res.t = t;
        res.kind = 'flesh';
        res.character = c;
        res.vehicle = null;
        res.nx = -dx;
        res.ny = -dy;
        res.nz = -dz;
      }
    }
    for (let i = 0; i < sim.helis.length; i++) {
      const h = sim.helis[i]!;
      if (h.removed || h.destroyed) continue;
      const t = raySphere(ox, oy, oz, dx, dy, dz, h.pos.x, h.pos.y + 1.2, h.pos.z, 3.2);
      if (t >= 0 && t < res.t) {
        res.t = t;
        res.kind = 'vehicle';
        res.heli = i;
        res.character = null;
        res.vehicle = null;
      }
    }
    return res;
  }

  private fireRay(shooter: Character, from: V3, dx: number, dy: number, dz: number, w: WeaponSpec): void {
    const sim = this.sim;
    const r = this.castRay(from.x, from.y, from.z, dx, dy, dz, w.range, shooter);
    const tx = from.x + dx * r.t;
    const ty = from.y + dy * r.t;
    const tz = from.z + dz * r.t;
    if (r.character) {
      const c = r.character;
      let dmg = w.damage;
      if (c.state === 'normal' && ty > c.pos.y + c.height * 0.86) {
        dmg *= 2.5;
        if (shooter.isPlayer && c.alive) sim.progress.stats.headshots++;
      }
      if (w.id === 'shotgun' && r.t < 8) dmg *= 1.3;
      if (shooter.role === 'cop' || shooter.role === 'swat' || shooter.role === 'gang') dmg *= c.isPlayer ? 0.55 : 1;
      this.damageCharacter(c, dmg, shooter, 'bullet', dx, dy, dz);
      sim.events.emit('blood', { x: tx, y: ty, z: tz, dx, dy, dz });
    } else if (r.vehicle) {
      const mult = shooter.isPlayer ? 1.4 : 0.8;
      this.damageVehicle(r.vehicle, w.damage * mult, shooter, 'bullet');
    } else if (r.heli >= 0) {
      const h = sim.helis[r.heli]!;
      h.health -= w.damage * (shooter.isPlayer ? 1.2 : 0);
      if (shooter.isPlayer) sim.wanted.crime('assaultCop', h.pos.x, h.pos.z);
    }
    sim.events.emit('shot', { shooter, weapon: w.id, fx: from.x, fy: from.y, fz: from.z, tx, ty, tz, hit: r.kind, nx: r.nx, ny: r.ny, nz: r.nz });
  }

  melee(c: Character): void {
    const sim = this.sim;
    if (c.fireCooldown > 0) return;
    c.fireCooldown = 1 / 2.6;
    c.punchTimer = 0.32;
    c.meleeCombo = (c.meleeCombo + 1) % 3;
    const fx = Math.sin(c.heading);
    const fz = Math.cos(c.heading);
    let best: Character | null = null;
    let bd = 1.75;
    for (const o of sim.characters) {
      if (o === c || o.removed || !o.alive || (o.state !== 'normal' && o.state !== 'knocked')) continue;
      const dx = o.pos.x - c.pos.x;
      const dz = o.pos.z - c.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > bd || Math.abs(o.pos.y - c.pos.y) > 1.2) continue;
      if (d > 0.3 && (dx * fx + dz * fz) / d < 0.45) continue;
      best = o;
      bd = d;
    }
    const hx = c.pos.x + fx * 0.8;
    const hz = c.pos.z + fz * 0.8;
    if (best) {
      const dmg = c.isPlayer ? 13 : 9;
      best.staggerHits++;
      best.meleeComboTimer = 2;
      if (best.staggerHits >= 3 && best.state === 'normal') {
        best.state = 'knocked';
        best.knockTimer = 1.6;
        best.vel.x = fx * 3.5;
        best.vel.z = fz * 3.5;
        best.vel.y = 2.5;
        best.onGround = false;
        best.staggerHits = 0;
      } else {
        best.vel.x += fx * 1.5;
        best.vel.z += fz * 1.5;
      }
      this.damageCharacter(best, dmg, c, 'melee', fx, 0, fz);
      sim.events.emit('melee', { x: hx, y: c.pos.y + 1.3, z: hz, hit: true });
    } else {
      sim.events.emit('melee', { x: hx, y: c.pos.y + 1.3, z: hz, hit: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Reloading

  startReload(c: Character): void {
    const spec = c.inventory.spec();
    const slot = c.inventory.slot();
    if (spec.mag === 0 || c.reloadTimer > 0 || slot.clip >= spec.mag) return;
    if (slot.ammo <= 0 && !c.inventory.infinite) return;
    c.reloadTimer = spec.reload;
    this.sim.events.emit('reload', { character: c });
  }

  finishReload(c: Character): void {
    c.reloadTimer = 0;
    const spec = c.inventory.spec();
    const slot = c.inventory.slot();
    const need = spec.mag - slot.clip;
    if (need <= 0) return;
    const take = c.inventory.infinite ? need : Math.min(need, slot.ammo);
    slot.clip += take;
    if (!c.inventory.infinite) slot.ammo -= take;
  }

  // ---------------------------------------------------------------------------
  // Damage

  damageCharacter(c: Character, amount: number, attacker: Character | null, kind: DamageKind, dx: number, _dy: number, dz: number): void {
    const sim = this.sim;
    if (c.removed || !c.alive || !(amount > 0)) return;
    if (c.isPlayer && sim.playerDown) return;
    if (c.isPlayer && sim.cheats.godMode) return;
    if (c.armor > 0 && kind !== 'fall' && kind !== 'drown') {
      const absorbed = Math.min(c.armor, amount);
      c.armor -= absorbed;
      amount -= absorbed;
    }
    c.health -= amount;
    c.hurtTimer = 0.35;
    if (attacker && attacker !== c) {
      c.lastAttacker = attacker;
      c.lastAttackTime = sim.time;
    }
    if (c.health <= 0) {
      this.kill(c, attacker, kind, dx, dz);
      return;
    }
    if (attacker && attacker.isPlayer && !c.isPlayer) {
      if (c.isLaw) sim.wanted.crime('assaultCop', c.pos.x, c.pos.z);
      else if (kind === 'melee' || kind === 'bullet') sim.wanted.crime('assault', c.pos.x, c.pos.z);
    }
    if (!c.isPlayer) {
      if (c.isLaw) sim.police.onCopAttacked(c, attacker);
      else sim.peds.onAttacked(c, attacker);
    }
  }

  kill(c: Character, killer: Character | null, kind: DamageKind, dx: number, dz: number): void {
    const sim = this.sim;
    if (!c.alive) return;
    c.health = Math.min(0, c.health);
    if (c.vehicle) {
      const v = c.vehicle;
      sim.unseat(c);
      const sx = Math.cos(v.heading);
      const sz = -Math.sin(v.heading);
      const spot = sim.world.findFreeSpot(v.pos.x + sx * (v.halfW + 0.7), v.pos.z + sz * (v.halfW + 0.7), 0.4, 6, true) ?? { x: v.pos.x, z: v.pos.z };
      c.pos.x = spot.x;
      c.pos.z = spot.z;
      c.pos.y = Math.max(sim.world.groundHeight(spot.x, spot.z), sim.world.groundHeight(v.pos.x, v.pos.z));
    }
    c.state = 'dead';
    c.deadTime = 0;
    c.moveSpeed = 0;
    c.aiming = false;
    c.reloadTimer = 0;
    if (kind === 'bullet' || kind === 'melee') {
      c.vel.x += dx * 2.5;
      c.vel.z += dz * 2.5;
    }
    if (c.isPlayer) {
      sim.playerDied();
    } else {
      if (killer && killer.isPlayer) {
        sim.progress.stats.kills++;
        if (c.isLaw) {
          sim.progress.stats.copsKilled++;
          sim.wanted.crime('killCop', c.pos.x, c.pos.z);
        } else if (c.role === 'gang' || c.missionTag === 'enemy') {
          sim.wanted.crime('killGang', c.pos.x, c.pos.z);
        } else {
          sim.wanted.crime('murder', c.pos.x, c.pos.z);
        }
      }
      if (c.cash > 0) sim.pickupSys.dropMoney(c.pos.x, c.pos.z, c.cash);
      c.cash = 0;
      if (c.owner === 'traffic') c.owner = 'ped';
    }
    sim.events.emit('characterKilled', { victim: c, killer });
  }

  damageVehicle(v: Vehicle, amount: number, attacker: Character | null, kind: DamageKind): void {
    if (v.destroyed || v.removed || !(amount > 0)) return;
    if (this.sim.cheats.godMode && v.driver?.isPlayer) return;
    v.health -= amount;
    if (attacker) this.damagedBy.set(v, attacker);
    if (attacker && attacker.isPlayer && v.spec.police && kind === 'bullet') this.sim.wanted.crime('assaultCop', v.pos.x, v.pos.z);
    if (v.driver && !v.driver.isPlayer && v.driver.brain && attacker) v.driver.brain.threat = attacker;
    if (kind === 'explosion' && v.health < -v.spec.health * 0.35) {
      this.explodeVehicle(v);
      return;
    }
    if (v.health <= 0 && !v.burning) this.igniteVehicle(v, this.sim.rng.range(3.5, 5.5));
  }

  igniteVehicle(v: Vehicle, seconds: number): void {
    if (v.destroyed || v.burning) return;
    v.burning = true;
    v.burnTimer = seconds;
    v.health = Math.min(v.health, 0);
    if (v.driver?.isPlayer && this.fireWarnCooldown <= 0) {
      this.fireWarnCooldown = 6;
      this.sim.events.emit('message', { text: 'Your vehicle is on fire! Get out (F)!', duration: 3 });
    }
  }

  explodeVehicle(v: Vehicle): void {
    const sim = this.sim;
    if (v.destroyed) return;
    const culprit = this.damagedBy.get(v) ?? null;
    v.destroyed = true;
    v.burning = false;
    v.health = -v.spec.health;
    v.wreckTime = 0;
    v.siren = false;
    v.ai = null;
    for (const o of v.occupants()) this.damageCharacter(o, 1000, culprit, 'explosion', 0, 1, 0);
    launchVehicle(v, 0, 0, 6.5, 2.5);
    if (culprit && culprit.isPlayer) {
      sim.progress.stats.vehiclesDestroyed++;
      sim.wanted.crime(v.spec.police ? 'destroyPolice' : 'destroyVehicle', v.pos.x, v.pos.z);
    }
    sim.events.emit('vehicleDestroyed', { vehicle: v });
    this.explosion(v.pos.x, v.pos.y + 0.8, v.pos.z, 7.5, 360, culprit, v);
  }

  explosion(x: number, y: number, z: number, radius: number, damage: number, owner: Character | null, source: Vehicle | null): void {
    const sim = this.sim;
    sim.events.emit('explosion', { x, y, z, radius });
    for (const c of sim.characters) {
      if (c.removed || c.state === 'inVehicle') continue;
      const dx = c.pos.x - x;
      const dy = c.pos.y + 1 - y;
      const dz = c.pos.z - z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      const f = 1 - d / radius;
      const hl = Math.hypot(dx, dz) || 1;
      c.vel.x = (dx / hl) * 13 * f;
      c.vel.z = (dz / hl) * 13 * f;
      c.vel.y = 3 + 6 * f;
      c.onGround = false;
      if (c.state === 'normal' || c.state === 'swimming') {
        c.state = 'knocked';
        c.knockTimer = 1.8 + f;
      }
      this.damageCharacter(c, damage * f * 0.8, owner, 'explosion', dx / hl, 0.5, dz / hl);
    }
    for (const v of sim.vehicles) {
      if (v.removed || v === source) continue;
      const dx = v.pos.x - x;
      const dz = v.pos.z - z;
      const d = Math.hypot(dx, v.pos.y + 0.8 - y, dz);
      if (d > radius + v.halfL * 0.5) continue;
      const f = clamp(1 - d / (radius + v.halfL * 0.5), 0, 1);
      const hl = Math.hypot(dx, dz) || 1;
      const massScale = clamp(1600 / v.spec.mass, 0.2, 1.4);
      launchVehicle(v, dx / hl, dz / hl, 9 * f * massScale, 5 * f * massScale);
      this.damageVehicle(v, damage * f * 3.2, owner, 'explosion');
    }
    sim.world.grid.query(x - radius, z - radius, x + radius, z + radius, (c) => {
      if (!c.breakable) return;
      if (Math.hypot(c.cx - x, c.cz - z) > radius * 0.7) return;
      const idx = sim.world.breakCollider(c);
      if (idx >= 0) {
        const hl = Math.hypot(c.cx - x, c.cz - z) || 1;
        sim.events.emit('propBroken', { index: idx, dirX: (c.cx - x) / hl, dirZ: (c.cz - z) / hl });
      }
    });
    for (const h of sim.helis) {
      if (h.removed || h.destroyed) continue;
      const d = Math.hypot(h.pos.x - x, h.pos.y - y, h.pos.z - z);
      if (d < radius * 1.6) h.health -= damage * 3 * (1 - d / (radius * 1.6));
    }
    if (owner && owner.isPlayer) sim.wanted.crime('explosion', x, z);
    sim.peds.onViolence(x, z, owner, 60);
  }

  // ---------------------------------------------------------------------------
  // Rockets

  private launchRocket(owner: Character, from: V3, dx: number, dy: number, dz: number): void {
    const sp = 58;
    const p = new Projectile(this.sim.newId(), { ...from }, { x: dx * sp, y: dy * sp, z: dz * sp }, owner);
    this.sim.projectiles.push(p);
    this.sim.events.emit('shot', { shooter: owner, weapon: 'rocket', fx: from.x, fy: from.y, fz: from.z, tx: from.x + dx, ty: from.y + dy, tz: from.z + dz, hit: 'none', nx: 0, ny: 1, nz: 0 });
  }

  private updateProjectiles(dt: number): void {
    const sim = this.sim;
    for (const p of sim.projectiles) {
      if (p.removed) continue;
      p.life -= dt;
      const sp = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
      const step = sp * dt;
      const dx = p.vel.x / sp;
      const dy = p.vel.y / sp;
      const dz = p.vel.z / sp;
      const ignore = p.life > 5.85 ? p.owner : null;
      const r = this.castRay(p.pos.x, p.pos.y, p.pos.z, dx, dy, dz, step, ignore ?? (p.owner && p.owner.vehicle ? p.owner : null));
      if (r.kind !== 'none' || p.life <= 0) {
        const t = r.kind !== 'none' ? Math.max(0, r.t - 0.2) : 0;
        p.removed = true;
        // A direct rocket hit always destroys a vehicle.
        if (r.vehicle) this.damageVehicle(r.vehicle, r.vehicle.spec.health * 3, p.owner, 'explosion');
        this.explosion(p.pos.x + dx * t, p.pos.y + dy * t, p.pos.z + dz * t, 8, 420, p.owner, null);
        continue;
      }
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z += p.vel.z * dt;
    }
  }

  // ---------------------------------------------------------------------------
  // Fire

  private updateBurning(dt: number): void {
    const sim = this.sim;
    for (const v of sim.vehicles) {
      if (v.removed || !v.burning || v.destroyed) continue;
      v.burnTimer -= dt;
      // NPC occupants abandon a burning vehicle.
      for (const o of v.occupants()) {
        if (o.isPlayer) continue;
        sim.unseat(o);
        const sx = Math.cos(v.heading);
        const sz = -Math.sin(v.heading);
        const spot = sim.world.findFreeSpot(v.pos.x + sx * (v.halfW + 0.8), v.pos.z + sz * (v.halfW + 0.8), 0.4, 6) ?? { x: v.pos.x + sx * 2, z: v.pos.z + sz * 2 };
        o.pos.x = spot.x;
        o.pos.z = spot.z;
        o.pos.y = sim.world.groundHeight(spot.x, spot.z);
        o.state = 'normal';
        if (o.owner === 'traffic') o.owner = 'ped';
        if (o.isLaw) sim.police.onCopBailed(o);
        else if (o.brain) sim.peds.flee(o, v.pos.x, v.pos.z, null);
      }
      if (v.burnTimer <= 0) this.explodeVehicle(v);
    }
    // Standing in flames hurts.
    for (const v of sim.vehicles) {
      if (v.removed || !(v.burning || (v.destroyed && v.wreckTime < 12))) continue;
      for (const c of sim.characters) {
        if (c.removed || !c.alive || c.state === 'inVehicle') continue;
        const d = Math.hypot(c.pos.x - v.pos.x, c.pos.z - v.pos.z);
        if (d < v.halfL + 0.4 && Math.abs(c.pos.y - v.pos.y) < 2) this.damageCharacter(c, 22 * dt, null, 'fire', 0, 0, 0);
      }
    }
  }
}

function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number): number {
  const lx = ox - cx;
  const ly = oy - cy;
  const lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t = -b - s;
  if (t >= 0) return t;
  const t2 = -b + s;
  return t2 >= 0 ? 0 : -1;
}
