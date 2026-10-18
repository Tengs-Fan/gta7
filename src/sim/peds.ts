// Pedestrian population (civilians and street gang members) and their AI.

import { clamp, moveAngleTowards } from '../core/math';
import { WATER_Y } from '../world/constants';
import { makeBrain, type PedBrain } from './brains';
import type { Character } from './entities';
import type { Sim } from './sim';

/**
 * Should a cowering ped put his hands up: the player is aiming a gun at him. Otherwise he crouches with his hands over
 * his head (cowerCrouched). CrowdView draws him by this rule, and combat hits him by it.
 */
export function cowerHandsUp(c: Character, p: Character | null): boolean {
  if (!p || p === c || !p.aiming || p.state !== 'normal' || p.inventory.current === 'fists') return false;
  if (c.brain?.threat === p) return true;
  // Peds that freeze when a gun is pointed at them keep no threat: judge by the aim line instead.
  const dx = c.pos.x - p.pos.x;
  const dz = c.pos.z - p.pos.z;
  const d = Math.hypot(dx, dz);
  if (d > 20) return false;
  const off = Math.atan2(dx, dz) - p.aimYaw;
  return d < 1 || Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) < 0.5;
}

/** A cowering ped crouched with his hands over his head: not held at gunpoint by `player` (see cowerHandsUp). */
export function cowerCrouched(c: Character, player: Character | null): boolean {
  return c.brain?.mode === 'cower' && c.state === 'normal' && !cowerHandsUp(c, player);
}

/** Turns from the escape direction a fleeing ped tries in turn, when the way ahead runs into the sea: either side, then back. */
const FLEE_TURNS = [0, Math.PI / 2, -Math.PI / 2, Math.PI] as const;

export class PedSystem {
  private timer = 0;
  private screamCooldown = 0;
  density = 1;

  constructor(private readonly sim: Sim) {
    // Once per trigger pull (a shotgun blast is one bang, not nine), from the muzzle.
    sim.events.on('weaponFired', (e) => {
      if (e.shooter && e.weapon !== 'fists') this.onViolence(e.x, e.z, e.shooter, e.weapon === 'pistol' ? 34 : 45);
    });
    sim.events.on('explosion', (e) => this.onViolence(e.x, e.z, null, 60));
    // Bystanders run from a killer whose blow they saw land; from the body when he only answers for the death (the
    // flames of a car he set alight): the fire is what they see.
    sim.events.on('characterKilled', (e) => {
      const seen = e.killer !== null && e.victim.lastAttacker === e.killer && e.victim.lastAttackTime === sim.time;
      this.onViolence(e.victim.pos.x, e.victim.pos.z, seen ? e.killer : null, 16);
    });
  }

  get targetCount(): number {
    const h = this.sim.clock.hours;
    return Math.round((h < 6 ? 14 : h < 8 ? 26 : h < 20 ? 40 : h < 23 ? 28 : 16) * this.density);
  }

  updateStreaming(dt: number): void {
    this.screamCooldown -= dt;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.5;
    const sim = this.sim;
    const pp = sim.playerPos();
    let count = 0;
    for (const c of sim.characters) {
      if (c.removed || c.persistent || c.isPlayer) continue;
      if (c.owner !== 'ped' && !(c.owner === 'traffic' && c.state !== 'inVehicle')) continue;
      const d = Math.hypot(c.pos.x - pp.x, c.pos.z - pp.z);
      if (!c.alive) {
        if ((c.deadTime > 30 && (d > 40 || !sim.isVisible(c.pos.x, c.pos.y, c.pos.z))) || d > 170) sim.removeCharacter(c);
        continue;
      }
      if (d > 150 || (d > 110 && !sim.isVisible(c.pos.x, c.pos.y, c.pos.z))) {
        sim.removeCharacter(c);
        continue;
      }
      if (c.owner === 'ped') count++;
    }
    let spawned = 0;
    while (count < this.targetCount && spawned < 4) {
      if (!this.trySpawn()) break;
      spawned++;
      count++;
    }
  }

