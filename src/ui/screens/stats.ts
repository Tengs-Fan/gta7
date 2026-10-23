// Stats and Street Run records.

import { formatMoney } from '../../core/math';
import { COMPLETION_GROUP_NAMES, completionPercent, completionRows } from '../../sim/completion';
import { PACKAGE_COUNT } from '../../sim/pickups';
import { formatRunTime } from '../../sim/streetRuns';
import { escapeHtml } from '../hud';
import { h, localPlayer, pushScrolling, type MenuCtx } from './shared';

export function showStats(ctx: MenuCtx): void {
  const sim = ctx.host.sim();
  const me = localPlayer(ctx.host);
  if (!sim || !me) return;
  const s = me.progress.stats;
  const p = me.progress;
  const story = sim.missions.defs.length;
  const done = sim.missions.defs.filter((d) => p.hasDone(d.id)).length;
  const completion = completionPercent(sim, me);
  const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
  const time = `${Math.floor(s.playTime / 3600)}h ${Math.floor((s.playTime % 3600) / 60)}m`;
  const rows: Array<[string, string]> = [
    ['Game completion', `${completion}%`],
    ['Story missions', `${done} / ${story}`],
    ['Hidden packages', `${p.packages.length} / ${PACKAGE_COUNT}`],
    ['Unique stunt jumps', `${p.stunts.length} / ${sim.world.layout.ramps.length}`],
    ['Rampages', `${p.rampages.length} / 3`],
    ['Money earned', formatMoney(s.moneyEarned)],
    ['Money spent', formatMoney(s.moneySpent)],
    ['Time played', time],
    ['People killed', String(s.kills)],
    ['Cops killed', String(s.copsKilled)],
    ['Cars stolen', String(s.carsStolen)],
    ['Vehicles destroyed', String(s.vehiclesDestroyed)],
    ['Shots fired', String(s.shotsFired)],
    ['Headshots', String(s.headshots)],
    ['Distance driven', km(s.distanceDriven)],
    ['Distance on foot', km(s.distanceOnFoot)],
    ['Highest wanted level', '★'.repeat(s.maxWanted) || '—'],
    ['Times wasted', String(s.timesWasted)],
    ['Times busted', String(s.timesBusted)],
    ['Taxi fares', String(s.taxiFares)],
    ['Vigilante level', String(s.vigilanteLevel)],
    ['Stunt bonuses', String(s.stuntBonuses)],
    ['Best stunt airtime', `${s.bestStuntAir.toFixed(1)} s`],
  ];
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel');
  const runs = sim.activities.streetRunCourses().map((c) => {
    const record = p.streetRuns[c.id];
    return `<span>${escapeHtml(c.name)}</span><span>${record ? `${formatRunTime(record.bestTime)} · ${record.medal.toUpperCase()} · ${record.finishes} finish${record.finishes === 1 ? '' : 'es'}` : 'NO TIME SET'}</span>`;
  }).join('');
  // The map screen's checklist, row for row (both read the completion registry).
  const checklist = completionRows(sim, me)
    .map((r) => `<span>${escapeHtml(`${COMPLETION_GROUP_NAMES[r.group] ?? r.group}: ${r.label}`)}</span><span>${r.done} / ${r.total}</span>`)
    .join('');
  panel.innerHTML = `<h2>STATS</h2><div class="stat-grid">${rows.map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join('')}</div><h3>Checklist</h3><div class="stat-grid stat-checklist">${checklist}</div><h3>Street run records</h3><div class="run-records">${runs}</div>`;
  pushScrolling(ctx, el, panel);
}
