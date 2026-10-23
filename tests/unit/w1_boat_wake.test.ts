// A boat under way leaves a wake and throws spray (Effects.boatWake, driven by the renderer's vehicleEffects) on the
// tiers that draw spray, High and Medium, and none on Low or software. It reuses the effects' pooled particle layer, so
// it adds no geometry, texture or shader to any tier. The render modules run headless on the stub header of
// r2_vehicles.test.ts (copied: vi.hoisted cannot be shared).

import { beforeAll, describe, expect, it, vi } from 'vitest';

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

import { BOAT_WAKE_MIN, boatWakeLevel, Effects } from '../../src/render/effects';
import { GameRenderer } from '../../src/render/renderer';
import type { Vehicle } from '../../src/sim/entities';
import type { VehicleKind } from '../../src/sim/specs';
import { WATER_Y } from '../../src/world/constants';
import type { StaticWorld } from '../../src/world/staticWorld';
import { makeSim, world } from './helpers';

const DT = 1 / 60;

function boatAt(kind: VehicleKind, x: number, z: number, heading: number, speed: number): Vehicle {
  const sim = makeSim({ world: world() });
  const v = sim.spawnVehicle(kind, x, z, heading);
  v.pos.y = WATER_Y;
  v.vel.x = Math.sin(heading) * speed;
  v.vel.z = Math.cos(heading) * speed;
  return v;
}

/** Wake particles emitted over `seconds` of a boat holding `speed`. */
function emitted(kind: VehicleKind, speed: number, seconds = 2): number {
  const fx = new Effects();
  const v = boatAt(kind, 0, 0, 0.7, speed);
  let total = 0;
  for (let i = 0; i < seconds / DT; i++) {
    fx.boatWake(v, WATER_Y, DT);
    fx.update(DT, 0);
    total += fx.wakeSprites;
  }
  return total;
}

describe('boat wake strength', () => {
  it('is nothing at rest or drifting, grows with speed and tops out at 1', () => {
    expect(boatWakeLevel(0)).toBe(0);
    expect(boatWakeLevel(BOAT_WAKE_MIN)).toBe(0);
    expect(boatWakeLevel(BOAT_WAKE_MIN * 0.5)).toBe(0);
    let last = 0;
    for (const s of [3, 6, 10, 14, 17]) {
      expect(boatWakeLevel(s)).toBeGreaterThan(last);
      last = boatWakeLevel(s);
    }
    expect(boatWakeLevel(34)).toBe(1);
    expect(boatWakeLevel(-20)).toBe(0);
  });
});

