import { describe, expect, it } from 'vitest';
import { makeContact, obbVsAabb } from '../../src/core/collision';
import { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { stepVehicle, vehicleObb } from '../../src/sim/vehiclePhysics';
import { WATER_Y } from '../../src/world/constants';
import { input, makeSim, placeInCar, roadPoint, step, teleport } from './helpers';

/** Records every crime the wanted system is asked to report. */
function spyCrimes(sim: Sim): string[] {
  const crimes: string[] = [];
  const orig = sim.wanted.crime.bind(sim.wanted);
  sim.wanted.crime = (type, x, z) => {
    crimes.push(type);
    orig(type, x, z);
  };
  return crimes;
}

/** A vehicle on a lane with the player standing at its driver door. */
function carAtPlayer(sim: Sim, kind: 'sedan' | 'police' | 'bus' = 'sedan'): Vehicle {
  const rp = roadPoint(sim, 60, 15);
  const v = sim.spawnVehicle(kind, rp.x, rp.z, rp.heading);
  teleport(sim, rp.x + Math.cos(rp.heading) * (v.halfW + 1.4), rp.z - Math.sin(rp.heading) * (v.halfW + 1.4));
  return v;
}

describe('knocked characters in deep water', () => {
  it('a player who bails out over the sea swims instead of floating knocked forever', () => {
    const sim = makeSim();
    const b = sim.world.bounds;
    const v = sim.spawnVehicle('sedan', b.landMinX + 60, 0, -Math.PI / 2);
    placeInCar(sim, v);
    let bailAt = -1;
    let swimAt = -1;
    for (let i = 0; i < 60 * 8 && swimAt < 0; i++) {
      const inp = input({ throttle: 1 });
      if (bailAt < 0 && v.pos.x < b.landMinX + 2 && v.speed > 11) {
        inp.enterExit = true;
        bailAt = i;
      }
      sim.update(1 / 60, inp);
      if (bailAt >= 0 && i > bailAt && sim.player.state === 'swimming') swimAt = i;
    }
    expect(bailAt).toBeGreaterThan(0);
    expect(swimAt).toBeGreaterThan(bailAt);
    expect(swimAt - bailAt).toBeLessThan(60 * 2);
    // Water stops the bail momentum: the player does not glide far out to sea.
    step(sim, 2);
    expect(sim.player.pos.x).toBeGreaterThan(b.landMinX - 30);
    // Swim back east and climb out onto the quay.
    step(sim, 20, input({ moveZ: 1, cameraYaw: Math.PI / 2 }));
    expect(sim.player.state).toBe('normal');
    expect(sim.player.pos.x).toBeGreaterThan(b.landMinX);
  });

  it('an explosion next to a swimmer only knocks them briefly', () => {
    const sim = makeSim();
    const b = sim.world.bounds;
    teleport(sim, b.landMinX - 15, 0);
    step(sim, 0.5);
    const p = sim.player;
    expect(p.state).toBe('swimming');
    const x0 = p.pos.x;
    sim.combat.explosion(p.pos.x + 4, WATER_Y, p.pos.z, 8, 20, null, null);
    expect(p.state).toBe('knocked');
    step(sim, 3);
    expect(p.state).toBe('swimming');
    expect(Math.abs(p.pos.x - x0)).toBeLessThan(15);
  });

  it('knocked NPCs swim and floating corpses come to rest', () => {
    const sim = makeSim();
    const b = sim.world.bounds;
    const npc = sim.spawnCharacter('civilian', b.landMinX - 25, 30);
    npc.pos.y = 1;
    npc.onGround = false;
    npc.state = 'knocked';
    npc.knockTimer = 2;
    npc.vel.x = -8;
    const body = sim.spawnCharacter('civilian', b.landMinX - 25, -30);
    sim.combat.damageCharacter(body, 999, null, 'fall', 0, -1, 0);
    expect(body.alive).toBe(false);
    body.pos.y = 1;
    body.onGround = false;
    body.vel.x = -8;
    const bx0 = body.pos.x;
    step(sim, 4);
    expect(npc.state).toBe('swimming');
    expect(Math.abs(body.vel.x)).toBeLessThan(0.5);
    expect(body.pos.x).toBeGreaterThan(bx0 - 12);
  });
});

describe('vehicle step-up blocking', () => {
  it('a car sliding sideways into the high end of a ramp does not climb it', () => {
    const sim = makeSim();
    const r = sim.world.layout.ramps[2]!; // west promenade, high end faces north
    const v = sim.spawnVehicle('sedan', r.x - 2, r.z - 10, -Math.PI / 2);
    const y0 = v.pos.y;
    v.vel.z = 16; // facing west, sliding south into the ramp's 2.2 m high end
    let maxY = y0;
    for (let i = 0; i < 90; i++) {
      sim.update(1 / 60, input());
      maxY = Math.max(maxY, v.pos.y);
    }
    expect(maxY - y0).toBeLessThan(0.5);
    expect(v.pos.z).toBeLessThan(r.z - r.length / 2);
  });

  it('no sliding approach to a ramp climbs a wall or launches the car', () => {
    const sim = makeSim();
    const world = sim.world;
    let seed = 12345;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    let climbs = 0;
    let maxLaunch = 0;
    for (let i = 0; i < 500; i++) {
      const r = world.layout.ramps[i % world.layout.ramps.length]!;
      const th = rnd() * Math.PI * 2;
      const ux = Math.sin(th);
      const uz = Math.cos(th);
      const off = (rnd() - 0.5) * 10;
      const sp = 8 + rnd() * 14;
      const x = r.x - ux * 11 - uz * off;
      const z = r.z - uz * 11 + ux * off;
      const v = new Vehicle(10000 + i, 'sedan', x, world.groundHeight(x, z), z, th + (rnd() - 0.5) * 2 * Math.PI, 0);
      v.vel.x = ux * sp;
      v.vel.z = uz * sp;
      for (let k = 0; k < 180; k++) {
        const y = v.pos.y;
        const wasAir = v.airborne;
        stepVehicle(v, 1 / 120, sim);
        if (!wasAir && v.pos.y - y > 1.05) climbs++;
        if (!wasAir && v.airborne) maxLaunch = Math.max(maxLaunch, v.vy);
      }
    }
    expect(climbs).toBe(0);
    expect(maxLaunch).toBeLessThan(7);
  });

  it('a car rammed sideways into a ramp end is not shoved up it', () => {
    const sim = makeSim();
    const r = sim.world.layout.ramps[2]!;
    const wall = r.z - r.length / 2;
    const victim = sim.spawnVehicle('compact', r.x, wall - 1.3, -Math.PI / 2);
    const y0 = victim.pos.y;
    const pusher = sim.spawnVehicle('pickup', r.x, wall - 14, 0);
    placeInCar(sim, pusher);
    pusher.vel.z = 18;
    let maxY = y0;
    step(sim, 3, () => {
      maxY = Math.max(maxY, victim.pos.y);
      return input({ throttle: 1 });
    });
    expect(maxY - y0).toBeLessThan(0.5);
    expect(victim.pos.z + victim.halfW).toBeLessThan(wall + 0.05);
  });

  it('a car flying low into a ramp end bounces off instead of landing on top', () => {
    const sim = makeSim();
    const r = sim.world.layout.ramps[2]!;
    const wall = r.z - r.length / 2;
    // Still in the air (about 0.7 m up) when it reaches the 2.2 m high end.
    const v = sim.spawnVehicle('sedan', r.x, wall - 2, -Math.PI / 2);
    const y0 = v.pos.y;
    v.airborne = true;
    v.pos.y += 0.3;
    v.vy = 3;
    v.vel.z = 12;
    let maxY = y0;
    for (let i = 0; i < 90; i++) {
      sim.update(1 / 60, input());
      maxY = Math.max(maxY, v.pos.y);
    }
    expect(maxY - y0).toBeLessThan(1);
    expect(v.pos.z).toBeLessThan(wall);
  });

  it('cars still launch off ramps when driven up them', () => {
    const sim = makeSim();
    const r = sim.world.layout.ramps[2]!;
    const fx = Math.sin(r.heading);
    const fz = Math.cos(r.heading);
    const v = sim.spawnVehicle('sedan', r.x - fx * 40, r.z - fz * 40, r.heading);
    placeInCar(sim, v);
    let maxAir = 0;
    step(sim, 5, () => {
      maxAir = Math.max(maxAir, v.airTime);
      return input({ throttle: 1 });
    });
    expect(maxAir).toBeGreaterThan(0.6);
  });
});

describe('falls and water', () => {
  it('real falls hurt, short drops do not', () => {
    const high = makeSim();
    high.player.pos.y += 6;
    high.player.onGround = false;
    step(high, 2);
    expect(high.player.health).toBeLessThan(90);
    expect(high.player.alive).toBe(true);
    const low = makeSim();
    low.player.pos.y += 2;
    low.player.onGround = false;
    step(low, 2);
    expect(low.player.health).toBe(100);
    expect(low.player.onGround).toBe(true);
  });

  it('cars sinking in the surf rest on the sand; in deep water they still sink out of sight', () => {
    const sim = makeSim();
    const b = sim.world.bounds;
    const v = sim.spawnVehicle('sedan', b.beachStartX + 30, 0, Math.PI / 2);
    placeInCar(sim, v);
    step(sim, 20, () => input({ throttle: v.inWater ? 0 : 1 }));
    expect(v.inWater).toBe(true);
    expect(v.pos.y).toBeLessThan(WATER_Y);
    expect(v.pos.y).toBeGreaterThan(sim.world.baseGround(v.pos.x, v.pos.z) - 0.35);

    const deep = makeSim();
    const d = deep.spawnVehicle('sedan', deep.world.bounds.landMinX - 20, 0, -Math.PI / 2);
    d.pos.y = WATER_Y;
    step(deep, 6);
    expect(d.inWater).toBe(true);
    expect(d.pos.y).toBeCloseTo(WATER_Y - 3.2, 3);
  });
});

describe('crime attribution for vehicle hits', () => {
  it('nudging a cop with the car reports one assaultCop', () => {
    const sim = makeSim();
    const v = carAtPlayer(sim);
    placeInCar(sim, v);
    const cop = sim.spawnCharacter('cop', v.pos.x + 6, v.pos.z + 6);
    const crimes = spyCrimes(sim);
    sim.onCharacterHitByVehicle(cop, v, 5, 1, 0);
    expect(cop.alive).toBe(true);
    expect(crimes).toEqual(['assaultCop']);
    expect(sim.wanted.heat).toBe(150);
    expect(sim.wanted.level).toBe(1);
  });

  it('the player is not blamed when his own empty car hits him', () => {
    const sim = makeSim();
    const v = carAtPlayer(sim);
    placeInCar(sim, v);
    sim.playerCtl.exitVehicle(false);
    expect(v.lastDriver).toBe(sim.player);
    sim.spawnCharacter('cop', sim.player.pos.x + 3, sim.player.pos.z + 3);
    const crimes = spyCrimes(sim);
    sim.onCharacterHitByVehicle(sim.player, v, 7, 1, 0);
    expect(sim.player.health).toBeLessThan(100);
    expect(crimes).toEqual([]);
    expect(sim.wanted.level).toBe(0);
    expect(sim.player.lastAttacker).toBeNull();
  });
});

describe('entering vehicles', () => {
  it('taking a police car hands it over from the police', () => {
    const sim = makeSim({ police: false });
    const v = carAtPlayer(sim, 'police');
    v.owner = 'police';
    sim.addDriver(v, 'cop', 'traffic');
    sim.update(1 / 60, input({ enterExit: true }));
    expect(sim.player.state).toBe('entering');
    step(sim, 1.5);
    expect(sim.player.vehicle).toBe(v);
    expect(v.owner).toBe('none');
  });

  it('mission vehicles keep their owner when the player gets in', () => {
    const sim = makeSim();
    const v = carAtPlayer(sim);
    v.owner = 'mission';
    sim.update(1 / 60, input({ enterExit: true }));
    step(sim, 1);
    expect(sim.player.vehicle).toBe(v);
    expect(v.owner).toBe('mission');
  });

  it('dying while carjacking releases the car', () => {
    const sim = makeSim();
    const v = carAtPlayer(sim);
    sim.addDriver(v, 'civilian', 'traffic');
    sim.update(1 / 60, input({ enterExit: true }));
    expect(sim.player.state).toBe('entering');
    expect(v.ai!.hold).toBe(true);
    sim.combat.damageCharacter(sim.player, 500, null, 'fall', 0, -1, 0);
    step(sim, 0.1);
    expect(v.ai!.hold).toBe(false);
    expect(sim.player.enterTarget).toBeNull();
    expect(sim.player.state).toBe('dead');
    step(sim, 6);
    expect(sim.player.alive).toBe(true);
    expect(sim.player.enterTarget).toBeNull();
    expect(v.ai!.hold).toBe(false);
  });

  it('being busted while carjacking releases the car and the player', () => {
    const sim = makeSim();
    const v = carAtPlayer(sim);
    sim.addDriver(v, 'civilian', 'traffic');
    sim.update(1 / 60, input({ enterExit: true }));
    expect(v.ai!.hold).toBe(true);
    sim.bustPlayer();
    step(sim, 0.1);
    expect(sim.deathKind).toBe('busted');
    expect(v.ai!.hold).toBe(false);
    expect(sim.player.enterTarget).toBeNull();
    expect(sim.player.state).toBe('normal');
  });

  it('pressing F right behind a bus gets the player in', () => {
    const sim = makeSim();
    const rp = roadPoint(sim, 60, 20);
    const bus = sim.spawnVehicle('bus', rp.x, rp.z, rp.heading);
    teleport(sim, rp.x - Math.sin(rp.heading) * (bus.halfL + 1.2), rp.z - Math.cos(rp.heading) * (bus.halfL + 1.2));
    expect(sim.playerCtl.findEnterable(sim.player)).toBe(bus);
    sim.update(1 / 60, input({ enterExit: true }));
    step(sim, 1.5);
    expect(sim.player.state).toBe('inVehicle');
    expect(sim.player.vehicle).toBe(bus);
  });
});

describe('sanitize', () => {
  it('repairs non-finite smoothed vehicle values the renderer and audio read', () => {
    const sim = makeSim();
    const v = carAtPlayer(sim);
    placeInCar(sim, v);
    v.rpm = NaN;
    v.steer = NaN;
    v.climbRate = NaN;
    v.skid = NaN;
    v.wheelSpin = NaN;
    v.vel.x = NaN;
    sim.update(1 / 60, input({ throttle: 1 }));
    for (const val of [v.rpm, v.steer, v.climbRate, v.skid, v.wheelSpin, v.speed, v.forwardSpeed]) expect(Number.isFinite(val)).toBe(true);
    step(sim, 1, input({ throttle: 1 }));
    expect(v.speed).toBeGreaterThan(3);
    expect(Number.isFinite(v.rpm) && v.rpm > 0).toBe(true);
  });
});

describe('stolen police cars', () => {
  it('getting back into a stolen cruiser is not a new theft', () => {
    const sim = makeSim();
    const v = carAtPlayer(sim, 'police');
    v.owner = 'police';
    const crimes = spyCrimes(sim);
    sim.update(1 / 60, input({ enterExit: true }));
    step(sim, 1);
    expect(sim.player.vehicle).toBe(v);
    expect(crimes).toEqual(['stealPoliceCar']);
    expect(sim.wanted.level).toBe(2);
    // The player evades the police, then steps out and gets back in.
    sim.wanted.clear();
    sim.police.dismissAll();
    expect(sim.wanted.level).toBe(0);
    expect(sim.playerCtl.exitVehicle(false)).toBe(true);
    step(sim, 1);
    sim.update(1 / 60, input({ enterExit: true }));
    step(sim, 1);
    expect(sim.player.vehicle).toBe(v);
    expect(crimes).toEqual(['stealPoliceCar']);
    expect(sim.wanted.level).toBe(0);
  });
});

describe('sinking cars stay in the water', () => {
  /** A car that has fallen in at (x, z) and is sinking at height y. */
  function sinking(sim: Sim, kind: 'sedan' | 'bus', x: number, z: number, heading: number, y: number): Vehicle {
    const v = sim.spawnVehicle(kind, x, z, heading);
    v.pos.y = y;
    v.inWater = true;
    return v;
  }

  it('a rocket blast does not lift a sinking car back onto the quay', () => {
    const sim = makeSim();
    const b = sim.world.bounds;
    const v = sinking(sim, 'sedan', b.landMinX - 3, 0, -Math.PI / 2, WATER_Y - 2.6);
    step(sim, 0.1);
    const y0 = v.pos.y;
    // Rocket strength, just on the seaward side: the push alone carries the car about 3.5 m towards land.
    sim.combat.explosion(v.pos.x - 1, v.pos.y + 0.8, v.pos.z, 8, 420, null, null);
    let maxY = -Infinity;
    step(sim, 30, () => {
      maxY = Math.max(maxY, v.pos.y);
      return input();
    });
    expect(v.inWater).toBe(true);
    expect(v.pos.x).toBeLessThan(b.landMinX);
    expect(maxY).toBeLessThan(y0 + 0.1);
    expect(v.pos.y + v.spec.height).toBeLessThan(WATER_Y);
  });

  it('a car that has just fallen in and drifts back stops at the quay wall', () => {
    const sim = makeSim();
    const b = sim.world.bounds;
    const v = sinking(sim, 'sedan', b.landMinX - 2.5, 0, -Math.PI / 2, WATER_Y + 0.1);
    v.vel.x = 6;
    let maxNose = -Infinity;
    step(sim, 5, () => {
      maxNose = Math.max(maxNose, v.pos.x + v.halfL);
      return input();
    });
    // The roof is above the quay while the car is still near the surface: the body must not cut into the quay.
    expect(maxNose).toBeLessThan(b.landMinX + 0.3);
  });

  it('a wreck sunk off the end of the beach is not lifted onto the sand', () => {
    const sim = makeSim();
    const b = sim.world.bounds;
    // The surf sand there is still deeper than cars sink in, but 2 m above the sunk bus.
    const v = sinking(sim, 'bus', 575, b.landMinZ - 1, Math.PI / 2, WATER_Y - 3.2);
    v.vel.z = 5;
    let maxY = -Infinity;
    step(sim, 10, () => {
      maxY = Math.max(maxY, v.pos.y);
      return input();
    });
    expect(maxY).toBeLessThan(WATER_Y - 3.1);
    expect(v.pos.y + v.spec.height).toBeLessThan(WATER_Y + 0.01);
  });

  it('a bus driven off the side of the pier ends up with its roof under the deck', () => {
    for (const x of [560, 590]) {
      const sim = makeSim();
      const bus = sim.spawnVehicle('bus', x, 40, 0);
      placeInCar(sim, bus);
      step(sim, 12, () => input({ throttle: bus.inWater ? 0 : 0.6 }));
      step(sim, 20);
      expect(bus.inWater).toBe(true);
      const ct = makeContact();
      const obb = vehicleObb(bus, { x: 0, z: 0, hw: 0, hl: 0, h: 0 });
      const decks = sim.world.layout.decks.filter((d) => obbVsAabb(obb, d.rect, ct));
      // It comes to rest partly under the pier; the deck slab is 0.35 m thick.
      expect(decks.length).toBeGreaterThan(0);
      for (const d of decks) expect(bus.pos.y + bus.spec.height).toBeLessThan(d.y - 0.35);
    }
  });
});
