// Foundations: the menu split keeps menus.ts's public exports and gives every screen its own module.

import { describe, expect, it } from 'vitest';
import * as menus from '../../src/ui/menus';

describe('menus split', () => {
  it('still exports Menus and NEW_GAME_WARNING', () => {
    expect(typeof menus.Menus).toBe('function');
    expect(menus.NEW_GAME_WARNING).toContain('Start a new game?');
  });

  it.each([
    ['title', 'showTitle'],
    ['pause', 'showPause'],
    ['settings', 'showSettings'],
    ['shop', 'showShop'],
    ['map', 'showMap'],
    ['stats', 'showStats'],
    ['streetRuns', 'showStreetRuns'],
    ['controls', 'showControls'],
  ])('screens/%s exports %s', async (file, fn) => {
    const mod = (await import(`../../src/ui/screens/${file}`)) as Record<string, unknown>;
    expect(typeof mod[fn]).toBe('function');
  });
});
