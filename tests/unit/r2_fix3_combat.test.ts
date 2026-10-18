// Round 2 fix pass 3, combat cluster: vigilante stops that are no crime, the NPC-to-player damage factor for every
// NPC shooter, fist fights that let a downed man up, NPC swim speed, crimes from a previous life, aim reactions that
// need a line of sight, exits on the dry side of a quay, and the low items (exit points per seat, fire kill credit,
// fleeing along a seawall, the last round's pose and a cowering civilian's hit volume).
// The drawn crouch is measured headless: the canvas and WebGL stub header below is copied from fix_render.test.ts.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CrowdView } from '../../src/render/crowd';
import { makeBrain } from '../../src/sim/brains';
import type { Character, Vehicle } from '../../src/sim/entities';
import { Projectile } from '../../src/sim/entities';
import type { SimEvents } from '../../src/sim/events';
import { weaponPose } from '../../src/sim/pose';
import type { Sim } from '../../src/sim/sim';
import { WEAPONS } from '../../src/sim/specs';
import { SWIM_DEPTH, WATER_Y } from '../../src/world/constants';
import { aimAt, input, makeSim, placeInCar, roadPoint, step, teleport, world } from './helpers';

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
    // Every other 2D call is a no-op; property writes are kept.
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

// ---------------------------------------------------------------------------
// Helpers

/** Collects every event of `type` emitted from now on. */
function record<K extends keyof SimEvents>(sim: Sim, type: K): Array<SimEvents[K]> {
  const out: Array<SimEvents[K]> = [];
  sim.events.on(type, (e) => out.push(e));
  return out;
}

/** The middle of a long straight lane with nothing static within a few metres (props knocked over). */
function openRoad(sim: Sim): { x: number; z: number; h: number; fx: number; fz: number; rx: number; rz: number } {
  for (const pr of sim.world.grid.colliders) if (pr.breakable || pr.tag === 'tree') pr.broken = true;
  for (const lane of sim.roads.lanes) {
    if (lane.length < 60) continue;
    const s = lane.length / 2;
    const x = lane.sx + lane.dx * s;
    const z = lane.sz + lane.dz * s;
    const rx = -Math.cos(lane.heading);
    const rz = Math.sin(lane.heading);
    let open = true;
    for (let a = -10; a <= 24 && open; a++) {
      for (let l = -4; l <= 4 && open; l++) open = sim.world.isFree(x + lane.dx * a + rx * l, z + lane.dz * a + rz * l, 0.5);
    }
    if (open) return { x, z, h: lane.heading, fx: Math.sin(lane.heading), fz: Math.cos(lane.heading), rx, rz };
  }
  throw new Error('no open road');
}

/** A stationary NPC at (x, z), kept by no streaming system (no brain unless one is given). */
function npcAt(sim: Sim, role: 'civilian' | 'gang' | 'cop' | 'swat' | 'mission', x: number, z: number): Character {
  const c = sim.spawnCharacter(role, x, z);
  c.owner = 'mission';
  c.persistent = true;
  return c;
}

interface Vigilante {
  car: Vehicle;
  target: Vehicle;
  suspect: Character;
  level: () => number;
}

/**
 * The player in a cruiser of his own on a lane, a vigilante job started (T) and its first suspect spawned; the suspect's
 * car is then brought 18 m ahead of the cruiser and stopped, so the scene is in sight of the player and the test's officer.
 */
function startVigilante(sim: Sim): Vigilante {
  const r = roadPoint(sim, 40, 20);
  const car = sim.spawnVehicle('police', r.x, r.z, r.heading);
  car.owner = 'none';
  placeInCar(sim, car);
  sim.update(DT, input({ job: true }));
  step(sim, 0.5);
  const j = sim.activities.job;
  if (j?.kind !== 'vigilante' || !j.target || !j.suspect) throw new Error('no vigilante suspect');
  const target = j.target;
  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  target.pos.x = car.pos.x + fx * 18;
  target.pos.z = car.pos.z + fz * 18;
  target.pos.y = sim.world.groundHeight(target.pos.x, target.pos.z);
  target.heading = car.heading;
  target.vel.x = 0;
  target.vel.z = 0;
  return { car, target, suspect: j.suspect, level: () => (sim.activities.job?.kind === 'vigilante' ? sim.activities.job.level : 0) };
}

/** An officer standing (brainless, so he stays put) `side` m to the right of the suspect's car: he sees everything there. */
function officerBeside(sim: Sim, v: Vehicle, side = 4.5): Character {
  const rx = -Math.cos(v.heading);
  const rz = Math.sin(v.heading);
  const cop = npcAt(sim, 'cop', v.pos.x + rx * side, v.pos.z + rz * side);
  cop.owner = 'police';
  return cop;
}

// ---------------------------------------------------------------------------
// 1 (high): vigilante stops are no crime

