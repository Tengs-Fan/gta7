// Gravel Gulch (world/country/places.ts): the dirt track's ribbon, the berms banked up round the outside of its turns,
// the whoops and the tabletops (their ramps and decks are the sim's ground: rampHeight and the decks), the flag gates
// round a lap, the banner over the start line, and the drive in from the highway with its sign. Only drawn: riders pass
// through the berms and the flags. The dirt (the ribbon, the berms, the jumps and the drive) is packed dirt with the other
// places' (kit.dirt); the rest is the track's piece of the places' atlas.

import { prism } from '../city/rooftops';
import { boxC, face, tri, type V } from '../city/attractions';
import type { GeoBuilder, RGB } from '../geo';
import type { CountryView } from './index';
import { DIRT_Y, type PlacesKit } from './kit';
import { SIGN_GLOW } from './town';

/** The berms round the turns: how far out from the track's edge they rise to their crest, its height, and their foot. */
const BERM_CREST = 1.4;
const BERM_HEIGHT = 1.1;
const BERM_OUT = 3.5;

const WHITE: RGB = [1, 1, 1];

/** The quad a..d of dirt facing `toward`, its texture laid on it from above (on the walls, along them and up). */
function dirt(g: GeoBuilder, a: V, b: V, c: V, d: V, toward: V, scale: number): void {
  const wall = Math.abs(toward[1]) < 0.5;
  const uv = (v: V) => (wall ? [(v[0] + v[2]) / scale, v[1] / scale] : [v[0] / scale, v[2] / scale]);
  face(g, a, b, c, d, toward, WHITE, [a, b, c, d].flatMap(uv));
}

