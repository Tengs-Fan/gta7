import { expect, test, type Page } from '@playwright/test';
import { Progress, serialize } from '../../src/sim/progress';
import { boot, state, type Api } from './helpers';

const RUN_TIMEOUT = 60_000;

async function chooseCourse(page: Page, id = 'magnolia'): Promise<void> {
  await page.locator('button[data-id="street-run"]').click();
  await expect(page.locator('.runs-panel h2')).toHaveText('PICK YOUR RUN.');
  await expect(page.locator('.course-menu button[data-id^="course-"]')).toHaveCount(3);
  await page.locator(`button[data-id="course-${id}"]`).click();
  await page.waitForFunction((courseId) => {
    const g = (window as Api).__gta7;
    const j = g.sim.activities.job;
    return g.state().mode === 'game' && j?.kind === 'streetRun' && j.course.id === courseId;
  }, id, { timeout: RUN_TIMEOUT });
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const g = (window as Api).__gta7;
    const sim = g.sim;
    const j = sim.activities.job;
    const car = sim.player.vehicle;
    return {
      frames: g.state().frames,
      simTime: sim.time as number,
      stage: j?.stage as string | undefined,
      countdown: j?.countdown as number | undefined,
      elapsed: j?.elapsed as number | undefined,
      checkpoint: j?.checkpoint as number | undefined,
      lock: sim.controlLock as number,
      x: car?.pos.x as number | undefined,
      z: car?.pos.z as number | undefined,
      throttle: car?.controls.throttle as number | undefined,
      money: sim.progress.money as number,
    };
  });
}

async function waitForGo(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const g = (window as Api).__gta7;
    return g.sim.activities.job?.stage === 'racing' && g.sim.controlLock === 0;
  }, null, { timeout: RUN_TIMEOUT });
}

/** Observe several actual frames: a frozen renderer cannot make a pause test pass. */
async function renderedFrames(page: Page, from: number, count = 4): Promise<void> {
  await page.waitForFunction((target) => {
    const g = (window as Api).__gta7;
    // Menus briefly ignore their opening key. Wait for that real menu clock,
    // too, so a very fast GPU cannot make the next M press arrive too soon.
    return g.state().frames >= target && g.game.menus.age >= 0.3;
  }, from + count, { timeout: RUN_TIMEOUT });
}

