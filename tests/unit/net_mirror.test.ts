// The client mirror against the real server room: snapshots applied to a Mirror reproduce what the server's Sim shows
// the player (VAL-MPCL-002), events come back once each with their entities resolved, a lost snapshot is repaired by a
// resync, and remote entities are drawn smoothly from the interpolation buffer (VAL-MPCL-003, unit part).

import { describe, expect, it } from 'vitest';
import { Connection, type ConnectionOptions } from '../../server/connection';
import { RoomManager } from '../../server/rooms';
import { Mirror } from '../../src/net/mirror';
import { ANGLE_STEP, decodeMessage, encodeMessage, PROTOCOL_VERSION, type Message, type SnapshotMsg, type WelcomeMsg } from '../../src/net/protocol';
import type { Character, Vehicle } from '../../src/sim/entities';
import { linkRandom } from '../../src/net/transport';
import { StaticWorld } from '../../src/world/staticWorld';
import { FakePeer } from './net_helpers';

const TAU = Math.PI * 2;
const angDiff = (a: number, b: number) => Math.abs(((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI);
const POS_TOL = 0.0051;
const ANG_TOL = ANGLE_STEP / 2 + 1e-6;

interface Harness {
  mgr: RoomManager;
  peer: FakePeer;
  conn: Connection;
  mirror: Mirror;
  received: Map<string, number>;
  emitted: Map<string, number>;
  /** Event payload fields that were ids on the wire and came back as objects: [field value, id]. */
  resolved: Array<{ value: unknown; id: number }>;
  apply: (drop?: (m: Message) => boolean) => { snapshots: SnapshotMsg[]; gap: boolean; missing: number };
  send: (m: Message) => void;
  t: number;
}

function harness(): Harness {
  const mgr = new RoomManager({ emptyRoomTtlMs: 60_000, log: () => {}, room: { realtime: false, log: () => {}, dev: true } });
  const peer = new FakePeer();
  const opts: ConnectionOptions = { defaultRoom: 'lobby', maxErrors: 32, ratePerSec: 1e6, rateBurst: 1e6, log: () => {}, now: () => performance.now() };
  const conn = new Connection(peer, mgr, opts);
  const mirror = new Mirror({ world: new StaticWorld() });
  const received = new Map<string, number>();
  const emitted = new Map<string, number>();
  const resolved: Harness['resolved'] = [];
  const emit = mirror.events.emit.bind(mirror.events) as (t: string, p: unknown) => void;
  (mirror.events as unknown as { emit: (t: string, p: unknown) => void }).emit = (type, payload) => {
    emitted.set(type, (emitted.get(type) ?? 0) + 1);
    emit(type, payload);
  };
  const h: Harness = {
    mgr, peer, conn, mirror, received, emitted, resolved, t: 0,
    send: (m) => conn.onMessage(new Uint8Array(encodeMessage(m)), true),
    apply(drop) {
      const out = { snapshots: [] as SnapshotMsg[], gap: false, missing: 0 };
      for (const bytes of peer.sent.splice(0)) {
        const m = decodeMessage(bytes);
        if (drop?.(m)) continue;
        if (m.type === 'welcome') mirror.applyWelcome(m as WelcomeMsg);
        else if (m.type === 'snapshot') {
          h.t += 40;
          const r = mirror.applySnapshot(m, h.t);
          out.gap ||= r.gap;
          out.missing += r.missing;
          out.snapshots.push(m);
        } else if (m.type === 'event') {
          for (const e of m.events) {
            received.set(e.type, (received.get(e.type) ?? 0) + 1);
            for (const [k, v] of Object.entries(e.data)) if (v && typeof v === 'object' && '$id' in v) resolved.push({ value: k, id: (v as { $id: number }).$id });
          }
          mirror.queueEvents(m);
          mirror.flushEvents();
        }
      }
      return out;
    },
  };
  h.send({ type: 'hello', version: PROTOCOL_VERSION, name: 'A', room: 'mir' });
  return h;
}

/** Field-by-field comparison of every entity in the client's interest set; returns the mismatches. */
function compare(h: Harness): { checked: { vehicles: number; characters: number; pickups: number; projectiles: number; helis: number; fields: number }; bad: string[] } {
  const room = h.mgr.room('mir')!;
  const member = [...room.members.values()][0]!;
  const sim = room.sim;
  const m = h.mirror;
  const bad: string[] = [];
  const checked = { vehicles: 0, characters: 0, pickups: 0, projectiles: 0, helis: 0, fields: 0 };
  const near = (what: string, a: number, b: number, tol: number) => {
    checked.fields++;
    if (!(Math.abs(a - b) <= tol)) bad.push(`${what}: server ${a} mirror ${b}`);
  };
  const same = (what: string, a: unknown, b: unknown) => {
    checked.fields++;
    if (JSON.stringify(a) !== JSON.stringify(b)) bad.push(`${what}: server ${JSON.stringify(a)} mirror ${JSON.stringify(b)}`);
  };
  const interest = member.interest!;
  const mirrorIds = new Set<number>([...m.vehicles, ...m.characters, ...m.pickups, ...m.projectiles, ...m.helis].map((e) => e.id));
  same('interest ids', [...interest].sort((a, b) => a - b), [...mirrorIds].sort((a, b) => a - b));
  const ref = (e: { id: number } | null | undefined) => (e ? e.id : 0);
  for (const sv of sim.vehicles) {
    if (!interest.has(sv.id)) continue;
    const v = m.vehicle(sv.id) as Vehicle;
    if (!v) {
      bad.push(`vehicle ${sv.id} missing`);
      continue;
    }
    checked.vehicles++;
    const k = `vehicle ${sv.id}`;
    same(`${k} kind`, sv.kind, v.kind);
    same(`${k} color/owner`, [sv.color, sv.owner], [v.color, v.owner]);
    near(`${k} x`, sv.pos.x, v.pos.x, POS_TOL);
    near(`${k} y`, sv.pos.y, v.pos.y, POS_TOL);
    near(`${k} z`, sv.pos.z, v.pos.z, POS_TOL);
    near(`${k} heading`, 0, angDiff(sv.heading, v.heading), ANG_TOL);
    near(`${k} pitch`, 0, angDiff(sv.pitch, v.pitch), ANG_TOL);
    near(`${k} roll`, 0, angDiff(sv.roll, v.roll), ANG_TOL);
    near(`${k} vx`, sv.vel.x, v.vel.x, 0.0051);
    near(`${k} vz`, sv.vel.z, v.vel.z, 0.0051);
    near(`${k} vy`, sv.vy, v.vy, 0.0051);
    near(`${k} angVel`, sv.angVel, v.angVel, 0.00051);
    near(`${k} steer`, sv.steer, v.steer, 1 / 32767);
    // Derived from the velocity on both ends (a car spawned moving has a stale speed until its first physics step).
    near(`${k} speed`, Math.hypot(sv.vel.x, sv.vel.z), v.speed, 0.02);
    near(`${k} forwardSpeed`, sv.vel.x * Math.sin(sv.heading) + sv.vel.z * Math.cos(sv.heading), v.forwardSpeed, 0.02);
    near(`${k} rpm`, sv.rpm, v.rpm, 0.5 / 255 + 1e-6);
    near(`${k} skid`, Math.max(0, Math.min(1, sv.skid)), v.skid, 0.5 / 255 + 1e-6);
    same(`${k} gear`, sv.gear, v.gear);
    near(`${k} throttle`, sv.controls.throttle, v.controls.throttle, 0.5 / 127 + 1e-6);
    near(`${k} brake`, sv.controls.brake, v.controls.brake, 0.5 / 127 + 1e-6);
    near(`${k} ctlSteer`, sv.controls.steer, v.controls.steer, 0.5 / 127 + 1e-6);
    same(`${k} flags`, [sv.controls.handbrake, sv.braking, sv.reversing, sv.siren, sv.horn], [v.controls.handbrake, v.braking, v.reversing, v.siren, v.horn]);
    near(`${k} health`, sv.health, v.health, Math.abs(sv.health) * 1e-6 + 1e-3);
    same(`${k} status`, [sv.burning, sv.destroyed, sv.flipped, sv.airborne, sv.inWater, Math.min(255, Math.floor(sv.wreckTime))], [v.burning, v.destroyed, v.flipped, v.airborne, v.inWater, v.wreckTime]);
    same(`${k} seats`, [ref(sv.driver), ...sv.passengers.map(ref)], [ref(v.driver), ...v.passengers.map(ref)]);
    same(`${k} dents`, [sv.dentVersion, sv.dents.length], [v.dentVersion, v.dents.length]);
  }
  for (const sc of sim.characters) {
    if (!interest.has(sc.id)) continue;
    const c = m.character(sc.id) as Character;
    if (!c) {
      bad.push(`character ${sc.id} missing`);
      continue;
    }
    checked.characters++;
    const k = `character ${sc.id}`;
    const ap = (a: Character['appearance']) => [a.skin, a.shirt, a.pants, a.hair, a.hat];
    same(`${k} role/appearance`, [sc.role, ap(sc.appearance), sc.maxHealth], [c.role, ap(c.appearance), c.maxHealth]);
    near(`${k} height`, sc.appearance.height, c.appearance.height, 1e-6);
    near(`${k} build`, sc.appearance.build, c.appearance.build, 1e-6);
    near(`${k} x`, sc.pos.x, c.pos.x, POS_TOL);
    near(`${k} y`, sc.pos.y, c.pos.y, POS_TOL);
    near(`${k} z`, sc.pos.z, c.pos.z, POS_TOL);
    near(`${k} vx`, sc.vel.x, c.vel.x, 0.0051);
    near(`${k} vy`, sc.vel.y, c.vel.y, 0.0051);
    near(`${k} vz`, sc.vel.z, c.vel.z, 0.0051);
    near(`${k} heading`, 0, angDiff(sc.heading, c.heading), ANG_TOL);
    near(`${k} animPhase`, 0, angDiff(sc.animPhase, c.animPhase), ANG_TOL);
    same(`${k} state`, [sc.state, ref(sc.vehicle), sc.seat, sc.onGround], [c.state, ref(c.vehicle), c.seat, c.onGround]);
    near(`${k} health`, sc.health, c.health, Math.abs(sc.health) * 1e-6 + 1e-3);
    near(`${k} armor`, sc.armor, c.armor, Math.abs(sc.armor) * 1e-6 + 1e-3);
    same(`${k} weapon`, [sc.inventory.current, sc.reloadWeapon, sc.aiming, sc.aimZoom, sc.meleeCombo], [c.inventory.current, c.reloadWeapon, c.aiming, c.aimZoom, c.meleeCombo]);
    near(`${k} aimYaw`, 0, angDiff(sc.aimYaw, c.aimYaw), ANG_TOL);
    near(`${k} shotTimer`, Math.max(0, sc.shotTimer), c.shotTimer, 0.00051);
  }
  for (const sp of sim.pickups) {
    if (!interest.has(sp.id)) continue;
    const p = m.pickups.find((x) => x.id === sp.id);
    if (!p) {
      bad.push(`pickup ${sp.id} missing`);
      continue;
    }
    checked.pickups++;
    same(`pickup ${sp.id}`, [sp.kind, sp.active, sp.weapon, sp.tag], [p.kind, p.active, p.weapon, p.tag]);
    near(`pickup ${sp.id} x`, sp.pos.x, p.pos.x, POS_TOL);
  }
  for (const sh of sim.helis) {
    if (!interest.has(sh.id)) continue;
    const x = m.helis.find((e) => e.id === sh.id);
    if (!x) {
      bad.push(`heli ${sh.id} missing`);
      continue;
    }
    checked.helis++;
    near(`heli ${sh.id} x`, sh.pos.x, x.pos.x, POS_TOL);
    near(`heli ${sh.id} y`, sh.pos.y, x.pos.y, POS_TOL);
    same(`heli ${sh.id} flags`, [sh.destroyed, sh.crashing], [x.destroyed, x.crashing]);
  }
  for (const sp of sim.projectiles) {
    if (!interest.has(sp.id)) continue;
    const x = m.projectiles.find((e) => e.id === sp.id);
    if (!x) bad.push(`projectile ${sp.id} missing`);
    else {
      checked.projectiles++;
      near(`projectile ${sp.id} x`, sp.pos.x, x.pos.x, POS_TOL);
    }
  }
  return { checked, bad };
}

describe('the mirror reproduces the server view of the player (VAL-MPCL-002)', () => {
  it('every entity of the interest set, field by field, through traffic, pedestrians, a pursuit and gunfire', () => {
    const h = harness();
    const room = h.mgr.room('mir')!;
    const sim = room.sim;
    const p = sim.player;
    p.inventory.give('smg', 900);
    p.inventory.current = 'smg';
    let compared = 0;
    let maxBad: string[] = [];
    const totals = { vehicles: 0, characters: 0, pickups: 0, projectiles: 0, helis: 0, fields: 0 };
    let removedSeen = 0;
    let addedSeen = 0;
    // The most police cars the mirror held at once: wave-1 police shoot a standing 3-star player dead in about 30 s,
    // and the respawn ends the pursuit before the run does.
    let policeSeen = 0;
    for (let tick = 0; tick < 60 * 40; tick++) {
      if (tick === 60 * 4) sim.wanted.setLevel(3);
      // Some shooting into the air now and then (shot/weaponFired events, a fleeing crowd).
      if (tick % 90 === 0 && tick > 60 * 5) {
        const inp = { ...sim.lastInput, aimOrigin: { x: p.pos.x, y: p.pos.y + 1.6, z: p.pos.z }, aimDir: { x: 0, y: 0.6, z: 0.8 } };
        sim.combat.playerFire(p, inp, false);
      }
      room.step();
      const before = new Set([...h.mirror.vehicles, ...h.mirror.characters].map((e) => e.id));
      const r = h.apply();
      if (r.snapshots.length === 0) continue;
      const after = new Set([...h.mirror.vehicles, ...h.mirror.characters].map((e) => e.id));
      for (const id of before) if (!after.has(id)) removedSeen++;
      for (const id of after) if (!before.has(id)) addedSeen++;
      policeSeen = Math.max(policeSeen, h.mirror.vehicles.filter((v) => v.owner === 'police').length);
      const c = compare(h);
      compared++;
      for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += c.checked[k];
      if (c.bad.length > maxBad.length) maxBad = c.bad.slice(0, 12);
      expect(c.bad, `tick ${room.tick}`).toEqual([]);
      // Removed entities are gone from the arrays as well as the index.
      for (const v of h.mirror.vehicles) expect(v.removed).toBe(false);
      for (const ch of h.mirror.characters) expect(ch.removed).toBe(false);
    }
    const police = h.mirror.vehicles.filter((v) => v.owner === 'police').length;
    console.log(`[mirror] ${compared} snapshots compared; entity checks ${JSON.stringify(totals)}; ${addedSeen} appeared, ${removedSeen} left; police cars now ${police} (most at once ${policeSeen}), helis ${h.mirror.helis.length}; mismatches ${maxBad.length}`);
    expect(compared).toBeGreaterThan(900);
    expect(totals.vehicles).toBeGreaterThan(5000);
    expect(totals.characters).toBeGreaterThan(5000);
    expect(addedSeen).toBeGreaterThan(10);
    expect(removedSeen).toBeGreaterThan(5);
    expect(policeSeen).toBeGreaterThan(0);

    // Events: each re-emitted once, with every entity id the mirror knows turned into its object.
    const recv = Object.fromEntries(h.received);
    const emitted = Object.fromEntries(h.emitted);
    console.log(`[mirror] events received ${JSON.stringify(recv)}; dropped (subject unknown) ${h.mirror.stats.eventsDropped}`);
    for (const [type, n] of h.received) {
      if (type === 'propBroken') continue;
      expect(emitted[type] ?? 0, type).toBe(n);
    }
    expect((recv.shot ?? 0) + (recv.weaponFired ?? 0)).toBeGreaterThan(10);
    expect(recv.wanted ?? 0).toBeGreaterThan(0);
    expect(h.mirror.stats.eventsDropped).toBe(0);
  });

  it('a lost snapshot is detected, a resync repairs the mirror, and nothing in it is corrupted meanwhile', () => {
    const h = harness();
    const room = h.mgr.room('mir')!;
    const sim = room.sim;
    for (let i = 0; i < 120; i++) {
      room.step();
      h.apply();
    }
    expect(compare(h).bad).toEqual([]);
    // A car drives off from beside the player, a parked one vanishes, a prop breaks while one snapshot is lost.
    const p = sim.player.pos;
    const car = sim.spawnVehicle('muscle', p.x + 6, p.z + 3, 0.4, 0xabcdef);
    let lost = 0;
    let gapSeen = false;
    let resyncs = 0;
    for (let i = 0; i < 240; i++) {
      if (i === 10) car.vel.x = 12;
      if (i === 12) sim.removeVehicle(car);
      room.step();
      const r = h.apply((m) => {
        if (m.type === 'snapshot' && lost < 2 && i >= 8) {
          lost++;
          return true;
        }
        return false;
      });
      if (r.gap || r.missing > 0) {
        gapSeen = true;
        resyncs++;
        h.send({ type: 'cmd', seq: resyncs, name: 'resync', arg: '' });
      }
      for (const v of h.mirror.vehicles) {
        expect(Number.isFinite(v.pos.x) && Number.isFinite(v.heading)).toBe(true);
        expect(v.spec).toBeDefined();
      }
    }
    expect(lost).toBe(2);
    expect(gapSeen).toBe(true);
    const c = compare(h);
    console.log(`[mirror] after ${lost} lost snapshots and ${resyncs} resync request(s): ${c.checked.vehicles} vehicles, ${c.checked.characters} characters, ${c.checked.fields} fields compared, ${c.bad.length} mismatches`);
    expect(c.bad).toEqual([]);
    expect(h.mirror.vehicle(car.id)).toBeNull();
  });
});

describe('remote entities move smoothly between snapshots (VAL-MPCL-003, unit)', () => {
  for (const hz of [20, 30]) {
    it(`a car at 20 m/s from ${hz} Hz snapshots, 2% lost, ±20 ms jitter`, () => {
      const mirror = new Mirror({ world: new StaticWorld() });
      mirror.applyWelcome({ type: 'welcome', playerId: 2, slot: 1, roomId: 'x', roomSeed: 1, tick: 0, tickRate: 60, snapshotRate: hz, brokenProps: [], signalHolds: [], pickups: [] });
      const every = 60 / hz;
      const speed = 20;
      const id = 500;
      const rnd = linkRandom(hz);
      const base = (tick: number): SnapshotMsg => ({
        type: 'snapshot', tick, ackSeq: 0, time: tick / 60, full: tick === every, clock: { day: 1, hours: 12, rate: 0 }, hud: { wanted: 0, searching: false, money: 0 },
        roster: tick === every ? [{ playerId: 2, characterId: 0, slot: 1, name: 'B' }] : null, weather: null, signalHolds: null, brokenProps: [], vehicles: [], characters: [], projectiles: [], helis: [], pickups: [], removed: [],
      });
      const motion = (tick: number) => {
        const x = (tick / 60) * speed;
        return { x, y: 0.5, z: 0, heading: Math.PI / 2, pitch: 0, roll: 0, vx: speed, vz: 0, vy: 0, angVel: 0, steer: 0, speed, forwardSpeed: speed };
      };
      // Server sends at tick/60 s; each arrives 50 ms ± 20 ms later, never before the one sent before it.
      const arrivals: Array<{ at: number; msg: SnapshotMsg }> = [];
      let lastAt = 0;
      let dropped = 0;
      for (let tick = every; tick < 60 * 30; tick += every) {
        const msg = base(tick);
        msg.vehicles = [tick === every
          ? { id, motion: motion(tick), engine: { rpm: 0.5, gear: 3, skid: 0, throttle: 1, brake: 0, ctlSteer: 0, handbrake: false, braking: false, reversing: false, siren: false, horn: false }, status: { health: 1000, burning: false, destroyed: false, flipped: false, airborne: false, inWater: false, wreckTime: 0, driver: 0, passengers: [0, 0, 0] }, rare: { kind: 'sedan', color: 0xff0000, owner: 'traffic', dentVersion: 0, dents: [] } }
          : { id, motion: motion(tick) }];
        if (tick > every && rnd() < 0.02) {
          dropped++;
          continue;
        }
        lastAt = Math.max(lastAt, (tick / 60) * 1000 + 50 + (rnd() * 2 - 1) * 20);
        arrivals.push({ at: lastAt, msg });
      }
      const steps: number[] = [];
      const delays: number[] = [];
      let prevX = NaN;
      let k = 0;
      let newest: { tick: number; at: number } | null = null;
      for (let f = 0; f < 60 * 29; f++) {
        const now = 100 + f * (1000 / 60);
        while (k < arrivals.length && arrivals[k]!.at <= now) {
          mirror.applySnapshot(arrivals[k]!.msg, arrivals[k]!.at);
          newest = { tick: arrivals[k]!.msg.tick, at: arrivals[k]!.at };
          k++;
        }
        mirror.update(1 / 60, now);
        const v = mirror.vehicle(id);
        if (!v || !newest) continue;
        if (f > 120) {
          steps.push(Math.abs(v.pos.x - prevX));
          // How far behind the newest snapshot (carried on to now) the drawn car is.
          const drawnTick = (v.pos.x / speed) * 60;
          delays.push(((newest.tick + ((now - newest.at) * 60) / 1000 - drawnTick) / 60) * 1000);
        }
        prevX = v.pos.x;
      }
      const ideal = speed / 60;
      const within = steps.filter((s) => Math.abs(s - ideal) <= 0.25 * ideal).length / steps.length;
      const meanDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
      const sorted = [...steps].sort((a, b) => a - b);
      console.log(`[interp ${hz} Hz] ${steps.length} frames, ${dropped} snapshots dropped; step median ${sorted[sorted.length >> 1]!.toFixed(4)} m (ideal ${ideal.toFixed(4)}), min ${sorted[0]!.toFixed(4)}, max ${sorted[sorted.length - 1]!.toFixed(4)}; within 25%: ${(within * 100).toFixed(2)}%; delay behind newest snapshot mean ${meanDelay.toFixed(1)} ms (min ${Math.min(...delays).toFixed(1)}, max ${Math.max(...delays).toFixed(1)})`);
      expect(dropped).toBeGreaterThan(0);
      expect(within).toBeGreaterThanOrEqual(0.99);
      expect(meanDelay).toBeGreaterThanOrEqual(70);
      expect(meanDelay).toBeLessThanOrEqual(150);
    });
  }
});
