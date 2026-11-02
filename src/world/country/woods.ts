// Pinewood and the valley's north (world/country/lakeland.ts): the pine forest on Pine Rise and the plot with the dirt
// track that climbs into it, the fire lookout tower on the rise's top with its telescope and plaque, and the wild country
// between the Valley Loop's lake and its north side: scattered pines and oaks thinning toward the lake, boulders and
// wildflower patches. Coyote Pass gets a welcome sign and a few boulders at its west mouth.

import { Rng } from '../../core/rng';
import { smoothstep } from '../../core/math';
import { mkRect, rectContains, type CityLayout, type Rect } from '../layout';
import { countryGround, PASS_Z } from './index';
import { blocked, dryLand, lakeGap, laneThrough, loopX, NORTH_VALLEY, prop, roadGap, valueNoise, type Boulder, type CountyLakeland, type FireTower, type FlowerHue, type Keepout } from './lakeland';

/** Pine Rise's top: the fire lookout tower's frame, four posts 5 m apart, a cab on a deck 15 m up. */
export const PINE_TOWER: FireTower = { x: -1710, z: -300, half: 2.5, cab: 15, top: 18.6, post: 0.26 };

/** The gravel pad round the tower's foot, where the track ends. */
const TOWER_PAD = mkRect(-1722, -314, -1698, -288);

/** The dirt track's centre line from the Valley Loop's east side into Pinewood: out across the meadow, in under the pines and up the rise's north slope. */
function trackCorners(): number[] {
  return [loopX(-345) + 5 - 0.3, -345, -1795, -350, -1765, -372, -1745, -404, -1722, -421, -1704, -399, -1699, -372, -1706, -346, -1712, -321];
}
const TRACK_WIDTH = 4.2;

/** The forest's cell (m): a pine in a cell about as often as the glades allow. */
const PINE_CELL = 5.2;
/** The valley's scatter grid (m). */
const SCATTER_CELL = 11;

