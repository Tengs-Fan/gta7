// window.__gta7: a small scripting surface used by the end-to-end tests and
// handy for poking at the game from the browser console.

import type { Game } from './game';
import { playerOf, type ViewState } from './sim/viewState';
import type { VehicleKind, WeaponId } from './sim/specs';
import { WEATHER_KINDS, type WeatherFields, type WeatherKind, type WeatherMode } from './sim/weather';

const registered = new Map<string, unknown>();
let installedExt: Record<string, unknown> | null = null;
/** Hooks that also sit on window.__gta7 itself once registered (multiplayer's __gta7.net); none in single player. */
const topLevel = new Map<string, unknown>();
let installedApi: Record<string, unknown> | null = null;

/**
 * Exposes `api` as `window.__gta7.ext[name]`. Works before or after installDebugApi; registering a name again replaces
 * the earlier API.
 */
export function registerDebug(name: string, api: unknown, opts: { topLevel?: boolean } = {}): void {
  registered.set(name, api);
  if (installedExt) installedExt[name] = api;
  if (opts.topLevel) {
    topLevel.set(name, api);
    if (installedApi) installedApi[name] = api;
  }
}

export function installDebugApi(game: Game): void {
  const ext: Record<string, unknown> = {};
  for (const [name, entry] of registered) ext[name] = entry;
  installedExt = ext;
  const api = {
    game,
    ext,
    get sim() {
      return game.sim;
    },
    /** New Game; { intro: false } skips Lou's opening call. */
    newGame: (opts?: { intro?: boolean }) => game.newGame(opts),
    startStreetRun: (courseId?: string) => game.startStreetRun(courseId),
    state: () => {
      // In multiplayer the screens show the mirror; the same fields come from it.
      const view = game.view;
      if (view !== game.sim) return viewState(game, view);
      const sim = game.sim;
      const p = sim.player;
      const pos = sim.playerPos();
      return {
        mode: game.mode,
        crashed: game.isCrashed,
        fps: Math.round(game.fps * 10) / 10,
        frames: game.frames,
        menuOpen: game.menus.open,
        player: { x: pos.x, y: pos.y, z: pos.z, state: p.state, health: p.health, armor: p.armor, weapon: p.inventory.current, vehicle: p.vehicle?.kind ?? null, speed: p.vehicle ? p.vehicle.speed : p.speed },
        wanted: sim.wanted.level,
        money: sim.progress.money,
        mission: sim.missions.active?.def.id ?? null,
        objective: sim.missions.active?.objectiveText ?? null,
        missionsDone: [...sim.progress.missionsDone],
        activity: sim.activities.job?.kind ?? null,
        activityStatus: sim.activities.status(),
        hours: sim.clock.hours,
        vehicles: sim.vehicles.length,
        police: sim.vehicles.filter((v) => v.owner === 'police').length,
        characters: sim.characters.length,
        deathKind: sim.deathKind,
        render: { ...game.renderer.stats(), tier: game.renderer.currentQuality, post: game.renderer.post, software: game.renderer.software, msaa: game.renderer.msaa },
        perf: { ...game.perf },
      };
    },
    teleport(x: number, z: number) {
      const sim = game.sim;
      const p = sim.player;
      const t = p.vehicle ?? p;
      t.pos.x = x;
      t.pos.z = z;
      t.pos.y = sim.world.groundHeight(x, z);
      if (p.vehicle) {
        p.vehicle.vel.x = 0;
        p.vehicle.vel.z = 0;
      }
      game.renderer.cameraCtl.reset(sim);
    },
    spawnVehicle(kind: VehicleKind, enter = true) {
      const sim = game.sim;
      const p = sim.player;
      const lane = sim.roads.nearestLane(p.pos.x, p.pos.z).lane;
      const s = Math.min(lane.length - 5, Math.max(5, (p.pos.x - lane.sx) * lane.dx + (p.pos.z - lane.sz) * lane.dz));
      const v = sim.spawnVehicle(kind, lane.sx + lane.dx * s, lane.sz + lane.dz * s, lane.heading);
      if (enter) {
        if (p.vehicle) sim.playerCtl.ejectPlayer(true);
        sim.seat(p, v, 0);
        v.usedByPlayer = true;
        game.renderer.cameraCtl.reset(sim);
      }
      return v.id;
    },
    give(weapon: WeaponId, ammo = 200) {
      const p = game.sim.player;
      p.inventory.give(weapon, ammo);
      p.inventory.current = weapon;
    },
    setWanted(n: number) {
      game.sim.wanted.setLevel(n);
    },
    setTime(h: number) {
      game.sim.clock.set(h);
    },
    /** Overrides FinishPass (FXAA, grade, vignette; vignette null = time of day) until the next quality change. */
    setPost(o: { aa?: 'none' | 'fxaa'; grade?: boolean; vignette?: number | null }) {
      return game.renderer.overridePost(o);
    },
    /**
     * Forces a weather kind (ramping over 20 s unless `instant`), or pins single fields ({ seaState: 1 }) on top of the
     * weather; clearWeather releases both.
     */
    setWeather(w: WeatherKind | WeatherFields, opts: { instant?: boolean; ramp?: number } = {}) {
      const ws = game.sim.weather;
      const ramp = opts.instant ? 0 : opts.ramp;
      if (typeof w === 'string') {
        if (!WEATHER_KINDS.includes(w)) throw new Error(`unknown weather ${w}`);
        ws.override(w, ramp);
      } else {
        ws.setFields(w);
      }
      return api.weather();
    },
    weather() {
      const ws = game.sim.weather;
      return { ...ws.state, wind: { ...ws.state.wind }, mode: ws.mode, overridden: ws.overridden };
    },
    /** Back to the forecast (or the clear mode): drops a forced kind and pinned fields. */
    clearWeather(opts: { instant?: boolean } = {}) {
      game.sim.weather.override(null, opts.instant ? 0 : undefined);
      return api.weather();
    },
    /** A lightning strike now, at (x, z) or at a spot 300-1500 m from the player. */
    lightning(x?: number, z?: number) {
      const sim = game.sim;
      sim.weather.strike(sim.events, sim.playerPos(), x, z, sim.frame);
    },
    /** Imposes a weather mode over the setting for this and later games (the e2e helpers keep it clear); null releases it. */
    forceWeather(mode: WeatherMode | null) {
      game.forceWeather(mode);
    },
    /** Clock speed relative to the default (1 = one game minute per real second). */
    setClockRate(r: number) {
      game.sim.clock.rate = r / 60;
    },
    /** The environment map's bake count, last bake hour and current sky-light compensation. */
    envStats() {
      const env = game.renderer.env;
      const rgb = (c: { r: number; g: number; b: number }) => ({ r: c.r, g: c.g, b: c.b });
      return {
        bakes: env.envBakes,
        lastBakeHour: env.lastBakeHour,
        envIntensity: game.renderer.scene.environmentIntensity,
        bakedUp: rgb(env.bakedUp),
        upNow: rgb(env.upNow),
        source: env.envSource,
        hdriMix: env.bakedHdriMix,
      };
    },
    godMode(on = true) {
      game.sim.cheats.godMode = on;
    },
    startMission(id: string) {
      const sim = game.sim;
      return sim.missions.start(id);
    },
    markDone(...ids: string[]) {
      for (const id of ids) game.sim.progress.markDone(id);
      game.sim.missions.refreshMarkers();
    },
    poi(id: string) {
      const p = game.sim.world.layout.pois.find((q) => q.id === id);
      return p ? { x: p.x, z: p.z, heading: p.heading } : null;
    },
    setCamera(yaw: number, pitch: number) {
      const c = game.renderer.cameraCtl;
      c.yaw = yaw;
      c.pitch = pitch;
    },
    /** Renders a frame and samples a 9x9 pixel grid from the canvas (for tests). */
    samplePixels() {
      const r = game.renderer;
      r.render(1 / 60, false);
      const gl = r.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(4);
      let sum = 0;
      let sum2 = 0;
      let n = 0;
      const colors = new Set<string>();
      for (let i = 1; i < 10; i++) {
        for (let j = 1; j < 10; j++) {
          gl.readPixels(Math.floor((w * i) / 10), Math.floor((h * j) / 10), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const l = (px[0]! + px[1]! + px[2]!) / 3;
          sum += l;
          sum2 += l * l;
          n++;
          colors.add(`${px[0]! >> 3},${px[1]! >> 3},${px[2]! >> 3}`);
        }
      }
      const mean = sum / n;
      return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), colors: colors.size };
    },
    /** Moves the player's vehicle (or the player) to an exact spot and stops it. */
    place(x: number, z: number, heading?: number) {
      const sim = game.sim;
      const p = sim.player;
      const t = p.vehicle ?? p;
      t.pos.x = x;
      t.pos.z = z;
      t.pos.y = sim.world.groundHeight(x, z);
      if (heading !== undefined) t.heading = heading;
      if (p.vehicle) {
        p.vehicle.vel.x = 0;
        p.vehicle.vel.z = 0;
        p.vehicle.angVel = 0;
      }
    },
    spawnPedAhead(dist = 6) {
      const sim = game.sim;
      const p = sim.player;
      const yaw = game.renderer.cameraCtl.yaw;
      const c = sim.spawnCharacter('civilian', p.pos.x + Math.sin(yaw) * dist, p.pos.z + Math.cos(yaw) * dist);
      c.owner = 'mission';
      c.persistent = true;
      return c.id;
    },
    characterAlive(id: number) {
      const c = game.sim.characters.find((x) => x.id === id);
      return c ? c.alive : false;
    },
  };
  const w = window as unknown as { __gta7: typeof api; __gta7Test?: { weather?: WeatherMode } };
  w.__gta7 = api;
  installedApi = api as unknown as Record<string, unknown>;
  for (const [name, entry] of topLevel) installedApi[name] = entry;
  // Set by an init script before the page loads (tests/e2e/helpers.ts boot), so it holds across reloads too.
  const forced = w.__gta7Test?.weather;
  if (forced === 'clear' || forced === 'dynamic') game.forceWeather(forced);
}

