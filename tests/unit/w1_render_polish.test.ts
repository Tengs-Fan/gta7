// Track D (wave 1) render polish: pedestrians fade in, removed bodies and wrecks fade out, and a shot-down helicopter
// burns, trails smoke and comes down on roofs and structures instead of through them.

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CrowdView, PED_FADE_IN, PED_FADE_OUT } from '../../src/render/crowd';
import { GameRenderer, VEHICLE_FADE_OUT } from '../../src/render/renderer';
import { PART_LAYER, VehiclePartBatches } from '../../src/render/vehicleBatches';
import { VehicleView } from '../../src/render/vehicleView';
import { Helicopter, type Character, type Vehicle } from '../../src/sim/entities';
import { ferrisDisc, HELI_BOTTOM } from '../../src/sim/heliCrash';
import type { Sim } from '../../src/sim/sim';
import { GARAGE_ROOF, type StaticWorld } from '../../src/world/staticWorld';
import { makeSim, step, world } from './helpers';

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
    readonly capabilities = { getMaxAnisotropy: () => 16 };
    readonly xr = { enabled: false };
    readonly coordinateSystem = actual.WebGLCoordinateSystem;
    autoClear = true;
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas ?? new EventTarget();
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
    getRenderTarget(): unknown {
      return null;
    }
    setRenderTarget(): void {}
    getActiveCubeFace(): number {
      return 0;
    }
    getActiveMipmapLevel(): number {
      return 0;
    }
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const DT = 1 / 60;

type Parts = Record<string, { mesh: THREE.InstancedMesh }>;
const headOf = (cv: CrowdView): THREE.InstancedMesh => (cv as unknown as { parts: Parts }).parts.head!.mesh;
const fadesDrawn = (cv: CrowdView): number[] => {
  const m = headOf(cv);
  const a = m.geometry.getAttribute('instanceFade').array as Float32Array;
  return Array.from(a.subarray(0, m.count));
};

