// npm run server [-- --port 4210 --host 0.0.0.0 --dist dist --dev [--puppets] --status-every 10]
// Starts the multiplayer server: the built game at http://<host>:<port>/, the game socket at ws://<host>:<port>/ws,
// JSON status at /status. See docs/multiplayer.md.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, startServer, statusLine } from './server';

interface Args { port: number; host: string; socket: string | null; dist: string; dev: boolean; puppets: boolean; statusEvery: number }

function parseArgs(argv: string[]): Args {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args: Args = { port: DEFAULT_PORT, host: '0.0.0.0', socket: null, dist: join(root, 'dist'), dev: false, puppets: false, statusEvery: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--port') args.port = Number(next());
    else if (a === '--host') args.host = next();
    else if (a === '--socket') args.socket = resolve(next());
    else if (a === '--dist') args.dist = resolve(next());
    else if (a === '--dev') args.dev = true;
    else if (a === '--puppets') args.puppets = true;
    else if (a === '--status-every') args.statusEvery = Number(next());
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run server -- [--port 4210] [--host 0.0.0.0] [--dist dist] [--socket path] [--dev [--puppets]] [--status-every 10]');
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error(`bad port ${args.port}`);
  if (!(args.statusEvery >= 0)) throw new Error(`bad --status-every ${args.statusEvery}`);
  return args;
}

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (line: string) => console.log(`${stamp()} ${line}`);

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  if (!existsSync(join(args.dist, 'index.html'))) log(`[warn] ${args.dist}/index.html not found: run "npm run build" first (the WebSocket still works)`);
  process.on('uncaughtException', (err) => log(`[error] uncaught exception: ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (err) => log(`[error] unhandled rejection: ${err instanceof Error ? err.stack : String(err)}`));
  const server = await startServer({ port: args.port, host: args.host, socketPath: args.socket, distDir: args.dist, dev: args.dev, puppets: args.puppets, statusLogMs: args.statusEvery * 1000, log });
  log(`GTA7 multiplayer server listening on ${args.socket ? `unix:${args.socket}` : `${args.host}:${server.port}`}${args.dev ? ` (dev commands on${args.puppets ? ', puppet slots' : ''})` : ''}`);
  if (!args.socket) for (const url of server.urls()) log(`  open ${url}?mp=1&room=lobby   (WebSocket ${url.replace(/^http/, 'ws')}ws, status ${url}status)`);
  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: shutting down`);
    for (const r of server.manager.status()) log(statusLine(r));
    server.close().then(() => process.exit(0), () => process.exit(1));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(`server failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
