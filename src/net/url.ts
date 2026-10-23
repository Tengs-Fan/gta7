// Where a multiplayer game connects to: the page URL's ?mp=1&server=&room=&name= (and the testing link options
// ?lag=&jitter=&loss=), typed server addresses, player names. Small and pure: single player loads it without any of the
// client.

import type { LinkConditions } from './transport';

/** Raised synchronously for an address no connection can be opened to (not a ws:// or wss:// URL). */
export class BadAddressError extends Error {}

export const DEFAULT_PORT = 4210;
export const DEFAULT_ROOM = 'lobby';
export const MAX_NAME = 24;

export interface PageLocation {
  protocol: string;
  hostname: string;
  port: string;
}

export interface NetJoinOptions {
  /** As the player typed it: host:port, ws://…, wss://… or http(s)://…. */
  server: string;
  room: string;
  name: string;
  /** A simulated slow link in front of the socket (testing). */
  link?: LinkConditions;
  /** Predict the local player (default on). */
  predict?: boolean;
}

/** The game server this page most likely came from: its own host on port 4210 (localhost from an https page). */
export function defaultServerAddress(loc: PageLocation): string {
  if (loc.protocol === 'https:') return `ws://localhost:${DEFAULT_PORT}`;
  return `ws://${loc.hostname || 'localhost'}:${DEFAULT_PORT}`;
}

/**
 * The MULTIPLAYER screen's server address before the player types one: the page's own host and port when the game
 * server served the page (its pages say so), else ws://localhost:4210.
 */
export function menuServerAddress(loc: PageLocation, servedByGameServer: boolean): string {
  if (servedByGameServer && loc.hostname) {
    const port = loc.port || (loc.protocol === 'https:' ? '443' : '80');
    return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.hostname}:${port}`;
  }
  return `ws://localhost:${DEFAULT_PORT}`;
}

/** The WebSocket URL for a typed server address (path /ws unless one is given). Throws BadAddressError. */
export function socketUrl(address: string): string {
  let a = address.trim();
  if (!a || /\s/.test(a)) throw new BadAddressError(`"${address}" is not a server address`);
  if (/^https?:\/\//i.test(a)) a = a.replace(/^http/i, 'ws');
  else if (!/^wss?:\/\//i.test(a)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) throw new BadAddressError(`"${address}" is not a server address`);
    a = `ws://${a}`;
  }
  let u: URL;
  try {
    u = new URL(a);
  } catch {
    throw new BadAddressError(`"${address}" is not a server address`);
  }
  if (!u.hostname) throw new BadAddressError(`"${address}" is not a server address`);
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString();
}

/** Player names are trimmed to MAX_NAME characters; an empty one becomes "Player". */
export function cleanName(name: string): string {
  const s = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_NAME);
  return s || 'Player';
}

/** The multiplayer settings in a page URL, or null when it does not ask for multiplayer (?mp=1). `servedByGameServer`: the page says so (see menuServerAddress). */
export function netOptionsFromUrl(search: string, loc: PageLocation, servedByGameServer = false): NetJoinOptions | null {
  const q = new URLSearchParams(search);
  if (q.get('mp') !== '1') return null;
  const num = (k: string) => {
    const v = Number(q.get(k));
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const lag = num('lag');
  const jitter = num('jitter');
  const loss = Math.min(0.5, num('loss') > 1 ? num('loss') / 100 : num('loss'));
  return {
    // A page the game server served joins that server, whatever port it runs on.
    server: q.get('server') || (servedByGameServer ? menuServerAddress(loc, true) : defaultServerAddress(loc)),
    room: q.get('room') || DEFAULT_ROOM,
    name: cleanName(q.get('name') ?? ''),
    link: lag || jitter || loss ? { latencyMs: lag, jitterMs: jitter, loss } : undefined,
    predict: q.get('predict') !== '0',
  };
}

