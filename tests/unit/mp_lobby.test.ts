// Multiplayer rules and lobby (architecture 4.5): each player's own look, PvP damage and kills credited to the right
// player (kill feed, kills / deaths), car damage credited to its attacker, the head-to-head Street Run (open, join,
// shared countdown and lock, gates per racer, finish order by tick, DNF, out of time, green wave), the job key at a
// course start, single-player-only places, and the MULTIPLAYER screen's defaults. Rooms run headless with fake peers.

import { describe, expect, it } from 'vitest';
import { FEED_EVENT, RACE_JOIN_WINDOW, ROOM_EVENT, type FeedEntry, type RoomState } from '../../src/net/lobby';
import { multiplayerInteractions, MP_NO_SHOP } from '../../src/net/mpPlaces';
import { MP_NO_STORY } from '../../src/sim/missions/runner';
import { menuServerAddress } from '../../src/net/url';
import type { NetEvent } from '../../src/net/protocol';
import { playerAppearance, playerColor, PLAYER_COLORS } from '../../src/sim/appearance';
import { HeadToHead, RACE_COUNTDOWN } from '../../src/sim/headToHead';
import { neutralInput, type PlayerInput } from '../../src/sim/input';
import { MP_NO_EXPORT, MP_NO_PROPERTY, MP_NO_SAVE } from '../../src/sim/interactions';
import { places } from '../../src/sim/activities/places';
import { streetRunCourses } from '../../src/sim/activities/streetRun';
import type { PlayerSlot } from '../../src/sim/playerSlot';
import { Sim } from '../../src/sim/sim';
import type { Vehicle } from '../../src/sim/entities';
import { StaticWorld } from '../../src/world/staticWorld';
import { Room, type Member } from '../../server/room';
import { joinValues } from '../../src/ui/screens/multiplayer';
import { FakePeer } from './net_helpers';
import { collectBlips, otherPlayerBlips } from '../../src/ui/mapRender';
import { Mirror } from '../../src/net/mirror';
import { world } from './helpers';

const TICK = 60;

function room(id = 'lobbytest'): Room {
  return new Room(id, 4242, { realtime: false, log: () => {}, sim: { ambient: false } });
}

interface Player { m: Member; peer: FakePeer; seq: number }

function join(r: Room, playerId: number, name: string): Player {
  const peer = new FakePeer();
  const m = r.join(playerId, name, peer);
  if (m === 'full') throw new Error('full');
  peer.send(r.welcome(m));
  return { m, peer, seq: 0 };
}

function slotOf(r: Room, p: Player): PlayerSlot {
  return r.sim.players.find((s) => s.id === p.m.slot)!;
}

function events(p: Player, type?: string): NetEvent[] {
  const out: NetEvent[] = [];
  for (const msg of p.peer.of('event')) for (const e of msg.events) if (!type || e.type === type) out.push(e);
  return out;
}

function lastState(p: Player): RoomState {
  const all = events(p, ROOM_EVENT);
  return all[all.length - 1]!.data.state as RoomState;
}

function send(r: Room, p: Player, over: Partial<PlayerInput> = {}): void {
  const c = slotOf(r, p).character;
  const at = c.vehicle ? c.vehicle.pos : c.pos;
  const h = c.vehicle ? c.vehicle.heading : c.heading;
  r.input(p.m, ++p.seq, { ...neutralInput(), aimOrigin: { x: at.x - Math.sin(h) * 6, y: at.y + 3, z: at.z - Math.cos(h) * 6 }, aimDir: { x: Math.sin(h), y: -0.12, z: Math.cos(h) }, cameraYaw: h, ...over }, r.tick);
}

function steps(r: Room, n: number, each?: () => void): void {
  for (let i = 0; i < n; i++) {
    each?.();
    r.step();
  }
}

