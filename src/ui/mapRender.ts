// Top-down map image (pre-rendered once) plus blip drawing, shared by the
// radar and the full-screen map.

import { formatMoney } from '../core/math';
import { activityKinds, getActivity, type Objective } from '../sim/activities';
import { REGATTA_GATE_R, REGATTA_GATES, REGATTA_START } from '../sim/activities/regatta';
import { GANGS, turfZones } from '../sim/gangs';
import type { Marker } from '../sim/interactions';
import { CONTACTS, contactById, findContact } from '../sim/missions/contacts';
import { playerOf, type ViewState } from '../sim/viewState';
import { playerColor } from '../sim/appearance';
import { packageIndex } from '../sim/pickups';
import { BUSINESS_DAILY, BUSINESS_NAME, BUSINESS_PRICE, GARAGE_PRICE, GARAGE_SLOTS } from '../sim/properties';
import { statRows } from '../sim/statRows';
import { HELI_SIGHT } from '../sim/wanted';
import { WATER_Y } from '../world/constants';
import { FIRE_ROAD_W, fireRoadLine } from '../world/country/hills';
import { beachOffsetAt, rectContains } from '../world/layout';
import { foreshoreReach, shores } from '../world/shore';
import type { StaticWorld } from '../world/staticWorld';
import { riseAt, riseBounds, type Rise } from '../world/terrain';

export const MAP_SCALE = 1; // pixels per metre in the pre-rendered image
const PACKAGE_COLOR = '#f5cd80';
const RAMPAGE_COLOR = '#e8402c';

/** Las Lomas County on the map: its beaches, its land, its plots by kind, and its roads by kind. */
const COUNTY_COLORS = { beach: '#cdb77d', land: '#33503a', town: '#3c4147', farm: '#3b5c39', venue: '#4a4438', wild: '#2f4a33' } as const;
const COUNTY_ROAD_COLORS = { highway: '#b0a46a', country: '#9aa1aa' } as const;

export class MapImage {
  readonly canvas: HTMLCanvasElement;
  /** The gang turf tint over the city's rectangle (the only place turf is), drawn over `canvas` at (turfX, turfZ) px. */
  readonly turf: HTMLCanvasElement;
  readonly turfX: number;
  readonly turfZ: number;
  readonly minX: number;
  readonly minZ: number;

