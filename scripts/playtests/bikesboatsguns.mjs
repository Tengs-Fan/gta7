// The bikes, the boats and the weapons from where a player sees them, for judging their models before and after a
// change: each bike parked 3 m off from three sides and with a rider, by night with its lamps on, and from the chase
// camera standing and riding; each boat moored and under way, a moored cruiser; each weapon held (a fixed camera a
// metre off the hand), aimed (the game's over-the-shoulder camera and a close side view), and lying as a pickup; then
// a street of bikes and the Marina, measured on High.
//
//   node scripts/playtest.mjs --script scripts/playtests/bikesboatsguns.mjs --out /tmp/bbg
//   BBG_PARTS=guns,pickups node scripts/playtest.mjs --script scripts/playtests/bikesboatsguns.mjs --out /tmp/bbg
//
// The camera is held where the script puts it (the game's own camera is suspended) except in the chase and aim shots.

const PARTS = (process.env.BBG_PARTS ?? 'bikes,night,chase,boats,guns,pickups,measure').split(',');
const BIKES = ['sportbike', 'scooter'];
const GUNS = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'rocket'];
const HELD = ['bat', 'knife', 'grenade', 'molotov'];

/** Runs in the page: holds the camera at window.__fixed ({ pos, at, fov }) while it is set. */
function installCamera(g) {
  const ctl = g.game.renderer.cameraCtl;
  if (!window.__origUpdate) window.__origUpdate = ctl.update;
  window.__fixed = null;
  ctl.update = function (dt, sim, aiming) {
    const f = window.__fixed;
    if (!f) return window.__origUpdate.call(this, dt, sim, aiming);
    this.camera.position.set(f.pos[0], f.pos[1], f.pos[2]);
    this.camera.fov = f.fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(f.at[0], f.at[1], f.at[2]);
    this.camera.updateMatrixWorld();
  };
  g.game.hud.root.style.visibility = 'hidden';
}

/** Runs in the page: removes what the script placed (by tag) and puts the player back on foot at the stage's edge. */
function clear(g, tags) {
  const sim = g.sim;
  if (sim.player.vehicle) sim.playerCtl.ejectPlayer(true);
  for (const v of [...sim.vehicles]) if (tags.includes(v.missionTag)) sim.removeVehicle(v);
  for (const c of [...sim.characters]) if (!c.isPlayer && tags.includes(c.missionTag)) sim.removeCharacter(c);
  window.__fixed = null;
}

/**
 * Runs in the page: one vehicle of `kind` at (x, z, heading), the camera at `view` (vehicle-local x left, y up, z
 * forward) looking at `at`; a rider on it if asked; the player out of the way.
 */
function stage(g, kind, st, view, at, opts) {
  const sim = g.sim;
  for (const v of [...sim.vehicles]) if (v.missionTag === 'look') sim.removeVehicle(v);
  for (const c of [...sim.characters]) if (c.missionTag === 'look') sim.removeCharacter(c);
  const v = sim.spawnVehicle(kind, st.x, st.z, st.heading, opts.color);
  v.persistent = true;
  v.missionTag = 'look';
  v.lights = opts.lights ? 'on' : 'off';
  if (opts.rider) {
    const c = sim.spawnCharacter('civilian', st.x, st.z, { skin: 0xe0ac69, shirt: 0x2c3e50, pants: 0x1a1a1a, hair: 0x3b2a1a, hat: 0, height: 1.0, build: 1.0 });
    c.persistent = true;
    c.missionTag = 'look';
    sim.seat(c, v, 0);
  }
  const h = st.heading;
  const w = (x, y, z) => [st.x + x * Math.cos(h) + z * Math.sin(h), st.y + y, st.z - x * Math.sin(h) + z * Math.cos(h)];
  window.__fixed = { pos: w(...view), at: w(...at), fov: opts.fov ?? 50 };
  const p = sim.player;
  const pp = w(-30, 0, 0);
  if (!p.vehicle) {
    p.pos.x = pp[0];
    p.pos.z = pp[2];
    p.pos.y = sim.world.groundHeight(pp[0], pp[2]);
  }
}

