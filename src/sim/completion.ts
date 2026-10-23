// The stats and completion registry: what the STATS screen lists beyond its core rows, and what Game completion and
// the map's checklist count. A feature adds its rows and entries here (registerStatRow, registerCompletion) instead of
// editing the stats screen. Completion is the weighted sum of the entries' done / total; the weights of the counted
// entries total 1. An entry of weight 0 is on the checklist without counting towards the percentage: the wave-1
// properties and jobs are, so a save from before them shows the completion it always did.

import { PACKAGE_COUNT } from './pickups';
import type { PlayerView, ViewState } from './viewState';

export interface CompletionView {
  sim: ViewState;
  player: PlayerView;
}

export interface CompletionEntry {
  id: string;
  label: string;
  /** Share of Game completion (0..1); 0 for a checklist-only entry. */
  weight: number;
  /** How much of it is done, out of how much. */
  progress(v: CompletionView): readonly [done: number, total: number];
}

export interface StatRow {
  id: string;
  label: string;
  value(v: CompletionView): string;
}

const entries: CompletionEntry[] = [];
const rows: StatRow[] = [];

export function registerCompletion(e: CompletionEntry): void {
  const i = entries.findIndex((o) => o.id === e.id);
  if (i >= 0) entries[i] = e;
  else entries.push(e);
}

export function registerStatRow(r: StatRow): void {
  const i = rows.findIndex((o) => o.id === r.id);
  if (i >= 0) rows[i] = r;
  else rows.push(r);
}

export function completionEntries(): readonly CompletionEntry[] {
  return entries;
}

export function statRows(): readonly StatRow[] {
  return rows;
}

/** Game completion in whole percent. */
export function completionPercent(v: CompletionView): number {
  let sum = 0;
  for (const e of entries) {
    if (e.weight <= 0) continue;
    const [done, total] = e.progress(v);
    sum += total > 0 ? (Math.min(done, total) / total) * e.weight : 0;
  }
  return Math.round(sum * 100);
}

// The core entries, in the order (and with the arithmetic) of the formula they replace.
registerCompletion({ id: 'story', label: 'Story missions', weight: 0.5, progress: ({ sim, player }) => [sim.missions.defs.filter((d) => player.progress.hasDone(d.id)).length, sim.missions.defs.length] });
registerCompletion({ id: 'packages', label: 'Hidden packages', weight: 0.2, progress: ({ player }) => [player.progress.packages.length, PACKAGE_COUNT] });
registerCompletion({ id: 'stunts', label: 'Unique stunt jumps', weight: 0.15, progress: ({ sim, player }) => [player.progress.stunts.length, sim.world.layout.ramps.length] });
registerCompletion({ id: 'rampages', label: 'Rampages', weight: 0.15, progress: ({ player }) => [player.progress.rampages.length, 3] });