  constructor(world: StaticWorld) {
    const b = world.layout.bounds;
    this.minX = b.worldMinX;
    this.minZ = b.worldMinZ;
    const w = Math.ceil((b.worldMaxX - b.worldMinX) * MAP_SCALE);
    const h = Math.ceil((b.worldMaxZ - b.worldMinZ) * MAP_SCALE);
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d')!;
    const X = (x: number) => (x - this.minX) * MAP_SCALE;
    const Z = (z: number) => (z - this.minZ) * MAP_SCALE;
    const rect = (minX: number, minZ: number, maxX: number, maxZ: number, color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(X(minX), Z(minZ), (maxX - minX) * MAP_SCALE, (maxZ - minZ) * MAP_SCALE);
    };
    ctx.fillStyle = '#16384f';
    ctx.fillRect(0, 0, w, h);
    // Land and beach.
    rect(b.landMinX, b.landMinZ, b.beachStartX, b.landMaxZ, '#3b4249');
    const shoreX = b.beachStartX + beachOffsetAt(WATER_Y);
    rect(b.beachStartX, b.landMinZ, shoreX, b.landMaxZ, '#cdb77d');
    const g = ctx.createLinearGradient(X(shoreX), 0, X(b.beachEndX), 0);
    g.addColorStop(0, '#2a6f8c');
    g.addColorStop(1, '#16384f');
    ctx.fillStyle = g;
    ctx.fillRect(X(shoreX), Z(b.landMinZ), (b.beachEndX - shoreX) * MAP_SCALE, (b.landMaxZ - b.landMinZ) * MAP_SCALE);
    // Las Lomas County: the beach out to the waterline round its land, the land, and the plots on it.
    const country = world.layout.country;
    ctx.fillStyle = COUNTY_COLORS.beach;
    for (const r of country.land) {
      ctx.beginPath();
      ctx.roundRect(X(r.minX - 8), Z(r.minZ - 8), (r.maxX - r.minX + 16) * MAP_SCALE, (r.maxZ - r.minZ + 16) * MAP_SCALE, 8 * MAP_SCALE);
      ctx.fill();
    }
    for (const r of country.land) rect(r.minX, r.minZ, r.maxX, r.maxZ, COUNTY_COLORS.land);
    for (const p of country.plots) rect(p.rect.minX, p.rect.minZ, p.rect.maxX, p.rect.maxZ, COUNTY_COLORS[p.kind]);
    // Headlands, and the sea where it comes into the land.
    for (const h of world.layout.headlands) for (const r of h.rects) rect(r.minX, r.minZ, r.maxX, r.maxZ, '#3b4249');
    for (const w of world.layout.water) for (const r of w.rects) rect(r.minX, r.minZ, r.maxX, r.maxZ, '#1a4560');
    // The rocky foreshore off the open sea walls, as ragged as the boulders the city draws (world/shore.ts).
    ctx.fillStyle = '#56524c';
    for (const s of shores(world)) {
      if (s.built) continue;
      const len = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
      const reach = foreshoreReach(s);
      ctx.beginPath();
      ctx.moveTo(X(s.x0), Z(s.z0));
      for (let d = 0; d <= len; d += 3) {
        const o = 0.3 + 0.7 * reach(d);
        ctx.lineTo(X(s.x0 + ((s.x1 - s.x0) * d) / len + s.nx * o), Z(s.z0 + ((s.z1 - s.z0) * d) / len + s.nz * o));
      }
      const o = 0.3 + 0.7 * reach(len);
      ctx.lineTo(X(s.x1 + s.nx * o), Z(s.z1 + s.nz * o));
      ctx.lineTo(X(s.x1), Z(s.z1));
      ctx.closePath();
      ctx.fill();
    }
    // Blocks and ground.
    for (const blk of world.layout.blocks) rect(blk.rect.minX, blk.rect.minZ, blk.rect.maxX, blk.rect.maxZ, '#2c3238');
    const gc: Record<string, string> = { grass: '#2f6a3a', yard: '#35603a', plaza: '#3c4147', parking: '#33373c', dirt: '#4a4438' };
    for (const gp of world.layout.ground) rect(gp.rect.minX, gp.rect.minZ, gp.rect.maxX, gp.rect.maxZ, gc[gp.kind] ?? '#333');
    hillshade(ctx, world, X, Z);
    // Roads.
    for (const s of world.roads.segments) rect(s.minX, s.minZ, s.maxX, s.maxZ, '#9aa1aa');
    for (const n of world.roads.live) rect(n.x - n.halfX, n.z - n.halfZ, n.x + n.halfX, n.z + n.halfZ, '#9aa1aa');
    // The county's roads (over the causeway and the bridge, after their deck below), at their widths, round at the bends.
    const strokeRoads = () => {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'butt';
      for (const { road, nodes } of world.roads.outerRoads) {
        ctx.strokeStyle = COUNTY_ROAD_COLORS[road.kind];
        ctx.lineWidth = road.width * MAP_SCALE;
        ctx.beginPath();
        nodes.forEach((id, k) => {
          const n = world.roads.nodes[id]!;
          if (k === 0) ctx.moveTo(X(n.x), Z(n.z));
          else ctx.lineTo(X(n.x), Z(n.z));
        });
        ctx.stroke();
      }
    };
    // Buildings.
    for (const bd of world.layout.buildings) {
      const tall = bd.height > 40;
      rect(bd.rect.minX, bd.rect.minZ, bd.rect.maxX, bd.rect.maxZ, tall ? '#1d2228' : '#22282e');
    }
    for (const d of world.layout.decks) rect(d.rect.minX, d.rect.minZ, d.rect.maxX, d.rect.maxZ, d.bridge ? '#9aa1aa' : '#7b5a3a');
    strokeRoads();
    // Coyote Ridge's fire road, a gravel track up to Lookout Point.
    ctx.strokeStyle = '#8a7a58';
    ctx.lineWidth = FIRE_ROAD_W * MAP_SCALE;
    ctx.beginPath();
    for (const [k, p] of fireRoadLine(4).entries()) {
      if (k === 0) ctx.moveTo(X(p.x), Z(p.z));
      else ctx.lineTo(X(p.x), Z(p.z));
    }
    ctx.stroke();
    // The turbines' towers: Turbine Row's out at sea, and Coyote Ridge's.
    ctx.fillStyle = '#c9d2da';
    for (const p of world.layout.props) {
      if (p.kind !== 'turbine') continue;
      ctx.beginPath();
      ctx.arc(X(p.x), Z(p.z), 4 * MAP_SCALE, 0, Math.PI * 2);
      ctx.fill();
    }
    // AzuraLink: a thin teal line down the canal between its stations' platforms.
    const m = world.layout.monorail;
    rect(m.x - 1.2, m.stations[0]!.platform[0]!.minZ, m.x + 1.2, m.stations[1]!.platform[0]!.maxZ, '#0aa5ad');
    for (const s of m.stations) for (const r of [...s.platform, s.tower]) rect(r.minX, r.minZ, r.maxX, r.maxZ, '#0aa5ad');
    this.turf = document.createElement('canvas');
    this.turfX = Math.floor(X(b.cityMinX));
    this.turfZ = Math.floor(Z(b.cityMinZ));
    this.turf.width = Math.ceil(X(b.cityMaxX)) - this.turfX;
    this.turf.height = Math.ceil(Z(b.cityMaxZ)) - this.turfZ;
    drawTurf(this.turf.getContext('2d')!, world, (x) => X(x) - this.turfX, (z) => Z(z) - this.turfZ);
  }
}

/** Metres between the hillshade's samples. */
const SHADE_CELL = 2;

/**
 * Hillshade over the rises, the city's and Las Lomas County's, in one pass over their bounds: the ground darkens with its
 * slope, most where it faces away from a light in the north-west (top left), and lightens a little where it faces the
 * light, so the hill, the bluff, Coyote Ridge and the foothills read as relief; the bluff's cliffs come out as a dark rim.
 */
function hillshade(ctx: CanvasRenderingContext2D, world: StaticWorld, X: (x: number) => number, Z: (z: number) => number): void {
  for (const rises of [world.layout.rises, world.layout.country.rises]) hillshadeOf(ctx, rises, X, Z);
}

function hillshadeOf(ctx: CanvasRenderingContext2D, rises: readonly Rise[], X: (x: number) => number, Z: (z: number) => number): void {
  const h = (x: number, z: number) => riseAt(rises, x, z);
  for (const r of rises) {
    const b = riseBounds(r);
    for (let z = b.minZ; z < b.maxZ; z += SHADE_CELL) {
      for (let x = b.minX; x < b.maxX; x += SHADE_CELL) {
        const mx = x + SHADE_CELL / 2;
        const mz = z + SHADE_CELL / 2;
        if (h(mx, mz) <= 0) continue;
        const gx = (h(mx + 1, mz) - h(mx - 1, mz)) / 2;
        const gz = (h(mx, mz + 1) - h(mx, mz - 1)) / 2;
        // Facing away from the light (> 0) or towards it (< 0).
        const away = -(gx + gz) / Math.SQRT2;
        const dark = Math.min(0.6, 0.35 * Math.hypot(gx, gz) + 1.6 * Math.max(0, away));
        const lit = Math.min(0.25, 0.9 * Math.max(0, -away));
        ctx.fillStyle = lit > dark ? `rgba(255,255,255,${lit.toFixed(3)})` : `rgba(0,0,0,${dark.toFixed(3)})`;
        ctx.fillRect(X(x), Z(z), SHADE_CELL * MAP_SCALE, SHADE_CELL * MAP_SCALE);
      }
    }
  }
}

