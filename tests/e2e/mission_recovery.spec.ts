import { expect, test } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

test.describe('mission recovery presentation', () => {
  test('a paused retry keeps its fade and hides the move when play resumes', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.sim.missions.start('wheels', { retrying: true });
    });
    await page.waitForFunction(() => (window as Api).__gta7.state().objective === 'Steal a car');
    await page.evaluate(() => (window as Api).__gta7.sim.missions.active.fail('The deal fell through.'));
    await expect(page.locator('.prompt')).toContainText('retry "Wheels"');
    await expect(page.locator('.navigation')).toBeHidden();
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      (window as Api).__retryCover = [];
      g.sim.events.on('missionStarted', () => (window as Api).__retryCover.push(Number(getComputedStyle(document.querySelector('.fade')!).opacity)));
    });
    await page.keyboard.press('KeyE');
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.fade')!).opacity) > 0.15);
    await page.keyboard.press('KeyP');
    await expect(page.getByRole('heading', { name: 'PAUSED', exact: true })).toBeVisible();
    const paused = await page.evaluate(() => ({ time: (window as Api).__gta7.sim.time, opacity: getComputedStyle(document.querySelector('.fade')!).opacity }));
    await page.waitForTimeout(1700);
    const held = await page.evaluate(() => ({ time: (window as Api).__gta7.sim.time, opacity: getComputedStyle(document.querySelector('.fade')!).opacity }));
    expect(held).toEqual(paused);
    expect(Number(held.opacity)).toBeGreaterThan(0);
    await page.keyboard.press('KeyP');
    await page.waitForFunction(() => (window as Api).__gta7.state().mission === 'wheels');
    expect(await page.evaluate(() => (window as Api).__retryCover)).toEqual([1]);
    await expect(page.locator('.fade')).toHaveCSS('opacity', '0');
    expect(errors).toEqual([]);
  });

  test('a retained checkpoint stays discoverable after the quick prompt expires and can be retried from Pause', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.sim.missions.noBust = true;
      g.markDone('wheels', 'delivery', 'repo', 'loose_lips', 'heatwave');
      // Start from the real post-vault script branch, then fail that retained checkpoint.
      g.sim.missions.start('big_score', { retrying: true, resume: 1 });
    });
    await page.waitForFunction(() => (window as Api).__gta7.state().objective === 'Get in the getaway car');
    await page.evaluate(() => (window as Api).__gta7.sim.missions.active.fail('The getaway went wrong.'));
    await page.waitForFunction(() => (window as Api).__gta7.state().mission === null);
    await page.evaluate(() => (window as Api).__gta7.sim.wanted.clear());
    await page.waitForFunction(() => (window as Api).__gta7.sim.missions.retryOffer() !== null);
    await page.waitForFunction(() => (window as Api).__gta7.sim.missions.retryOffer() === null, null, { timeout: 35_000 });
    await expect(page.locator('.objective')).toHaveText('Retry "The Big Score" from the pause menu');
    await expect(page.locator('.objective')).toHaveClass(/show/);
    await expect(page.locator('.navigation')).toBeHidden();
    await expect(page.locator('.prompt')).toBeHidden();
    await page.keyboard.press('KeyP');
    const retry = page.locator('[data-id="retry-mission"]');
    await expect(retry).toHaveText('RETRY FROM CHECKPOINT');
    await expect(retry).toBeEnabled();
    await expect(retry).toHaveAttribute('data-description', /The Big Score/);
    await page.screenshot({ path: test.info().outputPath('retained-checkpoint.png') });
    await retry.click();
    await page.waitForFunction(() => (window as Api).__gta7.state().objective === 'Get in the getaway car');
    const state = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      return { menu: g.game.menus.open, checkpoint: g.sim.missions.active.checkpointReached, retrying: g.sim.missions.active.retrying, crashed: g.state().crashed };
    });
    expect(state).toEqual({ menu: false, checkpoint: 1, retrying: true, crashed: false });
    expect(errors).toEqual([]);
  });
});
