// The on-foot camera in motion: the player stands, walks, sprints, turns and stops on a Midtown sidewalk, looks with the
// far zoom, aims a pistol at someone near and far, backs up to a wall, walks under a shop's awning, stands in a doorway
// and between parked cars, walks through a crowd, and gets into a car, drives off and gets out again. The page logs ten
// times a second what the player sees: how tall he stands in the frame (crown to soles, a share of its height), whether
// his soles are in it, the camera's distance and field of view, and the people dissolving near the lens.
//
//   node scripts/playtest.mjs --script scripts/playtests/footcam.mjs --video --out /tmp/footcam
//   FOOTCAM_HOUR=22 FOOTCAM_SHORT=1 node scripts/playtest.mjs --script scripts/playtests/footcam.mjs --video --out /tmp/footcam-night
//
// report.json gets one note, "footcam <json>", with a summary per segment and the samples.

const HOUR = Number(process.env.FOOTCAM_HOUR ?? 11);
const SHORT = process.env.FOOTCAM_SHORT === '1';

/** Runs in the page: window.__fc, the sampler and the in-page helpers. */
export function install(g) {
  const sim = g.sim;
  const r = g.game.renderer;
  const cc = r.cameraCtl;
  const crowd = r.crowd;
  const key = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key', '').toLowerCase(), bubbles: true }));
  const geo = crowd.parts.head.mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const crownUp = geo.boundingBox.max.y;
  const V = cc.camera.position.constructor;
  const fc = {
    label: 'idle',
    samples: [],
    t0: performance.now(),
    /** Seconds from the page's start to t0: the video's time for a sample is about nav + t. */
    nav: +(performance.now() / 1000).toFixed(2),
    pan: 0,
    key,
    /** The head pivot drawn nearest the player's feet: his own. */
    neck() {
      const p = sim.player.pos;
      let best = null;
      let bd = Infinity;
      for (const h of crowd.drawnHeads()) {
        const d = Math.hypot(h.x - p.x, h.z - p.z);
        if (d < bd && h.y > p.y) {
          bd = d;
          best = h;
        }
      }
      return bd < 1.2 ? best : null;
    },
    sample() {
      const cam = cc.camera;
      cam.updateMatrixWorld();
      const p = sim.player;
      const n = fc.neck();
      const s = p.appearance.height;
      const crown = n ? new V(n.x, n.y + crownUp * s, n.z).project(cam) : null;
      const sole = new V(p.pos.x, p.pos.y, p.pos.z).project(cam);
      const head = n ? new V(n.x, n.y + 0.12 * s, n.z).project(cam) : null;
      const share = crown ? (crown.y - sole.y) / 2 : null;
      // The part of him inside the frame, and whether his soles are in it.
      const seen = crown ? (Math.min(1, crown.y) - Math.max(-1, sole.y)) / 2 : null;
      // The camera relative to him, in the view's frame: back, right and up (m).
      const fx = Math.sin(cc.yaw);
      const fz = Math.cos(cc.yaw);
      const dx = cam.position.x - p.pos.x;
      const dz = cam.position.z - p.pos.z;
      // People near the lens: their depth along the view (m) from the camera, in the dissolve band (0.45..0.9) or nearer.
      const dir = new V();
      cam.getWorldDirection(dir);
      let fading = 0;
      let near = 0;
      const depths = [];
      for (const c of sim.characters) {
        if (c === p || c.vehicle) continue;
        for (const y of [0.4, 1.0, 1.5]) {
          const z = (c.pos.x - cam.position.x) * dir.x + (c.pos.y + y - cam.position.y) * dir.y + (c.pos.z - cam.position.z) * dir.z;
          if (z > 0 && z < 0.9) {
            fading++;
            depths.push(+z.toFixed(2));
            break;
          }
        }
        if (Math.hypot(c.pos.x - cam.position.x, c.pos.z - cam.position.z) < 2.5) near++;
      }
      return {
        t: +((performance.now() - fc.t0) / 1000).toFixed(2),
        label: fc.label,
        state: p.state,
        speed: +(p.vehicle ? p.vehicle.speed : Math.hypot(p.vel.x, p.vel.z)).toFixed(2),
        inCar: !!p.vehicle,
        fov: +cam.fov.toFixed(1),
        camDist: n ? +Math.hypot(cam.position.x - n.x, cam.position.y - n.y, cam.position.z - n.z).toFixed(2) : null,
        back: +(-(dx * fx + dz * fz)).toFixed(2),
        right: +(dx * -fz + dz * fx).toFixed(2),
        up: +(cam.position.y - p.pos.y).toFixed(2),
        pitch: +cc.pitch.toFixed(3),
        share: share === null ? null : +share.toFixed(3),
        seen: seen === null ? null : +seen.toFixed(3),
        solesIn: sole.y > -1 && sole.y < 1,
        crownY: crown ? +crown.y.toFixed(3) : null,
        soleY: +sole.y.toFixed(3),
        headX: head ? +head.x.toFixed(3) : null,
        headY: head ? +head.y.toFixed(3) : null,
        fading,
        depths,
        near,
      };
    },
    /** Pans the view at `rate` rad/s (through look(), as the mouse does) until stopped with rate 0. */
    panAt(rate) {
      fc.pan = rate;
    },
    /** The first building wall within `len` m of (x, z) along (dx, dz), or null. */
    wall(x, z, dx, dz, len) {
      const hit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, collider: null };
      return sim.world.grid.raycast(x, sim.world.groundHeight(x, z) + 1, z, dx, 0, dz, len, hit, (c) => c.tag === 'building') ? { ...hit, collider: null } : null;
    },
    /** Puts the crosshair (rayFor) through `pt`: a few rounds of aiming from where the ray starts. */
    crosshairOn(pt) {
      for (let k = 0; k < 30; k++) {
        const ray = cc.rayFor();
        cc.yaw = Math.atan2(pt.x - ray.origin.x, pt.z - ray.origin.z);
        cc.pitch = Math.atan2(pt.y - ray.origin.y, Math.hypot(pt.x - ray.origin.x, pt.z - ray.origin.z));
      }
    },
    /**
     * Whether the player's figure covers `pt` on screen: his torso and head as a box 0.5 m wide from his hips to his crown,
     * projected; and the gap (px, + clear) between that box's right edge and pt.
     */
    covers(pt) {
      const cam = cc.camera;
      cam.updateMatrixWorld();
      const p = sim.player;
      const rx = -Math.cos(cc.yaw);
      const rz = Math.sin(cc.yaw);
      const n = fc.neck();
      const top = n ? n.y + crownUp * p.appearance.height : p.pos.y + 1.8;
      const pts = [];
      for (const s of [-0.28, 0.28]) for (const y of [p.pos.y + 0.9, top]) pts.push(new V(p.pos.x + rx * s, y, p.pos.z + rz * s).project(cam));
      const q = new V(pt.x, pt.y, pt.z).project(cam);
      const x0 = Math.min(...pts.map((a) => a.x));
      const x1 = Math.max(...pts.map((a) => a.x));
      const y0 = Math.min(...pts.map((a) => a.y));
      const y1 = Math.max(...pts.map((a) => a.y));
      return { covered: q.x > x0 && q.x < x1 && q.y > y0 && q.y < y1, gapPx: Math.round(((q.x - x1) / 2) * innerWidth), target: { x: +q.x.toFixed(3), y: +q.y.toFixed(3) } };
    },
  };
  // Every frame: where his head is on screen and how tall he stands (for the jolts from one frame to the next), and how
  // deep along the view each person near the lens is (for people dissolving in and out again).
  fc.frames = [];
  fc.crossings = [];
  const lastSide = new Map();
  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (fc.pan !== 0) cc.look((-fc.pan * dt) / (0.0024 * cc.sensitivity), 0);
    const p = sim.player;
    const cam = cc.camera;
    if (!p.vehicle && fc.label !== 'idle') {
      cam.updateMatrixWorld();
      const n = fc.neck();
      if (n) {
        const head = new V(n.x, n.y + 0.12 * p.appearance.height, n.z).project(cam);
        const sole = new V(p.pos.x, p.pos.y, p.pos.z).project(cam);
        fc.frames.push([+((now - fc.t0) / 1000).toFixed(3), fc.label, +head.x.toFixed(4), +head.y.toFixed(4), +((head.y - sole.y) / 2).toFixed(4), +cam.fov.toFixed(2)]);
      }
      const dir = new V();
      cam.getWorldDirection(dir);
      for (const c of sim.characters) {
        if (c === p || c.vehicle) continue;
        if (Math.hypot(c.pos.x - cam.position.x, c.pos.z - cam.position.z) > 3) continue;
        let z = Infinity;
        for (const y of [0.4, 1.0, 1.5]) z = Math.min(z, (c.pos.x - cam.position.x) * dir.x + (c.pos.y + y - cam.position.y) * dir.y + (c.pos.z - cam.position.z) * dir.z);
        const side = z < 0.9 && z > -0.3;
        if (lastSide.has(c.id) && lastSide.get(c.id) !== side) fc.crossings.push([+((now - fc.t0) / 1000).toFixed(3), fc.label, c.id, side]);
        lastSide.set(c.id, side);
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setInterval(() => fc.samples.push(fc.sample()), 100);
  window.__fc = fc;
}

const summary = (samples) => {
  const by = new Map();
  for (const s of samples) {
    if (!by.has(s.label)) by.set(s.label, []);
    by.get(s.label).push(s);
  }
  const out = [];
  for (const [label, list] of by) {
    const foot = list.filter((s) => !s.inCar && s.share !== null);
    const mean = (f, l = foot) => (l.length ? +(l.reduce((a, s) => a + f(s), 0) / l.length).toFixed(3) : null);
    const min = (f, l = foot) => (l.length ? +Math.min(...l.map(f)).toFixed(3) : null);
    const max = (f, l = foot) => (l.length ? +Math.max(...l.map(f)).toFixed(3) : null);
    // Flicker: how often the count of people in the dissolve band changes from one sample to the next.
    let flips = 0;
    for (let i = 1; i < list.length; i++) if (list[i].fading !== list[i - 1].fading) flips++;
    out.push({
      label,
      n: list.length,
      speed: mean((s) => s.speed, list),
      share: mean((s) => s.share),
      shareMin: min((s) => s.share),
      shareMax: max((s) => s.share),
      seen: mean((s) => s.seen),
      solesOut: foot.filter((s) => !s.solesIn).length,
      soleYMin: min((s) => s.soleY),
      crownYMax: max((s) => s.crownY),
      headX: mean((s) => s.headX),
      camDist: mean((s) => s.camDist, list.filter((s) => s.camDist !== null)),
      back: mean((s) => s.back, list),
      up: mean((s) => s.up, list),
      fov: mean((s) => s.fov, list),
      fadingMax: Math.max(0, ...list.map((s) => s.fading)),
      fadeFlips: flips,
    });
  }
  return out;
};

export default async function (t) {
  await t.boot();
  await t.newGame();
  await t.game((g, hour) => {
    g.godMode(true);
    g.setClockRate(0);
    g.setTime(hour);
    const sim = g.sim;
    sim.ambient = false;
    for (const c of [...sim.characters]) if (!c.isPlayer && !c.vehicle) sim.removeCharacter(c);
    for (const v of [...sim.vehicles]) if (!v.usedByPlayer) sim.removeVehicle(v);
    // A Midtown sidewalk, looking north along it.
    const n = sim.roads.node(7, 3);
    g.teleport(n.x + n.halfX + 2.2, n.z + n.halfZ + 6);
    sim.player.heading = 0;
    g.setCamera(0, -0.12);
  }, HOUR);
  await t.page.evaluate(`(${install.toString()})(window.__gta7)`);
  const label = (s) => t.game((g, s) => (window.__fc.label = s), s);
  const key = (code, down) => t.game((g, c, d) => window.__fc.key(c, d), code, down);
  const pan = (rate) => t.game((g, r) => window.__fc.panAt(r), rate);
  const results = { hour: HOUR, notes: [] };
  await t.wait(2500);

  // At rest, then the far zoom.
  await label('rest');
  await t.wait(1500);
  await t.shot('rest');
  await label('rest-far');
  await t.press('KeyV');
  await t.wait(1500);
  await t.shot('rest-far');
  await t.press('KeyV');
  await label('far-back');
  await t.wait(1000);

  // Walk, sprint, stop: along the sidewalk.
  await label('walk');
  await key('KeyW', true);
  await t.wait(1500);
  await t.shot('walk');
  await t.wait(1000);
  await label('sprint');
  await key('ShiftLeft', true);
  await t.wait(1500);
  await t.shot('sprint');
  await t.wait(1000);
  await key('ShiftLeft', false);
  await key('KeyW', false);
  await label('stop');
  await t.wait(400);
  await t.shot('stop');
  await t.wait(1200);
  // Turning: the view pans 90 degrees a second as he walks, then he walks on round a bend.
  await label('walk-pan');
  await key('KeyW', true);
  await pan(1.6);
  await t.wait(1000);
  await t.shot('walk-pan');
  await t.wait(500);
  await pan(0);
  await label('walk-bend');
  await key('KeyD', true);
  await t.wait(1200);
  await t.shot('walk-bend');
  await key('KeyD', false);
  await label('sprint-pan');
  await key('ShiftLeft', true);
  await pan(-1.6);
  await t.wait(1200);
  await t.shot('sprint-pan');
  await pan(0);
  await key('ShiftLeft', false);
  await key('KeyW', false);
  await label('stop2');
  await t.wait(1200);
  // Back toward the camera.
  await label('walk-back');
  await key('KeyS', true);
  await t.wait(1200);
  await t.shot('walk-back');
  await key('KeyS', false);
  await label('idle');
  await t.wait(800);

  // A pistol: someone 9 m ahead, then someone 3 m ahead, aimed at over the shoulder and shot.
  const aimAt = async (dist, name) => {
    const setup = await t.game((g, dist) => {
      const sim = g.sim;
      const p = sim.player;
      g.setCamera(0, -0.05);
      g.teleport(sim.roads.node(7, 3).x + sim.roads.node(7, 3).halfX + 2.2, sim.roads.node(7, 3).z + sim.roads.node(7, 3).halfZ + 6);
      p.heading = 0;
      g.setCamera(0, -0.05);
      const c = sim.spawnCharacter('civilian', p.pos.x + 0.4, p.pos.z + dist, { skin: 0xe0ac69, shirt: 0xc0392b, pants: 0x2c3e50, hair: 0x3b2a1a, hat: 0, height: 1.0, build: 1.0 });
      c.heading = Math.PI;
      c.owner = 'mission';
      c.persistent = true;
      window.__target = c.id;
      return c.id;
    }, dist);
    await t.wait(900);
    await label(`aim-${name}`);
    await t.page.mouse.move(800, 450);
    await t.page.mouse.down({ button: 'right' });
    await t.wait(900);
    const before = await t.game((g) => {
      const c = g.sim.characters.find((o) => o.id === window.__target);
      const chest = { x: c.pos.x, y: c.pos.y + 1.15, z: c.pos.z };
      window.__fc.crosshairOn(chest);
      return { health: c.health };
    });
    await t.wait(150);
    await t.game((g) => {
      const c = g.sim.characters.find((o) => o.id === window.__target);
      window.__fc.crosshairOn({ x: c.pos.x, y: c.pos.y + 1.15, z: c.pos.z });
    });
    const cover = await t.game((g) => {
      const c = g.sim.characters.find((o) => o.id === window.__target);
      return window.__fc.covers({ x: c.pos.x, y: c.pos.y + 1.15, z: c.pos.z });
    });
    await t.shot(`aim-${name}`);
    await t.page.mouse.down({ button: 'left' });
    await t.wait(80);
    await t.page.mouse.up({ button: 'left' });
    await t.wait(400);
    const after = await t.game((g) => {
      const c = g.sim.characters.find((o) => o.id === window.__target);
      return { health: c ? c.health : 0 };
    });
    await t.page.mouse.up({ button: 'right' });
    results.notes.push({ aim: name, dist, setup, hit: after.health < before.health, before: before.health, after: after.health, ...cover });
    await t.game((g) => {
      const sim = g.sim;
      const c = sim.characters.find((o) => o.id === window.__target);
      if (c) sim.removeCharacter(c);
    });
    await label('idle');
    await t.wait(600);
  };
  await t.game((g) => g.give('pistol', 120));
  await t.wait(600);
  await aimAt(9, 'far');
  await aimAt(3, 'near');
  await t.game((g) => (g.sim.player.inventory.current = 'fists'));

  if (!SHORT) {
    // His back to a wall: the nearest building face east of the sidewalk, him 0.5 m off it facing west; then a pan
    // along it.
    const wall = await t.game((g) => {
      const sim = g.sim;
      const n = sim.roads.node(7, 3);
      const x = n.x + n.halfX + 2.2;
      const z = n.z + n.halfZ + 20;
      const w = window.__fc.wall(x, z, 1, 0, 30);
      if (!w) return null;
      g.teleport(w.x - 0.55, z);
      sim.player.heading = -Math.PI / 2;
      g.setCamera(-Math.PI / 2, -0.12);
      return { x: w.x, z };
    });
    results.notes.push({ wall });
    await t.wait(1500);
    await label('wall-back');
    await t.wait(1000);
    await t.shot('wall-back');
    await label('wall-pan');
    await pan(0.8);
    await t.wait(1200);
    await t.shot('wall-pan');
    await pan(0);
    await t.wait(600);
    // Walking backwards into it from 3 m out.
    await t.game((g, w) => {
      g.teleport(w.x - 3, w.z);
      g.sim.player.heading = -Math.PI / 2;
      g.setCamera(-Math.PI / 2, -0.12);
    }, wall);
    await t.wait(1200);
    await label('wall-backup');
    await key('KeyS', true);
    await t.wait(1400);
    await t.shot('wall-backup');
    await key('KeyS', false);
    await t.wait(800);

    // Under an awning: the shop front with one nearest the start, walking along under it.
    const awn = await t.game((g) => {
      const sim = g.sim;
      const p = sim.player.pos;
      let best = null;
      let bd = Infinity;
      for (const f of g.game.renderer.city.storefronts.values()) {
        if (f.awning === 'none') continue;
        const d = Math.hypot(f.x - p.x, f.z - p.z);
        if (d < bd) {
          bd = d;
          best = f;
        }
      }
      if (!best) return null;
      // Out from the wall: the side faces N (+z?), S, E or W.
      const out = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[best.side];
      // Which way out is: try both and keep the side the wall is not on.
      const probe = (sx) => window.__fc.wall(best.x + out[0] * sx * 0.8, best.z + out[1] * sx * 0.8, -out[0] * sx, -out[1] * sx, 2);
      const s = probe(1) ? 1 : -1;
      const ox = out[0] * s;
      const oz = out[1] * s;
      const along = Math.atan2(-oz, ox);
      g.teleport(best.x + ox * 0.7 - Math.sin(along) * 4, best.z + oz * 0.7 - Math.cos(along) * 4);
      sim.player.heading = along;
      g.setCamera(along, -0.12);
      return { x: best.x, z: best.z, side: best.side, style: best.awning, out: [ox, oz], along };
    });
    results.notes.push({ awning: awn });
    await t.wait(1500);
    await label('awning-rest');
    await t.wait(600);
    await t.shot('awning-rest');
    await label('awning-walk');
    await key('KeyW', true);
    await t.wait(1400);
    await t.shot('awning-walk');
    await key('KeyW', false);
    // Facing out from under it, the camera at the shop window.
    await t.game((g, a) => {
      const sim = g.sim;
      g.teleport(a.x + a.out[0] * 0.9, a.z + a.out[1] * 0.9);
      const yaw = Math.atan2(a.out[0], a.out[1]);
      sim.player.heading = yaw;
      g.setCamera(yaw, -0.12);
    }, awn);
    await t.wait(1200);
    await label('awning-out');
    await t.wait(600);
    await t.shot('awning-out');

    // In a doorway: the bank's entrance, facing out of it.
    const door = await t.game((g) => {
      const sim = g.sim;
      const b = g.poi('bank');
      let best = null;
      let bd = Infinity;
      for (const e of g.game.renderer.city.entrances.values()) {
        const d = Math.hypot(e.x - b.x, e.z - b.z);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      const e = best ?? b;
      const out = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] }[best?.side ?? 'W'];
      const s = window.__fc.wall(e.x + out[0] * 1.5, e.z + out[1] * 1.5, -out[0], -out[1], 3) ? 1 : -1;
      const ox = out[0] * s;
      const oz = out[1] * s;
      g.teleport(e.x + ox * 0.6, e.z + oz * 0.6);
      const yaw = Math.atan2(ox, oz);
      sim.player.heading = yaw;
      g.setCamera(yaw, -0.12);
      return { x: e.x, z: e.z, side: best?.side, out: [ox, oz] };
    });
    results.notes.push({ door });
    await t.wait(1500);
    await label('doorway');
    await t.wait(800);
    await t.shot('doorway');
    await label('doorway-walk');
    await key('KeyW', true);
    await t.wait(1200);
    await key('KeyW', false);

    // Between parked cars: two sedans 2.6 m apart side by side, him between their front wheels, then a pan into one.
    await t.game((g) => {
      const sim = g.sim;
      const n = sim.roads.node(7, 3);
      const x = n.x + n.halfX + 2.2;
      const z = n.z + n.halfZ + 30;
      g.teleport(x, z);
      const fx = x - 4.6;
      for (const s of [-1, 1]) {
        const v = sim.spawnVehicle('sedan', fx + s * 1.5, z + 1, 0, 0x8a9aa8);
        v.persistent = true;
      }
      g.teleport(fx, z - 3);
      sim.player.heading = 0;
      g.setCamera(0, -0.12);
    });
    await t.wait(1500);
    await label('cars-walk');
    await key('KeyW', true);
    await t.wait(1300);
    await key('KeyW', false);
    await label('cars-between');
    await t.wait(600);
    await t.shot('cars-between');
    await label('cars-pan');
    await pan(1.2);
    await t.wait(1300);
    await t.shot('cars-pan');
    await pan(0);
    await t.wait(500);

    // A crowd: a dozen people milling round him, the view panning slowly.
    await t.game((g) => {
      const sim = g.sim;
      for (const v of [...sim.vehicles]) if (!v.usedByPlayer) sim.removeVehicle(v);
      const n = sim.roads.node(7, 3);
      const x = n.x + n.halfX + 2.2;
      const z = n.z + n.halfZ + 6;
      g.teleport(x, z);
      sim.player.heading = 0;
      g.setCamera(0, -0.12);
      window.__crowd = [];
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const r = 1.2 + (i % 4) * 0.8;
        const c = sim.spawnCharacter('civilian', x + Math.sin(a) * r, z + Math.cos(a) * r);
        window.__crowd.push(c.id);
      }
    });
    await t.wait(1200);
    await label('crowd');
    await pan(0.35);
    await t.wait(3500);
    await t.shot('crowd');
    await pan(0);
    await label('crowd-walk');
    await key('KeyW', true);
    await t.wait(2000);
    await key('KeyW', false);
    await t.game((g) => {
      const sim = g.sim;
      for (const c of [...sim.characters]) if (window.__crowd.includes(c.id)) sim.removeCharacter(c);
    });
  }

  // Into a car parked beside him, a short drive, out again.
  await t.game((g) => {
    const sim = g.sim;
    const n = sim.roads.node(7, 3);
    const x = n.x + n.halfX + 2.2;
    const z = n.z + n.halfZ + 10;
    g.teleport(x, z);
    const lane = sim.roads.nearestLane(x, z).lane;
    const s = Math.max(5, Math.min(lane.length - 5, (x - lane.sx) * lane.dx + (z - lane.sz) * lane.dz));
    const v = sim.spawnVehicle('sedan', lane.sx + lane.dx * s, lane.sz + lane.dz * s, lane.heading, 0x2e6b8f);
    v.persistent = true;
    // Him a step off its left side, by the driver's door, the view on the car.
    const lx = Math.cos(v.heading);
    const lz = -Math.sin(v.heading);
    const side = (x - v.pos.x) * lx + (z - v.pos.z) * lz > 0 ? 1 : -1;
    g.teleport(v.pos.x + lx * side * (v.halfW + 1.2), v.pos.z + lz * side * (v.halfW + 1.2));
    const p = sim.player.pos;
    const yaw = Math.atan2(v.pos.x - p.x, v.pos.z - p.z) + 0.5;
    sim.player.heading = yaw;
    g.setCamera(yaw, -0.12);
  });
  await t.wait(1200);
  await label('to-car');
  await t.press('KeyF');
  await t.wait(500);
  await t.shot('entering');
  await t.wait(1500);
  await label('in-car');
  await t.shot('in-car');
  await key('KeyW', true);
  await t.wait(2500);
  await key('KeyW', false);
  await key('KeyS', true);
  await t.wait(1500);
  await key('KeyS', false);
  await t.wait(1200);
  await label('exit-car');
  await t.press('KeyF');
  await t.wait(400);
  await t.shot('exiting');
  await t.wait(1600);
  await t.shot('out');
  await label('after-car');
  await t.wait(1200);

  const samples = await t.game(() => window.__fc.samples);
  results.segments = summary(samples);
  results.nav = await t.game(() => window.__fc.nav);
  // Motion per segment: the frame-to-frame jolt of his head on screen (the second difference, in % of the frame's height,
  // 95th percentile and worst), and people dissolving and coming back within a quarter second.
  const frames = await t.game(() => window.__fc.frames);
  const crossings = await t.game(() => window.__fc.crossings);
  const motion = {};
  for (let i = 2; i < frames.length; i++) {
    const [, l] = frames[i];
    if (frames[i - 1][1] !== l || frames[i - 2][1] !== l) continue;
    const jx = Math.abs(frames[i][2] - 2 * frames[i - 1][2] + frames[i - 2][2]) * 50;
    const jy = Math.abs(frames[i][3] - 2 * frames[i - 1][3] + frames[i - 2][3]) * 50;
    (motion[l] ??= { jolts: [], flick: 0, crossings: 0 }).jolts.push(Math.hypot(jx, jy));
  }
  const lastCross = new Map();
  for (const [tm, l, id] of crossings) {
    const m = (motion[l] ??= { jolts: [], flick: 0, crossings: 0 });
    m.crossings++;
    if (lastCross.has(id) && tm - lastCross.get(id) < 0.25) m.flick++;
    lastCross.set(id, tm);
  }
  results.motion = Object.entries(motion).map(([label, m]) => {
    const j = m.jolts.sort((a, b) => a - b);
    return { label, frames: j.length, jolt95: j.length ? +j[Math.floor(j.length * 0.95)].toFixed(3) : null, joltMax: j.length ? +j[j.length - 1].toFixed(3) : null, crossings: m.crossings, flick: m.flick };
  });
  console.table(results.motion);
  results.samples = samples;
  await t.snap('end');
  t.note('footcam ' + JSON.stringify(results));
  console.table(results.segments);
  console.log(JSON.stringify(results.notes));
}
