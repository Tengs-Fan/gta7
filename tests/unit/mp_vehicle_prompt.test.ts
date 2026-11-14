// The prompt for taking a vehicle on a multiplayer client: the mirror, fed by a real server room, offers what the
// room's own single-player Interactions says for the same player in the same place ("Press F to get in the Velora",
// "... to carjack ...", "... to get on ...", "... to board ..."), and nothing where F would pass the vehicle over.

import { describe, expect, it } from 'vitest';
import { Connection } from '../../server/connection';
import { RoomManager } from '../../server/rooms';
import { Mirror } from '../../src/net/mirror';
import { decodeMessage, encodeMessage, PROTOCOL_VERSION, type WelcomeMsg } from '../../src/net/protocol';
import type { Vehicle } from '../../src/sim/entities';
import type { VehicleKind } from '../../src/sim/specs';
import { StaticWorld } from '../../src/world/staticWorld';
import { WATER_Y } from '../../src/world/constants';
import { roadPoint } from './helpers';
import { FakePeer } from './net_helpers';

function join() {
  const mgr = new RoomManager({ emptyRoomTtlMs: 60_000, log: () => {}, room: { realtime: false, log: () => {}, dev: true, sim: { ambient: false, police: false, seed: 9 } } });
  const peer = new FakePeer();
  const conn = new Connection(peer, mgr, { defaultRoom: 'lobby', maxErrors: 32, ratePerSec: 1e6, rateBurst: 1e6, log: () => {}, now: () => performance.now() });
  const mirror = new Mirror({ world: new StaticWorld() });
  let t = 0;
  conn.onMessage(new Uint8Array(encodeMessage({ type: 'hello', version: PROTOCOL_VERSION, name: 'A', room: 'prompt' })), true);
  const room = mgr.room('prompt')!;
  const sim = room.sim;
  const slot = sim.players[0]!;
  /** Ticks the room until the mirror has had a snapshot (and, then, one more, so the state set up before is in it). */
  const sync = (): void => {
    for (let snapshots = 0; snapshots < 2;) {
      room.step();
      for (const bytes of peer.sent.splice(0)) {
        const m = decodeMessage(bytes);
        if (m.type === 'welcome') mirror.applyWelcome(m as WelcomeMsg);
        else if (m.type === 'snapshot') {
          mirror.applySnapshot(m, (t += 40));
          snapshots++;
        }
      }
    }
  };
  sync();
  return { sim, slot, mirror, sync };
}

/** What the room's own game says to its player, and what the client's mirror says to the same player. */
function both(h: ReturnType<typeof join>): { server: string | null; client: string | null } {
  h.sync();
  return { server: h.sim.interactions.prompt(h.slot), client: h.mirror.interactions.prompt(h.mirror.me) };
}

/** A `kind` parked on a road, the player on foot at its driver's door. */
function parkedWithPlayer(h: ReturnType<typeof join>, kind: VehicleKind = 'sedan'): Vehicle {
  const rp = roadPoint(h.sim, 40, 30);
  const v = h.sim.spawnVehicle(kind, rp.x, rp.z, rp.heading);
  v.owner = 'parked';
  const p = h.slot.character;
  p.pos.x = v.pos.x + Math.cos(v.heading) * (v.halfW + 0.8);
  p.pos.z = v.pos.z - Math.sin(v.heading) * (v.halfW + 0.8);
  p.pos.y = h.sim.world.groundHeight(p.pos.x, p.pos.z);
  return v;
}

