// How the people move, on video: his own character jogging and sprinting across the view and away from it, setting off,
// stopping and turning; people walking and running past side-on at seven metres; five walking the pavement towards the
// camera and away from it; a group standing about.
//
//   node scripts/playtest.mjs --video --script scripts/playtests/people-motion.mjs --out /tmp/people-motion
//
// report.json's notes give each segment's start in seconds from the first note, to cut the video by.

const key = (page, code, down) =>
  page.evaluate(([code, down]) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key', '').toLowerCase(), bubbles: true })), [code, down]);

const LOOKS = [
  { skin: 0xf1c27d, shirt: 0xc0392b, pants: 0x2c3e50, hair: 0x3b2a1a, hat: 0, height: 0.96, build: 0.95 },
  { skin: 0x8d5524, shirt: 0xecf0f1, pants: 0x5d4037, hair: 0x1a1a1a, hat: 0, height: 1.0, build: 1.0 },
  { skin: 0xffdbac, shirt: 0x27ae60, pants: 0x1a1a1a, hair: 0xd9c36a, hat: 0xf39c12, height: 1.04, build: 1.1 },
  { skin: 0x5c3a1e, shirt: 0xf1c40f, pants: 0x7b7d7d, hair: 0x8a8a8a, hat: 0, height: 0.97, build: 1.05 },
  { skin: 0xe0ac69, shirt: 0xe84393, pants: 0x154360, hair: 0x6b4423, hat: 0, height: 0.94, build: 0.92 },
  { skin: 0xd8a47f, shirt: 0x16a085, pants: 0xa0826d, hair: 0xb5651d, hat: 0, height: 1.02, build: 0.98 },
];

export default async function (t) {
  const t0 = Date.now();
  const mark = (label) => {
    t.note?.(`${label} @ ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    console.log(`mark ${label} ${((Date.now() - t0) / 1000).toFixed(2)}`);
  };
  await t.boot();
  await t.newGame();
  await t.game((g) => {
    g.godMode(true);
    g.setClockRate(0);
    g.setTime(11);
    const sim = g.sim;
    sim.ambient = false;
    for (const c of [...sim.characters]) if (!c.isPlayer && !c.vehicle) sim.removeCharacter(c);
    for (const v of [...sim.vehicles]) if (v.driver && Math.hypot(v.pos.x - sim.player.pos.x, v.pos.z - sim.player.pos.z) < 120) sim.removeVehicle(v);
    window.__home = { x: sim.player.pos.x, z: sim.player.pos.z };
    g.setCamera(0, -0.05);
  });
  await t.wait(1500);

  // His own character: standing, then jogging (his ordinary pace) across the view, stopping, sprinting back.
  mark('player-stand');
  await t.wait(2000);
  mark('player-jog-side');
  await key(t.page, 'KeyD', true);
  await t.wait(3000);
  await key(t.page, 'KeyD', false);
  mark('player-stop');
  await t.wait(1500);
  mark('player-sprint-side');
  await key(t.page, 'KeyA', true);
  await key(t.page, 'ShiftLeft', true);
  await t.wait(3000);
  await key(t.page, 'ShiftLeft', false);
  await key(t.page, 'KeyA', false);
  await t.wait(1200);
  // Away from the camera: jog, then sprint.
  await t.game((g) => {
    g.teleport(window.__home.x, window.__home.z);
    g.sim.player.heading = 0;
    g.setCamera(0, -0.05);
  });
  await t.wait(800);
  mark('player-jog-away');
  await key(t.page, 'KeyW', true);
  await t.wait(2500);
  mark('player-sprint-away');
  await key(t.page, 'ShiftLeft', true);
  await t.wait(2500);
  await key(t.page, 'ShiftLeft', false);
  await key(t.page, 'KeyW', false);
  await t.wait(1200);
  // Setting off and stopping: short taps.
  await t.game((g) => {
    g.teleport(window.__home.x, window.__home.z);
    g.sim.player.heading = 0;
    g.setCamera(0, -0.05);
  });
  await t.wait(800);
  mark('player-taps');
  for (const k of ['KeyD', 'KeyA', 'KeyD']) {
    await key(t.page, k, true);
    await t.wait(450);
    await key(t.page, k, false);
    await t.wait(900);
  }
  // Turning: right, then back left, then towards the camera and away again.
  mark('player-turns');
  for (const k of ['KeyD', 'KeyA', 'KeyS', 'KeyW']) {
    await key(t.page, k, true);
    await t.wait(700);
    await key(t.page, k, false);
    await t.wait(500);
  }
  await t.wait(800);

  // People walking past side-on, seven metres from the camera, the player out of the frame, back where he started.
  await t.game((g) => {
    g.teleport(window.__home.x, window.__home.z);
    g.sim.player.heading = 0;
  });
  await t.wait(800);
  await t.game((g, looks) => {
    const sim = g.sim;
    const p = sim.player;
    g.game.renderer.crowd.hiddenId = p.id;
    g.setCamera(0, -0.05);
    window.__walkers = [];
    const add = (i, x, z, heading, speed) => {
      const c = sim.spawnCharacter('civilian', x, z, looks[i % looks.length]);
      c.brain = null;
      c.owner = 'mission';
      c.persistent = true;
      c.heading = heading;
      c.moveX = Math.sin(heading);
      c.moveZ = Math.cos(heading);
      c.moveSpeed = speed;
      window.__walkers.push(c.id);
      return c;
    };
    window.__add = add;
    window.__clear = () => {
      for (const c of [...sim.characters]) if (window.__walkers.includes(c.id)) sim.removeCharacter(c);
      window.__walkers = [];
    };
    // Across the view (to the camera's left, +x at yaw 0).
    add(0, p.pos.x - 7, p.pos.z + 2.5, Math.PI / 2, 1.45);
  }, LOOKS);
  mark('npc-walk-side');
  await t.wait(9000);
  await t.game((g) => {
    window.__clear();
    const p = g.sim.player;
    window.__add(1, p.pos.x - 8, p.pos.z + 2.5, Math.PI / 2, 1.9);
  });
  mark('npc-brisk-side');
  await t.wait(7500);
  await t.game((g) => {
    window.__clear();
    const p = g.sim.player;
    window.__add(2, p.pos.x - 14, p.pos.z + 3.5, Math.PI / 2, 6.3);
  });
  mark('npc-run-side');
  await t.wait(4000);
  // Five on the pavement: three coming towards the camera, two going away.
  await t.game((g) => {
    window.__clear();
    const p = g.sim.player;
    window.__add(0, p.pos.x - 1.2, p.pos.z + 22, Math.PI, 1.45);
    window.__add(3, p.pos.x + 0.6, p.pos.z + 26, Math.PI, 1.35);
    window.__add(4, p.pos.x + 1.8, p.pos.z + 19, Math.PI, 1.55);
    window.__add(1, p.pos.x - 0.4, p.pos.z + 1.5, 0, 1.45);
    window.__add(5, p.pos.x + 1.1, p.pos.z + 3, 0, 1.4);
  });
  mark('npc-pavement');
  await t.wait(12000);
  // A group standing about.
  await t.game((g) => {
    window.__clear();
    const p = g.sim.player;
    const spots = [[-1.6, 4.5, 2.6], [-0.5, 5.2, 3.3], [0.6, 4.4, -2.8], [1.5, 5.4, -2.2], [0.1, 6.4, 3.0], [2.4, 3.8, 3.6]];
    spots.forEach(([dx, dz, h], i) => window.__add(i, p.pos.x + dx, p.pos.z + dz, h, 0));
  });
  mark('npc-idle');
  await t.wait(7000);
  mark('end');
  await t.snap('end');
}
