// AzuraLink, the monorail along Cortez Canal (src/world/monorail.ts): the train keeps a timetable of sim time alone,
// between its two stations and dwelling at each; the pylons stand in the canal clear of every deck; the stations stand
// on the promenades clear of the footbridges, the pedestrians' paths and every prop; a boat or a swimmer stops at a
// pylon; and the train is heard rising in pitch as it comes and falling as it goes, a station's loudspeaker announcing
// each departure.

import { describe, expect, it } from 'vitest';
import { Glider } from '../../src/audio/mixer';
import { PA_LEAD, TrainVoice, type Hearing } from '../../src/audio/trainVoice';
import { gangAt } from '../../src/sim/gangs';
import { SPEECH } from '../../src/sim/speech';
import { WATER_Y } from '../../src/world/constants';
import { CAR_WIDTH, nextDeparture, runTime, TRAIN_DWELL, TRAIN_LENGTH, TRAIN_SPEED, trainAt, trainPeriod, TOWER_H } from '../../src/world/monorail';
import { rectContains, type Rect } from '../../src/world/layout';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';

const line = () => world().layout.monorail;
const canal = () => world().layout.water.find((w) => w.name === 'Cortez Canal')!.bounds;
/** The decks over the canal: bridges, their footways and the two footbridges. */
const canalDecks = () => world().layout.decks.filter((d) => d.rect.minX < canal().maxX && d.rect.maxX > canal().minX);
const grow = (r: Rect, d: number): Rect => ({ minX: r.minX - d, minZ: r.minZ - d, maxX: r.maxX + d, maxZ: r.maxZ + d });
const overlaps = (a: Rect, b: Rect) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;

describe('AzuraLink: the timetable', () => {
  it('repeats every round, runs between the two stops and never past them', () => {
    const m = line();
    const P = trainPeriod(m);
    expect(P).toBeCloseTo(2 * (TRAIN_DWELL + runTime(m)), 9);
    for (let k = 0; k < (2 * P) / 0.37; k++) {
      // Off the instants it arrives and leaves, where the way it faces turns round.
      const t = 0.5 + k * 0.37;
      const a = trainAt(m, t);
      const b = trainAt(m, t + 3 * P);
      expect(b.z).toBeCloseTo(a.z, 6);
      expect(b.dir).toBe(a.dir);
      expect(a.z).toBeGreaterThanOrEqual(m.z0 - 1e-9);
      expect(a.z).toBeLessThanOrEqual(m.z1 + 1e-9);
      expect(a.speed).toBeLessThanOrEqual(TRAIN_SPEED + 1e-9);
    }
  });

  it('dwells 20 s at each station with its doors open, then eases out to 15 m/s within 30 m', () => {
    const m = line();
    const P = trainPeriod(m);
    let north = 0;
    let south = 0;
    const dt = 0.05;
    for (let t = 0; t < P; t += dt) {
      const s = trainAt(m, t);
      if (s.dwell > 0) {
        expect(s.speed).toBe(0);
        expect(s.z).toBe(s.station === 0 ? m.z0 : m.z1);
        // It leaves the way of the other station.
        expect(s.dir).toBe(s.station === 0 ? 1 : -1);
        if (s.station === 0) north += dt;
        else south += dt;
      } else expect(s.station).toBe(-1);
      // Up to cruising speed by 30 m out, and moving smoothly: no jump from one moment to the next.
      const along = Math.min(s.z - m.z0, m.z1 - s.z);
      if (along >= 30 - 1e-6) expect(s.speed).toBeCloseTo(TRAIN_SPEED, 6);
      expect(Math.abs(trainAt(m, t + dt).z - s.z)).toBeLessThanOrEqual(TRAIN_SPEED * dt + 1e-6);
    }
    expect(north).toBeCloseTo(TRAIN_DWELL, 0);
    expect(south).toBeCloseTo(TRAIN_DWELL, 0);
  });

  it('counts down to the next departure from each station: zero as its doors close, the round after that', () => {
    const m = line();
    const P = trainPeriod(m);
    for (const station of [0, 1]) {
      // A moment before it leaves it still stands there; a moment after it is on its way.
      for (let t = 5; t < 5 + P; t += 1.3) {
        const left = nextDeparture(m, station, t);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left).toBeLessThan(P);
        const before = trainAt(m, t + left - 0.05);
        const after = trainAt(m, t + left + 0.05);
        expect(before.station).toBe(station);
        expect(after.station).toBe(-1);
        expect(after.dir).toBe(station === 0 ? 1 : -1);
      }
    }
    // It arrives a run's time after it leaves.
    const leave = nextDeparture(m, 0, 0);
    expect(trainAt(m, leave + runTime(m) + 0.05).station).toBe(1);
    expect(trainAt(m, leave + runTime(m) - 0.05).station).toBe(-1);
  });
});