  private trySpawn(): Character | null {
    const sim = this.sim;
    const pp = sim.playerPos();
    for (let tries = 0; tries < 6; tries++) {
      // Keep the crowd close: hidden spots (behind the camera or buildings) may be near.
      const pt = sim.world.walk.randomPointNear(sim.rng, pp.x, pp.z, 22, sim.rng.range(45, 100));
      if (!pt) return null;
      const d = Math.hypot(pt.x - pp.x, pt.z - pp.z);
      if (d < 55 && sim.isVisible(pt.x, 1, pt.z)) continue;
      if (sim.world.waterDepth(pt.x, pt.z) > -0.2) continue;
      if (!sim.traffic.isClear(pt.x, pt.z, 2.5)) continue;
      const zone = sim.world.zoneName(pt.x, pt.z);
      const gangTurf = zone === 'Port Azura Docks' || zone === 'Westside' || zone === 'Southgate';
      const role = gangTurf && sim.rng.chance(0.14) ? 'gang' : 'civilian';
      const c = sim.spawnCharacter(role, pt.x, pt.z);
      c.owner = 'ped';
      const b = makeBrain('wander');
      b.fromNode = pt.a;
      b.toNode = pt.b;
      b.lateral = sim.rng.range(-0.4, 0.6);
      b.speedMul = sim.rng.range(0.85, 1.15);
      b.brave = role === 'gang' ? true : sim.rng.chance(0.12);
      b.accuracy = role === 'gang' ? 0.35 : 0.2;
      c.brain = b;
      c.cash = role === 'gang' ? sim.rng.int(20, 120) : sim.rng.int(4, 60);
      if (role === 'gang' && sim.rng.chance(0.6)) {
        c.inventory.infinite = true;
        c.inventory.give('pistol', 999);
        c.inventory.current = 'fists';
      }
      const na = sim.world.walk.nodes[pt.a]!;
      const nb = sim.world.walk.nodes[pt.b]!;
      c.heading = Math.atan2(nb.x - na.x, nb.z - na.z);
      return c;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Reactions

  /** Something violent happened at (x, z): nearby civilians panic. */
  onViolence(x: number, z: number, attacker: Character | null, radius: number): void {
    for (const c of this.sim.characters) {
      if (c.removed || !c.brain || c.isLaw || c.isPlayer || !c.alive) continue;
      if (c.state === 'inVehicle' || c === attacker) continue;
      const b = c.brain;
      if (b.mode === 'stand') continue;
      const d = Math.hypot(c.pos.x - x, c.pos.z - z);
      if (d > radius) continue;
      if (attacker && this.allied(c, attacker)) {
        // A crewmate opened fire: back him up against the player, never turn on him or run from him.
        const t = attacker.brain?.target;
        if (b.hostile && b.mode !== 'fight' && t && t.isPlayer && t.alive) this.fight(c, t);
        continue;
      }
      // Hostiles only go after the player (or whoever hurts them, see onAttacked) and don't run from gunfire.
      if (attacker && attacker.isPlayer && (b.hostile || (b.brave && c.role === 'gang' && d < 25))) {
        this.fight(c, attacker);
      } else if (b.mode !== 'fight' && !(b.hostile && attacker)) {
        this.flee(c, attacker ? attacker.pos.x : x, attacker ? attacker.pos.z : z, attacker);
      }
    }
  }

  /** A character was hurt by `attacker`. */
  onAttacked(victim: Character, attacker: Character | null): void {
    if (!victim.brain || victim.isLaw || victim.isPlayer || !victim.alive) return;
    const b = victim.brain;
    if (b.mode === 'stand' && !b.hostile) return;
    // Friendly fire: take the hit and keep the current target.
    if (attacker && this.allied(victim, attacker)) return;
    if (attacker && (b.brave || b.hostile)) this.fight(victim, attacker);
    // Hurt by nothing in particular (fire, a fall) while already running: keep running from the known threat.
    else if (attacker || b.mode !== 'flee') this.flee(victim, attacker ? attacker.pos.x : victim.pos.x, attacker ? attacker.pos.z : victim.pos.z, attacker);
  }

  /** Gang members are one crew: they never fight, or run from, each other. */
  allied(a: Character, b: Character): boolean {
    return a !== b && a.role === 'gang' && b.role === 'gang';
  }

  /** A crewmate of `c` stands in the line of fire towards (tx, tz). */
  private allyInLine(c: Character, tx: number, tz: number): boolean {
    const dx = tx - c.pos.x;
    const dz = tz - c.pos.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return false;
    for (const o of this.sim.characters) {
      if (o.removed || !o.alive || o.state === 'inVehicle' || !this.allied(c, o)) continue;
      const ox = o.pos.x - c.pos.x;
      const oz = o.pos.z - c.pos.z;
      const along = (ox * dx + oz * dz) / len;
      if (along > 0 && along < len && Math.abs(ox * dz - oz * dx) / len < 0.8) return true;
    }
    return false;
  }

  onJacked(victim: Character): void {
    if (!victim.brain) victim.brain = makeBrain('flee');
    victim.owner = victim.owner === 'traffic' ? 'ped' : victim.owner;
    const p = this.sim.player;
    if (victim.isLaw) return;
    if (victim.brain.brave || victim.role === 'gang') this.fight(victim, p);
    else this.flee(victim, p.pos.x, p.pos.z, p);
  }

  flee(c: Character, fromX: number, fromZ: number, threat: Character | null): void {
    if (c.isPlayer) return;
    if (!c.brain) {
      // NPCs spawned without AI (traffic drivers) still need one to run away.
      c.brain = makeBrain('wander');
      c.brain.speedMul = this.sim.rng.range(0.85, 1.15);
    }
    const b = c.brain;
    const was = b.mode;
    b.mode = 'flee';
    b.threat = threat;
    b.threatX = fromX;
    b.threatZ = fromZ;
    b.modeTimer = this.sim.rng.range(8, 14);
    b.lateral = this.sim.rng.range(-0.6, 0.6);
    if (was !== 'flee' && this.screamCooldown <= 0) {
      this.screamCooldown = 1.2;
      this.sim.events.emit('scream', { x: c.pos.x, y: c.pos.y + 1.6, z: c.pos.z });
    }
  }

  fight(c: Character, target: Character): void {
    const b = c.brain;
    if (!b || target === c) return;
    b.mode = 'fight';
    b.target = target;
    b.modeTimer = 25;
    if (c.inventory.has('pistol') && c.inventory.current === 'fists') c.inventory.current = 'pistol';
  }

  // ---------------------------------------------------------------------------
  // Behaviour

  updateAI(dt: number): void {
    const sim = this.sim;
    const p = sim.player;
    // Civilians react to a gun being pointed at them.
    const aimingGun = p.aiming && p.inventory.current !== 'fists' && p.state === 'normal';
    for (const c of sim.characters) {
      if (c.removed || !c.brain || c.isLaw || c.isPlayer) continue;
      if (c.state !== 'normal' && c.state !== 'swimming') {
        c.moveSpeed = 0;
        continue;
      }
      if (aimingGun && (c.brain.mode === 'wander' || c.brain.mode === 'idle' || c.brain.mode === 'cross')) this.checkAimedAt(c);
      this.think(c, c.brain, dt);
    }
  }

  private checkAimedAt(c: Character): void {
    const sim = this.sim;
    const dir = sim.lastInput.aimDir;
    const o = sim.lastInput.aimOrigin;
    const dx = c.pos.x - o.x;
    const dy = c.pos.y + 1.2 - o.y;
    const dz = c.pos.z - o.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 16 || d < 0.5) return;
    const cos = (dx * dir.x + dy * dir.y + dz * dir.z) / d;
    if (cos < 0.985) return;
    // Only someone who can see the gun: not round a corner, through a wall or from outside a garage he is in
    // (from his eyes, as the police judge it: the camera can sit beyond a corner he cannot see past).
    const p = sim.player;
    if (!sim.world.lineOfSight(p.pos.x, p.pos.y + 1.5, p.pos.z, c.pos.x, c.pos.y + 1.2, c.pos.z)) return;
    const b = c.brain!;
    if (c.role === 'gang') this.fight(c, sim.player);
    else if (sim.rng.chance(0.5)) {
      b.mode = 'cower';
      b.modeTimer = sim.rng.range(2.5, 4.5);
    } else this.flee(c, sim.player.pos.x, sim.player.pos.z, sim.player);
  }

  think(c: Character, b: PedBrain, dt: number): void {
    switch (b.mode) {
      case 'wander':
        this.wander(c, b, dt);
        break;
      case 'cross':
        this.crossWait(c, b, dt);
        break;
      case 'idle':
        c.moveSpeed = 0;
        b.modeTimer -= dt;
        if (b.modeTimer <= 0) b.mode = 'wander';
        break;
      case 'flee':
        this.doFlee(c, b, dt);
        break;
      case 'cower':
        c.moveSpeed = 0;
        b.modeTimer -= dt;
        if (b.modeTimer <= 0) this.flee(c, this.sim.player.pos.x, this.sim.player.pos.z, this.sim.player);
        break;
      case 'fight':
        this.doFight(c, b, dt);
        break;
      case 'guard':
        this.doGuard(c, b, dt);
        break;
      case 'stand':
      case 'chase':
      case 'return':
      default:
        c.moveSpeed = 0;
        break;
    }
  }

  private steer(c: Character, tx: number, tz: number, speed: number, dt: number): number {
    const dx = tx - c.pos.x;
    const dz = tz - c.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) {
      c.moveSpeed = 0;
      return 0;
    }
    c.moveX = dx / d;
    c.moveZ = dz / d;
    c.moveSpeed = speed;
    c.heading = moveAngleTowards(c.heading, Math.atan2(dx, dz), 9 * dt);
    return d;
  }