describe('Vigilante: stopping the suspect is no crime', () => {
  it('a drive-by that sets his car alight, with an officer beside it: paid, and no star from the gunfire, the wreck or its blast', () => {
    const sim = makeSim({ police: true });
    const vg = startVigilante(sim);
    officerBeside(sim, vg.target);
    const p = sim.player;
    p.inventory.give('smg', 400);
    p.inventory.current = 'smg';
    const destroyed = sim.progress.stats.vehiclesDestroyed;
    // Spray the suspect's car from the cruiser's window until it burns (boxed in: he cannot drive off).
    let t = 0;
    while (!vg.target.burning && t < 8) {
      if (vg.target.ai) vg.target.ai.hold = true;
      const aim = { x: vg.target.pos.x, y: vg.target.pos.y + 0.8, z: vg.target.pos.z };
      sim.update(DT, aimAt(sim, aim, { fire: true, firePressed: true }));
      t += DT;
    }
    expect(vg.target.burning).toBe(true);
    expect(sim.wanted.level, `${sim.wanted.lastCrime}`).toBe(0);
    // He bails, the job counts the stop, and the wreck blows up 3.5 to 5.5 s later.
    step(sim, 8);
    expect(vg.level()).toBe(2);
    expect(vg.target.destroyed).toBe(true);
    expect(sim.wanted.level, `${sim.wanted.lastCrime}`).toBe(0);
    // He did destroy it: the stat still counts it.
    expect(sim.progress.stats.vehiclesDestroyed).toBe(destroyed + 1);
  });

  it('rammed into flames: no star from the wreck or its blast, with an officer watching', () => {
    const sim = makeSim({ police: true });
    const vg = startVigilante(sim);
    officerBeside(sim, vg.target);
    // The physics host's ram callback: the player's cruiser drove into the suspect's car.
    for (let i = 0; i < 6 && !vg.target.burning; i++) sim.onVehicleImpact(vg.target, vg.car, 22, vg.target.pos.x, vg.target.pos.z, true);
    expect(vg.target.burning).toBe(true);
    step(sim, 8);
    expect(vg.level()).toBe(2);
    expect(vg.target.destroyed).toBe(true);
    expect(sim.wanted.level, `${sim.wanted.lastCrime}`).toBe(0);
  });

  it('the suspect run down or shot dead on foot next to an officer: no star; a bystander shot dead there still is murder', () => {
    const sim = makeSim({ police: true });
    const vg = startVigilante(sim);
    const cop = officerBeside(sim, vg.target);
    const kills = sim.progress.stats.kills;
    sim.combat.damageVehicle(vg.target, vg.target.health + 1, sim.player, 'bullet');
    // He bails out of the burning car; the job pays for the stop and lets go of him.
    step(sim, 0.1);
    expect(vg.suspect.state).toBe('normal');
    expect(vg.level()).toBe(2);
    expect(vg.suspect.missionTag).toBe('');
    // Knocked down by the cruiser, then shot dead, 4 m from the officer.
    vg.suspect.pos.x = cop.pos.x + 2;
    vg.suspect.pos.z = cop.pos.z;
    sim.onCharacterHitByVehicle(vg.suspect, vg.car, 8, 1, 0);
    expect(vg.suspect.alive).toBe(true);
    expect(sim.wanted.level, `${sim.wanted.lastCrime}`).toBe(0);
    sim.combat.damageCharacter(vg.suspect, 1000, sim.player, 'bullet', 1, 0, 0);
    expect(vg.suspect.alive).toBe(false);
    expect(sim.progress.stats.kills).toBe(kills + 1);
    expect(sim.wanted.level, `${sim.wanted.lastCrime}`).toBe(0);
    // Not a licence to kill: a civilian shot dead there is murder.
    const civ = npcAt(sim, 'civilian', cop.pos.x - 2, cop.pos.z);
    sim.combat.damageCharacter(civ, 1000, sim.player, 'bullet', 1, 0, 0);
    expect(sim.wanted.level).toBe(1);
    expect(sim.wanted.lastCrime).toBe('murder');
  });

  it('a job that lets the suspect go without a stop hands back an ordinary man; one stopped stays stopped after the job', () => {
    // Quit (T) while he still drives: killing him next to the officer is killing a gang member again.
    {
      const sim = makeSim({ police: true });
      const vg = startVigilante(sim);
      officerBeside(sim, vg.target);
      sim.update(DT, input({ job: true }));
      sim.update(DT, input());
      expect(sim.activities.job).toBeNull();
      expect(vg.target.driver).toBe(vg.suspect);
      sim.combat.damageCharacter(vg.suspect, 1000, sim.player, 'bullet', 1, 0, 0);
      expect(vg.suspect.alive).toBe(false);
      expect(sim.wanted.level).toBe(1);
      expect(sim.wanted.lastCrime).toBe('killGang');
    }
    // Stopped (his car set alight, he bails), then the player quits: still no crime to finish him off.
    {
      const sim = makeSim({ police: true });
      const vg = startVigilante(sim);
      officerBeside(sim, vg.target);
      sim.combat.damageVehicle(vg.target, vg.target.health + 1, sim.player, 'bullet');
      step(sim, 0.1);
      expect(vg.level()).toBe(2);
      sim.update(DT, input({ job: true }));
      sim.update(DT, input());
      expect(sim.activities.job).toBeNull();
      sim.combat.damageCharacter(vg.suspect, 1000, sim.player, 'bullet', 1, 0, 0);
      expect(vg.suspect.alive).toBe(false);
      expect(sim.wanted.level, `${sim.wanted.lastCrime}`).toBe(0);
    }
  });

  it('control: the same drive-by from a cruiser with no job running is gunfire in front of the officer', () => {
    const sim = makeSim({ police: true });
    const r = roadPoint(sim, 40, 20);
    const car = sim.spawnVehicle('police', r.x, r.z, r.heading);
    car.owner = 'none';
    placeInCar(sim, car);
    const other = sim.spawnVehicle('sedan', car.pos.x + Math.sin(car.heading) * 18, car.pos.z + Math.cos(car.heading) * 18, car.heading);
    officerBeside(sim, other);
    const p = sim.player;
    p.inventory.give('smg', 400);
    p.inventory.current = 'smg';
    sim.update(DT, aimAt(sim, { x: other.pos.x, y: other.pos.y + 0.8, z: other.pos.z }, { fire: true, firePressed: true }));
    expect(sim.wanted.level).toBe(1);
    expect(sim.wanted.lastCrime).toBe('gunfire');
  });
});

// ---------------------------------------------------------------------------
// 2 (medium): every NPC shooter's hits on the player are scaled down

