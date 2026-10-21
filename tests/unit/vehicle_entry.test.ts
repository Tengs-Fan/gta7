import { describe, expect, it } from 'vitest';
import { circleVsObb, makeContact } from '../../src/core/collision';
import type { Vehicle } from '../../src/sim/entities';
import { vehicleObb } from '../../src/sim/vehiclePhysics';
import { input, makeSim, step, teleport } from './helpers';

const DT = 1 / 60;

function localPoint(car: Vehicle, x: number, z: number): { x: number; z: number } {
  const c = Math.cos(car.heading);
  const s = Math.sin(car.heading);
  return { x: car.pos.x + x * c + z * s, z: car.pos.z - x * s + z * c };
}

describe('reachable vehicle entry', () => {
  it('cannot select a car through the back wall of an actual garage', () => {
    const sim = makeSim({ police: false });
    const garage = sim.world.layout.garages.find((g) => g.poi === 'lou')!;
    const center = { x: (garage.rect.minX + garage.rect.maxX) / 2, z: (garage.rect.minZ + garage.rect.maxZ) / 2 };
    // Find a long garage wall with walkable ground outside. The car is parked
    // just inside it and within the old 2 m body-reach check from outside.
    const spots = garage.walls.flatMap((wall) => {
      const vertical = wall.maxX - wall.minX < wall.maxZ - wall.minZ;
      const x = (wall.minX + wall.maxX) / 2;
      const z = (wall.minZ + wall.maxZ) / 2;
      const nx = vertical ? Math.sign(x - center.x) : 0;
      const nz = vertical ? 0 : Math.sign(z - center.z);
      const halfThickness = (vertical ? wall.maxX - wall.minX : wall.maxZ - wall.minZ) / 2;
      const outside = { x: x + nx * (halfThickness + 0.55), z: z + nz * (halfThickness + 0.55) };
      const inside = { x: x - nx * (halfThickness + 1.15), z: z - nz * (halfThickness + 1.15) };
      return sim.world.isFree(outside.x, outside.z, 0.35) && sim.world.isFree(inside.x, inside.z, 0.8)
        ? [{ outside, inside, heading: vertical ? 0 : Math.PI / 2 }]
        : [];
    });
    expect(spots.length).toBeGreaterThan(0);
    const spot = spots[0]!;
    const car = sim.spawnVehicle('sedan', spot.inside.x, spot.inside.z, spot.heading);
    teleport(sim, spot.outside.x, spot.outside.z);
    const body = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };
    vehicleObb(car, body);
    expect(circleVsObb(sim.player.pos.x, sim.player.pos.z, 2, body, makeContact())).toBe(true);
    expect(sim.playerCtl.findEnterable(sim.player)).toBeNull();
    sim.update(DT, input({ enterExit: true }));
    step(sim, 1);
    expect(sim.player.vehicle).toBeNull();
    expect(sim.player.state).toBe('normal');
    expect(Math.hypot(sim.player.pos.x - spot.outside.x, sim.player.pos.z - spot.outside.z)).toBeLessThan(0.1);
  });

  it.each([0, Math.PI / 2, -Math.PI / 3])('keeps normal entry timing at an open door, heading %s', (heading) => {
    const sim = makeSim({ police: false });
    const car = sim.spawnVehicle('sedan', 0, 0, heading);
    const door = localPoint(car, car.halfW + 0.8, 0.35);
    teleport(sim, door.x, door.z);
    expect(sim.playerCtl.findEnterable(sim.player)).toBe(car);
    sim.update(DT, input({ enterExit: true }));
    step(sim, 0.4);
    expect(sim.player.state).toBe('entering');
    step(sim, 0.1);
    expect(sim.player.vehicle).toBe(car);
  });

  it('uses the accessible passenger side when the driver door is against a wall', () => {
    const sim = makeSim({ police: false });
    const car = sim.spawnVehicle('sedan', 0, 0, 0);
    sim.world.grid.addBox(1.2, -4, 1.8, 4, 0, 3, 'wall');
    teleport(sim, -car.halfW - 0.8, 0.35);
    expect(sim.world.isFree(car.halfW + 0.55, 0.35, sim.player.radius)).toBe(false);
    expect(sim.playerCtl.findEnterable(sim.player)).toBe(car);
    sim.update(DT, input({ enterExit: true }));
    step(sim, 0.55);
    expect(sim.player.vehicle).toBe(car);
    expect(sim.player.seat).toBe(0);
  });

  it.each([-1, 1])('walks around a bus from end %s and reaches a side door before seating', (end) => {
    const sim = makeSim({ police: false });
    const car = sim.spawnVehicle('bus', 0, 0, Math.PI / 3);
    const start = localPoint(car, 0, (car.halfL + 1.1) * end);
    teleport(sim, start.x, start.z);
    sim.update(DT, input({ enterExit: true }));
    const body = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };
    let seatedAt = -1;
    for (let frame = 0; frame < 180; frame++) {
      sim.update(DT, input());
      if (sim.player.vehicle) {
        seatedAt = (frame + 1) * DT;
        break;
      }
      vehicleObb(car, body);
      expect(circleVsObb(sim.player.pos.x, sim.player.pos.z, sim.player.radius - 0.05, body, makeContact())).toBe(false);
      if (frame === 30) expect(sim.player.state).toBe('entering');
    }
    expect(sim.player.vehicle).toBe(car);
    expect(seatedAt).toBeGreaterThan(0.9);
    expect(seatedAt).toBeLessThan(1.6);
  });

  it('does not pull a bus driver out until the player has reached the door', () => {
    const sim = makeSim({ police: false });
    const car = sim.spawnVehicle('bus', 0, 0, 0);
    const driver = sim.addDriver(car, 'civilian', 'traffic');
    teleport(sim, 0, -car.halfL - 1.1);
    sim.update(DT, input({ enterExit: true }));
    expect(car.ai!.hold).toBe(true);
    step(sim, 0.6);
    expect(car.driver).toBe(driver);
    expect(driver.state).toBe('inVehicle');
    expect(sim.player.state).toBe('entering');
    step(sim, 1.6);
    expect(sim.player.vehicle).toBe(car);
    expect(driver.vehicle).toBeNull();
    expect(car.ai).toBeNull();
  });

  it('abandons entry and releases the AI when a moving car carries its door across a wall', () => {
    const sim = makeSim({ police: false });
    const car = sim.spawnVehicle('sedan', 0, 0, 0);
    sim.addDriver(car, 'civilian', 'traffic');
    teleport(sim, 2.2, 0.35);
    sim.update(DT, input({ enterExit: true }));
    expect(car.ai!.hold).toBe(true);
    sim.world.grid.addBox(3.1, -10, 3.3, 10, 0, 3, 'wall');
    car.pos.x = 6;
    const before = { ...sim.player.pos };
    // Entry must catch a changed world before normal physics can correct it.
    sim.playerCtl.update(0.1, input());
    expect(sim.player.vehicle).toBeNull();
    expect(sim.player.enterTarget).toBeNull();
    expect(sim.player.state).toBe('normal');
    expect(car.ai!.hold).toBe(false);
    expect(sim.player.pos).toEqual(before);
  });

  it('cannot sweep through a thin wall that appears between player and door during entry', () => {
    const sim = makeSim({ police: false });
    const car = sim.spawnVehicle('sedan', 0, 0, 0);
    teleport(sim, 2.6, 0.35);
    sim.update(DT, input({ enterExit: true }));
    expect(sim.player.state).toBe('entering');
    expect(sim.player.enterTarget).toBe(car);
    sim.world.grid.addBox(2.0, -10, 2.04, 10, 0, 3, 'wall');
    sim.playerCtl.update(0.1, input());
    expect(sim.player.state).toBe('normal');
    expect(sim.player.vehicle).toBeNull();
    expect(sim.player.pos.x).toBeGreaterThan(2.4);
  });
});
