// The server survives garbage and abrupt disconnects: a real server process, two well-behaved clients, a third
// connection sending every kind of malformed and abusive traffic, and a client process killed mid-session.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Rng } from '../../src/core/rng';
import { encodeMessage, MESSAGE_TYPES, PROTOCOL_VERSION, tryDecode, Writer, MAGIC } from '../../src/net/protocol';
import { neutralInput } from '../../src/sim/input';
import { Bot } from '../../server/tools/bot';
import { maxGap, spawnServer, windowRates } from './net_helpers';

const ROOT = join(__dirname, '../..');

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function closed(ws: WebSocket): Promise<number> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(-1);
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('server robustness', () => {
  it('stays up and keeps ticking through garbage, floods and killed clients', async () => {
    const server = await spawnServer();
    const url = server.wsUrl('?room=r');
    const log: string[] = [];
    try {
      const good = [await Bot.connect({ url, name: 'good1' }), await Bot.connect({ url, name: 'good2' })];
      const inputs = setInterval(() => {
        good[0]!.input({ moveZ: 1, sprint: true });
        good[1]!.input({ moveX: 1 });
      }, 1000 / 60);
      await sleep(500);
      const from = good.map((g) => g.snapshots.length);
      const t0 = performance.now();

      // 1. 1,000 random binary messages (none of which happens to be a valid message).
      let bad = await open(url);
      const rng = new Rng(7);
      let sent = 0;
      for (let i = 0; i < 1000; i++) {
        const b = new Uint8Array(rng.int(0, 300));
        for (let k = 0; k < b.length; k++) b[k] = rng.int(0, 255);
        if (i % 3 === 0 && b.length > 3) {
          b[0] = MAGIC;
          b[1] = PROTOCOL_VERSION;
          b[2] = rng.int(0, MESSAGE_TYPES.length - 1);
        }
        if (tryDecode(b).ok) continue;
        if (bad.readyState !== WebSocket.OPEN) break;
        bad.send(b);
        sent++;
      }
      log.push(`random: ${sent} sent, connection closed with ${await Promise.race([closed(bad), sleep(2000).then(() => 'still open')])}`);

      // 2. A text frame.
      bad = await open(url);
      bad.send('hello server');
      log.push(`text frame: closed with ${await Promise.race([closed(bad), sleep(2000).then(() => 'still open')])}`);

      // 3-6. On one connection: a truncated message, a wrong version, an input before hello, a length past the end.
      bad = await open(url);
      const hello = new Uint8Array(encodeMessage({ type: 'hello', version: PROTOCOL_VERSION, name: 'bad', room: 'r' }));
      bad.send(hello.subarray(0, hello.length - 2));
      const wrong = new Uint8Array(encodeMessage({ type: 'ping', clientTime: 1 }));
      wrong[1] = 9;
      bad.send(wrong);
      bad.send(new Uint8Array(encodeMessage({ type: 'input', seq: 1, tick: 0, input: neutralInput() })));
      const w = new Writer();
      w.u8(MAGIC); w.u8(PROTOCOL_VERSION); w.u8(MESSAGE_TYPES.indexOf('cmd'));
      w.u32(1); w.varu(0x7ffffff0); w.raw(new Uint8Array(8));
      bad.send(w.finish());
      await sleep(200);
      log.push(`truncated/wrong version/input before hello/length past end: connection ${bad.readyState === WebSocket.OPEN ? 'open, messages ignored' : 'closed'}`);

      // 7. A 1 MB message.
      bad.send(new Uint8Array(1024 * 1024));
      log.push(`1 MB message: closed with ${await Promise.race([closed(bad), sleep(2000).then(() => 'still open')])}`);

      // 8-9. A joined connection floods 2,000 valid inputs in one second, then drops without a bye.
      const flood = await Bot.connect({ url, name: 'flood' });
      for (let batch = 0; batch < 20; batch++) {
        for (let k = 0; k < 100; k++) flood.input({ firePressed: true, jump: true, moveZ: 1 });
        await sleep(50);
      }
      log.push(`flood: ${flood.inputsSent} inputs, connection ${flood.closed ? `closed ${flood.closeCode}` : 'open'}`);
      flood.terminate();

      // 10. A client process killed mid-session.
      const child = spawn(process.execPath, ['-e', `
        const WebSocket = require('ws');
        const ws = new WebSocket(process.argv[1]);
        ws.binaryType = 'arraybuffer';
        ws.on('open', () => {
          ws.send(Buffer.from(process.argv[2], 'hex'));
          setInterval(() => ws.send(Buffer.from(process.argv[3], 'hex')), 16);
        });
        let n = 0;
        ws.on('message', () => { if (++n === 5) console.log('joined'); });
      `, url, Buffer.from(encodeMessage({ type: 'hello', version: PROTOCOL_VERSION, name: 'doomed', room: 'r' })).toString('hex'), Buffer.from(encodeMessage({ type: 'input', seq: 1, tick: 0, input: neutralInput() })).toString('hex')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((resolve) => child.stdout!.on('data', (d: Buffer) => d.toString().includes('joined') && resolve()));
      const before = (await server.status()).rooms.find((r) => r.id === 'r')!;
      expect(before.members.map((m) => m.name)).toContain('doomed');
      const killedAt = performance.now();
      child.kill('SIGKILL');
      let removedAfter = -1;
      while (performance.now() - killedAt < 3000) {
        const st = (await server.status()).rooms.find((r) => r.id === 'r')!;
        if (!st.members.some((m) => m.name === 'doomed')) {
          removedAfter = performance.now() - killedAt;
          break;
        }
        await sleep(25);
      }
      log.push(`killed client: slot removed after ${removedAfter.toFixed(0)} ms`);
      // Long enough after the abuse for whole-second rates to be measured.
      await sleep(Math.max(1500, 11_000 - (performance.now() - t0)));
      clearInterval(inputs);

      const status = await server.status();
      const room = status.rooms.find((r) => r.id === 'r')!;
      const elapsed = (performance.now() - t0) / 1000;
      const runs = good.map((g, i) => g.snapshots.slice(from[i]));
      const gaps = runs.map((s) => maxGap(s.map((x) => x.at)));
      const rates = runs.map((s) => (s.length / ((s[s.length - 1]!.at - s[0]!.at) / 1000)));
      const windows = runs.map((s) => windowRates(s.map((x) => x.at), 10));
      const tickRate = ((runs[0]![runs[0]!.length - 1]!.tick - runs[0]![0]!.tick) * 1000) / (runs[0]![runs[0]!.length - 1]!.at - runs[0]![0]!.at);
      const serverLog = server.output();
      console.log(`[robustness] ${log.join('; ')}`);
      console.log(`[robustness] ${elapsed.toFixed(1)} s: tick rate ${tickRate.toFixed(2)} Hz (status ${room.tickRate} Hz, dropped ${room.droppedTicks}), good clients' snapshot rates ${rates.map((r) => r.toFixed(1)).join('/')} Hz (10 s windows ${windows.map((w) => w.map((x) => x.toFixed(1)).join(' ')).join(' | ')}), longest gaps ${gaps.map((g) => g.toFixed(0)).join('/')} ms; members after: ${room.members.map((m) => m.name).join(',')}; server rss ${status.rssMB} MB`);
      console.log(`[robustness] server log:\n${serverLog.split('\n').filter((l) => /conn|error|uncaught|closing/i.test(l)).slice(0, 12).join('\n')}`);
      expect(server.proc.exitCode).toBeNull();
      expect(serverLog).not.toMatch(/uncaught|unhandled|\[error\]/i);
      expect(tickRate).toBeGreaterThanOrEqual(59.4);
      expect(tickRate).toBeLessThanOrEqual(60.6);
      for (const g of gaps) expect(g).toBeLessThanOrEqual(250);
      for (const r of [...rates, ...windows.flat()]) {
        expect(r).toBeGreaterThanOrEqual(20);
        expect(r).toBeLessThanOrEqual(30);
      }
      expect(removedAfter).toBeGreaterThanOrEqual(0);
      expect(removedAfter).toBeLessThan(2000);
      expect(room.members.map((m) => m.name).sort()).toEqual(['good1', 'good2']);
      expect(good.every((g) => !g.closed && g.decodeErrors === 0)).toBe(true);
      for (const g of good) await g.close();
    } finally {
      await server.stop();
    }
  }, 90_000);
});
