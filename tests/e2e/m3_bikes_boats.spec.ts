import { expect, test, type Page } from '@playwright/test';
import { boot, newGame, type Api } from './helpers';

// Mission 3 track C (VAL-BKB-003/005/006): the sculpted bikes and the new boat hulls fade in where they appear and out
// where they are removed, every part (the foam ring and the windscreen included) at one level and with no new shader
// programs; they stay drawn through High/Low tier cycles without growing geometry or texture counts and come back
// after a lost WebGL context; their lamps glow at night. In-page code is passed as source (no transpiler helpers).

/** Runs `body` (the source of an async function body; `g` is window.__gta7, `args` the arguments) in the page. */
async function run<T>(page: Page, body: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([src, a]) => new Function('g', 'args', `return (async () => { ${src} })()`)((window as Api).__gta7, a), [body, args] as const) as Promise<T>;
}

const SETUP = `
  g.godMode(true);
  g.setClockRate(0);
  g.setTime(args[0]);
  g.setWeather('clear', { instant: true });
  g.sim.traffic.density = 0;
  g.sim.peds.density = 0;
  const ctl = g.game.renderer.cameraCtl;
  if (!ctl.__orig) {
    ctl.__orig = ctl.update;
    ctl.update = function (dt, sim, aiming) {
      ctl.__orig.call(ctl, dt, sim, aiming);
      const o = window.__cam;
      if (o) { ctl.camera.position.set(o.pos[0], o.pos[1], o.pos[2]); ctl.camera.lookAt(o.look[0], o.look[1], o.look[2]); ctl.camera.updateMatrixWorld(); }
    };
  }
`;

const CLEAR = `for (const v of [...g.sim.vehicles]) if (v !== g.sim.player.vehicle) g.sim.removeVehicle(v);`;

const frame = `await new Promise((r) => requestAnimationFrame(r));`;

/**
 * Spawns a vehicle of kind args[0] at (args[1], args[2]) heading args[3] and follows its view through its fade in and,
 * after a second whole, its fade out: per frame the view's level, whether every part it draws itself is at that level
 * (opaque fade copies at the level, see-through ones at their own opacity times it), and its own draws.
 */
const FADES = `
  const R = g.game.renderer;
  const r = R.renderer;
  if (!r.__countHooked) {
    const draw = r.renderBufferDirect.bind(r);
    r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
      const root = window.__countRoot;
      if (root) for (let o = object; o; o = o.parent) if (o === root) { window.__countDraws++; break; }
      return draw(camera, scene, geometry, material, object, group);
    };
    r.__countHooked = true;
  }
  const v = g.sim.spawnVehicle(args[0], args[1], args[2], args[3]);
  v.owner = 'mission';
  v.persistent = true;
  const t0 = performance.now();
  const rows = [];
  let view = null;
  const sample = () => {
    view = R.vehicleViews.get(v.id) ?? view;
    if (!view) return;
    const level = view.fadeLevel;
    let same = true;
    const parts = [];
    view.group.traverse((o) => {
      if (!o.isMesh || o.userData.batched || o.layers.mask !== 1 && !o.castShadow) return;
      const m = o.material;
      const want = m.transparent ? (m.userData.baseOpacity ?? m.opacity) : level;
      if (!m.transparent && view.fading && Math.abs(m.opacity - level) > 1e-6) same = false;
      parts.push(o.name);
    });
    rows.push({ t: (performance.now() - t0) / 1000, level, fading: view.fading, visible: view.group.visible, same, draws: window.__countDraws, parts: parts.length });
  };
  window.__countDraws = 0;
  for (let k = 0; k < 240; k++) {
    ${frame}
    window.__countRoot = (R.vehicleViews.get(v.id) ?? view)?.group ?? null;
    sample();
    window.__countDraws = 0;
    if (rows.length > 5 && !rows[rows.length - 1].fading && (performance.now() - t0) > 1500) break;
  }
  const removedAt = (performance.now() - t0) / 1000;
  g.sim.removeVehicle(v);
  for (let k = 0; k < 120; k++) {
    ${frame}
    window.__countRoot = view.group;
    sample();
    window.__countDraws = 0;
    if (!view.fading && rows.length > 5) break;
  }
  window.__countRoot = null;
  return { rows, removedAt };
`;

type Row = { t: number; level: number; fading: boolean; visible: boolean; same: boolean; draws: number; parts: number };

