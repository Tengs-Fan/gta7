#!/usr/bin/env node
// Scripted playtests against a running build of the game (npm run build && npm run preview).
//
//   node scripts/playtest.mjs --scenario tour --out /tmp/shots
//   node scripts/playtest.mjs --script my-steps.mjs --out /tmp/shots --url http://localhost:4173/
//
// A scenario or script drives the real game through window.__gta7 and real keyboard/mouse input,
// saves screenshots to --out and writes --out/report.json (console errors, state snapshots and
// per-segment performance). Built-in scenarios: tour, drive, chase, night, perf. A custom --script
// is an ES module exporting `default async function (t)`, where `t` is the helper object below.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const url = opt('url', `http://localhost:${opt('port', '4173')}/`);
const out = resolve(opt('out', '/tmp/gta7-playtest'));
const scenario = opt('scenario', opt('script') ? null : 'tour');
const scriptPath = opt('script', null);
const [vw, vh] = opt('size', '1600x900').split('x').map(Number);
const software = flag('swiftshader') || process.env.GTA7_SWIFTSHADER === '1';

mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: !flag('headed'),
  args: software
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required']
    : ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: vw, height: vh } });
// Headless Chromium that grants pointer lock can stop delivering frames and grow without bound,
// so automated runs refuse the lock (clicks then shoot unlocked); --pointer-lock opts back in.
if (!flag('pointer-lock')) {
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = function () {
      throw new DOMException('pointer lock disabled under automation', 'NotSupportedError');
    };
  });
}
const IGNORED = [/GPU stall due to ReadPixels/i, /requestPointerLock/i, /pointer lock/i];
const report = { url, scenario: scenario ?? scriptPath, errors: [], shots: [], snapshots: [], segments: [], notes: [] };
page.on('console', (m) => {
  if ((m.type() === 'error' || m.type() === 'warning') && !IGNORED.some((r) => r.test(m.text()))) report.errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => report.errors.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

/** Helpers handed to scenarios and custom scripts. */
const t = {
  page,
  out,
  /** Runs fn(g) in the page, where g = window.__gta7; extra args are passed after g. */
  game: (fn, ...args) => page.evaluate(([src, a]) => new Function('g', 'args', `return (${src})(g, ...args)`)(window.__gta7, a), [fn.toString(), args]),
  wait: (ms) => page.waitForTimeout(ms),
  state: () => page.evaluate(() => window.__gta7.state()),
  async shot(name) {
    const path = `${out}/${String(report.shots.length).padStart(2, '0')}-${name}.png`;
    await page.screenshot({ path });
    report.shots.push(path);
    return path;
  },
  async snap(label) {
    const s = await t.state();
    report.snapshots.push({ label, ...s });
    return s;
  },
  note: (text) => report.notes.push(text),
  async hold(key, ms) {
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
  },
  press: (key) => page.keyboard.press(key),
  /** Measures fps and frame cost over `ms` of real play. */
  async measure(label, ms = 4000) {
    const before = await page.evaluate(() => ({ f: window.__gta7.state().frames, t: performance.now() }));
    await page.waitForTimeout(ms);
    const after = await page.evaluate(() => {
      const s = window.__gta7.state();
      const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
      return { f: s.frames, t: performance.now(), render: s.render, perf: s.perf, heapMB: mem, vehicles: s.vehicles, characters: s.characters };
    });
    const seg = { label, fps: Math.round(((after.f - before.f) * 1000) / (after.t - before.t)), ...after };
    delete seg.f;
    delete seg.t;
    report.segments.push(seg);
    return seg;
  },
  async boot() {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__gta7 && window.__gta7.state().frames > 20, null, { timeout: 90_000 });
  },
  async newGame() {
    await page.click('button[data-id="new"]');
    await page.waitForFunction(() => window.__gta7.state().mode === 'game');
    await page.waitForTimeout(600);
  },
};

const SCENARIOS = {
  /** A fixed photo tour: title, streets, peds, traffic, a car, the beach at sunset, night, map, pause. */
  async tour() {
    await t.boot();
    await t.shot('title');
    await t.newGame();
    await t.game((g) => g.godMode(true));
    await t.shot('start');
    await t.snap('start');
    await t.game((g) => {
      g.setTime(11);
      const n = g.sim.roads.node(4, 4);
      g.teleport(n.x + n.halfX + 2.2, n.z + n.halfZ + 9);
      g.setCamera(0, -0.15);
    });
    await t.wait(3500);
    await t.shot('downtown-noon');
    await t.game((g) => {
      g.setTime(12.5);
      const n = g.sim.roads.node(7, 3);
      g.teleport(n.x + n.halfX + 2.2, n.z + n.halfZ + 14);
      g.setCamera(Math.PI, -0.2);
    });
    await t.wait(4000);
    await t.shot('midtown-sidewalk');
    await t.game((g) => g.setCamera(-Math.PI / 2, -0.12));
    await t.wait(1500);
    await t.shot('midtown-traffic');
    await t.game((g) => {
      g.spawnVehicle('sports', true);
      g.game.renderer.cameraCtl.look(-650, 0);
    });
    await t.wait(1200);
    await t.shot('car-side');
    await t.game((g) => {
      g.setTime(18.6);
      const b = g.sim.world.layout.bounds;
      if (g.sim.player.vehicle) g.sim.playerCtl.ejectPlayer(true);
      g.teleport(b.beachStartX + 12, 20);
      g.setCamera(Math.PI / 2, 0.02);
    });
    await t.wait(2500);
    await t.shot('beach-sunset');
    await t.game((g) => {
      g.setTime(22.5);
      const n = g.sim.roads.node(5, 5);
      g.teleport(n.x + n.halfX + 2.2, n.z + n.halfZ + 9);
      g.setCamera(0.4, -0.1);
    });
    await t.wait(3000);
    await t.shot('downtown-night');
    await t.press('KeyM');
    await t.wait(600);
    await t.shot('map');
    await t.press('KeyM');
    await t.wait(300);
    await t.press('Escape');
    await t.wait(400);
    await t.shot('pause');
    await t.press('Escape');
    await t.snap('end');
  },
  /** Steal a car and drive with real keys, steering through a few turns. */
  async drive() {
    await t.boot();
    await t.newGame();
    await t.game((g) => {
      g.godMode(true);
      g.setTime(10);
      g.spawnVehicle('sedan', true);
    });
    await t.wait(500);
    await t.page.keyboard.down('KeyW');
    for (let i = 0; i < 6; i++) {
      await t.wait(1500);
      await t.shot(`drive-${i}`);
      await t.hold(i % 2 ? 'KeyA' : 'KeyD', 500);
    }
    await t.page.keyboard.up('KeyW');
    await t.measure('drive', 3000);
    await t.snap('end');
  },
  /** Three stars in a fast car: police pursuit, roadblocks and the helicopter. */
  async chase() {
    await t.boot();
    await t.newGame();
    await t.game((g) => {
      g.godMode(true);
      g.setTime(20.3);
      g.spawnVehicle('sports', true);
      g.setWanted(3);
    });
    await t.page.keyboard.down('KeyW');
    for (let i = 0; i < 5; i++) {
      await t.wait(2000);
      await t.shot(`chase-${i}`);
      await t.hold(i % 2 ? 'KeyA' : 'KeyD', 400);
    }
    await t.page.keyboard.up('KeyW');
    await t.measure('chase', 4000);
    await t.snap('end');
  },
  /** Night walk and drive for lighting. */
  async night() {
    await t.boot();
    await t.newGame();
    for (const [i, h] of [21, 23.5, 2, 5.6].entries()) {
      await t.game((g, hours, k) => {
        g.godMode(true);
        g.setTime(hours);
        const n = g.sim.roads.node(2 + k * 2, 3 + k);
        g.teleport(n.x + n.halfX + 2.2, n.z + n.halfZ + 9);
        g.setCamera(k * 1.3, -0.08);
      }, h, i);
      await t.wait(2500);
      await t.shot(`night-${h}`);
    }
    await t.snap('end');
  },
  /** Frame rate in a few demanding places; prints a table. */
  async perf() {
    await t.boot();
    await t.newGame();
    await t.game((g) => g.godMode(true));
    await t.measure('start', 4000);
    await t.game((g) => {
      const n = g.sim.roads.node(4, 4);
      g.teleport(n.x + n.halfX + 2.2, n.z + n.halfZ + 9);
    });
    await t.wait(1500);
    await t.measure('downtown', 5000);
    await t.game((g) => {
      g.spawnVehicle('sports', true);
      g.setWanted(4);
    });
    await t.page.keyboard.down('KeyW');
    await t.measure('pursuit-4-stars', 6000);
    await t.page.keyboard.up('KeyW');
    await t.game((g) => {
      g.setTime(19);
      const b = g.sim.world.layout.bounds;
      g.teleport(b.beachStartX + 12, 20);
    });
    await t.wait(1500);
    await t.measure('beach-dusk', 4000);
    console.table(report.segments.map((s) => ({ label: s.label, fps: s.fps, calls: s.render?.calls, tris: s.render?.triangles, heapMB: s.heapMB })));
  },
};

let failed = false;
try {
  if (scriptPath) {
    const mod = await import(pathToFileURL(resolve(scriptPath)).href);
    await mod.default(t);
  } else {
    if (!SCENARIOS[scenario]) throw new Error(`unknown scenario "${scenario}" (have: ${Object.keys(SCENARIOS).join(', ')})`);
    await SCENARIOS[scenario]();
  }
} catch (e) {
  failed = true;
  report.errors.push(`[playtest] ${e?.stack ?? e}`);
  try {
    await t.shot('failure');
  } catch {
    // The page may be gone.
  }
}
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
await browser.close();
console.log(`${report.shots.length} screenshots, ${report.errors.length} console errors -> ${out}/report.json`);
if (report.errors.length) console.log(report.errors.slice(0, 20).join('\n'));
process.exit(failed ? 1 : 0);