/** Moves a racer's car toward (x, z) at 4 m a tick (a speed a car can drive), stepping the room each tick. */
function driveTo(r: Room, car: Vehicle, x: number, z: number, max = 2000): void {
  for (let i = 0; i < max; i++) {
    const dx = x - car.pos.x;
    const dz = z - car.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5) return;
    const k = Math.min(1, 4 / d);
    car.pos.x += dx * k;
    car.pos.z += dz * k;
    car.heading = Math.atan2(dx, dz);
    car.vel.x = car.vel.z = 0;
    r.step();
  }
  throw new Error('did not get there');
}

/** Drives a racer's car through every gate of the race's course, in order. */
function driveCourse(r: Room, race: HeadToHead, slot: PlayerSlot, upTo = Infinity): void {
  const racer = race.racer(slot)!;
  const gates = race.course.checkpoints;
  for (let k = racer.gate; k < Math.min(gates.length, upTo); k++) driveTo(r, racer.car!, gates[k]!.x, gates[k]!.z);
}

describe('every player has his own look', () => {
  it('two players in a room wear their slots\' colours; the look comes from slot and name only', () => {
    const r = room();
    const a = join(r, 1, 'Ann');
    const b = join(r, 2, 'Bea');
    const ca = slotOf(r, a).character;
    const cb = slotOf(r, b).character;
    expect(ca.appearance.shirt).toBe(playerColor(a.m.slot!));
    expect(cb.appearance.shirt).toBe(playerColor(b.m.slot!));
    expect(ca.appearance.shirt).not.toBe(cb.appearance.shirt);
    expect(new Set(PLAYER_COLORS).size).toBe(8);
    expect(playerAppearance(3, 'Zed')).toEqual(playerAppearance(3, 'Zed'));
    // Height stays the hero's (Character.height is fixed at construction, also in the client's mirror).
    expect(ca.appearance.height).toBe(1.02);
    // The look reaches the clients in the character's rare group.
    steps(r, 6);
    const seen = b.peer.of('snapshot').flatMap((s) => s.characters).find((u) => u.id === ca.id && u.rare);
    expect(seen!.rare!.appearance.shirt).toBe(playerColor(a.m.slot!));
  });
});

