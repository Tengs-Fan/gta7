// The multiplayer client: one connection to a game server's room. It says hello, keeps the Mirror up to date from the
// snapshots and events, runs the local player's prediction at the server's tick rate and sends one input per tick,
// measures the round trip, asks for a full resend after a lost snapshot, and reports a lost or failed connection.
// Pure TypeScript: the transport is injected (a WebSocket in the browser, an in-process pipe in tests).

import type { PlayerInput } from '../sim/input';
import type { StaticWorld } from '../world/staticWorld';
import type { CombatView } from '../sim/viewState';
import { Mirror } from './mirror';
import { placeOccupant } from './mirror';
import { Predictor, serverOwnState, type Pose } from './predictor';
import { decodeMessage, encodeMessage, peekType, PROTOCOL_VERSION, quantizeInput, type Message, type SnapshotMsg } from './protocol';
import { BadAddressError, type Transport, type TransportFactory } from './transport';

export type NetState = 'connecting' | 'joining' | 'connected' | 'lost' | 'failed' | 'closed';

export type FailureKind = 'badAddress' | 'unreachable' | 'timeout' | 'version' | 'rejected' | 'lost';

export interface NetFailure {
  kind: FailureKind;
  /** A sentence for the player. */
  text: string;
}

export interface NetClientOptions {
  url: string;
  name: string;
  room: string;
  world: StaticWorld;
  transport: TransportFactory;
  now: () => number;
  combat?: CombatView;
  /** Seconds to wait for the welcome before giving up. */
  connectTimeout?: number;
  /** Seconds without any message from a joined server before the connection counts as lost. */
  silenceTimeout?: number;
  /** A world for the prediction (tests share one; the browser builds its own). */
  predictionWorld?: StaticWorld;
  /** Predict the local player (off: draw him from snapshots like everyone else). */
  predict?: boolean;
  /** Protocol version to say hello with (tests of a mismatch). */
  version?: number;
}

/** Ticks of slack the client aims for: its inputs reach the server this many ticks before the tick they are for. */
const TARGET_SLACK = 2;
const MAX_TICKS_PER_FRAME = 8;
const PING_EVERY_MS = 1000;
const RESYNC_GAP_MS = 1000;

const EDGES = ['firePressed', 'jump', 'enterExit', 'interact', 'job', 'hornPressed', 'reload', 'nextWeapon', 'prevWeapon'] as const;

export interface NetDebug {
  state: NetState;
  failure: NetFailure | null;
  url: string;
  room: string;
  name: string;
  playerId: number;
  slot: number;
  watching: boolean;
  rtt: number;
  tick: number;
  renderTick: number;
  interpDelayMs: number;
  snapshots: number;
  bytesIn: number;
  bytesOut: number;
  inputsSent: number;
  resyncs: number;
  counts: { vehicles: number; characters: number; pickups: number; projectiles: number; helis: number; total: number };
  mirror: Mirror['stats'];
  prediction: Predictor['stats'] & { active: boolean; tick: number; slack: number; rateScale: number };
}

export class NetClient {
  readonly mirror: Mirror;
  readonly predictor: Predictor;
  state: NetState = 'connecting';
  failure: NetFailure | null = null;
  /** Round-trip time (ms), smoothed; NaN before the first pong. */
  rtt = NaN;
  bytesIn = 0;
  bytesOut = 0;
  inputsSent = 0;
  resyncs = 0;
  /** Called on every state change. */
  onState: ((s: NetState, failure: NetFailure | null) => void) | null = null;
  /** Called once the first snapshot has been applied (the world can be drawn). */
  onReady: (() => void) | null = null;
  ready = false;

  private transport: Transport | null = null;
  private readonly opts: Required<Omit<NetClientOptions, 'combat' | 'predictionWorld'>> & Pick<NetClientOptions, 'combat' | 'predictionWorld'>;
  private readonly startedAt: number;
  private lastMessageAt = 0;
  private lastPingAt = -Infinity;
  private lastResyncAt = -Infinity;
  /** Next tick this client sends input for (NaN until the first snapshot of its own player). */
  private ctick = NaN;
  private seqOffset = 0;
  private lastSeq = 0;
  /** First seq after the tick numbering last changed: acks below it say nothing about the current lead. */
  private seqEpoch = 0;
  private acc = 0;
  private rateScale = 1;
  private slack = NaN;
  private alpha = 1;
  private readonly sentInputs = new Map<number, PlayerInput>();
  private pending: PlayerInput | null = null;
  private cmdSeq = 0;
  private readonly pose: Pose = { x: 0, y: 0, z: 0, heading: 0 };