/** Runs in the page: where the player's drawn weapon is (its instance in the crowd's mesh), or his chest. */
function heldAt(g, id) {
  const crowd = g.game.renderer.crowd;
  const part = crowd.weapons.get(id);
  const p = g.sim.player;
  if (part && part.mesh.count > 0) {
    const m = new part.mesh.matrix.constructor();
    part.mesh.getMatrixAt(0, m);
    const e = m.elements;
    return [e[12], e[13], e[14]];
  }
  return [p.pos.x, p.pos.y + 1.2, p.pos.z];
}

const key = (page, code, down) =>
  page.evaluate(([code, down]) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key', '').toLowerCase(), bubbles: true })), [code, down]);

export default async function (t) {
  await t.boot();
  await t.newGame();
  await t.game((g) => {
    g.godMode(true);
    g.setClockRate(0);
    g.setTime(11);
    g.forceWeather('clear');
    const sim = g.sim;
    sim.ambient = false;
    for (const c of [...sim.characters]) if (!c.isPlayer && !c.vehicle) sim.removeCharacter(c);
    for (const v of [...sim.vehicles]) if (Math.hypot(v.pos.x - sim.player.pos.x, v.pos.z - sim.player.pos.z) < 250) sim.removeVehicle(v);
    const start = sim.player.pos;
    window.__street = { x: start.x, y: sim.world.groundHeight(start.x, start.z + 5.2), z: start.z + 5.2, heading: Math.PI / 2 };
    const lots = sim.world.layout.ground.filter((q) => q.kind === 'parking').map((q) => q.rect);
    lots.sort((a, b) => (b.maxX - b.minX) * (b.maxZ - b.minZ) - (a.maxX - a.minX) * (a.maxZ - a.minZ));
    const lot = lots[0];
    const along = lot.maxX - lot.minX >= lot.maxZ - lot.minZ;
    const x = (lot.minX + lot.maxX) / 2;
    const z = (lot.minZ + lot.maxZ) / 2;
    g.teleport(x, z);
    for (const v of [...sim.vehicles]) if (Math.hypot(v.pos.x - x, v.pos.z - z) < 250) sim.removeVehicle(v);
    window.__stage = { x, y: sim.world.groundHeight(x, z), z, heading: along ? Math.PI / 2 : 0 };
    const b = sim.world.layout.props.find((p) => p.kind === 'boat');
    window.__marina = { prop: { x: b.x, z: b.z, y: b.y ?? 0, heading: b.heading ?? 0 }, x: b.x + 13, z: b.z, y: 0, heading: 0.4 };
  });
  await t.game(installCamera);
  t.note(`stage ${JSON.stringify(await t.game(() => ({ stage: window.__stage, marina: window.__marina })))}`);
  await t.wait(1500);
  const colors = { sportbike: 0xc0392b, scooter: 0x16a085, speedboat: 0xf4f6f7, dinghy: 0xe67e22 };

  if (PARTS.includes('bikes')) {
    for (const kind of BIKES) {
      const views = {
        side: [[3, 0.9, 0], [0, 0.6, 0]],
        front: [[2.1, 1.1, 2.1], [0, 0.6, 0]],
        rear: [[2.1, 1.2, -2.1], [0, 0.6, 0]],
        top: [[1.2, 2.3, -1.4], [0, 0.7, 0.2]],
        engine: [[1.4, 0.7, 0.2], [0, 0.45, -0.05]],
        cockpit: [[0.5, 1.6, -0.9], [0, 1.0, 0.5]],
      };
      for (const [view, [pos, at]] of Object.entries(views)) {
        await t.game(stage, kind, await t.game(() => window.__stage), pos, at, { color: colors[kind] });
        await t.wait(900);
        await t.shot(`${kind}-${view}`);
      }
      await t.game(stage, kind, await t.game(() => window.__stage), [2.6, 1.3, 1.6], [0, 0.9, 0], { color: colors[kind], rider: true });
      await t.wait(1200);
      await t.shot(`${kind}-rider`);
    }
  }

  if (PARTS.includes('night')) {
    await t.game((g) => g.setTime(21.5));
    await t.wait(1500);
    for (const kind of BIKES) {
      for (const [view, pos] of [['front', [1.8, 1.0, 3.2]], ['rear', [1.8, 1.1, -3.2]]]) {
        await t.game(stage, kind, await t.game(() => window.__stage), pos, [0, 0.7, 0], { color: colors[kind], lights: true, rider: true });
        await t.wait(1200);
        await t.shot(`night-${kind}-${view}`);
      }
    }
    await t.game((g) => g.setTime(11));
    await t.wait(1500);
  }

  if (PARTS.includes('chase')) {
    for (const kind of BIKES) {
      await t.game((g, kind, color) => {
        const sim = g.sim;
        for (const v of [...sim.vehicles]) if (v.missionTag === 'look') sim.removeVehicle(v);
        for (const c of [...sim.characters]) if (c.missionTag === 'look') sim.removeCharacter(c);
        window.__fixed = null;
        if (sim.player.vehicle) sim.playerCtl.ejectPlayer(true);
        const st = window.__street;
        g.teleport(st.x, st.z - 5.2);
        const v = sim.spawnVehicle(kind, st.x, st.z, st.heading, color);
        v.missionTag = 'look';
        v.persistent = true;
        sim.seat(sim.player, v, 0);
        v.usedByPlayer = true;
        g.game.renderer.cameraCtl.reset(sim);
      }, kind, colors[kind]);
      await t.wait(2500);
      await t.shot(`chase-${kind}`);
      // Riding: throttle, then a turn to the right (leaning).
      await key(t.page, 'KeyW', true);
      await t.wait(1600);
      await t.shot(`chase-${kind}-riding`);
      await key(t.page, 'KeyD', true);
      await t.wait(500);
      await t.shot(`chase-${kind}-lean`);
      await key(t.page, 'KeyD', false);
      await key(t.page, 'KeyW', false);
      await key(t.page, 'Space', true);
      await t.wait(1500);
      await key(t.page, 'Space', false);
    }
    await t.game(clear, ['look']);
  }

  if (PARTS.includes('boats')) {
    await t.game((g) => {
      const m = window.__marina;
      g.teleport(m.x - 20, m.z - 8);
    });
    await t.wait(1500);
    for (const kind of ['speedboat', 'dinghy']) {
      const D = kind === 'speedboat' ? 7.5 : 5;
      const views = {
        side: [[D, 1.8, 0], [0, 0.5, 0]],
        front: [[D * 0.72, 2.0, D * 0.72], [0, 0.5, 0]],
        rear: [[D * 0.72, 2.0, -D * 0.72], [0, 0.4, -0.5]],
        cockpit: [[1.0, 2.6, -D * 0.55], [0, 0.6, 0.6]],
        stern: [[0.9, 1.4, -D * 0.5], [0, 0.2, -1.5]],
      };
      for (const [view, [pos, at]] of Object.entries(views)) {
        await t.game(stage, kind, await t.game(() => window.__marina), pos, at, { color: colors[kind] });
        await t.wait(1200);
        await t.shot(`${kind}-${view}`);
      }
    }
    // A moored cruiser, from the pontoon side and from its stern.
    await t.game((g) => {
      for (const v of [...g.sim.vehicles]) if (v.missionTag === 'look') g.sim.removeVehicle(v);
      const b = window.__marina.prop;
      const h = b.heading;
      const w = (x, y, z) => [b.x + x * Math.cos(h) + z * Math.sin(h), y, b.z - x * Math.sin(h) + z * Math.cos(h)];
      window.__fixed = { pos: w(10, 3.5, 8), at: w(0, 1.2, 1), fov: 50 };
    });
    await t.wait(1200);
    await t.shot('cruiser-a');
    await t.game((g) => {
      const b = window.__marina.prop;
      const h = b.heading;
      const w = (x, y, z) => [b.x + x * Math.cos(h) + z * Math.sin(h), y, b.z - x * Math.sin(h) + z * Math.cos(h)];
      window.__fixed = { pos: w(-11, 3, -6), at: w(1, 1.2, 0), fov: 50 };
    });
    await t.wait(1000);
    await t.shot('cruiser-b');
    // Under way, from the chase camera.
    for (const kind of ['speedboat', 'dinghy']) {
      await t.game((g, kind, color) => {
        const sim = g.sim;
        for (const v of [...sim.vehicles]) if (v.missionTag === 'look') sim.removeVehicle(v);
        window.__fixed = null;
        if (sim.player.vehicle) sim.playerCtl.ejectPlayer(true);
        const m = window.__marina;
        g.teleport(m.x, m.z - 6);
        const v = sim.spawnVehicle(kind, m.x, m.z, m.heading, color);
        v.missionTag = 'look';
        v.persistent = true;
        sim.seat(sim.player, v, 0);
        v.usedByPlayer = true;
        g.game.renderer.cameraCtl.reset(sim);
      }, kind, colors[kind]);
      await t.wait(2500);
      await t.shot(`chase-${kind}`);
      await key(t.page, 'KeyW', true);
      await t.wait(2500);
      await t.shot(`chase-${kind}-underway`);
      await key(t.page, 'KeyW', false);
    }
    // The speedboat at night, moored, from the stern quarter.
    await t.game((g) => g.setTime(21.5));
    await t.game(clear, ['look']);
    await t.wait(1200);
    await t.game(stage, 'speedboat', await t.game(() => window.__marina), [5.5, 2.2, -6], [0, 0.6, 0], { color: colors.speedboat, lights: true, rider: true });
    await t.wait(1500);
    await t.shot('night-speedboat');
    await t.game((g) => g.setTime(11));
    await t.game(clear, ['look']);
  }

  if (PARTS.includes('guns')) {
    await t.game((g) => {
      const st = window.__stage;
      g.teleport(st.x, st.z);
      g.sim.player.heading = st.heading;
      g.setCamera(st.heading, -0.05);
    });
    await t.wait(1500);
    for (const id of [...GUNS, ...HELD]) {
      await t.game((g, id) => {
        window.__fixed = null;
        g.give(id, 60);
        g.setCamera(window.__stage.heading, -0.05);
      }, id);
      await t.wait(900);
      // Held at rest: a camera a metre off the gun, from his right front and from his right side.
      const at = await t.game(heldAt, id);
      await t.game((g, at) => {
        const h = g.sim.player.heading;
        const w = (x, y, z) => [at[0] + x * Math.cos(h) + z * Math.sin(h), at[1] + y, at[2] - x * Math.sin(h) + z * Math.cos(h)];
        window.__fixed = { pos: w(-0.85, 0.25, 0.65), at, fov: 40 };
      }, at);
      await t.wait(500);
      await t.shot(`held-${id}`);
      if (!GUNS.includes(id)) continue;
      // Aimed: the game's over-the-shoulder camera, then a close view from his right.
      await t.game(() => {
        window.__fixed = null;
      });
      await t.page.mouse.move(800, 450);
      await t.page.mouse.down({ button: 'right' });
      await t.wait(900);
      await t.shot(`aim-${id}`);
      const aat = await t.game(heldAt, id);
      await t.game((g, at) => {
        const h = g.game.renderer.cameraCtl.yaw;
        const w = (x, y, z) => [at[0] + x * Math.cos(h) + z * Math.sin(h), at[1] + y, at[2] - x * Math.sin(h) + z * Math.cos(h)];
        window.__fixed = { pos: w(-0.9, 0.12, 0.1), at, fov: 40 };
      }, aat);
      await t.wait(400);
      await t.shot(`aimside-${id}`);
      await t.game(() => {
        window.__fixed = null;
      });
      await t.page.mouse.up({ button: 'right' });
      await t.wait(300);
    }
    await t.game((g) => {
      g.sim.player.inventory.current = 'fists';
    });
  }

  if (PARTS.includes('pickups')) {
    // One pickup of each weapon moved into a row across the lot, seen from 3 m and from 8 m.
    await t.game((g) => {
      const sim = g.sim;
      const st = window.__stage;
      const h = st.heading;
      const w = (x, y, z) => [st.x + x * Math.cos(h) + z * Math.sin(h), st.y + y, st.z - x * Math.sin(h) + z * Math.cos(h)];
      const ids = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'rocket', 'bat', 'knife', 'grenade', 'molotov'];
      const taken = new Set();
      let i = 0;
      for (const id of ids) {
        const p = sim.pickups.find((q) => q.kind === 'weapon' && q.weapon === id && !taken.has(q.id));
        if (!p) continue;
        taken.add(p.id);
        p.active = true;
        const q = w(6, 0, (i - 4.5) * 1.4);
        p.pos.x = q[0];
        p.pos.y = q[1];
        p.pos.z = q[2];
        i++;
      }
      g.teleport(...w(-30, 0, 0).filter((_, k) => k !== 1));
      window.__fixed = { pos: w(3, 1.6, 0), at: w(6, 0.8, 0), fov: 60 };
      window.__pickupView = [w(3.6, 1.5, -1.6), w(6, 0.8, -3)];
    });
    await t.wait(1500);
    await t.shot('pickups-3m');
    await t.game(() => {
      const [pos, at] = window.__pickupView;
      window.__fixed = { pos, at, fov: 40 };
    });
    await t.wait(800);
    await t.shot('pickups-close');
    await t.game((g) => {
      const st = window.__stage;
      const h = st.heading;
      const w = (x, y, z) => [st.x + x * Math.cos(h) + z * Math.sin(h), st.y + y, st.z - x * Math.sin(h) + z * Math.cos(h)];
      window.__fixed = { pos: w(-2, 2, 0), at: w(6, 0.8, 0), fov: 50 };
    });
    await t.wait(800);
    await t.shot('pickups-8m');
    await t.game(() => {
      window.__fixed = null;
    });
  }

  if (PARTS.includes('measure')) {
    // A street of bikes: twenty standing bikes, half with riders, ahead of the player's sport bike, from the chase camera.
    await t.game((g) => {
      const sim = g.sim;
      for (const v of [...sim.vehicles]) if (v.missionTag === 'look') sim.removeVehicle(v);
      window.__fixed = null;
      const st = window.__street;
      g.teleport(st.x, st.z - 5.2);
      let n = 0;
      for (let d = 8; d <= 80; d += 7) {
        for (const lane of [0, 3.6]) {
          const kind = n % 2 ? 'scooter' : 'sportbike';
          const v = sim.spawnVehicle(kind, st.x + d + (lane ? 3 : 0), st.z + lane, lane ? -Math.PI / 2 : Math.PI / 2, [0xc0392b, 0x16a085, 0x1c1c1c, 0xf1c40f][n % 4]);
          v.persistent = true;
          v.missionTag = 'street';
          if (n % 2 === 0) {
            const c = sim.spawnCharacter('civilian', v.pos.x, v.pos.z);
            c.persistent = true;
            c.missionTag = 'street';
            sim.seat(c, v, 0);
          }
          n++;
        }
      }
      const v = sim.spawnVehicle('sportbike', st.x, st.z, st.heading, 0xc0392b);
      v.missionTag = 'look';
      v.persistent = true;
      sim.seat(sim.player, v, 0);
      v.usedByPlayer = true;
      g.game.renderer.cameraCtl.reset(sim);
      g.setCamera(Math.PI / 2, -0.05);
    });
    await t.wait(3000);
    await t.measure('bike-street-high', 3000);
    await t.snap('bike-street-high');
    await t.shot('bike-street-high');
    // The Marina from the speedboat, two more boats of each kind about.
    await t.game((g) => {
      const sim = g.sim;
      for (const v of [...sim.vehicles]) if (v.missionTag === 'street' || v.missionTag === 'look') sim.removeVehicle(v);
      for (const c of [...sim.characters]) if (c.missionTag === 'street') sim.removeCharacter(c);
      if (sim.player.vehicle) sim.playerCtl.ejectPlayer(true);
      const m = window.__marina;
      g.teleport(m.x, m.z - 6);
      [[6, 4, 'dinghy'], [-6, 6, 'speedboat'], [9, -6, 'speedboat'], [-8, -5, 'dinghy']].forEach(([dx, dz, k]) => {
        const v = sim.spawnVehicle(k, m.x + dx, m.z + dz, m.heading + dx * 0.1);
        v.persistent = true;
        v.missionTag = 'street';
      });
      const v = sim.spawnVehicle('speedboat', m.x, m.z, m.heading, 0xf4f6f7);
      v.missionTag = 'look';
      v.persistent = true;
      sim.seat(sim.player, v, 0);
      v.usedByPlayer = true;
      g.game.renderer.cameraCtl.reset(sim);
    });
    await t.wait(3000);
    await t.measure('marina-high', 3000);
    await t.snap('marina-high');
    await t.shot('marina-high');
  }
  await t.snap('end');
}