describe('PvP damage and kill attribution', () => {
  it('A shoots B with a pistol: B loses health, the damage names A; A kills B: the feed says "A killed B" on both', () => {
    const r = room();
    const a = join(r, 1, 'Ann');
    const b = join(r, 2, 'Bea');
    steps(r, 3);
    const sa = slotOf(r, a);
    const sb = slotOf(r, b);
    const A = sa.character;
    const B = sb.character;
    B.pos.x = A.pos.x;
    B.pos.z = A.pos.z + 6;
    B.pos.y = r.sim.world.groundHeight(B.pos.x, B.pos.z);
    A.heading = 0;
    A.inventory.give('pistol', 200);
    A.inventory.current = 'pistol';
    steps(r, 30, () => send(r, b));
    const hits: Array<{ attacker: number; loss: number }> = [];
    r.sim.events.on('damage', (e) => e.victim === B && hits.push({ attacker: e.attacker?.id ?? 0, loss: e.healthLoss }));
    const aim = () => {
      const o = { x: A.pos.x, y: A.pos.y + 1.6, z: A.pos.z - 2 };
      const t = { x: B.pos.x, y: B.pos.y + 1.2, z: B.pos.z };
      const l = Math.hypot(t.x - o.x, t.y - o.y, t.z - o.z);
      return { aimOrigin: o, aimDir: { x: (t.x - o.x) / l, y: (t.y - o.y) / l, z: (t.z - o.z) / l }, cameraYaw: 0, aim: true };
    };
    for (let i = 0; i < 6 && B.health > 0; i++) {
      steps(r, 1, () => {
        send(r, a, { ...aim(), fire: true, firePressed: true });
        send(r, b);
      });
      steps(r, 20, () => {
        send(r, a, aim());
        send(r, b);
      });
    }
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.attacker === A.id)).toBe(true);
    // B's own HUD numbers come from his slot: his health went down on the server.
    expect(B.health).toBeLessThan(100);
    if (B.alive) r.sim.combat.damageCharacter(B, 500, A, 'bullet', 0, 0, 1);
    steps(r, 4, () => {
      send(r, a);
      send(r, b);
    });
    for (const p of [a, b]) {
      const feed = events(p, FEED_EVENT).map((e) => e.data as unknown as FeedEntry).filter((f) => f.kind === 'kill');
      expect(feed).toEqual([expect.objectContaining({ text: 'Ann killed Bea', killer: 'Ann', victim: 'Bea', killerId: 1, victimId: 2 })]);
    }
    const st = lastState(a).players;
    expect(st.find((p) => p.name === 'Ann')).toMatchObject({ kills: 1, deaths: 0 });
    expect(st.find((p) => p.name === 'Bea')).toMatchObject({ kills: 0, deaths: 1 });
    // Each is told in his own words; the kill event itself names A's character as the killer.
    expect(events(b, 'message').some((e) => e.data.text === 'Ann killed you.')).toBe(true);
    expect(events(a, 'message').some((e) => e.data.text === 'You killed Bea.')).toBe(true);
    const killed = events(b, 'characterKilled').find((e) => (e.data.victim as { $id: number }).$id === B.id)!;
    expect((killed.data.killer as { $id: number }).$id).toBe(A.id);
    // B is down on his own: wasted, then the hospital; A was never locked.
    expect(sb.deathKind).toBe('wasted');
    expect(sa.deathKind).toBeNull();
    const money = sa.progress.money;
    steps(r, 6 * TICK, () => {
      send(r, a);
      send(r, b);
      expect(sa.controlLock).toBe(0);
    });
    expect(sb.deathKind).toBeNull();
    const hosp = r.sim.world.layout.pois.find((p) => p.id === 'hospital')!;
    expect(Math.hypot(B.pos.x - hosp.x, B.pos.z - hosp.z)).toBeLessThan(20);
    expect(sa.progress.money).toBe(money);
  });

  it("damage to B's car by A is credited to A, and wrecking it says so", () => {
    const r = room();
    const a = join(r, 1, 'Ann');
    const b = join(r, 2, 'Bea');
    steps(r, 2);
    const B = slotOf(r, b).character;
    const A = slotOf(r, a).character;
    const v = r.sim.spawnVehicle('sedan', B.pos.x + 4, B.pos.z, 0);
    r.sim.seat(B, v, 0);
    r.sim.combat.damageVehicle(v, 120, A, 'bullet');
    // Damage by nobody, or by the car's own driver, is nobody's credit.
    r.sim.combat.damageVehicle(v, 50, null, 'impact');
    r.sim.combat.damageVehicle(v, 50, B, 'bullet');
    steps(r, 3);
    expect(lastState(a).players.find((p) => p.name === 'Ann')!.carDamage).toBe(120);
    expect(lastState(a).players.find((p) => p.name === 'Bea')!.carDamage).toBe(0);
    r.sim.combat.damageVehicle(v, 5000, A, 'explosion');
    steps(r, 3);
    expect(v.destroyed).toBe(true);
    const wreck = events(b, FEED_EVENT).map((e) => e.data as unknown as FeedEntry).find((f) => f.kind === 'wreck');
    expect(wreck).toMatchObject({ text: "Ann wrecked Bea's car", killerId: 1, victimId: 2 });
  });
});

