// The attractions pass (src/world/attractions.ts): Hollister Farm and Eternal Palms Cemetery rebuilt on their cells, the
// corn maze, the cover rule, the barn, the pumpkins and the epitaphs (src/sim/farm.ts, src/sim/epitaphs.ts).

import { describe, expect, it } from 'vitest';
import { bellTolls, whisperDue } from '../../src/audio/ambience';
import { dressingItems, garageSpecs } from '../../src/render/dressing';
import { completionRows } from '../../src/sim/completion';
import { EPITAPHS, epitaphsRead } from '../../src/sim/epitaphs';
import { farmState, hollister, HOLLISTER_FAR, HOLLISTER_NEAR, PUMPKIN_COUNT, PUMPKIN_REWARD } from '../../src/sim/farm';
import { Character, Helicopter } from '../../src/sim/entities';
import { applyExt, parseExt, serializeExt } from '../../src/sim/saveExt';
import type { Sim } from '../../src/sim/sim';
import { attractionOf, SPOT_CLEAR, type MazeHalf } from '../../src/world/attractions';
import { rectContains, rectCX, rectCZ } from '../../src/world/layout';
import { rampHeight, type StaticWorld } from '../../src/world/staticWorld';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';

const farmOf = (W: StaticWorld) => attractionOf(W.layout, 'farm');
const cemeteryOf = (W: StaticWorld) => attractionOf(W.layout, 'cemetery');

/** The collider of prop `i`. */
const colliderOf = (W: StaticWorld, i: number) => W.grid.colliders[W.propColliders[i]!]!;

/** Whether a maze edge (from cell (c, r) through `side`) has standing corn on it. */
function walled(W: StaticWorld, m: MazeHalf, c: number, r: number, side: 'N' | 'E' | 'S' | 'W'): boolean {
  const x0 = m.rect.minX + c * m.cell;
  const z0 = m.rect.minZ + r * m.cell;
  const [ax, az, bx, bz] = side === 'N' ? [x0, z0, x0 + m.cell, z0] : side === 'S' ? [x0, z0 + m.cell, x0 + m.cell, z0 + m.cell] : side === 'W' ? [x0, z0, x0, z0 + m.cell] : [x0 + m.cell, z0, x0 + m.cell, z0 + m.cell];
  return W.layout.props.some((p, i) => p.kind === 'corn' && !colliderOf(W, i).broken && p.x >= Math.min(ax, bx) - 0.1 && p.x <= Math.max(ax, bx) + 0.1 && p.z >= Math.min(az, bz) - 0.1 && p.z <= Math.max(az, bz) + 0.1);
}

/** The cells reachable from (c, r) between the standing corn. */
function reach(W: StaticWorld, m: MazeHalf, c0: number, r0: number): Set<number> {
  const seen = new Set([r0 * m.cols + c0]);
  const todo = [[c0, r0] as const];
  while (todo.length > 0) {
    const [c, r] = todo.pop()!;
    for (const [dc, dr, side] of [[0, -1, 'N'], [1, 0, 'E'], [0, 1, 'S'], [-1, 0, 'W']] as const) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nc >= m.cols || nr < 0 || nr >= m.rows || seen.has(nr * m.cols + nc) || walled(W, m, c, r, side)) continue;
      seen.add(nr * m.cols + nc);
      todo.push([nc, nr]);
    }
  }
  return seen;
}

/** A sedan with the player in it at (x, z), heading `heading` at `speed` m/s. */
function drive(sim: Sim, x: number, z: number, heading: number, speed: number) {
  const v = sim.spawnVehicle('sedan', x, z, heading);
  placeInCar(sim, v);
  v.vel.x = Math.sin(heading) * speed;
  v.vel.z = Math.cos(heading) * speed;
  return v;
}

