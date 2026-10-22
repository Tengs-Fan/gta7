// Weather in the atmosphere (render/environment.ts, render/renderer.ts): cloud, sun, shadow, fog, exposure and the
// colour grade follow the sim's weather; lightning flashes the sky only while the setting allows. Also the weather
// settings. Headless, with the stub header of light_sprites.test.ts.

import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GameRenderer, lightningFlash } from '../../src/render/renderer';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../../src/settings';
import { WEATHER_KINDS, WeatherSystem, type WeatherKind, type WeatherState } from '../../src/sim/weather';
import { GameClock } from '../../src/sim/clock';
import { Emitter } from '../../src/core/emitter';
import type { SimEvents } from '../../src/sim/events';
import type { StaticWorld } from '../../src/world/staticWorld';
import { input, makeSim, world } from './helpers';

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
    setRenderTarget(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const DT = 1 / 60;
const HDR = { renderer: '', halfFloat: true };
const canvas = (): HTMLCanvasElement => document.createElement('canvas') as unknown as HTMLCanvasElement;

let W: StaticWorld;
beforeAll(() => {
  W = world();
});

/** The steady weather of a kind, as the sim reports it. */
function steady(kind: WeatherKind): WeatherState {
  const w = new WeatherSystem(7, 'clear');
  const clock = new GameClock(12);
  const ev = new Emitter<SimEvents>();
  w.update(DT, clock, ev, { x: 0, y: 0, z: 0 });
  w.override(kind, 0);
  w.update(DT, clock, ev, { x: 0, y: 0, z: 0 });
  return { ...w.state, wind: { ...w.state.wind } };
}

describe('atmosphere in weather', () => {
  function look(kind: WeatherKind, hours = 12) {
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: { renderer: '', halfFloat: false } });
    const env = r.env;
    env.update(hours, new THREE.Vector3(), r.cameraCtl.camera, 0, r.renderer, steady(kind));
    const u = (env.sky.material as THREE.ShaderMaterial).uniforms;
    const out = {
      cloudT: u.uCloudT!.value as number,
      overcast: u.uOvercast!.value as number,
      sun: env.sun.intensity,
      shadow: env.sun.shadow.intensity,
      fogFar: env.fog.far,
      fogNear: env.fog.near,
      exposure: r.renderer.toneMappingExposure,
      top: (u.uTop!.value as THREE.Color).clone(),
    };
    r.dispose();
    return out;
  }

  it('clear, cloudy, overcast, rain and storm grow cloud, dim the sun, soften shadows and close the fog in', () => {
    const order = ['clear', 'cloudy', 'overcast', 'rain', 'storm'] as const;
    const looks = order.map((k) => look(k));
    for (let i = 1; i < looks.length; i++) {
      const [a, b] = [looks[i - 1]!, looks[i]!];
      expect(b.cloudT, order[i]).toBeLessThanOrEqual(a.cloudT); // more of the sky exceeds a lower threshold
      expect(b.sun, order[i]).toBeLessThanOrEqual(a.sun);
      expect(b.shadow, order[i]).toBeLessThanOrEqual(a.shadow);
      expect(b.fogFar, order[i]).toBeLessThanOrEqual(a.fogFar);
    }
    const [clear, , overcast, rain, storm] = looks;
    expect(storm!.sun).toBeLessThan(clear!.sun * 0.5);
    expect(rain!.fogFar).toBeLessThanOrEqual(clear!.fogFar * 0.6);
    expect(overcast!.exposure).not.toBe(clear!.exposure);
    expect(overcast!.overcast).toBeGreaterThan(0.8);
    // The sky goes grey: less blue over red than in clear weather.
    expect(overcast!.top.b / overcast!.top.r).toBeLessThan(clear!.top.b / clear!.top.r);
  });

  it('every weather kind keeps the env inputs finite at all hours', () => {
    for (const kind of WEATHER_KINDS) {
      for (const h of [0, 6, 12, 18.4, 23]) {
        const l = look(kind, h);
        for (const v of [l.cloudT, l.sun, l.shadow, l.fogFar, l.fogNear, l.exposure]) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('without weather the update is as before (clear)', () => {
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: { renderer: '', halfFloat: false } });
    const cam = r.cameraCtl.camera;
    r.env.update(12, new THREE.Vector3(), cam, 0, r.renderer);
    const a = { sun: r.env.sun.intensity, far: r.env.fog.far, exp: r.renderer.toneMappingExposure };
    r.env.update(12, new THREE.Vector3(), cam, 0, r.renderer, steady('clear'));
    expect({ sun: r.env.sun.intensity, far: r.env.fog.far, exp: r.renderer.toneMappingExposure }).toEqual(a);
    r.dispose();
  });
});

describe('renderer weather wiring', () => {
  function setup(kind: WeatherKind) {
    const sim = makeSim({ world: W });
    sim.clock.set(22);
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    r.attach(sim);
    r.cameraCtl.mode = 'play';
    r.cameraCtl.reset(sim);
    sim.weather.override(kind, 0);
    const frame = () => {
      sim.update(DT, input());
      r.render(DT, false);
    };
    frame();
    const sky = (r.env.sky.material as THREE.ShaderMaterial).uniforms;
    return { sim, r, frame, sky };
  }

  it('a strike flashes the sky and the fill light for under half a second', () => {
    // Rain: no strikes of its own during the check.
    const { sim, r, frame, sky } = setup('rain');
    const hemi0 = r.env.hemi.intensity;
    expect(sky.uFlash!.value).toBe(0);
    sim.weather.strike(sim.events, sim.playerPos());
    frame();
    expect(sky.uFlash!.value).toBeGreaterThan(0.5);
    expect(r.env.hemi.intensity).toBeGreaterThan(hemi0 + 0.5);
    for (let i = 0; i < 36; i++) frame();
    expect(sky.uFlash!.value).toBe(0);
    expect(r.env.hemi.intensity).toBeCloseTo(hemi0, 6);
    r.dispose();
  });

  it('with lightning flashes off, a strike changes no sky or light uniform', () => {
    // The same storm twice, a strike in one of them only: every frame draws alike.
    const a = setup('storm');
    const b = setup('storm');
    for (const x of [a, b]) x.r.lightningFlashes = false;
    let strikes = 0;
    a.sim.events.on('lightning', () => strikes++);
    a.sim.weather.strike(a.sim.events, a.sim.playerPos());
    const snap = (x: typeof a) => ({
      flash: x.sky.uFlash!.value as number,
      hemi: x.r.env.hemi.intensity,
      hemiColor: x.r.env.hemi.color.getHex(),
      sun: x.r.env.sun.intensity,
      top: (x.sky.uTop!.value as THREE.Color).getHex(),
      exposure: x.r.renderer.toneMappingExposure,
    });
    for (let i = 0; i < 10; i++) {
      a.frame();
      b.frame();
      expect(snap(a).flash).toBe(0);
      expect(snap(a)).toEqual(snap(b));
    }
    expect(strikes).toBeGreaterThanOrEqual(1);
    expect(a.sim.weather.state.kind).toBe('storm');
    a.r.dispose();
    b.r.dispose();
  });

  it('the colour grade follows the weather', () => {
    const { sim, r, frame } = setup('clear');
    sim.clock.set(12);
    frame();
    const clear = { ...r.post, sat: (r as unknown as { gradeNow: { sat: number } }).gradeNow.sat };
    sim.weather.override('rain', 0);
    frame();
    const rain = { ...r.post, sat: (r as unknown as { gradeNow: { sat: number } }).gradeNow.sat };
    expect(rain.sat).toBeLessThan(clear.sat);
    expect(rain.vignette).toBeGreaterThan(clear.vignette + 0.04);
    r.dispose();
  });

  it('the flash curve is bright at once and gone within half a second', () => {
    expect(lightningFlash(0)).toBe(1);
    expect(lightningFlash(0.09)).toBeLessThan(0.5);
    expect(lightningFlash(0.13)).toBeGreaterThan(0.5);
    expect(lightningFlash(0.5)).toBeLessThan(0.01);
    expect(lightningFlash(Infinity)).toBe(0);
  });
});

describe('weather settings', () => {
  class Storage {
    private readonly m = new Map<string, string>();
    getItem(k: string): string | null {
      return this.m.get(k) ?? null;
    }
    setItem(k: string, v: string): void {
      this.m.set(k, String(v));
    }
    removeItem(k: string): void {
      this.m.delete(k);
    }
  }
  const win = window as unknown as { localStorage?: Storage };
  afterEach(() => {
    delete win.localStorage;
  });

  it('default to Dynamic with flashes on, persist, and survive old or junk files', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ weather: 'dynamic', lightningFlashes: true });
    win.localStorage = new Storage();
    win.localStorage.setItem('gta7.settings.v1', JSON.stringify({ quality: 'low', master: 0.5, hints: true, hintsSeen: [] }));
    expect(loadSettings()).toMatchObject({ quality: 'low', weather: 'dynamic', lightningFlashes: true });
    saveSettings({ ...DEFAULT_SETTINGS, weather: 'clear', lightningFlashes: false });
    expect(loadSettings()).toMatchObject({ weather: 'clear', lightningFlashes: false });
    win.localStorage.setItem('gta7.settings.v1', JSON.stringify({ weather: 'monsoon', lightningFlashes: 'yes' }));
    expect(loadSettings()).toMatchObject({ weather: 'dynamic', lightningFlashes: true });
  });
});
