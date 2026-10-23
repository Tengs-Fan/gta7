// Azura Express courier: stop a car or bike at the courier office (in front of First Azura Bank) and press T for a parcel
// run of COURIER_DROPS drop-offs, shown one at a time. Each drop has its own clock; delivering pays COURIER_BASE plus
// COURIER_BONUS for every whole second left on it. Running out of time ends the run with nothing more paid.

import { formatMoney } from '../../core/math';
import type { Vehicle } from '../entities';
import { places } from './places';
import { activityRecords } from './records';
import { awayStatus, outOfVehicle } from './service';
import type { ActivityDef, ActivityHost, Objective } from './types';

export const COURIER_DROPS = 3;
export const COURIER_BASE = 60;
export const COURIER_BONUS = 4;
/** Paid on top for finishing the whole run. */
export const COURIER_RUN_BONUS = 150;
/** A drop-off takes the parcel once the vehicle stops (below DROP_SPEED m/s) within DROP_RADIUS m of it. */
export const DROP_RADIUS = 8.5;
export const DROP_SPEED = 2.5;

export interface CourierJob {
  kind: 'courier';
  car: Vehicle;
  drops: Array<{ x: number; z: number; name: string }>;
  /** The drop being driven to. */
  index: number;
  timer: number;
  /** Paid so far on this run. */
  earned: number;
  away: number;
}

/** What a drop-off delivered with `secondsLeft` on its clock pays. */
export function courierPay(secondsLeft: number): number {
  return COURIER_BASE + COURIER_BONUS * Math.max(0, Math.floor(secondsLeft));
}

/** Seconds on a drop's clock: 20 plus one for every 10 m to it in a straight line. */
export function dropTime(dist: number): number {
  return Math.round(20 + dist / 10);
}

function startDrop(host: ActivityHost, j: CourierJob): void {
  const d = j.drops[j.index]!;
  j.timer = dropTime(Math.hypot(d.x - j.car.pos.x, d.z - j.car.pos.z));
  host.say(`Parcel ${j.index + 1} of ${j.drops.length}: deliver it in ${d.name}.`, 3);
}

/** A vehicle the courier office takes: a car or bike that drives, not a police or job vehicle. */
function courierVehicle(v: Vehicle | null | undefined): v is Vehicle {
  return !!v && v.drivable && (v.spec.class === 'car' || v.spec.class === 'bike') && !v.spec.police && !v.missionTag && v.kind !== 'bus';
}

function atOffice(host: ActivityHost, v: Vehicle): boolean {
  const c = places(host.sim.world).courier;
  return Math.hypot(v.pos.x - c.x, v.pos.z - c.z) < c.radius;
}

function updateCourier(host: ActivityHost, j: CourierJob, dt: number): void {
  const sim = host.sim;
  const car = j.car;
  if (outOfVehicle(host, j, car, 'The parcels went up with your ride. Courier run over.', 'You left your ride. Courier run over.', dt)) return;
  j.timer -= dt;
  if (j.timer <= 0) {
    host.end(`Too slow! Courier run over. Earned ${formatMoney(j.earned)}.`);
    return;
  }
  const d = j.drops[j.index]!;
  if (car.speed >= DROP_SPEED || Math.hypot(d.x - car.pos.x, d.z - car.pos.z) >= DROP_RADIUS) return;
  const pay = courierPay(j.timer);
  sim.progress.addMoney(pay);
  sim.events.emit('money', { amount: pay });
  j.earned += pay;
  const rec = activityRecords(sim.progress);
  rec.parcelsDelivered++;
  j.index++;
  if (j.index < j.drops.length) {
    sim.events.emit('big', { text: 'PARCEL DELIVERED', sub: formatMoney(pay), style: 'info', duration: 2 });
    startDrop(host, j);
    return;
  }
  sim.progress.addMoney(COURIER_RUN_BONUS);
  sim.events.emit('money', { amount: COURIER_RUN_BONUS });
  j.earned += COURIER_RUN_BONUS;
  rec.courierRuns++;
  sim.events.emit('big', { text: 'COURIER RUN COMPLETE', sub: formatMoney(j.earned), style: 'passed', duration: 3 });
  host.end('');
  sim.events.emit('activityMilestone', { kind: 'courier', reward: pay + COURIER_RUN_BONUS });
}

export const courierActivity: ActivityDef<CourierJob> = {
  kind: 'courier',
  toggleEndText: 'Courier run cancelled.',
  site: { label: 'C', name: 'Courier', at: (world) => places(world).courier },
  completion: (_view, me) => ({ label: 'Azura Express courier run', done: Math.min(1, activityRecords(me.progress).courierRuns), total: 1 }),

  canStart: (host, _slot, vehicle) => courierVehicle(vehicle) && atOffice(host, vehicle),

  prompt: (_host, _slot, vehicle) => (vehicle && vehicle.speed < 1 ? 'Press T to start an Azura Express courier run' : null),

  start(host, _slot, car) {
    if (!courierVehicle(car)) return false;
    const sim = host.sim;
    const drops: CourierJob['drops'] = [];
    let from = { x: car.pos.x, z: car.pos.z };
    for (let i = 0; i < COURIER_DROPS; i++) {
      const pt = sim.world.walk.randomPointNear(sim.rng, from.x, from.z, 140, 320);
      if (!pt) break;
      drops.push({ x: pt.x, z: pt.z, name: sim.world.zoneName(pt.x, pt.z) });
      from = pt;
    }
    if (drops.length < COURIER_DROPS) return false;
    const j: CourierJob = { kind: 'courier', car, drops, index: 0, timer: 0, earned: 0, away: 0 };
    host.job = j;
    sim.events.emit('big', { text: 'AZURA EXPRESS', sub: `${COURIER_DROPS} parcels: the faster, the bigger the tip`, style: 'title', duration: 3 });
    startDrop(host, j);
    return true;
  },

  update: updateCourier,

  end() {},

  objectives(j): Objective[] {
    const d = j.drops[j.index];
    return d ? [{ x: d.x, z: d.z, label: d.name, color: 0xffd23d, radius: DROP_RADIUS - 1 }] : [];
  },

  status: (j) => awayStatus(j, 'VEHICLE') ?? `COURIER ${j.index + 1}/${j.drops.length}  ·  ${Math.max(0, Math.ceil(j.timer))}  ·  TIP ${formatMoney(COURIER_BONUS * Math.max(0, Math.floor(j.timer)))}`,
};
