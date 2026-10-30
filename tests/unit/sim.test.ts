import { describe, expect, it } from 'vitest';
import { obbVsAabb, makeContact } from '../../src/core/collision';
import { applySave, parseSave, Progress, serialize } from '../../src/sim/progress';
import { vehicleObb } from '../../src/sim/vehiclePhysics';
import { aimAt, allFinite, input, makeSim, placeInCar, roadPoint, step, teleport } from './helpers';

describe('player on foot', () => {
  it('walks and sprints relative to the camera', () => {
    const sim = makeSim();
    const p = sim.player;
    const start = { ...p.pos };
    // Camera looking +Z: pushing forward walks +Z.
    step(sim, 2, input({ moveZ: 1, cameraYaw: 0 }));
    expect(p.pos.z - start.z).toBeGreaterThan(6);
    expect(Math.abs(p.pos.x - start.x)).toBeLessThan(0.5);
    const z1 = p.pos.z;
    step(sim, 1, input({ moveZ: 1, cameraYaw: 0, sprint: true }));
    expect(p.pos.z - z1).toBeGreaterThan(6);
    // Camera looking +X: pushing right walks towards +Z... right of +X heading is (-cos, sin) = (0, 1).
    const x0 = p.pos.x;
    const z0 = p.pos.z;
    step(sim, 1, input({ moveX: 1, cameraYaw: Math.PI / 2 }));
    expect(p.pos.z - z0).toBeGreaterThan(3);
    expect(Math.abs(p.pos.x - x0)).toBeLessThan(0.6);
  });

  it('jumps and lands', () => {
    const sim = makeSim();
    const p = sim.player;
    const y0 = p.pos.y;
    sim.update(1 / 60, input({ jump: true }));
    let maxY = y0;
    for (let i = 0; i < 60; i++) {
      sim.update(1 / 60, input());
      maxY = Math.max(maxY, p.pos.y);
    }
    expect(maxY - y0).toBeGreaterThan(0.9);
    expect(p.pos.y).toBeCloseTo(y0, 3);
    expect(p.onGround).toBe(true);
  });

  it('cannot walk through buildings', () => {
    const sim = makeSim();
    const b = sim.world.layout.buildings.find((x) => x.district === 'downtown')!;
    const p = sim.player;
    // Stand south of the building and walk north into it.
    teleport(sim, (b.rect.minX + b.rect.maxX) / 2, b.rect.maxZ + 3);
    step(sim, 3, input({ moveZ: 1, cameraYaw: Math.PI }));
    expect(p.pos.z).toBeGreaterThan(b.rect.maxZ + p.radius - 0.02);
  });
});

