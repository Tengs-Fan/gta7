// Client-side prediction of the local player: the player's own controller and physics run here, a fixed 1/60 tick per
// input, in a private Sim holding only the player, his vehicle and kinematic stand-ins for the remote vehicles around
// him (posed from the server's data each tick, so he collides with them). Each snapshot is compared with what was
// predicted for its tick; a difference rewinds to the server's state there and replays the inputs the server has not
// acted on yet. The rendered pose absorbs the change as an offset that fades out (a hard snap only past SNAP_DIST).
// Pure TypeScript (no three.js, no DOM).

import { wrapAngle } from '../core/math';
import { Character, Vehicle, type CharState } from '../sim/entities';
import { neutralInput, type PlayerInput } from '../sim/input';
import type { PlayerSlot } from '../sim/playerSlot';
import { Sim } from '../sim/sim';
import type { CharacterCombat, CharacterMotion, CharacterStatus, VehicleEngine, VehicleMotion, VehicleStatus } from '../sim/snapshot';
import { VEHICLE_SPECS, WEAPONS, type VehicleKind, type WeaponId } from '../sim/specs';
import { StaticWorld } from '../world/staticWorld';
import type { Mirror } from './mirror';

/** A position error (m) at or below which a snapshot needs no correction. */
export const EPS_POS = 0.01;
const EPS_HEADING = 0.002;
/** A position error (m) past which the predicted state is replaced, not blended: the rendered pose jumps. */
export const SNAP_DIST = 3;
/** The rendered pose never moves more than this (m) in one frame to take up a correction. */
export const MAX_CORRECTION_STEP = 0.25;
/** Time constant (s) of the fade of a correction. */
const CORRECTION_TAU = 0.1;
/** Remote vehicles closer than this (m) to the player are stand-ins in the prediction. */
const PROXY_RADIUS = 60;
/** How far past their newest sample (ticks) stand-ins are extrapolated along their velocity. */
const PROXY_EXTRAPOLATE = 30;
/** Ticks a state difference (on foot, seated, which car) may last before the server's state replaces the prediction's. */
const STATE_GRACE_TICKS = 4;
/**
 * Seconds a knocked-down prediction stays down. The wire carries no knock timer, so the prediction holds the knock until
 * the server reports the player on his feet again, and the first snapshot that does stands him up.
 */
const KNOCK_HOLD = 10;
/** Ticks of predicted history kept for comparison and replay. */
const HISTORY = 180;
/** A car the player got out of stays predicted this long (ticks), until the server's view of it has caught up. */
const RELEASE_TICKS = 40;

type Prims = Record<string, unknown>;

const CHAR_REFS = new Set(['vehicle', 'enterTarget', 'lastAttacker', 'lastHitBy', 'brain', 'appearance', 'inventory', 'pos', 'vel']);
const VEH_REFS = new Set(['driver', 'lastDriver', 'ai', 'passengers', 'spec', 'rng', 'dents', 'pos', 'vel', 'controls']);
const CTL_REFS = new Set(['sim', 'p', 'lastVehicle', 'steerCar', 'entryPoints']);

function primsOf(o: object, skip: ReadonlySet<string>): Prims {
  const out: Prims = {};
  for (const k of Object.keys(o)) {
    if (skip.has(k)) continue;
    const v = (o as Prims)[k];
    if (v === null || typeof v !== 'object') out[k] = v;
  }
  return out;
}

function assignPrims(o: object, p: Prims): void {
  Object.assign(o, p);
}

interface Hist {
  tick: number;
  char: Prims;
  cpos: { x: number; y: number; z: number };
  cvel: { x: number; y: number; z: number };
  vehId: number;
  enterId: number;
  veh: Prims | null;
  vpos: { x: number; y: number; z: number } | null;
  vvel: { x: number; z: number } | null;
  vctl: Vehicle['controls'] | null;
  ctl: Prims;
  entryPoints: Array<{ x: number; z: number }>;
  steerCarId: number;
  time: number;
  frame: number;
  controlLock: number;
  weapon: WeaponId;
}