/** Gang turf on the map: each gang's zones tinted and outlined in its colour, its name over its largest zone. */
function drawTurf(ctx: CanvasRenderingContext2D, world: StaticWorld, X: (x: number) => number, Z: (z: number) => number): void {
  const zones = turfZones(world.layout);
  ctx.save();
  for (const t of zones) {
    const g = GANGS[t.turf.gang];
    const w = (t.maxX - t.minX) * MAP_SCALE;
    const h = (t.maxZ - t.minZ) * MAP_SCALE;
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = g.mapColor;
    ctx.fillRect(X(t.minX), Z(t.minZ), w, h);
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = g.mapColor;
    ctx.lineWidth = 4;
    ctx.setLineDash([14, 8]);
    ctx.strokeRect(X(t.minX) + 2, Z(t.minZ) + 2, w - 4, h - 4);
  }
  ctx.setLineDash([]);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 30px sans-serif';
  for (const gang of Object.keys(GANGS) as Array<keyof typeof GANGS>) {
    const mine = zones.filter((t) => t.turf.gang === gang);
    const big = mine.sort((a, b) => (b.maxX - b.minX) * (b.maxZ - b.minZ) - (a.maxX - a.minX) * (a.maxZ - a.minZ))[0];
    if (!big) continue;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = GANGS[gang].mapColor;
    // Above the middle, clear of the district name the map writes there.
    ctx.fillText(GANGS[gang].name.toUpperCase(), X((big.minX + big.maxX) / 2), Z(big.minZ + (big.maxZ - big.minZ) * 0.28));
  }
  ctx.restore();
}

/**
 * 'pip': a small dot (officers on foot); 'ring': a hollow circle (a collectible already found); 'player': another player;
 * 'arrow': you; 'zone' and 'area': gang turf and the police search area, drawn as areas on the map and so only in the legend.
 */
export type BlipShape = 'circle' | 'square' | 'dot' | 'pip' | 'ring' | 'player' | 'arrow' | 'zone' | 'area';

export interface Blip {
  x: number;
  z: number;
  /** Its kind (blipKind), which the legend and a hover name. */
  kind: string;
  color: string;
  label: string;
  /** Keep on the radar rim when out of range. */
  sticky: boolean;
  shape: BlipShape;
  /** The map legend category that can hide it (see MAP_CATEGORIES); absent: always shown. */
  category?: string;
  /** What a hover on the full map says after its kind's name: the place's own name, a price, the job on offer. */
  detail?: string;
  /** An arrow's heading on the screen, clockwise from up (radians). */
  angle?: number;
}

/**
 * A kind of icon on the map and the radar: how it is drawn and what its legend row and a hover call it. Every blip has
 * one, so nothing appears on the map that the legend cannot name, and no two kinds look alike (unit-tested).
 */
export interface BlipKind {
  name: string;
  color: string;
  /** A letter, or one of BLIP_ICONS' names, drawn on it; '' for none. */
  label: string;
  shape: BlipShape;
  /** The legend category that can hide it (MAP_CATEGORIES); absent: a live marker, always shown. */
  category?: string;
}

/** Property icons: grey while for sale, green once owned. */
const FOR_SALE = '#9aa3ad';
const OWNED = '#3fd96b';

/**
 * The kinds with an icon of their own: the layout's POIs by their kind (the bank, the Marina and the contacts' places
 * have none), interaction markers' icons (Marker.blip), the collectibles and the live markers. Contacts, activity sites
 * and gang turf are kinds through their own tables (blipKind). Systems that add more register theirs (registerBlipKind).
 */
const KINDS: Record<string, BlipKind> = {
  safehouse: { name: 'Safehouse (save)', color: '#4aa8ff', label: 'house', shape: 'circle', category: 'places' },
  hospital: { name: 'Hospital', color: '#ff4a4a', label: '+', shape: 'circle', category: 'places' },
  police: { name: 'Police station', color: '#3a6bff', label: 'P', shape: 'circle', category: 'places' },
  monorail: { name: 'AzuraLink station', color: '#0aa5ad', label: 'M', shape: 'circle', category: 'places' },
  gunshop: { name: 'Gun shop', color: '#ff8a1f', label: 'G', shape: 'circle', category: 'shops' },
  spray: { name: 'Spray Shack', color: '#3fd96b', label: 'S', shape: 'circle', category: 'shops' },
  customs: { name: 'Azura Customs', color: '#b36bff', label: 'wrench', shape: 'circle', category: 'shops' },
  garage: { name: 'Safehouse garage (for sale)', color: FOR_SALE, label: 'garage', shape: 'circle', category: 'properties' },
  garageOwned: { name: 'Safehouse garage (owned)', color: OWNED, label: 'garage', shape: 'circle', category: 'properties' },
  business: { name: `${BUSINESS_NAME} (for sale)`, color: FOR_SALE, label: '$', shape: 'circle', category: 'properties' },
  businessOwned: { name: `${BUSINESS_NAME} (owned)`, color: OWNED, label: '$', shape: 'circle', category: 'properties' },
  package: { name: 'Hidden package', color: PACKAGE_COLOR, label: 'parcel', shape: 'square', category: 'collectibles' },
  packageFound: { name: 'Hidden package (found)', color: PACKAGE_COLOR, label: '', shape: 'ring', category: 'collectibles' },
  rampage: { name: 'Rampage', color: RAMPAGE_COLOR, label: 'R', shape: 'circle', category: 'collectibles' },
  rampageDone: { name: 'Rampage (done)', color: RAMPAGE_COLOR, label: '', shape: 'ring', category: 'collectibles' },
  you: { name: 'You', color: '#ffffff', label: '', shape: 'arrow' },
  waypoint: { name: 'Waypoint', color: '#c04fff', label: 'W', shape: 'circle' },
  // Objectives come in their own colours; the legend shows the commonest.
  objective: { name: 'Objective', color: '#ffd23d', label: '', shape: 'circle' },
  target: { name: 'Objective (person or vehicle)', color: '#ffd23d', label: '', shape: 'square' },
  fare: { name: 'Hailing your taxi', color: '#3dd9ff', label: '', shape: 'pip' },
  player: { name: 'Another player', color: '#ffffff', label: '', shape: 'player' },
  // The police flash red and blue.
  policeUnit: { name: 'Police unit', color: '#ff3030', label: '', shape: 'dot' },
  officer: { name: 'Police officer on foot', color: '#ff3030', label: '', shape: 'pip' },
  heli: { name: 'Police helicopter', color: '#3060ff', label: '', shape: 'square' },
  searchArea: { name: 'Police search area', color: '#ff3030', label: '', shape: 'area' },
};

