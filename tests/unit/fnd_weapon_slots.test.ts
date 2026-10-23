// Weapon slot keys come from WEAPON_ORDER: key N selects WEAPON_ORDER[N - 1], and keys past the last weapon select nothing.
// Wave 1 (w1-weapons) filled keys 7-9 (bat or knife, grenade or molotov, sniper rifle); the fixture cases below run on
// the six baseline weapons so they still check that a seventh weapon gets Digit7 without an input.ts edit.
// Input is driven headless, with key events dispatched on a stand-in window.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../../src/input/input';
import { WEAPON_ORDER, WEAPONS, type WeaponId, type WeaponSpec } from '../../src/sim/specs';
import { input as playerInput, makeSim, step } from './helpers';

const FIXTURE = 'fixture_gun' as WeaponId;

let win: EventTarget;
let canvas: EventTarget;
let inp: Input;

beforeEach(() => {
  win = new EventTarget();
  canvas = new EventTarget();
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null }));
  vi.stubGlobal('navigator', { getGamepads: () => [] });
  vi.stubGlobal('location', { search: '' });
  inp = new Input(canvas as unknown as HTMLCanvasElement);
  inp.attach();
});

const FULL_ORDER = [...WEAPON_ORDER];
const BASELINE: WeaponId[] = ['fists', 'pistol', 'smg', 'shotgun', 'rifle', 'rocket'];

afterEach(() => {
  vi.unstubAllGlobals();
  WEAPON_ORDER.splice(0, WEAPON_ORDER.length, ...FULL_ORDER);
  delete (WEAPONS as unknown as Record<string, WeaponSpec>)[FIXTURE];
});

/** Presses and releases a number-row key, and polls one frame. */
function tap(n: number): number {
  const code = `Digit${n}`;
  win.dispatchEvent(Object.assign(new Event('keydown'), { code, key: String(n), repeat: false }));
  const fi = inp.poll(1 / 60);
  inp.endFrame();
  win.dispatchEvent(Object.assign(new Event('keyup'), { code, key: String(n) }));
  return fi.player.selectSlot;
}

describe('weapon slot keys', () => {
  it('select the weapons of WEAPON_ORDER in order, the first six as at the baseline', () => {
    expect([...WEAPON_ORDER]).toEqual([...BASELINE, 'bat', 'grenade', 'sniper', 'knife', 'molotov']);
    for (let n = 1; n <= 9; n++) {
      const slot = tap(n);
      expect(slot).toBe(n - 1);
      expect(WEAPON_ORDER[slot]).toBe([...BASELINE, 'bat', 'grenade', 'sniper'][n - 1]);
    }
  });

  it('keys 7 to 9 select nothing with six weapons', () => {
    WEAPON_ORDER.splice(0, WEAPON_ORDER.length, ...BASELINE);
    for (const n of [7, 8, 9]) expect(tap(n)).toBe(-1);
  });

  it('key 0 and a frame with no key select nothing', () => {
    expect(tap(0)).toBe(-1);
    expect(inp.poll(1 / 60).player.selectSlot).toBe(-1);
  });

  it('a seventh weapon in WEAPON_ORDER gets Digit7 and is drawn by the player, without an input.ts edit', () => {
    (WEAPONS as unknown as Record<string, WeaponSpec>)[FIXTURE] = { ...WEAPONS.rifle, id: FIXTURE, name: 'Fixture Gun', slot: 6 };
    WEAPON_ORDER.splice(0, WEAPON_ORDER.length, ...BASELINE, FIXTURE);
    expect(tap(7)).toBe(6);
    expect(tap(8)).toBe(-1);

    const sim = makeSim();
    const inv = sim.player.inventory;
    inv.give(FIXTURE, 60);
    expect(inv.current).toBe('fists');
    step(sim, 0.1, playerInput({ selectSlot: 6 }));
    expect(inv.current).toBe(FIXTURE);
    step(sim, 0.1, playerInput({ selectSlot: 0 }));
    expect(inv.current).toBe('fists');
  });

  it('after the fixture is removed, Digit7 selects nothing again with six weapons', () => {
    WEAPON_ORDER.splice(0, WEAPON_ORDER.length, ...BASELINE);
    expect(tap(7)).toBe(-1);
  });
});