describe('AzuraLink: the line', () => {
  it('runs along the middle of Cortez Canal, 9.6 m up, stopping over the ring road at either end', () => {
    const m = line();
    const c = canal();
    const b = world().layout.bounds;
    expect(m.x).toBe((c.minX + c.maxX) / 2);
    expect(m.beamY).toBe(9.6);
    for (const z of [m.z0, m.z1]) {
      // Over the carriageway of the ring road's bridge, the train's end out over the promenade short of the footbridge.
      expect(canalDecks().some((d) => d.y === 0 && rectContains(d.rect, m.x, z))).toBe(true);
      expect(Math.abs(z) + TRAIN_LENGTH / 2).toBeGreaterThan(b.cityMaxZ + 8);
      expect(Math.abs(z) + TRAIN_LENGTH / 2).toBeLessThan(b.landMaxZ - 14);
    }
    // The train fits between the canal's quays.
    expect(m.x - CAR_WIDTH / 2).toBeGreaterThan(c.minX + 10);
    expect(m.x + CAR_WIDTH / 2).toBeLessThan(c.maxX - 10);
  });

  it('stands its pylons in the canal, at most 40 m apart, never on or within 3 m of a deck', () => {
    const W = world();
    const m = line();
    expect(m.pylons.length).toBeGreaterThan(20);
    for (const p of m.pylons) {
      expect(p.x).toBe(m.x);
      expect(W.waterDepth(p.x, p.z), `pylon at z ${p.z}`).toBeGreaterThan(5);
      for (const d of canalDecks()) expect(rectContains(grow(d.rect, 2.9), p.x, p.z), `pylon at z ${p.z} by ${d.name} deck ${d.rect.minZ}..${d.rect.maxZ}`).toBe(false);
    }
    const zs = m.pylons.map((p) => p.z);
    for (let i = 1; i < zs.length; i++) {
      expect(zs[i]!).toBeGreaterThan(zs[i - 1]!);
      expect(zs[i]! - zs[i - 1]!).toBeLessThanOrEqual(40);
    }
    // The beam's ends rest near a pylon.
    expect(zs[0]! - (m.z0 - TRAIN_LENGTH / 2)).toBeLessThan(5);
    expect(m.z1 + TRAIN_LENGTH / 2 - zs[zs.length - 1]!).toBeLessThan(5);
    // Each is solid from below a swimmer's band up to the beam, to boats and swimmers but not to sight.
    const pillars = W.grid.colliders.filter((c) => c.circle && c.cx === m.x);
    expect(pillars.length).toBe(m.pylons.length);
    for (const c of pillars) {
      expect(c.tag).toBe('rock');
      expect(c.r).toBe(0.9);
      expect(c.y0).toBe(WATER_Y - 1.5);
      expect(c.y1).toBe(m.beamY);
    }
  });

  it('puts a station on each promenade, its tower on the bank clear of the footbridges, the walkways and every prop', () => {
    const W = world();
    const L = W.layout;
    const m = line();
    const c = canal();
    expect(m.stations.map((s) => s.name)).toEqual(['Northshore', 'Seaview']);
    const footbridges = canalDecks().filter((d) => d.rect.minZ < L.bounds.cityMinZ - 20 || d.rect.maxZ > L.bounds.cityMaxZ + 20);
    expect(footbridges.length).toBe(2);
    for (const s of m.stations) {
      const t = s.tower;
      // On dry promenade, beside the canal: out of the water, between the coast's edge and the ring road's sidewalk.
      expect(t.maxX < c.minX || t.minX > c.maxX).toBe(true);
      for (const [x, z] of [[t.minX, t.minZ], [t.maxX, t.minZ], [t.minX, t.maxZ], [t.maxX, t.maxZ]] as const) {
        expect(W.waterDepth(x, z)).toBeLessThan(0);
        expect(Math.abs(z)).toBeGreaterThan(L.bounds.cityMaxZ + 4);
        expect(Math.abs(z)).toBeLessThan(L.bounds.landMaxZ);
      }
      // Clear of the footbridges and the walk onto them, and 2 m clear of every other collider: the coast's lamps, trees
      // and benches, the billboards' posts, the buildings.
      for (const f of footbridges) expect(overlaps(grow(t, 3), { ...f.rect, minX: f.rect.minX - 12, maxX: f.rect.maxX + 12 })).toBe(false);
      const own = [t, ...s.platform];
      for (const col of W.grid.colliders) {
        if (own.some((r) => r.minX === col.minX && r.minZ === col.minZ && r.maxX === col.maxX && r.maxZ === col.maxZ)) continue;
        expect(overlaps(grow(t, 2), col), `${s.name} tower by a ${col.tag} at (${col.cx.toFixed(1)}, ${col.cz.toFixed(1)})`).toBe(false);
      }
      expect(L.props.filter((p) => rectContains(grow(t, 2), p.x, p.z))).toEqual([]);
      // No pedestrian path passes within 2 m of it.
      for (const n of W.walk.nodes) {
        for (const e of n.edges) {
          const o = W.walk.nodes[e.to]!;
          for (let k = 0; k <= 20; k++) {
            const x = n.x + ((o.x - n.x) * k) / 20;
            const z = n.z + ((o.z - n.z) * k) / 20;
            expect(rectContains(grow(t, 2), x, z), `${s.name} tower on the walk at (${x.toFixed(1)}, ${z.toFixed(1)})`).toBe(false);
          }
        }
      }
      // Its platform runs beside the train on its side of the beam, the walkway over the water to the tower.
      const [plat, walk] = s.platform as [Rect, Rect];
      expect(s.side * (plat.minX + plat.maxX - 2 * m.x)).toBeGreaterThan(0);
      expect(Math.min(Math.abs(plat.minX - m.x), Math.abs(plat.maxX - m.x))).toBeCloseTo(CAR_WIDTH / 2 + 0.2, 6);
      expect(plat.maxZ - plat.minZ).toBeGreaterThan(TRAIN_LENGTH);
      expect(s.side > 0 ? walk.maxX : walk.minX).toBe(s.side > 0 ? t.minX : t.maxX);
      // The foot of its stairs is free ground off any gang's turf and off the walks, out from the tower's door away from
      // the canal and facing away from it.
      expect(W.isFree(s.foot.x, s.foot.z, 0.6)).toBe(true);
      expect(gangAt(L, s.foot.x, s.foot.z)).toBeNull();
      expect(Math.abs(s.foot.z) - L.bounds.cityMaxZ).toBeGreaterThan(6);
      expect(s.side * (s.foot.x - (t.minX + t.maxX) / 2)).toBeGreaterThan(5);
      expect(Math.sin(s.foot.heading)).toBeCloseTo(s.side, 9);
      // Solid: the tower from the ground up, the platform under its floor.
      const solid = W.grid.colliders.filter((col) => col.tag === 'building' && overlaps(col, grow(t, -0.1)));
      expect(solid.some((col) => col.y0 === 0 && col.y1 === TOWER_H)).toBe(true);
      expect(W.lineOfSight(plat.minX - 2, m.beamY - 0.2, s.z, plat.maxX + 2, m.beamY - 0.2, s.z)).toBe(false);
    }
  });

  it('leaves sight and shots as they were: through the beam and past the pylons', () => {
    const W = world();
    const m = line();
    const z = (m.pylons[6]!.z + m.pylons[7]!.z) / 2;
    expect(W.lineOfSight(m.x - 12, m.beamY - 0.7, z, m.x + 12, m.beamY - 0.7, z)).toBe(true);
    expect(W.lineOfSight(m.x - 12, m.beamY + 1.5, z, m.x + 12, m.beamY + 1.5, z)).toBe(true);
    const p = m.pylons[6]!;
    expect(W.lineOfSight(m.x - 12, 1, p.z, m.x + 12, 1, p.z)).toBe(true);
  });
});