export function registerBlipKind(id: string, kind: BlipKind): void {
  KINDS[id] = kind;
}

// Not the objective yellow: the legend's fixed rows already use that for mission and job markers.
const ACTIVITY_COLOR = '#00e5ff';

/** Kind `id`'s look and name: KINDS', a contact's ('contact:lou'), an activity site's ('activity:regatta') or a gang's turf ('turf:halcones'). */
export function blipKind(id: string): BlipKind {
  const [table, key = ''] = id.split(':');
  const c = table === 'contact' ? findContact(key) : undefined;
  const site = table === 'activity' ? getActivity(key)?.site : undefined;
  const gang = table === 'turf' ? GANGS[key as keyof typeof GANGS] : undefined;
  const k = c
    ? { name: `${c.name} (missions)`, color: c.color, label: c.mapLabel, shape: 'circle' as const, category: 'missions' }
    : site
      ? { name: site.name, color: ACTIVITY_COLOR, label: site.label, shape: 'circle' as const, category: 'activities' }
      : gang
        ? { name: `${gang.name} turf`, color: gang.mapColor, label: '', shape: 'zone' as const, category: 'turf' }
        : KINDS[id];
  if (!k) throw new Error(`Unknown blip kind "${id}"`);
  return k;
}

/** Every kind, in the legend's order. */
export function blipKindIds(): string[] {
  return [
    ...CONTACTS.map((c) => `contact:${c.id}`),
    ...Object.keys(KINDS),
    ...Object.keys(GANGS).map((g) => `turf:${g}`),
    ...activityKinds().filter((k) => getActivity(k)?.site).map((k) => `activity:${k}`),
  ];
}

/** A blip of kind `kind` at (x, z), as the kind draws it unless `over` says otherwise (the police's flash, a player's colour). */
export function blipOf(kind: string, x: number, z: number, over: Partial<Blip> = {}): Blip {
  const k = blipKind(kind);
  return { x, z, kind, color: k.color, label: k.label, shape: k.shape, category: k.category, sticky: false, ...over };
}

/** A map legend category the player can switch off and on: its header and its icons' rows. */
export interface MapCategory {
  id: string;
  label: string;
  /** More blips of its own (collectibles, activity sites); POIs and markers come in by their kinds. */
  blips?(sim: ViewState, localPlayerId: number): Blip[];
  /** Kinds it draws as areas rather than blips (turf): the legend lists them whenever it lists the category. */
  areas?(): string[];
}

/** The legend's categories in order. Systems add theirs (turf) with registerMapCategory. */
export const MAP_CATEGORIES: MapCategory[] = [];

export function registerMapCategory(c: MapCategory): void {
  if (MAP_CATEGORIES.some((x) => x.id === c.id)) throw new Error(`Map category "${c.id}" is already registered`);
  MAP_CATEGORIES.push(c);
}

export function unregisterMapCategory(id: string): boolean {
  const i = MAP_CATEGORIES.findIndex((c) => c.id === id);
  if (i < 0) return false;
  MAP_CATEGORIES.splice(i, 1);
  return true;
}

registerMapCategory({ id: 'missions', label: 'Missions' });
registerMapCategory({ id: 'shops', label: 'Shops' });
registerMapCategory({ id: 'places', label: 'Places' });
registerMapCategory({ id: 'properties', label: 'Properties' });
registerMapCategory({ id: 'turf', label: 'Gang turf', areas: () => Object.keys(GANGS).map((g) => `turf:${g}`) });
registerMapCategory({
  id: 'collectibles',
  label: 'Collectibles',
  blips: (sim, localPlayerId) => {
    const prog = playerOf(sim, localPlayerId).progress;
    const out: Blip[] = [];
    for (const p of sim.pickups) {
      if (p.removed) continue;
      if (p.kind === 'package') out.push(blipOf(prog.packages.includes(packageIndex(p.tag)) ? 'packageFound' : 'package', p.pos.x, p.pos.z));
      else if (p.kind === 'rampage') out.push(blipOf(prog.rampages.includes(p.tag) ? 'rampageDone' : 'rampage', p.pos.x, p.pos.z));
    }
    return out;
  },
});
registerMapCategory({
  id: 'activities',
  label: 'Activities',
  blips: (sim, localPlayerId) => {
    const me = playerOf(sim, localPlayerId);
    return activityKinds().flatMap((kind) => {
      const def = getActivity(kind)!;
      if (!def.site) return [];
      // What the player has done of it, as the checklist counts it, and his best time.
      const row = def.completion?.(sim, me);
      const best = def.site.best ? statRows().find((r) => r.id === def.site!.best)?.value({ sim, player: me }) : undefined;
      const detail = [row ? `${row.label}: ${row.done} / ${row.total}` : '', best && best !== '-' ? `best ${best}` : ''].filter(Boolean).join(' · ');
      const at = def.site.at(sim.world);
      return [blipOf(`activity:${kind}`, at.x, at.z, { detail: detail || undefined })];
    });
  },
});

