// The city's set pieces (the pier and its Ferris wheel, the docks' cranes, containers and moored ships, the Azura Bowl,
// the bridges and the causeway, AzuraLink, the SAN AZURA letters, the beach, the Marina and the quays) from fixed
// viewpoints, so two builds can be compared shot for shot: on foot (eye height, a few metres off), from a car's chase
// camera, and from across the water or from high up, where they make the skyline. By day (11:00), six of them again at
// night (21:00), five on Medium and four on Low. Traffic and pedestrians are cleared first so the counts compare, and the
// train's views wait for it to stand at a station. Every shot is followed by a snapshot (draw calls and triangles in
// report.json); the notes list them as a table.
//
//   node scripts/playtest.mjs --script scripts/playtests/setpieces.mjs --out /tmp/setpieces
//
// SETPIECES_ONLY=ferris-near,crane-near shoots only those views, for a quick look, by day or at SETPIECES_HOUR. The camera is held where the
// script puts it (the game's own camera is suspended) and the player stands at the view's `stand` spot, on land.

/** name: camera position, the point it looks at, where the player stands (x, z) and the field of view. */
const VIEWS = {
  // Azura Pier (x 491..692, z 33..47, deck 0.45) and the wheel at its end (hub 28.95 m up at x 672), its axle along x.
  'pier-walk': { pos: [585, 2.2, 38], at: [672, 17, 40], stand: [585, 40] },
  'ferris-near': { pos: [650, 2.2, 36], at: [672, 13, 40], stand: [650, 40] },
  'ferris-quarter': { pos: [640, 2.2, 52], at: [672, 18, 40], stand: [640, 44] },
  'ferris-beach': { pos: [555, 2.4, -40], at: [672, 22, 40], stand: [555, -40] },
  'skyline-sea': { pos: [830, 9, 190], at: [560, 20, 40], stand: [690, 40], fov: 55 },
  // Port Basin's wharf and the three cranes (x -448, -388, -328 at z 384, booms out over the basin to +z).
  'crane-near': { pos: [-372, 1.9, 398], at: [-388, 20, 384], stand: [-372, 386] },
  'docks-car': { pos: [-455, 3.4, 352], at: [-370, 14, 392], stand: [-455, 352] },
  'docks-water': { pos: [-300, 6, 505], at: [-400, 16, 395], stand: [-300, 375], fov: 55 },
  'containers': { container: true },
  // The Azura Bowl (x 120..222, z 383..457).
  'stadium-street': { pos: [118, 3.4, 372], at: [175, 9, 405], stand: [118, 372] },
  'stadium-lot': { pos: [236, 1.9, 470], at: [190, 12, 430], stand: [236, 470] },
  'stadium-high': { pos: [70, 55, 300], at: [172, 4, 420], stand: [110, 372], fov: 55 },
  // The canal's bridges (deck x -191..-159), AzuraLink's beam over them, the bays' bridges and the causeway.
  'bridge-car': { pos: [-218, 3.3, 2], at: [-150, 1.6, 2], stand: [-218, 2] },
  'bridge-bank': { pos: [-197, 2.0, 40], at: [-176, 2, 84], stand: [-197, 40] },
  'canal-along': { pos: [-186, 6, 130], at: [-176, 8, 30], stand: [-196, 130], fov: 55 },
  'bay-bridge': { pos: [215, 2.4, -452], at: [262, 0.5, -470], stand: [215, -452] },
  'causeway': { pos: [-530, 3.4, -264], at: [-640, 1.5, -268], stand: [-530, -264] },
  // AzuraLink: the train standing at a station, and that station's tower and platform.
  'station': { station: true },
  'train': { train: true },
  // The SAN AZURA letters on Hillcrest Green (x 67..111 at z -328), from Coral St below them.
  'hillsign': { pos: [88, 2.2, -266], at: [88, 7, -328], stand: [88, -266] },
  // Ocean Beach's lifeguard towers on the sand, the Marina's slips and boats, the north promenade's quay.
  'beach': { pos: [520, 2.2, 190], at: [585, 1.5, 230], stand: [520, 190] },
  'marina': { pos: [520, 2.4, 438], at: [618, 1, 466], stand: [520, 438] },
  'promenade': { pos: [-10, 1.9, -500], at: [60, 0.5, -512], stand: [-10, -500] },
};

const NIGHT = ['pier-walk', 'skyline-sea', 'docks-water', 'stadium-street', 'canal-along', 'hillsign'];
const MEDIUM = ['skyline-sea', 'docks-car', 'ferris-near', 'containers', 'bridge-car'];
const LOW = ['ferris-near', 'docks-car', 'bridge-car', 'canal-along'];
const ONLY = process.env.SETPIECES_ONLY?.split(',') ?? null;

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

