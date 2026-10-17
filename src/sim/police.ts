// Police response: patrol cars, pursuit units, foot officers, SWAT, the
// helicopter, and arrests ("busted").

import { clamp, moveAngleTowards, pointSegDist, wrapAngle } from '../core/math';
import type { Lane } from '../world/roads';
import { makeBrain, type PedBrain } from './brains';
import { DispatchSystem } from './dispatch';
import { DriverAI } from './driver';
import { Helicopter, type Character, type Vehicle } from './entities';
import type { Sim } from './sim';

const UNITS_BY_LEVEL = [0, 2, 3, 4, 6, 7];
/** Seconds after a shot or a punch by the player during which officers treat him as fighting (no arrest, return fire). */
export const HOSTILE_WINDOW = 4;
/** From 3 stars, officers keep at least this far from an armed or fighting player instead of walking up to him. */
const STANDOFF = 12;
/** The others cover an arrester walking up to a still player this long at most (he may be stuck: then they open fire). */
const ARREST_PATIENCE = 12;
/** Crews fire from pursuit cars (from 2 stars) at a player within this range and in sight, rechecked this often. */
const CAR_FIRE_RANGE = 35;
const CAR_SIGHT_INTERVAL = 0.35;
/** Accuracy of fire from a car: 0.25 at 2 stars, 0.05 more per star. */
const carAccuracy = (level: number) => 0.25 + 0.05 * (level - 2);
/** A pursuit unit this far from the player, out of sight and not this much closer than RECYCLE_WINDOW s ago, is replaced by one nearer. */
const RECYCLE_DIST = 170;
const RECYCLE_WINDOW = 6;
const RECYCLE_CLOSING = 5;
/** Pursuit units cut off a fast player from lanes this far ahead of him. */
const AHEAD_MIN = 90;
const AHEAD_MAX = 180;
/** Helicopter: spawn distance from where the police think the player is, cruise and dash speeds, and the dash range. */
const HELI_SPAWN_DIST = 150;
const HELI_SPEED = 40;
const HELI_DASH_SPEED = 55;
const HELI_DASH_RANGE = 120;
/** No new helicopter for this many seconds after one is shot down. */
export const HELI_RESPAWN_DELAY = 45;
/** Helicopter: horizontal reach of its rotor and tail, and the height it keeps above roofs. */
const HELI_PAD = 7;
const HELI_CLEARANCE = 4;
/** Orbit spots tried in turn while the regular one is over a building: [radius, angle offset]. */
const HELI_SPOTS: ReadonlyArray<readonly [number, number]> = [24, 16, 8]
  .flatMap((r) => [0, 1, -1, 2, -2, 3, -3, 4].map((k) => [r, (k * Math.PI) / 4] as const))
  .concat([[0, 0]]);

export class PoliceSystem {
  private dispatchTimer = 0;
  private patrolTimer = 3;
  private cleanupTimer = 0;
  bustTimer = 0;
  private calm = 0;
  /** Seconds each unit has been waiting for its crew to get back in. */
  private readonly crewWait = new WeakMap<Vehicle, number>();
  /** Destinations handed out to units searching for the player: when, and how far from the last sighting the unit was then. */
  private readonly searchDests = new WeakMap<object, { at: number; from: number }>();
  private wasSearching = false;
  /** Sim time of the player's last shot or punch. */
  private playerHostileAt = -Infinity;
  /** Per pursuit unit: when its crew last checked for a line of fire to the player, and the answer. */
  private readonly carSight = new WeakMap<Vehicle, { at: number; clear: boolean }>();
  /** Per pursuit unit: when its recycle window started and how far from the player it was then. */
  private readonly trail = new WeakMap<Vehicle, { t: number; d: number }>();
  /** Alternates the pursuit spawns for a fast player between lanes ahead of him and the usual ring. */
  private aheadTurn = false;
  /** No helicopter is sent before this sim time (one was just shot down). */
  heliCooldownUntil = -Infinity;
  /** Police radio chatter for the HUD, updated after everything else here. */
  readonly dispatcher: DispatchSystem;

  constructor(private readonly sim: Sim) {
    this.dispatcher = new DispatchSystem(sim);
  }

  /** Seconds the player's vehicle has been (nearly) stationary. */
  private playerStill = 0;
  /** Seconds the player's vehicle has been stopped (below 1.2 m/s). */
  private playerStopped = 0;
  /** The officer walking up to arrest the player this frame, and whether he is making the arrest (see pickArrester). */
  private arrester: Character | null = null;
  private arresting = false;
  /** Seconds that arrester has been walking up to the player without a bust under way. */
  private arrestWalk = 0;

