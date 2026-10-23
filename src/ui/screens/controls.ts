// Controls reference.

import { weaponKeyCount } from '../../sim/specs';
import { escapeHtml } from '../hud';
import { h, pushScrolling, type MenuCtx } from './shared';

export function showControls(ctx: MenuCtx): void {
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel');
  // Named as printed on the player's keyboard: the bindings are positions, so AZERTY moves with Z Q S D.
  const k = (code: string) => ctx.keys.label(code);
  const kb: Array<[string, string]> = [
    ['Move / Drive', ['KeyW', 'KeyA', 'KeyS', 'KeyD'].map(k).join(' ')],
    ['Look / Aim', 'Mouse'],
    ['Sprint', 'Shift'],
    ['Jump / Handbrake', 'Space'],
    ['Shoot / Punch / Throw', 'Left click'],
    ['Aim', 'Right click'],
    ['Enter / Exit vehicle', k('KeyF')],
    ['Interact / Horn', k('KeyE')],
    ['Reload / Next radio', k('KeyR')],
    ['Weapons', `1-${weaponKeyCount()}, ${k('KeyQ')}, wheel`],
    ['Side job / Street run', k('KeyT')],
    ['Camera distance', k('KeyV')],
    ['Map', k('KeyM')],
    ['Pause', `Esc / ${k('KeyP')}`],
  ];
  // As Input.poll() binds them: several buttons do one thing on foot and another in a vehicle.
  const pad: Array<[string, string]> = [
    ['Move / Steer', 'Left stick'],
    ['Look', 'Right stick'],
    ['Shoot (on foot) / Accelerate', 'RT'],
    ['Aim (on foot) / Brake', 'LT'],
    ['Jump (on foot)', 'X'],
    ['Shoot from a vehicle', 'X'],
    ['Handbrake', 'RB / A'],
    ['Sprint', 'A'],
    ['Enter / Exit', 'Y'],
    ['Reload', 'B'],
    ['Weapons (LB in a vehicle)', 'LB / RB'],
    ['Horn (in a vehicle)', 'L3'],
    ['Camera distance', 'R3'],
    ['Interact', 'D-pad up'],
    ['Radio', 'D-pad left/right'],
    ['Side job / Street run', 'D-pad down'],
    ['Map / Pause', 'Back / Start'],
  ];
  const grid = (rows: Array<[string, string]>) => `<div class="keys">${rows.map(([a, b]) => `<div><span>${a}</span><span>${escapeHtml(b)}</span></div>`).join('')}</div>`;
  panel.innerHTML = `<h2>CONTROLS</h2><h3>Keyboard &amp; mouse</h3>${grid(kb)}<h3>Gamepad</h3>${grid(pad)}
    <h3>Tips</h3><p>Steal any car with <kbd>${escapeHtml(k('KeyF'))}</kbd>, even with someone inside. Lose the cops by breaking line of sight or by driving into a Spray Shack. Hidden packages, stunt ramps and rampages are scattered across San Azura. Drive a taxi or police car and press <kbd>${escapeHtml(k('KeyT'))}</kbd> for side jobs.</p>
    <h3>Street runs</h3><p>Choose a course from the title screen, or press <kbd>${escapeHtml(k('KeyT'))}</kbd> in an ordinary road car to find the nearest run. Stop in the start gate, then follow the gold route through every checkpoint in order. Brake before the corners and use the handbrake to turn sharply. Gold, silver and bronze finishes pay cash; your best time is saved. Press <kbd>${escapeHtml(k('KeyT'))}</kbd> again to cancel.</p>`;
  pushScrolling(ctx, el, panel);
}
