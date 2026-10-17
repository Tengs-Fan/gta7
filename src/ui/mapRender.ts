// Top-down map image (pre-rendered once) plus blip drawing, shared by the
// radar and the full-screen map.

import type { Objective } from '../sim/activities';
import type { Sim } from '../sim/sim';
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
  shape: 'circle' | 'square' | 'dot';
}

const POI_BLIPS: Record<string, { color: string; label: string }> = {
  safehouse: { color: '#4aa8ff', label: 'H' },
  hospital: { color: '#ff4a4a', label: '+' },
  police: { color: '#3a6bff', label: 'P' },
  spray: { color: '#3fd96b', label: 'S' },
  gunshop: { color: '#ff8a1f', label: 'G' },
};

export function collectBlips(sim: Sim, time: number): Blip[] {
  const out: Blip[] = [];
  for (const p of sim.world.layout.pois) {
    const b = POI_BLIPS[p.kind];
    if (b) out.push({ x: p.x, z: p.z, color: b.color, label: b.label, sticky: false, shape: 'circle' });
  }
  if (!sim.missions.active) {
    for (const d of sim.missions.offers()) {
      const poi = sim.world.layout.pois.find((q) => q.id === d.giver)!;
      out.push({ x: poi.x, z: poi.z, color: d.giver === 'lou' ? '#ff4fa3' : '#38e1d2', label: d.giver === 'lou' ? 'L' : 'D', sticky: true, shape: 'circle' });
    }
  }
  const objectives: Objective[] = [...(sim.missions.active?.markers ?? []), ...sim.activities.objectives()];
  for (const o of objectives) {
    const t = o.vehicle ?? o.character;
    const x = t ? t.pos.x : o.x;
    const z = t ? t.pos.z : o.z;
    out.push({ x, z, color: '#' + o.color.toString(16).padStart(6, '0'), label: '', sticky: true, shape: t ? 'square' : 'circle' });
  }
  if (sim.wanted.level > 0) {
    const blink = Math.floor(time * 4) % 2 === 0;
    for (const v of sim.vehicles) if (v.owner === 'police' && !v.removed && !v.destroyed) out.push({ x: v.pos.x, z: v.pos.z, color: blink ? '#ff3030' : '#3060ff', label: '', sticky: false, shape: 'dot' });
    for (const h of sim.helis) if (!h.removed) out.push({ x: h.pos.x, z: h.pos.z, color: blink ? '#3060ff' : '#ff3030', label: '', sticky: false, shape: 'square' });
  }
  return out;
}

export function drawBlip(ctx: CanvasRenderingContext2D, b: Blip, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  if (b.shape === 'dot') {
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
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

/** Road-following GPS route (list of world points) from the player to a target. */
export function gpsRoute(sim: Sim, tx: number, tz: number): Array<{ x: number; z: number }> {
  const pp = sim.playerPos();
  const roads = sim.roads;
  const a = roads.nearestNode(pp.x, pp.z);
  const b = roads.nearestNode(tx, tz);
  const route = roads.findRoute(a.id, b.id);
  if (!route) return [];
  const pts = [{ x: pp.x, z: pp.z }];
  for (const id of route) pts.push({ x: roads.nodes[id]!.x, z: roads.nodes[id]!.z });
  pts.push({ x: tx, z: tz });
  return pts;
}

export function insideLand(sim: Sim, x: number, z: number): boolean {
  const b = sim.world.layout.bounds;
  return rectContains({ minX: b.landMinX, minZ: b.landMinZ, maxX: b.beachEndX, maxZ: b.landMaxZ }, x, z);
}
