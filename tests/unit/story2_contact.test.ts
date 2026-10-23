// Chapter 2: Vera Salgado joins through the contact registry, unlocks after The Big Score and counts towards completion.

import { describe, expect, it } from 'vitest';
import { CONTACTS, contactById, contactColorNumber } from '../../src/sim/missions/contacts';
import { STORY } from '../../src/sim/missions/index';
import { VERA_MISSIONS } from '../../src/sim/missions/vera';
import { applySave, parseSave, serialize } from '../../src/sim/progress';
import { PACKAGE_COUNT } from '../../src/sim/pickups';
import type { Sim } from '../../src/sim/sim';
import { missionCard, offerCardClass } from '../../src/ui/hud';
import { collectBlips } from '../../src/ui/mapRender';
import { showStats } from '../../src/ui/screens/stats';
import type { MenuCtx } from '../../src/ui/screens/shared';
import { makeSim, step } from './helpers';
import { CHAPTER1, CHAPTER2 } from './story2_helpers';

const veraIds = new Set(VERA_MISSIONS.map((d) => d.id));

function simWith(done: readonly string[]): Sim {
  const sim = makeSim({ ambient: false });
  for (const id of done) sim.progress.markDone(id);
  step(sim, 0.1);
  sim.missions.refreshMarkers();
  return sim;
}

