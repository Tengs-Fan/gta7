# Multiplayer server

GTA 7 runs single player in the browser with no server at all (that is what the GitHub Pages build does). The optional
multiplayer mode adds a small Node server that runs the real simulation for each room and streams it to the browsers
in the room. This page covers running that server, on your own machine, on your LAN, or in a container.

Every player who joins a room gets his own `PlayerSlot` in the room's Sim: his own character, weapons and ammo, money,
wanted level and police pursuit, side jobs, pickups and respawns, with PvP damage on. Traffic and pedestrians stream
round every group of players (players within 150 m of each other share one group). The browser joins with
`?mp=1` in the page address (see [Joining](#joining)).

From the title screen, MULTIPLAYER asks for a name (required, up to 24 characters), the server address (the page's
own host and port when this server served the page, else `ws://localhost:4210`) and a room (default `lobby`), and
remembers them in the browser. In the room, Tab (D-pad right) or pause > PLAYERS lists the players with their stars,
kills and deaths; other players have name tags (up to 150 m) and diamond blips on the radar and map in their own
colour; kills show in a kill feed and are credited to the attacker. Pause > STREET RUNS (or T at a course start) opens
a head-to-head Street Run for the room: others join within 20 s, everyone starts on one grid after one countdown, and
every screen shows the same results. No money is paid in races and nothing is saved in multiplayer. The server keeps
the room rules and races in `server/lobby.ts` and `src/sim/headToHead.ts`.

## Run it

```sh
npm ci
npm run build      # the server serves the built game from dist/
npm run server     # tsx server/main.ts --port 4210
```

The server listens on **port 4210 on all interfaces** and prints the addresses to open, for example:

```
GTA7 multiplayer server listening on 0.0.0.0:4210
  open http://127.0.0.1:4210/?mp=1&room=lobby   (WebSocket ws://127.0.0.1:4210/ws, status http://127.0.0.1:4210/status)
  open http://192.168.1.20:4210/?mp=1&room=lobby   (WebSocket ws://192.168.1.20:4210/ws, ...)
```

- **Same machine:** open `http://127.0.0.1:4210/?mp=1` (without `?mp=1` the page is the ordinary single-player game).
- **LAN:** other machines open `http://<this machine's LAN address>:4210/?mp=1` (one of the printed addresses). On
  macOS, allow incoming connections for `node` if the firewall asks.
- **Choosing a room:** add `?room=<id>` to the address (`http://127.0.0.1:4210/?mp=1&room=alpha&name=Ann`). Players
  with the same room id play together; rooms are separate worlds (their own city state, traffic, police, clock and
  seed). Without a room the game joins `lobby`. Room ids are 1-32 letters, digits, `.`, `_` or `-`. A room takes 8
  players; a 9th is told the room is full. An empty room is kept for 30 s, then closed.

Options (after `--`, e.g. `npm run server -- --port 4300`):

| Option | Default | Meaning |
|---|---|---|
| `--port N` | 4210 | TCP port for HTTP and WebSocket |
| `--host H` | 0.0.0.0 | Interface to listen on (`127.0.0.1`: this machine only) |
| `--dist DIR` | `dist` | Built client to serve |
| `--status-every S` | 10 | Seconds between status log lines (0: none) |
| `--socket PATH` | | Listen on a Unix socket instead of a port (used by the tests) |
| `--dev` | off | Allow the `debug` command (teleport, wanted level, weapons; tests and measurements) |
| `--puppets` | off | With `--dev`: players after the first are inert stand-in walkers instead of full players (tests and measurements) |

## Joining

- A page served by the game server joins that server, on whatever port it runs (the server marks the pages it
  serves with `<meta name="gta7-server">`). Any other page (`npm run dev`, `npm run preview`, GitHub Pages) looks on
  its own host at **port 4210** (from an `https://` page, at `ws://localhost:4210`). For another server add
  `&server=<host>:<port>` (or a full `ws://` or `wss://` address; the path defaults to `/ws`).
- The address form: `?mp=1&server=<host:port>&room=<id>&name=<name>`; everything except `mp=1` is optional (room
  `lobby`, name `Player`). Names are cut to 24 characters.
- Testing options: `&lag=<ms>&jitter=<ms>&loss=<fraction>` put a simulated slow link in front of the socket, and
  `&predict=0` turns off local prediction.
- If the connection drops, the game says so within 3 s and offers RECONNECT (which joins as a new player: nothing is
  kept) or RETURN TO TITLE. An address with nothing behind it gives COULD NOT JOIN with TRY AGAIN or BACK TO TITLE.

## Endpoints

- `GET /` and the files of `dist/`: the game. Paths outside `dist/` are never served; unknown paths are 404.
- `ws://<host>:4210/ws`: the game connection (binary WebSocket). The room may also be given here as `/ws?room=<id>`.
- `GET /status`: JSON with process memory and, per room, the player count, tick count, measured tick rate, tick
  time (sim update plus snapshot encoding: `tickMs.mean`, `tickMs.p95`, `tickMs.max` over the last 600 ticks),
  snapshot rate, snapshot sizes, bytes sent per second and entity counts.

Every 10 s the server also logs one line per room, for example:

```
[status] room=alpha players=2 spectators=0 tick=36012 rate=60.0Hz tick_ms_mean=0.521 tick_ms_p95=0.874 tick_ms_max=3.102 snapshots=25.0Hz snapshot_bytes_mean=2096 out=104.9KB/s vehicles=53 characters=82 helis=1 dropped_ticks=0 tick_errors=0
```

## How it works

- Each room owns a `StaticWorld` and a `Sim({ ambient: true, police: true, weather: 'dynamic', seed })`, stepped at a
  fixed 60 Hz with `dt = 1/60` exactly. A late wake is made up with extra fixed ticks (at most 5 per wake); a stall over
  250 ms is skipped rather than replayed.
- Inputs are latched per client: held buttons and axes follow the newest input; every single-frame press
  (fire, jump, enter/exit, interact, job, horn, reload, weapon next/previous/slot) reaches exactly one tick; inputs
  with an old sequence number are ignored, and each snapshot acknowledges the last applied one (`ackSeq`).
- Snapshots go out at 25 Hz. Each client gets the entities within about 250 m of its player (kept until 258 m), every
  player in the room at any distance, its own vehicle and the vehicles pursuing it, and police helicopters while it is
  wanted. Per entity, groups of fields (motion, engine, status, rare data such as model, colour, appearance and dents)
  are sent only when they changed since that client last got them; entities leaving the area are sent as removals and
  come back in full. Broken props, signal holds and weather go out when they change. Events (shots, impacts, damage,
  money, wanted level...) follow each snapshot as an `event` message, by distance or by the entities they involve;
  player-scoped events only go to their player.
- Measured in a busy scene (4 players downtown, a 3-star pursuit with a helicopter, gunfire, about 53 vehicles and 82
  characters): about 2.1-2.2 KB per snapshot (p95 about 2.5 KB), about 55 KB/s down and 2.4 KB/s up per client, tick
  time about 0.5 ms mean in process (1.3 ms with the machine under heavy load). That run used stand-in players; with
  four full players spread over four districts (about 180 vehicles, as each group streams its own ring of traffic and
  parked cars) the tick stayed at 2-3 ms mean on the real server.
- Story missions, cheats and saving stay single-player; the server has no commands for them.

### Protocol

`src/net/protocol.ts` (pure TypeScript, shared by server and browser). One binary frame per message:
`u8 0x47 ('G'), u8 version (3), u8 type`, then the body. Messages:

| Type | Direction | Body |
|---|---|---|
| `hello` | client | protocol version, name, room |
| `welcome` | server | playerId, slot (-1 while watching), room id, room seed, tick, tick and snapshot rates, broken props, signal holds, nearby pickups |
| `reject` | server | `full`, `version`, `badHello`, `shutdown` or `kicked`, with a message (the socket then closes) |
| `input` | client | seq, client tick, packed `PlayerInput` (41 bytes) |
| `snapshot` | server | tick, ackSeq, sim time, clock, HUD (wanted, searching, money, clip and ammo, and whether the server holds the player: wasted or busted, or controls locked), side job/roster/weather/holds when changed, new broken props, entity records, removals |
| `event` | server | tick and events (entity references as ids) |
| `cmd` | client | seq, command name, argument (`respawn`; `debug` with `--dev`) |
| `ping` / `pong` | both | client time, server time and tick (round-trip time) |
| `bye` | client | reason |

Quantization: positions 1 cm, angles 2π/65536, velocities 0.01 m/s, player input axes 1/32767, other vehicles'
controls 1/127, fractions 1/255, timers 1 ms. The client must predict with `quantizeInput(input)`, which is exactly what
the server sees. A message with another version, a truncated one, or one whose lengths point past its end is
rejected as a whole.

### Limits and robustness

WebSocket frames over 64 KB are refused from their header (the declared size is never allocated). Each connection
may send 240 messages a second on average (bursts of 480); more are dropped. Text frames close the connection; 32
malformed messages close it. A socket that stops answering pings is dropped within about 2 s; a closed socket's
player leaves the room at once. A client that falls 8 MB behind is disconnected.

## Docker

```sh
docker build -t gta7-server .
docker run --rm -p 4210:4210 gta7-server
# then open http://127.0.0.1:4210/?mp=1 (or http://<host>:4210/?mp=1&room=<id>)
```

The image installs the dependencies, builds the client and starts the same command as `npm run server` on port
4210. **Untested:** Docker is not installed on the machine this was written on, so the image has not been built here;
the Dockerfile was checked by reading it.

## Playing over the internet

- A page served over HTTPS (such as the GitHub Pages build) may only open `wss://` sockets (or `ws://localhost`).
  For internet play, put the server behind a TLS reverse proxy that terminates HTTPS and forwards both the page and
  the WebSocket path `/ws` (with the `Upgrade`/`Connection` headers) to port 4210, and open the game through the
  proxy's `https://` address. For example with Caddy: `reverse_proxy 127.0.0.1:4210` in your site block (Caddy
  forwards WebSockets on its own); with nginx, `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";` in the `location /` that proxies to `http://127.0.0.1:4210`.
- Cloud hosting needs your own account with a hosting provider; none is set up, and nothing in this repository
  deploys anywhere or contains credentials.

## Tools

- `server/tools/bot.ts`: a headless client (Node, `ws`) used by the tests.
- `server/tools/busyScene.ts`: the busy-scene measurement against a running `--dev` server:
  `npx tsx server/tools/busyScene.ts --url ws://127.0.0.1:4210/ws --seconds 60 [--spread]` prints the `/status` line
  every 10 s and each client's snapshot sizes and bandwidth (`--spread` puts the players in four districts).
- `tests/e2e/mp_client.spec.ts` (with `--dev --puppets`), `mp_cross.spec.ts`, `mp_lobby.spec.ts` and `mp_bystander.spec.ts` (all with `--dev`)
  start their own server on `GTA7_MP_PORT` (default 4210): one browser joining by URL, two to three clients through the cross-area flows, a
  head-to-head race between two clients, and a 60 s police chase of one player with a 0-star bystander beside it.
- Tests: `tests/unit/net_*.test.ts` and `tests/unit/server_*.test.ts`. The server tests listen on Unix sockets, not
  TCP ports; `GTA7_MP_TEST_PORT=<port>` adds a TCP and LAN check, `GTA7_MP_SOAK_SECONDS=60` lengthens the 60 Hz run.
