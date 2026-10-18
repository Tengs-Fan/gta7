import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, state, type Api } from './helpers';

/** Serves the game page with a header that forbids the Gamepad API, as a hardened host would. */
async function forbidGamepads(page: Page): Promise<void> {
  await page.route(/\/\?intro=0(&.*)?$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'permissions-policy': 'gamepad=()' } });
  });
}

/** Presses and releases the mouse's back button (a real input event, so the browser's navigation applies). */
async function mouseBack(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 360, button: 'back', buttons: 8, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 360, button: 'back', buttons: 0, clickCount: 1 });
  await cdp.detach();
}

const focused = (page: Page) => page.evaluate(() => document.activeElement?.textContent ?? null);

test.describe('GTA 7 input fixes (round 2, pass 3)', () => {
  test('with the Gamepad API forbidden by the permissions policy the game still boots, plays and pauses', async ({ page }) => {
    await forbidGamepads(page);
    const errors = await boot(page);
    const thrown = await page.evaluate(() => {
      try {
        navigator.getGamepads();
        return '';
      } catch (e) {
        return String(e);
      }
    });
    expect(thrown).toContain('SecurityError');
    await newGame(page);
    const a = await state(page);
    await page.waitForTimeout(600);
    const b = await state(page);
    expect(b.crashed).toBe(false);
    expect(b.frames).toBeGreaterThan(a.frames + 10);
    expect(b.hours).toBeGreaterThan(a.hours);
    expect(await page.locator('[data-el="clock"]').textContent()).not.toBe('00:00');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window as Api).__gta7.state().menuOpen);
    expect(errors).toEqual([]);
  });

  test('the error screen works from the keyboard: RELOAD has the focus, Tab reaches COPY DETAILS, Enter reloads', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      (window as Api).__gta7.game.hud.update = () => {
        throw new Error('hud exploded');
      };
    });
    await page.waitForFunction(() => (window as Api).__gta7.state().crashed);
    expect(await focused(page)).toBe('RELOAD');
    await page.keyboard.press('Tab');
    expect(await focused(page)).toBe('COPY DETAILS');
    await page.keyboard.press('Shift+Tab');
    expect(await focused(page)).toBe('RELOAD');
    await page.evaluate(() => {
      (window as unknown as { beforeReload: boolean }).beforeReload = true;
    });
    await Promise.all([page.waitForEvent('load'), page.keyboard.press('Enter')]);
    await page.waitForFunction(() => (window as Api).__gta7?.state().frames > 5, null, { timeout: 90_000 });
    expect(await page.evaluate(() => (window as unknown as { beforeReload?: boolean }).beforeReload)).toBeUndefined();
    expect((await state(page)).mode).toBe('title');
    expect(errors.filter((e) => !/hud exploded|GTA7 crashed/.test(e))).toEqual([]);
  });

  test('a mouse click on the title menus starts the audio', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(() => (window as Api).__gta7.game.audio.ctx === null)).toBe(true);
    await page.getByRole('button', { name: 'SETTINGS' }).click();
    expect(await page.evaluate(() => (window as Api).__gta7.game.audio.ctx?.state ?? null)).toBe('running');
  });

  test("the mouse's back button does not leave a game, also from the pause menu; on the title it still navigates", async ({ page }) => {
    await page.goto('about:blank');
    const errors = await boot(page);
    const url = page.url();
    await newGame(page);
    await mouseBack(page);
    await page.waitForTimeout(800);
    expect(page.url()).toBe(url);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window as Api).__gta7.state().menuOpen);
    await mouseBack(page);
    await page.waitForTimeout(800);
    expect(page.url()).toBe(url);
    expect((await state(page)).mode).toBe('game');
    expect(errors).toEqual([]);
    // Back on the title nothing is at stake: the button goes back as usual.
    await page.evaluate(() => (window as Api).__gta7.game.quitToTitle());
    await mouseBack(page);
    await page.waitForURL('about:blank');
  });

  test('a cheat code whose keys all arrive between two frames opens no map', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const money = (await state(page)).money;
    await page.evaluate(() => {
      for (const ch of 'moneytree') {
        const code = `Key${ch.toUpperCase()}`;
        window.dispatchEvent(new KeyboardEvent('keydown', { code, key: ch }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code, key: ch }));
      }
    });
    await page.waitForTimeout(500);
    const s = await state(page);
    expect(s.money).toBe(money + 50000);
    expect(s.menuOpen).toBe(false);
    expect(errors).toEqual([]);
  });
});

test.describe('GTA 7 input fixes on a HiDPI screen', () => {
  test.use({ deviceScaleFactor: 2 });

  test('the radar is backed at twice its CSS size', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const c = document.querySelector('[data-el="radar"]') as HTMLCanvasElement;
      return { w: c.width, h: c.height, css: c.clientWidth, dpr: window.devicePixelRatio };
    });
    expect(r.dpr).toBe(2);
    expect(r.w).toBe(r.css * 2);
    expect(r.h).toBe(r.css * 2);
    expect(errors).toEqual([]);
  });
});
