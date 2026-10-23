// Title screen and credits.

import { escapeHtml } from '../hud';
import { ButtonList, h, pushScrolling, showConfirm, type MenuCtx } from './shared';
import { showControls } from './controls';
import { showSettings } from './settings';
import { showStreetRuns } from './streetRuns';

/** NEW GAME's question when there is a save: the new game's first save replaces it. */
export const NEW_GAME_WARNING = 'Start a new game? Your saved game will be replaced the next time the game saves (after a mission or at the safehouse).';

/** Title menu; `notice` is an optional one-line message under the buttons. */
export function showTitle(ctx: MenuCtx, notice?: string): void {
  ctx.closeAll();
  const el = h('div', 'screen title-screen');
  el.appendChild(h('div', 'title-shade'));
  const wrap = h('div', 'title-wrap');
  wrap.appendChild(h('div', 'title-eyebrow', '<span class="title-mark"></span> SAN AZURA / AN OPEN WORLD CRIME SANDBOX'));
  const intro = h('div', 'title-intro');
  intro.appendChild(h('div', 'logo', '<span class="gta">GTA</span><span class="seven">7</span><span class="sub">GRAND TURBO ANARCHY</span>'));
  intro.appendChild(h('p', 'title-copy', 'A city of opportunity.<br>A spectacular way to get in trouble.'));
  wrap.appendChild(intro);
  const list = new ButtonList(
    [
      { label: 'CONTINUE', action: () => ctx.host.continueGame(), disabled: !ctx.host.hasSave(), id: 'continue', description: 'Pick up where you left off' },
      // There is one save slot, and the new game's first save (a passed mission, the safehouse) overwrites it.
      {
        label: 'NEW GAME',
        action: () => (ctx.host.hasSave() ? showConfirm(ctx, NEW_GAME_WARNING, () => ctx.host.newGame()) : ctx.host.newGame()),
        id: 'new',
        description: 'Meet the city. Make a name for yourself.',
      },
      ...(ctx.host.startStreetRun ? [{
        label: 'STREET RUN', id: 'street-run', description: 'Get behind the wheel. Beat the clock.',
        action: () => showStreetRuns(ctx),
      }] : []),
      { label: 'CONTROLS', action: () => showControls(ctx) },
      { label: 'SETTINGS', action: () => showSettings(ctx) },
      { label: 'CREDITS', action: () => showCredits(ctx) },
    ],
    () => ctx.host.click(),
  );
  list.el.classList.add('title-menu');
  if (notice) list.el.appendChild(h('div', 'title-note', escapeHtml(notice)));
  wrap.appendChild(list.el);
  wrap.appendChild(h('div', 'title-input-note', 'KEYBOARD + MOUSE / GAMEPAD'));
  wrap.appendChild(h('div', 'title-foot', 'An original parody sandbox. All names are fictional. Not affiliated with Rockstar Games or Take-Two Interactive.'));
  el.appendChild(wrap);
  el.appendChild(h('div', 'title-world-caption', '<span>WELCOME TO</span><strong>SAN<br>AZURA.</strong><small>GOOD WEATHER. BAD DECISIONS.</small>'));
  ctx.push({
    el,
    input: (ui) => list.input(ui),
    // The save may have been deleted from SETTINGS meanwhile.
    refresh: () => list.setDisabled('continue', !ctx.host.hasSave()),
  });
}

export function showCredits(ctx: MenuCtx): void {
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel credits-roll');
  panel.innerHTML = `<h2>CREDITS</h2>
    <p><b>GTA 7: Grand Turbo Anarchy</b><br>An original open-world sandbox built for the browser.</p>
    <p>Everything you see and hear is generated at runtime: the city, the cars, the people, the textures, the sound effects and the three radio stations.</p>
    <p>Built with three.js, TypeScript and Vite. Fonts: Anton &amp; Rajdhani (SIL Open Font License).</p>
    <p>All characters, places, vehicles and brands are fictional. Any resemblance to real persons or businesses is coincidental. This is a fan-made parody and is not affiliated with Rockstar Games or Take-Two Interactive.</p>`;
  pushScrolling(ctx, el, panel);
}
