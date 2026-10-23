// Top-down map image (pre-rendered once) plus blip drawing, shared by the
// radar and the full-screen map.

import type { Objective } from '../sim/activities';
import { contactById } from '../sim/missions/contacts';
import { playerOf, type ViewState } from '../sim/viewState';
import { HELI_SIGHT } from '../sim/wanted';
import { WATER_Y } from '../world/constants';
import { beachOffsetAt, rectContains } from '../world/layout';
import type { StaticWorld } from '../world/staticWorld';

export const MAP_SCALE = 1; // pixels per metre in the pre-rendered image

export class MapImage {
  readonly canvas: HTMLCanvasElement;
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
    // Blocks and ground.
    for (const blk of world.layout.blocks) rect(blk.rect.minX, blk.rect.minZ, blk.rect.maxX, blk.rect.maxZ, '#2c3238');
    const gc: Record<string, string> = { grass: '#2f6a3a', yard: '#35603a', plaza: '#3c4147', parking: '#33373c', dirt: '#4a4438' };
    for (const gp of world.layout.ground) rect(gp.rect.minX, gp.rect.minZ, gp.rect.maxX, gp.rect.maxZ, gc[gp.kind] ?? '#333');
    // Roads.
    for (const s of world.roads.segments) rect(s.minX, s.minZ, s.maxX, s.maxZ, '#9aa1aa');
    for (const n of world.roads.nodes) rect(n.x - n.halfX, n.z - n.halfZ, n.x + n.halfX, n.z + n.halfZ, '#9aa1aa');
    // Buildings.
    for (const bd of world.layout.buildings) {
      const tall = bd.height > 40;
      rect(bd.rect.minX, bd.rect.minZ, bd.rect.maxX, bd.rect.maxZ, tall ? '#1d2228' : '#22282e');
    }
    for (const d of world.layout.decks) rect(d.rect.minX, d.rect.minZ, d.rect.maxX, d.rect.maxZ, '#7b5a3a');
  }
}

export interface Blip {
  x: number;
  z: number;
  color: string;
  label: string;
  /** Keep on the radar rim when out of range. */
  sticky: boolean;
  /** 'pip': a small dot (officers on foot). */
  shape: 'circle' | 'square' | 'dot' | 'pip';
}

const POI_BLIPS: Record<string, { color: string; label: string }> = {
  safehouse: { color: '#4aa8ff', label: 'H' },
  hospital: { color: '#ff4a4a', label: '+' },
  police: { color: '#3a6bff', label: 'P' },
  spray: { color: '#3fd96b', label: 'S' },
  gunshop: { color: '#ff8a1f', label: 'G' },
};

export function collectBlips(sim: ViewState, time: number, localPlayerId = 0): Blip[] {
  const out: Blip[] = [];
  for (const p of sim.world.layout.pois) {
    const b = POI_BLIPS[p.kind];
    if (b) out.push({ x: p.x, z: p.z, color: b.color, label: b.label, sticky: false, shape: 'circle' });
  }
  // Places a marker carries an icon for (the properties and Azura Customs).
  for (const m of sim.interactions.markers) if (m.blip) out.push({ x: m.x, z: m.z, color: m.blip.color, label: m.blip.label, sticky: false, shape: 'circle' });
  if (!sim.missions.active) {
    for (const d of sim.missions.offers()) {
      const contact = contactById(d.giver);
      const poi = sim.world.layout.pois.find((q) => q.id === contact.poiId)!;
      out.push({ x: poi.x, z: poi.z, color: contact.color, label: contact.mapLabel, sticky: true, shape: 'circle' });
    }
  }
  const objectives: Objective[] = [...(sim.missions.active?.markers ?? []), ...sim.activities.objectives()];
  for (const o of objectives) {
    const t = o.vehicle ?? o.character;
    const x = t ? t.pos.x : o.x;
    const z = t ? t.pos.z : o.z;
    out.push({ x, z, color: '#' + o.color.toString(16).padStart(6, '0'), label: '', sticky: true, shape: t ? 'square' : 'circle' });
  }
  if (playerOf(sim, localPlayerId).wanted.level > 0) {
    const blink = Math.floor(time * 4) % 2 === 0;
    for (const v of sim.vehicles) if (v.owner === 'police' && !v.removed && !v.destroyed) out.push({ x: v.pos.x, z: v.pos.z, color: blink ? '#ff3030' : '#3060ff', label: '', sticky: false, shape: 'dot' });
    // Every officer on foot too, smaller.
    for (const c of sim.characters) if (c.isLaw && c.alive && !c.removed && c.state !== 'inVehicle') out.push({ x: c.pos.x, z: c.pos.z, color: blink ? '#ff3030' : '#3060ff', label: '', sticky: false, shape: 'pip' });
    for (const h of sim.helis) if (!h.removed) out.push({ x: h.pos.x, z: h.pos.z, color: blink ? '#3060ff' : '#ff3030', label: '', sticky: false, shape: 'square' });
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
  if (b.shape === 'dot' || b.shape === 'pip') {
    ctx.fillStyle = b.color;
    ctx.beginPath();
    // Callers size pips like full blips (14 px on the radar, 18 on the map): about 2.5 and 3 px.
    ctx.arc(0, 0, size * (b.shape === 'pip' ? 0.17 : 0.42), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = b.shape === 'pip' ? 1 : 1.5;
    ctx.stroke();
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
