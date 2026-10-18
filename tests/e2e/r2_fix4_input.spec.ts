import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

/** Where the keyboard focus is: its tag, its text, and whether it is on the error screen. */
const active = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName ?? null, text: (a?.textContent ?? '').trim().slice(0, 40), inError: !!a?.closest('.error') };
  });

/** Crashes the game as the reviewer's probe did: the menus' input handler throws on the next frame. */
async function crashInMenus(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Api).__gta7.game.menus.input = () => {
      throw new Error('menus broke');
    };
  });
  await page.waitForFunction(() => (window as Api).__gta7.state().crashed);
}

/** Presses Tab (or Shift+Tab) `n` times and returns each place the focus went. */
async function tabs(page: Page, key: 'Tab' | 'Shift+Tab', n: number) {
  const seen = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(key);
    seen.push(await active(page));
  }
  return seen;
}

/** Nothing but the error screen's own controls, or the page itself (the stop between the last control and the first). */
const onErrorScreen = (a: { tag: string | null; inError: boolean }) => a.inError || a.tag === 'BODY';

test.describe('GTA 7 input fixes (round 2, pass 4)', () => {
  test('a crash on the pause menu: Shift+Tab and Tab never reach the menu under the error screen, and Enter there runs nothing', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window as Api).__gta7.state().menuOpen);
    await page.waitForTimeout(400);
    await crashInMenus(page);
    expect(await active(page)).toEqual({ tag: 'BUTTON', text: 'RELOAD', inError: true });
    // One Shift+Tab from RELOAD used to land on the pause menu's hidden QUIT TO TITLE, and Enter opened its dialog.
    const [back] = await tabs(page, 'Shift+Tab', 1);
    expect(onErrorScreen(back!), JSON.stringify(back)).toBe(true);
    const before = await page.evaluate(() => ({ top: (window as Api).__gta7.game.menus.top?.el.textContent ?? null, paused: (window as Api).__gta7.game.audio.paused }));
    // Enter there (unless round on RELOAD, which would reload): no menu action runs in the dead game.
    if (back!.text !== 'RELOAD') {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => ({ top: (window as Api).__gta7.game.menus.top?.el.textContent ?? null, paused: (window as Api).__gta7.game.audio.paused }));
      expect(after).toEqual(before);
      expect((await state(page)).mode).toBe('game');
    }
    // Round and round, both ways: only the error screen's buttons and the page.
    for (const a of [...(await tabs(page, 'Tab', 7)), ...(await tabs(page, 'Shift+Tab', 7))]) expect(onErrorScreen(a), JSON.stringify(a)).toBe(true);
    expect(errors.filter((e) => !/menus broke|GTA7 crashed/.test(e))).toEqual([]);
  });

  test('a crash on the title: NEW GAME under the error screen cannot be reached with Tab', async ({ page }) => {
    const errors = await boot(page);
    await crashInMenus(page);
    expect(await active(page)).toEqual({ tag: 'BUTTON', text: 'RELOAD', inError: true });
    for (const a of [...(await tabs(page, 'Tab', 7)), ...(await tabs(page, 'Shift+Tab', 7))]) expect(onErrorScreen(a), JSON.stringify(a)).toBe(true);
    expect((await state(page)).mode).toBe('title');
    expect(errors.filter((e) => !/menus broke|GTA7 crashed/.test(e))).toEqual([]);
  });
});