  private nodeTarget(b: PedBrain): { x: number; z: number } {
    const walk = this.sim.world.walk;
    const to = walk.nodes[b.toNode]!;
    const from = walk.nodes[b.fromNode] ?? to;
    const ex = to.x - from.x;
    const ez = to.z - from.z;
    const el = Math.hypot(ex, ez) || 1;
    // Offset to the right of the walking direction.
    return { x: to.x + (-ez / el) * b.lateral, z: to.z + (ex / el) * b.lateral };
  }

  private wander(c: Character, b: PedBrain, dt: number): void {
    const sim = this.sim;
    const walk = sim.world.walk;
    if (b.toNode < 0 || !walk.nodes[b.toNode]) {
      b.toNode = walk.nearestNode(c.pos.x, c.pos.z);
      b.fromNode = b.toNode;
    }
    const t = this.nodeTarget(b);
    const d = this.steer(c, t.x, t.z, 1.45 * b.speedMul, dt);
    this.unstick(c, b, dt);
    if (d < 0.8) {
      const node = walk.nodes[b.toNode]!;
      const options = node.edges.filter((e) => e.to !== b.fromNode);
      const pool = options.length > 0 ? options : node.edges;
      if (pool.length === 0) return;
      const e = sim.rng.pick(pool);
      b.fromNode = b.toNode;
      b.toNode = e.to;
      if (e.crosswalk) {
        b.lateral = sim.rng.range(-1.1, 1.1);
        if (!sim.roads.pedCanCross(e.roadNode, e.axis!, sim.time)) {
          b.mode = 'cross';
          b.waitTimer = 0;
        }
      } else {
        b.lateral = sim.rng.range(-0.4, 0.6);
        if (sim.rng.chance(0.06)) {
          b.mode = 'idle';
          b.modeTimer = sim.rng.range(2, 6);
        }
      }
    }
  }

