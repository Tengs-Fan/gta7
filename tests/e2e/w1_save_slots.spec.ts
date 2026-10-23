import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { boot, fakePad, newGame, padTap, type Api } from './helpers';

const legacy = readFileSync(new URL('../unit/fixtures/legacy_v1.save.json', import.meta.url), 'utf8');

test.describe('wave 1: three save slots', () => {
  test('an old single save shows up as slot 1 and loads through CONTINUE', async ({ page }) => {
    const errors = await boot(page);
    await page.evaluate((text) => localStorage.setItem('gta7.save.v1', text), legacy);
    await page.reload();
    await page.waitForFunction(() => (window as Api).__gta7?.state().frames > 20, null, { timeout: 90_000 });
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gta7.save')).sort());
    console.log('keys after first load', keys);
    // The old key is gone once slot 1 holds the save; gta7.saves.v1 remembers the slot last used.
    expect(keys).toEqual(['gta7.save.slot1', 'gta7.saves.v1']);
    expect(await page.evaluate(() => localStorage.getItem('gta7.save.slot1'))).toBe(legacy);
    await page.click('button[data-id="continue"]');
    await expect(page.locator('button[data-id="slot2"]')).toBeDisabled();
    await expect(page.locator('button[data-id="slot1"] .slot-summary')).toContainText('Missions');
    await page.screenshot({ path: 'test-results/save3-migrated.png' });
    await page.click('button[data-id="slot1"]');
    await page.waitForFunction(() => (window as Api).__gta7.state().mode === 'game');
    expect((await page.evaluate(() => (window as Api).__gta7.state().money))).toBe(JSON.parse(legacy).money);
    expect(errors).toEqual([]);
  });

  test('on a full origin the old save still loads as slot 1; a failed save to slot 2 leaves the autosaves on slot 1', async ({ page }) => {
    const errors = await boot(page);
    // The old save, then the origin filled by other data until even a short write fails.
    const blocked = await page.evaluate((text) => {
      localStorage.clear();
      localStorage.setItem('gta7.save.v1', text);
      let n = 0;
      for (const size of [1e6, 1e5, 1e4, 1e3, 100, 10, 1]) {
        for (;;) {
          try {
            localStorage.setItem(`other.${n}`, 'x'.repeat(size));
            n++;
          } catch {
            break;
          }
        }
      }
      try {
        localStorage.setItem('probe', 'x'.repeat(50));
        return false;
      } catch {
        return true;
      }
    }, legacy);
    expect(blocked).toBe(true);
    await page.reload();
    await page.waitForFunction(() => (window as Api).__gta7?.state().frames > 20, null, { timeout: 90_000 });
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gta7.save')))).toEqual(['gta7.save.v1']);
    await expect(page.locator('button[data-id="continue"]')).toBeEnabled();
    await page.click('button[data-id="continue"]');
    await expect(page.locator('button[data-id="slot1"]')).toBeEnabled();
    await page.click('button[data-id="slot1"]');
    await page.waitForFunction(() => (window as Api).__gta7.state().mode === 'game');
    expect(await page.evaluate(() => (window as Api).__gta7.state().money)).toBe(JSON.parse(legacy).money);
    // The safehouse into empty slot 2: no room.
    await page.evaluate(() => (window as Api).__gta7.sim.events.emit('saveRequested', { poi: 'safehouse' }));
    await page.click('button[data-id="slot2"]');
    await expect(page.locator('.toast')).toHaveText('Could not save: browser storage is full');
    // Room again: the next autosave goes to slot 1, the slot the game was loaded from, and the old key goes.
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('other.')) localStorage.removeItem(k);
      const g = (window as Api).__gta7;
      g.sim.progress.addMoney(7);
      g.sim.events.emit('saveRequested', { poi: 'auto' });
    });
    await expect(page.locator('.toast')).toHaveText('Autosaved');
    const after = await page.evaluate(() => ({
      keys: Object.keys(localStorage).filter((k) => k.startsWith('gta7.save')).sort(),
      slot1: JSON.parse(localStorage.getItem('gta7.save.slot1') ?? 'null')?.money,
    }));
    expect(after).toEqual({ keys: ['gta7.save.slot1', 'gta7.saves.v1'], slot1: JSON.parse(legacy).money + 7 });
    await page.evaluate(() => localStorage.clear());
    expect(errors).toEqual([]);
  });

  test('the safehouse picker works with a gamepad: A saves into the empty slot, B closes it unsaved', async ({ page }) => {
    await fakePad(page);
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => (window as Api).__gta7.sim.events.emit('saveRequested', { poi: 'safehouse' }));
    await expect(page.locator('button[data-id="slot1"]')).toBeVisible();
    await page.waitForTimeout(350);
    await padTap(page, 1); // B: closes, nothing saved
    await expect(page.locator('button[data-id="slot1"]')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('gta7.save.slot1'))).toBeNull();
    await page.evaluate(() => (window as Api).__gta7.sim.events.emit('saveRequested', { poi: 'safehouse' }));
    await page.waitForTimeout(350);
    await padTap(page, 13); // down to slot 2
    await padTap(page, 0); // A
    await expect(page.locator('.toast')).toHaveText('Game saved');
    expect(await page.evaluate(() => [1, 2, 3].map((i) => localStorage.getItem(`gta7.save.slot${i}`) !== null))).toEqual([false, true, false]);
    // Slot 2 now holds a save: choosing it asks first, and B there goes back to the picker with the save as it was.
    const before = await page.evaluate(() => localStorage.getItem('gta7.save.slot2'));
    await page.evaluate(() => (window as Api).__gta7.sim.progress.addMoney(99));
    await page.evaluate(() => (window as Api).__gta7.sim.events.emit('saveRequested', { poi: 'safehouse' }));
    await page.waitForTimeout(350);
    await padTap(page, 13);
    await padTap(page, 0);
    await expect(page.locator('.panel p:visible')).toContainText('Overwrite slot 2');
    await page.screenshot({ path: 'test-results/save3-overwrite-confirm.png' });
    await page.waitForTimeout(350);
    await padTap(page, 1);
    await expect(page.locator('button[data-id="slot2"]')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('gta7.save.slot2'))).toBe(before);
    expect(errors).toEqual([]);
  });
});
