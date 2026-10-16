// Police response: patrol cars, pursuit units, foot officers, SWAT, the
// helicopter, and arrests ("busted").

import { clamp, moveAngleTowards, wrapAngle } from '../core/math';
import { makeBrain } from './brains';
import { DriverAI } from './driver';
import { Helicopter, type Character, type Vehicle } from './entities';
import type { Sim } from './sim';

const UNITS_BY_LEVEL = [0, 2, 3, 4, 6, 7];

export class PoliceSystem {
  private dispatchTimer = 0;
  private patrolTimer = 3;
  private cleanupTimer = 0;
  bustTimer = 0;
  private calm = 0;

  constructor(private readonly sim: Sim) {}

  /** Seconds the player's vehicle has been (nearly) stationary. */
  private playerStill = 0;

  update(dt: number): void {
    const sim = this.sim;
    if (!sim.policeEnabled) return;
    const level = sim.playerDown ? 0 : sim.wanted.level;
    const pv = sim.player.vehicle;
    this.playerStill = pv && pv.speed < 1.5 ? this.playerStill + dt : 0;
    this.calm = level === 0 ? this.calm + dt : 0;
    this.updateUnits(level);
    this.updateFootCops(dt, level);
    this.updateHelis(dt, level);
    this.updateBust(dt, level);
    this.dispatch(dt, level);
    this.patrols(dt, level);
    this.cleanup(dt, level);
  }

  // ---------------------------------------------------------------------------
  // Units (cars)

  private chasingUnits(): number {
    let n = 0;
    for (const v of this.sim.vehicles) {
      if (v.owner !== 'police' || v.removed || !v.drivable) continue;
      const crewAlive = v.occupants().some((c) => c.alive) || this.sim.characters.some((c) => c.isLaw && c.alive && c.brain?.car === v);
      if (crewAlive) n++;
    }
    return n;
  }

  private dispatch(dt: number, level: number): void {
    if (level === 0 || !this.sim.ambient) return;
    this.dispatchTimer -= dt;
    if (this.dispatchTimer > 0) return;
    this.dispatchTimer = 2.4;
    if (this.chasingUnits() < UNITS_BY_LEVEL[level]!) this.spawnUnit(level >= 4 && this.sim.rng.chance(0.45) ? 'swat' : 'police', true);
  }

