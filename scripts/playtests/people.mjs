// What the people look like from where a player sees them: his own character from behind at the camera's five metres,
// standing, walking and running side-on, aiming; a line-up of every kind of person five metres off and again at
// seventeen; a driver through his car's glass; a street's crowd at ten to forty metres.
//
//   node scripts/playtest.mjs --script scripts/playtests/people.mjs --out /tmp/people
//
// The same appearances every run (they are given, not drawn), so two builds' shots compare figure for figure.

const key = (page, code, down) =>
  page.evaluate(([code, down]) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key', '').toLowerCase(), bubbles: true })), [code, down]);

export default async function (t) {
  await t.boot();
  await t.newGame();
  await t.game((g) => {
    g.godMode(true);
    g.setClockRate(0);
    g.setTime(11);
    // Nobody else in the frame: the streets' own people are let go and none come.
    const sim = g.sim;
    sim.ambient = false;
    for (const c of [...sim.characters]) if (!c.isPlayer && !c.vehicle) sim.removeCharacter(c);
    for (const v of [...sim.vehicles]) if (v.driver && Math.hypot(v.pos.x - sim.player.pos.x, v.pos.z - sim.player.pos.z) < 120) sim.removeVehicle(v);
  });
  await t.wait(1500);
  const view = async (yaw, pitch, name, ms = 700) => {
    await t.game((g, y, p) => g.setCamera(y, p), yaw, pitch);
    await t.wait(ms);
    await t.shot(name);
  };
  // His own character, where he stands.
  await view(0, -0.05, 'player-back');
  await view(Math.PI, -0.05, 'player-front');
  await view(Math.PI / 2, -0.05, 'player-side');
  await view(Math.PI * 0.8, -0.02, 'player-three-quarter');
  // Walking and running across the view (D turns him to the camera's right).
  await t.game((g) => g.setCamera(0, -0.05));
  await key(t.page, 'KeyD', true);
  await t.wait(900);
  await t.shot('walk-side');
  await key(t.page, 'ShiftLeft', true);
  await t.wait(900);
  await t.shot('run-side');
  await key(t.page, 'ShiftLeft', false);
  await key(t.page, 'KeyD', false);
  // And away from it.
  await key(t.page, 'KeyW', true);
  await t.wait(900);
  await t.shot('walk-back');
  await key(t.page, 'ShiftLeft', true);
  await t.wait(900);
  await t.shot('run-back');
  await key(t.page, 'ShiftLeft', false);
  await key(t.page, 'KeyW', false);
  await t.wait(600);
  // A pistol held, then aimed over the shoulder.
  await t.game((g) => g.give('pistol', 60));
  await t.wait(500);
  await view(Math.PI * 0.75, -0.02, 'pistol-held');
  await t.game((g) => g.setCamera(0, -0.02));
  await t.page.mouse.move(800, 450);
  await t.page.mouse.down({ button: 'right' });
  await t.wait(700);
  await t.shot('aim');
  await t.page.mouse.up({ button: 'right' });
  await t.game((g) => {
    g.sim.player.inventory.current = 'fists';
  });

  // The line-up: every kind of person, five metres ahead, facing him.
  await t.game((g) => {
    const sim = g.sim;
    const p = sim.player;
    g.setCamera(0, -0.03);
    const looks = [
      ['civilian', { skin: 0xf1c27d, shirt: 0xc0392b, pants: 0x2c3e50, hair: 0x3b2a1a, hat: 0, height: 0.92, build: 0.9 }],
      ['civilian', { skin: 0x8d5524, shirt: 0xecf0f1, pants: 0x5d4037, hair: 0x1a1a1a, hat: 0, height: 1.0, build: 1.0 }],
      ['civilian', { skin: 0xffdbac, shirt: 0x27ae60, pants: 0x1a1a1a, hair: 0xd9c36a, hat: 0xf39c12, height: 1.06, build: 1.14 }],
      ['civilian', { skin: 0x5c3a1e, shirt: 0xf1c40f, pants: 0x7b7d7d, hair: 0x8a8a8a, hat: 0, height: 0.96, build: 1.08 }],
      ['cop', { skin: 0xe0ac69, shirt: 0x1f3a93, pants: 0x101a3a, hair: 0x3b2a1a, hat: 0x0d1b4c, height: 1.02, build: 1.06 }],
      ['swat', { skin: 0xc68642, shirt: 0x1c2833, pants: 0x17202a, hair: 0x111111, hat: 0x111111, height: 1.04, build: 1.18 }],
      ['gang', { skin: 0xd8a47f, shirt: 0x0e7c7b, pants: 0x1b1b1b, hair: 0x1a1a1a, hat: 0x0e7c7b, height: 1.0, build: 1.1 }],
      ['mission', { skin: 0xc68642, shirt: 0x8e44ad, pants: 0x34495e, hair: 0x5a2d0c, hat: 0, height: 0.98, build: 0.95 }],
      ['civilian', { skin: 0xe0ac69, shirt: 0xe84393, pants: 0x154360, hair: 0x6b4423, hat: 0, height: 0.94, build: 0.92 }],
      ['civilian', { skin: 0xd8a47f, shirt: 0x16a085, pants: 0xa0826d, hair: 0xb5651d, hat: 0, height: 1.02, build: 0.98 }],
    ];
    window.__lineup = looks.map(([role, look], i) => {
      const c = sim.spawnCharacter(role, p.pos.x + (i - 4.5) * 0.9, p.pos.z + 5, look);
      c.heading = Math.PI;
      c.owner = 'mission';
      c.persistent = true;
      return c.id;
    });
  });
  await t.wait(1200);
  await t.shot('lineup-5m');
  await t.game((g) => {
    const p = g.sim.player;
    g.teleport(p.pos.x, p.pos.z - 12);
    g.setCamera(0, -0.03);
  });
  await t.wait(1200);
  await t.shot('lineup-17m');
  await t.game((g) => {
    const sim = g.sim;
    for (const c of [...sim.characters]) if (window.__lineup.includes(c.id)) sim.removeCharacter(c);
  });

  // At the wheel: a car standing across the view four metres off, its driver and a passenger seen through the glass,
  // and the player in his own from the chase camera.
  await t.game((g) => {
    const sim = g.sim;
    const p = sim.player;
    g.setCamera(0, -0.03);
    const v = sim.spawnVehicle('sedan', p.pos.x, p.pos.z + 4.2, Math.PI / 2, 0xc9d3da);
    v.persistent = true;
    const d = sim.spawnCharacter('civilian', v.pos.x, v.pos.z, { skin: 0xe0ac69, shirt: 0xc0392b, pants: 0x2c3e50, hair: 0x3b2a1a, hat: 0, height: 1.0, build: 1.0 });
    sim.seat(d, v, 0);
    const q = sim.spawnCharacter('civilian', v.pos.x, v.pos.z, { skin: 0x8d5524, shirt: 0xf1c40f, pants: 0x1a1a1a, hair: 0x1a1a1a, hat: 0x2980b9, height: 0.95, build: 0.95 });
    sim.seat(q, v, 1);
    window.__car = v.id;
  });
  await t.wait(1500);
  await t.shot('riders-side');
  await t.game((g) => {
    const sim = g.sim;
    const v = sim.vehicles.find((o) => o.id === window.__car);
    if (v) sim.removeVehicle(v);
    g.spawnVehicle('sedan', true);
    g.setCamera(0, -0.05);
  });
  await t.wait(1500);
  await t.shot('driver-chase');
  await key(t.page, 'KeyF', true);
  await t.wait(100);
  await key(t.page, 'KeyF', false);
  await t.wait(2500);

  // A street's crowd at the distances it is met at.
  await t.game((g) => {
    g.sim.ambient = true;
    g.setTime(17);
    const b = g.poi('bank');
    g.teleport(b.x, b.z);
    g.sim.populate?.();
    g.setCamera(Math.PI / 2, -0.02);
  });
  await t.wait(7000);
  await t.shot('street-a');
  await view(-Math.PI / 2, -0.02, 'street-b', 1500);
  await t.snap('end');
}
