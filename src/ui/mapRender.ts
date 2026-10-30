// Top-down map image (pre-rendered once) plus blip drawing, shared by the
// radar and the full-screen map.

import { activityKinds, getActivity, type Objective } from '../sim/activities';
import { GANGS, turfZones } from '../sim/gangs';
import { FOR_SALE, OWNED } from '../sim/interactions';
import { CONTACTS, contactById, contactUnlocked } from '../sim/missions/contacts';
import { playerOf, type ViewState } from '../sim/viewState';
import { playerColor } from '../sim/appearance';
import { packageIndex } from '../sim/pickups';
import { HELI_SIGHT } from '../sim/wanted';
import { WATER_Y } from '../world/constants';
import { beachOffsetAt, rectContains } from '../world/layout';
import { foreshoreReach, shores } from '../world/shore';
import type { StaticWorld } from '../world/staticWorld';

export const MAP_SCALE = 1; // pixels per metre in the pre-rendered image
const PACKAGE_COLOR = '#f5cd80';
const RAMPAGE_COLOR = '#e8402c';

export class MapImage {
  readonly canvas: HTMLCanvasElement;
  /** The gang turf tint, drawn over `canvas` when the legend has it on. */
  readonly turf: HTMLCanvasElement;
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
    // Roads.
    for (const s of world.roads.segments) rect(s.minX, s.minZ, s.maxX, s.maxZ, '#9aa1aa');
    for (const n of world.roads.live) rect(n.x - n.halfX, n.z - n.halfZ, n.x + n.halfX, n.z + n.halfZ, '#9aa1aa');
    // Buildings.
    for (const bd of world.layout.buildings) {
      const tall = bd.height > 40;
      rect(bd.rect.minX, bd.rect.minZ, bd.rect.maxX, bd.rect.maxZ, tall ? '#1d2228' : '#22282e');
    }
    for (const d of world.layout.decks) rect(d.rect.minX, d.rect.minZ, d.rect.maxX, d.rect.maxZ, d.bridge ? '#9aa1aa' : '#7b5a3a');
    // AzuraLink: a thin teal line down the canal between its stations' platforms.
    const m = world.layout.monorail;
    rect(m.x - 1.2, m.stations[0]!.platform[0]!.minZ, m.x + 1.2, m.stations[1]!.platform[0]!.maxZ, '#0aa5ad');
    for (const s of m.stations) for (const r of [...s.platform, s.tower]) rect(r.minX, r.minZ, r.maxX, r.maxZ, '#0aa5ad');
    this.turf = document.createElement('canvas');
    this.turf.width = w;
    this.turf.height = h;
    drawTurf(this.turf.getContext('2d')!, world, X, Z);
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

export interface Blip {
  x: number;
  z: number;
  color: string;
  label: string;
  /** Keep on the radar rim when out of range. */
  sticky: boolean;
  /** 'pip': a small dot (officers on foot); 'ring': a hollow circle (a collectible already found); 'player': another player. */
  shape: 'circle' | 'square' | 'dot' | 'pip' | 'ring' | 'player';
  /** The map legend category that can hide it (see MAP_CATEGORIES); absent: always shown. */
  category?: string;
}

/** A map legend category the player can switch off and on. */
export interface MapCategory {
  id: string;
  label: string;
  /** Swatches drawn in its legend row: colour and the blip's letter. */
  swatches: Array<{ color: string; label?: string; hollow?: boolean }>;
  /** The swatches the legend shows for this player, where they depend on progress; absent: `swatches`. */
  legendSwatches?(sim: ViewState, localPlayerId: number): Array<{ color: string; label?: string; hollow?: boolean }>;
  /** More blips of its own (collectibles, turf); POIs come in through MAP_POIS. */
  blips?(sim: ViewState, localPlayerId: number): Blip[];
}

/**
 * Each POI kind's blip and the category it belongs to, for the layout's POIs and for interaction markers that carry
 * a blip (their marker kind). Systems that add POI kinds register theirs (registerMapPoi).
 */
const MAP_POIS: Record<string, { color: string; label: string; category: string; name: string }> = {
  safehouse: { color: '#4aa8ff', label: 'H', category: 'places', name: 'Safehouse (save)' },
  hospital: { color: '#ff4a4a', label: '+', category: 'places', name: 'Hospital' },
  police: { color: '#3a6bff', label: 'P', category: 'places', name: 'Police station' },
  spray: { color: '#3fd96b', label: 'S', category: 'shops', name: 'Spray Shack' },
  gunshop: { color: '#ff8a1f', label: 'G', category: 'shops', name: 'Gun shop' },
  // Interaction markers (sim/interactions.ts): the properties' blips turn from grey to green once owned.
  customs: { color: '#b36bff', label: 'C', category: 'shops', name: 'Azura Customs' },
  garage: { color: FOR_SALE, label: 'G', category: 'properties', name: 'Safehouse garage' },
  business: { color: FOR_SALE, label: '$', category: 'properties', name: 'Pier Arcade' },
  monorail: { color: '#0aa5ad', label: 'M', category: 'places', name: 'AzuraLink station' },
};

export function registerMapPoi(kind: string, def: { color: string; label: string; category: string; name: string }): void {
  MAP_POIS[kind] = def;
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

const LOCKED_CONTACT = '#8a8f98';
const poiSwatches = (category: string) => Object.values(MAP_POIS).filter((p) => p.category === category).map((p) => ({ color: p.color, label: p.label }));

registerMapCategory({ id: 'missions', label: 'Missions (contacts)', get swatches() {
  return CONTACTS.map((c) => ({ color: c.color, label: c.mapLabel }));
}, legendSwatches(sim, localPlayerId) {
  const progress = playerOf(sim, localPlayerId).progress;
  const open = CONTACTS.filter((c) => contactUnlocked(sim.missions.defs, progress, c.id));
  const swatches = open.map((c) => ({ color: c.color, label: c.mapLabel }));
  // A locked contact stays anonymous: neutral grey and no letter.
  return open.length < CONTACTS.length ? [...swatches, { color: LOCKED_CONTACT, label: '?' }] : swatches;
} });
registerMapCategory({ id: 'shops', label: 'Shops (guns, Spray Shack, Azura Customs)', get swatches() {
  return poiSwatches('shops');
} });
registerMapCategory({ id: 'places', label: 'Safehouse, hospital, police, AzuraLink', get swatches() {
  return poiSwatches('places');
} });
registerMapCategory({ id: 'properties', label: 'Properties (grey: for sale, green: owned)', get swatches() {
  return [...poiSwatches('properties'), { color: OWNED }];
} });
registerMapCategory({ id: 'turf', label: 'Gang turf', get swatches() {
  return Object.values(GANGS).map((g) => ({ color: g.mapColor }));
} });
registerMapCategory({
  id: 'collectibles',
  label: 'Packages, rampages (hollow: found)',
  swatches: [{ color: PACKAGE_COLOR }, { color: RAMPAGE_COLOR, label: 'R' }, { color: PACKAGE_COLOR, hollow: true }],
  blips: (sim, localPlayerId) => {
    const prog = playerOf(sim, localPlayerId).progress;
    const out: Blip[] = [];
    for (const p of sim.pickups) {
      if (p.removed) continue;
      if (p.kind === 'package') {
        const found = prog.packages.includes(packageIndex(p.tag));
        out.push({ x: p.pos.x, z: p.pos.z, color: PACKAGE_COLOR, label: '', sticky: false, shape: found ? 'ring' : 'square', category: 'collectibles' });
      } else if (p.kind === 'rampage') {
        const found = prog.rampages.includes(p.tag);
        out.push({ x: p.pos.x, z: p.pos.z, color: RAMPAGE_COLOR, label: found ? '' : 'R', sticky: false, shape: found ? 'ring' : 'circle', category: 'collectibles' });
      }
    }
    return out;
  },
});

// Not the objective yellow: the legend's fixed rows already use that for mission and job markers.
const ACTIVITY_COLOR = '#00e5ff';
const activitySites = () => activityKinds().flatMap((k) => {
  const site = getActivity(k)?.site;
  return site ? [site] : [];
});
registerMapCategory({
  id: 'activities',
  get label() {
    return `Activities (${activitySites().map((s) => s.name.toLowerCase()).join(', ')})`;
  },
  get swatches() {
    return activitySites().map((s) => ({ color: ACTIVITY_COLOR, label: s.label }));
  },
  blips: (sim) => activitySites().map((s) => {
    const at = s.at(sim.world);
    return { x: at.x, z: at.z, color: ACTIVITY_COLOR, label: s.label, sticky: false, shape: 'circle', category: 'activities' };
  }),
});

export interface BlipOptions {
  /** The full-screen map: collectibles and the categories' own blips too. */
  map?: boolean;
  /** Categories switched off in the map legend: their blips are left out. */
  hidden?: ReadonlySet<string>;
}

export function collectBlips(sim: ViewState, time: number, localPlayerId = 0, opts: BlipOptions = {}): Blip[] {
  const out: Blip[] = [];
  for (const p of sim.world.layout.pois) {
    const b = MAP_POIS[p.kind];
    if (b) out.push({ x: p.x, z: p.z, color: b.color, label: b.label, sticky: false, shape: 'circle', category: b.category });
  }
  // Places a marker carries an icon for (the properties and Azura Customs).
  for (const m of sim.interactions.markers) if (m.blip) out.push({ x: m.x, z: m.z, color: m.blip.color, label: m.blip.label, sticky: false, shape: 'circle', category: MAP_POIS[m.kind]?.category });
  // Before the contacts' offers, so that one is never hidden under an icon beside it (Lou's export board).
  if (opts.map) for (const c of MAP_CATEGORIES) if (c.blips) out.push(...c.blips(sim, localPlayerId).map((b) => ({ ...b, category: b.category ?? c.id })));
  if (!sim.missions.active) {
    for (const d of sim.missions.offers()) {
      const contact = contactById(d.giver);
      const poi = sim.world.layout.pois.find((q) => q.id === contact.poiId)!;
      out.push({ x: poi.x, z: poi.z, color: contact.color, label: contact.mapLabel, sticky: true, shape: 'circle', category: 'missions' });
    }
  }
  const objectives: Objective[] = [...(sim.missions.active?.markers ?? []), ...sim.activities.objectives()];
  for (const o of objectives) {
    const t = o.vehicle ?? o.character;
    const x = t ? t.pos.x : o.x;
    const z = t ? t.pos.z : o.z;
    out.push({ x, z, color: '#' + o.color.toString(16).padStart(6, '0'), label: '', sticky: true, shape: t ? 'square' : 'circle' });
  }
  out.push(...otherPlayerBlips(sim, localPlayerId));
  if (playerOf(sim, localPlayerId).wanted.level > 0) {
    const blink = Math.floor(time * 4) % 2 === 0;
    for (const v of sim.vehicles) if (v.owner === 'police' && !v.removed && !v.destroyed) out.push({ x: v.pos.x, z: v.pos.z, color: blink ? '#ff3030' : '#3060ff', label: '', sticky: false, shape: 'dot' });
    // Every officer on foot too, smaller.
    for (const c of sim.characters) if (c.isLaw && c.alive && !c.removed && c.state !== 'inVehicle') out.push({ x: c.pos.x, z: c.pos.z, color: blink ? '#ff3030' : '#3060ff', label: '', sticky: false, shape: 'pip' });
    for (const h of sim.helis) if (!h.removed) out.push({ x: h.pos.x, z: h.pos.z, color: blink ? '#3060ff' : '#ff3030', label: '', sticky: false, shape: 'square' });
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
    out.push({ x: at.x, z: at.z, color, label: (pl.name ?? '').trim().charAt(0).toUpperCase(), sticky: true, shape: 'player' });
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
  } else if (b.shape === 'square') {
    ctx.fillStyle = b.color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.fillRect(-size * 0.5, -size * 0.5, size, size);
    ctx.strokeRect(-size * 0.5, -size * 0.5, size, size);
  } else {
    ctx.fillStyle = b.color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (b.label) {
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
  const b = roads.nearestNode(tx, tz);
  const v = me.character.vehicle;
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
