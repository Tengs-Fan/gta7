// Data-driven kinds: the per-kind render, audio and HUD data lives on the spec entries (or has a documented default),
// so a vehicle, weapon or pickup kind added to the specs alone works everywhere.
// The tables below are copied from the baseline commit 72d0b98.

import { afterEach, describe, expect, it } from 'vitest';
import { engineParams, engineProfile, ENGINE_PROFILES } from '../../src/audio/vehicleProfiles';
import { flashSize, FLASH_SIZE } from '../../src/render/effects';
import { firingRow, WEAPON_POINTS, windowMuzzle } from '../../src/sim/pose';
import { DEFAULT_PICKUP_ICON_COLOR, PICKUP_SPECS, pickupIconColor } from '../../src/sim/pickups';
import type { PickupKind } from '../../src/sim/entities';
import {
  DEFAULT_ENGINE_PROFILE,
  DEFAULT_FLASH_SIZE,
  DEFAULT_WEAPON_ICON,
  VEHICLE_SPECS,
  WEAPON_ORDER,
  WEAPONS,
  weaponIconOf,
  weaponPointsOf,
  type VehicleKind,
  type VehicleSpec,
  type WeaponId,
  type WeaponSpec,
} from '../../src/sim/specs';
import { input, makeSim, placeInCar, roadPoint, step } from './helpers';

const BASE_FIRING_ROWS: Record<string, [number, number]> = {
  compact: [0, 0],
  sedan: [0, -0.135],
  taxi: [0, -0.135],
  sports: [0, 0],
  muscle: [0, 0],
  pickup: [0, 0],
  van: [0.24, 0.24],
  bus: [0, 0],
  police: [0, -0.138],
  swat: [0.283, (-0.24 + -0.07) / 2],
};

const DEFAULT_HORN = [392, 494];
const BASE_ENGINES: Record<string, object> = {
  compact: { cylinders: 3, idleRpm: 900, redlineRpm: 6500, brightness: 0.65, roughness: 0.35, loudness: -3, horn: [466, 587] },
  sedan: { cylinders: 4, idleRpm: 800, redlineRpm: 6500, brightness: 0.5, roughness: 0.12, loudness: -1.5, horn: DEFAULT_HORN },
  taxi: { cylinders: 4, idleRpm: 800, redlineRpm: 6500, brightness: 0.5, roughness: 0.15, loudness: -1.5, horn: DEFAULT_HORN },
  sports: { cylinders: 6, idleRpm: 900, redlineRpm: 8500, brightness: 0.85, roughness: 0.08, loudness: 0, horn: [440, 554] },
  muscle: { cylinders: 8, idleRpm: 700, redlineRpm: 6000, brightness: 0.55, roughness: 0.3, loudness: 1, horn: [349, 440], uneven: true },
  pickup: { cylinders: 8, idleRpm: 650, redlineRpm: 5200, brightness: 0.4, roughness: 0.22, loudness: 0.5, horn: [330, 415] },
  police: { cylinders: 8, idleRpm: 750, redlineRpm: 6500, brightness: 0.6, roughness: 0.12, loudness: 0.5, horn: DEFAULT_HORN },
  van: { cylinders: 4, idleRpm: 600, redlineRpm: 3500, brightness: 0.35, roughness: 0.3, loudness: -0.5, horn: [311, 392], diesel: true },
  swat: { cylinders: 6, idleRpm: 600, redlineRpm: 3200, brightness: 0.35, roughness: 0.25, loudness: 1, horn: [262, 330], diesel: true },
  bus: { cylinders: 6, idleRpm: 550, redlineRpm: 2600, brightness: 0.3, roughness: 0.2, loudness: 1.5, horn: [220, 277], diesel: true },
};

/** The vehicle kinds wave 1 added (track C), with their classes. */
const WAVE1_VEHICLES = ['sportbike', 'scooter'];
const WAVE1_CLASSES: Record<string, string> = { sportbike: 'bike', scooter: 'bike' };

