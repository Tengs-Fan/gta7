// The multiplayer client with real player slots: prediction for a player in any slot, smooth reconciliation of a
// knockdown the server causes, and each player's own HUD fields (VAL-MPCL-001, 004, 005, 008).

import { describe, expect, it } from 'vitest';
import { MAX_CORRECTION_STEP } from '../../src/net/predictor';
import { neutralInput } from '../../src/sim/input';
import type { Character } from '../../src/sim/entities';
import { makeClient, run, testManager, VirtualClock } from './net_client_helpers';

const LINK = { latencyMs: 100, jitterMs: 15, loss: 0.02 };

function pct(a: readonly number[], p: number): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] ?? 0;
}

/** Walks forward in a slowly turning arc, sprinting and jumping now and then. */
function walkInput(t0: number) {
  return (t: number) => {
    const inp = neutralInput();
    const s = (t - t0) / 1000;
    inp.moveZ = 1;
    inp.cameraYaw = Math.sin(s * 0.4) * 1.5;
    inp.sprint = Math.floor(s / 4) % 2 === 1;
    inp.jump = Math.floor(s * 60) % 120 === 0;
    return inp;
  };
}

describe('a player in any slot is predicted as well as the first one (VAL-MPCL-004/005)', () => {
  it('slot 1 walks and jumps over a lossy 100 ms link next to slot 0 without visible snapping', () => {
    const clock = new VirtualClock();
    const mgr = testManager({ dev: true });
    const first = makeClient(mgr, clock, { link: LINK, seed: 3 });
    const second = makeClient(mgr, clock, { link: LINK, seed: 4 });
    run(mgr, clock, [first, second], 1.5);
    const [a, b] = first.mirror.slot === 0 ? [first, second] : [second, first];
    const bChar: Character = mgr.room('r')!.sim.players[b.mirror.slot]!.character;
    expect([a.mirror.slot, b.mirror.slot].sort()).toEqual([0, 1]);
    const room = mgr.room('r')!;
    const sim = room.sim;
    expect(sim.players.length).toBe(2);
    expect(b.predictor.active).toBe(true);
    expect(a.mirror.ownCharacterId).not.toBe(b.mirror.ownCharacterId);

    for (const c of [a, b]) c.command('debug', JSON.stringify({ godMode: true, neverWanted: true }));
    run(mgr, clock, [a, b], 0.5);

    const server = new Map<number, { x: number; y: number; z: number }>();
    const predicted = new Map<number, { x: number; y: number; z: number }>();
    let rec = b.predictor.tick;
    b.predictor.stats.maxCorrectionStep = 0;
    const snapsBefore = b.predictor.stats.hardSnaps;
    const walkB = walkInput(clock.t);
    run(mgr, clock, [a, b], 25, {
      input: (c, _i, t) => (c === b ? walkB(t) : neutralInput()),
      afterTick: () => server.set(room.tick, { ...bChar.pos }),
      afterFrame: (c) => {
        if (c !== b) return;
        const p = b.predictor;
        for (let t = Math.max(rec, p.tick - 30); t < p.tick; t++) {
          const q = p.positionAt(t);
          if (q && !predicted.has(t)) predicted.set(t, q);
        }
        rec = p.tick;
      },
    });
    const errs: number[] = [];
    for (const [t, q] of predicted) {
      const s = server.get(t);
      if (s) errs.push(Math.hypot(s.x - q.x, s.y - q.y, s.z - q.z));
    }
    const st = b.debug().prediction;
    console.log(`[slot 1 walk] ${errs.length} ticks: p50 ${pct(errs, 50).toFixed(3)} m, p95 ${pct(errs, 95).toFixed(3)} m, max ${pct(errs, 100).toFixed(3)} m; largest correction ${st.maxCorrectionStep.toFixed(3)} m; hard snaps ${st.hardSnaps - snapsBefore}; soft ${st.softCorrections}`);
    expect(errs.length).toBeGreaterThan(1000);
    expect(pct(errs, 95)).toBeLessThanOrEqual(0.5);
    expect(st.maxCorrectionStep).toBeLessThanOrEqual(0.3);
    expect(st.hardSnaps - snapsBefore).toBeLessThanOrEqual(1);
  });
});

