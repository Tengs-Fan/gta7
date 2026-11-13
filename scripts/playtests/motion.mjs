// A motion check: an autopilot drives the player's car along the roads for a cruise and a three-star chase, and the page
// logs what a player would see ten times a second (speed, the camera's distance and field of view, how wide the car is on
// screen, the cars and people in view, the police). With --video the whole run is recorded.
//
//   node scripts/playtest.mjs --script scripts/playtests/motion.mjs --video --out /tmp/motion
//   MOTION_HOUR=22 node scripts/playtest.mjs --script scripts/playtests/motion.mjs --video --out /tmp/motion-night
//
// report.json gets one note, "motion <json>", with a summary per segment and the samples.

/** Runs in the page: installs window.__auto, a pure-pursuit driver that presses the real keys. */
export function install(g) {
  const sim = g.sim;
  const roads = sim.roads;
  const key = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key', '').toLowerCase(), bubbles: true }));
  const held = { KeyW: false, KeyS: false, KeyA: false, KeyD: false, Space: false };
  const set = (code, on) => {
    if (held[code] !== on) {
      held[code] = on;
      key(code, on);
    }
  };
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const auto = {
    on: false,
    cruise: 26,
    corner: 9,
    /** +1 when the D key raises the heading, -1 when it lowers it: found by calibrate(). */
    sign: 0,
    /** Brake for people on foot in the way (off: the motion check's careless driver, who only minds cars). */
    people: false,
    path: [],
    at: 0,
    samples: [],
    t0: 0,
    stuck: 0,
    unstick: 0,
    release() {
      for (const c of Object.keys(held)) set(c, false);
    },
    /** A path of points 6 m apart along the lanes from the car through the nodes of `via` in turn. */
    plan(via) {
      const v = sim.player.vehicle;
      let { lane } = roads.nearestLane(v.pos.x, v.pos.z, v.heading);
      const pts = [];
      const line = (x0, z0, x1, z1) => {
        const d = Math.hypot(x1 - x0, z1 - z0);
        const n = Math.max(1, Math.round(d / 6));
        for (let i = 1; i <= n; i++) pts.push({ x: x0 + ((x1 - x0) * i) / n, z: z0 + ((z1 - z0) * i) / n });
      };
      pts.push({ x: lane.sx, z: lane.sz });
      line(lane.sx, lane.sz, lane.ex, lane.ez);
      for (const goal of via) {
        for (let guard = 0; guard < 200 && lane.to !== goal; guard++) {
          const route = roads.findRoute(lane.to, goal, lane.from) ?? roads.findRoute(lane.to, goal);
          if (!route || route.length < 2) break;
          const next = route[1];
          const turn = lane.turns.find((t) => t.to.to === next && t.legal) ?? lane.turns.find((t) => t.to.to === next) ?? lane.turns[0];
          if (!turn) break;
          for (let i = 0; i < turn.pts.length; i += 2) pts.push({ x: turn.pts[i], z: turn.pts[i + 1] });
          lane = turn.to;
          line(lane.sx, lane.sz, lane.ex, lane.ez);
        }
      }
      // Drop points that all but repeat the one before (a turn's first point is its lane's last).
      const path = [];
      for (const q of pts) {
        const last = path[path.length - 1];
        if (!last || Math.hypot(q.x - last.x, q.z - last.z) > 1.5) path.push(q);
      }
      // How far the path turns over the 20 m after each point (its heading 3 m on against 20 m on), for the speed plan.
      const headingAt = (i, span) => {
        let j = i;
        let d = 0;
        while (j < path.length - 1 && d < span) {
          d += Math.hypot(path[j + 1].x - path[j].x, path[j + 1].z - path[j].z);
          j++;
        }
        const a = path[Math.max(0, j - 1)];
        const b = path[j];
        return Math.atan2(b.x - a.x, b.z - a.z);
      };
      for (let i = 0; i < path.length; i++) path[i].bend = Math.abs(wrap(headingAt(i, 20) - headingAt(i, 3)));
      pts.length = 0;
      pts.push(...path);
      auto.path = pts;
      auto.at = 0;
    },
    step() {
      const v = sim.player.vehicle;
      if (!auto.on || !v || auto.path.length === 0) return;
      const p = auto.path;
      // The nearest point of the path, looking a little way on from the last one.
      let best = auto.at;
      let bestD = Infinity;
      for (let i = auto.at; i < Math.min(p.length, auto.at + 14); i++) {
        const d = (p[i].x - v.pos.x) ** 2 + (p[i].z - v.pos.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      auto.at = best;
      const speed = Math.hypot(v.vel.x, v.vel.z);
      const ahead = Math.min(p.length - 1, best + Math.max(2, Math.round((7 + speed * 0.45) / 5)));
      const fx = Math.sin(v.heading);
      const fz = Math.cos(v.heading);
      // A car in the way in the next stretch: aim a lane's width to its side.
      let tx = p[ahead].x;
      let tz = p[ahead].z;
      const reach = 10 + speed * 0.9;
      let blocked = false;
      for (const o of sim.vehicles) {
        if (o === v) continue;
        const dx = o.pos.x - v.pos.x;
        const dz = o.pos.z - v.pos.z;
        const along = dx * fx + dz * fz;
        const side = dx * fz - dz * fx;
        if (along > 2 && along < reach && Math.abs(side) < 1.9) {
          const rel = speed - (o.vel.x * fx + o.vel.z * fz);
          if (rel > 2) {
            const s = side >= 0 ? -1 : 1;
            tx = o.pos.x + fz * s * 3.4 + fx * 4;
            tz = o.pos.z - fx * s * 3.4 + fz * 4;
            blocked = along < 6 + speed * 0.25;
          }
        }
      }
      // Somebody on foot in the way: brake for him, as a driver does (with auto.people off, the careless one this was).
      let waiting = false;
      if (auto.people) {
        const stop = 5 + speed * 0.7;
        for (const c of sim.characters) {
          if (c === sim.player || c.vehicle || !c.alive) continue;
          const dx = c.pos.x - v.pos.x;
          const dz = c.pos.z - v.pos.z;
          const along = dx * fx + dz * fz;
          if (along > 1.5 && along < stop && Math.abs(dx * fz - dz * fx) < 1.7) waiting = true;
        }
      }
      const err = wrap(Math.atan2(tx - v.pos.x, tz - v.pos.z) - v.heading) * auto.sign;
      // Slow for the sharpest bend within braking distance.
      let want = auto.cruise;
      const brakeDist = Math.max(0, speed * speed - auto.corner * auto.corner) / (2 * 13) + 14;
      for (let i = best, d = 0; i < p.length - 1 && d < brakeDist; i++) {
        if (p[i].bend > 0.5) want = Math.min(want, auto.corner);
        d += Math.hypot(p[i + 1].x - p[i].x, p[i + 1].z - p[i].z);
      }
      if (blocked) want = Math.min(want, 6);
      if (waiting) want = 0;
      if (best >= p.length - 3) want = 0;
      // Wedged against something: back out for a moment, steering the other way.
      if (auto.unstick > 0) {
        auto.unstick--;
        set('KeyW', false);
        set('KeyS', true);
        set('KeyD', err < 0);
        set('KeyA', err > 0);
        return;
      }
      auto.stuck = speed < 0.8 && want > 2 ? auto.stuck + 1 : 0;
      if (auto.stuck > 45) {
        auto.stuck = 0;
        auto.unstick = 40;
        auto.jams = (auto.jams ?? 0) + 1;
      }
      set('KeyW', speed < want);
      set('KeyS', speed > want + 3);
      set('KeyD', err > 0.05);
      set('KeyA', err < -0.05);
    },
    /** What a player sees right now. */
    sample() {
      const cam = g.game.renderer.cameraCtl.camera;
      const v = sim.player.vehicle;
      const me = v ? v.pos : sim.player.pos;
      const project = (x, y, z) => {
        const q = new cam.position.constructor(x, y, z).project(cam);
        return q;
      };
      const seen = (x, y, z, far) => {
        const d = Math.hypot(x - me.x, z - me.z);
        if (d > far) return false;
        const q = project(x, y, z);
        return q.z < 1 && Math.abs(q.x) < 1 && Math.abs(q.y) < 1;
      };
      let cars80 = 0;
      let carsSeen = 0;
      let parked = 0;
      let police = 0;
      let nearestPolice = Infinity;
      for (const o of sim.vehicles) {
        if (o === v) continue;
        const d = Math.hypot(o.pos.x - me.x, o.pos.z - me.z);
        if (d < 80) cars80++;
        if (seen(o.pos.x, 0.8, o.pos.z, 150)) carsSeen++;
        if (!o.driver && d < 80) parked++;
        if (o.owner === 'police') {
          police++;
          nearestPolice = Math.min(nearestPolice, d);
        }
      }
      let peds80 = 0;
      let pedsSeen = 0;
      for (const c of sim.characters) {
        if (c === sim.player || c.vehicle) continue;
        const d = Math.hypot(c.pos.x - me.x, c.pos.z - me.z);
        if (d < 80) peds80++;
        if (seen(c.pos.x, 1, c.pos.z, 80)) pedsSeen++;
      }
      let carPx = 0;
      if (v) {
        const rx = Math.cos(v.heading);
        const rz = -Math.sin(v.heading);
        const a = project(v.pos.x - rx * v.halfW, v.pos.y + 0.5, v.pos.z - rz * v.halfW);
        const b = project(v.pos.x + rx * v.halfW, v.pos.y + 0.5, v.pos.z + rz * v.halfW);
        carPx = Math.round((Math.abs(a.x - b.x) / 2) * innerWidth);
      }
      const speed = v ? Math.hypot(v.vel.x, v.vel.z) : sim.player.speed;
      return {
        t: +((performance.now() - auto.t0) / 1000).toFixed(2),
        speed: +speed.toFixed(1),
        camDist: +Math.hypot(cam.position.x - me.x, cam.position.y - me.y, cam.position.z - me.z).toFixed(2),
        camUp: +(cam.position.y - me.y).toFixed(2),
        fov: +cam.fov.toFixed(1),
        carPx,
        cars80,
        carsSeen,
        parked,
        peds80,
        pedsSeen,
        police,
        nearestPolice: Number.isFinite(nearestPolice) ? Math.round(nearestPolice) : null,
        wanted: sim.wanted.level,
        health: v ? Math.round(v.health) : null,
        player: Math.round(sim.player.health),
        simMs: +g.game.perf.simMs.toFixed(2),
        renderMs: +g.game.perf.renderMs.toFixed(2),
        vehicles: sim.vehicles.length,
        characters: sim.characters.length,
      };
    },
  };
  let n = 0;
  setInterval(() => {
    auto.step();
    if (auto.on && ++n % 3 === 0) auto.samples.push(auto.sample());
  }, 33);
  window.__auto = auto;
}

/** The hour the cruise and the sprint run at (MOTION_HOUR, 10.5 by default; the chase is at dusk). */
const HOUR = Number(process.env.MOTION_HOUR ?? 10.5);

const summary = (samples) => {
  const mean = (f) => +(samples.reduce((a, s) => a + f(s), 0) / Math.max(1, samples.length)).toFixed(1);
  const fast = samples.filter((s) => s.speed > 20);
  const slow = samples.filter((s) => s.speed < 3);
  const meanOf = (list, f) => (list.length ? +(list.reduce((a, s) => a + f(s), 0) / list.length).toFixed(1) : null);
  let hits = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1].speed - samples[i].speed > 6) hits++;
  const contact = samples.find((s) => s.wanted > 0 && s.nearestPolice !== null && s.nearestPolice < 40);
  return {
    seconds: samples.length ? samples[samples.length - 1].t - samples[0].t : 0,
    meanSpeed: mean((s) => s.speed),
    topSpeed: Math.max(0, ...samples.map((s) => s.speed)),
    carsWithin80m: mean((s) => s.cars80),
    carsInView: mean((s) => s.carsSeen),
    emptyViewShare: +(samples.filter((s) => s.carsSeen === 0).length / Math.max(1, samples.length)).toFixed(2),
    parkedWithin80m: mean((s) => s.parked),
    pedsWithin80m: mean((s) => s.peds80),
    pedsInView: mean((s) => s.pedsSeen),
    carPxAtRest: meanOf(slow, (s) => s.carPx),
    carPxFast: meanOf(fast, (s) => s.carPx),
    camDistAtRest: meanOf(slow, (s) => s.camDist),
    camDistFast: meanOf(fast, (s) => s.camDist),
    fovAtRest: meanOf(slow, (s) => s.fov),
    fovFast: meanOf(fast, (s) => s.fov),
    hardHits: hits,
    firstPoliceWithin40m: contact ? contact.t : null,
    healthEnd: samples.length ? samples[samples.length - 1].health : null,
    playerEnd: samples.length ? samples[samples.length - 1].player : null,
    simMs: +(samples.reduce((a, s) => a + s.simMs, 0) / Math.max(1, samples.length)).toFixed(2),
    simMsMax: Math.max(0, ...samples.map((s) => s.simMs)),
    renderMs: +(samples.reduce((a, s) => a + s.renderMs, 0) / Math.max(1, samples.length)).toFixed(2),
    vehicles: mean((s) => s.vehicles),
    characters: mean((s) => s.characters),
  };
};

