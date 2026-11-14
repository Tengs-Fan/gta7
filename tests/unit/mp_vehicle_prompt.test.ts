// The prompt for taking a vehicle on a multiplayer client: a NetClient (mirror and predictor) against a real server
// room offers what the room's own single-player Interactions says for the same player in the same place ("Press F to
// get in the Velora", "... to carjack ...", "... to get on ...", "... to board ..."), and nothing where F would pass
// the vehicle over. The prompt names the vehicle the client's predicted F takes, over the predictor's own copies of the
// vehicles, not the mirror's (which are drawn about 0.1 s in the past).

import { describe, expect, it } from 'vitest';
import type { NetClient } from '../../src/net/client';
import type { Vehicle } from '../../src/sim/entities';
import { neutralInput } from '../../src/sim/input';
import { streetRunCourses } from '../../src/sim/activities/streetRun';
import type { VehicleKind } from '../../src/sim/specs';
import { WATER_Y } from '../../src/world/constants';
import { clientWorld, makeClient, run, testManager, VirtualClock } from './net_client_helpers';
import { roadPoint } from './helpers';

function join(players = 1) {
  const clock = new VirtualClock();
  const mgr = testManager({ dev: true, sim: { ambient: false, police: false, seed: 9 } });
  const world = clientWorld();
  const clients: NetClient[] = [];
  for (let i = 0; i < players; i++) clients.push(makeClient(mgr, clock, { name: `P${i}`, world, predictionWorld: world }));
  const settle = (seconds = 1.2): void => run(mgr, clock, clients, seconds, { input: () => neutralInput() });
  settle(1.5);
  const sim = mgr.room('r')!.sim;
  const client = clients.find((c) => c.mirror.slot === 0)!;
  const slot = sim.players[0]!;
  /** What the room's own game says to player 0, and what his client says, after the client has caught up with the scene. */
  const both = (): { server: string | null; client: string | null } => {
    settle();
    return { server: sim.interactions.prompt(slot), client: client.mirror.interactions.prompt(client.mirror.me) };
  };
  return { sim, slot, client, clients, settle, both, mgr, clock };
}
type Scene = ReturnType<typeof join>;

/** Puts player 0 on foot at the driver's door of `v`. */
function atDoor(h: Scene, v: Vehicle): void {
  const p = h.slot.character;
  p.pos.x = v.pos.x + Math.cos(v.heading) * (v.halfW + 0.8);
  p.pos.z = v.pos.z - Math.sin(v.heading) * (v.halfW + 0.8);
  p.pos.y = h.sim.world.groundHeight(p.pos.x, p.pos.z);
}

/** A `kind` parked on a road, player 0 on foot at its driver's door. */
function parkedWithPlayer(h: Scene, kind: VehicleKind = 'sedan'): Vehicle {
  const rp = roadPoint(h.sim, 40, 30);
  const v = h.sim.spawnVehicle(kind, rp.x, rp.z, rp.heading);
  v.owner = 'parked';
  atDoor(h, v);
  return v;
}

/** The client's own copy of server vehicle `id` in its prediction. */
const proxy = (h: Scene, id: number): Vehicle => h.client.predictor.sim.vehicles.find((v) => v.id === id)!;

const same = (text: string) => ({ server: text, client: text });
const none = { server: null, client: null };

