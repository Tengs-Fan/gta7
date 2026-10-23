// The STATS screen's rows beyond its core ones. A feature adds its own with registerStatRow instead of editing the
// screen. Kept apart from completion.ts (which imports the activity registry) so activities can register rows without
// an import cycle.

import type { PlayerView, ViewState } from './viewState';

export interface CompletionView {
  sim: ViewState;
  player: PlayerView;
}

/** A line on the STATS screen. */
export interface StatRow {
  id: string;
  label: string;
  value(v: CompletionView): string;
}

const rows: StatRow[] = [];

export function registerStatRow(r: StatRow): void {
  const i = rows.findIndex((o) => o.id === r.id);
  if (i >= 0) rows[i] = r;
  else rows.push(r);
}

export function statRows(): readonly StatRow[] {
  return rows;
}