export default async function (t) {
  await t.boot();
  await t.newGame();
  await t.game((g, hour) => {
    // No god mode: it spares the car as well, and the damage a crash does is part of what this measures.
    g.setClockRate(0);
    g.setTime(hour);
    g.spawnVehicle('sedan', true);
  }, HOUR);
  await t.page.evaluate(`(${install.toString()})(window.__gta7)`);
  await t.wait(600);
  // Which way D turns: drive off, steer, compare headings.
  const sign = await t.page.evaluate(async () => {
    const v = window.__gta7.sim.player.vehicle;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const key = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key', '').toLowerCase(), bubbles: true }));
    key('KeyW', true);
    await wait(900);
    const h0 = v.heading;
    key('KeyD', true);
    await wait(350);
    key('KeyD', false);
    key('KeyW', false);
    const d = Math.atan2(Math.sin(v.heading - h0), Math.cos(v.heading - h0));
    window.__auto.sign = d > 0 ? 1 : -1;
    return window.__auto.sign;
  });
  t.note(`steer sign ${sign}`);

  const segment = async (label, seconds, setup) => {
    await t.page.evaluate(
      ([src]) => {
        const a = window.__auto;
        new Function('g', 'a', `(${src})(g, a)`)(window.__gta7, a);
        a.samples = [];
        a.jams = 0;
        a.t0 = performance.now();
        a.on = true;
      },
      [setup.toString()],
    );
    // A frame every four seconds, and one the first time the car passes each of these speeds (m/s).
    const marks = [30, 40, 48];
    const t0 = Date.now();
    let shot = 1;
    while (Date.now() - t0 < seconds * 1000) {
      await t.wait(200);
      const speed = await t.page.evaluate(() => {
        const v = window.__gta7.sim.player.vehicle;
        return v ? Math.hypot(v.vel.x, v.vel.z) : 0;
      });
      if (marks.length && speed >= marks[0]) await t.shot(`${label}-at-${Math.round(marks.shift() * 3.6)}kmh`);
      if (Date.now() - t0 >= shot * 4000) await t.shot(`${label}-${String(shot++ * 4).padStart(2, '0')}s`);
    }
    const out = await t.page.evaluate(() => {
      const a = window.__auto;
      a.on = false;
      a.release();
      return { samples: a.samples, jams: a.jams, startedAt: +(a.t0 / 1000).toFixed(1) };
    });
    // startedAt: seconds since the page loaded, which is where the segment starts in the video, give or take a second.
    return { label, startedAt: out.startedAt, jams: out.jams, ...summary(out.samples), samples: out.samples };
  };

  const results = [];
  // A cruise the way a player drives to a mission: brisk, through Midtown and Downtown.
  results.push(
    await segment('cruise', 44, (g, a) => {
      const r = g.sim.roads;
      a.cruise = 26;
      a.corner = 9;
      a.plan([r.node(5, 2).id, r.node(5, 5).id, r.node(2, 5).id, r.node(2, 2).id, r.node(6, 3).id]);
    }),
  );
  // Flat out in a sports car on the avenue.
  results.push(
    await segment('sprint', 20, (g, a) => {
      const r = g.sim.roads;
      g.spawnVehicle('sports', true);
      a.cruise = 60;
      a.corner = 12;
      a.plan([r.node(1, 4).id, r.node(7, 4).id, r.node(7, 6).id, r.node(1, 6).id]);
    }),
  );
  // Three stars at dusk.
  results.push(
    await segment('chase', 40, (g, a) => {
      const r = g.sim.roads;
      g.setTime(19.2);
      // A fresh car: the sprint may have left the last one a wreck.
      g.spawnVehicle('muscle', true);
      g.setWanted(3);
      a.cruise = 34;
      a.corner = 11;
      a.plan([r.node(4, 2).id, r.node(6, 2).id, r.node(6, 6).id, r.node(2, 6).id, r.node(2, 3).id, r.node(5, 3).id]);
    }),
  );
  await t.snap('end');
  t.note('motion ' + JSON.stringify(results));
  console.table(results.map(({ samples, ...r }) => r));
}