describe('vehicles', () => {
  it('lets the player get in and drive', () => {
    const sim = makeSim();
    const rp = roadPoint(sim, 60, 15);
    teleport(sim, rp.x + Math.cos(rp.heading) * 2.4, rp.z - Math.sin(rp.heading) * 2.4);
    const v = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    sim.update(1 / 60, input({ enterExit: true }));
    expect(sim.player.state).toBe('entering');
    step(sim, 1);
    expect(sim.player.state).toBe('inVehicle');
    expect(sim.player.vehicle).toBe(v);
    step(sim, 3, input({ throttle: 1 }));
    expect(v.forwardSpeed).toBeGreaterThan(12);
    // Brake to a stop (holding brake longer would start reversing).
    let stoppedAt = -1;
    step(sim, 2, (t) => {
      if (stoppedAt < 0 && Math.abs(v.forwardSpeed) < 0.6) stoppedAt = t;
      return stoppedAt < 0 ? input({ brake: 1 }) : input();
    });
    expect(stoppedAt).toBeGreaterThan(0);
    expect(stoppedAt).toBeLessThan(1.6);
    expect(Math.abs(v.forwardSpeed)).toBeLessThan(1);
    // Get out.
    sim.update(1 / 60, input({ enterExit: true }));
    step(sim, 0.5);
    expect(sim.player.state).toBe('normal');
    expect(v.driver).toBeNull();
  });

  it('turns right when steering right', () => {
    const sim = makeSim();
    const v = sim.spawnVehicle('sedan', 0, 0, Math.PI); // facing north (-Z)
    placeInCar(sim, v);
    // Use open water-free land: the center of the city is a road crossing, fine for a few metres.
    step(sim, 1.2, input({ throttle: 1 }));
    const h0 = v.heading;
    step(sim, 0.6, input({ throttle: 0.6, steer: 1 }));
    // Heading pi -> pi/2 (east) when turning right while driving north.
    const dh = Math.atan2(Math.sin(v.heading - h0), Math.cos(v.heading - h0));
    expect(dh).toBeLessThan(-0.15);
  });

  it('reaches top speed in a straight line and never NaNs', () => {
    const sim = makeSim();
    // Long north-south lane on the east ring avenue.
    const lane = sim.roads.lanes.find((l) => l.line.vertical && l.line.index === 10 && l.dir === 2)!;
    const v = sim.spawnVehicle('sports', lane.sx, lane.sz, lane.heading);
    placeInCar(sim, v);
    let maxV = 0;
    step(sim, 4, (t) => {
      maxV = Math.max(maxV, v.speed);
      return input({ throttle: 1, steer: t > 3 ? 0.2 : 0 });
    });
    expect(maxV).toBeGreaterThan(30);
    expect(allFinite(sim)).toBe(true);
  });

  it('collides with buildings without tunnelling and takes damage', () => {
    const sim = makeSim();
    // A downtown building that touches the south edge of its lot, so nothing stands in between.
    const L = sim.world.layout;
    const b = L.buildings.find((x) => {
      const blk = L.blocks.find((k) => k.lot.minX <= x.rect.minX && k.lot.maxX >= x.rect.maxX && k.lot.minZ <= x.rect.minZ && k.lot.maxZ >= x.rect.maxZ);
      return x.district === 'downtown' && x.rect.maxX - x.rect.minX > 14 && blk && blk.lot.maxZ - x.rect.maxZ < 3;
    })!;
    const blk = L.blocks.find((k) => k.lot.minX <= b.rect.minX && k.lot.maxX >= b.rect.maxX && k.lot.minZ <= b.rect.minZ && k.lot.maxZ >= b.rect.maxZ)!;
    const road = L.hLines[blk.bj + 1]!;
    const cx = (b.rect.minX + b.rect.maxX) / 2;
    // Start on the road south of the block and drive north into the building.
    for (const pr of sim.world.grid.colliders) if (pr.breakable || pr.tag === 'tree') pr.broken = true;
    const v = sim.spawnVehicle('sedan', cx, road.pos, Math.PI);
    placeInCar(sim, v);
    step(sim, 4, input({ throttle: 1 }));
    const c = makeContact();
    const obb = vehicleObb(v, { x: 0, z: 0, hw: 0, hl: 0, h: 0 });
    obb.hw -= 0.05;
    obb.hl -= 0.05;
    expect(obbVsAabb(obb, b.rect, c)).toBe(false);
    expect(v.health).toBeLessThan(v.spec.health);
    expect(v.pos.z).toBeGreaterThan(b.rect.maxZ);
  });

  it('launches off a stunt ramp and pays a stunt bonus', () => {
    const sim = makeSim();
    const r = sim.world.layout.ramps[0]!;
    const fx = Math.sin(r.heading);
    const fz = Math.cos(r.heading);
    const v = sim.spawnVehicle('sports', r.x - fx * 45, r.z - fz * 45, r.heading);
    placeInCar(sim, v);
    const money = sim.progress.money;
    let wasAirborne = false;
    let maxAir = 0;
    step(sim, 7, () => {
      if (v.airborne) {
        wasAirborne = true;
        maxAir = Math.max(maxAir, v.airTime);
      }
      return input({ throttle: 1 });
    });
    expect(wasAirborne).toBe(true);
    expect(maxAir).toBeGreaterThan(0.8);
    expect(sim.progress.stunts).toContain(r.id);
    expect(sim.progress.money).toBeGreaterThan(money);
  });

  it('sinks cars driven into the sea and lets the player swim back', () => {
    const sim = makeSim();
    const b = sim.world.bounds;
    // Drive west off the west quay.
    const v = sim.spawnVehicle('sedan', b.landMinX + 25, 0, -Math.PI / 2);
    placeInCar(sim, v);
    step(sim, 4, input({ throttle: 1 }));
    expect(v.inWater).toBe(true);
    expect(sim.player.vehicle).toBeNull();
    expect(sim.player.state).toBe('swimming');
    // Swim east to the quay and climb out.
    step(sim, 12, input({ moveZ: 1, cameraYaw: Math.PI / 2 }));
    expect(sim.player.state).toBe('normal');
    expect(sim.player.pos.x).toBeGreaterThan(b.landMinX);
  });
});

