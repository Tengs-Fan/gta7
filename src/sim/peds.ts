// Pedestrian population (civilians and street gang members) and their AI.

import { circleVsObb, makeContact } from '../core/collision';
import { clamp, moveAngleTowards } from '../core/math';
import { SWIM_DEPTH, WATER_Y } from '../world/constants';
import { makeBrain, type PedBrain } from './brains';
import { MAX_STEP } from './characterPhysics';
import type { Character, Vehicle } from './entities';
import { gangAt, setGang } from './gangs';
import type { PlayerSlot } from './playerSlot';
import type { Sim } from './sim';
import { clusterTarget, mpBudget, playerClusters } from './traffic';
import { isGun } from './specs';
import { vehicleObb } from './vehiclePhysics';

const contact = makeContact();
const obb = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };

/**
 * Should a cowering ped put his hands up: the player is aiming a gun at him. Otherwise he crouches with his hands over
 * his head (cowerCrouched). CrowdView draws him by this rule, and combat hits him by it.
 */
export function cowerHandsUp(c: Character, p: Character | null): boolean {
  if (!p || p === c || !p.aiming || p.state !== 'normal' || !isGun(p.inventory.current)) return false;
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

/** Dry ground to run on, at a ground height: not the sea, nor the wet sand at its edge (within 0.2 m of the water). */
function dryGround(y: number): boolean {
  return y >= WATER_Y + 0.2;
}

/**
 * Turns from the escape direction a fleeing ped tries in turn when the way ahead runs into the sea, the least first:
 * either side in steps of 22.5 degrees, then straight back. Fine enough to find the way along a 4 m finger pier, whatever
 * the angle he flees at.
 */
/** How far ahead (m) a fleeing ped makes sure of dry ground (see doFlee). */
const FLEE_PROBES: readonly number[] = [1.5, 3, 6];

const FLEE_TURNS: readonly number[] = (() => {
  const turns = [0];
  for (let k = 1; k < 8; k++) turns.push((k * Math.PI) / 8, (-k * Math.PI) / 8);
  turns.push(Math.PI);
  return turns;
})();

/**
 * A player driving faster than AHEAD_SPEED m/s outruns the crowd streamed round him (it walks at 1.5 m/s) and would
 * drive down empty pavements: the crowd streams ahead of him instead. New people appear within AHEAD_RING m of the
 * point AHEAD_LEAD s of travel ahead of him (AHEAD_REACH m at most), in his view no nearer than AHEAD_SEEN m (on foot:
 * NEAR_SEEN), and those he has left more than AHEAD_BEHIND m behind, out of view, make room for them. Single player
 * only: a room streams its crowd round each group of players.
 */
const AHEAD_SPEED = 6;
const AHEAD_LEAD = 3;
const AHEAD_REACH = 70;
const AHEAD_RING = 60;
const AHEAD_SEEN = 75;
const AHEAD_BEHIND = 60;
const NEAR_SEEN = 55;

/**
 * People get out of the way of a car a player is driving at them. Someone walking, waiting to cross or standing about
 * who is in the path of one going faster than DODGE_SPEED m/s (23 km/h: slower than that it is a car creeping round a
 * corner, whose driver can stop for him and for whom he need not run; when he ran from those too, a driver who
 * stopped for him and he for the driver did it six times over at one crossing) and within DODGE_MARGIN m of its
 * flanks notices it
 * DODGE_NOTICE m ahead of its bumper, up to DODGE_NOTICE_SPREAD m sooner by who he is, and dashes DODGE_TIME s at
 * DODGE_RUN m/s to the side he is on, never into the sea, and stands there DODGE_REST s and until the car has gone
 * DODGE_CLEAR m by or stopped (DODGE_REST_MAX s at most). The notice is a distance and not a time: at a crawl everyone steps clear,
 * at 70 km/h it is half a second's warning and some are clipped, and flat out nobody makes it. (They walked their
 * routes into the bonnet until round 8 put half as many again on the pavements, where every one of them hit is a call
 * to the police.)
 */
const DODGE_SPEED = 6.5;
const DODGE_NOTICE = 7;
const DODGE_NOTICE_SPREAD = 4;
const DODGE_MARGIN = 0.55;
/** A car turning faster than this (rad/s) is judged by the ring it sweeps, not by the line it is on (see PedSystem.dodge). */
const DODGE_TURN = 0.12;
/** Within this far (m) of a lane's centre line he is on the carriageway, and dashes across the lane for a kerb. */
const DODGE_LANE = 2;
const DODGE_RUN = 5.4;
const DODGE_TIME = 0.55;
const DODGE_REST = 2.5;
const DODGE_CLEAR = 6;
const DODGE_REST_MAX = 8;

/** populate(): nobody starts nearer the arriving player than this (m), and those further than ARRIVE_FAR m from him are let go first. */
const ARRIVE_NEAR = 9;
const ARRIVE_FAR = 110;

export class PedSystem {
  /** True while populate() fills the pavements: a spawn then takes no account of the players' view. */
  private arriving = false;
  /** The cars players are driving faster than DODGE_SPEED this step, with the unit direction they travel in (see dodge). */
  private readonly oncoming: Array<{ v: Vehicle; ux: number; uz: number }> = [];
  private timer = 0;
  private screamCooldown = 0;
  density = 1;
  /** Turns through a group's players for its spawns (multiplayer). */
  private turn = 0;

  constructor(private readonly sim: Sim) {
    // Once per trigger pull (a shotgun blast is one bang, not nine), from the muzzle.
    sim.events.on('weaponFired', (e) => {
      if (e.shooter && e.weapon !== 'fists') this.onViolence(e.x, e.z, e.shooter, e.weapon === 'pistol' ? 34 : 45);
    });
    sim.events.on('explosion', (e) => this.onViolence(e.x, e.z, null, 60));
    // Bystanders run from a killer whose blow they saw land; from the body when he only answers for the death (the
    // flames of a car he set alight dealt the fatal hit, whoever hit him before): the fire is what they see.
    sim.events.on('characterKilled', (e) => {
      const seen = e.killer !== null && e.victim.lastHitBy === e.killer;
      this.onViolence(e.victim.pos.x, e.victim.pos.z, seen ? e.killer : null, 16);
    });
  }

  get targetCount(): number {
    const h = this.sim.clock.hours;
    // A room keeps the crowd its server's tick and bandwidth are sized for.
    if (this.sim.multiplayer) return Math.round((h < 6 ? 14 : h < 8 ? 26 : h < 20 ? 40 : h < 23 ? 28 : 16) * this.density);
    return Math.round((h < 6 ? 18 : h < 8 ? 38 : h < 20 ? 60 : h < 23 ? 42 : 22) * this.density);
  }

  /** How far ahead of `slot` (m, along the unit vector written to `dir`) the crowd streams: 0 on foot or driving slowly. */
  private lead(slot: PlayerSlot, dir: { x: number; z: number }): number {
    const v = slot.character.vehicle;
    const speed = v ? Math.hypot(v.vel.x, v.vel.z) : 0;
    if (!v || speed <= AHEAD_SPEED || this.sim.multiplayer) return 0;
    dir.x = v.vel.x / speed;
    dir.z = v.vel.z / speed;
    return Math.min(AHEAD_REACH, speed * AHEAD_LEAD);
  }

  /**
   * Fills the pavements round the one player at once, in his view too, from ARRIVE_NEAR m of him: for the moment he
   * arrives somewhere he could not see a moment ago (see TrafficSystem.populate). Single player only.
   */
  populate(): void {
    const sim = this.sim;
    if (sim.multiplayer || sim.players.length > 1) return;
    const me = sim.activePlayers()[0] ?? sim.players[0]!;
    this.arriving = true;
    try {
      // The crowd streamed round where he was a moment ago is out of his reach now, and would fill the count: those
      // further off than the crowd streams (ARRIVE_FAR) go, as streaming lets them go over the next seconds.
      const pp = me.pos();
      let count = 0;
      for (const c of [...sim.characters]) {
        if (c.removed || c.persistent || c.isPlayer || !c.alive || c.owner !== 'ped') continue;
        if (Math.hypot(c.pos.x - pp.x, c.pos.z - pp.z) > ARRIVE_FAR) sim.removeCharacter(c);
        else count++;
      }
      for (let tries = this.targetCount * 3; count < this.targetCount && tries > 0; tries--) if (this.trySpawn(me)) count++;
    } finally {
      this.arriving = false;
    }
  }

  updateStreaming(dt: number): void {
    this.screamCooldown -= dt;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.5;
    const sim = this.sim;
    const active = sim.activePlayers();
    if (active.length > 1) {
      this.streamMulti(active);
      return;
    }
    const me = active[0] ?? sim.players[0]!;
    const pp = me.pos();
    const dir = { x: 0, z: 0 };
    const driving = this.lead(me, dir) > 0;
    let count = 0;
    for (const c of sim.characters) {
      if (c.removed || c.persistent || c.isPlayer) continue;
      if (c.owner !== 'ped' && !(c.owner === 'traffic' && c.state !== 'inVehicle')) continue;
      const d = Math.hypot(c.pos.x - pp.x, c.pos.z - pp.z);
      if (!c.alive) {
        if ((c.deadTime > 30 && (d > 40 || !sim.isVisible(c.pos.x, c.pos.y, c.pos.z))) || d > 170) sim.removeCharacter(c);
        continue;
      }
      // Far away, or out of view and either well off or left behind by a player driving on (see AHEAD_SPEED): those
      // just out walking, not one with business in hand (a driver he has angered, on his way back to his car).
      const behind = driving && d > AHEAD_BEHIND && c.brain?.mode === 'wander' && !c.brain.angryCar && (c.pos.x - pp.x) * dir.x + (c.pos.z - pp.z) * dir.z < 0;
      if (d > 150 || ((d > 110 || behind) && !sim.isVisible(c.pos.x, c.pos.y, c.pos.z))) {
        sim.removeCharacter(c);
        continue;
      }
      if (c.owner === 'ped') count++;
    }
    let spawned = 0;
    while (count < this.targetCount && spawned < 4) {
      if (!this.trySpawn(me)) break;
      spawned++;
      count++;
    }
  }

  /**
   * Multiplayer streaming: a pedestrian goes only far from every player and out of everyone's view; each group of
   * players (playerClusters) keeps its share of the crowd (clusterTarget), spawned round its players in turn.
   */
  private streamMulti(active: readonly PlayerSlot[]): void {
    const sim = this.sim;
    const groups = playerClusters(active);
    const groupOf = new Map<PlayerSlot, number>();
    groups.forEach((g, i) => g.forEach((s) => groupOf.set(s, i)));
    const target = clusterTarget(this.targetCount, groups.length);
    // Groups near each other share the crowd (the nearest player's group counts each): the total holds the budget too.
    const cap = Math.round(this.targetCount * mpBudget(groups.length));
    const counts = groups.map(() => 0);
    for (const c of sim.characters) {
      if (c.removed || c.persistent || c.isPlayer) continue;
      if (c.owner !== 'ped' && !(c.owner === 'traffic' && c.state !== 'inVehicle')) continue;
      const near = sim.nearestPlayer(c.pos.x, c.pos.z);
      const np = near.pos();
      const d = Math.hypot(c.pos.x - np.x, c.pos.z - np.z);
      // With several players nobody goes while any of them may see him, alive or dead.
      if (!c.alive) {
        if (((c.deadTime > 30 && d > 40) || d > 170) && !sim.isVisible(c.pos.x, c.pos.y, c.pos.z)) sim.removeCharacter(c);
        continue;
      }
      if (d > 110 && !sim.isVisible(c.pos.x, c.pos.y, c.pos.z)) {
        sim.removeCharacter(c);
        continue;
      }
      if (c.owner === 'ped') counts[groupOf.get(near) ?? 0]!++;
    }
    let total = counts.reduce((x, y) => x + y, 0);
    groups.forEach((g, gi) => {
      let count = counts[gi]!;
      let spawned = 0;
      while (count < target && total < cap && spawned < 4) {
        if (!this.trySpawn(g[this.turn++ % g.length]!)) break;
        spawned++;
        count++;
        total++;
      }
    });
  }

  private trySpawn(around: PlayerSlot): Character | null {
    const sim = this.sim;
    const pp = around.pos();
    const others = sim.players.length > 1;
    const dir = { x: 0, z: 0 };
    const lead = this.lead(around, dir);
    for (let tries = 0; tries < 6; tries++) {
      // Keep the crowd close: hidden spots (behind the camera or buildings) may be near. Ahead of a player driving,
      // round the point he is making for (see AHEAD_SPEED).
      const near = this.arriving ? ARRIVE_NEAR : 22;
      const pt = lead > 0 ? sim.world.walk.randomPointNear(sim.rng, pp.x + dir.x * lead, pp.z + dir.z * lead, 0, AHEAD_RING) : sim.world.walk.randomPointNear(sim.rng, pp.x, pp.z, near, sim.rng.range(45, 100));
      if (!pt) return null;
      const d = Math.hypot(pt.x - pp.x, pt.z - pp.z);
      if (d < near) continue;
      if (!this.arriving && d < (lead > 0 ? AHEAD_SEEN : NEAR_SEEN) && sim.isVisible(pt.x, 1, pt.z)) continue;
      // Never closer to another player, or nearer in his view, than the spawn ring allows round this one.
      if (others && (sim.distToPlayer(pt.x, pt.z) < Math.min(d, 22) || (sim.distToPlayer(pt.x, pt.z) < 55 && sim.isVisible(pt.x, 1, pt.z)))) continue;
      if (sim.world.waterDepth(pt.x, pt.z) > -0.2) continue;
      if (!sim.traffic.isClear(pt.x, pt.z, 2.5)) continue;
      const zone = sim.world.zoneName(pt.x, pt.z);
      // With the gangs (sim.streetCrime.gangs) each turf has its own gang (GANG_TURFS); without, the Tiburones all over.
      const turfGang = sim.streetCrime.gangs ? gangAt(sim.world.layout, pt.x, pt.z) : null;
      const gangTurf = sim.streetCrime.gangs ? turfGang !== null : zone === 'Port Azura Docks' || zone === 'Westside' || zone === 'Southgate';
      const role = gangTurf && sim.rng.chance(0.14) ? 'gang' : 'civilian';
      const c = sim.spawnCharacter(role, pt.x, pt.z);
      if (role === 'gang' && turfGang) setGang(c, turfGang);
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

  /**
   * One crew, who never fight, or run from, each other: gang members, and a mission's enemies (its own gangsters, and
   * the guards it hires, such as the bank's in The Big Score).
   */
  allied(a: Character, b: Character): boolean {
    return a !== b && ((a.role === 'gang' && b.role === 'gang' && (a.gang ?? 'tiburones') === (b.gang ?? 'tiburones')) || (a.missionTag === 'enemy' && b.missionTag === 'enemy'));
  }

  /** A street gang member's brain, walking the sidewalks from (x, z): he fights instead of running. */
  makeGangBrain(x: number, z: number): PedBrain {
    const b = makeBrain('wander');
    b.toNode = this.sim.world.walk.nearestNode(x, z);
    b.fromNode = b.toNode;
    b.brave = true;
    b.accuracy = 0.35;
    b.speedMul = 1;
    return b;
  }

  /** `victim` was pulled out of his car (or left a sinking one) by player `by` (slot 0's by default). */
  onJacked(victim: Character, by: Character = this.sim.player): void {
    if (!victim.brain) victim.brain = makeBrain('flee');
    victim.owner = victim.owner === 'traffic' ? 'ped' : victim.owner;
    const p = by;
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
    // Civilians react to a gun being pointed at them (by any player: in slot order, the first one aiming at him).
    const aiming = sim.players.filter((s) => {
      const p = s.character;
      return !s.parked && p.aiming && isGun(p.inventory.current) && p.state === 'normal';
    });
    this.oncoming.length = 0;
    for (const s of sim.players) {
      const v = s.parked ? null : s.character.vehicle;
      const speed = v ? Math.hypot(v.vel.x, v.vel.z) : 0;
      if (v && v.driver === s.character && speed > DODGE_SPEED) this.oncoming.push({ v, ux: v.vel.x / speed, uz: v.vel.z / speed });
    }
    for (const c of sim.characters) {
      if (c.removed || !c.brain || c.isLaw || c.isPlayer) continue;
      if (c.state !== 'normal' && c.state !== 'swimming') {
        c.moveSpeed = 0;
        c.brain.dodge = 0;
        continue;
      }
      if (c.state === 'normal' && this.dodge(c, c.brain, dt)) continue;
      for (const s of aiming) {
        if (c.brain.mode !== 'wander' && c.brain.mode !== 'idle' && c.brain.mode !== 'cross') break;
        this.checkAimedAt(c, s);
      }
      this.think(c, c.brain, dt);
    }
  }

  private checkAimedAt(c: Character, slot: PlayerSlot): void {
    const sim = this.sim;
    const dir = slot.input.aimDir;
    const o = slot.input.aimOrigin;
    const dx = c.pos.x - o.x;
    const dy = c.pos.y + 1.2 - o.y;
    const dz = c.pos.z - o.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 16 || d < 0.5) return;
    const cos = (dx * dir.x + dy * dir.y + dz * dir.z) / d;
    if (cos < 0.985) return;
    // Only someone who can see the gun: not round a corner, through a wall or from outside a garage he is in
    // (from his eyes, as the police judge it: the camera can sit beyond a corner he cannot see past).
    const p = slot.character;
    if (!sim.world.lineOfSight(p.pos.x, p.pos.y + 1.5, p.pos.z, c.pos.x, c.pos.y + 1.2, c.pos.z)) return;
    const b = c.brain!;
    if (c.role === 'gang') {
      // With turf (sim.streetCrime.gangs), a gun pointed at a member outside his gang's turf is no cause to fight.
      if (!sim.streetCrime.gangs || !c.gang || sim.gangs.inOwnTurf(c)) {
        this.fight(c, p);
        if (sim.streetCrime.gangs) b.turfAggroAt = sim.time;
      }
    } else if (sim.rng.chance(0.5)) {
      b.mode = 'cower';
      b.modeTimer = sim.rng.range(2.5, 4.5);
    } else this.flee(c, p.pos.x, p.pos.z, p);
  }

  /**
   * Out of the way of a car a player is driving at him (see DODGE_SPEED); true while he dashes and while he stands
   * clear after it, which is all he does then. PedBrain.dodge is the dash's seconds left while positive, and minus the
   * seconds he has stood clear while negative.
   */
  private dodge(c: Character, b: PedBrain, dt: number): boolean {
    const sim = this.sim;
    if (b.dodge < 0) {
      // Standing clear: DODGE_REST s at least (a driver who has stopped for him has that long to go on by: let go at
      // once he walked back into the path of a car that set off again as he stood, to dash and walk back again,
      // six times at one corner), and for as long as a player's car is still moving within DODGE_CLEAR m of him
      // (up to DODGE_REST_MAX s).
      b.dodge -= dt;
      let passing = false;
      for (const s of sim.players) {
        const v = s.parked ? null : s.character.vehicle;
        if (v && Math.hypot(v.vel.x, v.vel.z) > 1 && Math.hypot(v.pos.x - c.pos.x, v.pos.z - c.pos.z) < DODGE_CLEAR) passing = true;
      }
      if (-b.dodge < DODGE_REST || (passing && -b.dodge < DODGE_REST_MAX)) {
        c.moveSpeed = 0;
        return true;
      }
      b.dodge = 0;
      return false;
    }
    if (b.dodge === 0) {
      if (this.oncoming.length === 0 || (b.mode !== 'wander' && b.mode !== 'cross' && b.mode !== 'idle')) return false;
      const notice = DODGE_NOTICE + ((c.id % 5) / 4) * DODGE_NOTICE_SPREAD;
      const reach = DODGE_RUN * DODGE_TIME;
      for (const o of this.oncoming) {
        const dx = c.pos.x - o.v.pos.x;
        const dz = c.pos.z - o.v.pos.z;
        const front = dx * o.ux + dz * o.uz;
        if (front < 0 || front > notice + o.v.halfL + 2) continue;
        // How far to the side of its line he is: positive to the side (uz, -ux) points to, the side a rising heading turns to.
        const off = dx * o.uz - dz * o.ux;
        let nx: number;
        let nz: number;
        if (Math.abs(o.v.angVel) > DODGE_TURN) {
          // The car is turning: its path is the ring its body sweeps round the centre of its turn, and the way out of
          // it is along the ring's radius, inwards from inside its line and outwards from outside. (Judged by the
          // straight line it is on at the moment, he would dash to the side it is turning to, into its way.)
          const turn = Math.sign(o.v.angVel);
          const speed = Math.hypot(o.v.vel.x, o.v.vel.z);
          const r = Math.max(3, speed / Math.abs(o.v.angVel));
          // From the centre of the turn to him, and to the car.
          const px = dx - o.uz * turn * r;
          const pz = dz + o.ux * turn * r;
          const d = Math.hypot(px, pz);
          if (d < 1e-3 || Math.abs(d - r) > o.v.halfW + DODGE_MARGIN) continue;
          // How far round the ring ahead of the car's bumper he is.
          const ahead = r * Math.atan2(front, r - off * turn) - o.v.halfL;
          if (ahead < 0 || ahead > notice) continue;
          const way = d < r ? -1 : 1;
          nx = (px / d) * way;
          nz = (pz / d) * way;
        } else {
          if (front - o.v.halfL > notice || Math.abs(off) > o.v.halfW + DODGE_MARGIN) continue;
          // To the side he is on (dead ahead of it: one or the other, by who he is).
          const side = Math.abs(off) > 0.15 ? Math.sign(off) : c.id % 2 ? 1 : -1;
          nx = o.uz * side;
          nz = -o.ux * side;
        }
        // On a carriageway he makes for a kerb: across the lane he stands in, whichever way lies nearer the way out of
        // the car's path. (Out of a turning car's path alone, he dashed down the street it was turning into.)
        const on = sim.roads.nearestLane(c.pos.x, c.pos.z);
        if (on.dist < DODGE_LANE) {
          const way = on.lane.dz * nx - on.lane.dx * nz >= 0 ? 1 : -1;
          nx = on.lane.dz * way;
          nz = -on.lane.dx * way;
        }
        // Unless that way lies the sea: then the other way, if that is dry.
        if (sim.world.waterDepth(c.pos.x + nx * reach, c.pos.z + nz * reach) > -0.2) {
          nx = -nx;
          nz = -nz;
          if (sim.world.waterDepth(c.pos.x + nx * reach, c.pos.z + nz * reach) > -0.2) continue;
        }
        b.dodge = DODGE_TIME;
        b.dodgeX = nx;
        b.dodgeZ = nz;
        break;
      }
      if (b.dodge === 0) return false;
    }
    b.dodge -= dt;
    c.moveX = b.dodgeX;
    c.moveZ = b.dodgeZ;
    c.moveSpeed = DODGE_RUN;
    c.heading = moveAngleTowards(c.heading, Math.atan2(b.dodgeX, b.dodgeZ), 14 * dt);
    // The dash done, he stands clear (from the next step on).
    if (b.dodge <= 0) b.dodge = -1e-6;
    return true;
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
        if (b.modeTimer <= 0) {
          const near = this.sim.players.length > 1 ? this.sim.nearestPlayer(c.pos.x, c.pos.z).character : this.sim.player;
          this.flee(c, near.pos.x, near.pos.z, near);
        }
        break;
      case 'fight':
        this.doFight(c, b, dt);
        break;
      case 'guard':
        this.doGuard(c, b, dt);
        break;
      case 'phone':
        // On the phone to the police (witnesses.ts): he stands and talks until the call is over.
        c.moveSpeed = 0;
        b.modeTimer -= dt;
        if (c.phoneTimer <= 0 || b.modeTimer <= 0) b.mode = 'wander';
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
    if (!e || !e.crosswalk || sim.roads.pedCanCross(e.roadNode, e.axis!, sim.time)) b.mode = 'wander';
    // Tired of a broken light, a pedestrian crosses anyway; not at a junction held for a racer coming through.
    else if (b.waitTimer > 40 && sim.roads.signalHold(e.roadNode) === null) b.mode = 'wander';
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
    // the direction nearest it (see FLEE_TURNS) whose ground 1.5, 3 and 6 m ahead is dry (1.5 m keeps him from cutting
    // across the water where a coast turns inward, as round Azura Point), and no higher than he can step up
    // (not the side of a deck from the sand). When that way out lies back towards what he runs from (the end of a pier),
    // he is cornered and stays where he is, rather than pace back and forth at the edge. Off dry ground himself, on the
    // wet sand at the water's edge of the beach or wading in its shallows, every way along the beach is as wet as where
    // he stands: a way that leads no lower than that will do there (one that leads higher, in the water), so he runs
    // along the beach or up it, and is never cornered. Already swimming, or with water all round, he makes for the
    // nearest sidewalk instead, to climb out.
    const ang = Math.atan2(dx, dz) + b.lateral * 0.8;
    let tx = c.pos.x;
    let tz = c.pos.z;
    let way = false;
    let cornered = false;
    if (c.state !== 'swimming') {
      const own = sim.world.groundHeight(c.pos.x, c.pos.z);
      // On the wet sand or wading, the lowest ground ahead that will do as well as dry ground: as high as his own on the
      // sand, higher in the water.
      const shore = !dryGround(own) && own >= WATER_Y - SWIM_DEPTH;
      const low = !shore ? Infinity : own < WATER_Y ? own + 0.01 : own - 0.01;
      // On his feet, no higher than he steps up (in the air, cutting a corner of a deck, he may land back on it).
      const high = c.onGround ? own + MAX_STEP : Infinity;
      const open = (g: number) => g <= high && (dryGround(g) || g >= low);
      for (const turn of FLEE_TURNS) {
        const sx = Math.sin(ang + turn);
        const sz = Math.cos(ang + turn);
        let dry = true;
        for (const d of FLEE_PROBES) if (!open(sim.world.groundHeight(c.pos.x + sx * d, c.pos.z + sz * d))) dry = false;
        if (dry) {
          tx = c.pos.x + sx * 6;
          tz = c.pos.z + sz * 6;
          way = true;
          cornered = !shore && Math.abs(turn) > Math.PI / 2;
          break;
        }
      }
    }
    if (!way) {
      const n = sim.world.walk.nodes[sim.world.walk.nearestNode(c.pos.x, c.pos.z)]!;
      tx = n.x;
      tz = n.z;
    }
    if (cornered) c.moveSpeed = 0;
    else {
      this.steer(c, tx, tz, 6.3 * b.speedMul, dt);
      this.unstick(c, b, dt);
    }
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
    if (!t || t.removed || !t.alive || b.modeTimer <= 0 || (t.isPlayer && (sim.players.length > 1 ? !!sim.slotOf(t)?.down : sim.playerDown))) {
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
    const armed = isGun(c.inventory.current);
    c.aiming = false;
    if (armed) {
      const canSee = d < 38 && sim.world.lineOfSight(c.pos.x, c.pos.y + 1.5, c.pos.z, tp.x, tp.y + 1.2, tp.z);
      if (canSee && d < 30) {
        const yaw = Math.atan2(tp.x - c.pos.x, tp.z - c.pos.z);
        c.moveSpeed = 0;
        sim.combat.holdAim(c, t);
        c.heading = moveAngleTowards(c.heading, yaw, 10 * dt);
        // Don't shoot through a crewmate, or into a van that hides the target: side-step for a clear line. With no way
        // left to step (in a narrow gap between a wall and a bus, say), he fires all the same when the shot itself
        // clears the vehicle in the way, which only the margin kept round it for the spread of his shot reaches (a
        // round of that spread may graze it).
        const spare = (o: Character) => this.allied(c, o);
        const block = sim.combat.inLineOfFire(c, t, spare, true);
        const side = block ? this.stepSide(c, b, tp, d) : 0;
        if (!block) b.stepTurned = false;
        if (!block || (side === 0 && 'kind' in block && !sim.combat.inLineOfFire(c, t, spare, true, 0))) sim.combat.npcFire(c, t, b.accuracy);
        else if (side !== 0) {
          c.moveX = (-(tp.z - c.pos.z) / d) * side;
          c.moveZ = ((tp.x - c.pos.x) / d) * side;
          c.moveSpeed = 2.5;
        }
      } else {
        b.stepTurned = false;
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

  /**
   * Which way (1 or -1, across his line to `tp`, `d` m away) a gunman side-steps for a clear line of fire: the way he
   * last went (at first, the way his id picks) while it is open, else back the other way, once (to and fro across a
   * narrow passage would get him nowhere); 0 when there is no way to go. Open is ground at his level 1 m that way,
   * clear of walls, vehicles and the sea.
   */
  private stepSide(c: Character, b: PedBrain, tp: { x: number; z: number }, d: number): number {
    const sim = this.sim;
    const sx = -(tp.z - c.pos.z) / d;
    const sz = (tp.x - c.pos.x) / d;
    const open = (k: number) => {
      const x = c.pos.x + sx * k;
      const z = c.pos.z + sz * k;
      if (!sim.world.isFree(x, z, 0.4) || Math.abs(sim.world.groundHeight(x, z) - c.pos.y) > 0.4) return false;
      for (const v of sim.vehicles) {
        if (v.removed || Math.hypot(v.pos.x - x, v.pos.z - z) > v.halfL + v.halfW + 0.4) continue;
        vehicleObb(v, obb);
        if (circleVsObb(x, z, 0.4, obb, contact)) return false;
      }
      return true;
    };
    const side = b.stepSide || (c.id % 2 === 0 ? 1 : -1);
    if (open(side)) return (b.stepSide = side);
    if (b.stepTurned || !open(-side)) return 0;
    b.stepTurned = true;
    return (b.stepSide = -side);
  }

  private doGuard(c: Character, b: PedBrain, dt: number): void {
    const sim = this.sim;
    // The nearest player is the one a guard watches.
    const slot = sim.players.length > 1 ? sim.nearestPlayer(c.pos.x, c.pos.z) : sim.players[0]!;
    const p = slot.character;
    const pp = slot.pos();
    const dp = Math.hypot(pp.x - c.pos.x, pp.z - c.pos.z);
    if (b.hostile && p.alive && !slot.down && dp < 16 && sim.world.lineOfSight(c.pos.x, c.pos.y + 1.5, c.pos.z, pp.x, pp.y + 1.2, pp.z)) {
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