describe('NPC fire on the player: one damage factor for every shooter', () => {
  it("The Big Score's bank guards (role 'mission') hit the player for 0.55 of the pistol's damage, like a gangster", () => {
    for (const role of ['mission', 'gang', 'cop'] as const) {
      const sim = makeSim({ world: world(), police: false });
      const r = openRoad(sim);
      teleport(sim, r.x, r.z);
      const p = sim.player;
      const g = npcAt(sim, role, r.x + r.fx * 4, r.z + r.fz * 4);
      g.inventory.infinite = true;
      g.inventory.give('pistol', 999);
      g.inventory.current = 'pistol';
      g.drawnWeapon = 'pistol';
      g.heading = r.h + Math.PI;
      const hits = record(sim, 'damage');
      for (let i = 0; i < 6; i++) {
        g.fireCooldown = 0;
        p.health = p.maxHealth;
        sim.combat.npcFire(g, p, 1);
      }
      const body = hits.filter((e) => e.victim === p && e.zone === 'body');
      expect(body.length, role).toBeGreaterThan(0);
      for (const e of body) expect(e.healthLoss + e.armourLoss, role).toBeCloseTo(WEAPONS.pistol.damage * 0.55, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// 3 (medium): fist fights let a downed man up

/**
 * A passive player on a road, a brave unarmed civilian squared up to him 1 m ahead (the sweep's repro). `tick` steps one
 * frame; each blow on the player is logged with whether he was already down when it landed (as the frame began).
 */
function brawl(): {
  sim: Sim;
  p: Character;
  civ: Character;
  hits: Array<{ t: number; down: boolean; counted: number }>;
  tick: (inp?: ReturnType<typeof input>) => void;
} {
  const sim = makeSim({ police: false, seed: 1 });
  const r = roadPoint(sim, 40, 30);
  teleport(sim, r.x, r.z);
  const p = sim.player;
  p.heading = 0;
  const civ = npcAt(sim, 'civilian', r.x, r.z + 1);
  const b = makeBrain('wander');
  b.brave = true;
  civ.brain = b;
  sim.peds.fight(civ, p);
  const hits: Array<{ t: number; down: boolean; counted: number }> = [];
  let downBefore = false;
  sim.events.on('damage', (e) => {
    if (e.victim === p && e.kind === 'melee') hits.push({ t: sim.time, down: downBefore, counted: p.staggerHits });
  });
  const tick = (inp = input()) => {
    downBefore = p.state === 'knocked';
    sim.update(DT, inp);
  };
  return { sim, p, civ, hits, tick };
}

describe('Fist fights: a man on the ground is let up', () => {
  it('an NPC brawler never punches a downed player, and he gets up with no blows counted towards the next knockdown', () => {
    const { sim, p, hits, tick } = brawl();
    const getUps: Array<{ t: number; counted: number }> = [];
    const knocks: number[] = [];
    let prev = p.state;
    for (let i = 0; i < 60 * 12 && p.alive; i++) {
      tick();
      if (p.state !== prev) {
        if (prev === 'knocked' && p.state === 'normal') getUps.push({ t: sim.time, counted: p.staggerHits });
        if (p.state === 'knocked') knocks.push(sim.time);
        prev = p.state;
      }
    }
    expect(knocks.length).toBeGreaterThanOrEqual(2);
    expect(getUps.length).toBeGreaterThanOrEqual(1);
    for (const g of getUps) expect(g.counted).toBe(0);
    // No blow lands on the man on the ground.
    expect(hits.filter((h) => h.down).length).toBe(0);
    // Back on his feet, the next knockdown takes three counted blows, the first ones after a moment to find his feet.
    const up = getUps[0]!.t;
    const next = knocks.find((k) => k > up)!;
    const between = hits.filter((h) => h.t > up && h.t <= next + 1e-9);
    expect(between.length).toBeGreaterThanOrEqual(3);
    expect(next - up).toBeGreaterThanOrEqual(1.2);
  });

  it('a player who sprints off 0.6 s after getting up gets away, and is not knocked down again', () => {
    const { sim, p, civ, tick } = brawl();
    // Wait for the first knockdown to end.
    let t = 0;
    let wasDown = false;
    while (t < 8 && !(wasDown && p.state === 'normal')) {
      tick();
      if (p.state === 'knocked') wasDown = true;
      t += DT;
    }
    expect(wasDown && p.state === 'normal').toBe(true);
    step(sim, 0.6);
    expect(p.state).toBe('normal');
    // Away from the brawler, at a sprint.
    const yaw = Math.atan2(p.pos.x - civ.pos.x, p.pos.z - civ.pos.z);
    let knocked = false;
    for (let i = 0; i < 60 * 5; i++) {
      sim.update(DT, input({ cameraYaw: yaw, moveZ: 1, sprint: true }));
      if (p.state === 'knocked') knocked = true;
    }
    expect(knocked).toBe(false);
    expect(p.alive).toBe(true);
    expect(Math.hypot(p.pos.x - civ.pos.x, p.pos.z - civ.pos.z)).toBeGreaterThan(8);
  });
});

// ---------------------------------------------------------------------------
// 4 (medium): NPCs swim at a swimmer's speed

describe('NPCs swim no faster than the player', () => {
  it('an officer, a fleeing civilian and a gang fighter in deep water keep under the swim speed (2.4 m/s)', () => {
    const sim = makeSim({ police: true });
    const b = sim.world.bounds;
    const x = b.beachEndX + 30;
    const z = 200;
    teleport(sim, x, z);
    step(sim, 0.2);
    const p = sim.player;
    expect(p.state).toBe('swimming');
    // At 2 stars the officer swims after him (and shoots once within range: the player takes no harm here).
    sim.cheats.godMode = true;
    sim.wanted.setLevel(2);
    const cop = npcAt(sim, 'cop', x + 40, z);
    cop.owner = 'police';
    cop.brain = makeBrain('chase');
    const civ = npcAt(sim, 'civilian', x + 6, z + 6);
    civ.brain = makeBrain('wander');
    const gang = npcAt(sim, 'gang', x - 30, z);
    gang.brain = makeBrain('wander');
    gang.brain.brave = true;
    const top = new Map<Character, number>([
      [cop, 0],
      [civ, 0],
      [gang, 0],
    ]);
    for (let i = 0; i < 60 * 12; i++) {
      // Keep the civilian running and the gangster after the player.
      if (civ.brain!.mode !== 'flee') sim.peds.flee(civ, p.pos.x, p.pos.z, p);
      if (gang.brain!.mode !== 'fight') sim.peds.fight(gang, p);
      sim.update(DT, input());
      for (const c of top.keys()) if (c.state === 'swimming') top.set(c, Math.max(top.get(c)!, c.speed));
    }
    for (const [c, v] of top) {
      expect(c.state, c.role).toBe('swimming');
      expect(v, c.role).toBeGreaterThan(1);
      expect(v, c.role).toBeLessThanOrEqual(2.4 + 1e-6);
    }
    // The officer never closed the 40 m gap to shadow him at arm's length.
    expect(Math.hypot(cop.pos.x - p.pos.x, cop.pos.z - p.pos.z)).toBeGreaterThan(10);
  });

  it("at one star an officer waits at the water's edge for a swimmer, who loses the star by swimming off", () => {
    const sim = makeSim({ police: true });
    const b = sim.world.bounds;
    // Off Ocean Beach, where the sand runs down into swimming depth; the officer comes from up the beach.
    const z = 200;
    const sea = b.beachStartX + 88;
    const sand = b.beachStartX + 33;
    expect(sim.world.waterDepth(sea, z)).toBeGreaterThan(SWIM_DEPTH);
    expect(sim.world.waterDepth(sand, z)).toBeLessThan(0);
    teleport(sim, sea, z);
    sim.update(DT, input());
    const p = sim.player;
    expect(p.state).toBe('swimming');
    sim.wanted.setLevel(1);
    const cop = npcAt(sim, 'cop', sand, z + 4);
    cop.owner = 'police';
    cop.inventory.infinite = true;
    cop.inventory.give('pistol', 999);
    cop.inventory.current = 'pistol';
    cop.brain = makeBrain('chase');
    // Treading water: the officer comes down to the water and waits there, never swimming out to shadow him.
    let swam = false;
    for (let i = 0; i < 60 * 20; i++) {
      sim.update(DT, input());
      if (cop.state === 'swimming') swam = true;
    }
    expect(swam).toBe(false);
    expect(Math.hypot(cop.pos.x - p.pos.x, cop.pos.z - p.pos.z)).toBeGreaterThan(5);
    expect(Math.hypot(cop.pos.x - p.pos.x, cop.pos.z - p.pos.z)).toBeLessThan(25);
    expect(sim.wanted.level).toBe(1);
    // Swimming off out to sea gets him away.
    let t = 0;
    while (sim.wanted.level > 0 && t < 90) {
      sim.update(DT, input({ cameraYaw: Math.PI / 2, moveZ: 1 }));
      t += DT;
    }
    expect(sim.wanted.level).toBe(0);
    expect(sim.playerDown).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5 (medium): crimes from a previous life are void

describe('Respawn: crimes from the previous life are void', () => {
  it('a car he set alight before he died blows up after the respawn: no star, no stat', () => {
    const sim = makeSim({ police: true });
    const r = openRoad(sim);
    teleport(sim, r.x, r.z);
    const p = sim.player;
    const car = sim.spawnVehicle('sedan', r.x + r.fx * 12, r.z + r.fz * 12, r.h);
    const destroyed = sim.progress.stats.vehiclesDestroyed;
    sim.combat.damageVehicle(car, 1, p, 'bullet');
    sim.combat.igniteVehicle(car, 5.5);
    sim.combat.damageCharacter(p, 500, null, 'bullet', 1, 0, 0);
    expect(sim.playerDown).toBe(true);
    step(sim, 7);
    expect(sim.playerDown).toBe(false);
    expect(car.destroyed).toBe(true);
    expect(sim.wanted.level, `${sim.wanted.lastCrime}`).toBe(0);
    expect(sim.progress.stats.vehiclesDestroyed).toBe(destroyed);
  });

  it('a rocket still in flight when he dies lights a car that blows up after the respawn: no star', () => {
    const sim = makeSim({ police: true });
    const r = openRoad(sim);
    teleport(sim, r.x, r.z);
    const p = sim.player;
    const car = sim.spawnVehicle('sedan', r.x + r.fx * 40, r.z + r.fz * 40, r.h);
    // One more hit sets it alight; the blast about 7.4 m away is not enough to blow it up at once.
    car.health = 1;
    const gx = car.pos.x + r.rx * 3.5 + r.fx * 6.5;
    const gz = car.pos.z + r.rz * 3.5 + r.fz * 6.5;
    // A rocket coming down on the road there, fired just before he died.
    const from = { x: gx, y: sim.world.groundHeight(gx, gz) + 6, z: gz };
    sim.projectiles.push(new Projectile(sim.newId(), from, { x: 0, y: -58, z: 0 }, p));
    sim.combat.damageCharacter(p, 500, null, 'bullet', 1, 0, 0);
    let t = 0;
    while (!car.burning && !car.destroyed && t < 3) {
      sim.update(DT, input());
      t += DT;
    }
    expect(car.burning).toBe(true);
    expect(sim.playerDown).toBe(true);
    // Burning on past the WASTED screen.
    car.burnTimer = Math.max(car.burnTimer, 4.8 - t + 0.5);
    step(sim, 7);
    expect(sim.playerDown).toBe(false);
    expect(car.destroyed).toBe(true);
    expect(sim.wanted.level, `${sim.wanted.lastCrime}`).toBe(0);
  });

  it('a car he only shot before he died, set alight after the respawn by a crash: no star', () => {
    const sim = makeSim({ police: true });
    const r = openRoad(sim);
    teleport(sim, r.x, r.z);
    const p = sim.player;
    const car = sim.spawnVehicle('sedan', r.x + r.fx * 12, r.z + r.fz * 12, r.h);
    sim.combat.damageVehicle(car, 100, p, 'bullet');
    sim.combat.damageCharacter(p, 500, null, 'bullet', 1, 0, 0);
    step(sim, 5.5);
    expect(sim.playerDown).toBe(false);
    sim.combat.damageVehicle(car, car.health + 1, null, 'impact');
    step(sim, 6);
    expect(car.destroyed).toBe(true);
    expect(sim.wanted.level, `${sim.wanted.lastCrime}`).toBe(0);
  });

  it('control: alive, he is charged for the car he set alight', () => {
    const sim = makeSim({ police: true });
    const r = openRoad(sim);
    teleport(sim, r.x, r.z);
    const p = sim.player;
    const car = sim.spawnVehicle('sedan', r.x + r.fx * 12, r.z + r.fz * 12, r.h);
    sim.combat.damageVehicle(car, 1, p, 'bullet');
    sim.combat.igniteVehicle(car, 5.5);
    step(sim, 7);
    expect(car.destroyed).toBe(true);
    expect(sim.wanted.level).toBe(1);
    expect(sim.wanted.lastCrime).toBe('explosion');
  });
});

// ---------------------------------------------------------------------------
// 6 (medium): aim reactions need a line of sight

describe('Peds react to a gun pointed at them only when they can see it', () => {
  /** The player with a pistol at (px, pz), aiming at the chest of a ped at (cx, cz) for `frames` frames. */
  function pointGun(role: 'gang' | 'civilian', px: number, pz: number, cx: number, cz: number, frames = 3): { sim: Sim; c: Character; seen: boolean } {
    const sim = makeSim({ world: world(), police: false, startHour: 12 });
    teleport(sim, px, pz);
    const p = sim.player;
    p.inventory.give('pistol', 48);
    p.inventory.current = 'pistol';
    const c = npcAt(sim, role, cx, cz);
    c.brain = makeBrain('idle');
    c.brain.modeTimer = 30;
    if (role === 'gang') c.brain.brave = true;
    const chest = { x: c.pos.x, y: c.pos.y + 1.2, z: c.pos.z };
    const seen = sim.world.lineOfSight(p.pos.x, p.pos.y + 1.5, p.pos.z, chest.x, chest.y, chest.z);
    for (let i = 0; i < frames; i++) sim.update(DT, aimAt(sim, { x: c.pos.x, y: c.pos.y + 1.2, z: c.pos.z }, { aim: true }));
    return { sim, c, seen };
  }

  it('a gang member round a Westside corner stays idle', () => {
    const { c, seen } = pointGun('gang', -282.2, 70.8, -290.2, 77.8);
    expect(seen).toBe(false);
    expect(c.brain!.mode).not.toBe('fight');
    expect(c.brain!.target).toBeNull();
  });

  it('a gang member on the sidewalk outside the Docks Spray Shack, the player inside: stays idle', () => {
    const { c, seen } = pointGun('gang', -318.0, 281.5, -315.5, 278.2);
    expect(seen).toBe(false);
    expect(c.brain!.mode).not.toBe('fight');
  });

  it('in plain view 8 m away a gang member squares up and a civilian cowers or runs', () => {
    const sim = makeSim({ world: world(), police: false });
    const r = openRoad(sim);
    for (const role of ['gang', 'civilian'] as const) {
      const { c, seen } = pointGun(role, r.x, r.z, r.x + r.fx * 8, r.z + r.fz * 8);
      expect(seen, role).toBe(true);
      if (role === 'gang') expect(c.brain!.mode).toBe('fight');
      else expect(['cower', 'flee']).toContain(c.brain!.mode);
    }
  });
});

// ---------------------------------------------------------------------------
// 7 (medium): out of a car on the dry side

describe('Getting out beside a quay, pier or deck edge: the dry side first', () => {
  function exitFrom(x: number, z: number, heading: number): { sim: Sim; p: Character; v: Vehicle } {
    const sim = makeSim({ world: world(), police: false });
    const v = sim.spawnVehicle('sedan', x, z, heading);
    placeInCar(sim, v);
    step(sim, 0.5);
    sim.update(DT, input({ enterExit: true }));
    step(sim, 3);
    return { sim, p: sim.player, v };
  }

  it('a car parked along the west quay with the sea on the driver side: out on the quay', () => {
    const b = world().bounds;
    const { sim, p } = exitFrom(b.landMinX + 1.6, 100, Math.PI);
    expect(p.vehicle).toBeNull();
    expect(p.state).toBe('normal');
    expect(sim.world.waterDepth(p.pos.x, p.pos.z)).toBeLessThan(0);
    expect(p.pos.x).toBeGreaterThan(b.landMinX);
  });

  it('a car on a Marina finger pier: out on the 0.45 m deck', () => {
    const { sim, p } = exitFrom(592.5, 466, 0);
    expect(p.vehicle).toBeNull();
    expect(p.state).toBe('normal');
    expect(sim.world.groundHeight(p.pos.x, p.pos.z)).toBeCloseTo(0.45, 6);
    expect(Math.abs(p.pos.y - 0.45)).toBeLessThan(0.05);
  });

  it('a car sinking in deep water: he still gets out, into the water', () => {
    const sim = makeSim({ world: world(), police: false });
    const b = sim.world.bounds;
    const v = sim.spawnVehicle('sedan', b.beachEndX + 30, 200, 0);
    placeInCar(sim, v);
    step(sim, 0.3);
    if (sim.player.vehicle) sim.update(DT, input({ enterExit: true }));
    step(sim, 1);
    const p = sim.player;
    expect(p.vehicle).toBeNull();
    expect(sim.world.waterDepth(p.pos.x, p.pos.z)).toBeGreaterThan(SWIM_DEPTH);
    expect(p.state).toBe('swimming');
    expect(p.pos.y).toBeCloseTo(WATER_Y - 1.3, 3);
  });
});

// ---------------------------------------------------------------------------
// Low: occupants come out of their own doors

describe('Occupants leave a burning or exploding car by their own doors', () => {
  /** A sedan on an open road with a driver and three passengers. */
  function fourUp(): { sim: Sim; v: Vehicle; crew: Character[] } {
    const sim = makeSim({ world: world(), police: false });
    const r = openRoad(sim);
    const v = sim.spawnVehicle('sedan', r.x + r.fx * 8, r.z + r.fz * 8, r.h);
    const crew = [sim.addDriver(v, 'civilian', 'traffic')];
    for (let seat = 1; seat <= 3; seat++) {
      const c = sim.spawnCharacter('civilian', v.pos.x, v.pos.z);
      sim.seat(c, v, seat);
      crew.push(c);
    }
    return { sim, v, crew };
  }

  /** (x, z) in `v`'s frame: across (towards the driver's side, local +X) and along (forward). */
  function local(v: Vehicle, x: number, z: number): { across: number; along: number } {
    const dx = x - v.pos.x;
    const dz = z - v.pos.z;
    return { across: dx * Math.cos(v.heading) - dz * Math.sin(v.heading), along: dx * Math.sin(v.heading) + dz * Math.cos(v.heading) };
  }

  function apart(crew: Character[]): number {
    let min = Infinity;
    for (let i = 0; i < crew.length; i++) {
      for (let j = i + 1; j < crew.length; j++) min = Math.min(min, Math.hypot(crew[i]!.pos.x - crew[j]!.pos.x, crew[i]!.pos.z - crew[j]!.pos.z));
    }
    return min;
  }

  it('set alight: each bails out on his seat side, the front row ahead of the back, at least 0.6 m apart', () => {
    const { sim, v, crew } = fourUp();
    sim.combat.igniteVehicle(v, 30);
    sim.update(DT, input());
    for (const [seat, c] of crew.entries()) {
      expect(c.vehicle, `seat ${seat}`).toBeNull();
      const l = local(v, c.pos.x, c.pos.z);
      // Seats 0 and 2 on the driver's side (local +X), 1 and 3 on the other.
      expect(Math.sign(l.across), `seat ${seat}`).toBe(seat === 0 || seat === 2 ? 1 : -1);
      expect(Math.abs(l.across), `seat ${seat}`).toBeGreaterThan(v.halfW);
    }
    expect(local(v, crew[0]!.pos.x, crew[0]!.pos.z).along).toBeGreaterThan(local(v, crew[2]!.pos.x, crew[2]!.pos.z).along + 0.6);
    expect(local(v, crew[1]!.pos.x, crew[1]!.pos.z).along).toBeGreaterThan(local(v, crew[3]!.pos.x, crew[3]!.pos.z).along + 0.6);
    expect(apart(crew)).toBeGreaterThanOrEqual(0.6);
  });

  it('blown up with all four inside: four bodies, not one', () => {
    const { sim, v, crew } = fourUp();
    sim.combat.explodeVehicle(v);
    for (const c of crew) expect(c.alive).toBe(false);
    expect(apart(crew)).toBeGreaterThanOrEqual(0.6);
    step(sim, 2);
    expect(apart(crew)).toBeGreaterThanOrEqual(0.6);
  });
});

// ---------------------------------------------------------------------------
// Low: a death in the flames of a car someone set alight is his doing

describe('Fire kills are credited to whoever set the car alight', () => {
  it('in a rampage, a knocked, wounded gangster dies in the flames of a car the player lit: the kill and the rampage count it', () => {
    const sim = makeSim({ world: world(), police: false });
    sim.cheats.godMode = true;
    const r = openRoad(sim);
    teleport(sim, r.x, r.z);
    expect(sim.activities.startRampage('test')).toBe(true);
    const car = sim.spawnVehicle('sedan', r.x + r.fx * 14, r.z + r.fz * 14, r.h);
    sim.combat.damageVehicle(car, car.health + 1, sim.player, 'bullet');
    car.burnTimer = 30;
    const g = npcAt(sim, 'gang', car.pos.x + r.rx * 1.6, car.pos.z + r.rz * 1.6);
    g.missionTag = 'rampage';
    g.health = 8;
    g.state = 'knocked';
    g.knockTimer = 5;
    const civ = npcAt(sim, 'civilian', car.pos.x - r.rx * 1.6, car.pos.z - r.rz * 1.6);
    civ.brain = makeBrain('wander');
    const kills = sim.progress.stats.kills;
    const killed = record(sim, 'characterKilled');
    step(sim, 2);
    const e = killed.find((k) => k.victim === g);
    expect(e).toBeDefined();
    expect(e!.killer).toBe(sim.player);
    expect(sim.progress.stats.kills).toBe(kills + 1);
    const j = sim.activities.job;
    expect(j?.kind === 'rampage' ? j.kills : -1).toBe(1);
    // The flames are no attack: the burned civilian runs from the car, not from the player.
    expect(civ.brain!.mode).toBe('flee');
    expect(civ.brain!.threat).toBeNull();
  });

  it('hit by the player in the same frame, then finished by the flames: bystanders run from the fire, not from him', () => {
    const sim = makeSim({ world: world(), police: false });
    const r = openRoad(sim);
    teleport(sim, r.x - r.fx * 40, r.z - r.fz * 40);
    const car = sim.spawnVehicle('sedan', r.x, r.z, r.h);
    sim.combat.damageVehicle(car, car.health + 1, sim.player, 'bullet');
    car.burnTimer = 30;
    const victim = npcAt(sim, 'civilian', car.pos.x + r.rx * 1.6, car.pos.z + r.rz * 1.6);
    victim.brain = makeBrain('wander');
    victim.health = 34.2;
    const witness = npcAt(sim, 'civilian', car.pos.x + r.rx * 6, car.pos.z + r.rz * 6);
    witness.brain = makeBrain('wander');
    const killed = record(sim, 'characterKilled');
    // A hit of his that nobody saw (no shot heard), then, in the same frame, the flames deal the fatal one.
    sim.combat.damageCharacter(victim, 34, sim.player, 'bullet', 1, 0, 0);
    expect(victim.alive).toBe(true);
    sim.combat.update(DT);
    expect(victim.alive).toBe(false);
    expect(killed.find((k) => k.victim === victim)?.killer).toBe(sim.player);
    expect(witness.brain!.mode).toBe('flee');
    expect(witness.brain!.threat).toBeNull();
  });

  it("a gangster's stray round on a car the player lit does not take over the blame for its explosion", () => {
    const sim = makeSim({ world: world(), police: true });
    const r = openRoad(sim);
    teleport(sim, r.x, r.z);
    const car = sim.spawnVehicle('sedan', r.x + r.fx * 14, r.z + r.fz * 14, r.h);
    const g = npcAt(sim, 'gang', r.x - r.fx * 6, r.z - r.fz * 6);
    sim.combat.damageVehicle(car, car.health + 1, sim.player, 'bullet');
    car.burnTimer = 1;
    sim.combat.damageVehicle(car, 30, g, 'bullet');
    step(sim, 2);
    expect(car.destroyed).toBe(true);
    expect(sim.wanted.level).toBe(1);
    expect(sim.wanted.lastCrime).toBe('explosion');
  });
});

// ---------------------------------------------------------------------------
// Low: fleeing along a seawall

describe('Peds fleeing along a seawall keep out of the sea', () => {
  /** A civilian 3 m inside the coast at (x, z), fleeing for 14 s along `dir` (into the sea at an angle); did he swim? */
  function fleeAlong(x: number, z: number, dirX: number, dirZ: number): boolean {
    const sim = makeSim({ world: world(), police: false });
    const c = npcAt(sim, 'civilian', x, z);
    c.brain = makeBrain('wander');
    sim.peds.flee(c, x - dirX * 400, z - dirZ * 400, null);
    c.brain.lateral = 0;
    teleport(sim, x - dirX * 60, z - dirZ * 60);
    for (let i = 0; i < 60 * 14; i++) {
      sim.update(DT, input());
      if (c.state === 'swimming') return true;
    }
    return false;
  }

  it('west, north and south coasts, flight 0.2 to 1.0 rad off straight out to sea, either way along the shore', () => {
    const b = world().bounds;
    for (const beta of [0.2, 0.4, 0.6, 0.8, 1.0]) {
      const s = Math.sin(beta);
      const k = Math.cos(beta);
      for (const side of [1, -1]) {
        expect(fleeAlong(b.landMinX + 3, 0, -k, side * s), `west ${beta} ${side}`).toBe(false);
        expect(fleeAlong(0, b.landMinZ + 3, side * s, -k), `north ${beta} ${side}`).toBe(false);
        expect(fleeAlong(0, b.landMaxZ - 3, side * s, k), `south ${beta} ${side}`).toBe(false);
      }
    }
  });

  it('on a 4 m Marina finger pier, fleeing at an angle to it: along the pier, never into the water', () => {
    const piers = world().layout.decks.filter((d) => d.name === 'Marina' && d.rect.maxX - d.rect.minX < 6);
    expect(piers.length).toBe(3);
    for (const pier of piers) {
      const x = (pier.rect.minX + pier.rect.maxX) / 2;
      const z = (pier.rect.minZ + pier.rect.maxZ) / 2;
      // The threat 40 m off at 45 degrees on either side, towards the deck or out to sea.
      for (const [sx, sz] of [[1, -1], [-1, -1], [1, 1], [-1, 1]] as const) {
        const sim = makeSim({ world: world(), police: false });
        teleport(sim, x - 100, 300);
        const c = npcAt(sim, 'civilian', x, z);
        c.brain = makeBrain('wander');
        sim.peds.flee(c, x + sx * 40, z + sz * 40, null);
        c.brain.lateral = 0;
        const label = `pier at x ${x}, threat ${sx},${sz}`;
        for (let i = 0; i < 60 * 10; i++) {
          sim.update(DT, input());
          expect(c.state, label).not.toBe('swimming');
        }
        expect(sim.world.waterDepth(c.pos.x, c.pos.z), label).toBeLessThan(0);
      }
    }
  });

  it('one already in the water makes for the shore', () => {
    const sim = makeSim({ world: world(), police: false });
    const b = sim.world.bounds;
    const c = npcAt(sim, 'civilian', b.landMinX - 12, 0);
    c.brain = makeBrain('wander');
    step(sim, 0.2);
    expect(c.state).toBe('swimming');
    sim.peds.flee(c, b.landMinX + 200, 0, null);
    c.brain.lateral = 0;
    // Still running when the test ends (a flight that times out walks him back to a sidewalk anyway).
    c.brain.modeTimer = 30;
    teleport(sim, b.landMinX + 60, 0);
    // 12 m out: straight for the quay takes about 6 s (swimming along the coast, about twice that).
    let out = false;
    for (let i = 0; i < 60 * 8 && !out; i++) {
      sim.update(DT, input());
      out = c.state === 'normal' && sim.world.waterDepth(c.pos.x, c.pos.z) < 0;
    }
    expect(out).toBe(true);
    // And on along the quay, out of the water.
    for (let i = 0; i < 60 * 6; i++) {
      sim.update(DT, input());
      expect(c.state).toBe('normal');
    }
  });
});

// ---------------------------------------------------------------------------
// Low: a clip's last round is drawn with the gun raised

describe("A clip's last round: the gun stays up for the shot, then comes in for the reload", () => {
  it('a cop firing the last round of each gun, and the player firing a rocket', () => {
    for (const gun of ['pistol', 'smg', 'rifle', 'shotgun', 'rocket'] as const) {
      const sim = makeSim({ world: world(), police: false });
      sim.cheats.godMode = true;
      const r = openRoad(sim);
      teleport(sim, r.x, r.z);
      const p = sim.player;
      const cop = npcAt(sim, 'cop', r.x + r.fx * 10, r.z + r.fz * 10);
      cop.heading = r.h + Math.PI;
      cop.inventory.infinite = true;
      cop.inventory.give(gun, 99);
      cop.inventory.current = gun;
      cop.drawnWeapon = gun;
      cop.inventory.slot().clip = 1;
      const fired = record(sim, 'weaponFired');
      sim.combat.npcFire(cop, p, 1);
      expect(fired.length, gun).toBe(1);
      expect(cop.reloadTimer, gun).toBeGreaterThan(0);
      // The frame ends (the timers run) and is drawn: the gun is still raised, its tip where the shot left.
      sim.update(DT, input());
      const pose = weaponPose(cop);
      expect(pose.mode, gun).toBe('raised');
      const e = fired[0]!;
      expect(Math.hypot(e.x - pose.tip.x, e.y - pose.tip.y, e.z - pose.tip.z), gun).toBeLessThan(0.05);
      // Once the shot has been drawn, the reload pose takes over.
      step(sim, 0.1);
      expect(weaponPose(cop).mode, gun).toBe('reload');
    }
    const sim = makeSim({ world: world(), police: false });
    const r = openRoad(sim);
    teleport(sim, r.x, r.z);
    const p = sim.player;
    p.heading = r.h;
    p.inventory.give('rocket', 4);
    p.inventory.current = 'rocket';
    step(sim, 0.4);
    const target = { x: r.x + r.fx * 30, y: p.pos.y + 1.2, z: r.z + r.fz * 30 };
    step(sim, 0.3, () => aimAt(sim, target, { aim: true }));
    const fired = record(sim, 'weaponFired');
    sim.update(DT, aimAt(sim, target, { aim: true, fire: true, firePressed: true }));
    expect(fired.length).toBe(1);
    expect(p.reloadTimer).toBeGreaterThan(0);
    expect(weaponPose(p).mode).toBe('raised');
    step(sim, 0.1, () => aimAt(sim, target, { aim: true }));
    expect(weaponPose(p).mode).toBe('reload');
  });
});

// ---------------------------------------------------------------------------
// Low: a cowering civilian is hit where he is drawn

describe('A cowering civilian crouched with his hands over his head is hit where he is drawn', () => {
  type Part = { mesh: THREE.InstancedMesh };

  /** The drawn figure of the only character drawn: its top, and the middle of its footprint. */
  function drawnFigure(c: Character): { top: number; x: number; z: number } {
    const cv = new CrowdView();
    for (let i = 0; i < 30; i++) cv.sync([c], c.pos.x, c.pos.z, DT);
    const parts = (cv as unknown as { parts: Record<string, Part> }).parts;
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    let top = -Infinity;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const p of Object.values(parts)) {
      const pos = p.mesh.geometry.getAttribute('position');
      for (let k = 0; k < p.mesh.count; k++) {
        p.mesh.getMatrixAt(k, m);
        for (let i = 0; i < pos.count; i++) {
          v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
          top = Math.max(top, v.y);
          x0 = Math.min(x0, v.x);
          x1 = Math.max(x1, v.x);
          z0 = Math.min(z0, v.z);
          z1 = Math.max(z1, v.z);
        }
      }
    }
    return { top, x: (x0 + x1) / 2, z: (z0 + z1) / 2 };
  }

  /** Who a level round fired from 6 m away along `yaw`, at height `y`, through (x, z), hits, and where. */
  function round(sim: Sim, x: number, y: number, z: number, yaw: number): { who: Character | null; zone: string } {
    const dx = Math.sin(yaw);
    const dz = Math.cos(yaw);
    const r = sim.combat.castRay(x - dx * 6, y, z - dz * 6, dx, 0, dz, 12, null);
    return { who: r.character, zone: r.zone };
  }

  it('rounds just over the drawn crouch miss him, rounds through it hit his body; held at gunpoint he stands and is hit standing', () => {
    for (const height of [0.9, 1, 1.07]) {
      const sim = makeSim({ world: world(), police: false });
      const r = openRoad(sim);
      // The player 12 m off, not aiming yet.
      teleport(sim, r.x - r.fx * 12, r.z - r.fz * 12);
      const c = npcAt(sim, 'civilian', r.x, r.z);
      c.appearance = { ...c.appearance, height };
      c.height = 1.8 * height;
      c.heading = r.h + 0.7;
      c.brain = makeBrain('cower');
      c.brain.modeTimer = 30;
      const fig = drawnFigure(c);
      // Crouched: the drawn figure ends well below his standing height.
      expect(fig.top - c.pos.y, `${height}`).toBeLessThan(0.75 * c.height);
      for (let k = 0; k < 8; k++) {
        const yaw = (k / 8) * Math.PI * 2;
        const label = `height ${height}, from ${k * 45} degrees`;
        expect(round(sim, fig.x, fig.top + 0.03, fig.z, yaw).who, label).not.toBe(c);
        expect(round(sim, fig.x, c.pos.y + 0.93 * c.height, fig.z, yaw).who, label).not.toBe(c);
        const mid = round(sim, fig.x, c.pos.y + 0.5 * (fig.top - c.pos.y), fig.z, yaw);
        expect(mid.who, label).toBe(c);
        expect(mid.zone, label).toBe('body');
      }
      // The player points a gun at him: he stands with his hands up, and a round at head height hits his head.
      const p = sim.player;
      p.inventory.give('pistol', 20);
      p.inventory.current = 'pistol';
      p.aiming = true;
      p.aimYaw = Math.atan2(c.pos.x - p.pos.x, c.pos.z - p.pos.z);
      const head = round(sim, c.pos.x, c.pos.y + 0.93 * c.height, c.pos.z, r.h + Math.PI / 2);
      expect(head.who, `${height}`).toBe(c);
      expect(head.zone, `${height}`).toBe('head');
    }
  });
});