  constructor(opts: NetClientOptions) {
    this.opts = { connectTimeout: 5, silenceTimeout: 2.5, predict: true, version: PROTOCOL_VERSION, ...opts };
    this.mirror = new Mirror({ world: opts.world, combat: opts.combat });
    this.predictor = new Predictor(opts.predictionWorld);
    this.startedAt = opts.now();
    this.connect();
  }

  get url(): string {
    return this.opts.url;
  }

  private setState(s: NetState, failure: NetFailure | null = null): void {
    if (this.state === s && !failure) return;
    this.state = s;
    if (failure) this.failure = failure;
    this.onState?.(s, this.failure);
  }

  private connect(): void {
    let t: Transport;
    try {
      t = this.opts.transport(this.opts.url);
    } catch (err) {
      const why = err instanceof BadAddressError ? '' : ` (${err instanceof Error ? err.message : String(err)})`;
      this.fail({ kind: 'badAddress', text: `"${this.opts.url}" is not a server address${why}. Use host:port, e.g. localhost:4210.` });
      return;
    }
    this.transport = t;
    t.onopen = () => {
      if (this.state !== 'connecting') return;
      this.lastMessageAt = this.opts.now();
      this.send({ type: 'ping', clientTime: this.opts.now() });
      this.send({ type: 'hello', version: this.opts.version, name: this.opts.name, room: this.opts.room });
      this.setState('joining');
    };
    t.onmessage = (data) => this.onMessage(data);
    t.onclose = (code, reason) => this.onClose(code, reason);
  }

  private send(m: Message): void {
    if (!this.transport) return;
    const buf = encodeMessage(m);
    this.bytesOut += buf.byteLength;
    this.transport.send(buf);
  }

  private fail(f: NetFailure): void {
    if (this.state === 'failed' || this.state === 'closed' || this.state === 'lost') return;
    const t = this.transport;
    this.transport = null;
    if (t) {
      t.onclose = null;
      t.onmessage = null;
      try {
        t.close(1000, 'client gave up');
      } catch {
        // Already closed.
      }
    }
    this.predictor.stop();
    this.mirror.locallyDriven.clear();
    this.setState(f.kind === 'lost' ? 'lost' : 'failed', f);
  }

  /** Sends a menu command ('respawn'; 'debug' on a --dev server). */
  command(name: string, arg = ''): void {
    if (this.state === 'connected' || this.state === 'joining') this.send({ type: 'cmd', seq: ++this.cmdSeq, name, arg });
  }

  /** Leaves the room (bye) and closes the connection. */
  close(): void {
    if (this.state === 'closed') return;
    const t = this.transport;
    this.transport = null;
    if (t) {
      t.onclose = null;
      t.onmessage = null;
      try {
        t.send(encodeMessage({ type: 'bye', reason: 'leaving' }));
      } catch {
        // Not open.
      }
      try {
        t.close(1000, 'bye');
      } catch {
        // Already closed.
      }
    }
    this.predictor.stop();
    this.setState('closed');
  }

  private onClose(code: number, reason: string): void {
    this.transport = null;
    if (this.state === 'connected' || (this.state === 'joining' && this.mirror.playerId > 0)) {
      this.fail({ kind: 'lost', text: 'Connection to the server was lost.' });
      return;
    }
    if (code === 4001) return this.fail({ kind: 'version', text: `The server runs a different version of the game${reason ? ` (${reason})` : ''}.` });
    if (code === 4002 || code === 4003 || code === 1008) return this.fail({ kind: 'rejected', text: reason || 'The server turned the connection down.' });
    this.fail({ kind: 'unreachable', text: `Could not connect to ${this.opts.url}.` });
  }