/** Runs in the page: resolves the views placed by rule (an aisle of the container yard, beside the train) and holds the camera there. */
function frame(g, v) {
  const sim = g.sim;
  const L = sim.world.layout;
  let view = v;
  if (v.container) {
    // Beside the middle container of the yard's longest row, 2 m off its side, looking along the row.
    const cs = L.props.filter((p) => p.kind === 'container' && p.y < 1);
    cs.sort((a, b) => a.z - b.z || a.x - b.x);
    const c = cs[Math.floor(cs.length / 2)];
    const alongX = c.w > c.d;
    const off = (alongX ? c.d : c.w) / 2 + 1.8;
    const pos = alongX ? [c.x - 16, 1.8, c.z + off] : [c.x + off, 1.8, c.z - 16];
    const at = alongX ? [c.x + 10, 2.5, c.z - 0.5] : [c.x - 0.5, 2.5, c.z + 10];
    view = { pos, at, stand: [pos[0], pos[2]] };
  }
  if (v.train || v.station) {
    const m = L.monorail;
    const z = g.game.renderer.monorail.train.position.z;
    if (v.train) view = { pos: [m.x - 12 * Math.sign(z || 1), 12.5, z - 18 * Math.sign(z || 1)], at: [m.x, 10.5, z], stand: [m.x - 22, z - 30 * Math.sign(z || 1)] };
    else {
      // The tower of the station the train stands at, from the street on its landward side.
      const s = m.stations.reduce((a, b) => (Math.abs(b.z - z) < Math.abs(a.z - z) ? b : a));
      const t = s.tower;
      const cx = (t.minX + t.maxX) / 2;
      const land = -Math.sign(s.z);
      view = { pos: [cx - 14 * s.side, 1.9, t.minZ + land * 20], at: [cx + 6 * s.side, 8, (t.minZ + t.maxZ) / 2], stand: [cx - 14 * s.side, t.minZ + land * 20] };
    }
  }
  const [sx, sz] = view.stand;
  const p = sim.player;
  p.pos.x = sx;
  p.pos.z = sz;
  p.pos.y = sim.world.groundHeight(sx, sz);
  g.game.renderer.cameraCtl.reset(sim);
  window.__fixed = { pos: view.pos, at: view.at, fov: view.fov ?? 62 };
}

export default async function (t) {
  await t.boot();
  await t.newGame();
  const software = (await t.state()).render.software;
  await t.game((g, hour) => {
    g.godMode(true);
    g.game.applySettings({ ...g.game.settings, quality: 'high' }, false);
    g.setClockRate(0);
    g.setTime(hour);
    g.forceWeather('clear');
    const sim = g.sim;
    sim.ambient = false;
    for (const c of [...sim.characters]) if (!c.isPlayer && !c.vehicle) sim.removeCharacter(c);
    for (const v of [...sim.vehicles]) if (v !== sim.player.vehicle) sim.removeVehicle(v);
  }, Number(process.env.SETPIECES_HOUR ?? 11));
  await t.game(installCamera);
  await t.wait(1500);
  const rows = [];
  const shoot = async (name, key) => {
    await t.game(frame, VIEWS[key]);
    await t.wait(1800);
    await t.shot(name);
    const s = await t.snap(name);
    rows.push(`${name}\tcalls ${s.render.calls}\ttris ${s.render.triangles}\tfps ${s.fps}`);
  };
  /** Waits for the train to pull in at a station (it leaves one first if it stands at one), so 20 s of its dwell are left. */
  const onTrain = (at) =>
    t.page.waitForFunction((want) => {
      const g = window.__gta7;
      const z = g.game.renderer.monorail.train.position.z;
      return g.sim.world.layout.monorail.stations.some((s) => Math.abs(s.z - z) < 0.05) === want;
    }, at, { timeout: 180_000, polling: 100 });
  const keys = software ? ['ferris-near', 'docks-car', 'stadium-high', 'bridge-car'] : ONLY ?? Object.keys(VIEWS);
  for (const k of keys) {
    if (VIEWS[k].train || VIEWS[k].station) {
      if (k === 'station') {
        await onTrain(false);
        await onTrain(true);
      }
    }
    await shoot(k, k);
  }
  if (!software && !ONLY) {
    await t.game((g) => g.setTime(21));
    await t.wait(1500);
    for (const k of NIGHT) await shoot(`${k}-night`, k);
    await t.game((g) => g.setTime(11));
    await t.game((g) => g.game.applySettings({ ...g.game.settings, quality: 'medium' }, false));
    await t.wait(1500);
    for (const k of MEDIUM) await shoot(`${k}-medium`, k);
    await t.game((g) => g.game.applySettings({ ...g.game.settings, quality: 'low' }, false));
    await t.wait(1500);
    for (const k of LOW) await shoot(`${k}-low`, k);
  }
  t.note(rows.join('\n'));
}
