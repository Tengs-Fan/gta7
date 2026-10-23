// Pause menu.

import { escapeHtml } from '../hud';
import { ButtonList, h, localPlayer, showConfirm, type MenuCtx } from './shared';
import { showControls } from './controls';
import { showMap } from './map';
import { showSettings } from './settings';
import { showStats } from './stats';

export function showPause(ctx: MenuCtx): void {
  const sim = ctx.host.sim();
  const m = sim?.missions.active ?? null;
  const retry = ctx.host.retryMission ? sim?.missions.retryMenuOffer() : null;
  const here = localPlayer(ctx.host)?.pos() ?? { x: 0, y: 0, z: 0 };
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel pause-panel');
  panel.style.width = 'min(520px, 92vw)';
  panel.appendChild(h('div', 'panel-eyebrow', 'SAN AZURA / TAKE A BREATHER'));
  panel.appendChild(h('h2', '', 'PAUSED'));
  const items: Array<{ label: string; action: () => void; id?: string; description?: string; disabled?: boolean }> = [
    { label: 'RESUME', action: () => ctx.host.resume() },
    { label: 'MAP', action: () => showMap(ctx) },
    { label: 'STATS', action: () => showStats(ctx) },
    { label: 'CONTROLS', action: () => showControls(ctx) },
    { label: 'SETTINGS', action: () => showSettings(ctx) },
  ];
  // An abandoned mission offers no retry: it starts over from its contact. Once its goal is met (MissionCtx.won) it
  // is passed whatever happens during the closing lines, an abandon included, so there is nothing to abandon. The
  // sim stands still while this menu is open, so that cannot change under it.
  if (m && !m.won) items.push({ label: 'ABANDON MISSION', action: () => showConfirm(ctx, 'Abandon the mission? You will have to start it again from the beginning.', () => ctx.host.abandonMission()) });
  if (retry) items.push({
    label: retry.checkpoint > 0 ? 'RETRY FROM CHECKPOINT' : 'RETRY MISSION',
    id: 'retry-mission',
    description: `${retry.title} · ${retry.blocked ?? (retry.checkpoint > 0 ? 'Resume from your last checkpoint.' : 'Start this attempt again.')}`,
    disabled: !!retry.blocked,
    action: () => ctx.host.retryMission?.(),
  });
  const quitWarning = retry ? 'Quit to the title screen? This mission retry and its checkpoint will be lost. Completed missions remain saved.' : 'Quit to the title screen? Unsaved progress will be lost.';
  items.push({ label: 'QUIT TO TITLE', action: () => showConfirm(ctx, quitWarning, () => ctx.host.quitToTitle()) });
  const list = new ButtonList(items, () => ctx.host.click());
  panel.appendChild(list.el);
  if (sim) {
    // Past the goal the objective line is stale (or empty, then the blurb would read as still to do).
    const doing = m ? (m.won ? 'complete' : escapeHtml(m.objectiveText || m.def.blurb)) : '';
    const job = sim.activities.job;
    const activity = job?.kind === 'streetRun' ? `<b>${escapeHtml(job.course.name)}</b><br>${escapeHtml(sim.activities.status() ?? '')}` : escapeHtml(sim.activities.status() ?? '');
    panel.appendChild(h('p', 'pause-context', m ? `Mission: <b>${escapeHtml(m.def.title)}</b> — ${doing}` : activity || `Zone: <b>${escapeHtml(sim.world.zoneName(here.x, here.z))}</b> · ${sim.clock.label()} · Day ${sim.clock.day}`));
  }
  el.appendChild(panel);
  ctx.push({ el, input: (ui) => (ui.back || ui.pause ? ctx.host.resume() : list.input(ui)) });
}
