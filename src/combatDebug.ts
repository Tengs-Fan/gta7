// window.__gta7.ext.combat: what the e2e tests and validators read of the wave-1 combat track (throws, fires, the
// scope), and a few setters for them.

import { registerDebug } from './debug';
import type { Game } from './game';

export function installCombatDebug(game: Game): void {
  const api = {
    /** The scope, throws in flight and ground fires, as of the last frame. */
    state() {
      const sim = game.sim;
      const p = sim.player;
      const cam = game.renderer.cameraCtl;
      const tv = game.renderer.throwView;
      return {
        weapon: p.inventory.current,
        ammo: p.inventory.total(p.inventory.current),
        scoped: cam.scoped,
        fov: cam.camera.fov,
        baseFov: cam.baseFov,
        scopeLevel: p.scopeLevel,
        scopeOverlay: game.scope.visible,
        arcShown: tv.arcShown,
        arcEnd: tv.arcShown ? { x: tv.arcEnd.x, y: tv.arcEnd.y, z: tv.arcEnd.z } : null,
        fireLit: tv.fireLit,
        throws: sim.combat.throws.list.map((t) => ({ weapon: t.weapon, x: t.pos.x, y: t.pos.y, z: t.pos.z, age: t.age, bounces: t.bounces, inWater: t.inWater })),
        fires: sim.combat.fire.areas.map((a) => ({ x: a.x, z: a.z, radius: a.radius, patches: a.burning, age: a.age })),
        burningPeople: sim.characters.filter((c) => !c.removed && c.burnTimer > 0).length,
        burningCars: sim.vehicles.filter((v) => !v.removed && v.burning).map((v) => v.id),
      };
    },
    /** Starts a molotov fire on the ground at (x, z) (default: 8 m ahead of the camera's view), as the player's. */
    fireAt(x?: number, z?: number) {
      const sim = game.sim;
      const p = sim.player;
      const yaw = game.renderer.cameraCtl.yaw;
      const fx = x ?? p.pos.x + Math.sin(yaw) * 8;
      const fz = z ?? p.pos.z + Math.cos(yaw) * 8;
      const a = sim.combat.fire.ignite(fx, sim.world.groundHeight(fx, fz), fz, p);
      return a ? { x: a.x, z: a.z } : null;
    },
    /** A vehicle's id and position, and whether it burns. */
    vehicle(id: number) {
      const v = game.sim.vehicles.find((o) => o.id === id);
      return v ? { x: v.pos.x, z: v.pos.z, health: v.health, burning: v.burning, destroyed: v.destroyed } : null;
    },
  };
  registerDebug('combat', api);
}
