import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// The crowded top-right corner: armour, a taxi job line, three stars with DISPATCH and the evade bar, three toasts and
// a title card at once. Nothing may overlap or leave the window, at the common sizes down to a small 800x500 window.

type Box = { name: string; x: number; y: number; w: number; h: number };

async function boxes(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const out: Array<{ name: string; x: number; y: number; w: number; h: number }> = [];
    const add = (name: string, e: Element | null) => {
      if (!e) return;
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      if (r.width === 0 || r.height === 0 || s.display === 'none' || s.visibility === 'hidden') return;
      out.push({ name, x: r.left, y: r.top, w: r.width, h: r.height });
    };
    add('cluster', document.querySelector('.hud-tr'));
    document.querySelectorAll('.toasts > .show').forEach((e, i) => add(`toast${i}`, e));
    add('title', document.querySelector('.big .t'));
    add('titleSub', document.querySelector('.big .s'));
    add('radar', document.querySelector('.radar'));
    const drive = document.querySelector('.drive-panel');
    if (drive && !drive.classList.contains('hidden')) add('drive', drive);
    const zone = document.querySelector('.zone');
    if (zone && zone.classList.contains('show')) add('zone', zone);
    return out;
  });
}

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

for (const [w, h] of [
  [1280, 720],
  [1024, 768],
  [800, 500],
] as const) {
  test(`crowded top-right corner at ${w}x${h}: cluster, three toasts and the title card do not overlap`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.sim.missions.noBust = true;
      g.sim.player.armor = 100;
      g.spawnVehicle('taxi', true);
    });
    await expect(page.locator('.prompt')).toContainText('taxi job', { timeout: 5000 });
    await page.keyboard.press('KeyT');
    await expect(page.locator('.big')).toContainText('TAXI DRIVER', { timeout: 3000 });
    await page.evaluate(() => (window as Api).__gta7.setWanted(3));
    await expect(page.locator('.scanner.show')).toContainText('DISPATCH', { timeout: 5000 });
    // Out of the search area (as in r2_police.spec.ts): the stars flash and the evade bar fills, with DISPATCH still up.
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.sim.wanted.responseUntil = 0;
      g.sim.police.dismissAll();
      const p = g.sim.playerPos();
      const n = g.sim.roads.nearestNode(p.x + 300, p.z);
      g.teleport(n.x + 9, n.z + 9);
      g.sim.ambient = false;
    });
    await expect(page.locator('.evade')).toBeVisible({ timeout: 6000 });
    await expect(page.locator('.scanner.show')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('.hud-tr .status')).toBeVisible();
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const hud = g.game.hud;
      hud.toast('Waypoint reached');
      hud.toast('Autosaved');
      hud.toast('Weather: rain');
      // Keep the card up long enough to measure it beside the full column.
      hud.showBig({ text: 'TAXI DRIVER', sub: 'Pick up fares and drive them where they want to go', style: 'info', duration: 8 });
    });
    await page.waitForTimeout(500);
    const all = await boxes(page);
    const names = all.map((b) => b.name);
    expect(names).toContain('cluster');
    expect(names).toContain('title');
    // In a short window the oldest toasts may go early rather than run into the vehicle panel; the newest stays.
    expect(names).toContain('toast0');
    if (h >= 720) expect(names.filter((n) => n.startsWith('toast'))).toHaveLength(3);
    for (const b of all) {
      expect(b.x, `${b.name} inside the window`).toBeGreaterThanOrEqual(0);
      expect(b.y, `${b.name} inside the window`).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w, `${b.name} inside the window`).toBeLessThanOrEqual(w + 0.5);
      expect(b.y + b.h, `${b.name} inside the window`).toBeLessThanOrEqual(h + 0.5);
    }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!;
        const b = all[j]!;
        if ((a.name === 'title' && b.name === 'titleSub') || (a.name === 'titleSub' && b.name === 'title')) continue;
        expect(overlap(a, b), `${a.name} overlaps ${b.name}: ${JSON.stringify([a, b])}`).toBe(false);
      }
    }
    // The toasts sit under the cluster, newest at the bottom.
    const cluster = all.find((b) => b.name === 'cluster')!;
    const toasts = all.filter((b) => b.name.startsWith('toast'));
    for (const t of toasts) expect(t.y).toBeGreaterThanOrEqual(cluster.y + cluster.h);
    await expect(page.locator('.toast')).toHaveText('Weather: rain');
    await page.screenshot({ path: test.info().outputPath(`hud-layout-${w}x${h}.png`) });
    // After their time they are all gone.
    await expect(page.locator('.toasts > .show')).toHaveCount(0, { timeout: 5000 });
    expect(errors).toEqual([]);
  });
}