/**
 * The legend's rows: under each category, the kinds among `blips` (the map's, its hidden categories' included) and its
 * areas; then the live markers among them and `live` (those always listed); each in blipKindIds order.
 */
export function legendRows(blips: readonly Blip[], live: readonly string[]): Array<{ category: MapCategory | null; kinds: string[] }> {
  const shown = new Set([...blips.map((b) => b.kind), ...live, ...MAP_CATEGORIES.flatMap((c) => c.areas?.() ?? [])]);
  const ids = blipKindIds().filter((id) => shown.has(id));
  return [
    ...MAP_CATEGORIES.map((c) => ({ category: c, kinds: ids.filter((id) => blipKind(id).category === c.id) })),
    { category: null, kinds: ids.filter((id) => !blipKind(id).category) },
  ];
}

/** What a hover on an interaction marker's icon says after its name. */
function markerDetail(sim: ViewState, m: Marker): string | undefined {
  if (m.blip === 'garage') return `${formatMoney(GARAGE_PRICE)} · stores ${GARAGE_SLOTS} cars`;
  if (m.blip === 'business') return `${formatMoney(BUSINESS_PRICE)} · pays ${formatMoney(BUSINESS_DAILY)} a day`;
  if (m.kind === 'monorail') return `${sim.world.layout.monorail.stations[Number(m.ref)]!.name} station`;
  return undefined;
}

export interface BlipOptions {
  /** The full-screen map: collectibles and the categories' own blips too. */
  map?: boolean;
  /** Categories switched off in the map legend: their blips are left out. */
  hidden?: ReadonlySet<string>;
}

export function collectBlips(sim: ViewState, time: number, localPlayerId = 0, opts: BlipOptions = {}): Blip[] {
  const out: Blip[] = [];
  // Under the places and the contacts' offers, so that a package or a job beside one never hides it (a package on Azura
  // Customs, Lou's export board).
  if (opts.map) for (const c of MAP_CATEGORIES) if (c.blips) out.push(...c.blips(sim, localPlayerId));
  for (const p of sim.world.layout.pois) {
    // A POI kind with an icon is a kind of its own (KINDS); the hover names the place.
    if (!(p.kind in KINDS)) continue;
    out.push(blipOf(p.kind, p.x, p.z, { detail: blipKind(p.kind).name.startsWith(p.name) ? undefined : p.name }));
  }
  // Places a marker carries an icon for (the properties, Azura Customs, AzuraLink).
  for (const m of sim.interactions.markers) if (m.blip) out.push(blipOf(m.blip, m.x, m.z, { detail: markerDetail(sim, m) }));
  if (!sim.missions.active) {
    for (const d of sim.missions.offers()) {
      const contact = contactById(d.giver);
      const poi = sim.world.layout.pois.find((q) => q.id === contact.poiId)!;
      out.push(blipOf(`contact:${contact.id}`, poi.x, poi.z, { sticky: true, detail: `Mission: ${d.title}` }));
    }
  }
  const objectives: Objective[] = [...(sim.missions.active?.markers ?? []), ...sim.activities.objectives()];
  for (const o of objectives) {
    const t = o.vehicle ?? o.character;
    const x = t ? t.pos.x : o.x;
    const z = t ? t.pos.z : o.z;
    out.push(blipOf(t ? 'target' : 'objective', x, z, { color: '#' + o.color.toString(16).padStart(6, '0'), sticky: true, detail: o.label || undefined }));
  }
  // Pedestrians waving down the taxi you drive, small.
  const me = playerOf(sim, localPlayerId).character;
  if (me.vehicle?.kind === 'taxi' && me.vehicle.driver === me) {
    for (const c of sim.characters) if (c.hailTimer > 0 && c.owner === 'ped' && c.alive && !c.removed) out.push(blipOf('fare', c.pos.x, c.pos.z));
  }
  out.push(...otherPlayerBlips(sim, localPlayerId));
  if (playerOf(sim, localPlayerId).wanted.level > 0) {
    const blink = Math.floor(time * 4) % 2 === 0;
    for (const v of sim.vehicles) if (v.owner === 'police' && !v.removed && !v.destroyed) out.push(blipOf('policeUnit', v.pos.x, v.pos.z, { color: blink ? '#ff3030' : '#3060ff' }));
    // Every officer on foot too, smaller.
    for (const c of sim.characters) if (c.isLaw && c.alive && !c.removed && c.state !== 'inVehicle') out.push(blipOf('officer', c.pos.x, c.pos.z, { color: blink ? '#ff3030' : '#3060ff' }));
    for (const h of sim.helis) if (!h.removed) out.push(blipOf('heli', h.pos.x, h.pos.z, { color: blink ? '#3060ff' : '#ff3030' }));
  }
  const hidden = opts.hidden;
  return hidden && hidden.size > 0 ? out.filter((b) => !b.category || !hidden.has(b.category)) : out;
}

/**
 * Multiplayer: every other player as a diamond in his colour with his initial, kept on the radar's rim when out of
 * range. Single player has only the local player, so none.
 */