describe('a knockdown the server causes reconciles smoothly (mp-core regression)', () => {
  for (const slot of [0, 1]) {
    it(`slot ${slot}: knocked down while walking, no run of hard snaps and no visible jump`, () => {
      const clock = new VirtualClock();
      const mgr = testManager({ dev: true });
      const clients = [makeClient(mgr, clock, { link: LINK, seed: 7 }), makeClient(mgr, clock, { link: LINK, seed: 8 })];
      run(mgr, clock, clients, 1.5);
      const c = clients.find((k) => k.mirror.slot === slot)!;
      expect(c).toBeDefined();
      const sim = mgr.room('r')!.sim;
      const victim = sim.players[slot]!.character;
      for (const k of clients) k.command('debug', JSON.stringify({ godMode: true, neverWanted: true }));
      run(mgr, clock, clients, 0.5);
      const p = c.predictor;
      p.stats.maxCorrectionStep = 0;
      const snapsBefore = p.stats.hardSnaps;
      const t0 = clock.t;
      const walk = walkInput(t0);
      let knocks = 0;
      let knockedTicks = 0;
      // A car or an angry pedestrian throws him back a few metres and he lies there for 1.6 s, as combat.ts does.
      const knockAt = [3000, 9000, 15000].map((ms) => t0 + ms);
      run(mgr, clock, clients, 20, {
        input: (k, _i, t) => (k === c ? walk(t) : neutralInput()),
        afterTick: () => {
          if (knocks < knockAt.length && clock.t >= knockAt[knocks]! && victim.state === 'normal') {
            victim.state = 'knocked';
            victim.knockTimer = 1.6;
            victim.vel.x -= 4 * Math.sin(victim.heading);
            victim.vel.z -= 4 * Math.cos(victim.heading);
            victim.vel.y = 3;
            victim.onGround = false;
            knocks++;
          }
          if (victim.state === 'knocked') knockedTicks++;
        },
      });
      const st = c.debug().prediction;
      console.log(`[knock slot ${slot}] ${knocks} knocks, ${knockedTicks} knocked ticks; hard snaps ${st.hardSnaps - snapsBefore} (largest jump ${st.maxSnapJump.toFixed(3)} m); largest correction ${st.maxCorrectionStep.toFixed(3)} m; soft ${st.softCorrections}; replays ${st.replays}`);
      expect(knocks).toBe(3);
      expect(knockedTicks).toBeGreaterThan(200);
      expect(st.hardSnaps - snapsBefore).toBeLessThanOrEqual(1);
      expect(st.maxSnapJump).toBeLessThanOrEqual(0.3);
      expect(st.maxCorrectionStep).toBeLessThanOrEqual(MAX_CORRECTION_STEP + 0.05);
      expect(victim.state).toBe('normal');
      expect(p.char.state).toBe('normal');
    });
  }
});

describe('the local player\'s own shots show at once (flash and bang) and only once', () => {
  it('a pistol fired over a 100 ms link flashes within two frames; the server\'s events add no second flash', () => {
    const clock = new VirtualClock();
    const mgr = testManager({ dev: true });
    const c = makeClient(mgr, clock, { link: { latencyMs: 100, jitterMs: 0, loss: 0 }, seed: 11 });
    run(mgr, clock, [c], 1.5);
    c.command('debug', JSON.stringify({ godMode: true, neverWanted: true, give: ['pistol', 200] }));
    run(mgr, clock, [c], 1);
    const sim = mgr.room('r')!.sim;
    expect(c.mirror.hud.clip).toBeGreaterThan(0);
    const serverFired: number[] = [];
    sim.events.on('weaponFired', (e) => {
      if (e.shooter === sim.player) serverFired.push(clock.t);
    });
    const shown: number[] = [];
    c.mirror.events.on('weaponFired', (e) => {
      if (e.shooter === c.mirror.localCharacter) shown.push(clock.t);
    });
    const presses: number[] = [];
    run(mgr, clock, [c], 6, {
      input: (_k, _i, t) => {
        const inp = neutralInput();
        inp.aim = true;
        inp.aimOrigin = { x: sim.player.pos.x, y: sim.player.pos.y + 1.4, z: sim.player.pos.z };
        inp.aimDir = { x: Math.sin(sim.player.heading), y: 0, z: Math.cos(sim.player.heading) };
        // One pull every half second, held for a frame.
        const phase = (t - 500) % 500;
        if (t > 500 && phase < 17) {
          inp.fire = true;
          inp.firePressed = phase < 17 && (presses.length === 0 || t - presses[presses.length - 1]! > 400);
          if (inp.firePressed) presses.push(t);
        }
        return inp;
      },
    });
    console.log(`[own shots] ${presses.length} pulls, ${serverFired.length} fired on the server, ${shown.length} flashes on the client; first pull ${presses[0]!.toFixed(0)} ms: shown +${(shown[0]! - presses[0]!).toFixed(0)} ms, server +${(serverFired[0]! - presses[0]!).toFixed(0)} ms`);
    expect(serverFired.length).toBeGreaterThanOrEqual(6);
    expect(shown.length).toBe(serverFired.length);
    const lags = shown.map((t, i) => t - presses[i]!);
    expect(Math.max(...lags)).toBeLessThan(60);
    expect(serverFired[0]! - presses[0]!).toBeGreaterThan(40);
    expect(c.mirror.predictedShotsPending).toBe(0);
  });
});

