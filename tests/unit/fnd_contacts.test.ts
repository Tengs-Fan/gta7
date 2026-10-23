import { afterEach, describe, expect, it } from 'vitest';
import { CONTACTS, contactById, contactColorNumber, registerContact, unregisterContact, type ContactDef } from '../../src/sim/missions/contacts';
import { DEX } from '../../src/sim/missions/dex';
import { registerContactMissions, STORY, unregisterContactMissions } from '../../src/sim/missions/index';
import { LOU } from '../../src/sim/missions/lou';
import type { MissionDef } from '../../src/sim/missions/runner';
import { STORY as REEXPORTED } from '../../src/sim/missions/story';
import { missionCard, offerCardClass } from '../../src/ui/hud';
import { collectBlips } from '../../src/ui/mapRender';
import { makeSim, step } from './helpers';

/** The story as it stood in missions/story.ts before it was split per contact. */
const BASELINE = [
  { id: 'wheels', title: 'Wheels', giver: 'lou', reward: 500, requires: [] },
  { id: 'delivery', title: 'Hot Delivery', giver: 'lou', reward: 1200, requires: ['wheels'] },
  { id: 'repo', title: 'Repo Man', giver: 'lou', reward: 2500, requires: ['delivery'] },
  { id: 'loose_lips', title: 'Loose Lips', giver: 'dex', reward: 4000, requires: ['repo'] },
  { id: 'heatwave', title: 'Heatwave', giver: 'dex', reward: 6000, requires: ['loose_lips'] },
  { id: 'big_score', title: 'The Big Score', giver: 'dex', reward: 25000, requires: ['heatwave'] },
];

const summary = (d: MissionDef) => ({ id: d.id, title: d.title, giver: d.giver, reward: d.reward, requires: d.requires });

describe('contact table', () => {
  it('has Lou and Dex with the colours, labels and names they always had', () => {
    // Vera Salgado (chapter 2) comes after them.
    expect(CONTACTS.map((c) => c.id)).toEqual(['lou', 'dex', 'vera']);
    const lou = contactById('lou');
    expect(lou).toMatchObject({ name: 'Mama Lou', phoneName: 'Mama Lou (phone)', color: '#ff4fa3', cssClass: 'lou', poiId: 'lou', mapLabel: 'L' });
    expect(contactColorNumber(lou)).toBe(0xff4fa3);
    const dex = contactById('dex');
    expect(dex).toMatchObject({ name: 'Dex Moreau', color: '#38e1d2', cssClass: 'dex', poiId: 'dex', mapLabel: 'D' });
    expect(contactColorNumber(dex)).toBe(0x38e1d2);
    for (const c of CONTACTS) for (const k of ['id', 'name', 'phoneName', 'color', 'cssClass', 'poiId', 'mapLabel'] as const) expect(c[k], `${c.id}.${k}`).toBeTruthy();
  });

  it('rejects an unknown or duplicate contact', () => {
    expect(() => contactById('nobody')).toThrow(/Unknown contact/);
    expect(() => registerContact({ ...contactById('lou') })).toThrow(/already registered/);
  });
});

describe('story per contact', () => {
  it('keeps the ids, order, titles, givers and unlock requirements of the single story file', () => {
    // Chapter 2 is appended after them (see story2_contact.test.ts).
    expect(STORY.slice(0, BASELINE.length).map(summary)).toEqual(BASELINE);
    expect(REEXPORTED).toBe(STORY);
  });

  it("keeps each mission in its giver's file", () => {
    expect(LOU.map((d) => d.id)).toEqual(['wheels', 'delivery', 'repo']);
    expect(DEX.map((d) => d.id)).toEqual(['loose_lips', 'heatwave', 'big_score']);
    expect(LOU.every((d) => d.giver === 'lou')).toBe(true);
    expect(DEX.every((d) => d.giver === 'dex')).toBe(true);
  });
});

describe('a contact added by a table row and a missions array', () => {
  const FIXTURE: ContactDef = { id: 'fixture', name: 'Fixture Fran', phoneName: 'Fixture Fran (phone)', color: '#12ab34', cssClass: 'fixture', poiId: 'bank', mapLabel: 'F' };
  const MISSION: MissionDef = {
    id: 'fixture_job',
    title: 'Fixture Job',
    giver: 'fixture',
    reward: 777,
    requires: ['wheels'],
    blurb: 'A mission that only exists in a test.',
    *run(m) {
      m.objective('Wait');
      yield m.until(() => false);
    },
  };
  const ORIGINAL_CONTACTS = [...CONTACTS];
  const ORIGINAL_STORY = [...STORY];

  afterEach(() => {
    unregisterContactMissions([MISSION]);
    unregisterContact(FIXTURE.id);
  });

  it('is offered at its POI in its colour once unlocked, and starts with its name on the title card', () => {
    registerContact(FIXTURE);
    registerContactMissions(FIXTURE.id, [MISSION]);
    const sim = makeSim({ ambient: false });
    step(sim, 0.1);
    const marker = () => sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === MISSION.id);
    expect(marker()).toBeUndefined();

    sim.progress.markDone('wheels');
    sim.missions.refreshMarkers();
    const poi = sim.world.layout.pois.find((p) => p.id === FIXTURE.poiId)!;
    expect(marker()).toMatchObject({ x: poi.x, z: poi.z, color: 0x12ab34, ref: MISSION.id });
    expect(sim.missions.offers().map((d) => d.id)).toEqual(['delivery', MISSION.id]);

    const cards: Array<{ text: string; sub: string; style: string }> = [];
    sim.events.on('big', (e) => cards.push(e));
    expect(sim.missions.start(MISSION.id)).toBe(true);
    expect(cards).toContainEqual(expect.objectContaining({ text: 'FIXTURE JOB', sub: 'Fixture Fran', style: 'title' }));
  });

  it('is found by the HUD and map lookups', () => {
    registerContact(FIXTURE);
    registerContactMissions(FIXTURE.id, [MISSION]);
    const sim = makeSim({ ambient: false });
    sim.progress.markDone('wheels');
    step(sim, 0.1);
    expect(offerCardClass(MISSION)).toBe('fixture');
    expect(offerCardClass(undefined)).toBeNull();
    expect(missionCard(MISSION, 'Press E')).toContain('<span class="card-giver">Fixture Fran</span>');
    const poi = sim.world.layout.pois.find((p) => p.id === FIXTURE.poiId)!;
    const blip = collectBlips(sim, 0).find((b) => b.label === 'F');
    expect(blip).toMatchObject({ x: poi.x, z: poi.z, color: '#12ab34', sticky: true, shape: 'circle' });
  });

  it('leaves the real tables as they were', () => {
    expect(CONTACTS).toEqual(ORIGINAL_CONTACTS);
    expect(STORY).toEqual(ORIGINAL_STORY);
    expect(STORY.slice(0, BASELINE.length).map(summary)).toEqual(BASELINE);
  });
});