describe('the head-to-head Street Run', () => {
  it('A opens, B joins in the window, one countdown for both, locked until GO, then the results by finish tick', () => {
    const r = room();
    const a = join(r, 1, 'Ann');
    const b = join(r, 2, 'Bea');
    steps(r, 2);
    r.command(a.m, 'race', JSON.stringify({ action: 'open', course: 'magnolia' }));
    const opened = r.tick;
    steps(r, 3);
    const race = r.rules.race!;
    expect(race.stage).toBe('lobby');
    // Both clients see the open race; B joins it.
    expect(lastState(b).race).toMatchObject({ courseId: 'magnolia', stage: 'lobby', hostName: 'Ann' });
    expect(lastState(b).race!.closeTick).toBe(opened + RACE_JOIN_WINDOW * TICK);
    r.command(b.m, 'race', JSON.stringify({ action: 'join', course: 'magnolia' }));
    steps(r, 3);
    expect(lastState(a).race!.entrants.map((e) => e.name)).toEqual(['Ann', 'Bea']);
    // Only the opener starts it early.
    r.command(b.m, 'race', JSON.stringify({ action: 'start' }));
    steps(r, 3);
    expect(race.stage).toBe('lobby');
    r.command(a.m, 'race', JSON.stringify({ action: 'start' }));
    expect(race.stage).toBe('countdown');
    const sa = slotOf(r, a);
    const sb = slotOf(r, b);
    const ca = race.racer(sa)!.car!;
    const cb = race.racer(sb)!.car!;
    expect(sa.character.vehicle).toBe(ca);
    expect(sb.character.vehicle).toBe(cb);
    // Two grid spots, apart.
    expect(Math.hypot(ca.pos.x - cb.pos.x, ca.pos.z - cb.pos.z)).toBeGreaterThan(3);
    const startA = { ...ca.pos };
    // Full throttle through the countdown moves neither car.
    let ticks = 0;
    while (race.stage === 'countdown') {
      steps(r, 1, () => {
        send(r, a, { throttle: 1, moveZ: 1 });
        send(r, b, { throttle: 1, moveZ: 1 });
      });
      ticks++;
      if (race.stage === 'countdown') {
        expect(Math.hypot(ca.pos.x - startA.x, ca.pos.z - startA.z)).toBeLessThan(0.05);
        expect(sa.controlLock).toBeGreaterThan(0);
        expect(sb.controlLock).toBeGreaterThan(0);
      }
    }
    expect(ticks).toBe(RACE_COUNTDOWN * TICK);
    expect(sa.controlLock).toBe(0);
    expect(sb.controlLock).toBe(0);
    steps(r, 3);
    // The beats 3, 2, 1, GO came in the same server messages to both players.
    const beats = (p: Player) => p.peer.of('event').flatMap((m) => m.events.filter((e) => e.type === 'streetRunCountdown').map((e) => `${m.tick}:${e.data.count}`));
    expect(beats(a)).toEqual(beats(b));
    expect(beats(a).map((x) => x.split(':')[1])).toEqual(['3', '2', '1', '0']);
    expect(race.goTick).toBe(lastState(a).race!.goTick);
    // Moving after GO: the racers' HUDs show their own gates.
    send(r, a, { throttle: 1 });
    steps(r, 30, () => send(r, a, { throttle: 1, moveZ: 1 }));
    expect(Math.hypot(ca.pos.x - startA.x, ca.pos.z - startA.z)).toBeGreaterThan(1);
    const hud = r.rules.jobFor(sa.id)!;
    expect(hud.status).toMatch(/^GATE 1\/\d+ · 0:0\d\.\d · P\d\/2$/);
    expect(hud.objectives).toHaveLength(1);
    // The green wave holds the junctions ahead.
    expect(race.course.nodes.filter((n) => r.sim.roads.signalHold(n) !== null).length).toBeGreaterThan(0);
    // B drives the course first, then A.
    driveCourse(r, race, sb);
    expect(race.racer(sb)!.status).toBe('finished');
    const bTick = race.racer(sb)!.finishTick!;
    driveCourse(r, race, sa);
    expect(race.stage).toBe('results');
    const aTick = race.racer(sa)!.finishTick!;
    expect(aTick).toBeGreaterThan(bTick);
    steps(r, 3);
    const ra = lastState(a).race!;
    const rb = lastState(b).race!;
    expect(ra).toEqual(rb);
    expect(ra.entrants.map((e) => [e.name, e.position, e.status])).toEqual([['Bea', 1, 'finished'], ['Ann', 2, 'finished']]);
    expect(ra.entrants[0]!.time).toBeCloseTo((bTick - race.goTick) / TICK, 9);
    expect(ra.entrants[1]!.finishTick).toBe(aTick);
    // Medals by the course's times; nothing is paid (and nothing could be saved: multiplayer sims save nothing).
    for (const e of ra.entrants) expect(e.medal).toBe(e.time! <= race.course.gold ? 'gold' : e.time! <= race.course.silver ? 'silver' : e.time! <= race.course.bronze ? 'bronze' : null);
    expect(events(a, 'saveRequested')).toEqual([]);
    expect(events(a, FEED_EVENT).some((e) => e.data.text === 'Bea won the Magnolia Rush race')).toBe(true);
    // The results stay up, then the race is gone and the signals are released.
    steps(r, 12 * TICK + 3);
    expect(r.rules.race).toBeNull();
    expect(lastState(a).race).toBeNull();
  });

  it('a racer who leaves mid race is DNF and the race still finishes for the other', () => {
    const r = room();
    const a = join(r, 1, 'Ann');
    const b = join(r, 2, 'Bea');
    r.command(a.m, 'race', JSON.stringify({ action: 'open', course: 'dockside' }));
    r.command(b.m, 'race', JSON.stringify({ action: 'join' }));
    r.command(a.m, 'race', JSON.stringify({ action: 'start' }));
    const race = r.rules.race!;
    steps(r, RACE_COUNTDOWN * TICK + 2);
    expect(race.stage).toBe('racing');
    const sa = slotOf(r, a);
    driveCourse(r, race, sa, 2);
    r.leave(b.m);
    steps(r, 3);
    expect(race.results().find((x) => x.status === 'dnf')).toMatchObject({ reason: 'left' });
    driveCourse(r, race, sa);
    expect(race.stage).toBe('results');
    steps(r, 3);
    expect(lastState(a).race!.entrants.map((e) => [e.name, e.position, e.status, e.reason])).toEqual([['Ann', 1, 'finished', ''], ['Gone', 0, 'dnf', 'left']]);
  });

  it('the job key at a course start opens its race (no solo run), and a second player there joins it', () => {
    const r = room();
    const a = join(r, 1, 'Ann');
    const b = join(r, 2, 'Bea');
    const course = streetRunCourses(r.sim).find((c) => c.id === 'coastline')!;
    for (const [p, dx] of [[a, 0], [b, 3]] as const) {
      const c = slotOf(r, p).character;
      c.pos.x = course.start.x + dx;
      c.pos.z = course.start.z;
      c.pos.y = r.sim.world.groundHeight(c.pos.x, c.pos.z);
    }
    steps(r, 2, () => {
      send(r, a);
      send(r, b);
    });
    send(r, a, { job: true });
    steps(r, 2);
    expect(r.rules.race?.course.id).toBe('coastline');
    expect(r.sim.activities.jobOf(slotOf(r, a))).toBeNull();
    send(r, b, { job: true });
    steps(r, 2);
    expect(r.rules.race!.racers.map((x) => x.slot.id)).toEqual([a.m.slot, b.m.slot]);
    // Nobody starts it: the window closes on its own and the countdown begins.
    steps(r, RACE_JOIN_WINDOW * TICK);
    expect(r.rules.race!.stage).not.toBe('lobby');
  });

  it('nobody finishing within the course time ends it out of time for everyone still racing', () => {
    const sim = new Sim({ world: new StaticWorld(), ambient: false, police: false, multiplayer: true, seed: 3 });
    const s1 = sim.players[0]!;
    const s2 = sim.addPlayer(s1.character.pos.x + 3, s1.character.pos.z);
    const course = streetRunCourses(sim).find((c) => c.id === 'magnolia')!;
    const race = new HeadToHead(sim, course);
    expect(race.join(s1)).toBeNull();
    expect(race.join(s2)).toBeNull();
    race.begin(0);
    let tick = 0;
    while (race.stage !== 'results' && tick < (course.bronze + 10) * TICK) {
      sim.update(1 / TICK, new Map([[0, neutralInput()], [s2.id, neutralInput()]]));
      race.update(++tick);
    }
    expect(race.stage).toBe('results');
    expect(tick).toBe(RACE_COUNTDOWN * TICK + Math.floor(course.bronze * TICK) + 1);
    expect(race.results().map((x) => x.status)).toEqual(['timeout', 'timeout']);
    // The signals it held are released.
    race.release();
  });

  it('cannot be joined with the cops on you, nor once it has started', () => {
    const sim = new Sim({ world: new StaticWorld(), ambient: false, police: false, multiplayer: true, seed: 3 });
    const s1 = sim.players[0]!;
    const s2 = sim.addPlayer(s1.character.pos.x + 3, s1.character.pos.z);
    const race = new HeadToHead(sim, streetRunCourses(sim)[0]!);
    s2.wanted.setLevel(2);
    expect(race.join(s2)).toBe('Lose the cops before joining a race.');
    race.join(s1);
    race.begin(0);
    s2.wanted.setLevel(0);
    expect(race.join(s2)).toBe('That race has already started.');
  });
});

