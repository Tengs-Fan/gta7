// The full map's legend names every icon the map and the radar draw, from the same table the icons are drawn from, and
// no two kinds of icon look alike.

import { describe, expect, it } from 'vitest';
import { makeBrain } from '../../src/sim/brains';
import { Helicopter } from '../../src/sim/entities';
import { propertyState } from '../../src/sim/properties';
import type { Sim } from '../../src/sim/sim';
import { blipKind, blipKindIds, collectBlips, drawBlip, legendRows, MAP_BLIP, MAP_CATEGORIES, type Blip } from '../../src/ui/mapRender';
import { makeSim, placeInCar } from './helpers';
import { CHAPTER1 } from './story2_helpers';

/** The kinds the map screen adds to collectBlips' (screens/map.ts): you, and the areas it lists from the overlays. */
const SCREEN_KINDS = ['you', 'waypoint', 'searchArea'];

/** Every blip on the full map and the radar of each of a run of sims between them showing every kind there is. */
function blipsOfEverySim(): Blip[][] {
  const out: Blip[][] = [];
  const both = (sim: Sim) => out.push(collectBlips(sim, 0, 0, { map: true }), collectBlips(sim, 0.25, 0, {}));
  // A new game: places, shops, Lou's offer, packages and rampages to find, the activities.
  both(makeSim({ ambient: false }));
  // Dex's offer.
  const dex = makeSim({ ambient: false });
  for (const id of CHAPTER1.slice(0, 5)) dex.progress.markDone(id);
  both(dex);
  // Packages and a rampage found, both properties bought, Vera's offer; a second player.
  const later = makeSim({ ambient: false });
  for (const id of CHAPTER1) later.progress.markDone(id);
  later.progress.packages.push(0);
  later.progress.rampages.push('rampage:1');
  Object.assign(propertyState(later.progress), { garage: true, business: true });
  later.interactions.update(0);
  // As a multiplayer view names him (ViewState's PlayerView).
  Object.assign(later.addPlayer(later.player.pos.x + 5, later.player.pos.z), { name: 'Bea', slot: 1 });
  both(later);
  // A mission's markers, on a place and on a car.
  const mission = makeSim({ ambient: false });
  mission.missions.start('wheels');
  const car = mission.spawnVehicle('sedan', mission.player.pos.x + 20, mission.player.pos.z, 0);
  mission.missions.active!.mark({ x: car.pos.x + 30, z: car.pos.z }, 'Somewhere');
  mission.missions.active!.mark(car, 'That car');
  both(mission);
  // Wanted, in a taxi a pedestrian waves down: a police car, an officer on foot, the helicopter, the fare.
  const wanted = makeSim({ ambient: false });
  const p = wanted.player.pos;
  const taxi = wanted.spawnVehicle('taxi', p.x, p.z, 0);
  placeInCar(wanted, taxi);
  const fare = wanted.spawnCharacter('civilian', p.x + 8, p.z);
  fare.owner = 'ped';
  fare.brain = makeBrain('idle');
  fare.hailTimer = 5;
  wanted.wanted.setLevel(3);
  wanted.spawnVehicle('police', p.x + 30, p.z, 0).owner = 'police';
  wanted.spawnCharacter('cop', p.x - 12, p.z);
  wanted.helis.push(new Helicopter(wanted.newId(), p.x + 12, 40, p.z + 12));
  both(wanted);
  return out;
}