/** state() over a ViewState (the multiplayer mirror): the same fields as for the single-player Sim. */
function viewState(game: Game, view: ViewState): Record<string, unknown> {
  const me = playerOf(view, game.localPlayer);
  const p = me.character;
  const pos = me.pos();
  return {
    mode: game.mode,
    crashed: game.isCrashed,
    fps: Math.round(game.fps * 10) / 10,
    frames: game.frames,
    menuOpen: game.menus.open,
    player: { x: pos.x, y: pos.y, z: pos.z, state: p.state, health: p.health, armor: p.armor, weapon: p.inventory.current, vehicle: p.vehicle?.kind ?? null, speed: p.vehicle ? p.vehicle.speed : p.speed },
    wanted: me.wanted.level,
    money: me.progress.money,
    mission: view.missions.active?.def.id ?? null,
    objective: view.missions.active?.objectiveText ?? null,
    missionsDone: [...me.progress.missionsDone],
    activity: view.activities.job?.kind ?? null,
    activityStatus: view.activities.status(),
    hours: view.clock.hours,
    vehicles: view.vehicles.length,
    police: view.vehicles.filter((v) => v.owner === 'police').length,
    characters: view.characters.length,
    deathKind: me.deathKind,
    render: { ...game.renderer.stats(), tier: game.renderer.currentQuality, post: game.renderer.post, software: game.renderer.software, msaa: game.renderer.msaa },
    perf: { ...game.perf },
  };
}