test.describe('street runs: player journeys', () => {
  test('launches from the course picker, locks the countdown and drives through the first gate with W', async ({ page }) => {
    const errors = await boot(page);
    await chooseCourse(page);
    const start = await snapshot(page);
    expect(start.stage).toBe('countdown');
    expect(start.lock).toBeGreaterThan(0);
    expect(start.elapsed).toBe(0);
    expect((await state(page)).player.vehicle).toBe('sports');
    await expect(page.locator('[data-el="objective"]')).toContainText('Get ready');

    await page.keyboard.down('KeyW');
    try {
      await page.waitForFunction((countdown) => {
        const j = (window as Api).__gta7.sim.activities.job;
        return j?.stage !== 'countdown' || j.countdown < countdown - 0.25;
      }, start.countdown!, { timeout: RUN_TIMEOUT });
      const held = await snapshot(page);
      expect(held.stage).toBe('countdown');
      expect(held.x).toBeCloseTo(start.x!, 5);
      expect(held.z).toBeCloseTo(start.z!, 5);
      expect(held.throttle).toBe(0);
      expect(held.elapsed).toBe(0);

      await waitForGo(page);
      await expect(page.locator('.big.countdown [data-el="bigT"]')).toHaveText('GO');
      // This first leg is a straight road. Keep the real key held until the
      // simulation credits its gate; do not substitute a timed sleep/teleport.
      await page.waitForFunction(() => {
        const j = (window as Api).__gta7.sim.activities.job;
        return j?.kind === 'streetRun' && j.checkpoint >= 1;
      }, null, { timeout: RUN_TIMEOUT });
    } finally {
      await page.keyboard.up('KeyW');
    }
    const driven = await snapshot(page);
    expect(driven.checkpoint).toBeGreaterThanOrEqual(1);
    expect(Math.hypot(driven.x! - start.x!, driven.z! - start.z!)).toBeGreaterThan(35);
    expect(driven.elapsed).toBeGreaterThan(1);
    await expect(page.locator('[data-el="status"]')).toContainText('GATE 2/');
    expect((await state(page)).crashed).toBe(false);
    expect(errors).toEqual([]);
  });

  test('pause and map hold the race clock, resume continues it, and T cancels without awarding a finish', async ({ page }) => {
    const errors = await boot(page);
    await chooseCourse(page);
    await waitForGo(page);
    await page.waitForFunction(() => (window as Api).__gta7.sim.activities.job.elapsed > 0.25, null, { timeout: RUN_TIMEOUT });

    await page.keyboard.press('KeyP');
    await expect(page.locator('.pause-panel h2')).toHaveText('PAUSED');
    const paused = await snapshot(page);
    await renderedFrames(page, paused.frames);
    const duringPause = await snapshot(page);
    expect(duringPause.elapsed).toBe(paused.elapsed);
    expect(duringPause.simTime).toBe(paused.simTime);
    await page.getByRole('button', { name: 'RESUME', exact: true }).click();
    await page.waitForFunction((elapsed) => (window as Api).__gta7.sim.activities.job.elapsed > elapsed + 0.15, paused.elapsed!, { timeout: RUN_TIMEOUT });

    await page.keyboard.press('KeyM');
    await expect(page.locator('.map-screen')).toBeVisible();
    const mapped = await snapshot(page);
    await renderedFrames(page, mapped.frames);
    const duringMap = await snapshot(page);
    expect(duringMap.elapsed).toBe(mapped.elapsed);
    expect(duringMap.simTime).toBe(mapped.simTime);
    await page.keyboard.press('KeyM');
    await expect(page.locator('.map-screen')).toHaveCount(0);
    await page.waitForFunction((elapsed) => (window as Api).__gta7.sim.activities.job.elapsed > elapsed + 0.15, mapped.elapsed!, { timeout: RUN_TIMEOUT });

    await page.keyboard.press('KeyT');
    await page.waitForFunction(() => !(window as Api).__gta7.sim.activities.busy, null, { timeout: RUN_TIMEOUT });
    const ended = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      return { money: g.sim.progress.money, records: g.sim.progress.streetRuns, objectives: g.sim.activities.objectives(), status: g.sim.activities.status(), save: [1, 2, 3].map((i) => localStorage.getItem(`gta7.save.slot${i}`)).find((x) => x !== null) ?? null };
    });
    expect(ended).toEqual({ money: paused.money, records: {}, objectives: [], status: null, save: null });
    expect((await state(page)).crashed).toBe(false);
    expect(errors).toEqual([]);
  });

  test('shows saved personal bests and preserves story, cash and equipment when selecting another run', async ({ page }) => {
    const progress = new Progress();
    progress.money = 4321;
    progress.missionsDone = ['wheels'];
    progress.streetRuns.magnolia = { bestTime: 58.25, medal: 'gold', finishes: 2 };
    const saved = serialize(progress, [{ id: 'pistol', ammo: 41 }], 35, 17, 3);
    // A pre-existing browser save is the fixture. Starting/cancelling a race
    // must preserve it, and must not manufacture a successful finish.
    await page.addInitScript((data) => localStorage.setItem('gta7.save.v1', JSON.stringify(data)), saved);
    const errors = await boot(page);
    await page.locator('button[data-id="street-run"]').click();
    await expect(page.locator('button[data-id="course-magnolia"]')).toHaveAccessibleDescription(/BEST 0:58\.2/);
    await expect(page.locator('button[data-id="course-coastline"]')).toHaveAccessibleDescription(/NO TIME SET/);
    await page.locator('button[data-id="course-coastline"]').click();
    await waitForGo(page);
    const loaded = await page.evaluate(() => {
      const sim = (window as Api).__gta7.sim;
      return { course: sim.activities.job.course.id, money: sim.progress.money, missions: sim.progress.missionsDone, records: sim.progress.streetRuns, ammo: sim.player.inventory.total('pistol'), armor: sim.player.armor };
    });
    expect(loaded).toEqual({ course: 'coastline', money: 4321, missions: ['wheels'], records: progress.streetRuns, ammo: 41, armor: 35 });
    await page.keyboard.press('KeyT');
    await page.waitForFunction(() => !(window as Api).__gta7.sim.activities.busy, null, { timeout: RUN_TIMEOUT });
    // The old single save moved into slot 1 (wave 1 save slots) and stays as it was.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gta7.save.slot1')!))).toEqual(saved);
    expect((await state(page)).crashed).toBe(false);
    expect(errors).toEqual([]);
  });
});
