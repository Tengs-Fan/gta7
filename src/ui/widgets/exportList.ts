// While the export job runs: Lou's list at the side of the screen, ticked as the cars are shipped.

import { EXPORT_LIST, exportDone, exportLabel } from '../../sim/activities/carExport';
import { playerOf, type ViewState } from '../../sim/viewState';
import { escapeHtml } from '../hud';
import './exportList.css';

export class ExportListWidget {
  readonly el: HTMLDivElement;
  private shown = '';

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'export-widget hidden';
    parent.appendChild(this.el);
  }

  /** Call once per frame of play; `visible` is false while the HUD is hidden. */
  update(sim: ViewState | null, localPlayerId: number, visible = true): void {
    const me = sim ? playerOf(sim, localPlayerId) : null;
    const on = visible && !!sim && sim.activities.job?.kind === 'carExport' && !!me && !me.down;
    let html = '';
    if (on && me) {
      const done = exportDone(me.progress);
      html = `<b>EXPORT LIST ${done.size}/${EXPORT_LIST.length}</b>${EXPORT_LIST.map((e) => `<div class="${done.has(e.id) ? 'done' : ''}">${escapeHtml(exportLabel(e))}</div>`).join('')}`;
    }
    if (html === this.shown) return;
    this.shown = html;
    this.el.innerHTML = html;
    this.el.classList.toggle('hidden', !html);
  }
}
