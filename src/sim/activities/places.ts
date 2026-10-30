// Fixed places of the wave-1 activities and properties, laid out against the city's points of interest so that they
// move with them: service vehicle depots, the hospital drop-off, the courier office, Lou's export board and the crane,
// the garage across the street from the safehouse, the Pier Arcade and Azura Customs.

import { mkRect, rectContains, type Rect } from '../../world/layout';
import type { StaticWorld } from '../../world/staticWorld';
import type { VehicleKind } from '../specs';

export interface Spot {
  x: number;
  z: number;
  heading: number;
}

export interface Places {
  /** Where the activity vehicles stand ready (see serviceVehicles.ts). */
  depots: Array<Spot & { kind: VehicleKind; name: string }>;
  /** San Azura General's ambulance bay, on the road at its door. */
  hospitalDrop: Spot & { radius: number };
  /** Azura Express: a car or bike stopped here is offered a courier run. */
  courier: Spot & { radius: number };
  /** Lou's export board (on foot) and the docks crane drop-off (in the car). */
  exportBoard: Spot;
  crane: Rect;
  /** The garage's four bays across the street from the safehouse, its walk-up marker and the area that counts as inside. */
  garageBays: Spot[];
  garageMarker: Spot;
  garageArea: Rect;
  /** The Pier Arcade's marker on Azura Pier. */
  arcade: Spot;
  /** Azura Customs: the drive-in bay. */
  customsBay: Rect;
  customsSign: Spot;
}

const cache = new WeakMap<StaticWorld, Places>();

function poi(world: StaticWorld, id: string): { x: number; z: number; heading: number } {
  const p = world.layout.pois.find((q) => q.id === id);
  if (!p) throw new Error(`no POI ${id}`);
  return p;
}

export function places(world: StaticWorld): Places {
  let p = cache.get(world);
  if (p) return p;
  const home = poi(world, 'safehouse');
  const hospital = poi(world, 'hospital');
  const police = poi(world, 'police');
  const lou = poi(world, 'lou');
  const bank = poi(world, 'bank');
  const pier = world.layout.decks.find((d) => d.name === 'Azura Pier')!.rect;
  const cranes = world.layout.props.filter((q) => q.kind === 'crane').sort((a, b) => a.x - b.x);
  const crane = cranes[Math.floor(cranes.length / 2)] ?? { x: lou.x - 137, z: lou.z + 131 };
  // The parking lot across the street from the safehouse door: four bays along its east side, facing the wall.
  const bx = home.x + 1.4;
  const bz = home.z + 25.2;
  const garageBays = [0, 1, 2, 3].map((k) => ({ x: bx, z: bz + k * 3.4, heading: Math.PI / 2 }));
  p = {
    depots: [
      { kind: 'ambulance', name: 'San Azura General', x: hospital.x - 22.5, z: hospital.z - 7.8, heading: 0 },
      // At the curb of Central Ave beside SAPD Central's door, with the westbound traffic (the station faced Cortez St before the canal took it).
      { kind: 'firetruck', name: 'SAFD Station 1', x: police.x - 18, z: police.z + 4.2, heading: -Math.PI / 2 },
    ],
    hospitalDrop: { x: hospital.x, z: hospital.z + 6.5, heading: -Math.PI / 2, radius: 8 },
    courier: { x: bank.x - 4.2, z: bank.z - 9, heading: Math.PI, radius: 7 },
    exportBoard: { x: lou.x + 6, z: lou.z, heading: lou.heading },
    crane: mkRect(crane.x - 12, crane.z - 22, crane.x + 12, crane.z - 8),
    garageBays,
    garageMarker: { x: home.x - 4.5, z: home.z + 20.6, heading: 0 },
    garageArea: mkRect(bx - 3.4, bz - 2.2, bx + 3.4, bz + 3 * 3.4 + 2.2),
    arcade: { x: pier.minX + 135, z: (pier.minZ + pier.maxZ) / 2 - 2.5, heading: Math.PI },
    customsBay: mkRect(hospital.x - 10.5, hospital.z + 147, hospital.x - 2.5, hospital.z + 159),
    customsSign: { x: hospital.x - 6.5, z: hospital.z + 146.5, heading: 0 },
  };
  cache.set(world, p);
  return p;
}

export function inRect(r: Rect, x: number, z: number): boolean {
  return rectContains(r, x, z);
}