  private onMessage(data: ArrayBuffer): void {
    this.bytesIn += data.byteLength;
    this.lastMessageAt = this.opts.now();
    const head = peekType(data);
    if (head && head.version !== PROTOCOL_VERSION) {
      this.fail({ kind: 'version', text: `The server speaks protocol version ${head.version}, this game ${PROTOCOL_VERSION}: they need to be the same version.` });
      return;
    }
    let msg: Message;
    try {
      msg = decodeMessage(data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'welcome':
        this.mirror.applyWelcome(msg);
        return;
      case 'reject':
        this.fail({ kind: msg.code === 'version' ? 'version' : 'rejected', text: msg.text });
        return;
      case 'snapshot':
        this.onSnapshot(msg);
        return;
      case 'event':
        this.mirror.queueEvents(msg);
        return;
      case 'pong': {
        const rtt = this.opts.now() - msg.clientTime;
        this.rtt = Number.isNaN(this.rtt) ? rtt : this.rtt * 0.8 + rtt * 0.2;
        return;
      }
      case 'bye':
        this.fail({ kind: 'lost', text: msg.reason ? `The server ended the game: ${msg.reason}` : 'Connection to the server was lost.' });
        return;
      default:
        return;
    }
  }

  private onSnapshot(s: SnapshotMsg): void {
    if (this.mirror.playerId === 0) return;
    const now = this.opts.now();
    const res = this.mirror.applySnapshot(s, now);
    if (res.stale) return;
    if ((res.gap || res.missing > 0) && now - this.lastResyncAt > RESYNC_GAP_MS) {
      this.lastResyncAt = now;
      this.resyncs++;
      this.send({ type: 'cmd', seq: this.resyncs, name: 'resync', arg: '' });
    }
    if (!this.ready) {
      this.ready = true;
      this.setState('connected');
      this.onReady?.();
    }
    this.updatePrediction(s, res.gap);
  }

  /** Starts, corrects or suspends the prediction from the server's view of the local player. */
  private updatePrediction(s: SnapshotMsg, gap: boolean): void {
    const m = this.mirror;
    const p = this.predictor;
    const own = m.ownCharacterId;
    if (!own) {
      if (p.active) p.stop();
      m.locallyDriven.clear();
      return;
    }
    p.serverCharId = own;
    if (Number.isNaN(this.ctick)) {
      const rttTicks = Number.isNaN(this.rtt) ? 6 : Math.round((this.rtt * 60) / 1000);
      this.ctick = s.tick + rttTicks + TARGET_SLACK + 1;
      this.seqOffset = Math.max(0, this.lastSeq + 1 - this.ctick);
      this.seqEpoch = this.ctick + this.seqOffset;
    }
    if (s.ackSeq >= this.seqEpoch) {
      const slack = s.ackSeq - this.seqOffset - s.tick;
      this.slack = Number.isNaN(this.slack) ? slack : this.slack * 0.9 + slack * 0.1;
      this.rateScale = 1 + Math.max(-0.05, Math.min(0.05, (TARGET_SLACK - this.slack) * 0.02));
      if (Math.abs(this.slack - TARGET_SLACK) > 30) this.retime(s.tick);
    }
    if (!this.opts.predict) return;
    const st = serverOwnState(m, own);
    const ok = st && !gap && (st.status.state === 'normal' || st.status.state === 'swimming' || st.status.state === 'knocked' || (st.status.state === 'inVehicle' && st.status.seat === 0 && st.vehicle !== null));
    if (!st || !ok) {
      if (!gap && p.active) {
        p.stop();
        m.locallyDriven.clear();
      }
      return;
    }
    if (!p.active || st.tick < p.tick - 170) {
      p.start(st, this.ctick, m, (t) => this.sentInputs.get(t));
    } else {
      p.reconcile(st, m);
    }
  }

  /** Renumbers the client's ticks after the server's clock jumped (stall, catch-up): the prediction starts over. */
  private retime(serverTick: number): void {
    const rttTicks = Number.isNaN(this.rtt) ? 6 : Math.round((this.rtt * 60) / 1000);
    this.ctick = serverTick + rttTicks + TARGET_SLACK + 1;
    this.seqOffset = this.lastSeq + 1 - this.ctick;
    this.seqEpoch = this.ctick + this.seqOffset;
    this.slack = NaN;
    this.rateScale = 1;
    this.sentInputs.clear();
    this.predictor.stop();
  }

  // ---------------------------------------------------------------------------
  // Per frame

  /**
   * One rendered frame of `dt` s with the player's input for it (null while a menu has the keyboard): sends one input
   * per tick that is due, predicts the local player over those ticks, and brings the mirror's drawing up to date.
   */
  frame(dt: number, input: PlayerInput | null): void {
    const now = this.opts.now();
    if (this.state === 'joining' && now - this.startedAt > this.opts.connectTimeout * 1000 && !this.ready) {
      this.fail({ kind: 'timeout', text: `Could not connect to ${this.opts.url}: no answer.` });
    }
    if (this.state === 'connecting' && now - this.startedAt > this.opts.connectTimeout * 1000) {
      this.fail({ kind: 'unreachable', text: `Could not connect to ${this.opts.url}.` });
    }
    if (this.state === 'connected' && now - this.lastMessageAt > this.opts.silenceTimeout * 1000) {
      this.fail({ kind: 'lost', text: 'Connection to the server was lost.' });
    }
    if (this.state !== 'connected') {
      if (this.ready) this.mirror.update(dt, now);
      return;
    }
    if (now - this.lastPingAt > PING_EVERY_MS) {
      this.lastPingAt = now;
      this.send({ type: 'ping', clientTime: now });
    }
    if (input) this.latch(input);
    if (this.mirror.slot >= 0 && !Number.isNaN(this.ctick)) this.runTicks(dt);
    this.mirror.update(dt, now);
    this.writeLocal(dt);
  }

  /** Keeps a frame's presses for the next tick (a frame may run no tick at all). */
  private latch(input: PlayerInput): void {
    const prev = this.pending;
    const next: PlayerInput = { ...input, aimOrigin: { ...input.aimOrigin }, aimDir: { ...input.aimDir } };
    if (prev) {
      for (const f of EDGES) next[f] = next[f] || prev[f];
      if (next.selectSlot < 0) next.selectSlot = prev.selectSlot;
    }
    this.pending = next;
  }

  private runTicks(dt: number): void {
    this.acc += dt * 60 * this.rateScale;
    let n = 0;
    while (this.acc > 0 && n < MAX_TICKS_PER_FRAME) {
      this.tickOnce();
      this.acc -= 1;
      n++;
    }
    if (this.acc > 0) this.acc = 0;
    this.alpha = 1 + this.acc;
  }

  private tickOnce(): void {
    const t = this.ctick;
    const raw = this.pending ?? this.lastHeld();
    const q = quantizeInput(raw);
    // Presses go with one tick only; held state carries on.
    if (this.pending) {
      const held: PlayerInput = { ...this.pending };
      for (const f of EDGES) held[f] = false;
      held.selectSlot = -1;
      this.pending = held;
    }
    const seq = t + this.seqOffset;
    this.lastSeq = seq;
    this.send({ type: 'input', seq, tick: Math.max(0, this.mirror.tick), input: q });
    this.inputsSent++;
    this.sentInputs.set(t, q);
    this.sentInputs.delete(t - 240);
    const p = this.predictor;
    if (p.active) {
      if (p.tick !== t) p.stop();
      else p.step(q, this.mirror);
    }
    this.ctick = t + 1;
  }

  private lastHeld(): PlayerInput {
    const last = this.sentInputs.get(this.ctick - 1);
    if (last) {
      const held = { ...last };
      for (const f of EDGES) held[f] = false;
      held.selectSlot = -1;
      return held;
    }
    return quantizeInput({
      moveX: 0, moveZ: 0, cameraYaw: 0, aimOrigin: { x: 0, y: 0, z: 0 }, aimDir: { x: 0, y: 0, z: 1 }, sprint: false, jump: false, fire: false,
      firePressed: false, aim: false, enterExit: false, interact: false, reload: false, nextWeapon: false, prevWeapon: false, selectSlot: -1,
      throttle: 0, brake: 0, steer: 0, steerDigital: false, handbrake: false, horn: false, hornPressed: false, job: false,
    });
  }

  /** Draws the predicted player (and his car) in the mirror's objects; everything else stays interpolated. */
  private writeLocal(dt: number): void {
    const m = this.mirror;
    const p = this.predictor;
    m.locallyDriven.clear();
    if (!p.active) return;
    const mc = m.character(p.serverCharId);
    if (!mc) return;
    for (const id of p.ownedIds()) m.locallyDriven.add(id);
    const pose = p.renderPose(this.alpha, dt, this.pose);
    const pc = p.char;
    const pv = pc.state === 'inVehicle' ? pc.vehicle : null;
    const mv = pv ? m.vehicle(pv.id) : null;
    if (pv && mv) {
      mv.pos.x = pose.x;
      mv.pos.y = pose.y;
      mv.pos.z = pose.z;
      mv.heading = pose.heading;
      mv.vel.x = pv.vel.x;
      mv.vel.z = pv.vel.z;
      mv.vy = pv.vy;
      mv.pitch = pv.pitch;
      mv.roll = pv.roll;
      mv.angVel = pv.angVel;
      mv.steer = pv.steer;
      mv.speed = pv.speed;
      mv.forwardSpeed = pv.forwardSpeed;
      mv.rpm = pv.rpm;
      mv.gear = pv.gear;
      mv.skid = pv.skid;
      mv.wheelSpin = pv.wheelSpin;
      mv.braking = pv.braking;
      mv.reversing = pv.reversing;
      mv.airborne = pv.airborne;
      Object.assign(mv.controls, pv.controls);
      mv.horn = pv.horn;
      if (mc.vehicle && mc.vehicle !== mv && mc.vehicle.driver === mc) mc.vehicle.driver = null;
      mc.vehicle = mv;
      mc.seat = 0;
      mc.state = 'inVehicle';
      mv.driver = mc;
      placeOccupant(mc, mv);
    } else {
      if (mc.vehicle && mc.state === 'inVehicle') {
        if (mc.vehicle.driver === mc) mc.vehicle.driver = null;
        mc.vehicle = null;
      }
      mc.state = pc.state === 'inVehicle' ? 'normal' : pc.state;
      mc.pos.x = pose.x;
      mc.pos.y = pose.y;
      mc.pos.z = pose.z;
      mc.heading = pose.heading;
      mc.vel.x = pc.vel.x;
      mc.vel.y = pc.vel.y;
      mc.vel.z = pc.vel.z;
      mc.speed = pc.speed;
      mc.onGround = pc.onGround;
      mc.animPhase = pc.animPhase;
    }
    mc.aiming = pc.aiming;
    mc.aimZoom = pc.aimZoom;
    mc.aimYaw = pc.aimYaw;
    mc.aimPitch = pc.aimPitch;
    mc.moveX = pc.moveX;
    mc.moveZ = pc.moveZ;
    mc.moveSpeed = pc.moveSpeed;
    for (const id of p.ownedIds()) {
      if (id === p.serverCharId || (pv && id === pv.id)) continue;
      const rv = m.vehicle(id);
      const src = p.sim.vehicles.find((v) => v.id === id);
      if (!rv || !src) continue;
      Object.assign(rv.pos, src.pos);
      rv.heading = src.heading;
      rv.vel.x = src.vel.x;
      rv.vel.z = src.vel.z;
      rv.speed = src.speed;
      rv.forwardSpeed = src.forwardSpeed;
      rv.pitch = src.pitch;
      rv.roll = src.roll;
    }
  }

  // ---------------------------------------------------------------------------
  // Debug

  debug(): NetDebug {
    const m = this.mirror;
    const p = this.predictor;
    const now = this.opts.now();
    return {
      state: this.state,
      failure: this.failure,
      url: this.opts.url,
      room: m.roomId || this.opts.room,
      name: this.opts.name,
      playerId: m.playerId,
      slot: m.slot,
      watching: m.playerId > 0 && m.slot < 0,
      rtt: Number.isNaN(this.rtt) ? -1 : Math.round(this.rtt * 10) / 10,
      tick: m.tick,
      renderTick: m.renderClock.renderTick,
      interpDelayMs: m.renderClock.started ? Math.round(((m.renderClock.observed(now) - m.renderClock.renderTick) / 60) * 1000) : -1,
      snapshots: m.stats.snapshots,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      inputsSent: this.inputsSent,
      resyncs: this.resyncs,
      counts: {
        vehicles: m.vehicles.length,
        characters: m.characters.length,
        pickups: m.pickups.length,
        projectiles: m.projectiles.length,
        helis: m.helis.length,
        total: m.entityCount,
      },
      mirror: { ...m.stats },
      prediction: { ...p.stats, active: p.active, tick: p.tick, slack: Number.isNaN(this.slack) ? 0 : Math.round(this.slack * 100) / 100, rateScale: this.rateScale },
    };
  }

  /** Inputs sent, by tick (tests compare the server's state with the prediction). */
  inputAt(tick: number): PlayerInput | undefined {
    return this.sentInputs.get(tick);
  }

  /** The client tick that maps to a seq (tests). */
  get seqToTick(): number {
    return this.seqOffset;
  }
}