describe('the attractions pass', () => {
  it('names the two cells after their places', () => {
    const W = world();
    for (const [a, name] of [[farmOf(W), 'Hollister Farm'], [cemeteryOf(W), 'Eternal Palms Cemetery']] as const) {
      expect(a.name).toBe(name);
      expect(W.zoneName(rectCX(a.rect), rectCZ(a.rect))).toBe(name);
    }
  });

  it('keeps every open spot of the two cells, free: no collider within a metre, none on a ramp', () => {
    const W = world();
    let n = 0;
    for (const a of [farmOf(W), cemeteryOf(W)]) {
      for (const s of W.layout.openSpots.filter((q) => rectContains(a.rect, q.x, q.z))) {
        n++;
        expect(W.isFree(s.x, s.z, SPOT_CLEAR), `${a.id} spot ${s.x},${s.z}`).toBe(true);
        for (const r of W.layout.ramps) expect(rampHeight(r, s.x, s.z), `${a.id} spot ${s.x},${s.z} on ramp ${r.id}`).toBe(0);
      }
    }
    // The farm's eight and the cemetery's fifteen, as the houses left them.
    expect(n).toBe(23);
  });

  it("puts no package or pickup under a ramp's flight, where two of the farm lane's spots lie", () => {
    // The lane's spots are 18 to 24 m apart and a car lands 12 to 25 m past the kicker's lip, so on the lane it could
    // stand nowhere without one under its flight (docs/map.md). Nothing is placed on them; a reshuffle of the pickups
    // (a spot added or dropped anywhere in the city) that put something there fails here.
    const sim = makeSim({ police: false });
    const W = sim.world;
    const under = W.layout.openSpots.filter((s) => W.layout.ramps.some((r) => {
      const along = (s.x - r.x) * Math.sin(r.heading) + (s.z - r.z) * Math.cos(r.heading);
      const side = Math.abs((s.x - r.x) * Math.cos(r.heading) - (s.z - r.z) * Math.sin(r.heading));
      return side < r.width / 2 + 1 && along > r.length / 2 && along < r.length / 2 + 35;
    }));
    expect(under.length).toBe(2);
    for (const s of under) {
      expect(rectContains(farmOf(W).rect, s.x, s.z)).toBe(true);
      expect(sim.pickups.filter((p) => Math.hypot(p.pos.x - s.x, p.pos.z - s.z) < 0.5), `spot ${s.x},${s.z}`).toEqual([]);
    }
  });

  it("adds the farm's hay-bale kicker as the sixth stunt jump", () => {
    const sim = makeSim();
    const farm = farmOf(sim.world);
    expect(farm.anchors.ramp).toBe(5);
    expect(sim.world.layout.ramps[5]!.id).toBe(5);
    expect(sim.world.layout.ramps.length).toBe(6);
    const row = completionRows(sim, sim.players[0]!).find((r) => r.id === 'stunts')!;
    expect(row.total).toBe(6);
  });

  it('lets a car out of the barn, through its door onto the lane and down it to Hillcrest Rd', () => {
    const W = world();
    const farm = farmOf(W);
    const b = farm.anchors.barn;
    const lane = farm.anchors.lane;
    const z = rectCZ(b);
    for (let x = rectCX(b); x > rectCX(lane); x -= 1) expect(W.isFree(x, z, 1.4), `barn door at ${x}`).toBe(true);
    for (let zz = z; zz < lane.maxZ + 10; zz += 1) expect(W.isFree(rectCX(lane), zz, 1.4), `lane at ${zz}`).toBe(true);
    expect(W.isOnRoad(rectCX(lane), lane.maxZ + 8)).toBe(true);
  });

  it('keeps a garage\'s benches, tyres and posters out of the barn', () => {
    const W = world();
    const b = farmOf(W).anchors.barn;
    expect(garageSpecs(W).map((g) => g.name)).not.toContain('farm_barn');
    expect(dressingItems(W).filter((it) => rectContains(b, it.x, it.z))).toEqual([]);
  });
});

