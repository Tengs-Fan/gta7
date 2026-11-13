// A new player's first job, played with the real keys: New Game with Lou's call, walk to a car, take it with F, drive
// it across town to her garage in the Docks and into it (all but lining it up with her door, see below). Run with
// --intro (and --video to watch it):
//
//   node scripts/playtest.mjs --intro --video --script scripts/playtests/firstjob.mjs --out /tmp/firstjob
//
// report.json's notes give the seconds each step took and whether "Wheels" was passed.

import { install } from './motion.mjs';

const key = (page, code, down) =>
  page.evaluate(([code, down]) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key', '').toLowerCase(), bubbles: true })), [code, down]);

export default async function (t) {
  await t.boot();
  await t.newGame();
  const started = Date.now();
  const since = () => +((Date.now() - started) / 1000).toFixed(1);
  await t.shot('new-game');
  await t.page.waitForFunction(() => window.__gta7.state().objective === 'Steal a car', null, { timeout: 90_000 });
  t.note(`objective "Steal a car" at ${since()} s`);
  await t.shot('steal-a-car');

  // On foot to the nearest car standing still (not a police car), the view turned to it, and F beside it.
  await t.page.evaluate(() => {
    const g = window.__gta7;
    const sim = g.sim;
    const press = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key', '').toLowerCase(), bubbles: true }));
    const skip = new Set();
    let target = null;
    let best = Infinity;
    let stall = 0;
    let n = 0;
    press('KeyW', true);
    press('ShiftLeft', true);
    window.__walk = setInterval(() => {
      const p = sim.player;
      if (p.vehicle) {
        clearInterval(window.__walk);
        press('KeyW', false);
        press('ShiftLeft', false);
        window.__walked = true;
        return;
      }
      if (!target || target.removed || skip.has(target)) {
        target = null;
        let near = Infinity;
        for (const v of sim.vehicles) {
          if (v.removed || skip.has(v) || !v.drivable || v.spec.police || v.spec.class !== 'car' || Math.hypot(v.vel.x, v.vel.z) > 1.5) continue;
          const d = Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
          if (d < near) {
            near = d;
            target = v;
          }
        }
        best = Infinity;
        stall = 0;
      }
      if (!target) return;
      const dx = target.pos.x - p.pos.x;
      const dz = target.pos.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      g.setCamera(Math.atan2(dx, dz), -0.12);
      // No nearer for five seconds (a fence, a wall): another car.
      if (d < best - 0.3) {
        best = d;
        stall = 0;
      } else if (++stall > 100) skip.add(target);
      if (d < 3.2 && ++n % 8 === 0) {
        press('KeyF', true);
        setTimeout(() => press('KeyF', false), 60);
      }
    }, 50);
  });
  await t.page.waitForFunction(() => window.__walked === true, null, { timeout: 120_000 });
  t.note(`in a car at ${since()} s`);
  await t.wait(1200);
  await t.shot('in-the-car');

  // The drive: along the lanes to the junction nearest her garage, then straight for the marker at a crawl.
  await t.page.evaluate(`(${install.toString()})(window.__gta7)`);
  // What the drive costs: every person the car hits (how fast, forwards or backing up) and every crime charged.
  await t.page.evaluate(() => {
    const sim = window.__gta7.sim;
    const t0 = performance.now();
    const log = (window.__incidents = []);
    const at = () => +((performance.now() - t0) / 1000).toFixed(1);
    // The three seconds before a hit, ten times a second: the car's speed and turn rate, what the driver was doing
    // (r: going round a car, w: stopping for someone) and, of everyone within 30 m, how far ahead of the car and to
    // its right he was, what he was about (his brain's mode), his dodge state and his pace.
    const past = [];
    setInterval(() => {
      const v = sim.player.vehicle;
      if (!v) return;
      const fx = Math.sin(v.heading);
      const fz = Math.cos(v.heading);
      const a = window.__auto;
      const row = { t: at(), car: [+Math.hypot(v.vel.x, v.vel.z).toFixed(1), +v.angVel.toFixed(2), (a.rounding ? 'r' : '') + (a.waiting ? 'w' : '')], who: {} };
      for (const c of sim.characters) {
        if (c.removed || c.isPlayer || !c.alive || c.vehicle) continue;
        const dx = c.pos.x - v.pos.x;
        const dz = c.pos.z - v.pos.z;
        if (dx * dx + dz * dz > 900) continue;
        row.who[c.id] = [+(dx * fx + dz * fz).toFixed(1), +(dx * fz - dz * fx).toFixed(1), c.brain?.mode ?? c.owner, +(c.brain?.dodge ?? 0).toFixed(2), +c.speed.toFixed(1)];
      }
      past.push(row);
      if (past.length > 30) past.shift();
    }, 100);
    const hit = sim.onCharacterHitByVehicle.bind(sim);
    sim.onCharacterHitByVehicle = (c, v, rel, nx, nz) => {
      if (v === sim.player.vehicle)
        log.push({
          t: at(),
          what: 'hit a person',
          rel: +rel.toFixed(1),
          speed: +Math.hypot(v.vel.x, v.vel.z).toFixed(1),
          forward: +v.forwardSpeed.toFixed(1),
          unstick: window.__auto.unstick > 0,
          lane: +sim.roads.nearestLane(c.pos.x, c.pos.z).dist.toFixed(1),
          // Who he was: on foot all along, or a driver who had just got out angry (AngryDriverSystem) or been thrown off a bike.
          mode: c.brain?.mode ?? null,
          angry: !!c.brain?.angryCar,
          owner: c.owner,
          before: past.filter((r) => r.who[c.id]).map((r) => [r.t, ...r.car, ...r.who[c.id]]),
        });
      return hit(c, v, rel, nx, nz);
    };
    // The streets he drives through: how many people jumped clear of him, and whether the game counted him on a clock
    // (a job or a mission's timer, when the fuller streets and the dodge are off; the first job has neither).
    window.__streets = { dodged: 0, samples: 0, onTheClock: 0 };
    sim.events.on('pedDodge', () => window.__streets.dodged++);
    const commit = sim.wanted.commit.bind(sim.wanted);
    sim.wanted.commit = (type, x, z) => {
      log.push({ t: at(), what: 'charged', type, level: sim.wanted.level });
      return commit(type, x, z);
    };
  });
  const marker = await t.page.evaluate(async () => {
    const g = window.__gta7;
    const v = g.sim.player.vehicle;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const press = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key', '').toLowerCase(), bubbles: true }));
    // A parked car stands nose to its bay's wall: back out of it first, as anyone would.
    press('KeyS', true);
    await wait(1700);
    press('KeyS', false);
    await wait(500);
    const a = window.__auto;
    // D lowers the heading (scripts/playtests/motion.mjs finds this by trying it; here there is a wall in the way).
    a.sign = -1;
    const m = g.sim.missions.active.markers[0];
    // A careful driver: under the limit, braking for people.
    a.people = true;
    a.cruise = 16;
    a.corner = 7;
    a.plan([g.sim.roads.nearestNode(m.x, m.z).id]);
    a.t0 = performance.now();
    a.on = true;
    return { x: m.x, z: m.z };
  });
  let passed = false;
  let close = false;
  let starred = false;
  let last = null;
  for (let i = 0; i < 400 && !passed; i++) {
    await t.wait(500);
    const s = await t.page.evaluate((m) => {
      const g = window.__gta7;
      const v = g.sim.player.vehicle;
      const a = window.__auto;
      const st = g.state();
      const d = v ? Math.hypot(v.pos.x - m.x, v.pos.z - m.z) : -1;
      window.__streets.samples++;
      if (g.sim.traffic.onTheClock) window.__streets.onTheClock++;
      return { d, done: st.missionsDone.includes('wheels'), mission: st.mission, at: a.at, len: a.path.length, wanted: st.wanted, objective: st.objective, health: v ? Math.round(v.health) : -1 };
    }, marker);
    passed = s.done;
    if (s.wanted > 0 && !starred) {
      starred = true;
      t.note(`a wanted star at ${since()} s`);
    }
    last = s;
    if (!close && s.d >= 0 && (s.d < 34 || s.at >= s.len - 3)) {
      close = true;
      t.note(`at her street at ${since()} s, ${Math.round(s.d)} m from the marker`);
      await t.shot('at-her-street');
      // The scripted driver cannot park through a doorway, which a person does by eye: the car is stood in front of
      // her door, facing in, with the debug hook (the one step here that is not played), and driven in by the keys.
      await t.page.evaluate((m) => {
        const g = window.__gta7;
        const a = window.__auto;
        a.on = false;
        a.release();
        // The bay (the mission's marker) is beside her own marker on the pavement; its door faces the way she does.
        const lou = g.poi('lou');
        g.place(m.x + Math.sin(lou.heading) * 13, m.z + Math.cos(lou.heading) * 13, lou.heading + Math.PI);
      }, marker);
      await t.wait(600);
      await t.shot('at-her-door');
      for (let k = 0; k < 60 && !passed; k++) {
        const speed = await t.page.evaluate(() => {
          const v = window.__gta7.sim.player.vehicle;
          return v ? Math.hypot(v.vel.x, v.vel.z) : 99;
        });
        await key(t.page, 'KeyW', speed < 3.5);
        await t.wait(150);
        passed = await t.page.evaluate(() => window.__gta7.state().missionsDone.includes('wheels'));
      }
      await key(t.page, 'KeyW', false);
    }
    if (i % 30 === 29) await t.shot(`drive-${Math.round(since())}s`);
  }
  await t.page.evaluate(() => {
    window.__auto.on = false;
    window.__auto.release();
  });
  t.note('incidents ' + JSON.stringify(await t.page.evaluate(() => window.__incidents)));
  t.note('streets ' + JSON.stringify(await t.page.evaluate(() => window.__streets)));
  // Where it ended: the cars within 14 m ahead of it and the people within 10 m, for a run that stood still to its end.
  t.note(
    'around ' +
      JSON.stringify(
        await t.page.evaluate(() => {
          const sim = window.__gta7.sim;
          const v = sim.player.vehicle;
          if (!v) return null;
          const fx = Math.sin(v.heading);
          const fz = Math.cos(v.heading);
          const rel = (o) => [+((o.pos.x - v.pos.x) * fx + (o.pos.z - v.pos.z) * fz).toFixed(1), +((o.pos.x - v.pos.x) * fz - (o.pos.z - v.pos.z) * fx).toFixed(1)];
          const cars = sim.vehicles
            .filter((o) => o !== v && !o.removed && Math.hypot(o.pos.x - v.pos.x, o.pos.z - v.pos.z) < 14)
            .map((o) => ({ at: rel(o), kind: o.kind, owner: o.owner, driver: o.driver ? (o.driver.alive ? 'in' : 'dead') : 'none', ai: !!o.ai, hold: !!o.ai?.hold, speed: +Math.hypot(o.vel.x, o.vel.z).toFixed(1), health: Math.round(o.health) }));
          const people = sim.characters
            .filter((c) => !c.removed && !c.isPlayer && !c.vehicle && Math.hypot(c.pos.x - v.pos.x, c.pos.z - v.pos.z) < 10)
            .map((c) => ({ at: rel(c), alive: c.alive, state: c.state, mode: c.brain?.mode ?? null, angry: !!c.brain?.angryCar, dodge: +(c.brain?.dodge ?? 0).toFixed(1), owner: c.owner }));
          return { speed: +Math.hypot(v.vel.x, v.vel.z).toFixed(1), waiting: window.__auto.waiting, rounding: window.__auto.rounding, cars, people, grievances: sim.angryDrivers.active.map((g) => g.state) };
        }),
      ),
  );
  t.note(passed ? `"Wheels" passed at ${since()} s, the car at ${last?.health} health` : `"Wheels" NOT passed after ${since()} s (${JSON.stringify(last)})`);
  await t.wait(1500);
  await t.shot('passed');
  await t.snap('end');
  if (!passed) throw new Error('the first job was not completed');
}
