import { afterEach, describe, expect, it } from 'vitest';
import { cabRefusal, cabState, callCab } from '../../src/sim/activities/cab';
import { registerContact, unregisterContact } from '../../src/sim/missions/contacts';
import { registerContactMissions, unregisterContactMissions } from '../../src/sim/missions/index';
import type { MissionDef } from '../../src/sim/missions/runner';
import { CALL_DELAY, CALL_HANDS_FREE, CALL_RING, MAX_TEXTS, PhoneCalls, phoneContacts, PhoneLog } from '../../src/ui/widgets/phone';
import { input, makeSim } from './helpers';

const CH1 = ['wheels', 'delivery', 'repo', 'loose_lips', 'heatwave'];

/** A chapter 2 contact as the story track adds one: a row, and a first mission that needs The Big Score. */
const vera = { id: 'vera_test', name: 'Vera Test', phoneName: 'Vera Test (phone)', color: '#9b6bff', cssClass: 'vera_test', poiId: 'lou', mapLabel: 'V' };
const veraMission: MissionDef = { id: 'vera_first', title: 'Vera First', giver: 'vera_test', reward: 7000, requires: ['big_score'], blurb: 'x', *run() {} };
/** A row with no missions at all. */
const plain = { id: 'plain_test', name: 'Plain Test', phoneName: 'Plain (phone)', color: '#12ab34', cssClass: 'plain_test', poiId: 'dex', mapLabel: 'P' };

afterEach(() => {
  unregisterContactMissions([veraMission]);
  unregisterContact(vera.id);
  unregisterContact(plain.id);
});

describe('phone contacts come from the contact registry', () => {
  it('lists Lou and Dex on a new game, a chapter 2 contact only after The Big Score, and any new row', () => {
    const sim = makeSim({ ambient: false });
    const ids = () => phoneContacts(sim, sim.players[0]!).map((c) => c.id);
    expect(ids()).toEqual(['lou', 'dex']);
    registerContact(vera);
    registerContactMissions(vera.id, [veraMission]);
    expect(ids()).toEqual(['lou', 'dex']);
    for (const id of CH1) sim.progress.markDone(id);
    expect(ids()).toEqual(['lou', 'dex']);
    sim.progress.markDone('big_score');
    // Vera Salgado (the story's chapter 2) shows from here on, like the test's own chapter 2 row.
    expect(ids()).toEqual(['lou', 'dex', 'vera', 'vera_test']);
    registerContact(plain);
    expect(ids()).toEqual(['lou', 'dex', 'vera', 'vera_test', 'plain_test']);
    console.log('new game: lou, dex; before big_score: lou, dex; after: lou, dex, vera, vera_test; with a plain row: + plain_test');
  });
});

describe('incoming calls', () => {
  const quiet = { talking: false, inVehicle: false };
  const run = (calls: PhoneCalls, sim: ReturnType<typeof makeSim>, seconds: number, frame = quiet) => {
    const out: Array<string | null> = [];
    for (let t = 0; t < seconds; t += 0.1) out.push(calls.update(0.1, sim, sim.players[0]!, frame));
    return out;
  };

  it('a contact rings when new work turns up, and the call never starts the mission', () => {
    const sim = makeSim({ ambient: false });
    const calls = new PhoneCalls();
    calls.reset(sim);
    run(calls, sim, 10);
    expect(calls.ringing).toBeNull();
    sim.progress.markDone('wheels');
    run(calls, sim, CALL_DELAY - 0.5);
    expect(calls.ringing).toBeNull();
    run(calls, sim, 1);
    expect(calls.ringing?.contact.id).toBe('lou');
    expect(calls.ringing?.mission.id).toBe('delivery');
    const answered = calls.answer();
    expect(answered?.mission.id).toBe('delivery');
    expect(sim.missions.active).toBeNull();
    console.log('after wheels: Lou rings about "delivery" after', CALL_DELAY, 's');
  });

  it('no call during a mission, a side job or a line of dialogue; it rings once they are over', () => {
    const sim = makeSim({ ambient: false });
    const calls = new PhoneCalls();
    calls.reset(sim);
    sim.progress.markDone('wheels');
    sim.missions.start('delivery');
    run(calls, sim, 20);
    expect(calls.ringing).toBeNull();
    sim.missions.abandon();
    sim.update(1 / 60, input());
    run(calls, sim, 20, { talking: true, inVehicle: false });
    expect(calls.ringing).toBeNull();
    // A street run holds it too.
    const car = sim.spawnVehicle('sports', sim.player.pos.x + 4, sim.player.pos.z, 0);
    sim.seat(sim.player, car, 0);
    expect(sim.activities.startStreetRun()).toBe(true);
    run(calls, sim, 20);
    expect(calls.ringing).toBeNull();
    sim.activities.cancelAll('mission');
    run(calls, sim, CALL_DELAY + 1.5);
    expect(calls.ringing?.mission.id).toBe('delivery');
    // A line of dialogue starting cuts the ringing short; it rings again later.
    run(calls, sim, 0.2, { talking: true, inVehicle: false });
    expect(calls.ringing).toBeNull();
    run(calls, sim, 3);
    expect(calls.ringing?.mission.id).toBe('delivery');
    console.log('held during a mission, dialogue and a street run; rang after each was over');
  });

  it('unanswered it is missed; in a vehicle it is answered hands-free', () => {
    const sim = makeSim({ ambient: false });
    const calls = new PhoneCalls();
    calls.reset(sim);
    sim.progress.markDone('wheels');
    run(calls, sim, CALL_DELAY + 0.5);
    expect(calls.ringing).not.toBeNull();
    expect(run(calls, sim, CALL_RING + 0.5)).toContain('missed');
    expect(calls.ringing).toBeNull();
    sim.progress.markDone('delivery');
    run(calls, sim, CALL_DELAY + 0.5);
    expect(calls.ringing?.mission.id).toBe('repo');
    expect(run(calls, sim, CALL_HANDS_FREE + 0.3, { talking: false, inVehicle: true })).toContain('answer');
  });
});