describe('the corn maze', () => {
  it('is one maze in each half, every cell reached from either of its entrances', () => {
    const W = world();
    for (const m of farmOf(W).anchors.mazes) {
      expect(m.entrances.length).toBe(2);
      for (const e of m.entrances) {
        expect(walled(W, m, e.col, e.row, e.side), `entrance ${JSON.stringify(e)}`).toBe(false);
        expect(reach(W, m, e.col, e.row).size).toBe(m.cols * m.rows);
      }
    }
    const corn = W.layout.props.filter((p) => p.kind === 'corn').length;
    expect(corn).toBeGreaterThan(180);
    expect(corn).toBeLessThan(260);
  });

  it('falls flat, rustling, under a car coasting across a half from 20 m/s, which comes out at more than 12 m/s', () => {
    const sim = makeSim({ police: false });
    const m = farmOf(sim.world).anchors.mazes[0]!;
    // West to east across every wall of the west half, a metre off a row's middle (so through one segment of each wall)
    // and along a row with no pumpkin in its dead ends.
    const pumpkins = farmOf(sim.world).anchors.pumpkins.map((i) => sim.world.layout.props[i]!);
    const z = Array.from({ length: m.rows }, (_, r) => m.rect.minZ + (r + 0.5) * m.cell + 1).find((zz) => !pumpkins.some((p) => Math.abs(p.z - zz) < 2 && p.x < m.rect.maxX + 2))!;
    const v = drive(sim, m.rect.minX - 8, z, Math.PI / 2, 20);
    let broken = 0;
    let impacts = 0;
    sim.events.on('propBroken', (e) => sim.world.layout.props[e.index]!.kind === 'corn' && broken++);
    sim.events.on('impact', (e) => e.vehicle === v && impacts++);
    let speed = 0;
    step(sim, 3, () => {
      if (speed === 0 && v.pos.x > m.rect.maxX + 0.5) speed = v.speed;
      return input();
    });
    expect(broken).toBeGreaterThanOrEqual(4);
    expect(impacts).toBe(0);
    expect(speed).toBeGreaterThan(12);
  });

  it('hides a player from officers 20 m away and from a daytime helicopter 40 m off; close by they see him', () => {
    const sim = makeSim({ police: false });
    sim.clock.set(12);
    const m = farmOf(sim.world).anchors.mazes[0]!;
    const x = m.rect.minX + 2.5 * m.cell;
    const z = m.rect.minZ + 4.5 * m.cell;
    teleport(sim, x, z);
    expect(sim.world.coverAt(x, z)).toBe(true);
    const cop = sim.spawnCharacter('cop', x, z - 20);
    // The corn hides nothing from a line of sight: the cover rule does.
    expect(sim.world.lineOfSight(cop.pos.x, cop.pos.y + 1.6, cop.pos.z, x, 1.35, z)).toBe(true);
    expect(sim.wanted.copWitness(x, z, 80, 0)).toBe(false);
    cop.pos.z = z - 8;
    expect(sim.wanted.copWitness(x, z, 80, 0)).toBe(true);
    sim.removeCharacter(cop);
    const h = new Helicopter(sim.newId(), x + 40, 40, z);
    sim.helis.push(h);
    expect(sim.wanted.heliSees(h, x, z)).toBe(false);
    h.pos.x = x + 10;
    expect(sim.wanted.heliSees(h, x, z)).toBe(true);
    // Out of the corn, 40 m off, he is seen.
    const out = { x: m.rect.minX - 3, z };
    expect(sim.world.coverAt(out.x, out.z)).toBe(false);
    h.pos.x = out.x - 40;
    expect(sim.wanted.heliSees(h, out.x, out.z)).toBe(true);
  });

  it('hides a car in the barn from a helicopter overhead', () => {
    const sim = makeSim({ police: false });
    sim.clock.set(12);
    const b = farmOf(sim.world).anchors.barn;
    const x = rectCX(b) + 2;
    const z = rectCZ(b);
    const h = new Helicopter(sim.newId(), x, 45, z + 3);
    sim.helis.push(h);
    expect(sim.wanted.heliSees(h, x, z)).toBe(false);
    // Out in the barnyard he would be seen.
    expect(sim.wanted.heliSees(h, b.maxX + 4, z)).toBe(true);
  });
});