describe('single-player places in multiplayer', () => {
  it('the server refuses properties and the export board with a reason; the client marks them and the contacts so', () => {
    const r = room();
    const a = join(r, 1, 'Ann');
    const sim = r.sim;
    const slot = slotOf(r, a);
    const msgs: string[] = [];
    sim.events.on('message', (e) => msgs.push(e.text));
    const at = places(sim.world);
    for (const spot of [at.exportBoard, at.garageMarker, at.arcade]) {
      slot.character.pos.x = spot.x;
      slot.character.pos.z = spot.z;
      sim.interactions.interact(slot);
    }
    expect(msgs).toEqual([MP_NO_EXPORT, MP_NO_PROPERTY, MP_NO_PROPERTY]);
    expect(sim.activities.jobOf(slot)).toBeNull();

    const view = multiplayerInteractions(world());
    const prompt = (x: number, z: number, inCar = false) => {
      const c = { ...slot.character, pos: { x, y: 0, z }, state: inCar ? 'inVehicle' : 'normal', vehicle: inCar ? { pos: { x, y: 0, z } } : null };
      return view.prompt({ character: c, down: false, pos: () => c.pos } as never);
    };
    const poi = (id: string) => world().layout.pois.find((p) => p.id === id)!;
    expect(prompt(poi('safehouse').x, poi('safehouse').z)).toBe(MP_NO_SAVE);
    expect(prompt(at.exportBoard.x, at.exportBoard.z)).toBe(MP_NO_EXPORT);
    expect(prompt(at.garageMarker.x, at.garageMarker.z)).toBe(MP_NO_PROPERTY);
    const gun = world().layout.pois.find((p) => p.kind === 'gunshop')!;
    expect(prompt(gun.x, gun.z)).toBe(MP_NO_SHOP);
    const contacts = view.markers.filter((m) => m.kind === 'mission');
    expect(contacts.map((m) => m.ref).sort()).toEqual(['dex', 'lou']);
    for (const m of contacts) expect(prompt(m.x, m.z)).toBe(MP_NO_STORY);
    // A course start speaks to a car too.
    const c0 = streetRunCourses({ roads: world().roads } as never)[0]!;
    expect(prompt(c0.start.x + 5, c0.start.z, true)).toBe(`Press T to race ${c0.name} head-to-head`);
    expect(prompt(c0.start.x + 40, c0.start.z, true)).toBeNull();
  });
});