describe('pedestrian fades', () => {
  it('a pedestrian drawn for the first time starts invisible and is whole after PED_FADE_IN, the player at once', () => {
    expect(PED_FADE_IN).toBeGreaterThanOrEqual(0.3);
    expect(PED_FADE_IN).toBeLessThanOrEqual(1);
    const sim = makeSim();
    const p = sim.player.pos;
    const ped = sim.spawnCharacter('civilian', p.x + 8, p.z + 3);
    const cv = new CrowdView();
    const sync = (): void => cv.sync([sim.player, ped], p.x, p.z, DT, sim.player.id);
    sync();
    expect(cv.fadeOf(sim.player)).toBe(1);
    expect(cv.fadeOf(ped)).toBe(0);
    expect(fadesDrawn(cv).sort()).toEqual([0, 1]);
    expect(cv.firstDrawn.map((e) => e.id)).toEqual([ped.id]);
    let t = 0;
    while ((cv.fadeOf(ped) ?? 0) < 1) {
      sync();
      t += DT;
      if (t < 0.3) expect(cv.fadeOf(ped)!).toBeLessThan(1);
    }
    expect(t).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(t).toBeLessThanOrEqual(1 + 1e-9);
    expect(fadesDrawn(cv)).toEqual([1, 1]);
  });

  it('another player\'s character (role player) arriving in view is whole at once, like the local one', () => {
    const sim = makeSim();
    const p = sim.player.pos;
    const other = sim.spawnCharacter('player', p.x + 8, p.z + 3);
    const cv = new CrowdView();
    cv.sync([sim.player, other], p.x, p.z, DT, sim.player.id);
    expect(cv.fadeOf(other)).toBe(1);
    expect(cv.firstDrawn.map((e) => e.id)).not.toContain(other.id);
  });

  it('the shadow fades with the body: the depth material carries the same per-instance fade', () => {
    const cv = new CrowdView();
    const depth = headOf(cv).customDepthMaterial!;
    expect(depth).toBeInstanceOf(THREE.MeshDepthMaterial);
    const s = { vertexShader: THREE.ShaderLib.depth.vertexShader, fragmentShader: THREE.ShaderLib.depth.fragmentShader, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
    depth.onBeforeCompile(s, undefined as unknown as THREE.WebGLRenderer);
    expect(s.vertexShader).toContain('vInstanceFade = instanceFade;');
    expect(s.fragmentShader).toContain('lensBayer4( gl_FragCoord.xy ) >= vInstanceFade ) discard;');
  });

  it('riders and people getting out of cars are whole; a body removed in view fades out over PED_FADE_OUT', () => {
    const sim = makeSim();
    const p = sim.player.pos;
    const v = sim.spawnVehicle('sedan', p.x + 6, p.z, 0);
    const driver = sim.spawnCharacter('civilian', p.x + 6, p.z);
    sim.seat(driver, v, 0);
    const cv = new CrowdView();
    const sync = (list: Character[]): void => cv.sync(list, p.x, p.z, DT, sim.player.id);
    sync([sim.player, driver]);
    expect(cv.fadeOf(driver)).toBe(1);
    sim.unseat(driver);
    sync([sim.player, driver]);
    expect(cv.fadeOf(driver)).toBe(1);
    // Dead, then cleared away: still drawn, fading, then gone.
    driver.state = 'dead';
    for (let i = 0; i < 10; i++) sync([sim.player, driver]);
    driver.removed = true;
    let frames = 0;
    let last = 1;
    while (cv.fadeOf(driver) !== undefined) {
      sync([sim.player]);
      const f = cv.fadeOf(driver);
      if (f === undefined) break;
      expect(f).toBeLessThan(last);
      last = f;
      expect(headOf(cv).count).toBe(2);
      frames++;
    }
    expect(frames * DT).toBeGreaterThanOrEqual(PED_FADE_OUT - 2 * DT);
    expect(PED_FADE_OUT).toBeGreaterThanOrEqual(0.5);
    // Fully faded: no longer drawn at all, so no shadow either.
    expect(headOf(cv).count).toBe(1);
  });

  it('a new session starts clean: nothing of the old one fades over it', () => {
    const sim = makeSim();
    const p = sim.player.pos;
    const ped = sim.spawnCharacter('civilian', p.x + 5, p.z);
    const cv = new CrowdView();
    for (let i = 0; i < 60; i++) cv.sync([sim.player, ped], p.x, p.z, DT, sim.player.id);
    ped.removed = true;
    cv.reset();
    const next = makeSim();
    cv.sync([next.player], p.x, p.z, DT, next.player.id);
    expect(headOf(cv).count).toBe(1);
    expect(cv.fadeOf(ped)).toBeUndefined();
  });
});

describe('vehicle fades', () => {
  it('a fading view draws its own meshes with hashed-alpha copies, fades its parts inside the batches, its shadow fades, and it comes back as it was', () => {
    const sim = makeSim();
    const v = sim.spawnVehicle('police', 0, 0, 0);
    v.destroyed = true;
    const view = new VehicleView('police');
    view.bind(v);
    view.sync(v, DT, 0, 0);
    const materials = new Map<THREE.Mesh, THREE.Material>();
    view.group.traverse((o) => {
      if (o instanceof THREE.Mesh) materials.set(o, o.material as THREE.Material);
    });
    const batches = new VehiclePartBatches();
    view.beginFade();
    view.setFade(0.4);
    let own = 0;
    for (const [mesh, original] of materials) {
      if (mesh.name === 'shadow') {
        expect((mesh.customDepthMaterial as THREE.MeshDepthMaterial).alphaHash).toBe(true);
        expect(mesh.customDepthMaterial!.opacity).toBeCloseTo(0.4);
        continue;
      }
      const m = mesh.material as THREE.Material;
      // The parts the batches draw stay batched (no camera draws the mesh), with their own materials.
      if (mesh.userData.batched || !mesh.visible) {
        expect(m).toBe(original);
        if (mesh.userData.batched) expect(mesh.layers.isEnabled(PART_LAYER)).toBe(true);
        continue;
      }
      own++;
      expect(m).not.toBe(original);
      if (original.transparent) expect(m.opacity).toBeCloseTo(original.opacity * 0.4);
      else {
        expect(m.alphaHash).toBe(true);
        expect(m.opacity).toBeCloseTo(0.4);
      }
    }
    expect(own).toBeGreaterThan(0);
    // Its instances in the batches carry what is left of it.
    batches.begin();
    view.drawParts(batches);
    batches.end();
    const fades = new Set<number>();
    for (const m of batches.group.children as THREE.InstancedMesh[]) {
      const a = m.geometry.getAttribute('instanceFade');
      for (let i = 0; i < m.count; i++) fades.add(Math.round(a.getX(i) * 100) / 100);
    }
    expect([...fades]).toEqual([0.4]);
    view.setFade(0);
    expect(view.group.visible).toBe(false);
    const used = view.endFade();
    expect(used.length).toBe(own + 1);
    for (const [mesh, original] of materials) {
      expect(mesh.material).toBe(original);
      if (mesh.userData.batched) expect(mesh.layers.isEnabled(PART_LAYER)).toBe(true);
    }
    // Whole again afterwards.
    batches.begin();
    view.group.visible = true;
    view.drawParts(batches);
    batches.end();
    for (const m of batches.group.children as THREE.InstancedMesh[]) {
      const a = m.geometry.getAttribute('instanceFade');
      for (let i = 0; i < m.count; i++) expect(a.getX(i)).toBe(1);
    }
    for (const m of used) m.dispose();
    batches.dispose();
  });

  describe('in the renderer', () => {
    let W: StaticWorld;
    let R: GameRenderer;
    beforeAll(() => {
      W = world();
      R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, W, { quality: 'high', fov: 68 });
    });
    const views = (): Map<number, VehicleView> => (R as unknown as { vehicleViews: Map<number, VehicleView> }).vehicleViews;
    const fading = (): Array<{ view: VehicleView }> => (R as unknown as { fadingViews: Array<{ view: VehicleView }> }).fadingViews;

    function ahead(sim: Sim, d: number): Vehicle {
      const cam = R.cameraCtl.camera;
      const dir = cam.getWorldDirection(new THREE.Vector3());
      const l = Math.hypot(dir.x, dir.z) || 1;
      const v = sim.spawnVehicle('sedan', cam.position.x + (dir.x / l) * d, cam.position.z + (dir.z / l) * d, 0);
      v.destroyed = true;
      v.wreckTime = 60;
      return v;
    }

    it('a wreck cleared away in view fades out over VEHICLE_FADE_OUT; one out of view goes at once; the sim is untouched', () => {
      const sim = makeSim({ world: W });
      R.attach(sim);
      R.cameraCtl.mode = 'play';
      R.cameraCtl.reset(sim);
      R.render(DT, false);
      const wreck = ahead(sim, 50);
      step(sim, DT);
      R.render(DT, false);
      const view = views().get(wreck.id)!;
      expect(view).toBeDefined();
      sim.removeVehicle(wreck);
      expect(sim.vehicles.includes(wreck) && !wreck.removed).toBe(false);
      let frames = 0;
      while (true) {
        R.render(DT, false);
        if (!fading().some((e) => e.view === view)) break;
        expect(view.group.parent).toBe(R.scene);
        frames++;
        expect(frames).toBeLessThan(200);
      }
      expect(VEHICLE_FADE_OUT).toBeGreaterThanOrEqual(0.5);
      expect(frames * DT).toBeGreaterThanOrEqual(0.5);
      expect(view.group.parent).toBeNull();
      // Behind the camera: no fade.
      const cam = R.cameraCtl.camera;
      const back = ahead(sim, -50);
      void cam;
      R.render(DT, false);
      sim.removeVehicle(back);
      R.render(DT, false);
      expect(fading().length).toBe(0);
    });
  });
});