describe('the text log', () => {
  it('lists a mission reward and a taxi fare with the amounts paid, newest first, at most MAX_TEXTS', () => {
    const sim = makeSim({ ambient: false });
    const log = new PhoneLog();
    log.bind(sim);
    const before = sim.progress.money;
    expect(sim.missions.start('wheels')).toBe(true);
    sim.missions.settle(sim.missions.active!);
    const reward = sim.progress.money - before;
    log.flush(sim);
    // A taxi fare as the taxi activity pays it: the fare, then the milestone.
    sim.progress.addMoney(87);
    sim.events.emit('money', { amount: 87 });
    sim.events.emit('activityMilestone', { kind: 'taxi', reward: 87 });
    log.flush(sim);
    // Money nothing claims (business income, a cheat) is a payment.
    sim.events.emit('money', { amount: 120 });
    log.flush(sim);
    const e = log.entries;
    console.log(e.map((x) => `${x.from}: ${x.text} ${x.amount ?? ''}`).join('\n'));
    expect(e.map((x) => [x.text, x.amount])).toEqual([
      ['Payment received', 120],
      ['Taxi fare', 87],
      [expect.stringContaining(': nice work. Your cut is in.'), reward],
    ]);
    expect(e[2]!.from).toBe('Mama Lou');
    expect(reward).toBe(500);
    for (let i = 0; i < MAX_TEXTS + 5; i++) {
      sim.events.emit('activityMilestone', { kind: 'vigilante', reward: i + 1 });
      log.flush(sim);
    }
    expect(log.entries).toHaveLength(MAX_TEXTS);
    expect(log.entries[0]!.amount).toBe(MAX_TEXTS + 5);
    expect(log.entries[MAX_TEXTS - 1]!.amount).toBe(6);
    log.unbind();
  });
});

describe('calling a cab', () => {
  it('is refused while wanted, in a vehicle or during a mission, and only one comes', () => {
    const sim = makeSim({ ambient: true, police: false });
    sim.update(1 / 60, input());
    sim.wanted.setLevel(1);
    expect(callCab(sim).ok).toBe(false);
    expect(cabRefusal(sim)).toMatch(/cops/);
    sim.wanted.clear();
    expect(sim.missions.start('wheels')).toBe(true);
    expect(callCab(sim).text).toMatch(/mission/);
    sim.missions.abandon();
    sim.update(1 / 60, input());
    const car = sim.spawnVehicle('sedan', sim.player.pos.x + 4, sim.player.pos.z, 0);
    sim.seat(sim.player, car, 0);
    expect(callCab(sim).text).toMatch(/on foot/);
    sim.unseat(sim.player);
    sim.player.state = 'normal';
    expect(callCab(sim).ok).toBe(true);
    const n = sim.vehicles.filter((v) => v.missionTag === 'cab').length;
    expect(callCab(sim).text).toMatch(/already on its way/);
    expect(sim.vehicles.filter((v) => v.missionTag === 'cab').length).toBe(n);
    expect(cabState(sim)?.stage).toBe('coming');
  });
});