describe('the vehicle prompt of a multiplayer client', () => {
  it('an empty car is offered with "get in", and nothing once the player is out of reach of it', () => {
    const h = join();
    const v = parkedWithPlayer(h);
    expect(both(h)).toEqual({ server: 'Press F to get in the Velora', client: 'Press F to get in the Velora' });
    h.slot.character.pos.x = v.pos.x + 12;
    h.slot.character.pos.z = v.pos.z + 12;
    expect(both(h)).toEqual({ server: null, client: null });
  });

  it('a car with someone at the wheel is a carjacking, until it is too fast to take', () => {
    const h = join();
    const v = parkedWithPlayer(h);
    h.sim.addDriver(v, 'civilian', 'traffic');
    v.owner = 'traffic';
    v.ai!.hold = true;
    expect(both(h)).toEqual({ server: 'Press F to carjack the Velora', client: 'Press F to carjack the Velora' });
    // Faster than 7 m/s, findEnterable passes it over (the server's car moves on, so each is asked at once).
    v.ai!.hold = false;
    v.vel.x = Math.sin(v.heading) * 9;
    v.vel.z = Math.cos(v.heading) * 9;
    h.sync();
    const p = h.slot.character;
    p.pos.x = v.pos.x + Math.cos(v.heading) * (v.halfW + 0.8);
    p.pos.z = v.pos.z - Math.sin(v.heading) * (v.halfW + 0.8);
    const fast = both(h);
    expect(Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z)).toBeLessThan(4);
    expect(h.sim.playerCtl.findEnterable(p)).toBeNull();
    expect(fast).toEqual({ server: null, client: null });
  });

  it('a bike is something to get on, an empty police vehicle a theft', () => {
    const h = join();
    parkedWithPlayer(h, 'sportbike');
    expect(both(h)).toEqual({ server: 'Press F to get on the Viper 600', client: 'Press F to get on the Viper 600' });
    const g = join();
    parkedWithPlayer(g, 'police').owner = 'police';
    expect(both(g)).toEqual({ server: 'Press F to steal the Patrol Cruiser', client: 'Press F to steal the Patrol Cruiser' });
  });

  it('a boat is boarded from the water, and one with a skipper is a carjacking', () => {
    const h = join();
    const boat = h.sim.spawnVehicle('speedboat', 700, -300, 0);
    boat.pos.y = WATER_Y;
    const p = h.slot.character;
    p.pos.x = boat.pos.x + boat.halfW + 2;
    p.pos.z = boat.pos.z;
    p.pos.y = WATER_Y;
    for (let i = 0; i < 90; i++) h.sim.update(1 / 60, h.sim.lastInput);
    expect(p.state).toBe('swimming');
    expect(both(h)).toEqual({ server: 'Press F to board the Marlin', client: 'Press F to board the Marlin' });
    h.sim.addDriver(boat, 'civilian', 'traffic');
    expect(both(h)).toEqual({ server: 'Press F to carjack the Marlin', client: 'Press F to carjack the Marlin' });
  });

  it('none while the server holds the player\'s controls, nor for a watcher who has none', () => {
    const h = join();
    parkedWithPlayer(h);
    h.slot.controlLock = 5;
    expect(both(h)).toEqual({ server: null, client: null });
    h.slot.controlLock = 0;
    expect(both(h).client).toBe('Press F to get in the Velora');
    h.mirror.me.slot = -1;
    expect(h.mirror.interactions.prompt(h.mirror.me)).toBeNull();
  });

  it('none in a car, nor with a marker under the player, whose reason comes first', () => {
    const h = join();
    const v = parkedWithPlayer(h);
    h.sim.seat(h.slot.character, v, 0);
    expect(both(h)).toEqual({ server: null, client: null });
    // Driving fast changes nothing: the player is in the car, not beside it.
    v.vel.x = Math.sin(v.heading) * 20;
    v.vel.z = Math.cos(v.heading) * 20;
    expect(both(h)).toEqual({ server: null, client: null });
    h.sim.unseat(h.slot.character);
    const save = h.sim.interactions.markers.find((m) => m.kind === 'save')!;
    const car = h.sim.spawnVehicle('sedan', save.x + 2.2, save.z, 0);
    car.owner = 'parked';
    h.slot.character.pos.x = save.x;
    h.slot.character.pos.z = save.z;
    h.slot.character.pos.y = h.sim.world.groundHeight(save.x, save.z);
    const at = both(h);
    expect(h.sim.playerCtl.findEnterable(h.slot.character)).toBe(car);
    expect(at.client).toBe('Saving is off in multiplayer.');
    expect(at.server).toBe(at.client);
  });
});