describe('a shot-down helicopter', () => {
  function drop(sim: Sim, x: number, y: number, z: number, vx = 0, vz = 0): { h: Helicopter; path: Array<[number, number, number]> } {
    const h = new Helicopter(sim.newId(), x, y, z);
    h.health = 0;
    h.vel.x = vx;
    h.vel.z = vz;
    sim.helis.push(h);
    const path: Array<[number, number, number]> = [];
    for (let i = 0; i < 60 * 20 && !h.removed; i++) {
      step(sim, DT);
      path.push([h.pos.x, h.pos.y, h.pos.z]);
    }
    expect(h.removed).toBe(true);
    return { h, path };
  }

  it('burns and trails smoke every frame of its fall', () => {
    const W = world();
    const R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, W, { quality: 'low', fov: 68 });
    const sim = makeSim({ world: W });
    R.attach(sim);
    const p = sim.player.pos;
    const h = new Helicopter(sim.newId(), p.x + 30, 80, p.z);
    h.health = 0;
    sim.helis.push(h);
    const spy = vi.spyOn(R.effects, 'heliCrash');
    let frames = 0;
    for (let i = 0; i < 120 && !h.removed; i++) {
      step(sim, DT);
      if (h.removed) break;
      spy.mockClear();
      R.render(DT, false);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]!.slice(0, 3)).toEqual([h.pos.x, h.pos.y, h.pos.z]);
      frames++;
    }
    expect(frames).toBeGreaterThan(30);
  });

  it('comes to rest on the roof of every garage and the police station, sparing the cars parked inside', () => {
    const W = world();
    const rows: string[] = [];
    const roofs: Array<{ name: string; x: number; z: number; top: number }> = W.layout.garages.map((g) => ({ name: `garage ${g.poi}`, x: (g.rect.minX + g.rect.maxX) / 2, z: (g.rect.minZ + g.rect.maxZ) / 2, top: g.height + GARAGE_ROOF }));
    const station = W.layout.buildings.find((b) => b.special === 'police')!;
    const t = station.tiers[station.tiers.length - 1]!;
    roofs.push({ name: 'police station', x: (t.minX + t.maxX) / 2, z: (t.minZ + t.maxZ) / 2, top: Math.max(...station.tiers.map((q) => q.y1)) });
    expect(roofs.some((r) => r.name === 'garage lou')).toBe(true);
    for (const r of roofs) {
      const sim = makeSim({ world: W });
      const parked = r.name.startsWith('garage') ? sim.spawnVehicle('sedan', r.x, r.z, 0) : null;
      const health = parked?.health;
      const { h } = drop(sim, r.x, r.top + 30, r.z);
      const low = h.pos.y - HELI_BOTTOM;
      rows.push(`${r.name}: roof ${r.top.toFixed(2)} m, rest (lowest point) ${low.toFixed(2)} m`);
      expect(low, r.name).toBeGreaterThanOrEqual(r.top - 1e-6);
      expect(low, r.name).toBeLessThanOrEqual(r.top + 0.3);
      if (parked) expect(parked.health, r.name).toBe(health);
    }
    console.log(rows.join('\n'));
  });

  it('stops at the lighthouse, every crane leg and the Ferris wheel instead of passing through them', () => {
    const W = world();
    const rows: string[] = [];
    const inside = (x: number, y: number, z: number): string | null => {
      let what: string | null = null;
      W.grid.query(x, z, x, z, (c) => {
        if (c.tag !== 'pillar' || y > c.y1 || y < c.y0) return;
        if (c.circle ? Math.hypot(x - c.cx, z - c.cz) < c.r : x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ) what = 'pillar';
      });
      const f = ferrisDisc(W);
      if (f) {
        const dx = x - f.x;
        const dy = y - f.y;
        const dz = z - f.z;
        const along = dx * f.ax + dz * f.az;
        if (Math.abs(along) < f.half && Math.sqrt(dx * dx + dy * dy + dz * dz - along * along) < f.r) what = 'ferris';
      }
      return what;
    };
    const targets: Array<{ name: string; x: number; z: number; top: number }> = [];
    for (const p of W.layout.props) {
      if (p.kind === 'lighthouse') targets.push({ name: 'lighthouse', x: p.x, z: p.z, top: p.y + 26 });
      if (p.kind === 'crane') for (const [lx, lz] of [[-6, -5], [6, -5], [-6, 5], [6, 5]] as const) targets.push({ name: `crane leg ${lx},${lz}`, x: p.x + lx, z: p.z + lz, top: 30 });
    }
    const f = ferrisDisc(W)!;
    expect(f).not.toBeNull();
    expect(targets.some((t) => t.name === 'lighthouse')).toBe(true);
    expect(targets.filter((t) => t.name.startsWith('crane')).length).toBeGreaterThanOrEqual(4);
    for (const t of targets) {
      // Straight down onto it, and in from the side below its top.
      for (const [label, sx, sy, vx] of [['above', 0, 25, 0], ['side', -18, -8, 22]] as const) {
        const sim = makeSim({ world: W });
        const { h, path } = drop(sim, t.x + sx, t.top + sy, t.z, vx, 0);
        const crossed = path.some(([x, y, z]) => inside(x, y, z) !== null);
        rows.push(`${t.name} (${label}): ended at ${h.pos.x.toFixed(1)}, ${h.pos.y.toFixed(1)}, ${h.pos.z.toFixed(1)}; crossed ${crossed}`);
        expect(crossed, `${t.name} ${label}`).toBe(false);
        expect(h.pos.y - HELI_BOTTOM, `${t.name} ${label}`).toBeGreaterThan(1);
      }
    }
    for (const [label, start, speed] of [['above the rim', [f.x, f.y + f.r + 20, f.z], 0], ['at the hub, side on', [f.x - f.ax * 25, f.y, f.z - f.az * 25], 25]] as const) {
      const sim = makeSim({ world: W });
      const { h, path } = drop(sim, start[0], start[1], start[2], f.ax * speed, f.az * speed);
      const crossed = path.some(([x, y, z]) => inside(x, y, z) === 'ferris');
      rows.push(`Ferris wheel (${label}): ended at ${h.pos.x.toFixed(1)}, ${h.pos.y.toFixed(1)}, ${h.pos.z.toFixed(1)}; crossed ${crossed}`);
      expect(crossed, label).toBe(false);
      expect(h.pos.y - HELI_BOTTOM, label).toBeGreaterThan(2);
    }
    console.log(rows.join('\n'));
  });
});
