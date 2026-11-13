// A look at every kind of vehicle from fixed viewpoints, for judging their models before and after a change: broadside,
// front three-quarter and rear three-quarter by day with nothing in the way, two kinds at night with their lamps on,
// the player's own car, bikes and speedboat from the chase camera, and a street of standing cars (the traffic mix) whose
// draw calls and triangles are measured on High, Medium and Low.
//
//   node scripts/playtest.mjs --script scripts/playtests/carlook.mjs --out /tmp/carlook
//   CARLOOK_KINDS=sedan,van node scripts/playtest.mjs --script scripts/playtests/carlook.mjs --out /tmp/carlook
//
// The camera is held where the script puts it (the game's own camera is suspended), and the player stands behind it.

const KINDS = (process.env.CARLOOK_KINDS ?? 'sedan,compact,taxi,sports,muscle,pickup,van,police,bus,ambulance,firetruck,swat,tractor,sportbike,scooter').split(',');
const PARTS = (process.env.CARLOOK_PARTS ?? 'day,night,chase,street,ride,dent').split(',');

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

/** Runs in the page: one vehicle of `kind` at the stage, the camera at `view` round it, the player behind the camera. */
function stage(g, kind, view, lights) {
  const sim = g.sim;
  const st = window.__stage;
  for (const v of [...sim.vehicles]) if (v.missionTag === 'look') sim.removeVehicle(v);
  const v = sim.spawnVehicle(kind, st.x, st.z, st.heading, st.colors[kind]);
  v.persistent = true;
  v.missionTag = 'look';
  v.lights = lights ? 'on' : 'off';
  const spec = v.spec;
  const D = Math.max(5.5, spec.length * 1.25);
  const h = st.heading;
  // Vehicle-local (x left, z forward) to world.
  const w = (x, y, z) => [st.x + x * Math.cos(h) + z * Math.sin(h), st.y + y, st.z - x * Math.sin(h) + z * Math.cos(h)];
  const a = { side: [D, 1.45, 0], front: [D * 0.72, 1.6, D * 0.72], rear: [D * 0.72, 1.75, -D * 0.72] }[view];
  window.__fixed = { pos: w(a[0], a[1], a[2]), at: w(0, spec.height * 0.45, 0), fov: 50 };
  const p = sim.player;
  const pp = w(D + 4, 0, 0);
  p.pos.x = pp[0];
  p.pos.z = pp[2];
  p.pos.y = sim.world.groundHeight(pp[0], pp[2]);
}

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
    // The street in front of the start (the near lane, cars facing +x) for the chase camera and the street of cars.
    const start = sim.player.pos;
    window.__street = { x: start.x, y: sim.world.groundHeight(start.x, start.z + 5.2), z: start.z + 5.2, heading: Math.PI / 2 };
    // The middle of the largest car park, open on every side (cars facing along its long side); one paint per kind,
    // the same every run.
    const lots = sim.world.layout.ground.filter((g) => g.kind === 'parking').map((g) => g.rect);
    lots.sort((a, b) => (b.maxX - b.minX) * (b.maxZ - b.minZ) - (a.maxX - a.minX) * (a.maxZ - a.minZ));
    const lot = lots[0];
    const along = lot.maxX - lot.minX >= lot.maxZ - lot.minZ;
    g.teleport((lot.minX + lot.maxX) / 2, (lot.minZ + lot.maxZ) / 2);
    for (const v of [...sim.vehicles]) if (Math.hypot(v.pos.x - sim.player.pos.x, v.pos.z - sim.player.pos.z) < 250) sim.removeVehicle(v);
    const p = sim.player;
    const colors = { sedan: 0x2e86c1, compact: 0xc0392b, taxi: undefined, sports: 0xf1c40f, muscle: 0x1e8449, pickup: 0x7f8c8d, van: 0xf2f3f4, police: undefined, bus: 0x2e86c1, ambulance: undefined, firetruck: undefined, swat: undefined, tractor: undefined, sportbike: 0xc0392b, scooter: 0x16a085 };
    window.__stage = { x: p.pos.x, y: sim.world.groundHeight(p.pos.x, p.pos.z), z: p.pos.z, heading: along ? Math.PI / 2 : 0, colors, lot };
  });
  await t.game(installCamera);
  t.note(`stage ${JSON.stringify(await t.game(() => window.__stage))}`);
  await t.wait(1500);

  if (PARTS.includes('day')) {
    for (const kind of KINDS) {
      for (const view of ['side', 'front', 'rear']) {
        await t.game(stage, kind, view, false);
        await t.wait(900);
        await t.shot(`${kind}-${view}`);
      }
    }
  }

  if (PARTS.includes('night')) {
    await t.game((g) => g.setTime(21));
    await t.wait(1500);
    for (const kind of ['sedan', 'van']) {
      for (const view of ['rear', 'front']) {
        await t.game(stage, kind, view, true);
        await t.wait(900);
        await t.shot(`night-${kind}-${view}`);
      }
    }
    await t.game((g) => g.setTime(11));
    await t.wait(1500);
  }

  if (PARTS.includes('chase')) {
    // The player's own car from the chase camera at rest, by day.
    for (const kind of ['sedan', 'compact', 'van']) {
      await t.game((g, kind) => {
        const sim = g.sim;
        for (const v of [...sim.vehicles]) if (v.missionTag === 'look') sim.removeVehicle(v);
        window.__fixed = null;
        const st = window.__street;
        if (sim.player.vehicle) sim.playerCtl.ejectPlayer(true);
        g.teleport(st.x, st.z - 5.2);
        const v = sim.spawnVehicle(kind, st.x, st.z, st.heading, window.__stage.colors[kind]);
        v.missionTag = 'look';
        v.persistent = true;
        sim.seat(sim.player, v, 0);
        v.usedByPlayer = true;
        g.game.renderer.cameraCtl.reset(sim);
      }, kind);
      await t.wait(2500);
      await t.shot(`chase-${kind}`);
    }
  }

  if (PARTS.includes('street')) {
    // A street of standing cars in the traffic mix, ahead of the player's sedan in both lanes out to 150 m, seen from
    // the chase camera; measured on each tier.
    await t.game((g) => {
      const sim = g.sim;
      const st = window.__street;
      const mix = ['sedan', 'compact', 'sedan', 'taxi', 'pickup', 'sedan', 'van', 'compact', 'muscle', 'sedan', 'compact', 'pickup', 'taxi', 'sedan', 'van', 'compact', 'sports', 'sedan', 'bus', 'compact'];
      const palette = [0x2e86c1, 0xc0392b, 0xf2f3f4, 0x1c2833, 0x7f8c8d, 0x1e8449, 0xb9770e, 0x8e44ad];
      let n = 0;
      for (let d = 9; d <= 150; d += 7.5) {
        for (const lane of [0, 3.6]) {
          const kind = mix[n % mix.length];
          const v = sim.spawnVehicle(kind, st.x + d + (lane ? 3 : 0), st.z + lane, lane ? -Math.PI / 2 : Math.PI / 2, palette[n % palette.length]);
          v.persistent = true;
          v.missionTag = 'street';
          n++;
        }
      }
      if (!sim.player.vehicle || sim.player.vehicle.kind !== 'sedan') {
        for (const v of [...sim.vehicles]) if (v.missionTag === 'look') sim.removeVehicle(v);
        const v = sim.spawnVehicle('sedan', st.x, st.z, st.heading, window.__stage.colors.sedan);
        v.missionTag = 'look';
        v.persistent = true;
        if (sim.player.vehicle) sim.playerCtl.ejectPlayer(true);
        sim.seat(sim.player, v, 0);
        v.usedByPlayer = true;
      }
      window.__fixed = null;
      g.game.renderer.cameraCtl.reset(sim);
      g.setCamera(Math.PI / 2, -0.05);
    });
    for (const tier of ['high', 'medium', 'low']) {
      await t.game((g, tier) => g.game.applySettings({ ...g.game.settings, quality: tier }, false), tier);
      await t.wait(2500);
      await t.measure(`street-${tier}`, 3000);
      await t.snap(`street-${tier}`);
      await t.shot(`street-${tier}`);
    }
    await t.game((g) => g.game.applySettings({ ...g.game.settings, quality: 'high' }, false));
  }
  if (PARTS.includes('ride')) {
    // The bikes on the street and the speedboat at the Marina, from the chase camera at rest.
    for (const kind of ['sportbike', 'scooter', 'speedboat']) {
      await t.game((g, kind) => {
        const sim = g.sim;
        for (const v of [...sim.vehicles]) if (v.missionTag === 'look') sim.removeVehicle(v);
        window.__fixed = null;
        if (sim.player.vehicle) sim.playerCtl.ejectPlayer(true);
        for (const v of [...sim.vehicles]) if (v.missionTag === 'street') sim.removeVehicle(v);
        let v;
        if (kind === 'speedboat') {
          const b = sim.world.layout.props.find((p) => p.kind === 'boat');
          g.teleport(b.x + 13, b.z - 6);
          v = sim.spawnVehicle(kind, b.x + 13, b.z, 0.4);
        } else {
          const st = window.__street;
          g.teleport(st.x, st.z - 5.2);
          v = sim.spawnVehicle(kind, st.x, st.z, st.heading, window.__stage.colors[kind]);
        }
        v.missionTag = 'look';
        v.persistent = true;
        sim.seat(sim.player, v, 0);
        v.usedByPlayer = true;
        g.game.renderer.cameraCtl.reset(sim);
      }, kind);
      await t.wait(3000);
      await t.shot(`chase-${kind}`);
    }
  }

  if (PARTS.includes('dent')) {
    // The sedan's tail after a rear-end hit (an 8 cm dent in the middle of it), from behind.
    await t.game((g) => {
      if (g.sim.player.vehicle) g.sim.playerCtl.ejectPlayer(true);
      g.teleport(window.__stage.x, window.__stage.z);
    });
    await t.wait(1500);
    await t.game(stage, 'sedan', 'rear', false);
    await t.game((g) => {
      const v = g.sim.vehicles.find((q) => q.missionTag === 'look');
      v.dents.push({ lx: 0.1, ly: v.spec.height * 0.45, lz: -v.spec.length / 2 + 0.05, nx: 0, nz: 1, depth: 0.08 });
      v.dentVersion++;
    });
    await t.wait(900);
    await t.shot('sedan-rear-dented');
  }
  await t.snap('end');
}