describe('the MULTIPLAYER screen', () => {
  it('defaults to the serving game server, else ws://localhost:4210; names are required and trimmed', () => {
    expect(menuServerAddress({ protocol: 'http:', hostname: '192.168.1.5', port: '4210' }, true)).toBe('ws://192.168.1.5:4210');
    expect(menuServerAddress({ protocol: 'http:', hostname: '127.0.0.1', port: '4211' }, false)).toBe('ws://localhost:4210');
    expect(menuServerAddress({ protocol: 'https:', hostname: 'me.github.io', port: '' }, false)).toBe('ws://localhost:4210');
    expect(joinValues({ name: '   ', server: 'x:1', room: 'r' })).toEqual({ error: 'Enter a name to join.', field: 'name' });
    expect(joinValues({ name: 'Ann', server: ' ', room: 'r' })).toMatchObject({ field: 'server' });
    expect(joinValues({ name: `  ${'N'.repeat(40)} `, server: ' 127.0.0.1:4210 ', room: '  ' })).toEqual({ name: 'N'.repeat(24), server: '127.0.0.1:4210', room: 'lobby' });
  });
});

describe('radar blips for other players', () => {
  it('every other player in his colour with his initial, sticky to the rim; none for the local player or in single player', () => {
    const r = room();
    const a = join(r, 1, 'Ann');
    const b = join(r, 2, 'bea');
    steps(r, 6);
    // B's client: a mirror fed what B was sent.
    const m = new Mirror({ world: new StaticWorld() });
    m.applyWelcome(b.peer.last('welcome')!);
    for (const s of b.peer.of('snapshot')) m.applySnapshot(s, 0);
    const blips = otherPlayerBlips(m, 2);
    const A = slotOf(r, a).character;
    expect(blips).toEqual([{ x: expect.closeTo(A.pos.x, 1), z: expect.closeTo(A.pos.z, 1), color: '#' + playerColor(a.m.slot!).toString(16).padStart(6, '0'), label: 'A', sticky: true, shape: 'player' }]);
    expect(otherPlayerBlips(m, 1).map((x) => x.label)).toEqual(['B']);
    expect(collectBlips(m, 0, 2).filter((x) => x.shape === 'player')).toHaveLength(1);
    const sp = new Sim({ world: world(), ambient: false, police: false });
    expect(otherPlayerBlips(sp, 0)).toEqual([]);
  });
});

