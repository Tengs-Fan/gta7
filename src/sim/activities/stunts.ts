import { formatMoney } from '../../core/math';
import type { Vehicle } from '../entities';
import type { Sim } from '../sim';

/** Pays the stunt bonus for a jump the player's vehicle has just landed. */
export function onVehicleLanded(sim: Sim, v: Vehicle): void {
  if (!v.driver || !v.driver.isPlayer || v.launchRamp < 0) {
    v.launchRamp = -1;
    return;
  }
  const ramp = v.launchRamp;
  v.launchRamp = -1;
  const air = v.airTime;
  const dist = Math.hypot(v.pos.x - v.launchX, v.pos.z - v.launchZ);
  if (air < 0.8 || dist < 12 || v.destroyed) return;
  const unique = !sim.progress.stunts.includes(ramp);
  let bonus = Math.round((air * 120 + dist * 8) / 10) * 10;
  if (unique) {
    bonus *= 2;
    sim.progress.stunts.push(ramp);
  }
  sim.progress.addMoney(bonus);
  sim.progress.stats.stuntBonuses++;
  sim.progress.stats.bestStuntAir = Math.max(sim.progress.stats.bestStuntAir, air);
  sim.events.emit('money', { amount: bonus });
  sim.events.emit('stunt', { airTime: air, distance: dist, bonus, unique });
  sim.events.emit('big', { text: unique ? 'UNIQUE STUNT BONUS!' : 'STUNT BONUS', sub: `${dist.toFixed(0)} m  ·  ${air.toFixed(1)} s  ·  ${formatMoney(bonus)}`, style: 'stunt', duration: 3.5 });
}
