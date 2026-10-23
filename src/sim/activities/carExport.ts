// Car export: Lou's board at her garage lists EXPORT_LIST, eight cars (a kind, some in a stated colour). Taking the
// list (E at the board) starts the job; a listed car driven into the drop-off under the docks crane is shipped: it pays
// its reward, is taken away and its entry is ticked. Any other car is turned away. The ticks persist (save ext
// EXPORT_KEY); delivering the last pays EXPORT_LIST_BONUS and starts a fresh list.

import { formatMoney } from '../../core/math';
import type { Vehicle } from '../entities';
import type { Progress } from '../progress';
import { registerCompletion } from '../completion';
import { registerSaveCodec } from '../saveExt';
import { VEHICLE_SPECS, type VehicleKind } from '../specs';
import { places } from './places';
import { activityRecords } from './records';
import type { ActivityDef, ActivityHost, Objective } from './types';

export interface ExportEntry {
  id: string;
  kind: VehicleKind;
  /** The colour it must be (0xRRGGBB), or undefined for any. */
  color?: number;
  colorName?: string;
  reward: number;
}

export const EXPORT_LIST: readonly ExportEntry[] = [
  { id: 'sports-red', kind: 'sports', color: 0xc0392b, colorName: 'red', reward: 4000 },
  { id: 'muscle', kind: 'muscle', reward: 2500 },
  { id: 'pickup', kind: 'pickup', reward: 1500 },
  { id: 'compact-yellow', kind: 'compact', color: 0xd4ac0d, colorName: 'yellow', reward: 1200 },
  { id: 'van-white', kind: 'van', color: 0xf2f3f4, colorName: 'white', reward: 1500 },
  { id: 'sedan-black', kind: 'sedan', color: 0x1c1c1c, colorName: 'black', reward: 1800 },
  { id: 'taxi', kind: 'taxi', reward: 1500 },
  { id: 'bus', kind: 'bus', reward: 3000 },
];

export const EXPORT_LIST_BONUS = 5000;
export const EXPORT_KEY = 'carExport';
/** The crane takes a car once it stops (below this, m/s) in the drop-off. */
export const CRANE_SPEED = 2;

export function exportLabel(e: ExportEntry): string {
  const name = VEHICLE_SPECS[e.kind].name;
  return e.colorName ? `${name} (${e.colorName})` : name;
}

/** The ticked entries of each player's list. */
const lists = new WeakMap<Progress, Set<string>>();

export function exportDone(p: Progress): Set<string> {
  let s = lists.get(p);
  if (!s) {
    s = new Set();
    lists.set(p, s);
  }
  return s;
}

/** The open entry `v` would fill, or null. */
export function exportMatch(p: Progress, v: Vehicle): ExportEntry | null {
  const done = exportDone(p);
  return EXPORT_LIST.find((e) => !done.has(e.id) && e.kind === v.kind && (e.color === undefined || e.color === v.color)) ?? null;
}

export interface ExportJob {
  kind: 'carExport';
  /** The vehicle the crane last judged while it stood in the drop-off: it is not judged again until it leaves. */
  judged: Vehicle | null;
  craneX: number;
  craneZ: number;
}

function updateExport(host: ActivityHost, j: ExportJob): void {
  const sim = host.sim;
  const v = sim.player.vehicle;
  const crane = places(sim.world).crane;
  const inside = !!v && v.driver === sim.player && v.pos.x >= crane.minX && v.pos.x <= crane.maxX && v.pos.z >= crane.minZ && v.pos.z <= crane.maxZ;
  if (!inside) {
    j.judged = null;
    return;
  }
  if (j.judged === v || v.speed >= CRANE_SPEED) return;
  j.judged = v;
  const p = sim.progress;
  const done = exportDone(p);
  const entry = v.missionTag || v.destroyed ? null : exportMatch(p, v);
  if (!entry) {
    const listed = EXPORT_LIST.some((e) => e.kind === v.kind && (e.color === undefined || e.color === v.color));
    host.say(v.missionTag ? "Lou: That one's spoken for. Not on my list." : listed ? 'Lou: Already shipped one of those.' : `Lou: A ${v.spec.name}? Not on my list.`, 3);
    return;
  }
  done.add(entry.id);
  const rec = activityRecords(p);
  rec.exportCars++;
  p.addMoney(entry.reward);
  sim.events.emit('money', { amount: entry.reward });
  sim.removeVehicle(v);
  j.judged = null;
  if (done.size < EXPORT_LIST.length) {
    sim.events.emit('big', { text: 'CAR EXPORTED', sub: `${exportLabel(entry)}  ·  ${formatMoney(entry.reward)}  ·  ${done.size}/${EXPORT_LIST.length}`, style: 'info', duration: 3 });
    sim.events.emit('activityMilestone', { kind: 'carExport', reward: entry.reward });
    return;
  }
  p.addMoney(EXPORT_LIST_BONUS);
  sim.events.emit('money', { amount: EXPORT_LIST_BONUS });
  rec.exportLists++;
  done.clear();
  sim.events.emit('big', { text: 'EXPORT LIST COMPLETE', sub: `${formatMoney(EXPORT_LIST_BONUS)} bonus`, style: 'passed', duration: 4 });
  host.end("Lou: That's the whole list. I'll put up a new one.");
  sim.events.emit('activityMilestone', { kind: 'carExport', reward: entry.reward + EXPORT_LIST_BONUS });
}

/** Started from Lou's board (Interactions, on foot), never by the job key. */
export const carExportActivity: ActivityDef<ExportJob> = {
  kind: 'carExport',
  toggleEndText: 'Export job stopped. The list stays on Lou\'s board.',
  onFoot: true,

  canStart: () => false,

  prompt: () => null,

  start(host) {
    if (host.job || host.sim.missions.active) return false;
    const c = places(host.sim.world).crane;
    const j: ExportJob = { kind: 'carExport', judged: null, craneX: (c.minX + c.maxX) / 2, craneZ: (c.minZ + c.maxZ) / 2 };
    host.job = j;
    const open = EXPORT_LIST.length - exportDone(host.sim.progress).size;
    host.sim.events.emit('big', { text: 'CAR EXPORT', sub: `${open} car${open === 1 ? '' : 's'} wanted: bring them to the docks crane`, style: 'title', duration: 3.5 });
    return true;
  },

  update: (host, j) => updateExport(host, j),

  end() {},

  objectives: (j): Objective[] => [{ x: j.craneX, z: j.craneZ, label: 'Docks crane', color: 0xffa020, radius: 9 }],

  status: () => null,
};

/** The list's ticks; a list nothing has been ticked on writes nothing. */
export function parseExport(raw: unknown): string[] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const done = (raw as { done?: unknown }).done;
  if (!Array.isArray(done)) return undefined;
  const ids = new Set(EXPORT_LIST.map((e) => e.id));
  return [...new Set(done.filter((d): d is string => typeof d === 'string' && ids.has(d)))];
}

registerSaveCodec<string[]>({
  key: EXPORT_KEY,
  serialize: (sim) => {
    const done = exportDone(sim.progress);
    return done.size > 0 ? { done: EXPORT_LIST.filter((e) => done.has(e.id)).map((e) => e.id) } : undefined;
  },
  parse: parseExport,
  apply: (sim, value) => {
    const done = exportDone(sim.progress);
    done.clear();
    for (const id of value) done.add(id);
  },
});

registerCompletion({
  id: 'carExport',
  label: "Lou's export list",
  weight: 0,
  progress: ({ player }) => [activityRecords(player.progress).exportLists > 0 ? EXPORT_LIST.length : exportDone(player.progress).size, EXPORT_LIST.length],
});