  private crossWait(c: Character, b: PedBrain, dt: number): void {
    const sim = this.sim;
    c.moveSpeed = 0;
    b.waitTimer += dt;
    const e = sim.world.walk.edge(b.fromNode, b.toNode);
    if (!e || !e.crosswalk || sim.roads.pedCanCross(e.roadNode, e.axis!, sim.time) || b.waitTimer > 40) b.mode = 'wander';
  }

  private doFlee(c: Character, b: PedBrain, dt: number): void {
    const sim = this.sim;
    if (b.threat && !b.threat.removed) {
      const tp = b.threat.vehicle ? b.threat.vehicle.pos : b.threat.pos;
      b.threatX = tp.x;
      b.threatZ = tp.z;
    }
    let dx = c.pos.x - b.threatX;
    let dz = c.pos.z - b.threatZ;
    const d = Math.hypot(dx, dz);
    if (d > 1e-3) {
      dx /= d;
      dz /= d;
    } else {
      // The threat is right here (hurt with no known source): turn back the way we came.
      dx = -Math.sin(c.heading);
      dz = -Math.cos(c.heading);
    }
    // Bend the escape direction a little per ped so crowds scatter. Never off a quay, a seawall or a pier into the sea:
    // the first of that direction, either side of it and back whose ground 3 and 6 m ahead is dry. Already in the
    // water, or with water all round, he makes for the nearest sidewalk instead, to climb out.
    const ang = Math.atan2(dx, dz) + b.lateral * 0.8;
    let tx = c.pos.x;
    let tz = c.pos.z;
    let way = false;
    if (c.state !== 'swimming') {
      for (const turn of FLEE_TURNS) {
        const sx = Math.sin(ang + turn);
        const sz = Math.cos(ang + turn);
        if (this.dry(c.pos.x + sx * 3, c.pos.z + sz * 3) && this.dry(c.pos.x + sx * 6, c.pos.z + sz * 6)) {
          tx = c.pos.x + sx * 6;
          tz = c.pos.z + sz * 6;
          way = true;
          break;
        }
      }
    }
    if (!way) {
      const n = sim.world.walk.nodes[sim.world.walk.nearestNode(c.pos.x, c.pos.z)]!;
      tx = n.x;
      tz = n.z;
    }
    this.steer(c, tx, tz, 6.3 * b.speedMul, dt);
    this.unstick(c, b, dt);
    b.modeTimer -= dt;
    if (b.modeTimer <= 0 && d > 28) {
      b.mode = 'wander';
      b.threat = null;
      b.toNode = sim.world.walk.nearestNode(c.pos.x, c.pos.z);
      b.fromNode = b.toNode;
    }
  }