/** What the renderer is shown of the predicted player at one tick. */
export interface Pose {
  x: number;
  y: number;
  z: number;
  heading: number;
}

export interface ServerOwnState {
  tick: number;
  motion: CharacterMotion;
  status: CharacterStatus;
  combat?: CharacterCombat;
  /** Rounds in the magazine of the gun in his hand, as the server's HUD data says (when known). */
  clip?: number;
  vehicle: { id: number; motion: VehicleMotion; engine?: VehicleEngine; status?: VehicleStatus; kind: VehicleKind } | null;
}

/** A trigger pull the prediction made at `tick` (the first time that tick was simulated). */
export interface PredictedShot {
  tick: number;
  weapon: WeaponId;
  x: number; y: number; z: number;
  dx: number; dy: number; dz: number;
  pellets: number;
}

export interface PredictorStats {
  ticks: number;
  replays: number;
  replayedTicks: number;
  softCorrections: number;
  hardSnaps: number;
  /** Error (m) between the server's state and the prediction for the same tick, at the last snapshot compared. */
  lastError: number;
  maxError: number;
  /** Largest per-frame move of the rendered pose that came from taking up a correction (m). */
  maxCorrectionStep: number;
  /** Largest jump of the rendered pose in a hard snap (m). */
  maxSnapJump: number;
}

export class Predictor {
  readonly sim: Sim;
  readonly slot: PlayerSlot;
  readonly char: Character;
  /** The next tick to simulate (the server tick its input is meant for). */
  tick = 0;
  active = false;
  /** Server id of the local player's character. */
  serverCharId = 0;
  private readonly hist = new Map<number, Hist>();
  private readonly inputs = new Map<number, PlayerInput>();
  /** Every vehicle in the prediction, by server id: stand-ins and the player's own. */
  private readonly vehicles = new Map<number, Vehicle>();
  private readonly dummies = new Map<number, Character>();
  /** Vehicles released by the player at a tick (still predicted until RELEASE_TICKS later). */
  private readonly released = new Map<number, number>();
  /** First compared tick of a run of snapshots whose state differs from the prediction's (-1: none). */
  private mismatchSince = -1;
  /** Rendered pose at the last two ticks, and the correction still being taken up. */
  readonly prevPose: Pose = { x: 0, y: 0, z: 0, heading: 0 };
  readonly curPose: Pose = { x: 0, y: 0, z: 0, heading: 0 };
  readonly offset: Pose = { x: 0, y: 0, z: 0, heading: 0 };
  readonly stats: PredictorStats = { ticks: 0, replays: 0, replayedTicks: 0, softCorrections: 0, hardSnaps: 0, lastError: 0, maxError: 0, maxCorrectionStep: 0, maxSnapJump: 0 };
  /** Prediction error (m) per compared tick, kept for measurements: [tick, error]. */
  readonly errors: Array<[number, number]> = [];
  recordErrors = false;
  /** Trigger pulls of ticks simulated for the first time since the last drain (replays after a correction add none). */
  readonly fired: PredictedShot[] = [];
  private recording = false;

  constructor(world: StaticWorld = new StaticWorld()) {
    this.sim = new Sim({ world, ambient: false, police: false, weather: 'clear', seed: 1 });
    const sim = this.sim;
    this.slot = sim.players[0]!;
    this.char = this.slot.character;
    // Damage, death and story belong to the server: the prediction only moves the player.
    this.slot.cheats.godMode = true;
    this.slot.cheats.neverWanted = true;
    sim.pickups.length = 0;
    sim.characters.length = 0;
    sim.characters.push(this.char);
    sim.vehicles.length = 0;
    const off = () => {};
    const sys = sim as unknown as Record<string, Record<string, unknown>>;
    for (const [owner, fn] of [['missions', 'update'], ['activities', 'update'], ['interactions', 'update'], ['interactions', 'interact'], ['activities', 'toggleJob'], ['pickupSys', 'update']] as const) {
      sys[owner]![fn] = off;
    }
    sim.events.clear();
    sim.events.on('weaponFired', (e) => {
      if (!this.recording || e.shooter !== this.char) return;
      this.fired.push({ tick: this.tick, weapon: e.weapon, x: e.x, y: e.y, z: e.z, dx: e.dx, dy: e.dy, dz: e.dz, pellets: e.pellets });
    });
    for (const w of Object.keys(WEAPONS) as WeaponId[]) if (w !== 'fists') this.char.inventory.give(w, 9999);
    this.char.inventory.current = 'fists';
  }