describe('the pumpkins', () => {
  /** Breaks every pumpkin under a car's bumper, as a car driving through them does. */
  function smashAll(sim: Sim): void {
    const v = sim.spawnVehicle('sedan', 0, 0, 0);
    v.vel.x = 10;
    v.speed = 10;
    for (const i of farmOf(sim.world).anchors.pumpkins) sim.onPropBroken(colliderOf(sim.world, i), v);
  }

  it('are forty, and smashing them all pays once and survives a save and a load', () => {
    const sim = makeSim({ police: false });
    teleport(sim, 0, 0);
    step(sim, 0.1);
    expect(farmOf(sim.world).anchors.pumpkins.length).toBe(PUMPKIN_COUNT);
    const bigs: string[] = [];
    sim.events.on('big', (e) => bigs.push(e.text));
    const money = sim.progress.money;
    smashAll(sim);
    expect(farmState(sim.progress).smashed.size).toBe(PUMPKIN_COUNT);
    expect(sim.progress.money).toBe(money + PUMPKIN_REWARD);
    expect(bigs[0]).toBe('PUMPKIN SMASH 1/40');
    expect(bigs[bigs.length - 1]).toBe('PUMPKIN SMASH 40/40');
    // Stood up again (a new game does that) and smashed again: no second payment.
    sim.world.resetBroken();
    smashAll(sim);
    expect(sim.progress.money).toBe(money + PUMPKIN_REWARD);
    const row = completionRows(sim, sim.players[0]!).find((r) => r.id === 'pumpkins')!;
    expect([row.done, row.total]).toEqual([40, 40]);

    const saved = JSON.parse(JSON.stringify(serializeExt(sim)));
    const next = makeSim({ police: false });
    applyExt(next, parseExt(saved));
    expect(farmState(next.progress).smashed.size).toBe(PUMPKIN_COUNT);
    expect(farmState(next.progress).paid).toBe(true);
    teleport(next, 0, 0);
    step(next, 0.1);
    const before = next.progress.money;
    smashAll(next);
    expect(next.progress.money).toBe(before);
  });

  it('counts a smash only once, and a part set survives a save', () => {
    const sim = makeSim({ police: false });
    step(sim, 0.1);
    const v = sim.spawnVehicle('sedan', 0, 0, 0);
    const [a, b] = farmOf(sim.world).anchors.pumpkins;
    sim.onPropBroken(colliderOf(sim.world, a!), v);
    sim.onPropBroken(colliderOf(sim.world, a!), v);
    sim.onPropBroken(colliderOf(sim.world, b!), v);
    expect([...farmState(sim.progress).smashed]).toEqual([0, 1]);
    const next = makeSim({ police: false });
    applyExt(next, parseExt(JSON.parse(JSON.stringify(serializeExt(sim)))));
    expect([...farmState(next.progress).smashed]).toEqual([0, 1]);
    expect(farmState(next.progress).paid).toBe(false);
  });
});

describe('Old Man Hollister', () => {
  it('is out on his porch only while the player is near the farm', () => {
    // A sim with ambient life, as the game's and the server's are (the people it streams in are civilians).
    const sim = makeSim({ police: false, ambient: true });
    const porch = farmOf(sim.world).anchors.porch;
    const mission = () => sim.characters.filter((c) => c.role === 'mission' && !c.removed);
    teleport(sim, porch.x + HOLLISTER_NEAR + 30, porch.z);
    step(sim, 0.5);
    expect(hollister(sim)).toBeNull();
    expect(mission()).toEqual([]);
    teleport(sim, porch.x + 20, porch.z);
    step(sim, 0.5);
    const h = hollister(sim)!;
    expect(h).not.toBeNull();
    expect(mission()).toEqual([h]);
    expect(Math.hypot(h.pos.x - porch.x, h.pos.z - porch.z)).toBeLessThan(0.5);
    step(sim, 3);
    expect(Math.hypot(h.pos.x - porch.x, h.pos.z - porch.z)).toBeLessThan(0.5);
    teleport(sim, porch.x + HOLLISTER_FAR + 10, porch.z);
    step(sim, 0.5);
    expect(hollister(sim)).toBeNull();
    expect(h.removed).toBe(true);
  });

  it('stays in a sim without ambient life, as a multiplayer client\'s predictor is', () => {
    const sim = makeSim({ police: false });
    const porch = farmOf(sim.world).anchors.porch;
    const before = sim.characters.length;
    teleport(sim, porch.x + 20, porch.z);
    step(sim, 0.5);
    expect(hollister(sim)).toBeNull();
    expect(sim.characters.length).toBe(before);
  });

  it('is found by the audio among a view\'s characters, as a multiplayer client\'s mirror holds them', () => {
    const sim = makeSim({ police: false, ambient: true });
    const porch = farmOf(sim.world).anchors.porch;
    teleport(sim, porch.x + 20, porch.z);
    step(sim, 0.5);
    const h = hollister(sim)!;
    // The mirror's own characters, made from the snapshot's id, role, position and look (net/mirror.ts).
    const copies = sim.characters.filter((c) => !c.removed).map((c) => new Character(c.id, c.role, c.pos.x, c.pos.y, c.pos.z, { ...c.appearance }));
    expect(hollister({ world: sim.world, characters: copies })?.id).toBe(h.id);
    expect(hollister({ world: sim.world, characters: copies.filter((c) => c.id !== h.id) })).toBeNull();
  });
});