describe('the map legend', () => {
  it('has a named row for every kind of icon the map and the radar draw, and every kind it knows can be drawn', () => {
    const seen = new Set<string>();
    for (const blips of blipsOfEverySim()) {
      const listed = legendRows(blips, SCREEN_KINDS).flatMap((r) => r.kinds);
      for (const b of blips) {
        expect(listed, `${b.kind} in the legend`).toContain(b.kind);
        expect(blipKind(b.kind).name, b.kind).not.toBe('');
        // Under the header of the category that hides it.
        const row = legendRows(blips, SCREEN_KINDS).find((r) => r.kinds.includes(b.kind))!;
        expect(row.category?.id, b.kind).toBe(b.category);
        seen.add(b.kind);
      }
    }
    // The areas the map draws from its overlays: the turf (always) and the search area (map screen).
    for (const c of MAP_CATEGORIES) for (const a of c.areas?.() ?? []) seen.add(a);
    for (const k of SCREEN_KINDS) seen.add(k);
    expect([...seen].sort()).toEqual([...blipKindIds()].sort());
    console.log(blipKindIds().map((id) => `${id}: ${blipKind(id).name}`).join('\n'));
  });

  it('gives every POI kind of the layout an icon, or leaves it out on purpose', () => {
    const sim = makeSim({ ambient: false });
    const kinds = [...new Set(sim.world.layout.pois.map((p) => p.kind))];
    const icons = new Set(collectBlips(sim, 0, 0, { map: true }).map((b) => b.kind));
    // The bank and the Marina are mission places; a contact's place carries his icon while he has work.
    const without = kinds.filter((k) => !icons.has(k));
    expect(without.sort()).toEqual(['bank', 'contactDex', 'contactLou', 'contactVera', 'marina']);
  });

  it('lists only what is on the map: a locked contact, the police and a found package have no row until they show', () => {
    const fresh = collectBlips(makeSim({ ambient: false }), 0, 0, { map: true });
    const names = legendRows(fresh, SCREEN_KINDS).flatMap((r) => r.kinds.map((k) => blipKind(k).name));
    expect(names).toContain('Mama Lou (missions)');
    expect(names).toContain('Hidden package');
    for (const n of ['Vera Salgado (missions)', 'Police unit', 'Hidden package (found)', 'Safehouse garage (owned)']) expect(names).not.toContain(n);
    // Every category keeps its header, in order, and the live markers come last.
    expect(legendRows(fresh, SCREEN_KINDS).map((r) => r.category?.id ?? 'live')).toEqual([...MAP_CATEGORIES.map((c) => c.id), 'live']);
  });
});

describe('icons that mean one thing', () => {
  it('draws no two kinds alike, and a letter or icon means one place (for sale or owned)', () => {
    const ids = blipKindIds();
    const looks = new Map<string, string>();
    for (const id of ids) {
      const k = blipKind(id);
      const look = `${k.label}|${k.color.toLowerCase()}|${k.shape}`;
      expect(looks.get(look), `${id} looks like ${looks.get(look)}`).toBeUndefined();
      looks.set(look, id);
    }
    const byLabel = new Map<string, Set<string>>();
    for (const id of ids) {
      const k = blipKind(id);
      if (!k.label) continue;
      const place = k.name.replace(/ \(.*\)$/, '');
      byLabel.set(k.label, new Set([...(byLabel.get(k.label) ?? []), place]));
    }
    const shared = [...byLabel].filter(([, places]) => places.size > 1).map(([label, places]) => `${label}: ${[...places].join(', ')}`);
    expect(shared).toEqual([]);
    console.log([...byLabel].map(([label, places]) => `${label} ${[...places].join(', ')}`).join('\n'));
  });

  it('draws the icons as pictures, not as the words that name them', () => {
    for (const id of blipKindIds()) {
      const k = blipKind(id);
      const texts: string[] = [];
      const ctx = new Proxy({} as Record<string | symbol, unknown>, {
        get: (t, key) => (key in t ? t[key] : (...args: unknown[]) => (key === 'fillText' || key === 'strokeText' ? texts.push(String(args[0])) : undefined)),
        set: (t, key, v) => {
          t[key] = v;
          return true;
        },
      }) as unknown as CanvasRenderingContext2D;
      drawBlip(ctx, { x: 0, z: 0, kind: id, color: k.color, label: k.label, shape: k.shape, sticky: false }, 0, 0, MAP_BLIP);
      // A letter is written; an icon's name never is (a '$' is drawn as an S with a long bar).
      for (const t of texts) expect(t.length, `${id} writes "${t}"`).toBe(1);
      if (k.label.length > 1) expect(texts, id).toEqual([]);
    }
  });
});
