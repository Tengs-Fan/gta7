// window.__gta7: a small scripting surface used by the end-to-end tests and
// handy for poking at the game from the browser console.

import type { Game } from './game';
import type { VehicleKind, WeaponId } from './sim/specs';

export function installDebugApi(game: Game): void {
  const api = {
    game,
    get sim() {
      return game.sim;
    },
    /** New Game; { intro: false } skips Lou's opening call. */
    newGame: (opts?: { intro?: boolean }) => game.newGame(opts),
    state: () => {
      const sim = game.sim;
      const p = sim.player;
      const pos = sim.playerPos();
      return {
        mode: game.mode,
        crashed: game.isCrashed,
        listenerErrors: game.sim.events.errors,
        fps: Math.round(game.fps),
        frames: game.frames,
        menuOpen: game.menus.open,
        player: { x: pos.x, y: pos.y, z: pos.z, state: p.state, health: p.health, armor: p.armor, weapon: p.inventory.current, vehicle: p.vehicle?.kind ?? null, speed: p.vehicle ? p.vehicle.speed : p.speed },
        wanted: sim.wanted.level,
        money: sim.progress.money,
        mission: sim.missions.active?.def.id ?? null,
        objective: sim.missions.active?.objectiveText ?? null,
        missionsDone: [...sim.progress.missionsDone],
        hours: sim.clock.hours,
        vehicles: sim.vehicles.length,
        police: sim.vehicles.filter((v) => v.owner === 'police').length,
        characters: sim.characters.length,
        deathKind: sim.deathKind,
        render: { ...game.renderer.stats(), tier: game.renderer.currentQuality },
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
  (window as unknown as { __gta7: typeof api }).__gta7 = api;
}
