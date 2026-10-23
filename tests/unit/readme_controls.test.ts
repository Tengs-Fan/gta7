// The README's Controls section against the real bindings: every rebindable action's default key is on its row of the
// Controls table, the weapon slot list follows WEAPON_ORDER and the spec slots, and the number-key ranges for weapons
// and map legend categories match the code.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTIONS, type ActionId } from '../../src/input/bindings';
import { WEAPON_ORDER, WEAPONS, weaponKeyCount } from '../../src/sim/specs';
import { MAP_CATEGORIES } from '../../src/ui/mapRender';

const README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const controls = README.slice(README.indexOf('## Controls'), README.indexOf("## What's in the game"));

/** The Controls table as [action, keyboard, gamepad] cells. */
const rows = controls
  .split('\n')
  .filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| Action'))
  .map((l) => l.slice(2, -2).split(' | ').map((c) => c.trim()));

/** Each action's row in the table, by the start of its action cell. */
const ROW_OF: Record<ActionId, string> = {
  forward: 'Move / steer',
  back: 'Move / steer',
  left: 'Move / steer',
  right: 'Move / steer',
  sprint: 'Sprint',
  jump: 'Jump',
  enterExit: 'Enter / exit vehicle',
  interact: 'Interact',
  horn: 'Horn',
  reload: 'Reload',
  prevWeapon: 'Choose a weapon',
  job: 'Start / cancel',
  phone: 'Phone',
  map: 'Map',
  camera: 'Camera distance',
  pause: 'Pause',
};

/** A key code as the README names it (US QWERTY). */
const keyName = (code: string) => code.replace(/^Key/, '').replace(/^Shift(Left|Right)$/, 'Shift');

describe('README controls', () => {
  it('lists every rebindable action with its default key', () => {
    expect(rows.length).toBeGreaterThan(15);
    for (const a of ACTIONS) {
      const row = rows.find((r) => r[0]!.startsWith(ROW_OF[a.id]));
      expect(row, a.id).toBeDefined();
      const keys = row![1]!.split(/[\s,/()]+/);
      expect(keys, `${a.id}: ${row![1]}`).toContain(keyName(a.key));
    }
  });

  it('names the weapons on each number key in WEAPON_ORDER order, sharing a key by spec slot', () => {
    const n = weaponKeyCount();
    const want = Array.from({ length: n }, (_, i) => {
      const base = WEAPON_ORDER[i]!;
      const group = WEAPON_ORDER.filter((id) => id === base || WEAPONS[id].slot === WEAPONS[base].slot);
      return `${i + 1} ${group.map((id) => WEAPONS[id].name).join(' / ')}`;
    }).join(', ');
    expect(controls).toContain(`Weapon slots: ${want};`);
    expect(rows.find((r) => r[0]!.startsWith('Choose a weapon'))![1]).toContain(`1–${n}`);
  });

  it('gives the map legend the number keys of its categories', () => {
    expect(controls).toContain(`the number keys 1–${MAP_CATEGORIES.length} `);
  });
});
