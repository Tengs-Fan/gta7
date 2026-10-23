// Single-player same-seed results stay identical to the trace recorded at 72d0b98, before the PlayerSlot refactor.
// Regenerate the fixture only at 72d0b98 (see scripts/record-sp-trace.ts); a diff here is a behaviour change.
// Exception: Hotel Salgado's entrance (Vera's SPECIALS row) displaced one street lamp, so propBroken indices past it
// are one lower than at 72d0b98; that is the only difference in the fixture.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordSpTrace, TRACE_FRAMES, type SpTrace } from '../support/spTrace';

const FIXTURE = join(__dirname, 'fixtures', 'sp_trace_72d0b98.json');

describe('single-player trace against the 72d0b98 baseline', () => {
  const baseline = readFileSync(FIXTURE, 'utf8');
  const parsed = JSON.parse(baseline) as SpTrace;

  it('the baseline covers walking, driving, shooting, 3 stars, a Street Run and a death or bust', () => {
    expect(parsed.seeds.length).toBeGreaterThanOrEqual(2);
    expect(parsed.frameCount).toBeGreaterThanOrEqual(3000);
    for (const s of parsed.seeds) {
      expect(s.frames.length).toBe(TRACE_FRAMES / 60);
      const types = new Set(s.frames.flatMap((f) => f.events.map(([t]) => t)));
      expect(Math.max(...s.frames.map((f) => f.wanted))).toBeGreaterThanOrEqual(3);
      expect(s.frames.some((f) => f.player.vehicle !== null)).toBe(true);
      expect(types.has('weaponFired')).toBe(true);
      expect(types.has('streetRunCountdown')).toBe(true);
      expect(types.has(s.end)).toBe(true);
      expect(types.has('respawn')).toBe(true);
    }
  });

  it('replaying the script reproduces the baseline byte for byte', () => {
    const now = `${JSON.stringify(recordSpTrace())}\n`;
    if (now === baseline) return;
    const got = JSON.parse(now) as SpTrace;
    for (let s = 0; s < parsed.seeds.length; s++) {
      for (let i = 0; i < parsed.seeds[s]!.frames.length; i++) {
        expect(got.seeds[s]!.frames[i], `seed ${parsed.seeds[s]!.seed} frame ${parsed.seeds[s]!.frames[i]!.frame}`).toEqual(parsed.seeds[s]!.frames[i]);
      }
    }
    expect(now === baseline).toBe(true);
  });
});