describe('a busted player in multiplayer', () => {
  it('is arrested and bailed out on his own at the police station; the others play on untouched', () => {
    const r = room();
    const a = join(r, 1, 'Ann');
    const b = join(r, 2, 'Bea');
    const c = join(r, 3, 'Cal');
    steps(r, 3);
    const [sa, sb, sc] = [slotOf(r, a), slotOf(r, b), slotOf(r, c)];
    for (const s of [sa, sb, sc]) s.progress.money = 1000;
    sa.character.inventory.give('smg', 90);
    sb.character.inventory.give('smg', 90);
    sa.wanted.setLevel(3);
    sb.wanted.setLevel(2);
    const bBefore = { x: sb.character.pos.x, z: sb.character.pos.z, wanted: sb.wanted.level, guns: sb.character.inventory.owned().join() };
    r.sim.bustPlayer(sa);
    expect(sa.deathKind).toBe('busted');
    expect(sb.deathKind).toBeNull();
    expect(sc.deathKind).toBeNull();
    let lockedOthers = 0;
    steps(r, 6 * TICK, () => {
      for (const p of [a, b, c]) send(r, p);
      if (sb.controlLock > 0 || sc.controlLock > 0 || sb.down || sc.down) lockedOthers++;
    });
    expect(lockedOthers).toBe(0);
    expect(sa.deathKind).toBeNull();
    const station = r.sim.world.layout.pois.find((p) => p.id === 'police')!;
    expect(Math.hypot(sa.character.pos.x - station.x, sa.character.pos.z - station.z)).toBeLessThan(20);
    // Ann pays 100 + 150 per star and loses her guns (3 stars); nobody else is charged or disarmed.
    expect(sa.progress.money).toBe(1000 - (100 + 150 * 3));
    expect(sa.wanted.level).toBe(0);
    expect(sa.character.inventory.owned()).toEqual(['fists']);
    expect(sb.progress.money).toBe(1000);
    expect(sc.progress.money).toBe(1000);
    expect(sb.wanted.level).toBe(bBefore.wanted);
    expect(sb.character.inventory.owned().join()).toBe(bBefore.guns);
    expect(Math.hypot(sb.character.pos.x - bBefore.x, sb.character.pos.z - bBefore.z)).toBeLessThan(0.5);
    // The room hears of it in the feed; only Ann got the BUSTED banner and the bail message.
    for (const p of [a, b, c]) expect(events(p, FEED_EVENT).map((e) => e.data.text)).toContain('Ann was busted');
    expect(events(a, 'big').some((e) => e.data.style === 'busted')).toBe(true);
    expect(events(a, 'message').some((e) => /^Bail paid: \$/.test(String(e.data.text)))).toBe(true);
    for (const p of [b, c]) {
      expect(events(p, 'big').some((e) => e.data.style === 'busted')).toBe(false);
      expect(events(p, 'message').some((e) => /^Bail paid/.test(String(e.data.text)))).toBe(false);
    }
  });

  it('a racer who is busted is out of the race (DNF) and the other racer carries on', () => {
    const r = room();
    const a = join(r, 1, 'Ann');
    const b = join(r, 2, 'Bea');
    r.command(a.m, 'race', JSON.stringify({ action: 'open', course: 'dockside' }));
    r.command(b.m, 'race', JSON.stringify({ action: 'join' }));
    r.command(a.m, 'race', JSON.stringify({ action: 'start' }));
    const race = r.rules.race!;
    steps(r, RACE_COUNTDOWN * TICK + 2);
    const sa = slotOf(r, a);
    const sb = slotOf(r, b);
    r.sim.bustPlayer(sb);
    steps(r, 3);
    expect(race.racer(sb)).toMatchObject({ status: 'dnf', reason: 'busted' });
    expect(race.racer(sa)!.status).toBe('racing');
    expect(sa.controlLock).toBe(0);
    driveCourse(r, race, sa);
    expect(race.stage).toBe('results');
    steps(r, 3);
    expect(lastState(a).race!.entrants.map((e) => [e.name, e.status, e.reason])).toEqual([['Ann', 'finished', ''], ['Bea', 'dnf', 'busted']]);
  });
});