const BASE_FLASH: Record<string, number> = { fists: 0, pistol: 0.3, smg: 0.32, rifle: 0.4, shotgun: 0.55, rocket: 0.6 };

const BASE_PICKUP_COLOR: Record<string, number> = {
  health: 0xff3a3a,
  armor: 0x4aa8ff,
  weapon: 0xd8d8d8,
  money: 0x3fd96b,
  package: 0xf5c542,
  rampage: 0xd01818,
  parcel: 0x8a5a2c,
};

const BASE_POINTS: Record<string, Record<string, [number, number, number]>> = {
  pistol: { tip: [0, 0, 0.21], grip: [0, -0.065, 0.02], fore: [0.03, -0.085, 0.005], stock: [0, 0, -0.01], reload: [0, -0.15, 0.02] },
  smg: { tip: [0, 0, 0.37], grip: [0, -0.1, 0.06], fore: [0, -0.075, 0.25], stock: [0, -0.01, -0.05], reload: [0, -0.15, 0.2] },
  shotgun: { tip: [0, 0, 0.75], grip: [0, -0.07, 0.05], fore: [0, -0.055, 0.31], stock: [0, -0.04, -0.245], reload: [0, -0.055, 0.3] },
  rifle: { tip: [0, 0, 0.705], grip: [0, -0.1, 0.06], fore: [0, -0.065, 0.29], stock: [0, -0.03, -0.25], reload: [0, -0.2, 0.12] },
  rocket: { tip: [0, 0.08, 0.775], grip: [0, -0.075, 0.1], fore: [0, -0.02, 0.32], stock: [0, 0.08, 0.2], reload: [0, 0.06, -0.36] },
};

