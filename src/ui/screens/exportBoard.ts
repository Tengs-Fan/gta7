// Lou's export board: the eight wanted cars, which are shipped, and what each pays.

import { formatMoney } from '../../core/math';
import { EXPORT_LIST, EXPORT_LIST_BONUS, exportDone, exportLabel } from '../../sim/activities/carExport';
import { padGlyph } from '../glyphs';
import { escapeHtml } from '../hud';
import { registerScreen } from './registry';
import { h, localPlayer, type MenuCtx } from './shared';
import './exportBoard.css';

function colorChip(color: number | undefined): string {
  return color === undefined ? '<i class="export-chip any"></i>' : `<i class="export-chip" style="background:#${color.toString(16).padStart(6, '0')}"></i>`;
}

export function showExportBoard(ctx: MenuCtx, onClose: () => void): boolean {
  const sim = ctx.host.sim();
  const me = localPlayer(ctx.host);
  if (!sim || !me) return false;
  const done = exportDone(me.progress);
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel export-board');
  panel.style.width = 'min(640px, 92vw)';
  const open = EXPORT_LIST.length - done.size;
  const running = sim.activities.job?.kind === 'carExport';
  panel.appendChild(h('h2', '', "LOU'S EXPORT LIST"));
  panel.appendChild(
    h('p', 'export-intro', running
      ? `Bring these to the crane on the docks (the orange marker). ${open} still wanted; the full list pays a ${escapeHtml(formatMoney(EXPORT_LIST_BONUS))} bonus.`
      : 'The list is up on the board. Take it with no job or mission running to start shipping cars.'),
  );
  const list = h('div', 'shop-list');
  for (const e of EXPORT_LIST) {
    const shipped = done.has(e.id);
    const row = h('div', `shop-item export-row${shipped ? ' shipped' : ''}`);
    row.dataset.id = e.id;
    row.innerHTML = `<span>${colorChip(e.color)}${escapeHtml(exportLabel(e))}</span><span class="own">${shipped ? 'SHIPPED' : 'WANTED'}</span><span class="price">${escapeHtml(formatMoney(e.reward))}</span>`;
    list.appendChild(row);
  }
  panel.appendChild(list);
  const row = h('div', 'row-end');
  const how = h('div', 'shop-how', ctx.device === 'pad' ? `${padGlyph('b')} to close` : '<kbd>Esc</kbd> or <kbd>Enter</kbd> to close');
  const back = h('button', 'btn primary', 'CLOSE');
  back.addEventListener('click', () => ctx.pop());
  row.append(how, back);
  panel.appendChild(row);
  el.appendChild(panel);
  ctx.push({ el, input: (ui) => (ui.back || ui.confirm ? ctx.pop() : undefined), close: onClose });
  return true;
}

registerScreen('exportBoard', showExportBoard);
