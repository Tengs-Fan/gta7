// The city's buildings and pavements as a player sees them, from fixed spots so two builds can be compared shot for shot:
// in seven districts, a building of the district's usual style is found by rule, and the player stands on the pavement
// before its street wall, facing it, looking along the street and looking across it, by day (11:00); two of the spots
// again at night (21:00); every view along a street again on Medium, and one spot on Low. Every shot is followed by a snapshot (draw calls and triangles
// in report.json); the notes list them as a table.
//
//   node scripts/playtest.mjs --script scripts/playtests/streetscape.mjs --out /tmp/streetscape
//
// With --swiftshader the run is the software tier (only the first spot is shot). STREETSCAPE_ONLY=midtown,hillcrest
// shoots only those spots by day, for a quick look.

/** District, style of the building to face, and a short name for the files. */
const SPOTS = [
  ['downtown', 'glassBlue', 'downtown'],
  ['midtown', 'stucco', 'midtown'],
  ['southgate', 'brick', 'southgate'],
  ['docks', 'warehouse', 'docks'],
  ['hillcrest', 'house', 'hillcrest'],
  ['westside', 'house', 'westside'],
  ['beachfront', 'hotel', 'beach'],
  ['westside', 'brick', 'westside-brick'],
];

const ONLY = process.env.STREETSCAPE_ONLY?.split(',') ?? null;

export default async function (t) {
  await t.boot();
  await t.newGame();
  const software = (await t.state()).render.software;
  await t.game((g) => {
    g.godMode(true);
    g.game.applySettings({ ...g.game.settings, quality: 'high' }, false);
    g.setClockRate(0);
    g.setTime(11);
    g.setWeather('clear', { instant: true });
  });
  await t.wait(1500);
  const rows = [];
  /** Stands on the pavement before the street wall of the n-th building of a district and style; returns the yaw facing it. */
  const stand = (district, style, n = 0) =>
    t.game(
      (g, a) => {
        const L = g.sim.world.layout;
        const cands = L.buildings.filter((b) => b.district === a.district && b.style === a.style && b.groundSides.length > 0 && b.rect.maxX - b.rect.minX > 8);
        cands.sort((p, q) => p.id - q.id);
        const b = cands[Math.floor(cands.length / 2) + a.n];
        const side = b.groundSides[0];
        const blk = L.blocks.find((k) => b.rect.minX >= k.rect.minX - 0.01 && b.rect.maxX <= k.rect.maxX + 0.01 && b.rect.minZ >= k.rect.minZ - 0.01 && b.rect.maxZ <= k.rect.maxZ + 0.01);
        const cx = (b.rect.minX + b.rect.maxX) / 2;
        const cz = (b.rect.minZ + b.rect.maxZ) / 2;
        // 2.6 m in from the kerb: on the pavement, between the street furniture and the shop fronts.
        const k = 2.6;
        const spot = {
          S: { x: cx, z: blk.rect.maxZ - k, yaw: Math.PI },
          N: { x: cx, z: blk.rect.minZ + k, yaw: 0 },
          E: { x: blk.rect.maxX - k, z: cz, yaw: -Math.PI / 2 },
          W: { x: blk.rect.minX + k, z: cz, yaw: Math.PI / 2 },
        }[side];
        g.teleport(spot.x, spot.z);
        return spot.yaw;
      },
      { district, style, n },
    );
  const shoot = async (name, yaw, pitch) => {
    await t.game((g, a) => g.setCamera(a.yaw, a.pitch), { yaw, pitch });
    await t.wait(1600);
    await t.shot(name);
    const s = await t.snap(name);
    rows.push(`${name}\tcalls ${s.render.calls}\ttris ${s.render.triangles}\tfps ${s.fps}`);
  };
  const spots = software ? SPOTS.slice(0, 1) : ONLY ? SPOTS.filter((s) => ONLY.includes(s[2])) : SPOTS;
  for (const [district, style, name] of spots) {
    const yaw = await stand(district, style);
    await shoot(`${name}-facade`, yaw, 0.18);
    await shoot(`${name}-along`, yaw + Math.PI / 2, 0.06);
    await shoot(`${name}-across`, yaw + Math.PI, 0.08);
  }
  if (!software && !ONLY) {
    await t.game((g) => g.setTime(21));
    await t.wait(1500);
    for (const [district, style, name] of [SPOTS[1], SPOTS[5]]) {
      const yaw = await stand(district, style);
      await shoot(`${name}-night-facade`, yaw, 0.18);
      await shoot(`${name}-night-along`, yaw + Math.PI / 2, 0.06);
    }
    await t.game((g) => g.setTime(11));
    // Medium is the tier an integrated GPU runs: every street view again on it.
    await t.game((g) => g.game.applySettings({ ...g.game.settings, quality: 'medium' }, false));
    await t.wait(1500);
    for (const [district, style, name] of SPOTS) {
      const yaw = await stand(district, style);
      await shoot(`${name}-along-medium`, yaw + Math.PI / 2, 0.06);
    }
    await t.game((g) => g.game.applySettings({ ...g.game.settings, quality: 'low' }, false));
    await t.wait(1500);
    const yaw = await stand('midtown', 'stucco');
    await shoot('midtown-facade-low', yaw, 0.18);
  }
  t.note(rows.join('\n'));
}