export function buildWoods(layout: CityLayout, land: CountyLakeland, rng: Rng, keep: Keepout): void {
  const country = layout.country;
  const solids = country.places.solids;
  const ground = (x: number, z: number) => countryGround(country, x, z);
  const plot = (id: string) => country.plots.find((p) => p.id === id)!.rect;
  const pinewood = plot('pinewood');
  const vineyard = plot('vineyard');
  const ranch = plot('ranch');
  const passPlot = plot('pass');
  const lakePlot = plot('lake');

  // The tower and its pad, the telescope and the plaque at its foot facing the lake.
  const t = PINE_TOWER;
  land.tower = t;
  land.pads.push(TOWER_PAD);
  const top = ground(t.x, t.z);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) solids.push({ rect: mkRect(t.x + sx * t.half - t.post, t.z + sz * t.half - t.post, t.x + sx * t.half + t.post, t.z + sz * t.half + t.post), y0: top, y1: top + t.cab, tag: 'pillar', round: true });
  solids.push({ rect: mkRect(t.x - t.half - 0.3, t.z - t.half - 0.3, t.x + t.half + 0.3, t.z + t.half + 0.3), y0: top + t.cab, y1: top + t.top, tag: 'wall' });
  land.telescope = { x: t.x - 6.5, z: t.z + 2.2, rot: -Math.PI / 2 };
  land.plaque = { x: t.x - 6.5, z: t.z - 2.4, rot: -Math.PI / 2 };

  // The track in, with its sign where it leaves the road.
  const track = laneThrough(trackCorners(), TRACK_WIDTH);
  land.lanes.push(track);
  keep.lines.push({ pts: track.pts, r: TRACK_WIDTH / 2 + 2.5 });
  keep.rects.push(mkRect(TOWER_PAD.minX - 4, TOWER_PAD.minZ - 4, TOWER_PAD.maxX + 4, TOWER_PAD.maxZ + 4));
  land.signs.push({ id: 'pinewood', x: loopX(-335) + 5 + 3.5, z: -335, rot: -Math.PI / 2, lines: ['PINEWOOD', 'FIRE LOOKOUT 300 M', 'ONLY YOU CAN PREVENT FOREST FIRES.', 'NO PRESSURE.'] });

  // Coyote Pass's west mouth: the valley's welcome to traffic coming out of the pass.
  land.signs.push({ id: 'welcome', x: -1606, z: PASS_Z - 12.5, rot: Math.PI / 2, lines: ['LAS LOMAS VALLEY', 'LAKE · PINES · NO SIGNAL'] });
  keep.rects.push(mkRect(-1612, PASS_Z - 15, -1600, PASS_Z - 10));

  land.labels.push({ name: 'Lake Lomas Campground', x: land.camp.fire.x, z: land.camp.fire.z + 18 }, { name: 'Pinewood Lookout', x: t.x, z: t.z + 24 });

  // Boulders: a few at each place, then scattered through the open valley and along the lake's shore.
  const boulder = (x: number, z: number, size: number): void => {
    const b: Boulder = { x, y: ground(x, z), z, size, yaw: rng.range(0, Math.PI * 2), variant: rng.int(0, 2), tint: rng.next() };
    land.boulders.push(b);
    solids.push({ rect: mkRect(x - size * 0.42, z - size * 0.42, x + size * 0.42, z + size * 0.42), y0: b.y - 0.2, y1: b.y + size * 0.75, tag: 'rock', round: true });
  };
  const spot = (x: number, z: number, size: number): boolean => {
    if (roadGap(x, z) < 6 + size || blocked(keep, x, z, size * 0.6) || ground(x, z) < 0.02 || !dryLand(layout, x, z, 3)) return false;
    boulder(x, z, size);
    return true;
  };
  // The pass: three at the foot of its north wall by the sign.
  for (const [x, z, s] of [[-1600, PASS_Z - 17, 1.8], [-1596, PASS_Z - 14.5, 1.1], [-1613, PASS_Z - 18.5, 2.2]] as const) boulder(x, z, s);
  // Round the tower pad, and beside the track.
  for (const [dx, dz, s] of [[-12, -15, 2.4], [12, 14, 1.7], [-10, 17, 1.3]] as const) spot(t.x + dx, t.z + dz, s);
  // Along the lake's shore, singly and in pairs, just above the beach.
  for (let tries = 0, n = 0; tries < 400 && n < 12; tries++) {
    const x = rng.range(lakePlot.minX - 20, lakePlot.maxX + 8);
    const z = rng.range(lakePlot.minZ - 20, lakePlot.maxZ + 10);
    const gap = lakeGap(x, z);
    const size = rng.range(0.9, 2.8);
    if (gap < 9 || gap > 16 || !spot(x, z, size)) continue;
    n++;
    if (rng.chance(0.5)) spot(x + rng.range(-2.5, 2.5), z + rng.range(-2.5, 2.5), size * rng.range(0.4, 0.7));
  }
  // The open valley: clusters of two or three, and now and then a big one.
  for (let tries = 0, n = 0; tries < 800 && n < 12; tries++) {
    const x = rng.range(NORTH_VALLEY.minX + 20, NORTH_VALLEY.maxX - 20);
    const z = rng.range(NORTH_VALLEY.minZ + 20, NORTH_VALLEY.maxZ - 50);
    if (rectContains(vineyard, x, z, 10) || rectContains(pinewood, x, z, 6) || rectContains(lakePlot, x, z, 20)) continue;
    const size = rng.chance(0.2) ? rng.range(3, 3.8) : rng.range(1, 2.6);
    if (!spot(x, z, size)) continue;
    n++;
    for (let k = rng.int(0, 2); k > 0; k--) spot(x + rng.range(-4, 4), z + rng.range(-4, 4), size * rng.range(0.35, 0.7));
  }

  // The forest: a pine in most cells of Pinewood, thinning at its edge and in the glades, and bushes under them.
  land.forest.first = layout.props.length;
  const inner = (x: number, z: number) => Math.min(x - pinewood.minX, pinewood.maxX - x, z - pinewood.minZ, pinewood.maxZ - z);
  const pine = (x: number, z: number, big: number): void => {
    prop(layout, 'pine', x, z, rng.range(0, Math.PI * 2), rng.range(0.72, 1.18) * big);
    land.forest.pines++;
  };
  for (let gx = pinewood.minX + PINE_CELL / 2; gx < pinewood.maxX; gx += PINE_CELL) {
    for (let gz = pinewood.minZ + PINE_CELL / 2; gz < pinewood.maxZ; gz += PINE_CELL) {
      const x = gx + rng.range(-2.1, 2.1);
      const z = gz + rng.range(-2.1, 2.1);
      const glade = smoothstep(0.2, 0.42, valueNoise(x, z, 38, 11));
      const edge = 0.35 + 0.65 * smoothstep(2, 22, inner(x, z));
      const p = 0.88 * glade * edge;
      const roll = rng.next();
      const size = rng.range(0.9, 1.15);
      if (roll > p || inner(x, z) < 1.5 || roadGap(x, z) < 8 || blocked(keep, x, z, 1.2) || !dryLand(layout, x, z, 2)) continue;
      pine(x, z, size * (0.9 + 0.35 * valueNoise(x, z, 90, 12)));
      if (rng.chance(0.14)) prop(layout, 'bush', x + rng.range(-2.4, 2.4), z + rng.range(-2.4, 2.4), rng.range(0, 6.28), rng.range(0.8, 1.2));
    }
  }

  // The valley's north: pines and oaks scattered thinning toward the lake, more of the pines toward Pinewood.
  const farPlot = (r: Rect, x: number, z: number, m: number) => rectContains(r, x, z, m);
  for (let gx = NORTH_VALLEY.minX + SCATTER_CELL / 2; gx < NORTH_VALLEY.maxX; gx += SCATTER_CELL) {
    for (let gz = NORTH_VALLEY.minZ + SCATTER_CELL / 2; gz < NORTH_VALLEY.maxZ; gz += SCATTER_CELL) {
      const x = gx + rng.range(-5, 5);
      const z = gz + rng.range(-5, 5);
      const roll = rng.next();
      const which = rng.next();
      const size = rng.next();
      if (farPlot(pinewood, x, z, 0) || farPlot(vineyard, x, z, 14) || farPlot(ranch, x, z, 14) || farPlot(passPlot, x, z, 0)) continue;
      const lake = lakeGap(x, z);
      const grove = valueNoise(x, z, 75, 21);
      const p = smoothstep(24, 150, lake) * smoothstep(0.12, 0.5, grove);
      if (roll > p || roadGap(x, z) < 9 || blocked(keep, x, z, 2.5) || !dryLand(layout, x, z, 5)) continue;
      const toWood = Math.max(0, pinewood.minX - x, x - pinewood.maxX, pinewood.minZ - z, z - pinewood.maxZ);
      if (which < 0.5 + 0.4 * smoothstep(300, 40, toWood)) prop(layout, 'pine', x, z, rng.range(0, Math.PI * 2), 0.8 + size * 0.5);
      else {
        prop(layout, 'tree', x, z, rng.range(0, Math.PI * 2), 1 + size * 0.34);
        const bx = x + rng.range(-3, 3);
        const bz = z + rng.range(-3, 3);
        if (rng.chance(0.5) && roadGap(bx, bz) >= 8) prop(layout, 'bush', bx, bz, rng.range(0, 6.28), rng.range(0.8, 1.25));
      }
    }
  }
  // A few oaks for shade by the cabins, the camp and the dock's pull-out.
  const shade: ReadonlyArray<readonly [number, number]> = [[-1976, -318], [-1948, -347], [-1921, -345], [-1897, -347], [-1866, -330], [-1890, -306], [-1940, -176], [-1912, -214], [-1957, -204], [-1850, -296], [-1850, -252], [-1900, -166]];
  for (const [x, z] of shade) {
    if (roadGap(x, z) <= 7 || blocked(keep, x, z, 2) || !dryLand(layout, x, z, 3)) continue;
    prop(layout, 'tree', x, z, rng.range(0, Math.PI * 2), rng.range(1.1, 1.34));
    land.forest.shade++;
  }

  // Wildflowers: patches in the open meadow, bigger out in the valley, small ones by the cabins and the lanes.
  const hues: readonly FlowerHue[] = ['buttercup', 'lupine', 'daisy', 'poppy', 'clover'];
  const patch = (x: number, z: number, r: number, hue: FlowerHue): void => {
    land.flowers.push({ x, z, r, hue, count: Math.round(Math.PI * r * r * 0.5), seed: land.flowers.length + 1 });
  };
  for (let tries = 0, n = 0; tries < 1200 && n < 15; tries++) {
    const x = rng.range(NORTH_VALLEY.minX + 25, NORTH_VALLEY.maxX - 30);
    const z = rng.range(NORTH_VALLEY.minZ + 25, NORTH_VALLEY.maxZ - 40);
    const r = rng.range(8, 17);
    if (farPlot(pinewood, x, z, r) || farPlot(vineyard, x, z, r + 8) || roadGap(x, z) < r + 8 || lakeGap(x, z) < r + 16 || blocked(keep, x, z, r) || !dryLand(layout, x, z, r)) continue;
    if (land.flowers.some((f) => Math.hypot(f.x - x, f.z - z) < f.r + r + 6) || land.boulders.some((b) => Math.hypot(b.x - x, b.z - z) < r)) continue;
    patch(x, z, r, hues[n % hues.length]!);
    n++;
  }
  // Tall golden grass in big loose patches, to break the lawn: the open land is more meadow than mown.
  for (let tries = 0, n = 0; tries < 2000 && n < 16; tries++) {
    const x = rng.range(NORTH_VALLEY.minX + 30, NORTH_VALLEY.maxX - 30);
    const z = rng.range(NORTH_VALLEY.minZ + 30, NORTH_VALLEY.maxZ - 40);
    const r = rng.range(20, 38);
    if (farPlot(pinewood, x, z, r * 0.5) || farPlot(vineyard, x, z, r + 6) || roadGap(x, z) < r + 4 || lakeGap(x, z) < r * 0.5 + 14 || blocked(keep, x, z, r * 0.4) || !dryLand(layout, x, z, r * 0.5)) continue;
    land.flowers.push({ x, z, r, hue: 'grass', count: Math.round(Math.PI * r * r * 0.2), seed: land.flowers.length + 1 });
    n++;
  }
  for (const [x, z, r, hue] of [[-1949, -314, 5.5, 'buttercup'], [-1893, -314, 4.5, 'daisy'], [-1856, -298, 4, 'poppy'], [-1938, -221, 6, 'lupine'], [-1884, -228, 5, 'clover']] as const) {
    if (!blocked(keep, x, z, r * 0.6) && dryLand(layout, x, z, r)) patch(x, z, r, hue);
  }
}
