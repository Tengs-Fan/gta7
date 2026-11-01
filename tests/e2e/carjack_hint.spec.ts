import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// The prompt for taking a vehicle: "Press F to get in the Velora" beside an empty car, "Press F to carjack the Velora"
// beside one with a driver at a stop, with the key cap F; F then takes the car the prompt named. The sim's side
// (every case, every slot) is tests/unit/enter_prompt.test.ts.

/** Spawns `kind` on the lane nearest the player, `back` m behind the point he stands at, held at a stop by a civilian. */
async function stoppedCar(page: Page, kind: 'sedan' | 'compact', back = 0): Promise<void> {
  await page.evaluate(
    ([k, b]) => {
      const g = (window as Api).__gta7;
      const s = g.sim;
      const p = s.player;
      const lane = s.roads.nearestLane(p.pos.x, p.pos.z).lane;
      const along = Math.min(lane.length - 5, Math.max(25, (p.pos.x - lane.sx) * lane.dx + (p.pos.z - lane.sz) * lane.dz)) - b;
      const v = s.spawnVehicle(k, lane.sx + lane.dx * along, lane.sz + lane.dz * along, lane.heading);
      v.owner = 'traffic';
      const driver = s.addDriver(v, 'civilian', 'traffic');
      driver.owner = 'traffic';
      v.ai.setLane(lane, along);
      v.ai.hold = true;
      if (b === 0) (window as Api).__stopped = { vehicle: v, driver };
    },
    [kind, back] as const,
  );
}

/** Stands the player facing the stopped car's driver's door, 2.3 m from it (as the other specs do). */
async function standAtDoor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as Api).__gta7;
    const v = (window as Api).__stopped.vehicle;
    const x = v.pos.x + Math.cos(v.heading) * 2.3;
    const z = v.pos.z - Math.sin(v.heading) * 2.3;
    g.sim.player.heading = Math.atan2(v.pos.x - x, v.pos.z - z);
    g.teleport(x, z);
  });
}

test.describe('the prompt for taking a vehicle', () => {
  test('beside a parked car it says "get in" with the F key cap, and goes when the player walks off', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => {
      const g = (window as Api).__gta7;
      g.godMode(true);
      g.spawnVehicle('sedan', false);
      const v = g.sim.vehicles[g.sim.vehicles.length - 1];
      g.place(v.pos.x + Math.cos(v.heading) * 2.3, v.pos.z - Math.sin(v.heading) * 2.3);
      (window as Api).__car = v;
    });
    const prompt = page.locator('.prompt');
    await expect(prompt).toHaveText('Press F to get in the Velora');
    await expect(prompt.locator('kbd')).toHaveText('F');
    await page.evaluate(() => {
      const v = (window as Api).__car;
      (window as Api).__gta7.place(v.pos.x + 30, v.pos.z + 30);
    });
    await expect(prompt).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('beside a car stopped in traffic it says "carjack", and F takes that car and puts its driver out', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const errors = await boot(page);
    await newGame(page);
    await page.evaluate(() => (window as Api).__gta7.godMode(true));
    await stoppedCar(page, 'compact', 8);
    await stoppedCar(page, 'sedan');
    await standAtDoor(page);
    const prompt = page.locator('.prompt');
    await expect(prompt).toHaveText('Press F to carjack the Velora');
    await expect(prompt.locator('kbd')).toHaveText('F');
    await page.keyboard.press('KeyF');
    await page.waitForFunction(() => (window as Api).__gta7.state().player.vehicle === 'sedan', null, { timeout: 8000 });
    const out = await page.evaluate(() => {
      const { vehicle, driver } = (window as Api).__stopped;
      const s = (window as Api).__gta7.sim;
      return { driverIsPlayer: vehicle.driver === s.player, victimInCar: driver.vehicle !== null, victimState: driver.state };
    });
    expect(out.driverIsPlayer).toBe(true);
    expect(out.victimInCar).toBe(false);
    expect(['knocked', 'normal']).toContain(out.victimState);
    // At the wheel the vehicle prompt is gone (a side-job prompt such as a street run's may stand in its place).
    await expect(prompt).not.toContainText('carjack');
    expect(errors).toEqual([]);
  });
});
