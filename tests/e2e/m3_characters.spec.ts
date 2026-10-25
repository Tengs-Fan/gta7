// Mission 3 characters on the real GPU: skinned models through the near pool and the batched crowd with bounded draws,
// first-draw fades and lens dissolves with no new shader programs, every tier and tier cycles without leaks, a WebGL
// context loss and restore, and the software renderer keeping the segment crowd (VAL-CHR-007/008/009).

import { chromium, expect, test, type Page } from '@playwright/test';
import { currentBrowserLaunch } from '../../scripts/browserFlags.mjs';
import { boot, newGame, type Api } from './helpers';

/** A still scene by the bank: no ambient spawns, the clock stopped, `n` standing pedestrians in front of the player. */
async function plaza(page: Page, n: number): Promise<number[]> {
  return page.evaluate((n) => {
    const g = (window as Api).__gta7;
    g.godMode(true);
    g.setClockRate(0);
    g.setTime(12);
    g.setWanted(0);
    g.sim.ambient = false;
    const p = g.sim.player;
    for (const c of [...g.sim.characters]) if (c !== p && !c.vehicle && c.role !== 'player') g.sim.removeCharacter(c);
    const b = g.poi('bank');
    g.place(b.x - 1.6, b.z - 2, Math.PI);
    g.setCamera(Math.PI, -0.05);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      // Rings from 2 m to about 40 m ahead and to the sides.
      const a = Math.PI + ((i % 9) - 4) * 0.22;
      const r = 2.5 + Math.floor(i / 9) * 4.5;
      const c = g.sim.spawnCharacter('civilian', b.x - 1.6 + Math.sin(a) * r, b.z - 2 + Math.cos(a) * r);
      c.brain = null;
      c.persistent = true;
      c.owner = 'mission';
      ids.push(c.id);
    }
    return ids;
  }, n);
}

const frames = (page: Page, n: number) =>
  page.evaluate((n) => new Promise<void>((res) => {
    let k = 0;
    const f = () => (++k >= n ? res() : requestAnimationFrame(f));
    requestAnimationFrame(f);
  }), n);