export function otherPlayerBlips(sim: ViewState, localPlayerId: number): Blip[] {
  const out: Blip[] = [];
  for (const pl of sim.players) {
    if (pl.id === localPlayerId || pl.slot === undefined || pl.slot < 0) continue;
    const c = pl.character;
    if (c.removed || c.id === 0) continue;
    const at = pl.pos();
    const color = '#' + playerColor(pl.slot).toString(16).padStart(6, '0');
    out.push(blipOf('player', at.x, at.z, { color, label: (pl.name ?? '').trim().charAt(0).toUpperCase(), sticky: true, detail: pl.name || undefined }));
  }
  return out;
}

/** The police search area while the stars flash (null while they see the player, or he is not wanted). */
export function searchArea(sim: ViewState, localPlayerId = 0): { x: number; z: number; r: number } | null {
  const w = playerOf(sim, localPlayerId).wanted;
  if (w.level === 0 || !w.searching) return null;
  return { x: w.lastSeenX, z: w.lastSeenZ, r: w.searchRadius() };
}

/** Helicopter sighting range shown on the radar and map from 3 stars (see WantedSystem.heliSees). */
export const HELI_SIGHT_RANGE = HELI_SIGHT;

/**
 * Police overlay drawn in map-image space (a context transformed so one unit is one pixel of the map
 * image): the search area pulsing red with a red/blue outline, and from 3 stars a faint ring around each
 * helicopter. `pxPerUnit` is the screen size of one map pixel, so outlines keep their screen width.
 */
