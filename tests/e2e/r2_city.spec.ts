import { expect, test } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

test.describe('GTA 7 round 2 city look', () => {
  test('the environment map keeps one target through ten re-bakes', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const r = await page.evaluate(() => {
      const g = (window as Api).__gta7;
      const R = g.game.renderer;
      g.sim.clock.rate = 0;
      g.setTime(10);
      R.render(1 / 60, false);
      const uuid0: string | null = R.scene.environment?.uuid ?? null;
      const textures0: number = R.renderer.info.memory.textures;
      const uuids = new Set<string>();
      // Clock jumps of more than a quarter hour force a re-bake on every frame.
      for (let i = 1; i <= 10; i++) {
        g.setTime((10 + i * 1.7) % 24);
        R.render(1 / 60, false);
        uuids.add(R.scene.environment?.uuid ?? 'none');
      }
      return { uuid0, uuids: [...uuids], textures0, textures1: R.renderer.info.memory.textures as number };
    });
    expect(r.uuid0).not.toBeNull();
    expect(r.uuids).toEqual([r.uuid0]);
    expect(r.textures1).toBeLessThanOrEqual(r.textures0);
    expect(errors).toEqual([]);
  });

  test('windows light up through the evening and go dark late at night', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    // The round 2 "ts" street corner downtown, looking up the tower across the street.
    const meanLuminance = (hours: number) =>
      page.evaluate((h) => {
        const g = (window as Api).__gta7;
        const R = g.game.renderer;
        g.godMode(true);
        g.sim.clock.rate = 0;
        g.setTime(h);
        g.teleport(-80, -95);
        g.setCamera(2.6, 0.1);
        for (let i = 0; i < 30; i++) R.render(1 / 60, false);
        // Measure the static city and sky only: passing cars, pedestrians and effects are noise here.
        const keep = new Set([R.city.group, R.props.group, R.env.sky, R.env.water]);
        const hidden = R.scene.children.filter((o: { visible: boolean }) => o.visible && !keep.has(o) && (o as { isLight?: boolean }).isLight !== true);
        for (const o of hidden) o.visible = false;
        R.render(1 / 60, false);
        for (const o of hidden) o.visible = true;
        const gl = R.renderer.getContext() as WebGL2RenderingContext;
        const w = gl.drawingBufferWidth;
        const hgt = gl.drawingBufferHeight;
        const px = new Uint8Array(w * hgt * 4);
        gl.readPixels(0, 0, w, hgt, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
        return sum / (w * hgt);
      }, hours);
    const evening = await meanLuminance(21.5);
    const lateNight = await meanLuminance(3.5);
    expect(evening).toBeGreaterThan(lateNight * 1.15);
    expect(errors).toEqual([]);
  });
});
