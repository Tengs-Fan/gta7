// Street Run course picker.

import { formatMoney } from '../../core/math';
import { formatRunTime, type StreetRunMedal } from '../../sim/streetRuns';
import { ButtonList, h, type MenuCtx } from './shared';

const MEDAL_ORDER: readonly StreetRunMedal[] = ['gold', 'silver', 'bronze'];

/** A real course selection, including the player's saved bests, before entering a car. */
export function showStreetRuns(ctx: MenuCtx): void {
  const courses = ctx.host.streetRunCourses?.() ?? [];
  if (!courses.length) {
    ctx.host.startStreetRun?.();
    return;
  }
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel runs-panel');
  panel.appendChild(h('div', 'panel-eyebrow', 'SAN AZURA / STREET SERIES'));
  panel.appendChild(h('h2', '', 'PICK YOUR RUN.'));
  panel.appendChild(h('p', 'runs-intro', 'A fast car. A clear route. Your time to beat.<br>Cross every gate in order and bring it home for gold.'));
  const list = new ButtonList([
    ...courses.map((c) => {
      const meta = [
        c.distance !== undefined ? `${(c.distance / 1000).toFixed(1)} KM` : '',
        c.best !== undefined ? `BEST ${formatRunTime(c.best)}` : 'NO TIME SET',
        c.reward !== undefined ? `UP TO ${formatMoney(c.reward)}` : '',
      ].filter(Boolean).join('  /  ');
      const medals = c.medals;
      const detail = medals ? h('span', 'course-medals') : undefined;
      if (medals && detail) {
        for (const m of MEDAL_ORDER) {
          if (m !== MEDAL_ORDER[0]) detail.appendChild(h('span', 'course-medal-sep', ' · '));
          const time = h('span', `course-medal ${m}`, `<b>${m.toUpperCase()}</b> ${formatRunTime(medals[m])}`);
          time.dataset.medal = m;
          detail.appendChild(time);
        }
      }
      return {
        label: c.title.toUpperCase(), description: `${c.description}\n${meta}`, detail,
        action: () => ctx.host.startStreetRun?.(c.id), id: `course-${c.id}`,
      };
    }),
    { label: 'BACK', action: () => ctx.pop(), id: 'courses-back' },
  ], () => ctx.host.click());
  list.el.classList.add('course-menu');
  panel.appendChild(list.el);
  el.appendChild(panel);
  ctx.push({ el, input: (ui) => ui.back ? ctx.pop() : list.input(ui) });
}