describe('AzuraLink: the pylons in the water', () => {
  /** A pylon in open water with a clear 20 m run north of it. */
  const target = () => line().pylons.find((p, i, all) => i > 0 && p.z - all[i - 1]!.z > 30 && p.z > -440)!;

  it('a boat driven down the canal at one stops against it', () => {
    const p = target();
    const sim = makeSim({ police: false });
    const boat = sim.spawnVehicle('speedboat', p.x, p.z - 18, 0);
    boat.pos.y = WATER_Y;
    placeInCar(sim, boat);
    for (let f = 0; f < 60 * 8; f++) {
      step(sim, 1 / 60, input({ throttle: 1 }));
      expect(boat.pos.z + boat.halfL).toBeLessThan(p.z - 0.9 + 0.2);
    }
    expect(boat.speed).toBeLessThan(1.5);
    expect(boat.inWater).toBe(false);
  });

  it('a swimmer swimming at one bumps into it', () => {
    const p = target();
    const sim = makeSim({ police: false });
    teleport(sim, p.x, p.z - 8);
    step(sim, 8, input({ moveZ: 1, cameraYaw: 0 }));
    const c = sim.player;
    expect(c.state).toBe('swimming');
    expect(c.pos.z).toBeLessThan(p.z - 0.9 - c.radius + 0.05);
    expect(Math.abs(c.pos.x - p.x)).toBeLessThan(0.3);
  });
});

