// The city's buildings and pavements as a player sees them, from fixed spots so two builds can be compared shot for shot:
// in seven districts, a building of the district's usual style is found by rule, and the player stands on the pavement
// before its street wall, facing it, looking along the street and looking across it, by day (11:00); two of the spots
// again at night (21:00); every view along a street again on Medium, and one spot on Low. Every shot is followed by a snapshot (draw calls and triangles
// in report.json); the notes list them as a table.
//
//   node scripts/playtest.mjs --script scripts/playtests/streetscape.mjs --out /tmp/streetscape
//
// With --swiftshader the run is the software tier (only the first spot is shot). STREETSCAPE_ONLY=midtown,hillcrest
// shoots only those spots by day, for a quick look. STREETSCAPE_POIS=1 adds the special buildings' fronts (the bank, the
// police, the hospital, the safehouse, the gun shops, Lou's, the Hotel Salgado, a spray shop), four ways from each
// marker, as the round's model audit shot them. By day the run also looks up at the upper floors and roof lines: a glass
// tower of each colour, an office, brick, apartment and house front from the far pavement, every special building from
// across its street, the skyline both ways along a Midtown and a Southgate street, the four tallest towers from a
// street two blocks south, each landmark tower from the east (and its crown through a long lens), the garages, and Downtown and Midtown from eight headings
// (no frame may come out black); at night a car's headlights on a row of shops.

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
const POIS = ['bank', 'police', 'hospital', 'safehouse', 'guns_south', 'lou', 'vera', 'spray_hill', 'guns_west'];

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
    // Upper floors and roof lines: the glass towers, the brick and office blocks and the special buildings from the far
    // pavement looking up, the skyline along a Midtown and a Southgate street, the tallest towers from a street a block off.
    /**
     * Stands on the far pavement of the street before wall `side` of a building (`back` m past the road's far kerb; or
     * `back` m out from the wall where no road runs within 40 m), mid-wall, facing it.
     */
    const facing = (b, back) =>
      t.game(
        (g, a) => {
          const L = g.sim.world.layout;
          const r = L.buildings.find((q) => q.id === a.id).rect;
          const cx = (r.minX + r.maxX) / 2;
          const cz = (r.minZ + r.maxZ) / 2;
          const sgn = a.side === 'S' || a.side === 'E' ? 1 : -1;
          const wall = { S: r.maxZ, N: r.minZ, E: r.maxX, W: r.minX }[a.side];
          const lines = a.side === 'S' || a.side === 'N' ? L.hLines : L.vLines;
          const road = lines.filter((l) => (l.pos - wall) * sgn > 0 && (l.pos - wall) * sgn < 40).sort((p, q) => Math.abs(p.pos - wall) - Math.abs(q.pos - wall))[0];
          const at = road ? road.pos + sgn * (road.width / 2 + a.back) : wall + sgn * 22;
          const spot = {
            S: { x: cx, z: at, yaw: Math.PI },
            N: { x: cx, z: at, yaw: 0 },
            E: { x: at, z: cz, yaw: -Math.PI / 2 },
            W: { x: at, z: cz, yaw: Math.PI / 2 },
          }[a.side];
          g.teleport(spot.x, spot.z);
          return spot.yaw;
        },
        { id: b.id, side: b.side, back },
      );
    /** The n-th building (by id, from the middle) of a district and style with a street wall, and that wall. */
    const pick = (district, style, n = 0, minTiers = 1) =>
      t.game(
        (g, a) => {
          const L = g.sim.world.layout;
          const c = L.buildings.filter((b) => b.district === a.district && b.style === a.style && b.groundSides.length > 0 && b.tiers.length >= a.minTiers).sort((p, q) => p.id - q.id);
          const b = c[Math.floor(c.length / 2) + a.n] ?? c[0];
          return { id: b.id, side: b.groundSides[0] };
        },
        { district, style, n, minTiers },
      );
    const looks = [
      ['tower-blue', 'downtown', 'glassBlue', 0, 3, 0.62],
      ['tower-teal', 'downtown', 'glassTeal', 0, 3, 0.62],
      ['office-mid', 'midtown', 'office', 0, 1, 0.42],
      ['brick-south', 'southgate', 'brick', 1, 1, 0.38],
      ['stucco-mid', 'midtown', 'stucco', 1, 1, 0.38],
      ['house-hill', 'hillcrest', 'house', 2, 1, 0.22],
    ];
    for (const [name, district, style, n, minTiers, pitch] of looks) {
      const b = await pick(district, style, n, minTiers);
      const yaw = await facing(b, 1.5);
      await shoot(`up-${name}`, yaw, pitch);
    }
    for (const id of ['bank', 'police', 'hospital', 'safehouse', 'guns_south', 'vera', 'dex']) {
      const b = await t.game(
        (g, a) => {
          const L = g.sim.world.layout;
          const p = L.pois.find((q) => q.id === a.id);
          const kinds = { bank: 'bank', police: 'police', hospital: 'hospital', safehouse: 'safehouse', guns_south: 'gunshop', vera: 'contactVera', dex: 'contactDex' };
          const near = L.buildings.filter((q) => q.special === kinds[a.id]).sort((u, v) => Math.hypot((u.rect.minX + u.rect.maxX) / 2 - p.x, (u.rect.minZ + u.rect.maxZ) / 2 - p.z) - Math.hypot((v.rect.minX + v.rect.maxX) / 2 - p.x, (v.rect.minZ + v.rect.maxZ) / 2 - p.z))[0];
          if (!near) return null;
          const r = near.rect;
          const dx = Math.max(r.minX - p.x, 0, p.x - r.maxX);
          const dz = Math.max(r.minZ - p.z, 0, p.z - r.maxZ);
          const side = dx > dz ? (p.x > r.maxX ? 'E' : 'W') : p.z > r.maxZ ? 'S' : 'N';
          return { id: near.id, side };
        },
        { id },
      );
      if (!b) continue;
      // The bank's far pavement is under the trees of a plaza: it is shot from the road's far lane.
      const yaw = await facing(b, id === 'bank' ? -1.2 : 1.5);
      await shoot(`bld-${id}`, yaw, id === 'dex' ? 0.6 : 0.36);
    }
    for (const [district, style, name] of [['midtown', 'stucco', 'midtown'], ['southgate', 'brick', 'southgate']]) {
      const yaw = await stand(district, style);
      await shoot(`skyline-${name}`, yaw + Math.PI / 2, 0.3);
      await shoot(`skyline-${name}-back`, yaw - Math.PI / 2, 0.3);
    }
    const tall = await t.game((g) => {
      const L = g.sim.world.layout;
      return L.buildings
        .filter((b) => (b.district === 'downtown' || b.district === 'midtown') && b.roof === 'flat')
        .sort((a, b) => b.height - a.height)
        .slice(0, 4)
        .map((b) => {
          const cx = (b.rect.minX + b.rect.maxX) / 2;
          const line = L.hLines.filter((l) => l.pos > b.rect.maxZ + 110).sort((p, q) => p.pos - q.pos)[0];
          return { x: cx, z: line ? line.pos : b.rect.maxZ + 60 };
        });
    });
    for (const [k, p] of tall.entries()) {
      await t.game((g, a) => g.teleport(a.x, a.z), p);
      await shoot(`tall-${k}`, Math.PI, 0.32);
    }
    // The landmark towers (render/city/landmarks.ts picks them by the same rule, so that each reads from the sea), each
    // from the easternmost avenue at its latitude looking west: the skyline at the usual lens, then its crown through a
    // 12-degree one.
    const lms = await t.game((g) => {
      const L = g.sim.world.layout;
      const cz = (b) => (b.rect.minZ + b.rect.maxZ) / 2;
      const hidden = (b) => L.buildings.some((o) => o !== b && o.rect.minX > b.rect.maxX && o.height >= b.height - 4 && Math.min(o.rect.maxZ, b.rect.maxZ) - Math.max(o.rect.minZ, b.rect.minZ) > 0.5 * (b.rect.maxZ - b.rect.minZ));
      const out = [];
      for (const b of L.buildings.filter((q) => (q.district === 'downtown' || q.district === 'midtown') && q.roof === 'flat' && q.tiers.length > 0).sort((p, q) => q.height - p.height || p.id - q.id)) {
        if (out.length === 4) break;
        if (out.some((o) => Math.abs(cz(o) - cz(b)) < 45) || hidden(b)) continue;
        out.push(b);
      }
      const east = Math.max(...L.vLines.map((l) => l.pos));
      return out.map((b) => ({ x: east, z: cz(b), dist: east - (b.rect.minX + b.rect.maxX) / 2, roof: b.height }));
    });
    for (const [k, lm] of lms.entries()) {
      const kind = ['stepped', 'pyramid', 'crown', 'wedge'][k];
      await t.game((g, a) => g.teleport(a.x, a.z), lm);
      const aim = Math.atan2(lm.roof + 12 - 2, lm.dist);
      await shoot(`lm-${kind}-far`, -Math.PI / 2, Math.min(0.6, aim * 0.6));
      await t.game((g) => (g.game.renderer.cameraCtl.baseFov = 12));
      await shoot(`lm-${kind}-crown`, -Math.PI / 2, aim);
      await t.game((g) => (g.game.renderer.cameraCtl.baseFov = g.game.settings.fov));
    }
    // The garages (Lou's and the Spray Shacks), 12 m out from their doors.
    for (const id of ['lou', 'spray_hill', 'spray_docks', 'spray_south']) {
      const yaw = await t.game(
        (g, a) => {
          const G = g.sim.world.layout.garages.find((q) => q.poi === a.id);
          if (!G) return null;
          const r = G.rect;
          const cx = (r.minX + r.maxX) / 2;
          const cz = (r.minZ + r.maxZ) / 2;
          const spot = { S: [cx, r.maxZ + 12, Math.PI], N: [cx, r.minZ - 12, 0], E: [r.maxX + 12, cz, -Math.PI / 2], W: [r.minX - 12, cz, Math.PI / 2] }[G.side];
          g.teleport(spot[0], spot[1]);
          return spot[2];
        },
        { id },
      );
      if (yaw !== null) await shoot(`garage-${id}`, yaw, 0.12);
    }
    // Downtown and Midtown from eight headings on High: a NaN in a shader or a normal of no length shades a pixel NaN,
    // which the bloom spreads over a rectangle of the frame.
    for (const [district, style, name] of [SPOTS[0], SPOTS[1]]) {
      const yaw = await stand(district, style);
      for (let k = 0; k < 8; k++) await shoot(`heading-${name}-${k}`, yaw + (k * Math.PI) / 4, 0.15);
    }
  }
  if (process.env.STREETSCAPE_POIS === '1') {
    for (const id of POIS) {
      for (const [k, yaw] of [0, Math.PI / 2, Math.PI, -Math.PI / 2].entries()) {
        await t.game((g, a) => {
          const p = g.poi(a.id);
          g.teleport(p.x, p.z);
        }, { id });
        await shoot(`bld-${id}-${k}`, yaw, 0.12);
      }
    }
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
    // Last, as it leaves the player in a car: on High at night, a car's headlights on a row of shops and their doorways'
    // floors, from the car's camera at rest.
    await t.game((g) => {
      g.game.applySettings({ ...g.game.settings, quality: 'high' }, false);
      g.setTime(21);
    });
    await t.wait(1500);
    const face = await stand('midtown', 'stucco');
    const spot = await t.game((g) => ({ x: g.sim.player.pos.x, z: g.sim.player.pos.z }));
    await t.game((g) => g.spawnVehicle('sedan', true));
    // Nose to the shops from the road, 7 m back from the pavement spot, so the pool falls on the doorways.
    await t.game((g, a) => g.place(a.x - Math.sin(a.yaw) * 7, a.z - Math.cos(a.yaw) * 7, a.yaw), { ...spot, yaw: face });
    await t.wait(2500);
    await t.shot('midtown-night-headlights');
  }
  t.note(rows.join('\n'));
}
