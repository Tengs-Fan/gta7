import type { Page } from '@playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Api = any;

/** Console noise caused by the test harness itself, not the game. */
const IGNORED = [/GPU stall due to ReadPixels/i, /requestPointerLock/i, /pointer lock/i];

export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !IGNORED.some((r) => r.test(m.text()))) errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return errors;
}

/**
 * Headless Chromium that grants pointer lock can stop delivering frames and grow without bound, so the tests
 * refuse it (the game also refuses it under automation): clicks then shoot unlocked. intro=0 keeps a new game
 * from starting the first mission by itself.
 */
export async function boot(page: Page, path = '/?intro=0'): Promise<string[]> {
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = function () {
      throw new DOMException('pointer lock disabled under automation', 'NotSupportedError');
    };
  });
  await page.goto(path);
  await page.waitForFunction(() => (window as Api).__gta7?.state().frames > 20, null, { timeout: 90_000 });
  return errors;
}

/** Clicks NEW GAME, and YES when there is a save and the game asks before replacing it (the dialog opens on NO). */
export async function newGame(page: Page): Promise<void> {
  await page.click('button[data-id="new"]');
  await page.waitForFunction(() => (window as Api).__gta7.state().mode === 'game' || document.querySelector('button[data-id="yes"]') !== null);
  if ((await state(page)).mode !== 'game') await page.click('button[data-id="yes"]');
  await page.waitForFunction(() => (window as Api).__gta7.state().mode === 'game');
  await page.waitForTimeout(400);
}

export const state = (page: Page) => page.evaluate(() => (window as Api).__gta7.state());

/** Installs a connected standard-mapping gamepad (window.__pad) that the test presses; call before boot(). */
export async function fakePad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const pad = {
      id: 'Test Pad (STANDARD GAMEPAD)',
      index: 0,
      connected: true,
      mapping: 'standard',
      timestamp: 0,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    (window as Api).__pad = pad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
  });
}

/** One press of fake-pad button `i` (standard mapping: 0 A, 1 B, 4 LB, 5 RB, 8 Back, 9 Start, 12-15 D-pad up / down / left / right). */
export async function padTap(page: Page, i: number): Promise<void> {
  await page.evaluate((k) => ((window as Api).__pad.buttons[k].pressed = true), i);
  await page.waitForTimeout(120);
  await page.evaluate((k) => ((window as Api).__pad.buttons[k].pressed = false), i);
  await page.waitForTimeout(120);
}

export async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}
