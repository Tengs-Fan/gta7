// Round 2 fix pass 4, police cluster: cars free to leave the side of a deck, a bus that backs out of the surf, officers
// who keep to the pier, police lights that last as long as the stars, peds who run along the wet sand, and one measure of
// night for the helicopter's crew and its beam (each test fails on the code before its fix).
//
// The render modules run headless here (for the beam), as in fix_render.test.ts: a canvas/document stub feeds the
// procedural textures and a fake WebGLRenderer stands in for WebGL.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GameRenderer } from '../../src/render/renderer';
import { makeBrain } from '../../src/sim/brains';
import { darkness } from '../../src/sim/clock';
import { Helicopter, type Character, type Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { HELI_NIGHT_SIGHT, HELI_SIGHT, SPOT_SEE } from '../../src/sim/wanted';
import { WATER_Y } from '../../src/world/constants';
import type { Deck } from '../../src/world/layout';
import { at, internals, longestLane, officer, placeOnFoot } from './r2_police_helpers';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  const ctx2d = (): unknown => {
    const store: Record<string | symbol, unknown> = {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      measureText: () => ({ width: 100 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
    return new Proxy(store, {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: (o, k, v) => {
        o[k] = v;
        return true;
      },
    });
  };
  const canvas = (): Record<string, unknown> => ({
    width: 300,
    height: 150,
    clientWidth: 1280,
    clientHeight: 720,
    style: {},
    getContext: (kind: string) => (kind === '2d' ? ctx2d() : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    readonly domElement: unknown;
    readonly info = { autoReset: true, reset: () => {}, render: { calls: 0, triangles: 0 }, programs: [] as unknown[], memory: { geometries: 0, textures: 0 } };
    readonly shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas;
    }
    setPixelRatio(): void {}
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    setEffects(): void {}
    compile(): void {}
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const DT = 1 / 60;

function deck(name: string, wide = true): Deck {
  return world().layout.decks.find((d) => d.name === name && (d.rect.maxX - d.rect.minX > 6) === wide)!;
}

/** The corners of a vehicle's body, the middles of its ends and sides, and its centre. */
function bodyPoints(v: Vehicle): { x: number; z: number }[] {
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  const pts: { x: number; z: number }[] = [];
  for (const a of [1, 0, -1]) {
    for (const b of [1, 0, -1]) pts.push({ x: v.pos.x + fx * a * v.halfL - fz * b * v.halfW, z: v.pos.z + fz * a * v.halfL + fx * b * v.halfW });
  }
  return pts;
}

const inRect = (d: Deck, p: { x: number; z: number }) => p.x >= d.rect.minX && p.x <= d.rect.maxX && p.z >= d.rect.minZ && p.z <= d.rect.maxZ;

/**
 * Steps `sim` for `secs` with input `inp`, watching `v` for climbing onto deck `d` where its side is a step face: a rise
 * of more than 0.3 m in a frame, or its centre on the deck where the sand is more than 0.45 m below it (the boardwalk end,
 * 0.3 m below, is driven onto).
 */
function climbs(sim: Sim, v: Vehicle, d: Deck, secs: number, inp: Parameters<typeof input>[0]): boolean {
  let last = v.pos.y;
  let climbed = false;
  step(sim, secs, () => {
    if (v.pos.y - last > 0.3 || (inRect(d, v.pos) && sim.world.baseGround(v.pos.x, v.pos.z) < d.y - 0.45)) climbed = true;
    last = v.pos.y;
    return input(inp);
  });
  return climbed;
}

// ---------------------------------------------------------------------------
// Medium: a car shoved off the side of a deck where it meets the beach

describe('a car shoved or rammed off the side of the pier or the marina deck over the sand drives away', () => {
  /**
   * A sedan on `d`, 1 m in from its north (side -1) or south (side +1) edge at x, facing along it, shoved off sideways at
   * 8 m/s: it comes to rest on the sand with its near side still under the edge of the deck.
   */
  function shovedOff(d: Deck, x: number, side: 1 | -1, heading: number): { sim: Sim; v: Vehicle } {
    const sim = makeSim({ police: false });
    const z = side > 0 ? d.rect.maxZ - 1 : d.rect.minZ + 1;
    const v = sim.spawnVehicle('sedan', x, z, heading);
    v.pos.y = sim.world.groundHeight(x, z);
    placeInCar(sim, v);
    v.vel.z = side * 8;
    step(sim, 3);
    return { sim, v };
  }

  const tries: [string, Parameters<typeof input>[0]][] = [
    ['forward', { throttle: 1 }],
    ['reverse', { brake: 1 }],
    ['forward, wheel left', { throttle: 1, steer: -1 }],
    ['forward, wheel right', { throttle: 1, steer: 1 }],
    ['reverse, wheel left', { brake: 1, steer: -1 }],
    ['reverse, wheel right', { brake: 1, steer: 1 }],
  ];

  it('off either side of the pier and of the marina deck, facing either way: forward, back and steering away, never up onto the deck', () => {
    const bad: string[] = [];
    let straddled = 0;
    for (const [d, x, side, heading] of [
      [deck('Azura Pier'), 508, 1, Math.PI / 2],
      [deck('Azura Pier'), 514, 1, -Math.PI / 2],
      [deck('Azura Pier'), 508, -1, Math.PI / 2],
      [deck('Marina'), 512, 1, Math.PI / 2],
      [deck('Marina'), 504, -1, -Math.PI / 2],
    ] as const) {
      const label = `${d.name} ${side > 0 ? 'south' : 'north'} side at x ${x}, heading ${heading.toFixed(2)}`;
      const rest = shovedOff(d, x, side, heading).v;
      // At rest on the sand, more than a curb below the deck, with its near side under the deck's edge.
      if (rest.pos.y < d.y - 0.4 && !inRect(d, rest.pos) && bodyPoints(rest).some((p) => inRect(d, p))) straddled++;
      else bad.push(`${label}: not straddling the edge (${rest.pos.x.toFixed(2)}, ${rest.pos.y.toFixed(2)}, ${rest.pos.z.toFixed(2)})`);
      const moved: number[] = [];
      for (const [name, inp] of tries) {
        const { sim, v } = shovedOff(d, x, side, heading);
        const x0 = v.pos.x;
        const z0 = v.pos.z;
        const climbed = climbs(sim, v, d, 3, inp);
        const m = Math.hypot(v.pos.x - x0, v.pos.z - z0);
        moved.push(m);
        if (climbed) bad.push(`${label}, ${name}: climbed onto the deck`);
        if ((name === 'forward' || name === 'reverse') && m < 5) bad.push(`${label}, ${name}: moved ${m.toFixed(2)} m`);
      }
      // One way of steering turns the nose away from the deck: the car drives off that way.
      if (Math.max(moved[2]!, moved[3]!) < 5 || Math.max(moved[4]!, moved[5]!) < 5) bad.push(`${label}: steering, moved ${moved.slice(2).map((m) => m.toFixed(2)).join(', ')} m`);
    }
    expect(bad).toEqual([]);
    expect(straddled).toBe(5);
  });

  it('a car rammed side-on off the pier by a police car drives away', () => {
    // A cruiser coming at 16 m/s from the deck's middle shoves the player's car over the south edge, at the beach end.
    const ram = (): { sim: Sim; v: Vehicle } => {
      const sim = makeSim({ police: false });
      const v = sim.spawnVehicle('sedan', 506, 45.8, Math.PI / 2);
      v.pos.y = sim.world.groundHeight(506, 45.8);
      placeInCar(sim, v);
      const cop = sim.spawnVehicle('police', 506, 36.8, 0);
      cop.pos.y = sim.world.groundHeight(506, 36.8);
      cop.vel.z = 16;
      step(sim, 4);
      sim.removeVehicle(cop);
      return { sim, v };
    };
    const d = deck('Azura Pier');
    const rest = ram().v;
    expect(rest.pos.y).toBeLessThan(d.y - 0.4);
    expect(bodyPoints(rest).some((p) => inRect(d, p))).toBe(true);
    for (const inp of [{ throttle: 1 }, { brake: 1 }]) {
      const { sim, v } = ram();
      const x0 = v.pos.x;
      expect(climbs(sim, v, d, 3, inp), JSON.stringify(inp)).toBe(false);
      expect(Math.abs(v.pos.x - x0), JSON.stringify(inp)).toBeGreaterThan(5);
    }
  });

  it('a car resting with its side under the deck, shoved back towards it, stays down on the sand', () => {
    for (const [x, vz] of [
      [508, -6],
      [514, -12],
    ] as const) {
      const d = deck('Azura Pier');
      const { sim, v } = shovedOff(d, x, 1, Math.PI / 2);
      v.vel.z = vz;
      expect(climbs(sim, v, d, 2, {}), `x ${x}`).toBe(false);
      expect(v.pos.y, `x ${x}`).toBeLessThan(d.y - 0.4);
      expect(v.pos.z, `x ${x}`).toBeGreaterThan(d.rect.maxZ);
    }
  });
});

// ---------------------------------------------------------------------------
// Low: wading drag

describe('backing out of the surf', () => {
  /** The beach at z = -100: the x where the water is `depth` m deep. */
  function surfX(sim: Sim, depth: number): number {
    const b = sim.world.layout.bounds;
    let x = b.beachStartX;
    while (WATER_Y - sim.world.groundHeight(x, -100) < depth && x < b.beachEndX) x += 0.05;
    return x;
  }

  it('a bus standing in 0.7-0.78 m of water facing the sea backs out onto the sand', () => {
    for (const depth of [0.7, 0.75, 0.78]) {
      const sim = makeSim({ police: false });
      const v = sim.spawnVehicle('bus', surfX(sim, depth), -100, Math.PI / 2);
      v.pos.y = sim.world.groundHeight(v.pos.x, v.pos.z);
      placeInCar(sim, v);
      let out = -1;
      step(sim, 15, (t) => {
        if (out < 0 && WATER_Y - v.pos.y < 0) out = t;
        return input({ brake: 1 });
      });
      expect(v.inWater, `${depth} m`).toBe(false);
      expect(out, `${depth} m`).toBeGreaterThan(0);
    }
  });

  it('the drag still holds every kind back by the same share of its engine: a sedan as before', () => {
    // The sedan's times out of half a metre of water are those of fix pass 3 (3.7 s backing out, 2.5 s driving out).
    for (const [heading, inp, lo, hi] of [
      [Math.PI / 2, { brake: 1 }, 3.4, 4.0],
      [-Math.PI / 2, { throttle: 1 }, 2.2, 2.8],
    ] as const) {
      const sim = makeSim({ police: false });
      const v = sim.spawnVehicle('sedan', surfX(sim, 0.5), -100, heading);
      v.pos.y = sim.world.groundHeight(v.pos.x, v.pos.z);
      placeInCar(sim, v);
      let out = -1;
      step(sim, 8, (t) => {
        if (out < 0 && WATER_Y - v.pos.y < 0) out = t;
        return input(inp);
      });
      expect(out).toBeGreaterThan(lo);
      expect(out).toBeLessThan(hi);
    }
  });
});

// ---------------------------------------------------------------------------
// Low: officers walking off the decks at 0 stars

describe('officers without a car walking off at 0 stars keep to the pier and the marina', () => {
  it('from the pier, its far end, the marina deck and a finger pier: along the deck to the land, never into the sea', () => {
    const bad: string[] = [];
    for (const [name, px, pz, ox, oz] of [
      ['pier', 600, 40, 606, 40],
      ['pier end', 680, 38, 686, 40],
      ['marina deck', 600, 446, 606, 446],
      ['finger pier', 592, 470, 592, 476],
    ] as const) {
      const sim = makeSim();
      teleport(sim, px, pz);
      const c = officer(sim, ox, oz);
      c.heading = Math.atan2(px - c.pos.x, pz - c.pos.z);
      const x0 = c.pos.x;
      let wet = 0;
      let swam = false;
      let west = 0;
      step(sim, 60, () => {
        if (!c.removed) {
          if (c.state === 'swimming') swam = true;
          wet = Math.max(wet, sim.world.waterDepth(c.pos.x, c.pos.z));
          west = Math.max(west, x0 - c.pos.x);
        }
        return input();
      });
      if (swam || wet > 0) bad.push(`${name}: in the water (${wet.toFixed(2)} m deep${swam ? ', swimming' : ''})`);
      // On his way to the land end of the deck (or gone out of sight, see PoliceSystem.cleanup).
      if (!c.removed && west < 20) bad.push(`${name}: only ${west.toFixed(1)} m along the deck towards the land`);
    }
    expect(bad).toEqual([]);
  });

  it('from the far end of the pier: back past the Ferris wheel along the deck, within 25 s', () => {
    for (const [ox, oz] of [
      [686, 40],
      [686, 36],
      [691, 44],
    ] as const) {
      const sim = makeSim();
      // The player 30-odd m along the pier (near enough that cleanup keeps the officer), out of his way.
      teleport(sim, 645, oz < 40 ? 44 : 36);
      const c = officer(sim, ox, oz);
      let past = -1;
      let wet = 0;
      step(sim, 30, (t) => {
        if (!c.removed) {
          if (past < 0 && c.pos.x < 666) past = t;
          wet = Math.max(wet, sim.world.waterDepth(c.pos.x, c.pos.z));
        }
        return input();
      });
      expect(wet, `from (${ox}, ${oz})`).toBeLessThanOrEqual(0);
      expect(past, `from (${ox}, ${oz})`).toBeGreaterThan(0);
      expect(past, `from (${ox}, ${oz})`).toBeLessThan(25);
    }
  });

  it('one walking along the pier passes the player standing in his way at a distance, on the other side of the deck', () => {
    const sim = makeSim();
    teleport(sim, 600, 40);
    const c = officer(sim, 612, 40);
    let nearest = Infinity;
    let swam = false;
    step(sim, 30, () => {
      if (!c.removed) {
        nearest = Math.min(nearest, Math.hypot(c.pos.x - 600, c.pos.z - 40));
        if (c.state === 'swimming') swam = true;
      }
      return input();
    });
    expect(swam).toBe(false);
    expect(nearest).toBeGreaterThan(2.4);
  });
});

// ---------------------------------------------------------------------------
// Low: lights through the BUSTED and WASTED screens

describe('police lights stay on until the stars clear, not the moment the player goes down', () => {
  /** A unit chasing the player at one star on the longest lane, at s = 40 (crewed, or with its crew put out on foot). */
  function unit(sim: Sim, deployed: boolean): Vehicle {
    const lane = longestLane(sim);
    sim.wanted.setLevel(1);
    let v: Vehicle | null = null;
    for (let i = 0; i < 10 && !v; i++) v = sim.police.spawnUnit('police', true);
    expect(v).not.toBeNull();
    const p = at(lane, 40);
    v!.pos.x = p.x;
    v!.pos.z = p.z;
    v!.pos.y = sim.world.groundHeight(p.x, p.z);
    v!.heading = lane.heading;
    v!.vel.x = 0;
    v!.vel.z = 0;
    v!.ai?.setLane(lane, 40);
    if (deployed) internals(sim).deploy(v!);
    return v!;
  }

  it('busted beside a deployed cruiser, wasted near a crewed one, and a crew getting back in meanwhile: lights on to the end', () => {
    for (const [how, deployed] of [
      ['busted', true],
      ['wasted', false],
      ['busted', false],
    ] as const) {
      const sim = makeSim();
      const v = unit(sim, deployed);
      const lane = longestLane(sim);
      const q = at(lane, 50);
      teleport(sim, q.x, q.z);
      for (const [i, c] of sim.characters.filter((c) => c.brain?.car === v).entries()) placeOnFoot(sim, c, q.x - lane.dx * (1.5 + i), q.z - lane.dz * (1.5 + i));
      step(sim, 0.3);
      expect(v.siren).toBe(true);
      if (how === 'busted') sim.bustPlayer();
      else sim.playerDied();
      let dark = 0;
      step(sim, 4.5, () => {
        if (!v.siren) dark++;
        return input();
      });
      expect(sim.playerDown).toBe(true);
      expect(sim.wanted.level).toBe(1);
      expect(dark, `${how}, ${deployed ? 'deployed' : 'crewed'}`).toBe(0);
      // Back on his feet the stars are gone, and so are the police.
      step(sim, 0.6);
      expect(sim.playerDown).toBe(false);
      expect(sim.wanted.level).toBe(0);
      expect(sim.vehicles.some((o) => !o.removed && o.owner === 'police' && o.siren)).toBe(false);
    }
  });

  it('an officer getting back into his cruiser while the player is down gets in with the lights on', () => {
    const sim = makeSim();
    const v = unit(sim, true);
    const lane = longestLane(sim);
    const crew = sim.characters.filter((c) => c.brain?.car === v);
    // The player far down the street, the crew by the car (beyond the 12 m at which they stand by him).
    const q = at(lane, 90);
    teleport(sim, q.x, q.z);
    for (const [i, c] of crew.entries()) placeOnFoot(sim, c, v.pos.x - lane.dx * (3 + i), v.pos.z - lane.dz * (3 + i));
    step(sim, 0.2);
    sim.bustPlayer();
    let boarded = false;
    let dark = 0;
    step(sim, 4.5, () => {
      if (crew.some((c) => c.vehicle === v)) boarded = true;
      if (!v.siren) dark++;
      return input();
    });
    expect(boarded).toBe(true);
    expect(dark).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Low: fleeing peds on the wet sand of Ocean Beach

describe('peds fleeing on the wet sand or in the shallows of Ocean Beach run along or up the beach', () => {
  /** The x on the beach at z = -100 where the ground is at height y. */
  function beachX(y: number): number {
    const b = world().layout.bounds;
    let x = b.beachStartX;
    while (world().groundHeight(x, -100) > y && x < b.beachEndX) x += 0.02;
    return x;
  }

  /** A civilian at (x, z) fleeing for 10 s a gunman 20 m inland who keeps firing: the longest he stood still, how far he went, whether he swam. */
  function flight(x: number, z: number, seed: number): { still: number; moved: number; swam: boolean } {
    const sim = makeSim({ world: world(), police: false, seed });
    teleport(sim, x - 60, z + 40);
    const c = sim.spawnCharacter('civilian', x, z);
    c.owner = 'mission';
    c.persistent = true;
    c.brain = makeBrain('wander');
    sim.peds.flee(c, x - 20, z, null);
    let still = 0;
    let longest = 0;
    let moved = 0;
    let swam = false;
    for (let i = 0; i < 60 * 10; i++) {
      if (i % 120 === 0) sim.peds.onViolence(x - 20, z, null, 60);
      const px = c.pos.x;
      const pz = c.pos.z;
      sim.update(DT, input());
      const d = Math.hypot(c.pos.x - px, c.pos.z - pz);
      moved += d;
      still = d < 0.2 * DT ? still + DT : 0;
      longest = Math.max(longest, still);
      if (c.state === 'swimming') swam = true;
    }
    return { still: longest, moved, swam };
  }

  it('on the wet strip, at the water, and wading: they keep running and never swim', () => {
    const bad: string[] = [];
    for (const [label, x] of [
      ['wet strip', beachX(WATER_Y + 0.13)],
      ['at the water', beachX(WATER_Y + 0.01)],
      ['wading 0.2 m', beachX(WATER_Y - 0.2)],
      ['wading 0.6 m', beachX(WATER_Y - 0.6)],
    ] as const) {
      for (const z of [-200, -100]) {
        for (const seed of [1, 2]) {
          const r = flight(x, z, seed);
          if (r.still > 1 || r.moved < 30 || r.swam) bad.push(`${label} z ${z} seed ${seed}: stood still ${r.still.toFixed(1)} s, ran ${r.moved.toFixed(1)} m${r.swam ? ', swam' : ''}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('a swimmer who wades ashore fleeing someone on the sand runs on along the beach', () => {
    const b = world().layout.bounds;
    const shore = beachX(WATER_Y);
    for (const z of [-200, 300]) {
      const sim = makeSim({ world: world(), police: false, seed: 1 });
      teleport(sim, b.beachStartX + 5, z + 30);
      const c = sim.spawnCharacter('civilian', shore + 10, z);
      c.owner = 'mission';
      c.persistent = true;
      c.brain = makeBrain('wander');
      sim.update(DT, input());
      sim.peds.flee(c, b.beachStartX + 5, z, null);
      let still = 0;
      let longest = 0;
      for (let i = 0; i < 60 * 20; i++) {
        if (i % 120 === 0) sim.peds.onViolence(b.beachStartX + 5, z, null, 60);
        const px = c.pos.x;
        const pz = c.pos.z;
        sim.update(DT, input());
        still = c.state !== 'swimming' && Math.hypot(c.pos.x - px, c.pos.z - pz) < 0.2 * DT ? still + DT : 0;
        longest = Math.max(longest, still);
      }
      expect(longest, `z ${z}`).toBeLessThan(1);
      expect(c.state, `z ${z}`).toBe('normal');
    }
  });

  it('one on the sand fleeing towards the side of the pier turns along it instead of running in place against it', () => {
    for (const x of [505, 512, 518]) {
      const sim = makeSim({ world: world(), police: false, seed: 1 });
      teleport(sim, x - 30, 120);
      const c: Character = sim.spawnCharacter('civilian', x, 58);
      c.owner = 'mission';
      c.persistent = true;
      c.brain = makeBrain('wander');
      sim.peds.flee(c, x, 80, null);
      c.brain.lateral = 0;
      c.brain.modeTimer = 30;
      // Running (moveSpeed up) without getting anywhere.
      let pressed = 0;
      let longest = 0;
      for (let i = 0; i < 60 * 12; i++) {
        const px = c.pos.x;
        const pz = c.pos.z;
        sim.update(DT, input());
        pressed = c.moveSpeed > 1 && Math.hypot(c.pos.x - px, c.pos.z - pz) < 0.2 * DT ? pressed + DT : 0;
        longest = Math.max(longest, pressed);
      }
      expect(longest, `x ${x}`).toBeLessThan(1);
      expect(c.state, `x ${x}`).toBe('normal');
    }
  });
});

// ---------------------------------------------------------------------------
// Low: one measure of night for the helicopter's crew and its beam

describe("the helicopter's crew sees by night exactly while its beam is drawn", () => {
  it('through dusk and dawn, minute by minute, in the renderer and the simulation', () => {
    const sim = makeSim({ world: world() });
    // Held in place over the beach (the police system is off, so nothing flies it), its light straight down.
    sim.policeEnabled = false;
    const hover = { x: 515, z: -150 };
    const heli = new Helicopter(sim.newId(), hover.x, sim.world.groundHeight(hover.x, hover.z) + 36, hover.z);
    heli.spotlight = { x: hover.x, z: hover.z };
    sim.helis.push(heli);
    // A spot the crew makes out by day but not by night: within HELI_SIGHT along the sand, beyond HELI_NIGHT_SIGHT and
    // outside the light.
    const far = { x: hover.x, z: hover.z + HELI_SIGHT - 4 };
    expect(Math.hypot(far.z - hover.z, heli.pos.y - sim.world.groundHeight(far.x, far.z) - 1.2)).toBeGreaterThan(HELI_NIGHT_SIGHT);
    expect(far.z - hover.z).toBeGreaterThan(SPOT_SEE);
    teleport(sim, far.x + 3, far.z + 3);
    const R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, sim.world, { quality: 'low', fov: 68 });
    R.attach(sim);
    const views = (R.markers as unknown as { heliViews: Map<number, { cone: THREE.Mesh }> }).heliViews;
    const bad: string[] = [];
    let beams = 0;
    let days = 0;
    for (const [h0, h1] of [
      [17.5, 21],
      [4.5, 7.5],
    ]) {
      for (let m = 0; h0 + m / 60 <= h1; m++) {
        const h = h0 + m / 60;
        sim.clock.set(h);
        R.render(DT, false);
        const beam = views.get(heli.id)!.cone.visible;
        const sees = sim.wanted.heliSees(heli, far.x, far.z);
        if (beam) beams++;
        if (sees) days++;
        if (beam === sees) bad.push(`${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}: beam ${beam ? 'on' : 'off'}, crew ${sees ? 'sees by day' : 'sees by night'}`);
        if (Math.abs(R.env.night - darkness(h)) > 1e-12) bad.push(`${h.toFixed(3)} h: the renderer's night ${R.env.night} is not darkness() ${darkness(h)}`);
      }
    }
    // Both ways across both windows.
    expect(beams).toBeGreaterThan(60);
    expect(days).toBeGreaterThan(60);
    expect(bad.slice(0, 8)).toEqual([]);
  });
});