function checkFades(label: string, res: { rows: Row[]; removedAt: number }): void {
  const rows = res.rows;
  const inRows = rows.filter((r) => r.t < res.removedAt);
  const outRows = rows.filter((r) => r.t >= res.removedAt);
  const first = inRows[0]!;
  const whole = inRows.find((r) => r.level >= 1 && !r.fading)!;
  const fadingIn = inRows.filter((r) => r.fading && r.level > 0);
  const wholeRows = inRows.filter((r) => !r.fading);
  const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const lastOut = outRows[outRows.length - 1]!;
  const outFrom = outRows.find((r) => r.fading);
  const gone = outRows.find((r) => !r.visible);
  console.log(`[m3-bikes-boats] ${label}: fade in from ${first.level.toFixed(2)} to whole at ${whole.t.toFixed(2)} s (${fadingIn.length} frames), own draws fading ${median(fadingIn.map((r) => r.draws))} vs whole ${median(wholeRows.map((r) => r.draws))}; fade out from ${outFrom?.level.toFixed(2)} gone at ${gone ? (gone.t - res.removedAt).toFixed(2) : '-'} s; every part at one level: ${rows.every((r) => r.same)}`);
  expect(first.level).toBeLessThan(0.15);
  expect(whole.t).toBeGreaterThanOrEqual(0.3);
  expect(whole.t).toBeLessThanOrEqual(1.0 + 0.1);
  expect(rows.every((r) => r.same)).toBe(true);
  expect(median(fadingIn.map((r) => r.draws))).toBeLessThanOrEqual(median(wholeRows.map((r) => r.draws)) + 2);
  expect(outFrom).toBeTruthy();
  expect(gone).toBeTruthy();
  expect(gone!.t - res.removedAt).toBeGreaterThanOrEqual(0.3);
  expect(gone!.t - res.removedAt).toBeLessThanOrEqual(1.1);
  expect(lastOut.fading).toBe(false);
}

