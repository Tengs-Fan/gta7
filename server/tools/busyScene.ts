// Busy-scene measurement against a running server started with --dev --puppets:
//   npm run server -- --port 4210 --dev --puppets
//   npx tsx server/tools/busyScene.ts --url ws://127.0.0.1:4210/ws --seconds 60
// Four players join one room downtown: the Sim's player at 3 stars (god mode, SMG gunfire in bursts) with the pursuit
// and helicopter that brings, three stand-in players walking a block away. Prints the server's /status line every
// 10 s and each client's snapshot sizes and bandwidth at the end.

import { StaticWorld } from '../../src/world/staticWorld';
import { statusLine, type ServerStatus } from '../server';
import { Bot } from './bot';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const url = arg('url', 'ws://127.0.0.1:4210/ws');
const seconds = Number(arg('seconds', '60'));
const room = arg('room', 'busy');
const statusUrl = url.replace(/^ws/, 'http').replace(/\/ws.*$/, '/status');

function stats(a: number[]): { mean: number; p95: number; max: number } {
  const s = [...a].sort((x, y) => x - y);
  return { mean: Math.round(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)), p95: s[Math.max(0, Math.ceil(s.length * 0.95) - 1)] ?? 0, max: s[s.length - 1] ?? 0 };
}

async function status(): Promise<ServerStatus> {
  return (await (await fetch(statusUrl)).json()) as ServerStatus;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const world = new StaticWorld();
  const nodes = [world.roads.node(4, 4), world.roads.node(5, 4), world.roads.node(4, 5), world.roads.node(5, 5)];
  const bots: Bot[] = [];
  for (let i = 0; i < 4; i++) bots.push(await Bot.connect({ url: `${url}?room=${room}`, name: `busy${i + 1}` }));
  const slots = bots.map((b) => b.welcome?.slot ?? -1);
  if (slots.some((s) => s < 0)) throw new Error(`every bot needs a slot (start the server with --dev --puppets); got ${slots.join(',')}`);
  bots.forEach((b, i) => b.cmd('debug', { teleport: [nodes[i]!.x + 12, nodes[i]!.z + 12] }));
  bots[0]!.cmd('debug', { godMode: true, give: ['smg', 9999] });
  let t = 0;
  const timer = setInterval(() => {
    t++;
    bots.forEach((b, i) => {
      if (i === 0) {
        const a = t / 40;
        b.input({ aim: true, fire: t % 120 < 80, firePressed: t % 120 === 0, moveZ: t % 600 < 300 ? 1 : 0, cameraYaw: a, aimDir: { x: Math.sin(a), y: -0.05, z: Math.cos(a) } });
      } else b.input({ moveZ: 1, sprint: true, cameraYaw: t / 120 + i });
    });
    if (t % 60 === 0) bots[0]!.cmd('debug', { wanted: 3 });
  }, 1000 / 60);
  bots[0]!.cmd('debug', { wanted: 3 });
  console.log(`settling 5 s, then measuring ${seconds} s in room "${room}"`);
  await sleep(5000);
  const from = bots.map((b) => ({ snaps: b.snapshots.length, bytesIn: b.bytesIn, bytesOut: b.bytesOut, events: b.eventBytes }));
  const t0 = performance.now();
  for (let s = 10; s <= seconds; s += 10) {
    await sleep(Math.max(0, t0 + s * 1000 - performance.now()));
    const st = await status();
    const r = st.rooms.find((x) => x.id === room);
    if (r) console.log(statusLine(r));
  }
  clearInterval(timer);
  const elapsed = (performance.now() - t0) / 1000;
  const st = await status();
  const r = st.rooms.find((x) => x.id === room)!;
  console.log(`scene: ${r.entities.vehicles} vehicles, ${r.entities.characters} characters, ${r.entities.helis} helicopters, ${r.players} players`);
  bots.forEach((b, i) => {
    const snaps = b.snapshots.slice(from[i]!.snaps);
    const sz = stats(snaps.map((x) => x.bytes));
    console.log(`client ${i + 1} (slot ${slots[i]}): first snapshot ${b.snapshots[0]?.bytes} B; ${snaps.length} snapshots (${(snaps.length / elapsed).toFixed(1)}/s) mean ${sz.mean} B p95 ${sz.p95} B max ${sz.max} B; down ${((b.bytesIn - from[i]!.bytesIn) / elapsed / 1024).toFixed(1)} KB/s (events ${((b.eventBytes - from[i]!.events) / elapsed / 1024).toFixed(1)} KB/s), up ${((b.bytesOut - from[i]!.bytesOut) / elapsed / 1024).toFixed(2)} KB/s`);
  });
  console.log(`status: ${JSON.stringify({ tickRate: r.tickRate, tickMs: r.tickMs, snapshotRate: r.snapshotRate, droppedTicks: r.droppedTicks })}`);
  for (const b of bots) await b.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
