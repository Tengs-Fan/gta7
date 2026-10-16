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

export async function boot(page: Page): Promise<string[]> {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.waitForFunction(() => (window as Api).__gta7?.state().frames > 20, null, { timeout: 90_000 });
  return errors;
}

export async function newGame(page: Page): Promise<void> {
  await page.click('button[data-id="new"]');
  await page.waitForFunction(() => (window as Api).__gta7.state().mode === 'game');
  await page.waitForTimeout(400);
}

export const state = (page: Page) => page.evaluate(() => (window as Api).__gta7.state());

export async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}