  private doFight(c: Character, b: PedBrain, dt: number): void {
    const sim = this.sim;
    const t = b.target;
    b.modeTimer -= dt;
    if (!t || t.removed || !t.alive || b.modeTimer <= 0 || (t.isPlayer && sim.playerDown)) {
      b.target = null;
      if (b.hostile && b.homeX !== 0) {
        b.mode = 'guard';
      } else {
        b.mode = 'wander';
        b.toNode = sim.world.walk.nearestNode(c.pos.x, c.pos.z);
        b.fromNode = b.toNode;
      }
      c.aiming = false;
      return;
    }
    const tp = t.vehicle ? t.vehicle.pos : t.pos;
    const d = Math.hypot(tp.x - c.pos.x, tp.z - c.pos.z);
    if (d > 60 && !b.hostile) {
      b.modeTimer = 0;
      return;
    }
    const armed = c.inventory.current !== 'fists';
    c.aiming = false;
    if (armed) {
      const canSee = d < 38 && sim.world.lineOfSight(c.pos.x, c.pos.y + 1.5, c.pos.z, tp.x, tp.y + 1.2, tp.z);
      if (canSee && d < 30) {
        const yaw = Math.atan2(tp.x - c.pos.x, tp.z - c.pos.z);
        c.moveSpeed = 0;
        c.aiming = true;
        c.aimYaw = yaw;
        c.heading = moveAngleTowards(c.heading, yaw, 10 * dt);
        if (!this.allyInLine(c, tp.x, tp.z)) sim.combat.npcFire(c, t, b.accuracy);
        else {
          // Don't shoot through a crewmate: side-step for a clear line.
          const side = c.id % 2 === 0 ? 1 : -1;
          c.moveX = (-(tp.z - c.pos.z) / d) * side;
          c.moveZ = ((tp.x - c.pos.x) / d) * side;
          c.moveSpeed = 2.5;
        }
      } else {
        this.steer(c, tp.x, tp.z, 5.8, dt);
        this.unstick(c, b, dt);
      }
    } else {
      if (d > 1.15) {
        this.steer(c, tp.x, tp.z, d > 6 ? 6.2 : 4.5, dt);
        this.unstick(c, b, dt);
      } else {
        c.moveSpeed = 0;
        c.heading = moveAngleTowards(c.heading, Math.atan2(tp.x - c.pos.x, tp.z - c.pos.z), 12 * dt);
        // A man on the ground is let up first (and his first moments up do not count, see GET_UP_GRACE).
        if (c.fireCooldown <= 0 && !t.vehicle && t.state !== 'knocked') sim.combat.melee(c);
      }
    }
  }