/** Just enough of a Web Audio context for the train's voice: params keep their last target. */
function fakeContext(): BaseAudioContext {
  const param = (value: number) => ({ value, setTargetAtTime(v: number) { this.value = v; return this; } });
  const node = (props: Record<string, unknown>) => ({ connect: (d: unknown) => d, start: () => {}, ...props });
  return {
    createBiquadFilter: () => node({ type: 'lowpass', frequency: param(350), Q: param(1) }),
    createGain: () => node({ gain: param(1) }),
    createBufferSource: () => node({ buffer: null, loop: false, playbackRate: param(1) }),
    createOscillator: () => node({ type: 'sine', frequency: param(440) }),
    createStereoPanner: () => node({ pan: param(0) }),
  } as unknown as BaseAudioContext;
}

describe('AzuraLink: the sound', () => {
  it('comes rumbling over a bridge higher than it goes away, loudest and whooshing as it passes, silent far off', () => {
    const m = line();
    const voice = new TrainVoice(fakeContext(), {} as AudioNode, {} as AudioBuffer, new Glider());
    // A listener on Central Ave's bridge, beside the beam, as the train runs south over it at full speed.
    const ear: Hearing = { x: m.x + 9, y: 2, z: 0, yaw: Math.PI, vx: 0, vz: 0 };
    const leave = nextDeparture(m, 0, 0);
    // Cruising: 30 m out after the 4 s it takes to reach 15 m/s, then 15 m a second.
    const at = (z: number) => leave + 4 + (z - m.z0 - 30) / TRAIN_SPEED;
    const hear = (z: number) => {
      voice.update(m, at(z), ear, 0);
      return { doppler: voice.doppler, ...voice.levels };
    };
    const coming = hear(-80);
    const over = hear(0);
    const going = hear(80);
    expect(trainAt(m, at(0)).z).toBeCloseTo(0, 6);
    expect(coming.doppler).toBeGreaterThan(1.02);
    expect(going.doppler).toBeLessThan(0.98);
    expect(over.doppler).toBeCloseTo(1, 6);
    expect(over.rumble).toBeGreaterThan(coming.rumble * 2);
    expect(over.whoosh).toBeGreaterThan(10 * coming.whoosh);
    expect(over.hiss).toBeGreaterThan(0);
    // Stopped at a station a kilometre away: nothing.
    const far = hear(m.z1);
    expect(far.rumble + far.hiss + far.whoosh + far.whine).toBe(0);
  });

  it("announces each departure once, a few seconds before the doors close, with a line for the train's destination", () => {
    const m = line();
    const voice = new TrainVoice(fakeContext(), {} as AudioNode, {} as AudioBuffer, new Glider());
    const ear: Hearing = { x: 0, y: 2, z: 0, yaw: 0, vx: 0, vz: 0 };
    const calls: Array<[number, number]> = [];
    for (let t = 0; t < trainPeriod(m) * 2; t += 1 / 30) {
      const s = voice.update(m, t, ear, t);
      if (s >= 0) calls.push([s, t]);
    }
    expect(calls.map(([s]) => s)).toEqual([0, 1, 0, 1]);
    for (const [s, t] of calls) expect(nextDeparture(m, s, t)).toBeCloseTo(PA_LEAD, 1);
    for (const st of m.stations) {
      expect(SPEECH.pa[st.name]!.length).toBeGreaterThanOrEqual(2);
      for (const id of SPEECH.pa[st.name]!) expect(SPEECH.clips[id]).toBeGreaterThan(2);
    }
  });
});

