import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

const CHAPTER1 = ['wheels', 'delivery', 'repo', 'loose_lips', 'heatwave', 'big_score'];
const CHAPTER2: Array<{ id: string; title: string; first: string }> = [
  { id: 'shadow_play', title: 'Shadow Play', first: 'Tail the courier: take the Pipsqueak first' },
  { id: 'room_service', title: 'Room Service', first: 'Defend the hotel entrance (wave 1/3)' },
  { id: 'showroom', title: 'Showroom Condition', first: 'Steal the yellow Nightjar GT' },
  { id: 'off_the_road', title: 'Off the Road', first: 'Get in the Dustrunner' },
  { id: 'rush_hour', title: 'Rush Hour', first: 'Get in the Thunderhoof' },
  { id: 'last_call', title: 'Last Call', first: 'Steal the evidence box from the SAPD impound lot' },
];

/** Walks the player into Vera's marker with W (the camera turned towards it), then presses E. */
async function walkInAndStart(page: Page, id: string): Promise<void> {
  await page.evaluate(() => {
    const g = (window as Api).__gta7;
    const vera = g.poi('vera');
    // Five metres up the sidewalk, facing the marker.
    g.place(vera.x, vera.z - 5, 0);
    g.game.renderer.cameraCtl.sensitivity = 0;
    g.setCamera(0, -0.12);
  });
  await page.waitForTimeout(300);
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => {
    const g = (window as Api).__gta7;
    const v = g.poi('vera');
    const p = g.sim.player.pos;
    return Math.hypot(p.x - v.x, p.z - v.z) < 1.2;
  }, null, { timeout: 8000, polling: 16 });
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(400);
  await expect(page.locator('.prompt')).toContainText('Vera Salgado');
  await page.keyboard.press('KeyE');
  await page.waitForFunction((mid) => (window as Api).__gta7.state().mission === mid, id, { timeout: 5000 });
}

test.describe('chapter 2: Vera Salgado', () => {
  for (const [n, mission] of CHAPTER2.entries()) {
    test(`${n + 1}. ${mission.title} starts from Vera's marker and shows its first objective`, async ({ page }) => {
      const errors = await boot(page);
      await newGame(page);
      await page.evaluate((done) => {
        const g = (window as Api).__gta7;
        g.godMode(true);
        g.markDone(...done);
      }, [...CHAPTER1, ...CHAPTER2.slice(0, n).map((m) => m.id)]);
      // Only this mission is offered by Vera, and nothing by Lou or Dex.
      const offers = await page.evaluate(() => (window as Api).__gta7.sim.missions.offers().map((d: Api) => d.id));
      expect(offers).toEqual([mission.id]);
      await walkInAndStart(page, mission.id);
      await expect(page.locator('.big')).toContainText(mission.title.toUpperCase(), { timeout: 3000 });
      await expect(page.locator('.big')).toContainText('Vera Salgado');
      await expect(page.locator('.subtitle')).toContainText('Vera Salgado', { timeout: 5000 });
      await page.waitForFunction((text) => (window as Api).__gta7.state().objective === text, mission.first, { timeout: 30_000 });
      await expect(page.locator('.objective')).toContainText(mission.first);
      await page.screenshot({ path: `test-results/story2-start-${n + 1}.png` });
      expect(errors).toEqual([]);
    });
  }

  test("Lou's and Dex's markers start nothing once chapter 1 is done", async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate((done) => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.markDone(...done);
    }, CHAPTER1);
    for (const poi of ['lou', 'dex']) {
      await page.evaluate((id) => {
        const g = (window as Api).__gta7;
        const p = g.poi(id);
        g.place(p.x, p.z);
      }, poi);
      await page.waitForTimeout(400);
      await page.keyboard.press('KeyE');
      await page.waitForTimeout(600);
      expect((await state(page)).mission, poi).toBeNull();
    }
    expect(errors).toEqual([]);
  });
});