  private doGuard(c: Character, b: PedBrain, dt: number): void {
    const sim = this.sim;
    const p = sim.player;
    const pp = sim.playerPos();
    const dp = Math.hypot(pp.x - c.pos.x, pp.z - c.pos.z);
    if (b.hostile && p.alive && !sim.playerDown && dp < 16 && sim.world.lineOfSight(c.pos.x, c.pos.y + 1.5, c.pos.z, pp.x, pp.y + 1.2, pp.z)) {
      this.fight(c, p);
      return;
    }
    const dh = Math.hypot(b.homeX - c.pos.x, b.homeZ - c.pos.z);
    if (dh > 2.5) this.steer(c, b.homeX, b.homeZ, 1.6, dt);
    else {
      c.moveSpeed = 0;
      c.heading = moveAngleTowards(c.heading, Math.atan2(pp.x - c.pos.x, pp.z - c.pos.z), 1.5 * dt);
    }
  }

  /** Dry ground to run on at (x, z): not the sea, nor the wet sand at its edge. */
  private dry(x: number, z: number): boolean {
    return this.sim.world.groundHeight(x, z) >= WATER_Y + 0.2;
  }

  /** Detects a ped pushing against a wall and nudges its path sideways. */
  private unstick(c: Character, b: PedBrain, dt: number): void {
    const moved = Math.hypot(c.pos.x - b.lastX, c.pos.z - b.lastZ);
    b.lastX = c.pos.x;
    b.lastZ = c.pos.z;
    if (c.moveSpeed > 0.5 && moved < c.moveSpeed * dt * 0.25) b.stuckTimer += dt;
    else b.stuckTimer = Math.max(0, b.stuckTimer - dt);
    if (b.stuckTimer > 0.8) {
      b.stuckTimer = 0;
      b.lateral = clamp(-b.lateral + (this.sim.rng.next() - 0.5) * 2, -1.5, 1.5);
      if (b.mode === 'wander') {
        // Give up on this edge.
        const tmp = b.toNode;
        b.toNode = b.fromNode >= 0 ? b.fromNode : tmp;
        b.fromNode = tmp;
      }
    }
  }
}
