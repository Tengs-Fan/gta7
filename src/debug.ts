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
    newGame: () => game.newGame(),
    state: () => {
      const sim = game.sim;
      const p = sim.player;
      const pos = sim.playerPos();
      return {
        mode: game.mode,
        crashed: game.isCrashed,
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
        render: game.renderer.stats(),
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
  };
  (window as unknown as { __gta7: typeof api }).__gta7 = api;
}