  private patrols(dt: number, level: number): void {
    if (level > 0 || !this.sim.ambient) return;
    this.patrolTimer -= dt;
    if (this.patrolTimer > 0) return;
    this.patrolTimer = 7;
    const pp = this.sim.playerPos();
    let n = 0;
    for (const v of this.sim.vehicles) if (v.owner === 'police' && !v.removed && Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z) < 300) n++;
    if (n < 2) this.spawnUnit('police', false);
  }

  /** Spawns a police car on a lane 100-210 m away, preferably out of sight. */
  spawnUnit(kind: 'police' | 'swat', pursuit: boolean): Vehicle | null {
    const sim = this.sim;
    const pp = sim.playerPos();
    const lanes = sim.roads.lanes;
    for (let tries = 0; tries < 30; tries++) {
      const lane = sim.rng.pick(lanes);
      const s = sim.rng.range(5, Math.max(6, lane.length - 5));
      const x = lane.sx + lane.dx * s;
      const z = lane.sz + lane.dz * s;
      const d = Math.hypot(x - pp.x, z - pp.z);
      if (d < 95 || d > 215) continue;
      if (pursuit && (pp.x - x) * lane.dx + (pp.z - z) * lane.dz < 0 && tries < 20) continue;
      if (d < 160 && sim.isVisible(x, 1, z) && tries < 25) continue;
      if (!sim.traffic.isClear(x, z, 9)) continue;
      const v = sim.spawnVehicle(kind, x, z, lane.heading);
      v.owner = 'police';
      const driver = sim.addDriver(v, kind === 'swat' ? 'swat' : 'cop', pursuit ? 'chase' : 'traffic');
      this.equip(driver, v);
      v.ai!.setLane(lane, s);
      if (pursuit) {
        v.ai!.target = sim.player;
        v.siren = true;
      }
      const crew = kind === 'swat' ? 3 : pursuit ? 1 : 0;
      for (let i = 0; i < crew && i < v.passengers.length; i++) {
        const c = sim.spawnCharacter(kind === 'swat' ? 'swat' : 'cop', x, z);
        this.equip(c, v);
        sim.seat(c, v, i + 1);
      }
      const sp = lane.speedLimit * (pursuit ? 1 : 0.6);
      v.vel.x = lane.dx * sp;
      v.vel.z = lane.dz * sp;
      return v;
    }
    return null;
  }

  private equip(c: Character, car: Vehicle): void {
    c.owner = 'police';
    c.inventory.infinite = true;
    c.inventory.give(c.role === 'swat' ? 'smg' : 'pistol', 999);
    c.inventory.current = c.role === 'swat' ? 'smg' : 'pistol';
    const b = makeBrain('chase');
    b.car = car;
    b.accuracy = c.role === 'swat' ? 0.62 : 0.45;
    b.brave = true;
    c.brain = b;
  }

  private updateUnits(level: number): void {
    const sim = this.sim;
    const p = sim.player;
    const pp = sim.playerPos();
    for (const v of sim.vehicles) {
      if (v.owner !== 'police' || v.removed || !v.drivable || !v.driver || !v.ai) continue;
      const ai = v.ai;
      if (level > 0) {
        if (ai.policy !== 'chase') {
          ai.setPolicy('chase');
        }
        ai.target = p;
        v.siren = true;
        const d = Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z);
        // Officers get out to arrest a player on foot, or one sitting in a stopped car.
        const playerStopped = !!p.vehicle && p.vehicle.speed < 1.5 && this.playerStill > 2.5;
        if ((!p.vehicle || playerStopped) && d < 26 && v.speed < 4.5) this.deploy(v);
        else ai.hold = false;
      } else if (ai.policy === 'chase') {
        ai.setPolicy('traffic');
        ai.target = null;
        ai.hold = false;
        ai.resetPath();
        v.siren = false;
      }
    }
  }

  /** Crew leaves the car to pursue on foot. */
  private deploy(v: Vehicle): void {
    const sim = this.sim;
    const sx = Math.cos(v.heading);
    const sz = -Math.sin(v.heading);
    let side = 1;
    for (const c of v.occupants()) {
      sim.unseat(c);
      const spot = sim.world.findFreeSpot(v.pos.x + sx * side * (v.halfW + 0.8), v.pos.z + sz * side * (v.halfW + 0.8), 0.4, 6) ?? { x: v.pos.x + sx * side * 2, z: v.pos.z + sz * side * 2 };
      c.pos.x = spot.x;
      c.pos.z = spot.z;
      c.pos.y = sim.world.groundHeight(spot.x, spot.z);
      c.state = 'normal';
      c.heading = v.heading;
      if (c.brain) {
        c.brain.mode = 'chase';
        c.brain.car = v;
      }
      side = -side;
    }
    v.controls.handbrake = true;
  }

  onCopAttacked(c: Character, attacker: Character | null): void {
    if (!c.brain) return;
    if (attacker && attacker.isPlayer) {
      c.brain.mode = 'chase';
      c.brain.target = attacker;
    }
  }

  onCopBailed(c: Character): void {
    if (c.brain) {
      c.brain.mode = 'chase';
      c.brain.car = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Officers on foot

  private updateFootCops(dt: number, level: number): void {
    const sim = this.sim;
    const p = sim.player;
    const pp = sim.playerPos();
    for (const c of sim.characters) {
      if (c.removed || !c.isLaw || !c.alive || !c.brain) continue;
      if (c.state !== 'normal' && c.state !== 'swimming') {
        c.moveSpeed = 0;
        continue;
      }
      const b = c.brain;
      c.aiming = false;
      const car = b.car && !b.car.removed && b.car.drivable ? b.car : null;
      if (level === 0) {
        if (car && !car.driver) this.walkToCar(c, car, dt);
        else {
          // Walk off; cleanup removes officers once out of view.
          c.moveX = Math.sin(c.heading);
          c.moveZ = Math.cos(c.heading);
          c.moveSpeed = 1.4;
        }
        continue;
      }
      const d = Math.hypot(pp.x - c.pos.x, pp.z - c.pos.z);
      const playerDrivingOff = !!p.vehicle && (p.vehicle.speed > 3 || d > 34);
      if (playerDrivingOff && d > 34 && car && Math.hypot(car.pos.x - c.pos.x, car.pos.z - c.pos.z) < 45) b.mode = 'return';
      if (b.mode === 'return') {
        if (!p.vehicle && d < 25) b.mode = 'chase';
        else if (car) {
          this.walkToCar(c, car, dt);
          continue;
        } else b.mode = 'chase';
      }
      const canSee = d < 48 && sim.world.lineOfSight(c.pos.x, c.pos.y + 1.6, c.pos.z, pp.x, pp.y + 1.2, pp.z);
      const shoot = level >= 2 && canSee && d < 32 && !sim.playerDown;
      if (shoot) {
        c.moveSpeed = 0;
        c.aiming = true;
        c.heading = moveAngleTowards(c.heading, Math.atan2(pp.x - c.pos.x, pp.z - c.pos.z), 9 * dt);
        if (Math.abs(wrapAngle(Math.atan2(pp.x - c.pos.x, pp.z - c.pos.z) - c.heading)) < 0.3) sim.combat.npcFire(c, p, b.accuracy);
        // Close in a bit when far.
        if (d > 22) this.runTo(c, pp.x, pp.z, 3.2, dt);
      } else if (d > 1.1) {
        this.runTo(c, pp.x, pp.z, d > 8 ? 6.4 : 4.2, dt);
      } else {
        c.moveSpeed = 0;
        c.heading = moveAngleTowards(c.heading, Math.atan2(pp.x - c.pos.x, pp.z - c.pos.z), 10 * dt);
      }
    }
  }

  private runTo(c: Character, x: number, z: number, speed: number, dt: number): void {
    const dx = x - c.pos.x;
    const dz = z - c.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    c.moveX = dx / d;
    c.moveZ = dz / d;
    c.moveSpeed = speed;
    c.heading = moveAngleTowards(c.heading, Math.atan2(dx, dz), 9 * dt);
    const b = c.brain!;
    const moved = Math.hypot(c.pos.x - b.lastX, c.pos.z - b.lastZ);
    b.lastX = c.pos.x;
    b.lastZ = c.pos.z;
    if (moved < speed * dt * 0.2) b.stuckTimer += dt;
    else b.stuckTimer = Math.max(0, b.stuckTimer - dt);
    if (b.stuckTimer > 0.7) {
      // Side-step around whatever blocks the way.
      const side = (c.id % 2 === 0 ? 1 : -1) * (b.stuckTimer > 2 ? -1 : 1);
      c.moveX = (dz / d) * side;
      c.moveZ = (-dx / d) * side;
      if (b.stuckTimer > 3.2) b.stuckTimer = 0;
    }
  }

  private walkToCar(c: Character, car: Vehicle, dt: number): void {
    const sim = this.sim;
    const sx = Math.cos(car.heading);
    const sz = -Math.sin(car.heading);
    const tx = car.pos.x + sx * (car.halfW + 0.6);
    const tz = car.pos.z + sz * (car.halfW + 0.6);
    const d = Math.hypot(tx - c.pos.x, tz - c.pos.z);
    if (d < 1.6) {
      if (!car.driver) {
        sim.seat(c, car, 0);
        car.ai = new DriverAI(sim, car, sim.wanted.level > 0 ? 'chase' : 'traffic');
        if (sim.wanted.level > 0) car.ai.target = sim.player;
      } else {
        const free = car.passengers.indexOf(null);
        if (free >= 0) sim.seat(c, car, free + 1);
        else c.brain!.car = null;
      }
      return;
    }
    this.runTo(c, tx, tz, sim.wanted.level > 0 ? 6 : 1.6, dt);
  }

  // ---------------------------------------------------------------------------
  // Arrest

  private updateBust(dt: number, level: number): void {
    const sim = this.sim;
    const p = sim.player;
    if (level === 0 || sim.playerDown || !p.alive || sim.missions.noBust) {
      this.bustTimer = 0;
      return;
    }
    let close = false;
    for (const c of sim.characters) {
      if (c.removed || !c.isLaw || !c.alive || c.state !== 'normal') continue;
      if (p.vehicle) {
        const v = p.vehicle;
        if (v.speed < 1.2 && Math.hypot(c.pos.x - v.pos.x, c.pos.z - v.pos.z) < v.halfW + 1.9) close = true;
      } else {
        const d = Math.hypot(c.pos.x - p.pos.x, c.pos.z - p.pos.z);
        if (d < 1.7 && (p.speed < 2.2 || p.state === 'knocked')) close = true;
      }
      if (close) break;
    }
    if (close) this.bustTimer += dt;
    else this.bustTimer = Math.max(0, this.bustTimer - dt * 2);
    const need = p.vehicle ? 2.2 : level === 1 ? 1.0 : 1.6;
    if (this.bustTimer > need) {
      this.bustTimer = 0;
      sim.bustPlayer();
    }
  }

  // ---------------------------------------------------------------------------
  // Helicopter

  private updateHelis(dt: number, level: number): void {
    const sim = this.sim;
    const pp = sim.playerPos();
    if (level >= 3 && sim.helis.filter((h) => !h.destroyed).length === 0 && sim.ambient) {
      const a = sim.rng.range(0, Math.PI * 2);
      const h = new Helicopter(sim.newId(), pp.x + Math.cos(a) * 240, sim.world.groundHeight(pp.x, pp.z) + 60, pp.z + Math.sin(a) * 240);
      sim.helis.push(h);
    }
    for (const h of sim.helis) {
      if (h.removed) continue;
      h.rotor += dt * (h.crashing ? 18 : 32);
      if (!h.destroyed && h.health <= 0) {
        h.destroyed = true;
        h.crashing = true;
        sim.events.emit('explosion', { x: h.pos.x, y: h.pos.y, z: h.pos.z, radius: 4 });
        sim.wanted.crime('destroyPolice', h.pos.x, h.pos.z);
        sim.progress.stats.vehiclesDestroyed++;
      }
      if (h.crashing) {
        h.vel.y -= 11 * dt;
        h.heading = wrapAngle(h.heading + dt * 4);
        h.pos.x += h.vel.x * dt;
        h.pos.y += h.vel.y * dt;
        h.pos.z += h.vel.z * dt;
        const gy = sim.world.groundHeight(h.pos.x, h.pos.z);
        let hitBuilding = false;
        sim.world.grid.query(h.pos.x - 1, h.pos.z - 1, h.pos.x + 1, h.pos.z + 1, (c) => {
          if (c.tag === 'building' && h.pos.y < c.y1 && h.pos.y > c.y0) hitBuilding = true;
        });
        if (h.pos.y <= gy + 1 || hitBuilding) {
          h.removed = true;
          sim.combat.explosion(h.pos.x, Math.max(gy, h.pos.y), h.pos.z, 9, 450, null, null);
        }
        continue;
      }
      if (level < 3) {
        // Leave the area.
        h.vel.y = damp1(h.vel.y, 6, dt);
        const ax = h.pos.x - pp.x;
        const az = h.pos.z - pp.z;
        const al = Math.hypot(ax, az) || 1;
        h.vel.x = damp1(h.vel.x, (ax / al) * 25, dt);
        h.vel.z = damp1(h.vel.z, (az / al) * 25, dt);
        h.pos.x += h.vel.x * dt;
        h.pos.y += h.vel.y * dt;
        h.pos.z += h.vel.z * dt;
        if (al > 420) h.removed = true;
        continue;
      }
      h.orbit += dt * 0.28;
      const gy = sim.world.groundHeight(pp.x, pp.z);
      const tx = pp.x + Math.cos(h.orbit) * 24;
      const tz = pp.z + Math.sin(h.orbit) * 24;
      const ty = Math.max(gy, 0) + 36;
      let dvx = (tx - h.pos.x) * 0.9;
      let dvy = (ty - h.pos.y) * 0.9;
      let dvz = (tz - h.pos.z) * 0.9;
      const dl = Math.hypot(dvx, dvy, dvz);
      const maxV = 25;
      if (dl > maxV) {
        dvx *= maxV / dl;
        dvy *= maxV / dl;
        dvz *= maxV / dl;
      }
      h.vel.x = damp1(h.vel.x, dvx, dt * 1.6);
      h.vel.y = damp1(h.vel.y, dvy, dt * 1.6);
      h.vel.z = damp1(h.vel.z, dvz, dt * 1.6);
      h.pos.x += h.vel.x * dt;
      h.pos.y += h.vel.y * dt;
      h.pos.z += h.vel.z * dt;
      h.heading = moveAngleTowards(h.heading, Math.atan2(pp.x - h.pos.x, pp.z - h.pos.z), dt * 1.5);
      h.spotlight.x = damp1(h.spotlight.x, pp.x, dt * 3);
      h.spotlight.z = damp1(h.spotlight.z, pp.z, dt * 3);
      if (level >= 4 && !sim.playerDown) {
        h.fireCooldown -= dt;
        if (h.fireCooldown <= 0) {
          h.fireCooldown = 0.16;
          this.heliShot(h);
          if (sim.rng.chance(0.15)) h.fireCooldown = 2.6;
        }
      }
    }
  }

  private heliShot(h: Helicopter): void {
    const sim = this.sim;
    const pp = sim.playerPos();
    const tx = pp.x;
    const ty = pp.y + 1;
    const tz = pp.z;
    let dx = tx - h.pos.x;
    let dy = ty - (h.pos.y - 1.5);
    let dz = tz - h.pos.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    if (d > 90) return;
    dx /= d;
    dy /= d;
    dz /= d;
    const err = 0.06 + sim.rng.next() * 0.05;
    dx += (sim.rng.next() - 0.5) * err * 2;
    dy += (sim.rng.next() - 0.5) * err * 2;
    dz += (sim.rng.next() - 0.5) * err * 2;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    const ox = h.pos.x + dx * 4;
    const oy = h.pos.y - 1.5 + dy * 4;
    const oz = h.pos.z + dz * 4;
    const r = sim.combat.castRay(ox, oy, oz, dx, dy, dz, 110, null);
    if (r.character) sim.combat.damageCharacter(r.character, 9, null, 'bullet', dx, dy, dz);
    else if (r.vehicle) sim.combat.damageVehicle(r.vehicle, 14, null, 'bullet');
    sim.events.emit('shot', { shooter: null, weapon: 'rifle', fx: ox, fy: oy, fz: oz, tx: ox + dx * r.t, ty: oy + dy * r.t, tz: oz + dz * r.t, hit: r.kind, nx: r.nx, ny: r.ny, nz: r.nz });
  }

  // ---------------------------------------------------------------------------

  private cleanup(dt: number, level: number): void {
    this.cleanupTimer -= dt;
    if (this.cleanupTimer > 0) return;
    this.cleanupTimer = 1;
    const sim = this.sim;
    const pp = sim.playerPos();
    for (const v of sim.vehicles) {
      if (v.owner !== 'police' || v.removed || v.driver === sim.player) continue;
      const d = Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z);
      const visible = sim.isVisible(v.pos.x, v.pos.y, v.pos.z);
      if ((d > 290 && !visible) || (v.destroyed && v.wreckTime > 40 && !visible) || (level === 0 && this.calm > 25 && d > 110 && !visible && v.ai?.policy !== 'traffic')) {
        // Remove the crew of an abandoned unit as well.
        for (const c of sim.characters) if (c.brain?.car === v && c.state !== 'inVehicle') c.brain.car = null;
        sim.removeVehicle(v);
      }
    }
    for (const c of sim.characters) {
      if (c.removed || !c.isLaw || c.state === 'inVehicle') continue;
      const d = Math.hypot(c.pos.x - pp.x, c.pos.z - pp.z);
      const visible = sim.isVisible(c.pos.x, c.pos.y, c.pos.z);
      if (!c.alive) {
        if ((c.deadTime > 30 && !visible) || d > 200) sim.removeCharacter(c);
      } else if ((d > 220 && !visible) || (level === 0 && this.calm > 12 && !c.brain?.car && d > 50 && !visible)) {
        sim.removeCharacter(c);
      }
    }
  }

  /** Removes every police unit (used on respawn). */
  dismissAll(): void {
    const sim = this.sim;
    for (const v of sim.vehicles) if (v.owner === 'police' && v.driver !== sim.player) sim.removeVehicle(v);
    for (const c of sim.characters) if (c.isLaw) sim.removeCharacter(c);
    for (const h of sim.helis) h.removed = true;
    this.bustTimer = 0;
  }
}

function damp1(cur: number, target: number, k: number): number {
  return cur + (target - cur) * clamp(k, 0, 1);
}