test.describe('mission 3 characters', () => {
  test('High draws skinned people through a bounded near pool and one batched crowd, keeping looks across the boundary', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const ids = await plaza(page, 72);
    await page.waitForTimeout(1500);
    const r = await page.evaluate((ids) => {
      const g = (window as Api).__gta7;
      const R = g.game.renderer;
      let skinned = 0;
      R.scene.traverse((o: { isSkinnedMesh?: boolean; visible: boolean }) => { if (o.isSkinnedMesh && o.visible) skinned++; });
      const cost: number[] = [];
      for (const vis of [true, false]) {
        R.crowd.group.visible = vis;
        R.render(0, false);
        cost.push(R.stats().calls);
      }
      R.crowd.group.visible = true;
      const looks = ids.map((id: number) => g.ext.characters.lookOf(id)).filter(Boolean);
      return { stats: g.ext.characters.stats(), skinned, calls: cost[0]! - cost[1]!, looks, tier: g.state().render.tier, models: R.crowd.models !== null };
    }, ids);
    console.log(`[m3-characters] ${JSON.stringify({ stats: r.stats, skinned: r.skinned, calls: r.calls, drawn: r.looks.length, distinctLooks: new Set(r.looks.map((l: { look: string }) => l.look)).size })}`);
    expect(r.tier).toBe('high');
    expect(r.models).toBe(true);
    expect(r.stats.models).toBe(true);
    expect(r.stats.skinnedMeshes).toBeGreaterThan(0);
    expect(r.stats.skinnedMeshes).toBeLessThanOrEqual(24);
    expect(r.skinned).toBeLessThanOrEqual(24);
    expect(r.stats.crowd).toBeGreaterThan(20);
    expect(r.looks.length).toBeGreaterThanOrEqual(60);
    expect(new Set(r.looks.map((l: { look: string }) => l.look)).size).toBeGreaterThanOrEqual(10);
    // 24 near meshes x 2 draws x 2 passes + one crowd draw per body type and pass, plus held guns: none here.
    expect(r.calls).toBeLessThanOrEqual(24 * 2 * 2 + 2 * 4 * 2);

    // A pedestrian walked from 22 m to 10 m away across the near pool's range keeps his look and fade (alone, so
    // the pool has room for him once he is near enough).
    const cross = await page.evaluate(async (ids) => {
      const g = (window as Api).__gta7;
      const p = g.sim.player;
      for (const c of [...g.sim.characters]) if (ids.includes(c.id)) g.sim.removeCharacter(c);
      await new Promise((res) => setTimeout(res, 2000));
      const c = g.sim.spawnCharacter('civilian', p.pos.x, p.pos.z - 22);
      c.brain = null;
      c.persistent = true;
      const out: Array<{ d: number; near: boolean; look: string; fade: number }> = [];
      for (let k = 0; k < 120; k++) {
        c.pos.z = p.pos.z - 22 + k * 0.1;
        await new Promise((res) => requestAnimationFrame(res));
        const l = g.ext.characters.lookOf(c.id);
        if (l) out.push({ d: p.pos.z - c.pos.z, near: l.near, look: l.look, fade: l.fade });
      }
      return out;
    }, ids);
    expect(cross.some((x) => x.near)).toBe(true);
    expect(cross.some((x) => !x.near)).toBe(true);
    expect(new Set(cross.map((x) => x.look)).size).toBe(1);
    expect(errors).toEqual([]);
  });

  test('new pedestrians fade in over 0.3 to 1 s, the camera dissolves them, and 30 s of fades compile no new programs', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await plaza(page, 20);
    await page.waitForTimeout(5000);
    const programs0 = (await page.evaluate(() => (window as Api).__gta7.state().render.programs)) as number;
    const fades = await page.evaluate(async () => {
      const g = (window as Api).__gta7;
      const p = g.sim.player;
      const out: Array<{ first: number; whole: number }> = [];
      const t0 = performance.now();
      let k = 0;
      // Spawn a pedestrian in view every 1.5 s and take away the oldest, for 30 s.
      const live: Array<{ c: { id: number; removed: boolean }; born: number; first: number | null; firstT: number; whole: number | null }> = [];
      while (performance.now() - t0 < 30_000) {
        if (k % 90 === 0) {
          const c = g.sim.spawnCharacter('civilian', p.pos.x + ((k / 90) % 5) - 2, p.pos.z - 6 - ((k / 90) % 4));
          c.brain = null;
          c.persistent = true;
          live.push({ c, born: performance.now(), first: null, firstT: 0, whole: null });
          if (live.length > 6) g.sim.removeCharacter(live.shift()!.c);
        }
        await new Promise((res) => requestAnimationFrame(res));
        for (const e of live) {
          const l = g.ext.characters.lookOf(e.c.id);
          if (!l) continue;
          if (e.first === null) {
            e.first = l.fade;
            e.firstT = performance.now();
          }
          if (e.whole === null && l.fade >= 1) {
            e.whole = (performance.now() - e.firstT) / 1000;
            out.push({ first: e.first ?? 0, whole: e.whole });
          }
        }
        k++;
      }
      return out;
    });
    // Near-lens dissolve: the camera against a pedestrian's chest.
    const lens = await page.evaluate(async () => {
      const g = (window as Api).__gta7;
      const p = g.sim.player;
      const c = g.sim.spawnCharacter('civilian', p.pos.x, p.pos.z - 3);
      c.brain = null;
      c.persistent = true;
      await new Promise((res) => setTimeout(res, 1200));
      const R = g.game.renderer;
      const ctl = R.cameraCtl;
      const orig = ctl.update.bind(ctl);
      ctl.update = (...a: unknown[]) => {
        const r = orig(...a);
        ctl.camera.position.set(c.pos.x, c.pos.y + 1.35, c.pos.z - 0.6);
        ctl.camera.lookAt(c.pos.x, c.pos.y + 1.3, c.pos.z + 3);
        ctl.camera.updateMatrixWorld();
        return r;
      };
      await new Promise((res) => setTimeout(res, 500));
      const l = g.ext.characters.lookOf(c.id);
      ctl.update = orig;
      return { lens: l?.lens, near: l?.near };
    });
    const programs1 = (await page.evaluate(() => (window as Api).__gta7.state().render.programs)) as number;
    console.log(`[m3-characters] fades ${JSON.stringify(fades.slice(0, 8))} n=${fades.length} programs ${programs0} -> ${programs1} lens ${JSON.stringify(lens)}`);
    expect(fades.length).toBeGreaterThanOrEqual(10);
    for (const f of fades) {
      expect(f.first).toBeLessThan(0.2);
      expect(f.whole).toBeGreaterThanOrEqual(0.3);
      expect(f.whole).toBeLessThanOrEqual(1.0);
    }
    expect(lens.lens).toBe(true);
    expect(lens.near).toBe(true);
    expect(programs1).toBe(programs0);
    expect(errors).toEqual([]);
  });

  test('every tier draws the characters, Low without shadows; three tier cycles and a context loss keep them whole', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    await plaza(page, 30);
    await page.waitForTimeout(1500);
    const TIERS = ['high', 'medium', 'low', 'high', 'medium', 'low', 'high', 'medium', 'low', 'high'] as const;
    const cycle: Array<{ tier: string; crowd: number; near: number; shadows: boolean; casts: boolean; geometries: number; textures: number; bones: string }> = [];
    for (const tier of TIERS) {
      cycle.push(await page.evaluate(async (tier) => {
        const g = (window as Api).__gta7;
        const R = g.game.renderer;
        R.setQuality(tier);
        for (let k = 0; k < 30; k++) await new Promise((res) => requestAnimationFrame(res));
        const m = R.crowd.models;
        const st = g.ext.characters.stats();
        return {
          tier: g.state().render.tier,
          crowd: st.crowd,
          near: st.skinnedMeshes,
          shadows: R.renderer.shadowMap.enabled as boolean,
          casts: m.batched.castShadow && m.pool[0].mesh.castShadow,
          geometries: R.renderer.info.memory.geometries as number,
          textures: R.renderer.info.memory.textures as number,
          bones: [m.boneTexture.uuid, ...m.pool.map((s: { skeleton: { boneTexture: { uuid: string } } }) => s.skeleton.boneTexture.uuid)].join(','),
        };
      }, tier));
    }
    console.log(`[m3-characters] tiers ${cycle.map((c) => `${c.tier} crowd ${c.crowd} near ${c.near} shadows ${c.shadows} geo ${c.geometries} tex ${c.textures}`).join('; ')}`);
    for (const c of cycle) {
      expect(c.crowd + c.near).toBeGreaterThan(20);
      expect(c.shadows).toBe(c.tier !== 'low');
      expect(c.casts).toBe(true);
      expect(c.bones).toBe(cycle[0]!.bones);
    }
    const highs = cycle.filter((c) => c.tier === 'high');
    expect(highs[highs.length - 1]!.geometries).toBeLessThanOrEqual(highs[1]!.geometries * 1.03);
    expect(highs[highs.length - 1]!.textures).toBeLessThanOrEqual(highs[1]!.textures * 1.03);

    // Context loss: a frame read back before the loss and after the restore (paused, so nothing moves).
    const read = () => page.evaluate(() => {
      const R = (window as Api).__gta7.game.renderer;
      R.render(0, false);
      const gl = R.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      (window as Api).__px = (window as Api).__px ?? [];
      (window as Api).__px.push(px);
      return { w, h, chars: (window as Api).__gta7.ext.characters.stats() };
    });
    await page.evaluate(() => (window as Api).__gta7.game.pause());
    await page.waitForTimeout(300);
    const before = await read();
    await page.evaluate(() => {
      const ext = (window as Api).__gta7.game.renderer.renderer.getContext().getExtension('WEBGL_lose_context');
      (window as Api).__lose = ext;
      ext.loseContext();
    });
    await page.waitForFunction(() => (window as Api).__gta7.game.contextLost === true);
    await page.evaluate(() => (window as Api).__lose.restoreContext());
    await page.waitForFunction(() => (window as Api).__gta7.game.contextLost === false);
    await page.waitForTimeout(800);
    const after = await read();
    const diff = await page.evaluate(() => {
      const [a, b] = (window as Api).__px as Uint8Array[];
      let sum = 0;
      let n = 0;
      for (let i = 0; i < a!.length; i += 4) {
        sum += Math.abs(a![i]! - b![i]!) + Math.abs(a![i + 1]! - b![i + 1]!) + Math.abs(a![i + 2]! - b![i + 2]!);
        n += 3;
      }
      return sum / n;
    });
    console.log(`[m3-characters] context restore mean abs diff ${diff.toFixed(3)} / 255; before ${JSON.stringify(before.chars)} after ${JSON.stringify(after.chars)}`);
    expect(after.chars.models).toBe(true);
    expect(after.chars.crowd + after.chars.skinnedMeshes).toBe(before.chars.crowd + before.chars.skinnedMeshes);
    expect(diff).toBeLessThanOrEqual(3);
    expect(errors).toEqual([]);
  });

  test('the software renderer keeps the segment crowd and creates no SkinnedMesh', async () => {
    const browser = await chromium.launch(currentBrowserLaunch(chromium, { software: true }));
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      const errors = await boot(page);
      await page.evaluate(() => (window as Api).__gta7.newGame({ intro: false }));
      await page.waitForFunction(() => (window as Api).__gta7.state().mode === 'game');
      await plaza(page, 12);
      await frames(page, 20);
      const r = await page.evaluate(() => {
        const g = (window as Api).__gta7;
        let skinned = 0;
        g.game.renderer.scene.traverse((o: { isSkinnedMesh?: boolean }) => { if (o.isSkinnedMesh) skinned++; });
        return { software: g.state().render.software, stats: g.ext.characters.stats(), skinned };
      });
      console.log(`[m3-characters] software ${JSON.stringify(r)}`);
      expect(r.software).toBe(true);
      expect(r.stats.models).toBe(false);
      expect(r.stats.segments).toBeGreaterThan(5);
      expect(r.skinned).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
