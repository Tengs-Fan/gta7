// window.__gta7.ext.combat: what the e2e tests and validators read of the wave-1 combat track (throws, fires, the
// scope), and a few setters for them.

import { registerDebug } from './debug';
import type { Game } from './game';
import { gangAt, setGang, turfBorders, turfZones } from './sim/gangs';
import type { GangId } from './world/layout';

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
    /** The gang turf the player is in, gang members within 80 m, gang cars and wars. */
    gangs() {
      const sim = game.sim;
      const pp = sim.playerPos();
      return {
        here: gangAt(sim.world.layout, pp.x, pp.z),
        members: sim.characters
          .filter((c) => !c.removed && c.alive && c.gang && Math.hypot(c.pos.x - pp.x, c.pos.z - pp.z) < 80)
          .map((c) => ({ id: c.id, gang: c.gang, mode: c.brain?.mode ?? null, hostile: c.brain?.mode === 'fight' && c.brain.target === sim.player, d: Math.round(Math.hypot(c.pos.x - pp.x, c.pos.z - pp.z)), shirt: c.appearance.shirt })),
        cars: sim.gangs.cars.filter((v) => !v.removed).map((v) => ({ id: v.id, gang: v.driver?.gang ?? null, color: v.color, x: v.pos.x, z: v.pos.z, inTurf: gangAt(sim.world.layout, v.pos.x, v.pos.z) })),
        wars: sim.gangs.wars.map((w) => ({ id: w.id, a: w.a, b: w.b, x: w.x, z: w.z, startedAt: w.startedAt, endedAt: w.endedAt, alive: w.members.filter((c) => c.alive && !c.removed).length })),
      };
    },
    /** A sidewalk spot near the middle of a gang's biggest turf. */
    toTurf(gang: GangId) {
      const sim = game.sim;
      const z = turfZones(sim.world.layout).filter((t) => t.turf.gang === gang).sort((a, b) => (b.maxX - b.minX) * (b.maxZ - b.minZ) - (a.maxX - a.minX) * (a.maxZ - a.minZ))[0];
      if (!z) return null;
      const cx = (z.minX + z.maxX) / 2;
      const cz = (z.minZ + z.maxZ) / 2;
      let best: { x: number; z: number } | null = null;
      let bd = Infinity;
      for (const n of sim.world.walk.nodes) {
        const d = Math.hypot(n.x - cx, n.z - cz);
        if (d < bd && gangAt(sim.world.layout, n.x, n.z) === gang && sim.world.isFree(n.x, n.z, 0.6)) {
          bd = d;
          best = { x: n.x, z: n.z };
        }
      }
      // Where the caller teleports him (window.__gta7.teleport).
      return best;
    },
    /** Spawns a member of `gang` on the sidewalk `dist` m ahead of the camera's view (armed with a pistol in his belt). */
    spawnMember(gang: GangId, dist = 8) {
      const sim = game.sim;
      const p = sim.player;
      const yaw = game.renderer.cameraCtl.yaw;
      const spot = sim.world.findFreeSpot(p.pos.x + Math.sin(yaw) * dist, p.pos.z + Math.cos(yaw) * dist, 0.5, 6);
      if (!spot) return null;
      const c = sim.spawnCharacter('gang', spot.x, spot.z);
      c.owner = 'ped';
      setGang(c, gang);
      c.brain = sim.peds.makeGangBrain(spot.x, spot.z);
      c.inventory.infinite = true;
      c.inventory.give('pistol', 999);
      c.inventory.current = 'fists';
      return c.id;
    },
    /** A free spot 22 m off the middle of the first border between two gangs' turfs (where the caller teleports him). */
    toBorder() {
      const sim = game.sim;
      const b = turfBorders(sim.world.layout)[0];
      if (!b) return null;
      const vertical = b.ax === b.bx;
      const mx = (b.ax + b.bx) / 2 + (vertical ? 22 : 0);
      const mz = (b.az + b.bz) / 2 + (vertical ? 0 : 22);
      return sim.world.findFreeSpot(mx, mz, 0.5, 20);
    },
    /** Starts a gang war at the turf border nearest the player, 15-60 m from him. */
    startWar() {
      const w = game.sim.gangs.startWar(undefined, true);
      return w ? { id: w.id, x: w.x, z: w.z, members: w.members.length } : null;
    },
    /** Roadblocks standing and placed, spike strips, and the player car's flat tyres. */
    roadblocks() {
      const sim = game.sim;
      const pp = sim.playerPos();
      const rb = sim.roadblocks;
      return {
        standing: rb.roadblocks.map((r) => ({ id: r.id, x: r.x, z: r.z, d: Math.round(Math.hypot(r.x - pp.x, r.z - pp.z)), ahead: r.ahead, cars: r.cars.map((v) => v.id), officers: r.officers.map((o) => ({ id: o.id, mode: o.brain?.mode ?? null, posted: rb.isPosted(o) })) })),
        placed: rb.log.length,
        strips: rb.strips.map((s) => ({ x: s.x, z: s.z, halfLen: s.halfLen, bursts: s.bursts })),
        flats: sim.player.vehicle ? [...sim.player.vehicle.flat] : null,
      };
    },
    /** Places a roadblock on the player's way now (3 stars or more, driving), if a spot turns up. */
    placeRoadblock() {
      const r = game.sim.roadblocks.place();
      return r ? { id: r.id, x: r.x, z: r.z, ahead: r.ahead } : null;
    },
    /** Witness calls (under way and done) and angry drivers (every hard hit on a civilian's car, and what came of it). */
    npc() {
      const sim = game.sim;
      return {
        calls: sim.witnesses.log.map((c) => ({ id: c.id, caller: c.caller.id, type: c.type, at: c.at, due: c.due, state: c.state, endedAt: c.endedAt })),
        hits: sim.angryDrivers.log.map((l) => ({ at: l.at, car: l.car, deltaV: l.deltaV, out: l.out, fights: l.fights, state: l.grievance?.state ?? null, end: l.grievance?.end ?? null, driver: l.grievance?.driver.id ?? null })),
      };
    },
    /** A vehicle's id and position, and whether it burns. */
    vehicle(id: number) {
      const v = game.sim.vehicles.find((o) => o.id === id);
      return v ? { x: v.pos.x, z: v.pos.z, health: v.health, burning: v.burning, destroyed: v.destroyed } : null;
    },
  };
  registerDebug('combat', api);
}