describe('Effects.boatWake', () => {
  it.each(['speedboat', 'dinghy'] as const)('a stopped %s leaves nothing, a moving one foam and spray that grow with speed', (kind) => {
    const fx = new Effects();
    const still = boatAt(kind, 0, 0, 0, 0);
    for (let i = 0; i < 60; i++) {
      fx.boatWake(still, WATER_Y, DT);
      fx.update(DT, 0);
    }
    expect(fx.particleCount).toBe(0);
    expect(fx.wakeBoats).toBe(0);
    expect(fx.wakeSprites).toBe(0);

    const slow = emitted(kind, 4);
    const fast = emitted(kind, 14);
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(slow * 1.5);
  });

  it('counts the boats under way each frame, and drops to 0 the frame after they stop', () => {
    const fx = new Effects();
    const a = boatAt('speedboat', 0, 0, 0, 12);
    const b = boatAt('dinghy', 20, 0, 1, 8);
    fx.boatWake(a, WATER_Y, DT);
    fx.boatWake(b, WATER_Y, DT);
    fx.update(DT, 0);
    expect(fx.wakeBoats).toBe(2);
    // Even paused (dt 0) a boat under way is counted, though nothing new is emitted.
    fx.boatWake(a, WATER_Y, 0);
    fx.update(0, 0);
    expect(fx.wakeBoats).toBe(1);
    expect(fx.wakeSprites).toBe(0);
    a.vel.x = a.vel.z = 0;
    fx.boatWake(a, WATER_Y, DT);
    fx.update(DT, 0);
    expect(fx.wakeBoats).toBe(0);
  });

  it('foam trails behind the stern, spray starts at the bow, and a backing boat swaps them', () => {
    const fx = new Effects();
    const smoke = (fx as unknown as { smoke: { max: number; life: Float32Array; pz: Float32Array } }).smoke;
    const ahead = (): { min: number; max: number } => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < smoke.max; i++) {
        if (!(smoke.life[i]! > 0)) continue;
        min = Math.min(min, smoke.pz[i]!);
        max = Math.max(max, smoke.pz[i]!);
      }
      return { min, max };
    };
    const v = boatAt('speedboat', 0, 0, 0, 12);
    for (let i = 0; i < 10; i++) fx.boatWake(v, WATER_Y, DT);
    const fwd = ahead();
    // Nothing starts ahead of the bow or further forward than a droplet's first hop, and the foam starts behind the hull.
    expect(fwd.min).toBeLessThan(-v.halfL * 0.5);
    expect(fwd.max).toBeLessThan(v.halfL + 0.5);
    const back = new Effects();
    const smokeB = (back as unknown as { smoke: typeof smoke }).smoke;
    v.vel.z = -6;
    for (let i = 0; i < 10; i++) back.boatWake(v, WATER_Y, DT);
    let maxB = -Infinity;
    for (let i = 0; i < smokeB.max; i++) if (smokeB.life[i]! > 0) maxB = Math.max(maxB, smokeB.pz[i]!);
    expect(maxB).toBeGreaterThan(v.halfL * 0.5);
  });

  it('a crowd of fast boats stays within the particle pool and adds no scene objects', () => {
    const fx = new Effects();
    const children = fx.group.children.length;
    const boats = Array.from({ length: 12 }, (_, i) => boatAt('speedboat', i * 9, 0, i * 0.5, 34));
    let peak = 0;
    for (let f = 0; f < 600; f++) {
      for (const v of boats) fx.boatWake(v, WATER_Y, DT);
      fx.update(DT, 0);
      peak = Math.max(peak, fx.particleCount);
    }
    expect(peak).toBeGreaterThan(200);
    expect(peak).toBeLessThanOrEqual(3000);
    expect(fx.group.children.length).toBe(children);
  });
});

describe('the renderer draws the wake by tier', () => {
  let W: StaticWorld;
  let R: GameRenderer;

  beforeAll(() => {
    W = world();
    R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, W, { quality: 'high', fov: 68 });
  });

  it('High and Medium show it for a boat under way and not for a stopped one, Low skips it, and the pool stays one object', () => {
    const sim = makeSim({ world: W });
    R.attach(sim);
    const p = sim.player.pos;
    const boat = sim.spawnVehicle('speedboat', p.x + 6, p.z, 0.4);
    // The title flyover circles far from the player: the wake is drawn near the play camera.
    R.cameraCtl.mode = 'play';
    for (let i = 0; i < 120; i++) R.render(0.1, false);
    const run = (speed: number, frames = 30): { boats: number; sprites: number; particles: number } => {
      let boats = 0;
      let sprites = 0;
      for (let i = 0; i < frames; i++) {
        boat.pos.y = WATER_Y;
        boat.vel.x = Math.sin(boat.heading) * speed;
        boat.vel.z = Math.cos(boat.heading) * speed;
        R.render(DT, false);
        const st = R.stats();
        boats = Math.max(boats, st.wakeBoats);
        sprites += st.wakeSprites;
      }
      return { boats, sprites, particles: R.stats().particles };
    };
    const children = R.effects.group.children.length;
    for (const tier of ['high', 'medium', 'high', 'medium'] as const) {
      R.setQuality(tier);
      const moving = run(14);
      expect(moving.boats, tier).toBe(1);
      expect(moving.sprites, tier).toBeGreaterThan(0);
      expect(moving.particles, tier).toBeGreaterThan(0);
      expect(run(0, 200).particles, tier).toBe(0);
      expect(run(0).boats, tier).toBe(0);
    }
    R.setQuality('low');
    const low = run(14);
    expect(low.boats).toBe(0);
    expect(low.sprites).toBe(0);
    expect(R.effects.group.children.length).toBe(children);
  });
});