describe('ambient city', () => {
  it('streams traffic and pedestrians that behave', () => {
    const sim = makeSim({ ambient: true, police: false });
    const node = sim.roads.node(5, 5);
    teleport(sim, node.x + 12, node.z + 12);
    step(sim, 40);
    const traffic = sim.vehicles.filter((v) => v.owner === 'traffic');
    const peds = sim.characters.filter((c) => c.owner === 'ped');
    expect(traffic.length).toBeGreaterThan(10);
    expect(peds.length).toBeGreaterThan(12);
    expect(allFinite(sim)).toBe(true);
    // Traffic makes progress over time (instant snapshots are dominated by red lights).
    const start = new Map(traffic.map((v) => [v.id, { x: v.pos.x, z: v.pos.z }]));
    step(sim, 20);
    const still = traffic.filter((v) => !v.removed && start.has(v.id));
    const progressed = still.filter((v) => Math.hypot(v.pos.x - start.get(v.id)!.x, v.pos.z - start.get(v.id)!.z) > 25).length;
    expect(progressed).toBeGreaterThan(still.length * 0.6);
    // No car is stuck inside a building.
    const c = makeContact();
    for (const v of sim.vehicles) {
      const obb = vehicleObb(v, { x: 0, z: 0, hw: 0, hl: 0, h: 0 });
      obb.hw -= 0.1;
      obb.hl -= 0.1;
      for (const b of sim.world.layout.buildings) expect(obbVsAabb(obb, b.rect, c)).toBe(false);
    }
  });
});

