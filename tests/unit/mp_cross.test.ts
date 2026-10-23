// Multiplayer cross-area flows at sim level (VAL-MPX-004): systems that used to follow slot 0 only must also work for
// the other players of a room.

import { describe, expect, it } from 'vitest';
import { Room } from '../../server/room';
import { mooredBoats } from '../../src/sim/boats';
import type { Vehicle } from '../../src/sim/entities';
import { makeSim } from './helpers';
import { place, stepSlots } from './mp_helpers';

describe('Marina boats in multiplayer (VAL-MPX-004)', () => {
  it('player 1 alone at the Marina finds both boats moored while player 0 is across town', () => {
    const sim = makeSim({ ambient: true, police: false, multiplayer: true, seed: 5 });
    const poi = sim.world.layout.pois.find((p) => p.kind === 'marina')!;
    const b = sim.addPlayer(poi.x - 6, poi.z);
    const home = sim.world.layout.pois.find((p) => p.id === 'safehouse')!;
    place(sim, sim.players[0]!, home.x, home.z);
    expect(Math.hypot(home.x - poi.x, home.z - poi.z)).toBeGreaterThan(400);
    stepSlots(sim, 1.5);
    const boats = mooredBoats(sim).filter((v): v is Vehicle => !!v);
    expect(boats.map((v) => v.kind).sort()).toEqual(['dinghy', 'speedboat']);
    for (const v of boats) expect(Math.hypot(v.pos.x - b.pos().x, v.pos.z - b.pos().z)).toBeLessThan(60);
  });

  it('with slot 0 parked (its player left), the remaining player at the Marina still gets the boats', () => {
    const sim = makeSim({ ambient: true, police: false, multiplayer: true, seed: 6 });
    const poi = sim.world.layout.pois.find((p) => p.kind === 'marina')!;
    sim.addPlayer(poi.x - 6, poi.z);
    sim.parkPlayer(sim.players[0]!);
    stepSlots(sim, 1.5);
    expect(mooredBoats(sim).filter((v) => !!v).length).toBe(2);
  });
});

describe('room status for cross-area validation (VAL-MPX-001/002/005)', () => {
  const peer = () => ({ send() {}, close() {}, bufferedAmount: 0 });

  it("lists each member's player as the server has him, with his wanted level and the police working for him", () => {
    const room = new Room('st', 7, { realtime: false, dev: true, log: () => {} });
    const a = room.join(1, 'Ann', peer());
    const b = room.join(2, 'Bea', peer());
    if (a === 'full' || b === 'full') throw new Error('room full');
    for (let i = 0; i < 30; i++) room.step();
    room.command(b, 'debug', JSON.stringify({ wanted: 2 }));
    for (let i = 0; i < 60 * 8; i++) room.step();
    const st = room.status();
    const [pa, pb] = st.members.map((m) => m.player!);
    const ca = room.slots.character(a.slot!);
    const cb = room.slots.character(b.slot!);
    expect(pa.x).toBeCloseTo(ca.pos.x, 1);
    expect(pa.z).toBeCloseTo(ca.pos.z, 1);
    expect(pb.x).toBeCloseTo(cb.pos.x, 1);
    expect(pa.wanted).toBe(0);
    expect(pb.wanted).toBe(2);
    expect(pa.police.chasing).toBe(0);
    expect(pb.police.units + pb.police.officers).toBeGreaterThan(0);
    expect(st.hours).toBeCloseTo(room.sim.clock.hours, 2);
    expect(st.weather.kind).toBe(room.sim.weather.state.kind);
    room.close();
  });

  it("the dev 'wreck' command blows up the nearest empty car, and status lists wrecks and broken props", () => {
    const room = new Room('wr', 8, { realtime: false, dev: true, log: () => {} });
    const a = room.join(1, 'Ann', peer());
    if (a === 'full') throw new Error('room full');
    room.step();
    const c = room.slots.character(a.slot!);
    const car = room.sim.spawnVehicle('sedan', c.pos.x + 12, c.pos.z, 0);
    room.command(a, 'debug', JSON.stringify({ wreck: true }));
    room.step();
    expect(car.destroyed).toBe(true);
    expect(room.status().wrecks).toContain(car.id);
    const prop = room.world.grid.colliders.find((k) => k.breakable && !k.broken)!;
    room.sim.events.emit('propBroken', { index: room.world.breakCollider(prop), x: 0, z: 0 } as never);
    expect(room.status().brokenProps.at(-1)).toBe(prop.propIndex);
    room.close();
  });
});
