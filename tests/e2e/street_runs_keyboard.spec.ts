import { expect, test, type Page } from '@playwright/test';
import { buildStreetRunCourses, formatRunTime } from '../../src/sim/streetRuns';
import { StaticWorld } from '../../src/world/staticWorld';
import { boot, type Api } from './helpers';
import { BOT_KEYS, coursePath, KeyboardBot, type BotCar, type BotKeys, type BotObstacle } from './keyboardBot';

// A bot that drives Magnolia Rush with real key presses only (W/S/A/D/Space through page.keyboard): after GO nothing
// is written to the game, it only reads the car and what is around it. Through the default ambient traffic it has to
// credit every gate in order, touch no other vehicle and finish within bronze, on 3 runs out of 3.

const COURSE = 'magnolia';
const RUN_TIMEOUT = 60_000;

interface Seen {
  stage: string | null;
  car: BotCar | null;
  obstacles: BotObstacle[];
}

/** What the bot may know: its car and the vehicles and people within 60 m. Reads only. */
async function look(page: Page): Promise<Seen> {
  return page.evaluate(() => {
    const sim = (window as Api).__gta7.sim;
    const j = sim.activities.job;
    const car = sim.player.vehicle;
    if (!car) return { stage: j?.stage ?? null, car: null, obstacles: [] };
    const obstacles: BotObstacle[] = [];
    const near = (x: number, z: number) => Math.abs(x - car.pos.x) < 60 && Math.abs(z - car.pos.z) < 60;
    for (const v of sim.vehicles) {
      if (v === car || v.removed || !near(v.pos.x, v.pos.z)) continue;
      obstacles.push({ x: v.pos.x, z: v.pos.z, heading: v.heading, halfL: v.halfL, halfW: v.halfW, vx: v.vel.x, vz: v.vel.z });
    }
    for (const c of sim.characters) {
      if (c.isPlayer || c.removed || c.vehicle || !near(c.pos.x, c.pos.z)) continue;
      obstacles.push({ x: c.pos.x, z: c.pos.z, heading: 0, halfL: 0.4, halfW: 0.4, vx: c.vel.x, vz: c.vel.z });
    }
    return {
      stage: j?.kind === 'streetRun' ? j.stage : null,
      car: { x: car.pos.x, z: car.pos.z, heading: car.heading, speed: car.forwardSpeed, wheel: car.steer, halfL: car.halfL, halfW: car.halfW, length: car.spec.length, steer: car.spec.steer },
      obstacles,
    };
  });
}

/** Counts, without changing anything: vehicle-vehicle contacts of the player's car while racing, gates, the finish. */
async function instrument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sim = (window as Api).__gta7.sim;
    const log = { contacts: [] as string[], gates: [] as number[], finish: null as null | { time: number; medal: string; reward: number } };
    (window as Api).__kbbot = log;
    const impact = sim.onVehicleImpact.bind(sim);
    sim.onVehicleImpact = (v: Api, other: Api, ...rest: unknown[]) => {
      const j = sim.activities.job;
      const car = sim.player.vehicle;
      if (j?.kind === 'streetRun' && j.stage === 'racing' && other && car && (v === car || other === car)) {
        log.contacts.push(`${j.elapsed.toFixed(1)}s ${(other === car ? v : other).kind}`);
      }
      return impact(v, other, ...rest);
    };
    sim.events.on('streetRunCheckpoint', (e: Api) => log.gates.push(e.index));
    sim.events.on('streetRunFinished', (e: Api) => (log.finish = { time: e.time, medal: e.medal, reward: e.reward }));
  });
}

async function setKeys(page: Page, held: BotKeys, want: BotKeys): Promise<void> {
  for (const k of BOT_KEYS) {
    if (want[k] === held[k]) continue;
    if (want[k]) await page.keyboard.down(k);
    else await page.keyboard.up(k);
    held[k] = want[k];
  }
}

test.describe('street runs: keyboard bot', () => {
  const world = new StaticWorld();
  const course = buildStreetRunCourses(world.roads).find((c) => c.id === COURSE)!;
  const path = coursePath(world.roads, course);

  for (const run of [1, 2, 3]) {
    test(`finishes Magnolia Rush through traffic without contact, run ${run} of 3`, async ({ page }, testInfo) => {
      test.setTimeout(240_000);
      const errors = await boot(page);
      await page.locator('button[data-id="street-run"]').click();
      await page.locator(`button[data-id="course-${COURSE}"]`).click();
      await page.waitForFunction((id) => {
        const g = (window as Api).__gta7;
        const j = g.sim.activities.job;
        return g.state().mode === 'game' && j?.kind === 'streetRun' && j.course.id === id;
      }, COURSE, { timeout: RUN_TIMEOUT });
      // The page builds the same city: the bot's path starts in the page's start gate.
      const start = await page.evaluate(() => (window as Api).__gta7.sim.activities.job.course.start);
      expect(start.x).toBeCloseTo(course.start.x, 6);
      expect(start.z).toBeCloseTo(course.start.z, 6);
      await instrument(page);
      await page.waitForFunction(() => {
        const g = (window as Api).__gta7;
        return g.sim.activities.job?.stage === 'racing' && g.sim.controlLock === 0;
      }, null, { timeout: RUN_TIMEOUT });

      const bot = new KeyboardBot(path);
      const held: BotKeys = { KeyW: false, KeyS: false, KeyA: false, KeyD: false, Space: false };
      const deadline = Date.now() + (course.bronze + 30) * 1000;
      try {
        for (;;) {
          const seen = await look(page);
          if (seen.stage !== 'racing' || !seen.car || Date.now() > deadline) break;
          await setKeys(page, held, bot.decide(seen.car, seen.obstacles));
        }
      } finally {
        await setKeys(page, held, { KeyW: false, KeyS: false, KeyA: false, KeyD: false, Space: false });
      }

      const log = await page.evaluate(() => (window as Api).__kbbot as { contacts: string[]; gates: number[]; finish: null | { time: number; medal: string; reward: number } });
      console.log(`[kbbot] run ${run}: ${log.finish ? `${log.finish.time.toFixed(1)}s ${log.finish.medal} $${log.finish.reward}` : 'DNF'}; gates ${log.gates.length}/${course.checkpoints.length}; contacts ${log.contacts.length ? log.contacts.join(', ') : 0}`);
      if (run === 1) await page.screenshot({ path: testInfo.outputPath('run-kbbot-finish.png') });
      expect(log.finish, `gates ${log.gates.join(',')}`).not.toBeNull();
      expect(log.gates).toEqual(course.checkpoints.map((_, k) => k + 1));
      expect(log.contacts).toEqual([]);
      expect(log.finish!.time).toBeLessThanOrEqual(course.bronze);
      expect(['gold', 'silver', 'bronze']).toContain(log.finish!.medal);
      expect(log.finish!.reward).toBeGreaterThan(0);

      // The course picker shows the new best time.
      await page.evaluate(() => (window as Api).__gta7.game.quitToTitle());
      await page.locator('button[data-id="street-run"]').click();
      await expect(page.locator(`button[data-id="course-${COURSE}"]`)).toHaveAccessibleDescription(new RegExp(`BEST ${formatRunTime(log.finish!.time).replace('.', '\\.')}`));
      expect(errors).toEqual([]);
    });
  }
});
