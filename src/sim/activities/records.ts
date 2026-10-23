// What the wave-1 activities remember for the player: highest levels, runs and cars delivered. Kept beside the v1
// Progress (one record per Progress, so per player slot) and saved in the save's `ext` under ACTIVITY_RECORDS_KEY.

import type { Progress } from '../progress';
import { registerSaveCodec } from '../saveExt';

export interface ActivityRecords {
  ambulanceLevel: number;
  patientsSaved: number;
  fireLevel: number;
  firesOut: number;
  courierRuns: number;
  parcelsDelivered: number;
  exportCars: number;
  exportLists: number;
}

export const ACTIVITY_RECORDS_KEY = 'activityRecords';

export function emptyRecords(): ActivityRecords {
  return { ambulanceLevel: 0, patientsSaved: 0, fireLevel: 0, firesOut: 0, courierRuns: 0, parcelsDelivered: 0, exportCars: 0, exportLists: 0 };
}

const records = new WeakMap<Progress, ActivityRecords>();

export function activityRecords(p: Progress): ActivityRecords {
  let r = records.get(p);
  if (!r) {
    r = emptyRecords();
    records.set(p, r);
  }
  return r;
}

/** Whole numbers 0..1e9 per known field; anything else (a corrupt entry) is dropped, keeping the field at 0. */
export function parseRecords(raw: unknown): ActivityRecords | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out = emptyRecords();
  for (const k of Object.keys(out) as Array<keyof ActivityRecords>) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.floor(Math.max(0, Math.min(1e9, v)));
  }
  return out;
}

registerSaveCodec<ActivityRecords>({
  key: ACTIVITY_RECORDS_KEY,
  serialize: (sim) => {
    const r = activityRecords(sim.progress);
    return Object.values(r).some((v) => v > 0) ? { ...r } : undefined;
  },
  parse: parseRecords,
  apply: (sim, value) => {
    Object.assign(activityRecords(sim.progress), value);
  },
});