describe('the cemetery', () => {
  it('has about 140 headstones in rows, twelve of them epitaph stones that no car topples', () => {
    const W = world();
    const c = cemeteryOf(W);
    const stones = W.layout.props.map((p, i) => [p, i] as const).filter(([p]) => p.kind === 'headstone');
    expect(stones.length).toBe(140);
    expect(c.anchors.epitaphs.length).toBe(EPITAPHS.length);
    const epitaph = new Set(c.anchors.epitaphs.map((e) => e.prop));
    for (const [, i] of stones) expect(colliderOf(W, i).breakable, `stone ${i}`).toBe(!epitaph.has(i));
  });

  it('a car topples an ordinary stone, not an epitaph stone, and toppling one is no crime', () => {
    const sim = makeSim();
    sim.clock.set(12);
    const c = cemeteryOf(sim.world);
    const e = sim.world.layout.props[c.anchors.epitaphs[0]!.prop]!;
    const epitaph = new Set(c.anchors.epitaphs.map((q) => q.prop));
    const plain = sim.world.layout.props.findIndex((p, i) => p.kind === 'headstone' && !epitaph.has(i));
    const s = sim.world.layout.props[plain]!;
    sim.spawnCharacter('cop', s.x + 6, s.z - 3);
    for (const [p, i] of [[s, plain], [e, c.anchors.epitaphs[0]!.prop]] as const) {
      const v = drive(sim, p.x, p.z - 8, 0, 12);
      step(sim, 1.2);
      expect(colliderOf(sim.world, i).broken, `stone ${i}`).toBe(i === plain);
      sim.removeVehicle(v);
    }
    expect(sim.wanted.level).toBe(0);
  });

  it('E at an epitaph stone shows its line, counts it once and keeps it through a save', () => {
    const sim = makeSim({ police: false });
    const c = cemeteryOf(sim.world);
    const bigs: Array<{ text: string; sub: string }> = [];
    sim.events.on('big', (e) => bigs.push(e));
    const k = 3;
    const at = c.anchors.epitaphs[k]!;
    teleport(sim, at.x, at.z);
    step(sim, 0.1);
    expect(sim.interactions.prompt()).toBe('Press E to read');
    sim.update(1 / 60, input({ interact: true }));
    expect(bigs[0]).toEqual(expect.objectContaining({ text: EPITAPHS[k], sub: `EPITAPHS 1/${EPITAPHS.length}` }));
    expect([...epitaphsRead(sim.progress)]).toEqual([k]);
    expect(sim.interactions.markers.find((m) => m.ref === String(k) && m.kind === 'epitaph')!.id).toBe(`epitaph:${k}:read`);
    step(sim, 0.2);
    sim.update(1 / 60, input({ interact: true }));
    expect(bigs[1]).toEqual(expect.objectContaining({ text: EPITAPHS[k], sub: '' }));
    expect(epitaphsRead(sim.progress).size).toBe(1);
    const row = completionRows(sim, sim.players[0]!).find((r) => r.id === 'epitaphs')!;
    expect([row.done, row.total]).toEqual([1, 12]);

    const next = makeSim({ police: false });
    applyExt(next, parseExt(JSON.parse(JSON.stringify(serializeExt(sim)))));
    expect([...epitaphsRead(next.progress)]).toEqual([k]);
    expect(next.interactions.markers.find((m) => m.ref === String(k) && m.kind === 'epitaph')!.id).toBe(`epitaph:${k}:read`);
  });
});

describe('the cemetery after dark and at noon', () => {
  it('tolls the bell when the clock runs past noon or midnight, not on a jump of the clock', () => {
    expect(bellTolls(11.99, 12.01)).toBe(true);
    expect(bellTolls(23.995, 0.002)).toBe(true);
    expect(bellTolls(12.01, 12.03)).toBe(false);
    expect(bellTolls(5, 5.02)).toBe(false);
    // A new game, a load or a cheat setting the clock.
    expect(bellTolls(15.5, 12)).toBe(false);
    expect(bellTolls(23, 3)).toBe(false);
    expect(bellTolls(NaN, 12)).toBe(false);
  });

  it('whispers by the Bramble crypt between 03:00 and 03:15, within 6 m', () => {
    const crypt = cemeteryOf(world()).anchors.mausoleums.find((m) => m.family === 'BRAMBLE')!;
    const door = cemeteryOf(world()).anchors.crypt;
    expect(Math.abs(door.x - rectCX(crypt.rect))).toBeLessThan(0.01);
    expect(whisperDue(3.1, 4)).toBe(true);
    expect(whisperDue(2.95, 4)).toBe(false);
    expect(whisperDue(3.3, 4)).toBe(false);
    expect(whisperDue(3.1, 7)).toBe(false);
  });
});
