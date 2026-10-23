// The server's fixed-rate loop: a real server process (as `npm run server` runs it) with two headless clients ticks at
// 60 Hz, every Sim update uses dt = 1/60 exactly, and each client gets 20-30 snapshots a second with strictly
// increasing ticks. GTA7_MP_SOAK_SECONDS sets the run length (20 s by default; the contract's run is 60).

import { describe, expect, it } from 'vitest';
import { FixedLoop } from '../../server/loop';
import { Room } from '../../server/room';
import { Bot } from '../../server/tools/bot';
import { spawnServer, windowRates } from './net_helpers';

const SECONDS = Number(process.env.GTA7_MP_SOAK_SECONDS ?? 20);

describe('fixed 60 Hz server loop', () => {
  it(`ticks 60 Hz for ${SECONDS} s with two clients; dt is always 1/60; 20-30 snapshots/s per client`, async () => {
    const server = await spawnServer();
    try {
      const url = server.wsUrl('?room=soak');
      const a = await Bot.connect({ url, name: 'A', keepAll: false });
      const b = await Bot.connect({ url, name: 'B' });
      // Snapshot ticks and sim times, to check the dt of every update in between.
      const timeErr: number[] = [];
      const ticksA: number[] = [];
      const ticksB: number[] = [];
      a.ws.on('message', () => {
        const s = a.latest;
        if (s && ticksA[ticksA.length - 1] !== s.tick) {
          ticksA.push(s.tick);
          timeErr.push(Math.abs(s.time - s.tick / 60));
        }
      });
      b.ws.on('message', () => {
        const s = b.latest;
        if (s && ticksB[ticksB.length - 1] !== s.tick) ticksB.push(s.tick);
      });
      const inputs = setInterval(() => {
        a.input({ moveZ: 1, cameraYaw: 0.3 });
        b.input({ moveX: 1 });
      }, 1000 / 60);
      const start = a.snapshots.length;
      const startB = b.snapshots.length;
      await new Promise((r) => setTimeout(r, SECONDS * 1000));
      clearInterval(inputs);
      const sa = a.snapshots.slice(start);
      const sb = b.snapshots.slice(startB);
      const first = sa[0]!;
      const last = sa[sa.length - 1]!;
      const rate = ((last.tick - first.tick) * 1000) / (last.at - first.at);
      const winA = windowRates(sa.map((s) => s.at), 10);
      const winB = windowRates(sb.map((s) => s.at), 10);
      const status = await server.status();
      const room = status.rooms.find((r) => r.id === 'soak')!;
      console.log(`[loop] ${SECONDS} s: ${last.tick - first.tick} ticks over ${((last.at - first.at) / 1000).toFixed(2)} s = ${rate.toFixed(2)} Hz (${((last.tick - first.tick) * 60 / ((last.at - first.at) / 1000)).toFixed(0)}/min); snapshot rates per 10 s window A ${winA.map((r) => r.toFixed(1)).join(' ')}, B ${winB.map((r) => r.toFixed(1)).join(' ')}; worst |time - tick/60| ${Math.max(...timeErr).toExponential(2)} s; status tick_ms mean ${room.tickMs.mean} p95 ${room.tickMs.p95}, rate ${room.tickRate} Hz, dropped ${room.droppedTicks}`);
      expect(rate).toBeGreaterThanOrEqual(59.4);
      expect(rate).toBeLessThanOrEqual(60.6);
      for (const r of [...winA, ...winB]) {
        expect(r).toBeGreaterThanOrEqual(20);
        expect(r).toBeLessThanOrEqual(30);
      }
      expect(winA.length).toBeGreaterThanOrEqual(Math.floor(SECONDS / 10) - 1);
      for (const ticks of [ticksA, ticksB]) for (let i = 1; i < ticks.length; i++) expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
      // sim.time is the tick count times 1/60: no update ever used another dt.
      expect(Math.max(...timeErr)).toBeLessThan(1e-6);
      expect(room.droppedTicks).toBe(0);
      await a.close();
      await b.close();
    } finally {
      expect(server.output()).not.toMatch(/uncaught|unhandled/i);
      await server.stop();
    }
  }, (SECONDS + 30) * 1000);

  it('every Sim.update gets dt = 1/60 exactly', async () => {
    const room = new Room('dt', 1, { log: () => {} });
    const dts: number[] = [];
    const update = room.sim.update.bind(room.sim);
    room.sim.update = (dt, inp) => {
      dts.push(dt);
      update(dt, inp);
    };
    await new Promise((r) => setTimeout(r, 1000));
    room.close();
    expect(dts.length).toBeGreaterThan(50);
    expect(new Set(dts)).toEqual(new Set([1 / 60]));
    expect(Math.abs(room.sim.time - room.tick / 60)).toBeLessThan(1e-9);
  });

  it('a stalled loop catches up with extra fixed ticks, a bounded number per wake', async () => {
    let offset = 0;
    let ticks = 0;
    const loop = new FixedLoop(() => {
      ticks++;
    }, { hz: 60, maxCatchUp: 5, maxLagMs: 250, now: () => performance.now() + offset });
    const t0 = performance.now();
    loop.start();
    await new Promise((r) => setTimeout(r, 300));
    offset += 150; // a 150 ms stall: 9 ticks due at once
    await new Promise((r) => setTimeout(r, 300));
    offset += 1000; // a 1 s stall: beyond maxLagMs, the backlog is dropped
    await new Promise((r) => setTimeout(r, 200));
    loop.stop();
    const elapsed = (performance.now() - t0 + 150) / 1000;
    console.log(`[loop] ${ticks} ticks in ${elapsed.toFixed(2)} s of loop time (+1 s dropped: ${loop.dropped} ticks), at most ${loop.maxBurst} per wake`);
    expect(loop.maxBurst).toBeLessThanOrEqual(5);
    expect(loop.maxBurst).toBeGreaterThanOrEqual(2);
    expect(Math.abs(ticks - elapsed * 60)).toBeLessThan(8);
    expect(loop.dropped).toBeGreaterThan(40);
  });
});