export function drawPoliceOverlay(ctx: CanvasRenderingContext2D, sim: ViewState, map: { minX: number; minZ: number }, time: number, pxPerUnit: number, localPlayerId = 0): void {
  const area = searchArea(sim, localPlayerId);
  if (area) {
    ctx.beginPath();
    ctx.arc((area.x - map.minX) * MAP_SCALE, (area.z - map.minZ) * MAP_SCALE, area.r * MAP_SCALE, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 48, 48, ${(0.18 + 0.06 * Math.sin(time * Math.PI * 2 * 1.5)).toFixed(3)})`;
    ctx.fill();
    ctx.lineWidth = 2.5 / pxPerUnit;
    ctx.strokeStyle = Math.floor(time * 4) % 2 === 0 ? '#ff3030' : '#3060ff';
    ctx.stroke();
  }
  if (playerOf(sim, localPlayerId).wanted.level >= 3) {
    ctx.lineWidth = 1.5 / pxPerUnit;
    ctx.strokeStyle = 'rgba(150, 190, 255, 0.4)';
    for (const h of sim.helis) {
      if (h.removed || h.destroyed) continue;
      ctx.beginPath();
      ctx.arc((h.pos.x - map.minX) * MAP_SCALE, (h.pos.z - map.minZ) * MAP_SCALE, HELI_SIGHT_RANGE * MAP_SCALE, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/**
 * The Gull Regatta's course while the player sails it, drawn in map-image space as drawPoliceOverlay is: the gates still
 * ahead (from the start line until the start) joined by a dashed line, each ringed.
 */
export function drawRegattaCourse(ctx: CanvasRenderingContext2D, sim: ViewState, map: { minX: number; minZ: number }, pxPerUnit: number): void {
  const j = sim.activities.job;
  if (j?.kind !== 'regatta') return;
  const ahead = j.stage === 'racing' ? REGATTA_GATES.slice(j.gate) : [REGATTA_START, ...REGATTA_GATES];
  const X = (x: number) => (x - map.minX) * MAP_SCALE;
  const Z = (z: number) => (z - map.minZ) * MAP_SCALE;
  ctx.save();
  ctx.strokeStyle = 'rgba(80, 241, 209, 0.9)';
  ctx.lineWidth = 2.5 / pxPerUnit;
  ctx.setLineDash([9 / pxPerUnit, 7 / pxPerUnit]);
  ctx.beginPath();
  ahead.forEach((g, i) => (i === 0 ? ctx.moveTo(X(g.x), Z(g.z)) : ctx.lineTo(X(g.x), Z(g.z))));
  ctx.stroke();
  ctx.setLineDash([]);
  for (const g of ahead) {
    ctx.beginPath();
    ctx.arc(X(g.x), Z(g.z), Math.max(REGATTA_GATE_R * MAP_SCALE, 4 / pxPerUnit), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** The full map's blip size (px): its icons, and the legend's drawn as it draws them. */
export const MAP_BLIP = 18;

/** Fills the path `trace` draws white on a black outline, as the letters are drawn. */
function whiteShape(ctx: CanvasRenderingContext2D, trace: () => void): void {
  ctx.beginPath();
  trace();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

/** Strokes the lines `trace` draws `w` px wide in white on a black outline. */
function whiteLines(ctx: CanvasRenderingContext2D, w: number, trace: () => void): void {
  ctx.beginPath();
  trace();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = w + 2.5;
  ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = w;
  ctx.stroke();
}

/**
 * Icons drawn on a blip in place of a letter, centred on it, for a blip drawn at `s` px in colour `color`: where a
 * letter would mean two things (H, G, C, D) or not much (B), a picture of the place.
 */
const BLIP_ICONS: Record<string, (ctx: CanvasRenderingContext2D, s: number, color: string) => void> = {
  // The safehouse: a house with its door.
  house: (ctx, s, color) => {
    whiteShape(ctx, () => {
      ctx.moveTo(0, -0.46 * s);
      ctx.lineTo(0.44 * s, -0.04 * s);
      ctx.lineTo(0.3 * s, -0.04 * s);
      ctx.lineTo(0.3 * s, 0.36 * s);
      ctx.lineTo(-0.3 * s, 0.36 * s);
      ctx.lineTo(-0.3 * s, -0.04 * s);
      ctx.lineTo(-0.44 * s, -0.04 * s);
      ctx.closePath();
    });
    ctx.fillStyle = color;
    ctx.fillRect(-0.08 * s, 0.08 * s, 0.16 * s, 0.28 * s);
  },
  // The safehouse garage: the car it keeps, side on.
  garage: (ctx, s, color) => {
    whiteShape(ctx, () => {
      ctx.moveTo(-0.46 * s, 0.24 * s);
      ctx.lineTo(-0.46 * s, 0.02 * s);
      ctx.lineTo(-0.26 * s, -0.02 * s);
      ctx.lineTo(-0.14 * s, -0.26 * s);
      ctx.lineTo(0.16 * s, -0.26 * s);
      ctx.lineTo(0.3 * s, -0.02 * s);
      ctx.lineTo(0.46 * s, 0.04 * s);
      ctx.lineTo(0.46 * s, 0.24 * s);
      ctx.closePath();
    });
    // Its wheels, and its windows cut out in the icon's colour.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-0.08 * s, -0.19 * s);
    ctx.lineTo(-0.17 * s, -0.03 * s);
    ctx.lineTo(-0.02 * s, -0.03 * s);
    ctx.lineTo(-0.02 * s, -0.19 * s);
    ctx.closePath();
    ctx.moveTo(0.04 * s, -0.19 * s);
    ctx.lineTo(0.04 * s, -0.03 * s);
    ctx.lineTo(0.2 * s, -0.03 * s);
    ctx.lineTo(0.12 * s, -0.19 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    for (const x of [-0.25, 0.25]) {
      ctx.beginPath();
      ctx.arc(x * s, 0.26 * s, 0.11 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  },
  // Azura Customs: a spanner, its open jaw to the top right.
  wrench: (ctx, s) => {
    whiteLines(ctx, 0.15 * s, () => {
      ctx.moveTo(-0.3 * s, 0.3 * s);
      ctx.lineTo(0.06 * s, -0.06 * s);
    });
    whiteLines(ctx, 0.13 * s, () => ctx.arc(0.15 * s, -0.15 * s, 0.17 * s, -Math.PI / 4 + 0.95, -Math.PI / 4 - 0.95 + Math.PI * 2));
  },
  // The Pier Arcade: a dollar sign, its bar through the S drawn long so that it never reads as the Spray Shack's S.
  $: (ctx, s) => {
    ctx.font = `700 ${Math.round(s * 0.95)}px Rajdhani, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeText('S', 0, s * 0.05);
    ctx.beginPath();
    ctx.moveTo(0, -0.5 * s);
    ctx.lineTo(0, 0.56 * s);
    ctx.lineCap = 'round';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('S', 0, s * 0.05);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  },
  // The Hill Climb: two peaks.
  peak: (ctx, s) =>
    whiteShape(ctx, () => {
      ctx.moveTo(-0.46 * s, 0.3 * s);
      ctx.lineTo(-0.1 * s, -0.38 * s);
      ctx.lineTo(0.08 * s, -0.04 * s);
      ctx.lineTo(0.2 * s, -0.2 * s);
      ctx.lineTo(0.46 * s, 0.3 * s);
      ctx.closePath();
    }),
  // The Gull Regatta: a sailing boat.
  sail: (ctx, s) =>
    whiteShape(ctx, () => {
      ctx.moveTo(0.02 * s, -0.46 * s);
      ctx.lineTo(0.02 * s, 0.14 * s);
      ctx.lineTo(-0.34 * s, 0.14 * s);
      ctx.closePath();
      ctx.moveTo(0.1 * s, -0.3 * s);
      ctx.lineTo(0.36 * s, 0.14 * s);
      ctx.lineTo(0.1 * s, 0.14 * s);
      ctx.closePath();
      ctx.moveTo(-0.42 * s, 0.2 * s);
      ctx.lineTo(0.42 * s, 0.2 * s);
      ctx.lineTo(0.28 * s, 0.38 * s);
      ctx.lineTo(-0.28 * s, 0.38 * s);
      ctx.closePath();
    }),
  // The Gravel Gulch scramble: a dirt bike.
  bike: (ctx, s) =>
    whiteLines(ctx, Math.max(1.4, 0.09 * s), () => {
      ctx.moveTo(-0.1 * s, 0.17 * s);
      ctx.arc(-0.26 * s, 0.17 * s, 0.16 * s, 0, Math.PI * 2);
      ctx.moveTo(0.42 * s, 0.17 * s);
      ctx.arc(0.26 * s, 0.17 * s, 0.16 * s, 0, Math.PI * 2);
      ctx.moveTo(-0.26 * s, 0.17 * s);
      ctx.lineTo(-0.04 * s, -0.08 * s);
      ctx.lineTo(0.16 * s, -0.08 * s);
      ctx.lineTo(0.26 * s, 0.17 * s);
      ctx.moveTo(0.16 * s, -0.08 * s);
      ctx.lineTo(0.12 * s, -0.32 * s);
      ctx.moveTo(-0.18 * s, -0.12 * s);
      ctx.lineTo(0.02 * s, -0.12 * s);
    }),
  // A hidden package: the square tied up with string.
  parcel: (ctx, s) => {
    ctx.strokeStyle = '#7a5418';
    ctx.lineWidth = Math.max(1.5, 0.12 * s);
    ctx.beginPath();
    ctx.moveTo(0, -0.5 * s);
    ctx.lineTo(0, 0.5 * s);
    ctx.moveTo(-0.5 * s, 0);
    ctx.lineTo(0.5 * s, 0);
    ctx.stroke();
  },
};