describe('combat, wanted level and police', () => {
  it('shoots a pedestrian and gets a wanted star for murder', () => {
    const sim = makeSim();
    const p = sim.player;
    p.inventory.give('pistol', 48);
    p.inventory.current = 'pistol';
    const v = sim.spawnCharacter('civilian', p.pos.x + Math.sin(p.heading) * 6, p.pos.z + Math.cos(p.heading) * 6);
    for (let i = 0; i < 120 && v.alive; i++) {
      const inp = aimAt(sim, { x: v.pos.x, y: v.pos.y + 1.2, z: v.pos.z }, { fire: true, firePressed: i % 16 === 0, aim: true });
      sim.update(1 / 60, inp);
    }
    expect(v.alive).toBe(false);
    expect(sim.wanted.level).toBeGreaterThanOrEqual(1);
    expect(sim.progress.stats.kills).toBe(1);
  });

  it('dispatches police that chase and can be evaded', () => {
    const sim = makeSim({ ambient: true });
    const node = sim.roads.node(3, 6);
    teleport(sim, node.x + 10, node.z + 10);
    // Standing still at 2 stars gets you arrested; this test is about pursuit, not arrests.
    sim.missions.noBust = true;
    sim.cheats.godMode = true;
    sim.wanted.setLevel(2);
    step(sim, 20);
    const units = sim.vehicles.filter((v) => v.owner === 'police');
    expect(units.length).toBeGreaterThanOrEqual(2);
    expect(units.some((u) => u.ai?.policy === 'chase' || u.driver === null)).toBe(true);
    expect(sim.wanted.level).toBeGreaterThanOrEqual(2);
    // Hide far away from everyone: teleport to the other side of the map, wait out the evasion timer.
    sim.police.dismissAll();
    const far = sim.roads.node(9, 0);
    teleport(sim, far.x + 10, far.z + 12);
    sim.ambient = false;
    step(sim, sim.wanted.evadeTime() + 3);
    expect(sim.wanted.level).toBe(0);
  });

  // Round 2 (police, P62): bail is $100 + $150 a star, and the police keep the guns only from 2 stars.
  for (const [stars, confiscated] of [[1, false], [2, true]] as const) {
    it(`busts the player when a cop catches them standing still (${stars} star${stars > 1 ? 's' : ''}: weapons ${confiscated ? 'confiscated' : 'kept'})`, () => {
      const sim = makeSim();
      const p = sim.player;
      p.inventory.give('smg', 100);
      sim.progress.addMoney(1000);
      const money = sim.progress.money;
      sim.wanted.setLevel(stars);
      // Use the police system equipment path for a proper brain, calling it as dispatch does until a spot turns up.
      let unit = sim.police.spawnUnit('police', true);
      for (let i = 0; i < 10 && !unit; i++) unit = sim.police.spawnUnit('police', true);
      expect(unit).not.toBeNull();
      // Move the crew next to the player on foot.
      for (const c of unit!.occupants()) {
        sim.unseat(c);
        c.state = 'normal';
        c.pos.x = p.pos.x + 0.9;
        c.pos.z = p.pos.z;
        c.pos.y = p.pos.y;
      }
      step(sim, 2);
      expect(sim.deathKind).toBe('busted');
      step(sim, 5);
      expect(sim.deathKind).toBeNull();
      const police = sim.world.layout.pois.find((q) => q.id === 'police')!;
      expect(Math.hypot(p.pos.x - police.x, p.pos.z - police.z)).toBeLessThan(12);
      expect(p.inventory.has('smg')).toBe(!confiscated);
      expect(sim.progress.money).toBe(money - 100 - 150 * stars);
      expect(sim.wanted.level).toBe(0);
    });
  }

  it('respawns at the hospital after being wasted', () => {
    const sim = makeSim();
    const p = sim.player;
    sim.combat.damageCharacter(p, 500, null, 'fall', 0, -1, 0);
    expect(p.alive).toBe(false);
    expect(sim.deathKind).toBe('wasted');
    step(sim, 5.5);
    expect(p.alive).toBe(true);
    expect(p.health).toBe(p.maxHealth);
    const h = sim.world.layout.pois.find((q) => q.id === 'hospital')!;
    expect(Math.hypot(p.pos.x - h.x, p.pos.z - h.z)).toBeLessThan(12);
  });

  it('blows up cars with a rocket, chaining nearby vehicles', () => {
    const sim = makeSim();
    const p = sim.player;
    p.inventory.give('rocket', 3);
    p.inventory.current = 'rocket';
    const fx = Math.sin(p.heading);
    const fz = Math.cos(p.heading);
    const rp = sim.roads.nearestLane(p.pos.x + fx * 25, p.pos.z + fz * 25);
    const x = rp.lane.sx + rp.lane.dx * rp.s;
    const z = rp.lane.sz + rp.lane.dz * rp.s;
    const a = sim.spawnVehicle('sedan', x, z, rp.lane.heading);
    const b = sim.spawnVehicle('compact', x + rp.lane.dx * 4.8, z + rp.lane.dz * 4.8, rp.lane.heading);
    sim.update(1 / 60, aimAt(sim, { x: a.pos.x, y: a.pos.y + 0.8, z: a.pos.z }, { fire: true, firePressed: true, aim: true }));
    step(sim, 2);
    expect(a.destroyed).toBe(true);
    expect(b.health).toBeLessThan(b.spec.health);
    step(sim, 7);
    expect(b.destroyed).toBe(true);
    expect(allFinite(sim)).toBe(true);
  });

  it('respray clears the wanted level and repairs the car', () => {
    const sim = makeSim();
    const spray = sim.world.layout.pois.find((q) => q.id === 'spray_docks')!;
    const bay = spray.bay!;
    const v = sim.spawnVehicle('sedan', (bay.minX + bay.maxX) / 2, (bay.minZ + bay.maxZ) / 2, spray.heading + Math.PI);
    placeInCar(sim, v);
    v.health = v.spec.health * 0.4;
    sim.wanted.setLevel(2);
    sim.policeEnabled = false;
    const money = sim.progress.money;
    step(sim, 0.5);
    expect(sim.wanted.level).toBe(0);
    expect(v.health).toBe(v.spec.health);
    // Round 2 (police, P62): a respray costs $100 per star.
    expect(sim.progress.money).toBe(money - 200);
  });
});

describe('progress and saves', () => {
  it('round-trips and rejects garbage', () => {
    const p = new Progress();
    p.addMoney(12345);
    p.markDone('wheels');
    p.packages.push(3, 7);
    const data = serialize(p, [{ id: 'pistol', ammo: 40 }], 50, 13.5, 2);
    const parsed = parseSave(JSON.parse(JSON.stringify(data)));
    expect(parsed).not.toBeNull();
    const q = new Progress();
    applySave(q, parsed!);
    expect(q.money).toBe(p.money);
    expect(q.missionsDone).toEqual(['wheels']);
    expect(q.packages).toEqual([3, 7]);
    expect(parseSave(null)).toBeNull();
    expect(parseSave({ version: 99 })).toBeNull();
    const evil = parseSave({ version: 1, money: 'lots', missionsDone: [1, 'x', {}], weapons: [{ id: 'nuke', ammo: 5 }, { id: 'smg', ammo: -4 }], stats: { kills: Infinity } });
    expect(evil).not.toBeNull();
    expect(evil!.money).toBe(0);
    expect(evil!.missionsDone).toEqual(['x']);
    expect(evil!.weapons).toEqual([{ id: 'smg', ammo: 0 }]);
    expect(evil!.stats.kills).toBe(0);
  });
});