  update(dt: number): void {
    const sim = this.sim;
    if (!sim.policeEnabled) return;
    const p = sim.player;
    if (p.shotTimer > 0 || p.punchTimer > 0) this.playerHostileAt = sim.time;
    const level = sim.playerDown ? 0 : sim.wanted.level;
    const pv = p.vehicle;
    this.playerStill = pv && pv.speed < 1.5 ? this.playerStill + dt : 0;
    this.playerStopped = pv && pv.speed < 1.2 ? this.playerStopped + dt : 0;
    this.calm = level === 0 ? this.calm + dt : 0;
    this.pickArrester(dt, level);
    this.updateUnits(dt, level);
    this.updateFootCops(dt, level);
    this.updateHelis(dt, level);
    this.updateBust(dt, level);
    this.dispatch(dt, level);
    this.patrols(dt, level);
    this.cleanup(dt, level);
    this.dispatcher.update();
  }

  /** The police have lost sight of the player and look around his last sighting instead. */
  private searching(level: number): boolean {
    return level > 0 && this.sim.wanted.searching;
  }

  /** The player shot or punched in the last HOSTILE_WINDOW seconds. */
  private playerHostile(): boolean {
    return this.sim.time - this.playerHostileAt < HOSTILE_WINDOW;
  }

  /** The player is on foot with a weapon in hand. */
  private playerArmed(): boolean {
    const p = this.sim.player;
    return !p.vehicle && p.inventory.current !== 'fists';
  }

  /**
   * May the police take the player in right now (rather than only shoot)? Never one who is fighting.
   * Up to 2 stars: one who is not getting away (or is unarmed), not hiding and not aiming at them.
   * From 3 stars: an unarmed player on foot, or one who has sat in a stopped car for a while.
   */
  private arrestAllowed(level: number): boolean {
    const sim = this.sim;
    const p = sim.player;
    const pv = p.vehicle;
    if (level === 0 || sim.playerDown || !p.alive || sim.missions.noBust || this.playerHostile()) return false;
    if (level <= 2) {
      const unarmed = !pv && p.inventory.current === 'fists';
      const aiming = !unarmed && p.state !== 'knocked' && p.aiming;
      const arrestable = pv ? pv.speed < 1.2 : p.speed < 2.2 || p.state === 'knocked';
      return !this.searching(level) && !aiming && (arrestable || unarmed);
    }
    return pv ? pv.speed < 1.2 && this.playerStopped > 2.5 : !this.playerArmed();
  }

  private playerSpeed(): number {
    const p = this.sim.player;
    return p.vehicle ? p.vehicle.speed : p.speed;
  }

  /** Where the police believe the player is. */
  private knownPos(level: number): { x: number; z: number } {
    const w = this.sim.wanted;
    return this.searching(level) ? { x: w.lastSeenX, z: w.lastSeenZ } : this.sim.playerPos();
  }

  // ---------------------------------------------------------------------------
  // Units (cars)

  /** A police car on duty: crewed by live officers, and not driven by anyone else. */
  private isUnit(v: Vehicle): boolean {
    if (v.owner !== 'police' || v.removed || !v.drivable || (v.driver && !v.driver.isLaw)) return false;
    return v.occupants().some((c) => c.isLaw && c.alive) || this.sim.characters.some((c) => !c.removed && c.isLaw && c.alive && c.brain?.car === v);
  }