describe('the vehicle prompt of a multiplayer client', () => {
  it('an empty car is offered with "get in", and nothing once the player is out of reach of it', () => {
    const h = join();
    const v = parkedWithPlayer(h);
    expect(h.both()).toEqual(same('Press F to get in the Velora'));
    h.slot.character.pos.x = v.pos.x + 12;
    h.slot.character.pos.z = v.pos.z + 12;
    expect(h.both()).toEqual(none);
  });

  it('a car with someone at the wheel is a carjacking', () => {
    const h = join();
    const v = parkedWithPlayer(h);
    h.sim.addDriver(v, 'civilian', 'traffic');
    v.owner = 'traffic';
    v.ai!.hold = true;
    expect(h.both()).toEqual(same('Press F to carjack the Velora'));
  });

  it('a car moving too fast to take is passed over', () => {
    const h = join();
    const v = parkedWithPlayer(h);
    h.sim.addDriver(v, 'civilian', 'traffic');
    v.owner = 'traffic';
    v.ai!.hold = true;
    expect(h.both()).toEqual(same('Press F to carjack the Velora'));
    // Held in place on the server (so the player stays at the door) but reported at 9 m/s: findEnterable refuses above 7.
    v.vel.x = Math.sin(v.heading) * 9;
    v.vel.z = Math.cos(v.heading) * 9;
    v.speed = 9;
    const fast = h.both();
    expect(h.sim.playerCtl.findEnterable(h.slot.character)).toBeNull();
    expect(fast.client).toBeNull();
  });

  it('a bike is something to get on, an empty police vehicle a theft', () => {
    const h = join();
    parkedWithPlayer(h, 'sportbike');
    expect(h.both()).toEqual(same('Press F to get on the Viper 600'));
    const g = join();
    parkedWithPlayer(g, 'police').owner = 'police';
    expect(g.both()).toEqual(same('Press F to steal the Patrol Cruiser'));
  });

  it('a boat is boarded from the water, and one with a skipper is a carjacking', () => {
    const h = join();
    const boat = h.sim.spawnVehicle('speedboat', 700, -300, 0);
    boat.pos.y = WATER_Y;
    const p = h.slot.character;
    p.pos.x = boat.pos.x + boat.halfW + 2;
    p.pos.z = boat.pos.z;
    p.pos.y = WATER_Y;
    h.settle(2);
    expect(p.state).toBe('swimming');
    expect(h.both()).toEqual(same('Press F to board the Marlin'));
    h.sim.addDriver(boat, 'civilian', 'traffic');
    if (boat.ai) boat.ai.hold = true;
    expect(h.both()).toEqual(same('Press F to carjack the Marlin'));
  });

  it('a car with another player at the wheel is not offered', () => {
    const h = join(2);
    const v = parkedWithPlayer(h);
    const other = h.sim.players[1]!.character;
    other.pos.x = v.pos.x;
    other.pos.z = v.pos.z;
    h.sim.seat(other, v, 0);
    const r = h.both();
    expect(r).toEqual(none);
    expect(v.driver).toBe(other);
  });

  it('none in a car, even at speed', () => {
    const h = join();
    const v = parkedWithPlayer(h);
    h.sim.seat(h.slot.character, v, 0);
    expect(h.both()).toEqual(none);
    v.vel.x = Math.sin(v.heading) * 20;
    v.vel.z = Math.cos(v.heading) * 20;
    h.settle(0.5);
    expect(h.slot.character.state).toBe('inVehicle');
    expect(h.client.mirror.interactions.prompt(h.client.mirror.me)).toBeNull();
  });

  it('none while the server holds the player\'s controls, nor for a watcher who has none', () => {
    const h = join();
    parkedWithPlayer(h);
    h.slot.controlLock = 5;
    expect(h.both()).toEqual(none);
    h.slot.controlLock = 0;
    expect(h.both().client).toBe('Press F to get in the Velora');
    h.client.mirror.me.slot = -1;
    expect(h.client.mirror.interactions.prompt(h.client.mirror.me)).toBeNull();
  });

  it('follows the vehicle the prediction would take, not the one the mirror draws', () => {
    const h = join();
    const v = parkedWithPlayer(h);
    expect(h.both().client).toBe('Press F to get in the Velora');
    const prompt = () => h.client.mirror.interactions.prompt(h.client.mirror.me);
    const mirrored = h.client.mirror.vehicle(v.id)!;
    const copy = proxy(h, v.id);
    expect(copy).toBeDefined();
    // A car creeping away at 6 m/s: the mirror (about 0.1 s behind) still has it at the door, the prediction's copy has
    // moved on past the 2 m reach, where the predicted F would find nothing.
    const at = { x: copy.pos.x, z: copy.pos.z };
    copy.pos.x += 8;
    expect(Math.hypot(mirrored.pos.x - h.client.predictor.char.pos.x, mirrored.pos.z - h.client.predictor.char.pos.z)).toBeLessThan(3);
    expect(h.client.predictor.enterable()).toBeNull();
    expect(prompt()).toBeNull();
    // And the other way round: the mirror's car out of reach, the prediction's at the door.
    copy.pos.x = at.x;
    mirrored.pos.x += 8;
    expect(h.client.predictor.enterable()).toBe(copy);
    expect(prompt()).toBe('Press F to get in the Velora');
    // Above 7 m/s in the prediction's copy: refused, whatever the mirror says.
    copy.vel.x = 6;
    copy.speed = 9;
    expect(prompt()).toBeNull();
  });
});

describe('the vehicle prompt beside a race start', () => {
  const start = (h: Scene) => streetRunCourses(h.sim)[0]!.start;

  it('on foot beside a car within reach of a start it is the car, and the race once he is in one', () => {
    const h = join();
    const s = start(h);
    const v = h.sim.spawnVehicle('sedan', s.x + 6, s.z, 0);
    v.owner = 'parked';
    atDoor(h, v);
    const race = `Press T to race ${streetRunCourses(h.sim)[0]!.name} head-to-head`;
    expect(h.both().client).toBe('Press F to get in the Velora');
    h.sim.seat(h.slot.character, v, 0);
    expect(h.both().client).toBe(race);
  });

  it('on foot with no car by it, the race start is offered', () => {
    const h = join();
    const s = start(h);
    const p = h.slot.character;
    p.pos.x = s.x + 6;
    p.pos.z = s.z;
    p.pos.y = h.sim.world.groundHeight(p.pos.x, p.pos.z);
    expect(h.both().client).toBe(`Press T to race ${streetRunCourses(h.sim)[0]!.name} head-to-head`);
  });
});

describe('a marker comes first', () => {
  it('a marker under the player has its reason before a car beside it', () => {
    const h = join();
    const save = h.sim.interactions.markers.find((m) => m.kind === 'save')!;
    const car = h.sim.spawnVehicle('sedan', save.x + 2.2, save.z, 0);
    car.owner = 'parked';
    h.slot.character.pos.x = save.x;
    h.slot.character.pos.z = save.z;
    h.slot.character.pos.y = h.sim.world.groundHeight(save.x, save.z);
    const at = h.both();
    expect(h.sim.playerCtl.findEnterable(h.slot.character)).toBe(car);
    expect(at.client).toBe('Saving is off in multiplayer.');
    expect(at.server).toBe(at.client);
  });
});