const BASE_ICONS: Record<string, string> = {
  fists: '<svg viewBox="0 0 64 40"><path d="M18 10c0-3 2-5 5-5h16c4 0 7 3 7 7v6l4 2v9c0 4-3 7-7 7H25c-4 0-7-3-7-7z M24 10v8 M30 9v9 M36 9v9 M42 10v8" stroke="#222" stroke-width="1.5"/></svg>',
  pistol: '<svg viewBox="0 0 64 40"><path d="M8 10h42l4 4v4H30l-3 3h-5l-4 13H9l5-15-6-2z"/></svg>',
  smg: '<svg viewBox="0 0 64 40"><path d="M4 13h46l6 3v4H38l-2 3h-6l-2 12h-7l2-12h-6l-3 8H8l3-10-7-2zM50 11h8v2h-8z"/></svg>',
  shotgun: '<svg viewBox="0 0 64 40"><path d="M2 15h48l10 1v3H40l-4 2H26l-8 9H8l7-10H2z"/></svg>',
  rifle: '<svg viewBox="0 0 64 40"><path d="M2 14h52l8 2v3H44l-3 3h-5l-2 10h-6l2-10h-5l-5 9h-8l5-10H2z M30 12h8v2h-8z"/></svg>',
  rocket: '<svg viewBox="0 0 64 40"><path d="M2 14h50l8 4-8 4H2z M18 22h6l2 10h-6z M34 22h5l1 6h-5z"/></svg>',
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const vehicleSpecs = VEHICLE_SPECS as unknown as Mutable<Record<string, VehicleSpec>>;
const weapons = WEAPONS as unknown as Mutable<Record<string, WeaponSpec>>;
const pickupSpecs = PICKUP_SPECS as unknown as Mutable<Record<string, { iconColor: number }>>;

const FIXTURE_VEHICLE = 'fixture_car' as VehicleKind;
const FIXTURE_WEAPON = 'fixture_gun' as WeaponId;
const FIXTURE_PICKUP = 'fixture_pickup' as PickupKind;

function addFixtures(): void {
  const { engine: _engine, firingRows: _rows, ...bare } = VEHICLE_SPECS.sedan;
  vehicleSpecs[FIXTURE_VEHICLE] = { ...bare, kind: FIXTURE_VEHICLE, name: 'Fixture' };
  const { flashSize: _flash, icon: _icon, ...gun } = WEAPONS.pistol;
  weapons[FIXTURE_WEAPON] = { ...gun, id: FIXTURE_WEAPON, name: 'Fixture Gun', slot: 6 };
  WEAPON_ORDER.push(FIXTURE_WEAPON);
}

function removeFixtures(): void {
  delete vehicleSpecs[FIXTURE_VEHICLE];
  delete weapons[FIXTURE_WEAPON];
  delete pickupSpecs[FIXTURE_PICKUP];
  const i = WEAPON_ORDER.indexOf(FIXTURE_WEAPON);
  if (i >= 0) WEAPON_ORDER.splice(i, 1);
}

afterEach(removeFixtures);

describe('exhaustive kind maps outside the specs are gone', () => {
  const vehicleKinds = Object.keys(BASE_FIRING_ROWS) as VehicleKind[];
  const weaponIds = Object.keys(BASE_FLASH) as WeaponId[];

  it('the spec tables still hold exactly the baseline kinds', () => {
    // Wave 1 (track C) added two motorbikes as spec rows only.
    expect(Object.keys(VEHICLE_SPECS).sort()).toEqual([...vehicleKinds, ...WAVE1_VEHICLES].sort());
    expect(Object.keys(WEAPONS).sort()).toEqual([...weaponIds].sort());
    expect(Object.keys(PICKUP_SPECS).sort()).toEqual(Object.keys(BASE_PICKUP_COLOR).sort());
    expect([...WEAPON_ORDER]).toEqual(['fists', 'pistol', 'smg', 'shotgun', 'rifle', 'rocket']);
  });

  it('firing rows equal the baseline for every vehicle kind', () => {
    for (const k of vehicleKinds) {
      expect(firingRow(k, 1, false), k).toBe(BASE_FIRING_ROWS[k]![0]);
      expect(firingRow(k, 1, true), k).toBe(BASE_FIRING_ROWS[k]![1]);
      expect(firingRow(k, 5.3, true), k).toBe(BASE_FIRING_ROWS[k]![1] * 5.3);
    }
  });

  it('engine profiles equal the baseline for every vehicle kind', () => {
    for (const k of vehicleKinds) {
      expect(engineProfile(k), k).toEqual(BASE_ENGINES[k]);
      expect(ENGINE_PROFILES[k], k).toEqual(BASE_ENGINES[k]);
    }
  });

  it('flash sizes equal the baseline for every weapon', () => {
    for (const w of weaponIds) {
      expect(flashSize(w), w).toBe(BASE_FLASH[w]);
      expect(FLASH_SIZE[w], w).toBe(BASE_FLASH[w]);
    }
  });

  it('pickup icon colours equal the baseline for every pickup kind', () => {
    for (const [k, c] of Object.entries(BASE_PICKUP_COLOR)) expect(pickupIconColor(k as PickupKind), k).toBe(c);
  });

  it('weapon held points equal the baseline for every gun', () => {
    for (const [gun, pts] of Object.entries(BASE_POINTS)) {
      for (const [name, [x, y, z]] of Object.entries(pts)) {
        const got = weaponPointsOf(gun as WeaponId)[name as 'tip'];
        expect([got.x, got.y, got.z], `${gun}.${name}`).toEqual([x, y, z]);
        expect(WEAPON_POINTS[gun as 'pistol'][name as 'tip'], `${gun}.${name}`).toEqual(got);
      }
    }
  });

  it('weapon icons equal the baseline HUD icons for every weapon', () => {
    for (const w of weaponIds) expect(weaponIconOf(w), w).toBe(BASE_ICONS[w]);
  });
});

describe('a kind added to the specs alone', () => {
  it('has documented defaults for every lookup, without throwing', () => {
    addFixtures();
    expect(firingRow(FIXTURE_VEHICLE, 4.7, false)).toBe(0);
    expect(firingRow(FIXTURE_VEHICLE, 4.7, true)).toBe(0);
    expect(engineProfile(FIXTURE_VEHICLE)).toBe(DEFAULT_ENGINE_PROFILE);
    expect(engineProfile(FIXTURE_VEHICLE)).toEqual(BASE_ENGINES['sedan']);
    const p = engineParams(FIXTURE_VEHICLE, 0.5, 0.5, 20);
    expect(Object.values(p).every(Number.isFinite)).toBe(true);
    expect(flashSize(FIXTURE_WEAPON)).toBe(DEFAULT_FLASH_SIZE);
    expect(weaponIconOf(FIXTURE_WEAPON)).toBe(DEFAULT_WEAPON_ICON);
    expect(pickupIconColor(FIXTURE_PICKUP)).toBe(DEFAULT_PICKUP_ICON_COLOR);
    expect(weaponPointsOf(FIXTURE_WEAPON)).toBe(WEAPONS.pistol.points);
  });

  it('takes the values on its spec entry when it has them', () => {
    addFixtures();
    const spec = vehicleSpecs[FIXTURE_VEHICLE]!;
    spec.engine = { cylinders: 2, idleRpm: 500, redlineRpm: 4000, brightness: 0.1, roughness: 0.1, loudness: 3, horn: [200, 250] };
    spec.firingRows = [0.1, -0.2];
    weapons[FIXTURE_WEAPON]!.flashSize = 0.9;
    weapons[FIXTURE_WEAPON]!.icon = '<svg/>';
    pickupSpecs[FIXTURE_PICKUP] = { iconColor: 0x123456 };
    expect(engineProfile(FIXTURE_VEHICLE).cylinders).toBe(2);
    expect(firingRow(FIXTURE_VEHICLE, 10, false)).toBeCloseTo(1, 12);
    expect(firingRow(FIXTURE_VEHICLE, 10, true)).toBeCloseTo(-2, 12);
    expect(flashSize(FIXTURE_WEAPON)).toBe(0.9);
    expect(weaponIconOf(FIXTURE_WEAPON)).toBe('<svg/>');
    expect(pickupIconColor(FIXTURE_PICKUP)).toBe(0x123456);
  });

  it('spawns and is driven for 60 frames without throwing', () => {
    addFixtures();
    const sim = makeSim();
    const rp = roadPoint(sim);
    const car = sim.spawnVehicle(FIXTURE_VEHICLE, rp.x, rp.z, rp.heading);
    placeInCar(sim, car);
    const out = { x: 0, y: 0, z: 0 };
    expect(() => windowMuzzle(car, 0, out)).not.toThrow();
    expect(Number.isFinite(out.x + out.y + out.z)).toBe(true);
    step(sim, 1, input({ throttle: 1 }));
    expect(car.speed).toBeGreaterThan(1);
    expect(Number.isFinite(car.pos.x + car.pos.z)).toBe(true);
  });

  it('is given and fired for 60 frames without throwing', () => {
    addFixtures();
    const sim = makeSim();
    const inv = sim.player.inventory;
    inv.give(FIXTURE_WEAPON, 100);
    inv.current = FIXTURE_WEAPON;
    const before = inv.total(FIXTURE_WEAPON);
    expect(() => step(sim, 1, input({ fire: true, firePressed: true }))).not.toThrow();
    expect(inv.total(FIXTURE_WEAPON)).toBeLessThan(before);
  });
});

describe('VehicleSpec.class', () => {
  it('is present on every spec and is "car" for all current vehicles', () => {
    // The baseline kinds are cars; wave 1's motorbikes and boats are classed as such.
    for (const spec of Object.values(VEHICLE_SPECS)) expect(spec.class, spec.kind).toBe(WAVE1_CLASSES[spec.kind] ?? 'car');
    for (const k of Object.keys(BASE_FIRING_ROWS)) expect(VEHICLE_SPECS[k as VehicleKind].class, k).toBe('car');
  });
});