export function drawBlip(ctx: CanvasRenderingContext2D, b: Blip, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  if (b.shape === 'ring') {
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  } else if (b.shape === 'dot' || b.shape === 'pip') {
    ctx.fillStyle = b.color;
    ctx.beginPath();
    // Callers size pips like full blips (14 px on the radar, 18 on the map): about 2.5 and 3 px.
    ctx.arc(0, 0, size * (b.shape === 'pip' ? 0.17 : 0.42), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = b.shape === 'pip' ? 1 : 1.5;
    ctx.stroke();
  } else if (b.shape === 'player') {
    const r = size * 0.72;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r, 0);
    ctx.lineTo(0, r);
    ctx.lineTo(-r, 0);
    ctx.closePath();
    ctx.fillStyle = b.color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    if (b.label) {
      ctx.fillStyle = '#101010';
      ctx.font = `700 ${Math.round(size * 0.8)}px Rajdhani, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, 0, size * 0.05);
    }
  } else if (b.shape === 'arrow') {
    // You: the arrow the map has always drawn (24 px long at 18), pointing your way.
    const u = size / 18;
    ctx.rotate(b.angle ?? 0);
    ctx.fillStyle = b.color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -12 * u);
    ctx.lineTo(8 * u, 9 * u);
    ctx.lineTo(0, 4 * u);
    ctx.lineTo(-8 * u, 9 * u);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (b.shape === 'zone' || b.shape === 'area') {
    // A patch of turf (tinted, its dashed edge as on the map) or the search area (a red disc).
    ctx.beginPath();
    if (b.shape === 'zone') ctx.rect(-size * 0.55, -size * 0.45, size * 1.1, size * 0.9);
    else ctx.arc(0, 0, size * 0.6, 0, Math.PI * 2);
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * 0.3;
    ctx.fillStyle = b.color;
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 2;
    if (b.shape === 'zone') ctx.setLineDash([4, 3]);
    ctx.stroke();
  } else if (b.shape === 'square') {
    ctx.fillStyle = b.color;
    ctx.fillRect(-size * 0.5, -size * 0.5, size, size);
    BLIP_ICONS[b.label]?.(ctx, size, b.color);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.strokeRect(-size * 0.5, -size * 0.5, size, size);
  } else {
    ctx.fillStyle = b.color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const icon = BLIP_ICONS[b.label];
    if (icon) icon(ctx, size, b.color);
    else if (b.label) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.round(size * 0.95)}px Rajdhani, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeText(b.label, 0, size * 0.05);
      ctx.fillText(b.label, 0, size * 0.05);
    }
  }
  ctx.restore();
}

/** A legend row's icon (CSS px): wide and tall enough for every shape at MAP_BLIP. */
export const LEGEND_ICON = { w: 30, h: 28 };

/** Draws kind `id`'s icon on a legend row's canvas as the full map draws it, backed at `dpr` pixels per CSS px. */
export function drawLegendIcon(canvas: HTMLCanvasElement, id: string, dpr: number): void {
  canvas.width = Math.round(LEGEND_ICON.w * dpr);
  canvas.height = Math.round(LEGEND_ICON.h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // The arrow points up, as it does going north.
  drawBlip(ctx, blipOf(id, 0, 0), LEGEND_ICON.w / 2, LEGEND_ICON.h / 2, MAP_BLIP);
}

/** Within this distance (m) of the lane he drives on, a car is on that road: its GPS route leads on along it. */
const ROUTE_ON_ROAD = 12;
/** What turning round costs (m) on top of the drive back: the GPS has a car turn back only when that is clearly shorter. */
const ROUTE_TURN_BACK = 40;

/**
 * Road-following GPS route (list of world points) from the player to a target. A car on a road is led on to the
 * junction ahead and on from there without turning straight back (as DriverAI plans), unless turning back to the
 * junction behind is clearly shorter (the target is behind him); on foot, or off the road, it starts at the nearest one.
 */
export function gpsRoute(sim: ViewState, tx: number, tz: number, localPlayerId = 0): Array<{ x: number; z: number }> {
  const me = playerOf(sim, localPlayerId);
  const pp = me.pos();
  const roads = sim.roads;
  const v = me.character.vehicle;
  // A boat sails straight there: the roads are no way for it.
  if (v?.spec.class === 'boat') return [{ x: pp.x, z: pp.z }, { x: tx, z: tz }];
  const b = roads.nearestNode(tx, tz);
  const on = v ? roads.nearestLane(pp.x, pp.z, v.heading) : null;
  let route: number[] | null;
  if (on && on.dist <= ROUTE_ON_ROAD) {
    const { lane } = on;
    const len = (r: number[]) => {
      let l = Math.hypot(roads.nodes[r[0]!]!.x - pp.x, roads.nodes[r[0]!]!.z - pp.z);
      for (let i = 1; i < r.length; i++) l += Math.hypot(roads.nodes[r[i]!]!.x - roads.nodes[r[i - 1]!]!.x, roads.nodes[r[i]!]!.z - roads.nodes[r[i - 1]!]!.z);
      return l;
    };
    const ahead = roads.findRoute(lane.to, b.id, lane.from) ?? roads.findRoute(lane.to, b.id);
    const back = roads.findRoute(lane.from, b.id);
    route = ahead && (!back || len(ahead) <= len(back) + ROUTE_TURN_BACK) ? ahead : back;
  } else {
    route = roads.findRoute(roads.nearestNode(pp.x, pp.z).id, b.id);
  }
  if (!route) return [];
  const pts = [{ x: pp.x, z: pp.z }];
  for (const id of route) pts.push({ x: roads.nodes[id]!.x, z: roads.nodes[id]!.z });
  pts.push({ x: tx, z: tz });
  return pts;
}

export function insideLand(sim: ViewState, x: number, z: number): boolean {
  const b = sim.world.layout.bounds;
  return rectContains({ minX: b.landMinX, minZ: b.landMinZ, maxX: b.beachEndX, maxZ: b.landMaxZ }, x, z);
}
