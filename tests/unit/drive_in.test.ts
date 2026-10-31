// The Moonbeam Drive-In (world/country/places.ts, sim/driveIn.ts): tonight's bill on the clock alone and the same on a
// multiplayer client's mirrored clock, its bays empty by day and filled out of view for the show, and the SHHH a horn
// sets off only in the lot while a film runs.

import { describe, expect, it } from 'vitest';
import { Connection, type ConnectionOptions } from '../../server/connection';
import { RoomManager } from '../../server/rooms';
import { Mirror } from '../../src/net/mirror';
import { decodeMessage, encodeMessage, PROTOCOL_VERSION, type SnapshotMsg, type WelcomeMsg } from '../../src/net/protocol';
import { BILL, FILMS, reelAt, showtime, shushes } from '../../src/sim/driveIn';
import { COUNTY_PLOTS } from '../../src/world/country';
import { rectContains } from '../../src/world/layout';
import { StaticWorld } from '../../src/world/staticWorld';
import { FakePeer } from './net_helpers';
import { input, makeSim, placeInCar, step, world } from './helpers';

const W = world();
const d = W.layout.country.places.driveIn;
const plot = COUNTY_PLOTS.find((p) => p.id === 'drivein')!.rect;

describe('Moonbeam Drive-In: the bill', () => {
  it('runs the two films round the intermissions from 19:30 to 00:30 and leaves the screen dark by day', () => {
    for (const r of Object.values(FILMS)) expect(r.length).toBeGreaterThan(0);
    // Each film runs 90 minutes, the intermission 15: one reel ends as the next begins.
    for (let k = 0; k + 1 < BILL.length; k++) {
      const b = BILL[k]!;
      expect(b.at + FILMS[b.reel].reduce((m, s) => m + s.minutes, 0) / 60).toBeCloseTo(BILL[k + 1]!.at, 9);
    }
    expect(reelAt(12)).toBeNull();
    expect(reelAt(18.99)).toBeNull();
    expect(reelAt(19.1)!.reel).toBe('preshow');
    expect(reelAt(19.5)).toEqual({ reel: 'corn', scene: 0, t: 0 });
    expect(reelAt(21.1)!.reel).toBe('intermission');
    expect(reelAt(21.3)!.reel).toBe('scarecrow');
    expect(reelAt(0.25)!.reel).toBe('corn');
    expect(reelAt(0.51)).toBeNull();
    expect(FILMS.corn.some((s) => s.line === "Doctor, the corn... it's moving!")).toBe(true);
    expect(FILMS.corn.some((s) => s.line === "Corn doesn't move, Linda. Corn just grows. Angrily.")).toBe(true);
    // A pure function of the hours: every minute of the night gives the same reel twice.
    for (let h = 0; h < 24; h += 1 / 60) expect(reelAt(h)).toEqual(reelAt(h));
    expect(showtime(18.9)).toBe(false);
    expect(showtime(19)).toBe(true);
    expect(showtime(0.9)).toBe(true);
    expect(showtime(1.1)).toBe(false);
  });

  it('shows a multiplayer client the reel the server shows, from its mirrored clock', () => {
    const mgr = new RoomManager({ emptyRoomTtlMs: 60_000, log: () => {}, room: { realtime: false, log: () => {}, dev: true } });
    const peer = new FakePeer();
    const opts: ConnectionOptions = { defaultRoom: 'lobby', maxErrors: 32, ratePerSec: 1e6, rateBurst: 1e6, log: () => {}, now: () => performance.now() };
    const conn = new Connection(peer, mgr, opts);
    const mirror = new Mirror({ world: new StaticWorld() });
    conn.onMessage(new Uint8Array(encodeMessage({ type: 'hello', version: PROTOCOL_VERSION, name: 'A', room: 'reel' })), true);
    const room = mgr.room('reel')!;
    room.sim.clock.set(20.1);
    let t = 0;
    let seen = 0;
    for (let i = 0; i < 400; i++) {
      room.step();
      for (const bytes of peer.sent.splice(0)) {
        const m = decodeMessage(bytes);
        if (m.type === 'welcome') mirror.applyWelcome(m as WelcomeMsg);
        else if (m.type === 'snapshot') {
          mirror.applySnapshot(m as SnapshotMsg, (t += 40));
          expect(reelAt(mirror.clock.hours)).toEqual(reelAt((m as SnapshotMsg).clock.hours));
          expect(reelAt(mirror.clock.hours)!.reel).toBe('corn');
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(10);
    mgr.closeAll();
  });
});

describe('Moonbeam Drive-In: the lot', () => {
  it('stands its screen, bays, posts and buildings in its plot, the bays in arcs nose to the screen', () => {
    expect(d.bays.end - d.bays.first).toBe(40);
    expect(d.speakers.length).toBe(20);
    expect(d.screen.z1 - d.screen.z0).toBe(30);
    expect(d.screen.y1 - d.screen.y0).toBe(14);
    for (const r of [d.frame, d.booth, d.stand, d.lot]) {
      expect(rectContains(plot, r.minX, r.minZ) && rectContains(plot, r.maxX, r.maxZ), JSON.stringify(r)).toBe(true);
    }
    for (let i = d.bays.first; i < d.bays.end; i++) {
      const b = W.layout.parking[i]!;
      expect(rectContains(d.lot, b.x, b.z)).toBe(true);
      // Facing the middle of the screen's foot.
      const to = Math.atan2(d.screen.x - b.x, (d.screen.z0 + d.screen.z1) / 2 - b.z);
      expect(Math.abs(Math.atan2(Math.sin(to - b.heading), Math.cos(to - b.heading)))).toBeLessThan(0.02);
      expect(W.isFree(b.x, b.z, 1.2)).toBe(true);
    }
  });

  it('stays empty by day and fills for the show, out of the player\'s view', () => {
    const bays = (sim: ReturnType<typeof makeSim>) => sim.vehicles.filter((v) => !v.removed && v.owner === 'parked' && rectContains(d.lot, v.pos.x, v.pos.z, 2));
    // West of the lot by Creek Road, looking north up it: the lot is behind and to his right.
    const watch = (sim: ReturnType<typeof makeSim>) => {
      sim.player.pos.x = -830;
      sim.player.pos.z = 110;
      sim.player.pos.y = 0;
      step(sim, 3, input({ aimOrigin: { x: -830, y: 3, z: 116 }, aimDir: { x: 0, y: 0, z: -1 } }));
    };
    const noon = makeSim({ seed: 3, police: false, ambient: true });
    noon.clock.set(12);
    watch(noon);
    expect(bays(noon)).toHaveLength(0);
    const night = makeSim({ seed: 3, police: false, ambient: true });
    night.clock.set(20);
    watch(night);
    expect(bays(night).length).toBeGreaterThan(20);
  });

  it('shushes a player\'s horn in the lot while a film runs, and no other', () => {
    const lotX = (d.lot.minX + d.lot.maxX) / 2;
    const lotZ = (d.lot.minZ + d.lot.maxZ) / 2;
    expect(shushes(W, 20, lotX, lotZ)).toBe(true);
    expect(shushes(W, 21.1, lotX, lotZ)).toBe(false);
    expect(shushes(W, 12, lotX, lotZ)).toBe(false);
    expect(shushes(W, 20, -840, -268)).toBe(false);
    for (const [hours, x, z, want] of [[20, lotX, lotZ, 1], [12, lotX, lotZ, 0], [20, -830, 60, 0]] as const) {
      const sim = makeSim({ seed: 5, police: false });
      sim.clock.set(hours);
      const car = sim.spawnVehicle('sedan', x, z, -Math.PI / 2);
      placeInCar(sim, car);
      let shh = 0;
      sim.events.on('driveInShush', () => shh++);
      step(sim, 0.1);
      sim.onHorn(car);
      sim.onHorn(car);
      step(sim, 0.1);
      expect(shh, `${hours} h at ${x}, ${z}`).toBe(want);
      // A parked car's horn in the lot is nobody's: no SHHH.
      const empty = sim.spawnVehicle('sedan', lotX + 6, lotZ, -Math.PI / 2);
      step(sim, 5);
      sim.onHorn(empty);
      expect(shh).toBe(want);
    }
  });
});