test.describe('mission 3 bikes and boats', () => {
  test('bikes and boats fade in where they appear and out where they go, every part together, with no new programs', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const spot = await run<{ x: number; z: number; programs: number }>(page, `${SETUP}
      const b = g.sim.world.layout.bounds;
      g.teleport(b.beachStartX + 40, (b.landMinZ + b.landMaxZ) / 2);
      await new Promise((r) => setTimeout(r, 2500));
      ${CLEAR}
      const p = g.sim.player.pos;
      window.__cam = { pos: [p.x, p.y + 1.8, p.z], look: [p.x + 30, p.y + 0.5, p.z] };
      await new Promise((r) => setTimeout(r, 3000));
      return { x: p.x, z: p.z, programs: g.state().render.programs };`, 12);
    for (const kind of ['sportbike', 'scooter']) {
      checkFades(kind, await run(page, FADES, kind, spot.x + 30, spot.z, Math.PI / 2));
    }
    const marina = await run<{ x: number; z: number }>(page, `
      g.teleport(644, 466);
      await new Promise((r) => setTimeout(r, 2500));
      ${CLEAR}
      const b = g.sim.world.layout.props.find((p) => p.kind === 'boat');
      const cx = b.x + 13, cz = b.z - 22;
      g.sim.player.pos.x = cx - 30; g.sim.player.pos.z = cz - 10;
      window.__cam = { pos: [cx, 2.2, cz], look: [cx, -1, cz + 25] };
      await new Promise((r) => setTimeout(r, 1500));
      return { x: cx, z: cz };`);
    for (const kind of ['speedboat', 'dinghy']) {
      checkFades(kind, await run(page, FADES, kind, marina.x, marina.z + 25, 0.4));
    }
    const programs = await run<number>(page, `await new Promise((r) => setTimeout(r, 1000)); return g.state().render.programs;`);
    console.log(`[m3-bikes-boats] programs ${spot.programs} before the first bike, ${programs} after every kind faded in and out`);
    expect(programs).toBeLessThanOrEqual(spot.programs);
    expect(errors).toEqual([]);
  });

  test('a ridden bike and a driven boat stay drawn through tier cycles without growing memory, light up at night and come back after a lost context', async ({ page }) => {
    const errors = await boot(page);
    await newGame(page);
    const results: Array<Record<string, unknown>> = [];
    for (const kind of ['sportbike', 'speedboat']) {
      const r = await run<Record<string, unknown>>(page, `${SETUP}
        const R = g.game.renderer;
        if (g.sim.player.vehicle) g.sim.playerCtl.ejectPlayer(true);
        ${CLEAR}
        let v;
        if (args[1] === 'speedboat') {
          g.teleport(644, 466);
          await new Promise((r) => setTimeout(r, 2000));
          ${CLEAR}
          const b = g.sim.world.layout.props.find((p) => p.kind === 'boat');
          v = g.sim.spawnVehicle('speedboat', b.x + 13, b.z, 0.4);
          g.sim.seat(g.sim.player, v, 0);
        } else {
          const b = g.sim.world.layout.bounds;
          g.teleport(b.beachStartX + 40, (b.landMinZ + b.landMaxZ) / 2);
          await new Promise((r) => setTimeout(r, 2000));
          ${CLEAR}
          const id = g.spawnVehicle('sportbike', true);
          v = g.sim.vehicles.find((q) => q.id === id);
        }
        window.__cam = null;
        await new Promise((r) => setTimeout(r, 1500));
        const view = () => R.vehicleViews.get(v.id);
        const drawn = () => { const w = view(); let n = 0; w.group.traverse((o) => { if (o.isMesh && o.visible && !o.userData.batched && o.layers.mask === 1) n++; }); return w.group.visible && !w.fading ? n : 0; };
        const cycles = [];
        for (const tier of ['high', 'low', 'high', 'low', 'high']) {
          R.setQuality(tier);
          for (let k = 0; k < 30; k++) ${frame}
          const m = R.renderer.info.memory;
          cycles.push({ tier, geometries: m.geometries, textures: m.textures, drawn: drawn(), programs: g.state().render.programs });
        }
        g.setTime(23);
        for (let k = 0; k < 20; k++) ${frame}
        const glows = view().lampWorldPositions([]);
        const night = { lightsOn: view().lightsOn, glows };
        g.setTime(12);
        const ext = R.renderer.getContext().getExtension('WEBGL_lose_context');
        ext.loseContext();
        await new Promise((r) => setTimeout(r, 500));
        ext.restoreContext();
        const t0 = performance.now();
        while (g.game.contextLost && performance.now() - t0 < 4000) ${frame}
        for (let k = 0; k < 10; k++) ${frame}
        const back = (performance.now() - t0) / 1000;
        // The game comes back paused (Game.onContextRestored): drawn, with the world still.
        const drawnPaused = drawn();
        g.game.resume();
        for (let k = 0; k < 10; k++) ${frame}
        return { kind: args[1], cycles, night, back, drawnPaused, drawnAfter: drawn(), calls: g.state().render.calls, crashed: g.state().crashed };`, 12, kind);
      results.push(r);
    }
    for (const r of results) {
      const cycles = r.cycles as Array<{ tier: string; geometries: number; textures: number; drawn: number; programs: number }>;
      console.log(`[m3-bikes-boats] ${r.kind}: ${cycles.map((c) => `${c.tier} geo ${c.geometries} tex ${c.textures} meshes ${c.drawn} programs ${c.programs}`).join('; ')}; night ${JSON.stringify(r.night)}; drawn again ${(r.back as number).toFixed(2)} s after the restore (${r.drawnPaused} meshes paused, ${r.drawnAfter} resumed, ${r.calls} calls)`);
      for (const c of cycles) expect(c.drawn, `${r.kind} ${c.tier}`).toBeGreaterThanOrEqual(3);
      const warm = cycles[2]!;
      const last = cycles[4]!;
      expect(last.geometries).toBeLessThanOrEqual(warm.geometries * 1.03);
      expect(last.textures).toBeLessThanOrEqual(warm.textures * 1.03);
      const night = r.night as { lightsOn: boolean; glows: number };
      expect(night.lightsOn).toBe(true);
      expect(night.glows).toBeGreaterThanOrEqual(2);
      expect(r.back as number).toBeLessThanOrEqual(2);
      expect(r.drawnPaused as number).toBeGreaterThanOrEqual(3);
      expect(r.drawnAfter as number).toBeGreaterThanOrEqual(3);
      expect(r.calls as number).toBeGreaterThan(30);
      expect(r.crashed).toBe(false);
    }
    expect(errors).toEqual([]);
  });
});