  private chasingUnits(): number {
    let n = 0;
    for (const v of this.sim.vehicles) if (this.isUnit(v)) n++;
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
    for (const v of this.sim.vehicles) if (this.isUnit(v) && Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z) < 300) n++;
    if (n < 2) this.spawnUnit('police', false);
  }

  /**
   * Spawns a police car on a lane 95-215 m from the player, preferably out of sight.
   * While the police are searching, pursuit units join the search around the last sighting,
   * heading its way from near it, or at least from its side of that ring.
   * A player driving off fast is cut off instead: every second pursuit unit comes his way down a
   * road ahead of him.
   */
  spawnUnit(kind: 'police' | 'swat', pursuit: boolean): Vehicle | null {
    const sim = this.sim;
    const pp = sim.playerPos();
    const w = sim.wanted;
    const searching = pursuit && this.searching(w.level);
    if (pursuit && !searching && this.playerSpeed() > 10) {
      this.aheadTurn = !this.aheadTurn;
      const spot = this.aheadTurn ? this.laneAhead() : null;
      if (spot) return this.placeUnit(kind, true, false, spot.lane, spot.s);
    }
    const goal = searching ? { x: w.lastSeenX, z: w.lastSeenZ } : pp;
    const lanes = sim.roads.lanes;
    // Search reinforcements preferably start a short drive from the search area. Failing that, they
    // start nearer to it than the player is, on a lane heading for it and away from him, and at least
    // 120 m from him, well beyond the 80 m an officer sees: their way there should not lead past
    // where he hides.
    const reach = w.searchRadius() + 130;
    const seenDist = Math.hypot(pp.x - goal.x, pp.z - goal.z);
    const near = searching ? lanes.filter((l) => pointSegDist(goal.x, goal.z, l.sx, l.sz, l.ex, l.ez) < reach && pointSegDist(pp.x, pp.z, l.sx, l.sz, l.ex, l.ez) < 215) : lanes;
    for (let tries = 0; tries < 30; tries++) {
      const lane = sim.rng.pick(tries < 20 && near.length > 0 ? near : lanes);
      const s = sim.rng.range(5, Math.max(6, lane.length - 5));
      const x = lane.sx + lane.dx * s;
      const z = lane.sz + lane.dz * s;
      const d = Math.hypot(x - pp.x, z - pp.z);
      if (d < 95 || d > 215) continue;
      if (searching && Math.hypot(x - goal.x, z - goal.z) > (tries < 20 ? reach : seenDist)) continue;
      if (pursuit && (goal.x - x) * lane.dx + (goal.z - z) * lane.dz < 0 && (tries < 20 || searching)) continue;
      if (searching && tries >= 20 && ((x - pp.x) * lane.dx + (z - pp.z) * lane.dz < 0 || d < 120)) continue;
      if (d < 160 && sim.isVisible(x, 1, z) && tries < 25) continue;
      if (!sim.traffic.isClear(x, z, 9)) continue;
      return this.placeUnit(kind, pursuit, searching, lane, s);
    }
    return null;
  }

  /** Puts a crewed police car on `lane` at `s`, on patrol, joining the search, or chasing the player. */
  private placeUnit(kind: 'police' | 'swat', pursuit: boolean, searching: boolean, lane: Lane, s: number): Vehicle {
    const sim = this.sim;
    const x = lane.sx + lane.dx * s;
    const z = lane.sz + lane.dz * s;
    const v = sim.spawnVehicle(kind, x, z, lane.heading);
    v.owner = 'police';
    const driver = sim.addDriver(v, kind === 'swat' ? 'swat' : 'cop', pursuit ? 'chase' : 'traffic');
    this.equip(driver, v);
    v.ai!.setLane(lane, s);
    if (pursuit) {
      if (searching) this.assignSearch(v.ai!);
      else v.ai!.target = sim.player;
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

  /**
   * A spot AHEAD_MIN-AHEAD_MAX m ahead of a fast player (along his velocity, within 45 degrees of it) on
   * a lane coming his way, out of sight and clear of traffic; null when none turns up.
   */
  private laneAhead(): { lane: Lane; s: number } | null {
    const sim = this.sim;
    const p = sim.player;
    const pp = sim.playerPos();
    const vx = p.vehicle ? p.vehicle.vel.x : p.vel.x;
    const vz = p.vehicle ? p.vehicle.vel.z : p.vel.z;
    const sp = Math.hypot(vx, vz);
    if (sp < 1e-6) return null;
    const ux = vx / sp;
    const uz = vz / sp;
    const mid = (AHEAD_MIN + AHEAD_MAX) / 2;
    const cx = pp.x + ux * mid;
    const cz = pp.z + uz * mid;
    const lanes = sim.roads.lanes.filter((l) => l.dx * ux + l.dz * uz < -0.5 && pointSegDist(cx, cz, l.sx, l.sz, l.ex, l.ez) < mid);
    for (let tries = 0; tries < 16 && lanes.length > 0; tries++) {
      const lane = sim.rng.pick(lanes);
      const s = sim.rng.range(5, Math.max(6, lane.length - 5));
      const x = lane.sx + lane.dx * s;
      const z = lane.sz + lane.dz * s;
      const ahead = (x - pp.x) * ux + (z - pp.z) * uz;
      const side = Math.abs((x - pp.x) * uz - (z - pp.z) * ux);
      if (ahead < AHEAD_MIN || ahead > AHEAD_MAX || side > ahead) continue;
      if (sim.isVisible(x, 1, z) || !sim.traffic.isClear(x, z, 9)) continue;
      return { lane, s };
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

  private updateUnits(dt: number, level: number): void {
    const sim = this.sim;
    const p = sim.player;
    const pv = p.vehicle;
    const pp = sim.playerPos();
    const w = sim.wanted;
    const searching = this.searching(level);
    // Spotted again after a search: drop the search routes.
    const resumed = !searching && this.wasSearching;
    this.wasSearching = searching;
    for (const v of sim.vehicles) {
      if (v.owner !== 'police' || v.removed || !v.drivable || !v.driver || !v.driver.isLaw || !v.ai) continue;
      const ai = v.ai;
      // Keep still while the player climbs in to take the car.
      const boarding = p.state === 'entering' && p.enterTarget === v;
      if (level === 0) {
        if (ai.policy === 'chase') {
          ai.setPolicy('traffic');
          ai.target = null;
          ai.dest = null;
          ai.resetPath();
          v.siren = false;
        }
        ai.hold = boarding || this.holdForCrew(v, dt, level);
        continue;
      }
      if (ai.policy !== 'chase') ai.setPolicy('chase');
      v.siren = true;
      if (searching) {
        const r = w.searchRadius();
        const dest = ai.dest;
        const job = dest ? this.searchDests.get(dest) : undefined;
        const fromSeen = Math.hypot(v.pos.x - w.lastSeenX, v.pos.z - w.lastSeenZ);
        // A new spot once there, or once the area moved; also when the unit drives away from the
        // area or still is not there after a while, so it comes back instead of wandering off.
        if (!dest || !job || Math.hypot(dest.x - v.pos.x, dest.z - v.pos.z) < 18 || Math.hypot(dest.x - w.lastSeenX, dest.z - w.lastSeenZ) > r || fromSeen > Math.max(job.from, r) + 30 || sim.time - job.at > 20) {
          this.assignSearch(ai);
        }
        ai.hold = boarding || this.holdForCrew(v, dt, level);
        continue;
      }
      if (resumed) {
        // Back to full pursuit speed (see assignSearch).
        ai.setPolicy('chase');
        ai.resetPath();
      }
      const d = Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z);
      // Pull up behind a player car that is stopped (or being shoved without power) instead of
      // ramming it: heading for its position rather than for the player makes it an obstacle.
      const contact = !!pv && d < v.halfL + pv.halfL + 1.5;
      const yielding = !!pv && pv.controls.throttle < 0.1 && (pv.speed < 4 || contact);
      ai.target = yielding ? null : p;
      ai.dest = yielding && pv ? pv.pos : null;
      // Officers get out to arrest a player on foot, or one sitting in a stopped car.
      const playerStopped = !!pv && pv.speed < 1.5 && this.playerStill > 2.5;
      const close = d < 26 && v.speed < 4.5;
      // A unit stuck behind others near an on-foot player sends its crew on foot.
      const stuckNear = !pv && d < 55 && v.stuckTime > 2.5;
      if ((!pv || playerStopped) && (close || stuckNear)) this.deploy(v);
      // The hold's handbrake only to stop the last bit of a shove: at speed, braking for the car
      // ahead (no longer the target) keeps the unit steering.
      else {
        ai.hold = boarding || (yielding && contact && v.speed < 4) || this.holdForCrew(v, dt, level);
        if (level >= 2) this.fireFromCar(v, d, level);
      }
    }
  }

  /**
   * The crew of a chasing unit (never the driver; SWAT only from 4 stars) shoots out of the windows at
   * a player in range and in sight. Not while the unit rams him (closes in on him fast from near: a
   * unit keeping pace on his tail fires away), nor at a player on foot beside it, nor while a partner
   * makes an arrest.
   */
  private fireFromCar(v: Vehicle, d: number, level: number): void {
    const sim = this.sim;
    const p = sim.player;
    const pv = p.vehicle;
    if (d > CAR_FIRE_RANGE || sim.playerDown || !p.alive || this.arresting || (v.kind === 'swat' && level < 4)) return;
    const pp = sim.playerPos();
    const closing = ((v.vel.x - (pv ? pv.vel.x : p.vel.x)) * (pp.x - v.pos.x) + (v.vel.z - (pv ? pv.vel.z : p.vel.z)) * (pp.z - v.pos.z)) / Math.max(d, 1e-6);
    if ((d < 8 && closing > 4) || (!pv && d < 6)) return;
    if (!v.passengers.some((c) => c && c.alive && c.isLaw)) return;
    let sight = this.carSight.get(v);
    if (!sight || sim.time - sight.at >= CAR_SIGHT_INTERVAL) {
      sight = { at: sim.time, clear: sim.world.lineOfSight(v.pos.x, v.pos.y + v.spec.height * 0.75, v.pos.z, pp.x, pp.y + 1, pp.z) };
      this.carSight.set(v, sight);
    }
    if (!sight.clear) return;
    for (const c of v.passengers) {
      if (c && c.alive && c.isLaw) sim.combat.npcFire(c, p, carAccuracy(level), true);
    }
  }

  /**
   * Sends a unit to a road point in the search area around the last sighting: of a few random
   * ones, the one most ahead of it that its route reaches without a U-turn (routes cannot make
   * one), at a speed that lets it look around rather than wreck itself.
   */
  private assignSearch(ai: DriverAI): void {
    const sim = this.sim;
    const roads = sim.roads;
    const w = sim.wanted;
    const r = w.searchRadius();
    const v = ai.vehicle;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const roadNear = (x: number, z: number) => {
      const { lane, s } = roads.nearestLane(x, z);
      return { x: lane.sx + lane.dx * s, z: lane.sz + lane.dz * s };
    };
    // The lane the route starts from (see DriverAI.resetPath).
    const lane = roads.nearestLane(v.pos.x, v.pos.z, v.heading).lane;
    // Failing all else, the road nearest to the sighting itself.
    let dest = roadNear(w.lastSeenX, w.lastSeenZ);
    let best = -Infinity;
    for (let tries = 0; tries < 6; tries++) {
      const a = sim.rng.range(0, Math.PI * 2);
      const k = sim.rng.range(0, r);
      const pt = roadNear(w.lastSeenX + Math.cos(a) * k, w.lastSeenZ + Math.sin(a) * k);
      const d = Math.hypot(pt.x - v.pos.x, pt.z - v.pos.z);
      if (Math.hypot(pt.x - w.lastSeenX, pt.z - w.lastSeenZ) > r || d < 25) continue;
      let score = ((pt.x - v.pos.x) * fx + (pt.z - v.pos.z) * fz) / d;
      const route = roads.findRoute(lane.to, roads.nearestNode(pt.x, pt.z).id);
      if (route && route.length > 1 && route[1] === lane.from) score -= 2;
      if (score > best) {
        best = score;
        dest = pt;
      }
    }
    // All of them behind: turn round in the street instead, slowly, heading for the road a little
    // way back (close enough for the driver to go straight at it) if that is still in the area.
    let turn = false;
    if (best < -1 && best > -Infinity) {
      for (const back of [30, 45]) {
        const pt = roadNear(v.pos.x - fx * back, v.pos.z - fz * back);
        if (Math.hypot(pt.x - w.lastSeenX, pt.z - w.lastSeenZ) <= r && Math.hypot(pt.x - v.pos.x, pt.z - v.pos.z) >= 25) {
          dest = pt;
          turn = true;
          break;
        }
      }
    }
    this.searchDests.set(dest, { at: sim.time, from: Math.hypot(v.pos.x - w.lastSeenX, v.pos.z - w.lastSeenZ) });
    ai.target = null;
    ai.dest = dest;
    ai.speedMul = 1.2;
    ai.maxSpeed = turn ? 8 : 20;
    ai.resetPath();
  }

  /** True while an officer of this car is still walking back to it (and it has a seat for him). */
  private crewOnFoot(v: Vehicle, level: number): boolean {
    if (!v.passengers.includes(null)) return false;
    for (const c of this.sim.characters) {
      const b = c.brain;
      if (c.removed || !c.isLaw || !c.alive || c.state === 'inVehicle' || !b || b.car !== v) continue;
      if (level > 0 && b.mode !== 'return') continue;
      if (Math.hypot(c.pos.x - v.pos.x, c.pos.z - v.pos.z) < 45) return true;
    }
    return false;
  }

  /** Keeps a unit waiting while its crew walks back to it, but not for ever. */
  private holdForCrew(v: Vehicle, dt: number, level: number): boolean {
    if (!this.crewOnFoot(v, level)) {
      this.crewWait.delete(v);
      return false;
    }
    const t = (this.crewWait.get(v) ?? 0) + dt;
    if (t < (level > 0 ? 8 : 30)) {
      this.crewWait.set(v, t);
      return true;
    }
    // Leave the stragglers behind: without a car, cleanup removes them once out of view.
    for (const c of this.sim.characters) if (c.brain?.car === v && c.state !== 'inVehicle') c.brain.car = null;
    this.crewWait.delete(v);
    return false;
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
    const pv = p.vehicle;
    const pp = sim.playerPos();
    const searching = this.searching(level);
    // At 2+ stars officers shoot on sight, and at any level right after an attack on one of them,
    // except the arrester (see pickArrester), while the others hold fire as he makes the arrest.
    // Not while the player fights or holds them off with a gun: they all fire back, and from 3
    // stars nobody walks up to an armed or fighting player.
    const arrester = this.arrester;
    const arresting = this.arresting;
    const fireAtWill = level >= 2 || sim.time - sim.wanted.lastCopAssaultAt < HOSTILE_WINDOW;
    const standOff = level >= 3 && (this.playerArmed() || this.playerHostile());
    // Officers walk up to the driver's door: the arrest radius around a long vehicle's centre does not reach its ends.
    const ax = pv ? pv.pos.x + Math.cos(pv.heading) * (pv.halfW + 0.6) : pp.x;
    const az = pv ? pv.pos.z - Math.sin(pv.heading) * (pv.halfW + 0.6) : pp.z;
    for (const c of sim.characters) {
      if (c.removed || !c.isLaw || !c.alive || !c.brain) continue;
      const b = c.brain;
      // A cruiser someone else took (the player stole it) is no longer this officer's car.
      if (b.car && (b.car.owner !== 'police' || (b.car.driver && !b.car.driver.isLaw))) b.car = null;
      if (c.state !== 'normal' && c.state !== 'swimming') {
        c.moveSpeed = 0;
        continue;
      }
      c.aiming = false;
      const car = b.car && !b.car.removed && b.car.drivable ? b.car : null;
      const carDist = car ? Math.hypot(car.pos.x - c.pos.x, car.pos.z - c.pos.z) : Infinity;
      if (level === 0) {
        // Get back in (a partner at the wheel waits with the door open); otherwise walk off.
        if (car && carDist < 45 && (!car.driver || (car.speed < 1 && car.passengers.includes(null)))) this.walkToCar(c, car, dt, level);
        else {
          // Cleanup removes officers without a car once out of view.
          b.car = null;
          c.moveX = Math.sin(c.heading);
          c.moveZ = Math.cos(c.heading);
          c.moveSpeed = 1.4;
        }
        continue;
      }
      const d = Math.hypot(pp.x - c.pos.x, pp.z - c.pos.z);
      // Run back to the car while the player drives off, as long as the car can still take this officer.
      const ride = car && carDist < 60 && (!car.driver || (car.speed < 3 && car.passengers.includes(null))) ? car : null;
      if (pv && d > 34 && ride && carDist < 45) b.mode = 'return';
      if (b.mode === 'return') {
        if (!ride || (!searching && (d < 25 || (!!pv && pv.speed < 1.5 && d < 34)))) b.mode = 'chase';
        else {
          this.walkToCar(c, ride, dt, level);
          continue;
        }
      }
      if (searching) {
        this.searchOnFoot(c, b, dt);
        continue;
      }
      const canSee = d < 48 && sim.world.lineOfSight(c.pos.x, c.pos.y + 1.6, c.pos.z, pp.x, pp.y + 1.2, pp.z);
      const shoot = fireAtWill && canSee && d < 32 && !sim.playerDown && c !== arrester;
      const yaw = Math.atan2(pp.x - c.pos.x, pp.z - c.pos.z);
      if (shoot) {
        c.moveSpeed = 0;
        c.aiming = true;
        c.aimYaw = yaw;
        c.heading = moveAngleTowards(c.heading, yaw, 9 * dt);
        if (!arresting && Math.abs(wrapAngle(yaw - c.heading)) < 0.3) sim.combat.npcFire(c, p, b.accuracy);
        // Close in a bit when far.
        if (d > 22) this.runTo(c, pp.x, pp.z, 3.2, dt);
      } else if (standOff && c !== arrester && d < STANDOFF) {
        // Near an armed or fighting player but without a line of fire: hold here, facing him.
        c.moveSpeed = 0;
        c.heading = moveAngleTowards(c.heading, yaw, 10 * dt);
      } else {
        const da = Math.hypot(ax - c.pos.x, az - c.pos.z);
        if (da > (pv ? 0.6 : 1.1)) this.runTo(c, ax, az, da > 8 ? 6.4 : 4.2, dt);
        else {
          c.moveSpeed = 0;
          c.heading = moveAngleTowards(c.heading, yaw, 10 * dt);
        }
      }
    }
  }

  /**
   * The nearest officer on foot (never SWAT) walks up to arrest a player the police may take in (see
   * arrestAllowed). While he walks up to a player who is not getting away (for ARREST_PATIENCE seconds
   * at most), and while a bust is under way, he is arresting: everyone else, in the street, in a car or
   * in the air, holds fire meanwhile.
   */
  private pickArrester(dt: number, level: number): void {
    const sim = this.sim;
    const p = sim.player;
    const pv = p.vehicle;
    const pp = sim.playerPos();
    const arrestable = pv ? pv.speed < 1.2 : p.speed < 2.2 || p.state === 'knocked';
    const a = !this.searching(level) && this.arrestAllowed(level) ? this.nearestOfficer(pp.x, pp.z, 32, pp.y) : null;
    const walking = !!a && arrestable && this.bustTimer === 0;
    this.arrestWalk = walking && a === this.arrester ? this.arrestWalk + dt : 0;
    this.arrester = a;
    this.arresting = !!a && (this.bustTimer > 0 || (arrestable && this.arrestWalk < ARREST_PATIENCE));
  }

  /**
   * The officer on foot (not SWAT) nearest to (x, z) within `range`, other than those heading back to
   * their car; with `y`, only one on that level (who can get to the player to cuff him).
   */
  private nearestOfficer(x: number, z: number, range: number, y?: number): Character | null {
    let best: Character | null = null;
    let bd = range;
    for (const c of this.sim.characters) {
      if (c.removed || c.role !== 'cop' || !c.alive || c.state !== 'normal' || !c.brain || c.brain.mode === 'return') continue;
      if (y !== undefined && Math.abs(c.pos.y - y) >= 1.2) continue;
      const d = Math.hypot(c.pos.x - x, c.pos.z - z);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  /** An officer who lost the player runs to where he was last seen, then checks the sidewalks around it. */
  private searchOnFoot(c: Character, b: PedBrain, dt: number): void {
    const sim = this.sim;
    const w = sim.wanted;
    b.modeTimer -= dt;
    if (Math.hypot(b.searchX - w.lastSeenX, b.searchZ - w.lastSeenZ) > 40) {
      b.searchX = w.lastSeenX;
      b.searchZ = w.lastSeenZ;
      b.modeTimer = 25;
    } else if (b.modeTimer <= 0 || Math.hypot(b.searchX - c.pos.x, b.searchZ - c.pos.z) < 2) {
      const pt = sim.world.walk.randomPointNear(sim.rng, w.lastSeenX, w.lastSeenZ, 5, 35);
      b.searchX = pt ? pt.x : w.lastSeenX;
      b.searchZ = pt ? pt.z : w.lastSeenZ;
      b.modeTimer = 12;
    }
    const d = Math.hypot(b.searchX - c.pos.x, b.searchZ - c.pos.z);
    this.runTo(c, b.searchX, b.searchZ, d > 12 ? 6 : 3, dt);
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

  private walkToCar(c: Character, car: Vehicle, dt: number, level: number): void {
    const sim = this.sim;
    const sx = Math.cos(car.heading);
    const sz = -Math.sin(car.heading);
    const tx = car.pos.x + sx * (car.halfW + 0.6);
    const tz = car.pos.z + sz * (car.halfW + 0.6);
    const d = Math.hypot(tx - c.pos.x, tz - c.pos.z);
    if (d < 1.6) {
      if (!car.driver) {
        sim.seat(c, car, 0);
        const ai = new DriverAI(sim, car, level > 0 ? 'chase' : 'traffic');
        car.ai = ai;
        if (level > 0) {
          if (this.searching(level)) this.assignSearch(ai);
          else ai.target = sim.player;
        }
        // Wait for the rest of the crew before driving off.
        ai.hold = this.crewOnFoot(car, level);
      } else {
        // Ride along with a fellow officer only, never in a car someone else has taken.
        const free = car.driver.isLaw ? car.passengers.indexOf(null) : -1;
        if (free >= 0) sim.seat(c, car, free + 1);
        else c.brain!.car = null;
      }
      return;
    }
    this.runTo(c, tx, tz, level > 0 ? 6 : 1.6, dt);
  }

  // ---------------------------------------------------------------------------
  // Arrest

  private updateBust(dt: number, level: number): void {
    const sim = this.sim;
    const p = sim.player;
    if (level === 0 || !this.arrestAllowed(level)) {
      this.bustTimer = 0;
      return;
    }
    const v = p.vehicle;
    let close = false;
    for (const c of sim.characters) {
      if (c.removed || !c.isLaw || !c.alive || c.state !== 'normal') continue;
      if (v) {
        if (v.speed >= 1.2 || Math.hypot(c.pos.x - v.pos.x, c.pos.z - v.pos.z) >= v.halfW + 1.9) continue;
      } else if (Math.hypot(c.pos.x - p.pos.x, c.pos.z - p.pos.z) >= 1.7 || (p.speed >= 2.2 && p.state !== 'knocked')) continue;
      // Within reach means on his level (not on a roof above him) and with nothing in between.
      if (Math.abs(c.pos.y - p.pos.y) >= 1.2) continue;
      if (!sim.world.lineOfSight(c.pos.x, c.pos.y + c.height * 0.75, c.pos.z, p.pos.x, p.pos.y + p.height * 0.75, p.pos.z)) continue;
      close = true;
      break;
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
    // It circles, and lights up, where the police think the player is.
    const kp = this.knownPos(level);
    if (level >= 3 && sim.time >= this.heliCooldownUntil && sim.helis.filter((h) => !h.destroyed).length === 0 && sim.ambient) {
      const a = sim.rng.range(0, Math.PI * 2);
      const x = kp.x + Math.cos(a) * HELI_SPAWN_DIST;
      const z = kp.z + Math.sin(a) * HELI_SPAWN_DIST;
      const h = new Helicopter(sim.newId(), x, Math.max(sim.world.groundHeight(kp.x, kp.z) + 60, this.skyTop(x, z) + HELI_CLEARANCE), z);
      sim.helis.push(h);
    }
    for (const h of sim.helis) {
      if (h.removed) continue;
      h.rotor += dt * (h.crashing ? 18 : 32);
      if (!h.destroyed && h.health <= 0) {
        h.destroyed = true;
        h.crashing = true;
        this.heliCooldownUntil = sim.time + HELI_RESPAWN_DELAY;
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
        this.keepClear(h, dt);
        h.pos.x += h.vel.x * dt;
        h.pos.y += h.vel.y * dt;
        h.pos.z += h.vel.z * dt;
        if (al > 420) h.removed = true;
        continue;
      }
      h.orbit += dt * 0.28;
      const base = Math.max(sim.world.groundHeight(kp.x, kp.z), 0) + 36;
      // Circle low enough to be shot at, but never through a building: when the orbit passes over
      // one, take another spot around the player (above a street) and climb only if none is open.
      let tx = kp.x;
      let tz = kp.z;
      let ty = Infinity;
      for (const [r, da] of HELI_SPOTS) {
        const x = kp.x + Math.cos(h.orbit + da) * r;
        const z = kp.z + Math.sin(h.orbit + da) * r;
        const y = Math.max(base, this.skyTop(x, z) + HELI_CLEARANCE);
        if (y < ty) {
          tx = x;
          tz = z;
          ty = y;
        }
        if (y <= base) break;
      }
      // Climb early for anything in the way there.
      ty = Math.max(ty, this.pathTop(h.pos.x, h.pos.z, tx, tz) + HELI_CLEARANCE);
      let dvx = (tx - h.pos.x) * 0.9;
      let dvy = (ty - h.pos.y) * 0.9;
      let dvz = (tz - h.pos.z) * 0.9;
      const dl = Math.hypot(dvx, dvy, dvz);
      // Dashes in from afar, then keeps up with a car at cruise speed.
      const maxV = Math.hypot(tx - h.pos.x, tz - h.pos.z) > HELI_DASH_RANGE ? HELI_DASH_SPEED : HELI_SPEED;
      if (dl > maxV) {
        dvx *= maxV / dl;
        dvy *= maxV / dl;
        dvz *= maxV / dl;
      }
      h.vel.x = damp1(h.vel.x, dvx, dt * 1.6);
      h.vel.y = damp1(h.vel.y, dvy, dt * 1.6);
      h.vel.z = damp1(h.vel.z, dvz, dt * 1.6);
      this.keepClear(h, dt);
      h.pos.x += h.vel.x * dt;
      h.pos.y += h.vel.y * dt;
      h.pos.z += h.vel.z * dt;
      h.heading = moveAngleTowards(h.heading, Math.atan2(kp.x - h.pos.x, kp.z - h.pos.z), dt * 1.5);
      h.spotlight.x = damp1(h.spotlight.x, kp.x, dt * 3);
      h.spotlight.z = damp1(h.spotlight.z, kp.z, dt * 3);
      if (level >= 4 && !sim.playerDown && !this.searching(level) && !this.arresting) {
        h.fireCooldown -= dt;
        if (h.fireCooldown <= 0) {
          h.fireCooldown = 0.16;
          this.heliShot(h);
          if (sim.rng.chance(0.15)) h.fireCooldown = 2.6;
        }
      }
    }
  }

  /** Top of the highest static obstacle within a helicopter's rotor reach of (x, z). */
  private skyTop(x: number, z: number): number {
    let top = -Infinity;
    this.sim.world.grid.query(x - HELI_PAD, z - HELI_PAD, x + HELI_PAD, z + HELI_PAD, (c) => {
      if (c.y1 > top) top = c.y1;
    });
    return top;
  }

  /** Highest obstacle under the next 40 m of a straight flight from (x0, z0) towards (x1, z1). */
  private pathTop(x0: number, z0: number, x1: number, z1: number): number {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const reach = Math.min(len, 40);
    const n = Math.ceil(reach / 8);
    let top = this.skyTop(x0, z0);
    for (let i = 1; i <= n; i++) {
      const f = (reach * i) / n / len;
      top = Math.max(top, this.skyTop(x0 + (x1 - x0) * f, z0 + (z1 - z0) * f));
    }
    return top;
  }

  /** A helicopter about to fly into a building stops short and climbs over it instead. */
  private keepClear(h: Helicopter, dt: number): void {
    const floor = this.skyTop(h.pos.x + h.vel.x * dt, h.pos.z + h.vel.z * dt) + 2.5;
    if (h.pos.y < floor) {
      h.vel.x = 0;
      h.vel.z = 0;
      h.vel.y = Math.max(h.vel.y, 12);
    } else if (h.pos.y + h.vel.y * dt < floor) {
      h.vel.y = (floor - h.pos.y) / dt;
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
    sim.events.emit('shot', { shooter: null, weapon: 'rifle', fx: ox, fy: oy, fz: oz, tx: ox + dx * r.t, ty: oy + dy * r.t, tz: oz + dz * r.t, hit: r.kind, nx: r.nx, ny: r.ny, nz: r.nz, pellet: 0 });
  }

  // ---------------------------------------------------------------------------

  private cleanup(dt: number, level: number): void {
    this.cleanupTimer -= dt;
    if (this.cleanupTimer > 0) return;
    this.cleanupTimer = 1;
    const sim = this.sim;
    const pp = sim.playerPos();
    const w = sim.wanted;
    const searching = this.searching(level);
    for (const v of sim.vehicles) {
      if (v.owner !== 'police' || v.removed || v.driver === sim.player) continue;
      // Units sweeping the area around the last sighting are still on duty.
      const d = Math.min(Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z), searching ? Math.hypot(v.pos.x - w.lastSeenX, v.pos.z - w.lastSeenZ) : Infinity);
      const visible = sim.isVisible(v.pos.x, v.pos.y, v.pos.z);
      const lagging = this.lagging(v, d, visible, level, searching);
      if ((d > 290 && !visible) || lagging || (v.destroyed && v.wreckTime > 40 && !visible) || (level === 0 && this.calm > 25 && d > 110 && !visible && v.ai?.policy !== 'traffic')) {
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

  /**
   * A pursuit unit trailing far behind the player (beyond RECYCLE_DIST, out of sight) that got no
   * RECYCLE_CLOSING m closer over the last RECYCLE_WINDOW seconds: freeing its slot lets dispatch send
   * one from near the player. Sampled on every cleanup tick.
   */
  private lagging(v: Vehicle, d: number, visible: boolean, level: number, searching: boolean): boolean {
    if (level === 0 || searching || v.destroyed || !v.ai || v.ai.policy !== 'chase' || !v.driver?.isLaw) {
      this.trail.delete(v);
      return false;
    }
    const now = this.sim.time;
    const s = this.trail.get(v);
    if (!s || now - s.t >= RECYCLE_WINDOW) this.trail.set(v, { t: now, d });
    if (!s || now - s.t < RECYCLE_WINDOW) return false;
    return d > RECYCLE_DIST && !visible && d > s.d - RECYCLE_CLOSING;
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