describe('racers are not car-jacked by angry drivers', () => {
  /** Rams `n` parked civilian cars hard with player `by`, counting the drivers who get out. */
  function hardHits(sim: Sim, by: PlayerSlot, n: number): number {
    sim.streetCrime.angryDrivers = true;
    let out = 0;
    const base = sim.players[0]!.character.pos;
    for (let i = 0; i < n; i++) {
      const v = sim.spawnVehicle('sedan', base.x + 20 + i * 6, base.z + 40, 0);
      v.owner = 'traffic';
      const d = sim.addDriver(v, 'civilian', 'traffic');
      d.owner = 'traffic';
      sim.events.emit('vehicleRammed', { vehicle: v, by: by.character, deltaV: 8 });
      if (sim.angryDrivers.active.some((g) => g.driver === d)) out++;
    }
    return out;
  }

  it('a hard hit brings drivers out for a player in free roam, but not in a single-player Street Run or a head-to-head race', () => {
    const mk = () => new Sim({ world: new StaticWorld(), ambient: false, police: false, multiplayer: true, seed: 5 });
    const free = mk();
    expect(hardHits(free, free.players[0]!, 20)).toBeGreaterThan(0);

    const sim = mk();
    const s1 = sim.players[0]!;
    const course = streetRunCourses(sim).find((c) => c.id === 'magnolia')!;
    const race = new HeadToHead(sim, course);
    race.join(s1);
    race.begin(0);
    expect(s1.racing).toBe(true);
    expect(hardHits(sim, s1, 20)).toBe(0);
    race.leave(s1, 'quit');
    expect(s1.racing).toBe(false);
    expect(hardHits(sim, s1, 20)).toBeGreaterThan(0);

    const solo = new Sim({ world: new StaticWorld(), ambient: false, police: false, seed: 5 });
    const job = { kind: 'streetRun', stage: 'racing' } as never;
    solo.activities.job = job;
    expect(hardHits(solo, solo.players[0]!, 20)).toBe(0);
    (solo.activities.job as { stage: string }).stage = 'approach';
    expect(hardHits(solo, solo.players[0]!, 20)).toBeGreaterThan(0);
  });
});