const veraOffers = (sim: Sim) => sim.missions.offers().filter((d) => d.giver === 'vera').map((d) => d.id);
const veraMarkers = (sim: Sim) => sim.interactions.markers.filter((m) => m.kind === 'mission' && veraIds.has(String(m.ref)));

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hue(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('chapter 2 in the registry', () => {
  it('is one contact row, one missions file and one index line: 12 missions, the first 6 unchanged', () => {
    const vera = contactById('vera');
    expect(vera).toEqual({ id: 'vera', name: 'Vera Salgado', phoneName: 'Vera Salgado (phone)', color: '#b8e62e', cssClass: 'vera', poiId: 'vera', mapLabel: 'V' });
    expect(CONTACTS.map((c) => c.id)).toEqual(['lou', 'dex', 'vera']);
    const table = STORY.map((d) => ({ id: d.id, giver: d.giver, requires: d.requires }));
    console.log(table.map((r) => `${r.id.padEnd(13)} ${r.giver.padEnd(5)} requires ${r.requires.join(',') || '-'}`).join('\n'));
    expect(STORY.length).toBe(12);
    expect(STORY.map((d) => d.id)).toEqual([...CHAPTER1, ...CHAPTER2]);
    expect(STORY.slice(6)).toEqual(VERA_MISSIONS);
    expect(VERA_MISSIONS.every((d) => d.giver === 'vera')).toBe(true);
    // A chain: The Big Score first, then each one the one before (and The Big Score still).
    expect(VERA_MISSIONS.map((d) => d.requires)).toEqual([['big_score'], ...CHAPTER2.slice(0, 5).map((id) => ['big_score', id])]);
  });

  it("has its own colour, clearly apart from Lou's and Dex's", () => {
    const vera = contactById('vera').color;
    expect(vera).toMatch(/^#[0-9a-f]{6}$/i);
    for (const other of ['lou', 'dex']) {
      const c = contactById(other).color;
      const channel = Math.max(...rgb(vera).map((v, i) => Math.abs(v - rgb(c)[i]!)));
      const dh = Math.min(Math.abs(hue(vera) - hue(c)), 360 - Math.abs(hue(vera) - hue(c)));
      expect(channel, `channels vs ${other}`).toBeGreaterThan(80);
      expect(dh, `hue vs ${other}`).toBeGreaterThan(60);
    }
    expect(contactById('lou').color).toBe('#ff4fa3');
    expect(contactById('dex').color).toBe('#38e1d2');
  });

  it('pays $7,000 to $15,000, never less than the mission before, each with an outro', () => {
    let last = 0;
    for (const d of VERA_MISSIONS) {
      expect(d.reward, d.id).toBeGreaterThanOrEqual(7000);
      expect(d.reward, d.id).toBeLessThanOrEqual(15000);
      expect(d.reward, d.id).toBeGreaterThanOrEqual(last);
      last = d.reward;
      expect(d.outro?.text, d.id).toBeTruthy();
      expect(d.outro?.sub, d.id).toBeTruthy();
      expect(d.outro!.duration, d.id).toBeGreaterThan(0);
    }
    console.log(VERA_MISSIONS.map((d) => `${d.title}: $${d.reward}`).join(' | '));
  });
});

describe('chapter 2 unlocks after The Big Score', () => {
  const sets: Array<[string, string[]]> = [
    ['none', []],
    ['wheels..heatwave', CHAPTER1.slice(0, 5)],
    ...[...CHAPTER1.slice(0, 5), ...CHAPTER2].map((id): [string, string[]] => [`only ${id}`, [id]]),
    ['all but big_score', [...CHAPTER1.slice(0, 5), ...CHAPTER2]],
  ];

  it.each(sets)('offers nothing of Vera with %s done', (_name, done) => {
    const sim = simWith(done);
    expect(veraOffers(sim)).toEqual([]);
    expect(veraMarkers(sim)).toEqual([]);
    expect(collectBlips(sim, 0).some((b) => b.label === 'V')).toBe(false);
  });

  it('offers Shadow Play at her POI in her colour once The Big Score is done, and nothing of Lou or Dex', () => {
    const sim = simWith(CHAPTER1);
    expect(sim.missions.offers().map((d) => d.id)).toEqual(['shadow_play']);
    const poi = sim.world.layout.pois.find((p) => p.id === 'vera')!;
    expect(poi).toMatchObject({ kind: 'contactVera', name: 'Hotel Salgado' });
    expect(veraMarkers(sim)).toEqual([expect.objectContaining({ id: 'mission:shadow_play', x: poi.x, z: poi.z, label: 'Press E to start "Shadow Play"', color: contactColorNumber(contactById('vera')) })]);
    const blip = collectBlips(sim, 0).find((b) => b.label === 'V');
    expect(blip).toMatchObject({ x: poi.x, z: poi.z, color: '#b8e62e', sticky: true, shape: 'circle' });
    const def = VERA_MISSIONS[0]!;
    expect(offerCardClass(def)).toBe('vera');
    expect(missionCard(def, 'Press E')).toContain('<span class="card-giver">Vera Salgado</span>');
  });

  it('offers exactly one chapter 2 mission at a time, in chain order', () => {
    for (let n = 0; n < CHAPTER2.length; n++) {
      const sim = simWith([...CHAPTER1, ...CHAPTER2.slice(0, n)]);
      expect(veraOffers(sim), `after ${n}`).toEqual([CHAPTER2[n]]);
      expect(veraMarkers(sim).map((m) => m.ref)).toEqual([CHAPTER2[n]]);
      for (const later of CHAPTER2.slice(n + 1)) expect(sim.missions.start(later), later).toBe(false);
    }
    const all = simWith([...CHAPTER1, ...CHAPTER2]);
    expect(all.missions.offers()).toEqual([]);
  });
});

// --- completion on the STATS screen (a minimal DOM: the screen only builds elements and sets innerHTML) -------------

class FakeEl {
  className = '';
  innerHTML = '';
  textContent = '';
  tabIndex = 0;
  readonly children: FakeEl[] = [];
  readonly classList = { add() {}, remove() {}, toggle() {} };
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  addEventListener(): void {}
  focus(): void {}
}

function statsOf(sim: Sim): { completion: string; story: string } {
  const g = globalThis as { document?: unknown };
  const before = g.document;
  g.document = { createElement: () => new FakeEl() };
  let screen: { el: FakeEl } | null = null;
  try {
    const ctx = { host: { sim: () => sim, localPlayerId: () => 0 }, push: (s: { el: FakeEl }) => (screen = s), pop() {}, closeAll() {} } as unknown as MenuCtx;
    showStats(ctx);
  } finally {
    g.document = before;
  }
  const html = (screen as { el: FakeEl } | null)!.el.children[0]!.innerHTML;
  const row = (label: string) => new RegExp(`<span>${label}</span><span>([^<]*)</span>`).exec(html)?.[1] ?? '';
  return { completion: row('Game completion'), story: row('Story missions') };
}

describe('completion counts 12 story missions', () => {
  /** A save as mission 1's build wrote it: version 1, no ext. */
  const legacy = (missionsDone: string[]) => ({
    version: 1,
    savedAt: 1767225600000,
    money: 31000,
    missionsDone,
    packages: [],
    stunts: [],
    rampages: [],
    streetRuns: {},
    stats: {},
    weapons: [{ id: 'pistol', ammo: 24 }],
    armor: 0,
    hours: 12,
    day: 3,
  });

  function loaded(raw: unknown): Sim {
    const parsed = parseSave(JSON.parse(JSON.stringify(raw)));
    expect(parsed).not.toBeNull();
    const sim = makeSim({ ambient: false });
    applySave(sim.progress, parsed!);
    return sim;
  }

  it('shows 0% with nothing done', () => {
    const s = statsOf(makeSim({ ambient: false }));
    console.log('nothing done:', s);
    expect(s).toEqual({ completion: '0%', story: '0 / 12' });
  });

  it('shows 25% and 6 / 12 for a mission 1 save with the whole first story done', () => {
    const sim = loaded(legacy([...CHAPTER1]));
    expect(sim.progress.missionsDone).toEqual(CHAPTER1);
    const s = statsOf(sim);
    console.log('old save, chapter 1 done:', s);
    expect(s).toEqual({ completion: '25%', story: '6 / 12' });
    // ...and Vera has work for it.
    step(sim, 0.1);
    expect(sim.missions.offers().map((d) => d.id)).toEqual(['shadow_play']);
  });

  it('shows 50% with all 12 done and nothing else, 100% with everything', () => {
    const sim = loaded(legacy([...CHAPTER1, ...CHAPTER2]));
    const half = statsOf(sim);
    console.log('all 12 missions:', half);
    expect(half).toEqual({ completion: '50%', story: '12 / 12' });
    const p = sim.progress;
    p.packages = Array.from({ length: PACKAGE_COUNT }, (_, i) => i);
    p.stunts = sim.world.layout.ramps.map((_, i) => i);
    p.rampages = ['a', 'b', 'c'];
    const full = statsOf(sim);
    console.log('everything:', full);
    expect(full).toEqual({ completion: '100%', story: '12 / 12' });
  });
});

describe('chapter 2 progress in the save', () => {
  function reload(sim: Sim): Sim {
    const raw = JSON.parse(JSON.stringify(serialize(sim.progress, [], 0, 12, 1)));
    expect(raw.version).toBe(1);
    const b = makeSim({ ambient: false });
    applySave(b.progress, parseSave(raw)!);
    step(b, 0.1);
    return b;
  }

  it('keeps passed chapter 2 missions and their money, and offers the next one (none after the finale)', () => {
    for (const n of [1, 6]) {
      const sim = simWith(CHAPTER1);
      for (const id of CHAPTER2.slice(0, n)) {
        sim.progress.markDone(id);
        sim.progress.addMoney(VERA_MISSIONS.find((d) => d.id === id)!.reward);
      }
      const b = reload(sim);
      expect(b.progress.missionsDone.filter((id) => CHAPTER2.includes(id))).toEqual(CHAPTER2.slice(0, n));
      expect(b.progress.money).toBe(sim.progress.money);
      expect(veraOffers(b)).toEqual(n < 6 ? [CHAPTER2[n]] : []);
    }
  });
});
