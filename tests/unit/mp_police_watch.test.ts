// What /status says of the police in a room (server/policeWatch.ts): the evidence VAL-MPX-002 reads to tell the chase of
// one player from fire or pursuit aimed at the bystander next to him.

import { describe, expect, it } from 'vitest';
import { Room } from '../../server/room';

const peer = () => ({ send() {}, close() {}, bufferedAmount: 0 });

function twoPlayers(seed: number) {
  const room = new Room('pw', seed, { realtime: false, dev: true, log: () => {}, sim: { ambient: true } });
  const a = room.join(1, 'Ann', peer());
  const b = room.join(2, 'Bea', peer());
  if (a === 'full' || b === 'full') throw new Error('room full');
  for (let i = 0; i < 30; i++) room.step();
  return { room, a, b };
}

describe('police watch in the room status', () => {
  it('counts police rounds whose line passes a player and police damage to him, per player', () => {
    const { room, a, b } = twoPlayers(31);
    const ca = room.slots.character(a.slot!);
    const cb = room.slots.character(b.slot!);
    room.command(b, 'debug', JSON.stringify({ teleport: [ca.pos.x, ca.pos.z + 12] }));
    room.step();
    const cop = room.sim.spawnCharacter('cop', ca.pos.x - 15, ca.pos.z);
    const at = (c: typeof ca) => ({ x: cop.pos.x, y: cop.pos.y + 1.4, z: cop.pos.z, dx: c.pos.x - cop.pos.x, dy: 0, dz: c.pos.z - cop.pos.z });
    const fire = (aim: ReturnType<typeof at>, shooter: typeof cop | null) => room.sim.events.emit('weaponFired', { shooter, weapon: 'pistol', pellets: 1, ...aim } as never);
    fire({ ...at(ca), dy: ca.pos.y + 1 - (cop.pos.y + 1.4) }, cop);
    fire({ ...at(ca), dy: ca.pos.y + 1 - (cop.pos.y + 1.4) }, cop);
    // A civilian's round along the same line is not the police's.
    fire(at(ca), null);
    // A round aimed 6 m wide of both of them passes neither.
    fire({ ...at(ca), dz: at(ca).dz + 6 }, cop);
    room.sim.events.emit('damage', { victim: cb, attacker: cop, healthLoss: 7, armourLoss: 0, kind: 'bullet', zone: 'torso', killed: false, dirX: 0, dirZ: 0 } as never);
    const [pa, pb] = room.status().members.map((m) => m.player!);
    expect(pa.police.shotsAt).toBe(2);
    expect(pa.police.hits).toBe(0);
    expect(pb.police.hits).toBe(1);
    expect(pb.police.healthLost).toBe(7);
    expect(pb.police.shotsAt).toBe(0);
    room.close();
  });

  it("lists every police unit with the player it works for and the one it targets: only the wanted player's pursuit is active", () => {
    const { room, a } = twoPlayers(32);
    room.command(a, 'debug', JSON.stringify({ wanted: 2 }));
    // Until a unit has him in its sights (the status is under test here, not how fast the police find him).
    for (let i = 0; i < 60 * 60 && !room.status().policeUnits.some((u) => u.target === 'Ann'); i++) room.step();
    const st = room.status();
    expect(st.policeUnits.length).toBeGreaterThan(0);
    const active = st.policeUnits.filter((u) => u.active);
    expect(active.length).toBeGreaterThan(0);
    expect(active.every((u) => u.works === 'Ann')).toBe(true);
    expect(st.policeUnits.some((u) => u.target === 'Ann')).toBe(true);
    expect(st.policeUnits.every((u) => u.target !== 'Bea')).toBe(true);
    expect(st.members.find((m) => m.name === 'Bea')!.player!.police.chasing).toBe(0);
    room.close();
  });

  it("the dev 'civilians' command stands idle civilians at the given spots", () => {
    const { room, a } = twoPlayers(33);
    const c = room.slots.character(a.slot!);
    const before = room.sim.characters.filter((x) => x.role === 'civilian' && !x.removed).length;
    room.command(a, 'debug', JSON.stringify({ civilians: [[c.pos.x + 5, c.pos.z], [c.pos.x + 7, c.pos.z]] }));
    const after = room.sim.characters.filter((x) => x.role === 'civilian' && !x.removed);
    expect(after.length).toBe(before + 2);
    for (let i = 0; i < 120; i++) room.step();
    const placed = after.filter((x) => Math.abs(x.pos.z - c.pos.z) < 3 && x.pos.x - c.pos.x > 3 && x.pos.x - c.pos.x < 9);
    expect(placed.length).toBeGreaterThanOrEqual(1);
    room.close();
  });
});
