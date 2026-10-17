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

  test('storefront taglines and window labels are drawn at least 11 texels tall', async ({ page }) => {
    const errors = await boot(page);
    const rows = await page.evaluate(() => {
      const img = (window as Api).__gta7.game.renderer.city.materials.storefront.map.image as HTMLCanvasElement;
      const ctx = img.getContext('2d')!;
      /**
       * Texel rows holding ink in a region of an atlas cell (metres from the cell's top left, the cell
       * drawn for 6.5 m x `h` m in a 248 x 328 texel slot of a 256 x 336 grid): ink is what stands out
       * from the region's commonest colour by more than half the most any texel does.
       */
      const inkRows = (cell: number, h: number, x0: number, y0: number, x1: number, y1: number): number => {
        const sx = 248 / 6.5;
        const sy = 328 / h;
        const ox = (cell % 8) * 256 + 4;
        const oy = Math.floor(cell / 8) * 336 + 4;
        const px = Math.round(ox + x0 * sx);
        const py = Math.round(oy + y0 * sy);
        const w = Math.round(ox + x1 * sx) - px;
        const hh = Math.round(oy + y1 * sy) - py;
        const d = ctx.getImageData(px, py, w, hh).data;
        const count = new Map<number, number>();
        for (let k = 0; k < d.length; k += 4) {
          const key = ((d[k]! >> 3) << 10) | ((d[k + 1]! >> 3) << 5) | (d[k + 2]! >> 3);
          count.set(key, (count.get(key) ?? 0) + 1);
        }
        const key = [...count.entries()].sort((a, b) => b[1] - a[1])[0]![0];
        const bg = [((key >> 10) & 31) * 8 + 4, ((key >> 5) & 31) * 8 + 4, (key & 31) * 8 + 4];
        const dist = (k: number) => Math.hypot(d[k]! - bg[0]!, d[k + 1]! - bg[1]!, d[k + 2]! - bg[2]!);
        let max = 0;
        for (let k = 0; k < d.length; k += 4) max = Math.max(max, dist(k));
        let n = 0;
        for (let y = 0; y < hh; y++) {
          let m = 0;
          for (let x = 0; x < w; x++) m = Math.max(m, dist((y * w + x) * 4));
          if (m > 0.5 * max) n++;
        }
        return n;
      };
      const out: Record<string, number> = {};
      // The 16 shop fascias: the tagline under the name.
      for (let i = 0; i < 16; i++) out[`tagline ${i}`] = inkRows(i, 4.5, 0.5, 0.6, 6.0, 0.93);
      // Window cards and signs: bail bonds' FREE CALL, the phone shop's NO QUESTIONS, the pizzeria's BY THE SLICE, and the lobby doors' street number.
      out['FREE CALL'] = inkRows(4, 4.5, 4.15, 2.75, 5.7, 3.04);
      out['NO QUESTIONS'] = inkRows(13, 4.5, 0.9, 1.85, 2.5, 2.13);
      out['BY THE SLICE'] = inkRows(11, 4.5, 2.7, 1.33, 4.4, 1.75);
      out['1200'] = inkRows(17, 6.5, 2.25, 3.32, 4.25, 3.67);
      return out;
    });
    const short = Object.entries(rows).filter(([, n]) => n < 11);
    expect(short).toEqual([]);
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