export function buildTrack(view: CountryView, kit: PlacesKit): void {
  const L = view.world.layout;
  const t = L.country.places.track;
  const p = kit.place('gravel-gulch');
  const uv = { kind: 'world', scale: view.city.ground.tile('plain') } as const;
  const half = t.width / 2;

  // The ribbon: a quad between each two points of the centre line, its edges square to the line.
  const right = (i: number) => {
    const a = t.line[Math.max(0, i - 1)]!;
    const b = t.line[Math.min(t.line.length - 1, i + 1)]!;
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    return { x: -(b.z - a.z) / l, z: (b.x - a.x) / l };
  };
  for (let i = 0; i + 1 < t.line.length; i++) {
    const a = t.line[i]!;
    const b = t.line[i + 1]!;
    const ra = right(i);
    const rb = right(i + 1);
    dirt(kit.dirt, [a.x - ra.x * half, DIRT_Y, a.z - ra.z * half], [a.x + ra.x * half, DIRT_Y, a.z + ra.z * half], [b.x + rb.x * half, DIRT_Y, b.z + rb.z * half], [b.x - rb.x * half, DIRT_Y, b.z - rb.z * half], [0, 1, 0], uv.scale);
  }
  const d = t.drive;
  kit.dirt.flat(d.minX, d.minZ, d.maxX, d.maxZ, DIRT_Y, uv);

  // The berms: banked dirt round the outside of each turn, up from its edge to a crest and down again.
  for (const turn of t.turns) {
    const span = Math.atan2(Math.sin(turn.a1 - turn.a0), Math.cos(turn.a1 - turn.a0));
    const n = 12;
    const at = (a: number, r: number, y: number): V => [turn.cx + Math.cos(a) * r, y, turn.cz + Math.sin(a) * r];
    const r0 = turn.r + half;
    for (let k = 0; k < n; k++) {
      const a = turn.a0 + (span * k) / n;
      const b = turn.a0 + (span * (k + 1)) / n;
      dirt(kit.dirt, at(a, r0, DIRT_Y), at(b, r0, DIRT_Y), at(b, r0 + BERM_CREST, BERM_HEIGHT), at(a, r0 + BERM_CREST, BERM_HEIGHT), [0, 1, 0], uv.scale);
      dirt(kit.dirt, at(a, r0 + BERM_CREST, BERM_HEIGHT), at(b, r0 + BERM_CREST, BERM_HEIGHT), at(b, r0 + BERM_OUT, 0), at(a, r0 + BERM_OUT, 0), [0, 1, 0], uv.scale);
    }
  }

  // The whoops' and the tables' faces: each ramp's slope in dirt, its sides closed down to the ground.
  for (const id of t.ramps) {
    const r = L.ramps[id]!;
    const fx = Math.sin(r.heading);
    const fz = Math.cos(r.heading);
    const sx = Math.cos(r.heading);
    const sz = -Math.sin(r.heading);
    const hw = r.width / 2;
    const hl = r.length / 2;
    const P = (along: number, side: number, y: number): V => [r.x + fx * along + sx * side, y, r.z + fz * along + sz * side];
    dirt(kit.dirt, P(-hl, -hw, DIRT_Y + 0.01), P(-hl, hw, DIRT_Y + 0.01), P(hl, hw, r.height), P(hl, -hw, r.height), [0, 1, 0], uv.scale);
    for (const side of [-1, 1]) dirt(kit.dirt, P(-hl, side * hw, 0), P(hl, side * hw, 0), P(hl, side * hw, r.height), P(-hl, side * hw, DIRT_Y + 0.01), [side * sx, 0, side * sz], uv.scale);
  }
  for (const r of t.tables) {
    const y = L.decks.find((q) => q.rect === r)!.y;
    dirt(kit.dirt, [r.minX, y, r.maxZ], [r.maxX, y, r.maxZ], [r.maxX, y, r.minZ], [r.minX, y, r.minZ], [0, 1, 0], uv.scale);
    for (const x of [r.minX, r.maxX]) dirt(kit.dirt, [x, 0, r.minZ], [x, 0, r.maxZ], [x, y, r.maxZ], [x, y, r.minZ], [x < (r.minX + r.maxX) / 2 ? -1 : 1, 0, 0], uv.scale);
  }

  // The flag gates: a pole either side of the track, a pennant on each, red then yellow round the lap.
  t.gates.forEach((g, k) => {
    const c = t.line[g.at]!;
    const n = right(g.at);
    for (const side of [-1, 1]) {
      const x = c.x + n.x * side * (half + 0.8);
      const z = c.z + n.z * side * (half + 0.8);
      prism(p.plain, x, z, 0.05, 0.05, 0, 3.2, 6, [0.85, 0.85, 0.85]);
      const flag: RGB = k % 2 === 0 ? [0.85, 0.12, 0.1] : [0.95, 0.78, 0.1];
      tri(p.plain, [x, 3.2, z], [x, 2.4, z], [x + n.x * side * 0.9, 2.8, z + n.z * side * 0.9], [n.z, 0, -n.x], flag);
      tri(p.plain, [x, 2.4, z], [x, 3.2, z], [x + n.x * side * 0.9, 2.8, z + n.z * side * 0.9], [-n.z, 0, n.x], flag);
    }
  });

  // The banner over the start line on two tall poles, and the sign where the drive leaves the highway.
  const banner = kit.atlas.band(128, (ctx) => {
    const glow = ctx.canvas !== kit.atlas.canvas;
    ctx.fillStyle = glow ? '#000' : '#1c1c1c';
    ctx.fillRect(0, 0, 1024, 128);
    for (let x = 0; x < 1024 && !glow; x += 64) {
      ctx.fillStyle = (x / 64) % 2 === 0 ? '#f2f2f2' : '#1c1c1c';
      ctx.fillRect(x, 0, 64, 16);
      ctx.fillStyle = (x / 64) % 2 === 1 ? '#f2f2f2' : '#1c1c1c';
      ctx.fillRect(x, 112, 64, 16);
    }
    if (glow) ctx.globalAlpha = SIGN_GLOW;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffb21e';
    ctx.font = '700 84px Anton, Impact, "Arial Black", sans-serif';
    ctx.fillText('GRAVEL GULCH', 512, 66, 980);
  }, true);
  const s0 = t.line[0]!;
  for (const side of [-1, 1]) boxC(p.plain, s0.x - 0.15, 0, s0.z + side * (half + 1) - 0.15, s0.x + 0.15, 6.4, s0.z + side * (half + 1) + 0.15, [0.3, 0.3, 0.32]);
  kit.board(p, banner, t.width + 2, 1.4, s0.x - 0.05, 5.6, s0.z, -Math.PI / 2);
  kit.board(p, banner, t.width + 2, 1.4, s0.x + 0.05, 5.6, s0.z, Math.PI / 2);
  const sign = kit.atlas.band(192, (ctx) => {
    ctx.fillStyle = '#e8d9b0';
    ctx.fillRect(0, 0, 1024, 192);
    ctx.strokeStyle = '#5a3a1a';
    ctx.lineWidth = 10;
    ctx.strokeRect(8, 8, 1008, 176);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#5a3a1a';
    ctx.font = '700 80px Anton, Impact, "Arial Black", sans-serif';
    ctx.fillText('GRAVEL GULCH', 512, 66, 980);
    ctx.font = '700 40px Anton, Impact, "Arial Black", sans-serif';
    ctx.fillText('DIRT TRACK · TWO LAPS AGAINST THE CLOCK · RIDE AT YOUR OWN RISK', 512, 142, 980);
  });
  const sx = d.minX - 3;
  const sz = d.minZ + 3;
  for (const dx of [-1.6, 1.6]) boxC(p.plain, sx + dx - 0.08, 0, sz - 0.08, sx + dx + 0.08, 2.6, sz + 0.08, [0.36, 0.25, 0.14]);
  kit.board(p, sign, 4, 0.75, sx, 2.2, sz - 0.1, Math.PI);
}