describe('each player\'s own HUD data (VAL-MPCL-001, VAL-MPCL-008)', () => {
  it('wanted level, money, weapon and ammo on each client are that client\'s player\'s', () => {
    const clock = new VirtualClock();
    const mgr = testManager({ dev: true });
    const first = makeClient(mgr, clock, { link: { latencyMs: 40, jitterMs: 5, loss: 0 }, seed: 21 });
    const second = makeClient(mgr, clock, { link: { latencyMs: 40, jitterMs: 5, loss: 0 }, seed: 22 });
    run(mgr, clock, [first, second], 1.5);
    const [a, b] = first.mirror.slot === 0 ? [first, second] : [second, first];
    const sim = mgr.room('r')!.sim;
    const slotA = sim.players[a.mirror.slot]!;
    const slotB = sim.players[b.mirror.slot]!;
    expect(slotA).not.toBe(slotB);
    a.command('debug', JSON.stringify({ wanted: 3, neverWanted: false, godMode: true, give: ['pistol', 60] }));
    b.command('debug', JSON.stringify({ godMode: true, neverWanted: true, give: ['shotgun', 24] }));
    slotA.progress.money = 777;
    slotB.progress.money = 4321;
    run(mgr, clock, [a, b], 1);
    expect(a.mirror.me.wanted.level).toBe(3);
    expect(b.mirror.me.wanted.level).toBe(0);
    expect(a.mirror.me.progress.money).toBe(777);
    expect(b.mirror.me.progress.money).toBe(4321);
    expect(a.mirror.localCharacter?.inventory.current).toBe('pistol');
    expect(b.mirror.localCharacter?.inventory.current).toBe('shotgun');
    const wa = a.mirror.localCharacter!.inventory.slot();
    const wb = b.mirror.localCharacter!.inventory.slot();
    expect(wa.clip + wa.ammo).toBe(slotA.character.inventory.slot().clip + slotA.character.inventory.slot().ammo);
    expect(wb.clip + wb.ammo).toBe(slotB.character.inventory.slot().clip + slotB.character.inventory.slot().ammo);
    expect(wa.clip + wa.ammo).toBe(60);
    expect(wb.clip + wb.ammo).toBe(24);
    // The other player's record in the list is not this player's HUD.
    const aInB = b.mirror.players.find((p) => p.id === a.mirror.playerId)!;
    expect(aInB).toBeDefined();
    expect(aInB.wanted.level).toBe(0);
    expect(b.mirror.me.id).toBe(b.mirror.playerId);
    expect(b.mirror.players.filter((p) => p.character === b.mirror.localCharacter).map((p) => p.id)).toEqual([b.mirror.playerId]);
    const wantedA = sim.players[a.mirror.slot]!.wanted.level;
    expect(wantedA).toBe(3);
  });

  it('no flash for a gun with an empty magazine', () => {
    const clock = new VirtualClock();
    const mgr = testManager({ dev: true });
    const c = makeClient(mgr, clock, { link: { latencyMs: 100, jitterMs: 0, loss: 0 }, seed: 12 });
    run(mgr, clock, [c], 1.5);
    c.command('debug', JSON.stringify({ godMode: true, neverWanted: true, give: ['pistol', 0] }));
    run(mgr, clock, [c], 1);
    const sim = mgr.room('r')!.sim;
    sim.player.inventory.slot().clip = 0;
    sim.player.inventory.slot().ammo = 0;
    run(mgr, clock, [c], 0.5);
    let shown = 0;
    c.mirror.events.on('weaponFired', () => shown++);
    run(mgr, clock, [c], 2, {
      input: (_k, _i, t) => {
        const inp = neutralInput();
        inp.aim = true;
        inp.fire = true;
        inp.firePressed = Math.floor(t / 100) % 2 === 0;
        return inp;
      },
    });
    expect(c.mirror.hud.clip).toBe(0);
    expect(shown).toBe(0);
  });
});
