// Snapshot size, bandwidth and tick cost in a busy scene (VAL-MPNET-008 / -010): four real players (PlayerSlots with
// controllers; slot 0 at 3 stars with a pursuit, a helicopter and gunfire, slots 1-3 walking), ambient traffic and
// pedestrians streamed round every player, 60 s of sim time, each client's snapshots measured as the encoded bytes it is
// sent. Downtown the four stand a block apart; spread out, each is in his own district with his own traffic.

import { describe, expect, it } from 'vitest';
import { encodeMessage, PROTOCOL_VERSION } from '../../src/net/protocol';
import { neutralInput, type PlayerInput } from '../../src/sim/input';
import { Room } from '../../server/room';
import { playerClusters } from '../../src/sim/traffic';
import { FakePeer } from './net_helpers';

const SIM_SECONDS = 60;

function m5(room: Room) {
  return room.members.get(99)!;
}

function stats(a: number[]): { mean: number; p95: number; max: number } {
  const s = [...a].sort((x, y) => x - y);
  return { mean: a.reduce((x, y) => x + y, 0) / a.length, p95: s[Math.ceil(s.length * 0.95) - 1]!, max: s[s.length - 1]! };
}

describe('busy scene budget', () => {
  for (const spread of [false, true]) {
  it(`4 players ${spread ? 'in four districts' : 'downtown'}, 3-star pursuit with a helicopter and gunfire: snapshot bytes, bandwidth and tick cost`, () => {
    const room = new Room('busy', 11, { realtime: false, log: () => {} });
    const sim = room.sim;
    // Downtown: the player at one junction, the other three one block away each. Spread: one in each corner district.
    const spots = spread
      ? [sim.roads.node(4, 4), sim.roads.node(1, 1), sim.roads.node(7, 1), sim.roads.node(1, 7)]
      : [sim.roads.node(4, 4), sim.roads.node(5, 4), sim.roads.node(4, 5), sim.roads.node(5, 5)];
    const place = (i: number) => {
      const c = room.slots.character(i);
      const n = spots[i]!;
      const spot = sim.world.findFreeSpot(n.x + 12, n.z + 12, 0.5, 20)!;
      c.pos.x = spot.x;
      c.pos.z = spot.z;
      c.pos.y = sim.world.groundHeight(spot.x, spot.z);
    };
    const player = sim.player;
    place(0);
    // Traffic and pedestrians stream in round the new spot before anyone joins.
    for (let i = 0; i < 300; i++) room.step();
    const peers = [0, 1, 2, 3].map(() => new FakePeer());
    const members = peers.map((p, i) => {
      const m = room.join(i + 1, `P${i + 1}`, p);
      if (m === 'full') throw new Error('full');
      place(i);
      p.send(room.welcome(m));
      return m;
    });
    expect(sim.players.map((s) => s.id)).toEqual([0, 1, 2, 3]);
    const clusters = playerClusters(sim.activePlayers()).length;
    expect(clusters).toBe(spread ? 4 : clusters);
    for (const s of sim.players) s.cheats.godMode = true;
    player.inventory.give('smg', 9999);
    player.inventory.current = 'smg';
    sim.wanted.setLevel(3);
    const welcomeBytes = peers.map((p) => p.sent[0]!.length);
    let late: { welcome: number; first: number; entities: number } | null = null;
    const latePeer = new FakePeer();

    const inputBytes: number[] = [];
    const tickMs: number[] = [];
    const counts = { cars: 0, chars: 0, police: 0, helis: 0, shots: 0, samples: 0 };
    sim.events.on('weaponFired', () => counts.shots++);
    let seq = 0;
    const ticks = SIM_SECONDS * 60;
    for (let t = 0; t < ticks; t++) {
      seq++;
      for (const [i, m] of members.entries()) {
        const yaw = t / 120 + i;
        const inp: PlayerInput = { ...neutralInput(), moveZ: 1, cameraYaw: yaw, sprint: i > 0 };
        if (i === 0) {
          // Gunfire in bursts, aimed round the player, never stopping to wait for the police.
          const a = t / 40;
          inp.aim = true;
          inp.fire = t % 120 < 80;
          inp.firePressed = t % 120 === 0;
          inp.moveZ = t % 600 < 300 ? 1 : 0;
          inp.aimDir = { x: Math.sin(a), y: -0.05, z: Math.cos(a) };
          inp.aimOrigin = { x: player.pos.x - Math.sin(a) * 3, y: player.pos.y + 2, z: player.pos.z - Math.cos(a) * 3 };
          inp.cameraYaw = a;
        }
        const buf = encodeMessage({ type: 'input', seq, tick: room.tick, input: inp });
        inputBytes.push(buf.byteLength);
        room.input(m, seq, inp, room.tick);
      }
      // Three stars throughout for slot 0 (shooting at the police would raise it), none for the walkers.
      if (sim.wanted.level !== 3) sim.wanted.setLevel(3);
      for (const s of sim.players) if (s.id !== 0 && s.wanted.level > 0) s.wanted.clear();
      const t0 = performance.now();
      room.step();
      tickMs.push(performance.now() - t0);
      // Half-way through, a fifth player joins next to the action: its welcome and first full snapshot.
      if (t === ticks / 2) {
        const m = room.join(99, 'Late', latePeer);
        if (m === 'full') throw new Error('full');
        latePeer.send(room.welcome(m));
      }
      if (!late && latePeer.of('snapshot').length > 0) {
        const s = latePeer.last('snapshot')!;
        late = { welcome: latePeer.sent[0]!.length, first: latePeer.sent[1]!.length, entities: s.vehicles.length + s.characters.length + s.helis.length + s.projectiles.length + s.pickups.length };
        room.leave(m5(room));
      }
      if (t % 60 === 0) {
        counts.samples++;
        counts.cars += sim.vehicles.filter((v) => !v.removed).length;
        counts.chars += sim.characters.filter((c) => !c.removed).length;
        counts.police += sim.vehicles.filter((v) => !v.removed && v.spec.police).length;
        counts.helis += sim.helis.filter((h) => !h.removed).length;
      }
    }
    expect(late).not.toBeNull();
    const status = room.status();
    const decoded = peers.map((p) => p.messages());
    const per = decoded.map((msgs, i) => {
      const snaps = msgs.map((m, k) => ({ m, bytes: peers[i]!.sent[k]!.length })).filter((x) => x.m.type === 'snapshot');
      const sizes = snaps.map((x) => x.bytes);
      const total = peers[i]!.sent.slice(1).reduce((n, b) => n + b.length, 0);
      return { first: sizes[0]!, ...stats(sizes), count: sizes.length, downKBs: total / SIM_SECONDS / 1024, eventKBs: (total - sizes.reduce((a, b) => a + b, 0)) / SIM_SECONDS / 1024 };
    });
    const upKBs = (inputBytes.reduce((a, b) => a + b, 0) / members.length / SIM_SECONDS) / 1024;
    const tick = stats(tickMs);
    const n = counts.samples;
    console.log(`[busy ${spread ? 'spread' : 'downtown'}] ${clusters} player groups; scene (mean over ${SIM_SECONDS} s): ${(counts.cars / n).toFixed(1)} vehicles (${(counts.police / n).toFixed(1)} police), ${(counts.chars / n).toFixed(1)} characters, ${(counts.helis / n).toFixed(2)} helicopters, ${counts.shots} trigger pulls, wanted ${sim.wanted.level}`);
    per.forEach((p, i) => console.log(`[busy ${spread ? 'spread' : 'downtown'}] client ${i + 1}: welcome ${welcomeBytes[i]} B, first (full) snapshot ${p.first} B, all snapshots mean ${p.mean.toFixed(0)} B, p95 ${p.p95} B, max ${p.max} B over ${p.count} snapshots; down ${p.downKBs.toFixed(1)} KB/s (events ${p.eventKBs.toFixed(1)} KB/s)`));
    console.log(`[busy ${spread ? 'spread' : 'downtown'}] late joiner: welcome ${late!.welcome} B, first (full) snapshot ${late!.first} B with ${late!.entities} entities`);
    console.log(`[busy ${spread ? 'spread' : 'downtown'}] up ${upKBs.toFixed(2)} KB/s per client (${inputBytes[0]} B per input at 60 Hz); tick (sim update + snapshots for 4) mean ${tick.mean.toFixed(3)} ms, p95 ${tick.p95.toFixed(3)} ms, max ${tick.max.toFixed(2)} ms`);
    console.log(`[busy ${spread ? 'spread' : 'downtown'}] status: ${JSON.stringify({ players: status.players, tickMs: status.tickMs, snapshotBytes: status.snapshotBytes, entities: status.entities })}`);
    expect(counts.helis / n).toBeGreaterThan(0.5);
    expect(counts.police / n).toBeGreaterThanOrEqual(2);
    expect(counts.shots).toBeGreaterThan(100);
    for (const p of per) {
      expect(p.mean).toBeLessThanOrEqual(3072);
      expect(p.p95).toBeLessThanOrEqual(6144);
      expect(p.first).toBeLessThanOrEqual(16 * 1024);
      expect(p.count).toBeGreaterThanOrEqual(SIM_SECONDS * 20);
      expect(p.downKBs).toBeLessThanOrEqual(100);
    }
    expect(late!.first).toBeLessThanOrEqual(16 * 1024);
    expect(upKBs).toBeLessThanOrEqual(10);
    expect(tick.mean).toBeLessThanOrEqual(5);
    expect(tick.p95).toBeLessThanOrEqual(12);
    // Version 2 added each player's ammo and job HUD (status line, objective markers) to the snapshot head; version 3
    // whether he is down or his controls are locked (in the byte that held the searching flag).
    expect(PROTOCOL_VERSION).toBe(3);
    room.close();
  }, 120_000);
  }
});