  /** The predicted player's vehicle, if he sits in one. */
  get vehicle(): Vehicle | null {
    return this.char.vehicle;
  }

  /** Server ids the predictor draws itself: the player and the vehicles he drives or just left. */
  ownedIds(): number[] {
    const out = [this.serverCharId];
    const v = this.char.vehicle;
    if (v) out.push(v.id);
    for (const id of this.released.keys()) if (!out.includes(id)) out.push(id);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Start, step

  /** Starts predicting from the server's state at `s.tick`, with the first predicted tick `firstTick`. */
  start(s: ServerOwnState, firstTick: number, mirror: Mirror, inputAt: (tick: number) => PlayerInput | undefined = () => undefined): void {
    this.mismatchSince = -1;
    this.hist.clear();
    this.inputs.clear();
    this.released.clear();
    this.active = true;
    this.applyServer(s, true);
    this.sim.time = mirror.timeAt(s.tick);
    this.sim.frame = s.tick;
    this.tick = s.tick + 1;
    this.record(s.tick);
    // The ticks between the snapshot and the next one this client sends input for run on what it sent for them already
    // (nothing, before its first input).
    while (this.tick < firstTick) this.step(inputAt(this.tick) ?? neutralInput(), mirror);
    this.fired.length = 0;
    this.snapPose();
  }

  stop(): void {
    this.active = false;
    this.hist.clear();
    this.inputs.clear();
    this.released.clear();
  }

  /** Simulates tick `this.tick` on `input` (already quantized as the server will see it). */
  step(input: PlayerInput, mirror: Mirror): void {
    const t = this.tick;
    this.inputs.set(t, input);
    this.recording = true;
    this.simulate(t, input, mirror);
    this.recording = false;
    this.record(t);
    this.prevPose.x = this.curPose.x;
    this.prevPose.y = this.curPose.y;
    this.prevPose.z = this.curPose.z;
    this.prevPose.heading = this.curPose.heading;
    this.poseNow(this.curPose);
    this.tick = t + 1;
    this.stats.ticks++;
    this.inputs.delete(t - HISTORY);
    this.hist.delete(t - HISTORY);
  }

  private simulate(t: number, input: PlayerInput, mirror: Mirror): void {
    this.refreshProxies(t, mirror);
    this.sim.update(1 / 60, input);
    const v = this.char.vehicle;
    for (const [id, at] of this.released) {
      if (v && v.id === id) this.released.delete(id);
      else if (t - at > RELEASE_TICKS) this.released.delete(id);
    }
  }

  // ---------------------------------------------------------------------------
  // Reconciliation

  /**
   * Compares the server's state of the player at its tick with the prediction for that tick, and corrects the
   * prediction if they differ. Returns the position error (m), or -1 when that tick is no longer (or not yet) predicted.
   */
  reconcile(s: ServerOwnState, mirror: Mirror): number {
    const h = this.hist.get(s.tick);
    if (!h || s.tick >= this.tick) return -1;
    const serverVeh = s.status.state === 'inVehicle' && s.status.seat === 0 && s.vehicle ? s.vehicle : null;
    const predVeh = h.char.state === 'inVehicle' && h.vehId ? h.vehId : 0;
    const stateDiffers = s.status.state !== h.char.state || (serverVeh ? serverVeh.id !== predVeh : predVeh !== 0);
    let err: number;
    let headErr: number;
    if (serverVeh && h.vpos && !stateDiffers) {
      err = Math.hypot(serverVeh.motion.x - h.vpos.x, serverVeh.motion.y - h.vpos.y, serverVeh.motion.z - h.vpos.z);
      headErr = Math.abs(wrapAngle(serverVeh.motion.heading - (h.veh!.heading as number)));
    } else {
      err = Math.hypot(s.motion.x - h.cpos.x, s.motion.y - h.cpos.y, s.motion.z - h.cpos.z);
      headErr = Math.abs(wrapAngle(s.motion.heading - (h.char.heading as number)));
    }
    this.stats.lastError = err;
    this.stats.maxError = Math.max(this.stats.maxError, err);
    if (this.recordErrors) this.errors.push([s.tick, err]);
    // Being knocked down or getting up is the server's doing, not a press that may act a tick apart: it is taken over
    // at once, and (both states being on foot) the pose absorbs it as a correction.
    const onFoot = (st: string) => st !== 'inVehicle' && st !== 'entering';
    const knockFlip = stateDiffers && onFoot(s.status.state) && onFoot(h.char.state as string) && (s.status.state === 'knocked') !== (h.char.state === 'knocked');
    // A press (getting in or out) may act a tick or two apart on the server and here: a state that differs is only
    // replaced once it still differs a few ticks on.
    if (stateDiffers && !knockFlip) {
      if (this.mismatchSince < 0) this.mismatchSince = s.tick;
      if (s.tick - this.mismatchSince <= STATE_GRACE_TICKS) return err;
    } else {
      this.mismatchSince = -1;
    }
    const hard = stateDiffers || err > SNAP_DIST;
    const weaponDiffers = !!s.combat && s.combat.weapon !== h.weapon;
    if (!hard && err <= EPS_POS && headErr <= EPS_HEADING && !weaponDiffers) return err;
    const smooth = !hard || (knockFlip && err <= SNAP_DIST);

    const before: Pose = { ...this.curPose };
    if (!hard) this.restore(h);
    this.applyServer(s, hard);
    this.sim.time = h.time;
    this.sim.frame = h.frame;
    this.record(s.tick);
    const end = this.tick;
    for (let t = s.tick + 1; t < end; t++) {
      const inp = this.inputs.get(t) ?? neutralInput();
      this.simulate(t, inp, mirror);
      this.record(t);
      this.stats.replayedTicks++;
    }
    this.stats.replays++;
    const prevDelta = { x: this.prevPose.x - before.x, y: this.prevPose.y - before.y, z: this.prevPose.z - before.z };
    this.poseNow(this.curPose);
    if (!smooth) {
      this.stats.hardSnaps++;
      this.stats.maxSnapJump = Math.max(this.stats.maxSnapJump, Math.hypot(this.curPose.x - before.x, this.curPose.y - before.y, this.curPose.z - before.z));
      this.snapPose();
    } else {
      this.stats.softCorrections++;
      const dx = this.curPose.x - before.x;
      const dy = this.curPose.y - before.y;
      const dz = this.curPose.z - before.z;
      const dh = wrapAngle(this.curPose.heading - before.heading);
      // The rendered pose stays where it was; the offset fades it over to the corrected one.
      this.offset.x -= dx;
      this.offset.y -= dy;
      this.offset.z -= dz;
      this.offset.heading = wrapAngle(this.offset.heading - dh);
      this.prevPose.x = before.x + prevDelta.x + dx;
      this.prevPose.y = before.y + prevDelta.y + dy;
      this.prevPose.z = before.z + prevDelta.z + dz;
      this.prevPose.heading = wrapAngle(this.prevPose.heading + dh);
      if (Math.hypot(this.offset.x, this.offset.y, this.offset.z) > SNAP_DIST) {
        this.stats.hardSnaps++;
        this.snapPose();
      }
    }
    return err;
  }

  /** The rendered pose this frame: between the last two ticks (alpha 0..1), plus the fading correction. */
  renderPose(alpha: number, dt: number, out: Pose): Pose {
    const decay = Math.exp(-dt / CORRECTION_TAU);
    const ox = this.offset.x * decay;
    const oy = this.offset.y * decay;
    const oz = this.offset.z * decay;
    let step = Math.hypot(this.offset.x - ox, this.offset.y - oy, this.offset.z - oz);
    let k = 1;
    if (step > MAX_CORRECTION_STEP) {
      k = MAX_CORRECTION_STEP / step;
      step = MAX_CORRECTION_STEP;
    }
    this.offset.x -= (this.offset.x - ox) * k;
    this.offset.y -= (this.offset.y - oy) * k;
    this.offset.z -= (this.offset.z - oz) * k;
    this.offset.heading *= decay;
    this.stats.maxCorrectionStep = Math.max(this.stats.maxCorrectionStep, step);
    const a = Math.max(0, Math.min(1, alpha));
    out.x = this.prevPose.x + (this.curPose.x - this.prevPose.x) * a + this.offset.x;
    out.y = this.prevPose.y + (this.curPose.y - this.prevPose.y) * a + this.offset.y;
    out.z = this.prevPose.z + (this.curPose.z - this.prevPose.z) * a + this.offset.z;
    out.heading = wrapAngle(this.prevPose.heading + wrapAngle(this.curPose.heading - this.prevPose.heading) * a + this.offset.heading);
    return out;
  }

  /** The predicted state the server reported for a tick: whether that tick is still in the history. */
  has(tick: number): boolean {
    return this.hist.has(tick);
  }

  /** Predicted position at a tick (as first predicted, or as replayed since). */
  positionAt(tick: number): { x: number; y: number; z: number } | null {
    const h = this.hist.get(tick);
    if (!h) return null;
    return h.vpos && h.char.state === 'inVehicle' ? { ...h.vpos } : { ...h.cpos };
  }

  // ---------------------------------------------------------------------------
  // Internals

  private poseNow(out: Pose): void {
    const v = this.char.vehicle;
    const src = v && this.char.state === 'inVehicle' ? v : this.char;
    out.x = src.pos.x;
    out.y = src.pos.y;
    out.z = src.pos.z;
    out.heading = src.heading;
  }

  private snapPose(): void {
    this.poseNow(this.curPose);
    Object.assign(this.prevPose, this.curPose);
    this.offset.x = 0;
    this.offset.y = 0;
    this.offset.z = 0;
    this.offset.heading = 0;
  }

  private record(t: number): void {
    const c = this.char;
    const v = c.vehicle ?? (c.state === 'entering' ? c.enterTarget : null);
    const ctl = this.slot.ctl as unknown as Record<string, unknown>;
    const steerCar = ctl.steerCar as Vehicle | null;
    this.hist.set(t, {
      tick: t,
      char: primsOf(c, CHAR_REFS),
      cpos: { ...c.pos },
      cvel: { ...c.vel },
      vehId: c.vehicle?.id ?? 0,
      enterId: c.enterTarget?.id ?? 0,
      veh: v ? primsOf(v, VEH_REFS) : null,
      vpos: v ? { ...v.pos } : null,
      vvel: v ? { ...v.vel } : null,
      vctl: v ? { ...v.controls } : null,
      ctl: primsOf(ctl, CTL_REFS),
      entryPoints: ((ctl.entryPoints as Array<{ x: number; z: number }>) ?? []).map((p) => ({ ...p })),
      steerCarId: steerCar?.id ?? 0,
      time: this.sim.time,
      frame: this.sim.frame,
      controlLock: this.slot.controlLock,
      weapon: c.inventory.current,
    });
  }

  /** Puts the prediction back to its state at a recorded tick. */
  private restore(h: Hist): void {
    const c = this.char;
    assignPrims(c, h.char);
    Object.assign(c.pos, h.cpos);
    Object.assign(c.vel, h.cvel);
    const ctl = this.slot.ctl as unknown as Record<string, unknown>;
    assignPrims(ctl, h.ctl);
    ctl.entryPoints = h.entryPoints.map((p) => ({ ...p }));
    ctl.steerCar = h.steerCarId ? this.vehicles.get(h.steerCarId) ?? null : null;
    this.slot.controlLock = h.controlLock;
    c.inventory.current = h.weapon;
    const vid = h.vehId || (h.char.state === 'entering' ? h.enterId : 0);
    const v = vid ? this.vehicles.get(vid) ?? null : null;
    if (v && h.veh && h.vpos && h.vvel && h.vctl) {
      assignPrims(v, h.veh);
      Object.assign(v.pos, h.vpos);
      Object.assign(v.vel, h.vvel);
      Object.assign(v.controls, h.vctl);
    }
    this.seatIn(h.vehId ? v : null);
    c.enterTarget = h.enterId ? this.vehicles.get(h.enterId) ?? null : null;
  }

  /** Seats the predicted player as the driver of `v`, or takes him out of any vehicle. */
  private seatIn(v: Vehicle | null): void {
    const c = this.char;
    if (c.vehicle && c.vehicle !== v) {
      const old = c.vehicle;
      if (old.driver === c) old.driver = null;
      c.vehicle = null;
    }
    if (v) {
      const prev = v.driver;
      if (prev && prev !== c) prev.vehicle = null;
      v.driver = c;
      v.lastDriver = c;
      c.vehicle = v;
      c.seat = 0;
    }
  }

  /** Writes the server's state at its tick over the prediction (`full`: occupancy and controller state too). */
  private applyServer(s: ServerOwnState, full: boolean): void {
    const c = this.char;
    const m = s.motion;
    c.pos.x = m.x; c.pos.y = m.y; c.pos.z = m.z;
    c.vel.x = m.vx; c.vel.y = m.vy; c.vel.z = m.vz;
    c.heading = m.heading;
    c.onGround = m.onGround;
    const st = s.status;
    c.state = (st.state === 'entering' ? 'normal' : st.state) as CharState;
    c.knockTimer = st.state === 'knocked' ? KNOCK_HOLD : 0;
    if (s.combat) {
      const w = s.combat.weapon;
      const changed = c.inventory.current !== w;
      if (!c.inventory.has(w)) c.inventory.give(w, 9999);
      c.inventory.current = w;
      const slot = c.inventory.slots.get(w);
      if ((full || changed) && slot && s.clip !== undefined && WEAPONS[w].mag > 0) slot.clip = Math.min(s.clip, WEAPONS[w].mag);
    }
    const sv = st.state === 'inVehicle' && st.seat === 0 ? s.vehicle : null;
    if (sv) {
      const v = this.ensureVehicle(sv.id, sv.kind);
      const vm = sv.motion;
      v.pos.x = vm.x; v.pos.y = vm.y; v.pos.z = vm.z;
      v.vel.x = vm.vx; v.vel.z = vm.vz; v.vy = vm.vy;
      v.heading = vm.heading; v.pitch = vm.pitch; v.roll = vm.roll;
      v.angVel = vm.angVel; v.steer = vm.steer;
      v.speed = vm.speed; v.forwardSpeed = vm.forwardSpeed;
      if (sv.engine) {
        v.rpm = sv.engine.rpm; v.gear = sv.engine.gear; v.skid = sv.engine.skid;
      }
      if (sv.status) {
        v.health = sv.status.health; v.destroyed = sv.status.destroyed; v.flipped = sv.status.flipped;
        v.airborne = sv.status.airborne; v.inWater = sv.status.inWater; v.burning = sv.status.burning;
      }
      if (full || c.vehicle !== v) this.seatIn(v);
      v.removed = false;
      if (!this.sim.vehicles.includes(v)) this.sim.vehicles.push(v);
    } else if (full || st.state !== 'inVehicle') {
      if (c.vehicle) this.released.set(c.vehicle.id, s.tick);
      this.seatIn(null);
      if (st.state === 'inVehicle') c.state = 'normal';
    }
    if (full) {
      c.enterTarget = null;
      const ctl = this.slot.ctl as unknown as Record<string, unknown>;
      ctl.exitPending = false;
      ctl.entryPoints = [];
    }
  }

  private ensureVehicle(id: number, kind: VehicleKind): Vehicle {
    let v = this.vehicles.get(id);
    if (!v) {
      v = new Vehicle(id, kind in VEHICLE_SPECS ? kind : 'sedan', 0, 0, 0, 0, 0);
      this.vehicles.set(id, v);
    }
    return v;
  }

  /** Poses the remote vehicles near the player for tick `t` from the server's data, and drops those out of reach. */
  private refreshProxies(t: number, mirror: Mirror): void {
    const c = this.char;
    const own = c.vehicle;
    const target = c.state === 'entering' ? c.enterTarget : null;
    const px = own ? own.pos.x : c.pos.x;
    const pz = own ? own.pos.z : c.pos.z;
    const seen = new Set<number>();
    const list = this.sim.vehicles;
    for (const mv of mirror.vehicles) {
      if (mv.removed) continue;
      if (own && own.id === mv.id) {
        seen.add(mv.id);
        continue;
      }
      if (this.released.has(mv.id)) {
        seen.add(mv.id);
        continue;
      }
      const tr = mirror.track(mv.id);
      const last = tr?.latest;
      if (!last) continue;
      const dt = Math.min(Math.max(0, t - last.tick), PROXY_EXTRAPOLATE) / 60;
      const x = last.x + last.vx * dt;
      const z = last.z + last.vz * dt;
      if (Math.hypot(x - px, z - pz) > PROXY_RADIUS && mv !== target) continue;
      seen.add(mv.id);
      const v = this.ensureVehicle(mv.id, mv.kind);
      v.pos.x = x;
      v.pos.y = last.y + last.vy * dt;
      v.pos.z = z;
      v.vel.x = last.vx;
      v.vel.z = last.vz;
      v.vy = last.vy;
      v.heading = wrapAngle(last.heading + last.angVel * dt);
      v.pitch = last.pitch;
      v.roll = last.roll;
      v.angVel = last.angVel;
      v.steer = last.steer;
      v.speed = Math.hypot(last.vx, last.vz);
      v.forwardSpeed = last.vx * Math.sin(v.heading) + last.vz * Math.cos(v.heading);
      v.health = mv.health;
      v.destroyed = mv.destroyed;
      v.flipped = mv.flipped;
      v.airborne = mv.airborne;
      v.inWater = mv.inWater;
      v.controls.throttle = 0;
      v.controls.brake = 0;
      v.controls.steer = 0;
      v.controls.handbrake = false;
      v.removed = false;
      // Who sits at the wheel matters to getting in (a player's car cannot be taken, a driver is pulled out first).
      const md = mv.driver;
      if (md && md.id !== this.serverCharId) {
        let d = this.dummies.get(mv.id);
        if (!d || d.role !== md.role) {
          d = new Character(-mv.id, md.role, x, v.pos.y, z, md.appearance);
          this.dummies.set(mv.id, d);
        }
        if (v.driver !== c) {
          d.state = 'inVehicle';
          d.vehicle = v;
          v.driver = d;
        }
      } else if (v.driver !== c) {
        v.driver = null;
      }
      if (!list.includes(v)) list.push(v);
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const v = list[i]!;
      if (v === own || seen.has(v.id)) continue;
      list.splice(i, 1);
      if (v !== target) this.vehicles.delete(v.id);
      this.dummies.delete(v.id);
    }
  }
}

/** Reads the server's latest state of the local player (and the vehicle he drives) out of the mirror's raw groups. */
export function serverOwnState(mirror: Mirror, charId: number): ServerOwnState | null {
  const raw = mirror.rawOf(charId);
  if (!raw) return null;
  const g = raw.groups as { motion?: CharacterMotion; status?: CharacterStatus; combat?: CharacterCombat };
  if (!g.motion || !g.status) return null;
  let vehicle: ServerOwnState['vehicle'] = null;
  if (g.status.vehicle) {
    const vr = mirror.rawOf(g.status.vehicle);
    const vg = vr?.groups as { motion?: VehicleMotion; engine?: VehicleEngine; status?: VehicleStatus; rare?: { kind: string } } | undefined;
    if (vg?.motion) vehicle = { id: g.status.vehicle, motion: vg.motion, engine: vg.engine, status: vg.status, kind: (vg.rare?.kind ?? 'sedan') as VehicleKind };
  }
  return { tick: mirror.tick, motion: g.motion, status: g.status, combat: g.combat, clip: mirror.hud.clip, vehicle };
}
