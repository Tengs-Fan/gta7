import { afterEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../src/game';
import { loadGame } from '../../src/settings';
import { applySave } from '../../src/sim/progress';
import type { Sim } from '../../src/sim/sim';
import { HintSystem } from '../../src/ui/hints';
import type { HintOptions } from '../../src/ui/hud';
import { input, makeSim, placeInCar, roadPoint, step, teleport } from './helpers';

// Lifecycle tests exercise the real Game methods; this Node suite has no GPU or canvas.
vi.mock('../../src/render/renderer', () => ({ GameRenderer: class {} }));

afterEach(() => vi.unstubAllGlobals());

function setup(): Sim {
  const sim = makeSim({ ambient: false, police: false });
  step(sim, 0.1);
  return sim;
}

/** Real vehicle job kept alive by the opening F of a possible FIXMYRIDE code. */
function exitedJob(sim: Sim, kind: 'taxi' | 'police'): void {
  const road = roadPoint(sim);
  const car = sim.spawnVehicle(kind, road.x, road.z, road.heading);
  placeInCar(sim, car);
  sim.activities.toggleJob();
  expect(sim.activities.job?.kind).toBe(kind === 'taxi' ? 'taxi' : 'vigilante');
  sim.activities.exitUndoable = true;
  sim.playerCtl.ejectPlayer(true);
  step(sim, 0.1);
  expect(sim.player.onFoot).toBe(true);
  expect(sim.activities.busy).toBe(true);
}

describe('on-foot recovery after a vehicle job', () => {
  for (const kind of ['taxi', 'police'] as const) {
    it(`saves and heals on the first E after leaving a ${kind}, and ends its held job`, () => {
      const sim = setup();
      exitedJob(sim, kind);
      const home = sim.interactions.markers.find((m) => m.kind === 'save')!;
      teleport(sim, home.x, home.z);
      sim.player.health = 25;
      const saved = vi.fn();
      const message = vi.fn();
      sim.events.on('saveRequested', saved);
      sim.events.on('message', message);
      expect(sim.interactions.prompt()).toBe('Press E to save your game');
      sim.update(1 / 60, input({ interact: true }));
      expect(saved).toHaveBeenCalledOnce();
      expect(sim.player.health).toBe(sim.player.maxHealth);
      expect(sim.activities.job).toBeNull();
      expect(sim.activities.exitUndoable).toBe(false);
      expect(message.mock.calls.some(([e]) => /rampage/i.test(e.text))).toBe(false);
    });

    it(`takes an offered retry immediately after leaving a ${kind}`, () => {
      const sim = setup();
      expect(sim.missions.start('wheels', { retrying: true })).toBe(true);
      sim.missions.active!.fail('The car was destroyed.');
      step(sim, 0.1);
      exitedJob(sim, kind);
      expect(sim.interactions.prompt()).toBe('Press E to retry "Wheels"');
      sim.update(1 / 60, input({ interact: true }));
      expect(sim.activities.job).toBeNull();
      expect(sim.controlLock).toBeGreaterThan(0);
      step(sim, 0.8);
      expect(sim.missions.active?.def.id).toBe('wheels');
      expect(sim.missions.active?.retrying).toBe(true);
    });
  }

  it('keeps wanted, mission and rampage save restrictions without ending those activities', () => {
    for (const blocked of ['wanted', 'mission', 'rampage'] as const) {
      const sim = setup();
      if (blocked === 'wanted') sim.wanted.setLevel(1);
      if (blocked === 'mission') expect(sim.missions.start('wheels')).toBe(true);
      if (blocked === 'rampage') expect(sim.activities.startRampage('rampage:0')).toBe(true);
      const home = sim.interactions.markers.find((m) => m.kind === 'save')!;
      teleport(sim, home.x, home.z);
      sim.player.health = 25;
      const saved = vi.fn();
      sim.events.on('saveRequested', saved);
      expect(sim.interactions.canSave()).toBe(false);
      sim.interactions.interact();
      expect(saved).not.toHaveBeenCalled();
      expect(sim.player.health).toBe(25);
      if (blocked === 'mission') expect(sim.missions.active?.def.id).toBe('wheels');
      if (blocked === 'rampage') expect(sim.activities.job?.kind).toBe('rampage');
    }
  });
});

function hintRig(sim: Sim) {
  const seen = ['drive', 'wanted', 'weapon', 'mouse'];
  const pending = new Map<string, { text: string; options: HintOptions }>();
  const hints = new HintSystem({
    enabled: () => true,
    seen: () => seen,
    markSeen: (id) => seen.push(id),
    pending: (id) => pending.has(id),
    show: (text, _duration, options) => {
      pending.set(options.id, { text, options });
      return true;
    },
  });
  const update = () => hints.update(1 / 60, sim, { device: 'kb', mouseFree: false });
  return { pending, seen, update };
}

describe('health guidance matches available recovery', () => {
  for (const blocked of ['wanted', 'mission', 'rampage'] as const) {
    it(`offers available health sources during ${blocked}, reserving the safehouse lesson for later`, () => {
      const sim = setup();
      sim.player.health = 20;
      if (blocked === 'wanted') sim.wanted.setLevel(1);
      if (blocked === 'mission') expect(sim.missions.start('wheels')).toBe(true);
      if (blocked === 'rampage') expect(sim.activities.startRampage('rampage:0')).toBe(true);
      const { pending, seen, update } = hintRig(sim);
      update();
      const restricted = pending.get('health:restricted')!;
      expect(restricted.text).toContain('health pickup');
      expect(restricted.text).toContain('First Aid');
      expect(restricted.text).not.toContain('safehouse');
      expect(pending.has('health')).toBe(false);
      restricted.options.onRead!();
      expect(seen).not.toContain('health');
      sim.wanted.clear();
      sim.missions.abandon();
      sim.activities.cancelAll('mission');
      step(sim, 0.1);
      expect(restricted.options.valid!()).toBe(false);
      update();
      expect(pending.get('health')?.text).toContain('save at the safehouse');
    });
  }

  it('invalidates queued safehouse advice as soon as a mission begins', () => {
    const sim = setup();
    sim.player.health = 20;
    const { pending, update } = hintRig(sim);
    update();
    const health = pending.get('health')!;
    expect(health.options.valid!()).toBe(true);
    expect(sim.missions.start('wheels')).toBe(true);
    expect(health.options.valid!()).toBe(false);
    update();
    expect(pending.get('health:restricted')?.options.valid!()).toBe(true);
  });
});

describe('pause-menu retry preserves recovery after the quick prompt expires', () => {
  it('keeps the earned Heatwave checkpoint and purchased equipment after thirty seconds', () => {
    const sim = setup();
    for (const id of ['wheels', 'delivery', 'repo', 'loose_lips']) sim.progress.markDone(id);
    sim.player.inventory.give('pistol', 48);
    sim.cheats.godMode = true;
    expect(sim.missions.start('heatwave', { retrying: true })).toBe(true);
    step(sim, 0.1);
    const first = sim.missions.active!;
    expect(first.vehicles).toHaveLength(3);
    for (const van of first.vehicles) sim.combat.damageVehicle(van, 100_000, sim.player, 'explosion');
    step(sim, 0.2);
    expect(first.checkpointReached).toBe(1);
    expect(first.objectiveText).toBe('Lose the cops');
    first.fail('The crew got away.');
    step(sim, 0.1);
    sim.wanted.clear();
    sim.progress.addMoney(2000);
    expect(sim.interactions.buy('buy:shotgun')).toBeNull();
    const shells = sim.player.inventory.total('shotgun');
    step(sim, 30);
    expect(sim.missions.retryOffer()).toBeNull();
    expect(sim.missions.retryNow()).toBe(false);
    expect(sim.missions.retryMenuOffer()).toEqual({ id: 'heatwave', title: 'Heatwave', checkpoint: 1, blocked: null });
    expect(sim.missions.retryNow(true)).toBe(true);
    expect(sim.missions.retryMenuOffer()).toBeNull();
    step(sim, 0.8);
    const retried = sim.missions.active!;
    expect(retried).not.toBe(first);
    expect(retried.resume).toBe(1);
    expect(retried.vehicles).toHaveLength(0);
    expect(retried.objectiveText).toBe('Lose the cops');
    expect(sim.player.inventory.total('shotgun')).toBe(shells);
    expect(sim.player.inventory.total('pistol')).toBe(48);
  });

  it('explains blocked retries and never abandons a live rampage or retries while seated or wanted', () => {
    const sim = setup();
    expect(sim.missions.start('wheels')).toBe(true);
    sim.missions.active!.fail('No car.');
    step(sim, 21);
    sim.wanted.setLevel(1);
    expect(sim.missions.retryMenuOffer()?.blocked).toMatch(/cops/);
    expect(sim.missions.retryNow(true)).toBe(false);
    sim.wanted.clear();
    const road = roadPoint(sim);
    placeInCar(sim, sim.spawnVehicle('sedan', road.x, road.z, road.heading));
    expect(sim.missions.retryMenuOffer()?.blocked).toMatch(/vehicle/);
    expect(sim.missions.retryNow(true)).toBe(false);
    sim.playerCtl.ejectPlayer(true);
    expect(sim.activities.startRampage('rampage:0')).toBe(true);
    expect(sim.missions.retryMenuOffer()?.blocked).toMatch(/rampage/);
    expect(sim.missions.retryNow(true)).toBe(false);
    expect(sim.activities.job?.kind).toBe('rampage');
  });

  it('commits an exited taxi job when taking the durable menu retry', () => {
    const sim = setup();
    expect(sim.missions.start('wheels')).toBe(true);
    sim.missions.active!.fail('No car.');
    step(sim, 21);
    exitedJob(sim, 'taxi');
    expect(sim.missions.retryMenuOffer()?.blocked).toBeNull();
    expect(sim.missions.retryNow(true)).toBe(true);
    expect(sim.activities.job).toBeNull();
    step(sim, 0.8);
    expect(sim.missions.active?.retrying).toBe(true);
  });

  it('clears the durable offer when another mission is deliberately started, and never offers abandoned missions', () => {
    const sim = setup();
    sim.progress.markDone('wheels');
    sim.progress.markDone('repo');
    expect(sim.missions.start('delivery')).toBe(true);
    sim.missions.active!.fail('No package.');
    step(sim, 21);
    expect(sim.missions.retryMenuOffer()?.id).toBe('delivery');
    expect(sim.missions.start('loose_lips')).toBe(true);
    expect(sim.missions.retryMenuOffer()).toBeNull();
    sim.missions.abandon();
    step(sim, 0.1);
    expect(sim.missions.retryMenuOffer()).toBeNull();
  });
});

/** Real Game save and quit methods with browser rendering/audio replaced by inert lifecycle hosts. */
function quitRig(sim: Sim) {
  const storage = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
  const game = {
    sim,
    mode: 'game',
    pendingAutosave: false,
    unsub: [] as Array<() => void>,
    hud: { toast: vi.fn(), setVisible: vi.fn() },
    audio: { setPaused: vi.fn(), attach: vi.fn() },
    renderer: { attach: vi.fn(), cameraCtl: { mode: 'play' } },
    canvas: { classList: { remove: vi.fn() } },
    menus: { showTitle: vi.fn() },
    makeTitleSim: () => setup(),
    save: (_auto: boolean) => {},
    flushAutosave: () => {},
  };
  const methods = Game.prototype as unknown as { save(auto: boolean): void; quitToTitle(): void; bindSaves(sim: Sim): Array<() => void>; flushAutosave(): void };
  const saves = vi.fn((auto: boolean) => methods.save.call(game, auto));
  game.save = saves;
  game.flushAutosave = () => methods.flushAutosave.call(game);
  game.unsub.push(...methods.bindSaves.call(game, sim));
  return { quit: () => methods.quitToTitle.call(game), flush: game.flushAutosave, saves, game };
}

describe('quitting after a passed mission settles the pending hospital/bail autosave', () => {
  for (const kind of ['wasted', 'busted'] as const) {
    for (const beforeMissionTick of [false, true]) {
      it(`${kind}, quit ${beforeMissionTick ? 'before' : 'after'} the mission ending tick: one reward, one bill and correct equipment on CONTINUE`, () => {
        const sim = setup();
        const { quit, flush, saves, game } = quitRig(sim);
        sim.player.inventory.give('pistol', 48);
        sim.player.armor = 80;
        sim.wanted.setLevel(2);
        const money = sim.progress.money;
        expect(sim.missions.start('wheels')).toBe(true);
        const mission = sim.missions.active!;
        mission.complete();
        flush();
        expect(saves).toHaveBeenCalledTimes(1);
        expect(loadGame()?.money).toBe(money + mission.reward);
        if (kind === 'busted') sim.bustPlayer();
        else {
          sim.player.health = 0;
          sim.playerDied();
        }
        if (!beforeMissionTick) step(sim, 0.1);
        const simTime = sim.time;
        quit();
        expect(game.mode).toBe('title');
        expect(sim.time).toBe(simTime); // no city/physics advance to fast-forward the death screen
        expect(sim.playerDown).toBe(false);
        const fee = kind === 'busted' ? 400 : 300;
        const saved = loadGame()!;
        expect(saved.missionsDone.filter((id) => id === 'wheels')).toHaveLength(1);
        expect(saved.money).toBe(money + mission.reward - fee);
        expect(saved.armor).toBe(kind === 'busted' ? 80 : 0);
        expect(saved.weapons.some((w) => w.id === 'pistol')).toBe(kind !== 'busted');
        expect(saved.stats[kind === 'busted' ? 'timesBusted' : 'timesWasted']).toBe(1);
        expect(saves).toHaveBeenCalledTimes(2);
        sim.missions.settleOnQuit();
        sim.finishRespawn();
        expect(sim.progress.money).toBe(saved.money);
        expect(saves).toHaveBeenCalledTimes(2);
      });
    }
  }

  it('preserves ordinary quit semantics: an unpassed mission or free roam death does not create a save', () => {
    for (const inMission of [false, true]) {
      const sim = setup();
      const { quit, saves } = quitRig(sim);
      if (inMission) expect(sim.missions.start('wheels')).toBe(true);
      sim.player.health = 0;
      sim.playerDied();
      const money = sim.progress.money;
      quit();
      expect(saves).not.toHaveBeenCalled();
      expect(loadGame()).toBeNull();
      expect(sim.progress.money).toBe(money);
    }
  });

  it('coalesces same-frame mission reward and death into one autosave after the natural respawn', () => {
    const sim = setup();
    const { flush, saves } = quitRig(sim);
    expect(sim.missions.start('wheels')).toBe(true);
    sim.missions.active!.complete();
    sim.player.health = 0;
    sim.playerDied();
    flush();
    expect(saves).not.toHaveBeenCalled();
    for (let frame = 0; frame < 360; frame++) {
      sim.update(1 / 60, input());
      flush();
    }
    expect(sim.playerDown).toBe(false);
    expect(saves).toHaveBeenCalledOnce();
    expect(loadGame()?.money).toBe(sim.progress.money);
    expect(loadGame()?.missionsDone).toContain('wheels');
  });
});

/** Reload the saved progress and collected-pickup state into a fresh simulation. */
function reloadProgress(): Sim {
  const saved = loadGame();
  expect(saved).not.toBeNull();
  const loaded = setup();
  applySave(loaded.progress, saved!);
  loaded.pickupSys.syncCollected();
  return loaded;
}

describe('completed side content survives reload', () => {
  it('saves every package and the twentieth-package bonus after the complete pickup transaction', () => {
    const sim = setup();
    const { flush, saves } = quitRig(sim);
    const startingMoney = sim.progress.money;
    const packages = sim.pickups.filter((pickup) => pickup.kind === 'package');
    for (let index = 0; index < packages.length; index++) {
      const pickup = packages[index]!;
      teleport(sim, pickup.pos.x, pickup.pos.z);
      sim.player.pos.y = pickup.pos.y;
      sim.pickupSys.update(1 / 60);
      expect(sim.progress.packages).toHaveLength(index + 1);
      expect(saves).toHaveBeenCalledTimes(index); // event queues, it does not serialize mid-frame
      flush();
      const loaded = reloadProgress();
      expect(loaded.progress.packages).toHaveLength(index + 1);
      expect(loaded.progress.money).toBe(sim.progress.money);
      expect(loaded.pickups.filter((p) => p.kind === 'package' && !p.active)).toHaveLength(index + 1);
    }
    expect(sim.progress.money - startingMoney).toBe(packages.length * 100 + 25_000);
  });

  it('saves each real taxi drop-off, including the fifth-fare bonus, without persisting unfinished fares', () => {
    const sim = setup();
    const { flush, saves } = quitRig(sim);
    const road = roadPoint(sim);
    const cab = sim.spawnVehicle('taxi', road.x, road.z, road.heading);
    placeInCar(sim, cab);
    sim.activities.toggleJob();
    flush();
    expect(saves).not.toHaveBeenCalled();
    const milestones: Array<{ reward: number; money: number }> = [];
    sim.events.on('activityMilestone', (e) => milestones.push({ reward: e.reward, money: sim.progress.money }));
    for (let fareIndex = 0; fareIndex < 5; fareIndex++) {
      const job = sim.activities.job;
      expect(job?.kind).toBe('taxi');
      if (job?.kind !== 'taxi') throw new Error('No taxi job');
      const fare = job.fare!;
      fare.pos.x = cab.pos.x + Math.cos(cab.heading) * (cab.halfW + 0.7);
      fare.pos.z = cab.pos.z - Math.sin(cab.heading) * (cab.halfW + 0.7);
      for (let tick = 0; tick < 60 && job.stage === 'pickup'; tick++) sim.activities.update(0.1);
      expect(job.stage).toBe('dropoff');
      expect(fare.vehicle).toBe(cab);
      const before = sim.progress.money;
      const expectedFare = 15 + Math.round(job.tripDist * 0.09) + Math.round((job.timer - 0.1) * 2);
      cab.pos.x = job.destX;
      cab.pos.z = job.destZ;
      sim.activities.update(0.1);
      const expectedReward = expectedFare + (fareIndex === 4 ? 500 : 0);
      expect(sim.progress.money).toBe(before + expectedReward);
      expect(milestones[fareIndex]).toEqual({ reward: expectedReward, money: sim.progress.money });
      expect(saves).toHaveBeenCalledTimes(fareIndex);
      flush();
      const loaded = reloadProgress();
      expect(loaded.progress.stats.taxiFares).toBe(fareIndex + 1);
      expect(loaded.progress.money).toBe(before + expectedReward);
    }
  });

  it('persists a stopped vigilante suspect and the paid level, but not a cancelled job', () => {
    const sim = setup();
    const { flush, saves } = quitRig(sim);
    const road = roadPoint(sim);
    placeInCar(sim, sim.spawnVehicle('police', road.x, road.z, road.heading));
    sim.activities.toggleJob();
    const job = sim.activities.job;
    if (job?.kind !== 'vigilante' || !job.target?.driver) throw new Error('Missing vigilante target');
    const money = sim.progress.money;
    sim.combat.damageCharacter(job.target.driver, 1000, sim.player, 'bullet', 0, 0, 1);
    sim.activities.update(0.1);
    flush();
    const loaded = reloadProgress();
    expect(loaded.progress.stats.vigilanteLevel).toBe(1);
    expect(loaded.progress.money).toBe(money + 250);
    sim.activities.toggleJob();
    flush();
    expect(saves).toHaveBeenCalledOnce();
  });

  it('persists a completed rampage and its reward, but not the weapon loan on starting or a failure', () => {
    const sim = setup();
    const { flush, saves } = quitRig(sim);
    const money = sim.progress.money;
    expect(sim.activities.startRampage('rampage:0')).toBe(true);
    flush();
    expect(saves).not.toHaveBeenCalled();
    for (let count = 0; count < 12; count++) {
      sim.activities.update(1.3);
      const gang = sim.characters.find((c) => c.missionTag === 'rampage' && c.alive);
      expect(gang).toBeDefined();
      sim.combat.damageCharacter(gang!, 1000, sim.player, 'bullet', 0, 0, 1);
    }
    sim.activities.update(0.1);
    expect(sim.activities.job).toBeNull();
    flush();
    const loaded = reloadProgress();
    expect(loaded.progress.rampages).toEqual(['rampage:0']);
    expect(loaded.progress.money).toBe(money + 2000);
    expect(loaded.pickups.find((p) => p.tag === 'rampage:0')?.active).toBe(false);
    expect(sim.activities.startRampage('rampage:1')).toBe(true);
    sim.activities.cancelAll('wasted');
    flush();
    expect(saves).toHaveBeenCalledOnce();
  });

  it('keeps a paid stunt pending through a fatal landing and saves its actual hospital settlement on quit', () => {
    const sim = setup();
    const { flush, quit, saves } = quitRig(sim);
    const road = roadPoint(sim);
    const car = sim.spawnVehicle('sports', road.x, road.z, road.heading);
    placeInCar(sim, car);
    car.launchRamp = 0;
    car.airTime = 2;
    car.launchX = car.pos.x - 30;
    car.launchZ = car.pos.z;
    sim.player.armor = 80;
    const money = sim.progress.money;
    sim.activities.onVehicleLanded(car);
    expect(sim.progress.stats.stuntBonuses).toBe(1);
    const reward = sim.progress.money - money;
    sim.player.health = 0;
    sim.playerDied();
    flush();
    expect(saves).not.toHaveBeenCalled();
    quit();
    const loaded = reloadProgress();
    expect(loaded.progress.stunts).toEqual([0]);
    expect(loaded.progress.stats.stuntBonuses).toBe(1);
    expect(loaded.progress.money).toBe(money + reward - 100);
    expect(loadGame()?.armor).toBe(0);
    expect(saves).toHaveBeenCalledOnce();
  });

  it('reports an autosave failure without claiming an achievement was saved', () => {
    const sim = setup();
    const { flush, game } = quitRig(sim);
    const pickup = sim.pickups.find((p) => p.kind === 'package')!;
    teleport(sim, pickup.pos.x, pickup.pos.z);
    sim.player.pos.y = pickup.pos.y;
    sim.pickupSys.update(1 / 60);
    window.localStorage.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
    flush();
    expect(loadGame()).toBeNull();
    expect(game.hud.toast).toHaveBeenCalledOnce();
    expect(game.hud.toast.mock.calls[0]?.[0]).toMatch(/full|space/i);
    expect(game.hud.toast.mock.calls[0]?.[0]).not.toBe('Autosaved');
  });
});
