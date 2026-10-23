// A multiplayer session as the game runs it: where to connect (the URL's ?mp=1&server=&room=&name= or, later, the
// MULTIPLAYER menu), the WebSocket (optionally behind a simulated slow link, ?lag=&jitter=&loss=), the NetClient, and
// reconnecting with the same settings. Loaded on demand: single player never imports it. No DOM (the page's location is
// passed in).

import type { SimEvents } from '../sim/events';
import type { CombatView } from '../sim/viewState';
import type { StaticWorld } from '../world/staticWorld';
import { NetClient, type NetDebug } from './client';
import { simulatedLink, webSocketTransport, type LinkConditions, type TransportFactory } from './transport';
import { cleanName, DEFAULT_ROOM, socketUrl, type NetJoinOptions } from './url';

export { cleanName, defaultServerAddress, netOptionsFromUrl, socketUrl, type NetJoinOptions } from './url';

/** World and sea events the debug log keeps (what a player sees or hears of the others). */
const LOGGED: ReadonlyArray<keyof SimEvents> = [
  'shot', 'weaponFired', 'impact', 'horn', 'explosion', 'damage', 'vehicleEnter', 'vehicleExit', 'vehicleDestroyed', 'characterKilled',
  'scrape', 'propBroken', 'splash', 'melee', 'reload', 'wanted', 'money', 'wasted', 'busted', 'respawn',
];

export interface LoggedEvent {
  /** performance.now() when re-emitted. */
  at: number;
  type: string;
  /** Entity fields as ids. */
  refs: Record<string, number>;
  playerId?: number;
}

export class NetSession {
  client: NetClient;
  readonly opts: NetJoinOptions;
  /** Every client of this session: a reconnect starts a new one. */
  connects = 0;
  readonly log: LoggedEvent[] = [];
  onClient: ((c: NetClient) => void) | null = null;
  private unlog: Array<() => void> = [];

  constructor(opts: NetJoinOptions, private readonly env: { world: StaticWorld; combat?: CombatView; now?: () => number; transport?: TransportFactory }) {
    this.opts = { ...opts, name: cleanName(opts.name), room: opts.room.trim() || DEFAULT_ROOM };
    this.client = this.open();
  }

  /** The address as a WebSocket URL, or the address itself when it is not one (the client then fails with a clear message). */
  get url(): string {
    try {
      return socketUrl(this.opts.server);
    } catch {
      return this.opts.server;
    }
  }

  private open(): NetClient {
    this.connects++;
    const base = this.env.transport ?? webSocketTransport;
    const link = this.opts.link;
    const factory: TransportFactory = (url) => {
      const u = socketUrl(url);
      return link ? simulatedLink(base(u), link) : base(u);
    };
    const c = new NetClient({
      url: this.url,
      name: this.opts.name,
      room: this.opts.room,
      world: this.env.world,
      combat: this.env.combat,
      transport: factory,
      now: this.env.now ?? (() => performance.now()),
      predict: this.opts.predict !== false,
    });
    for (const u of this.unlog) u();
    this.unlog = LOGGED.map((type) => c.mirror.events.on(type, (e) => this.note(type, e as unknown as Record<string, unknown>)));
    this.onClient?.(c);
    return c;
  }

  private note(type: string, e: Record<string, unknown>): void {
    const refs: Record<string, number> = {};
    for (const [k, v] of Object.entries(e)) if (v && typeof v === 'object' && 'id' in v && typeof (v as { id: unknown }).id === 'number') refs[k] = (v as { id: number }).id;
    this.log.push({ at: performance.now(), type, refs, playerId: typeof e.playerId === 'number' ? e.playerId : undefined });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
  }

  /** Joins again with the same settings, as a new player. */
  reconnect(): NetClient {
    this.client.close();
    this.client = this.open();
    return this.client;
  }

  close(): void {
    for (const u of this.unlog) u();
    this.unlog = [];
    this.client.close();
  }

  debug(): NetDebug & { connects: number; link: LinkConditions | null; server: string } {
    return { ...this.client.debug(), connects: this.connects, link: this.opts.link ?? null, server: this.opts.server };
  }
}
