// Multiplayer layers over the game view (DOM, pointer-events off, so menus keep their input): name tags over the
// other players, the kill feed, the head-to-head race panel (entrants, countdown, standings) and its results. It reads
// the room state and the feed the server sends as events, and locks the local player's input through a race countdown.

import * as THREE from 'three';
import { FEED_EVENT, ROOM_EVENT, cssColor, type FeedEntry, type RaceView, type RoomState } from '../../net/lobby';
import { playerColor } from '../../sim/appearance';
import { formatRunTime } from '../../sim/streetRuns';
import type { PlayerView, ViewState } from '../../sim/viewState';
import { escapeHtml } from '../hud';
import './mpOverlay.css';

export { RACE_COMMAND } from '../../net/lobby';

/** Name tags show up to this far (m) from the camera, fading out over the last NAME_TAG_FADE metres. */
export const NAME_TAG_RANGE = 150;
const NAME_TAG_FADE = 30;
/** Seconds a kill feed line stays up, and how many are shown at once. */
const FEED_TIME = 8;
const FEED_LINES = 5;

interface TagEl {
  el: HTMLDivElement;
  name: string;
}

export interface NameTagInfo {
  playerId: number;
  name: string;
  x: number;
  y: number;
  distance: number;
  opacity: number;
  occluded: boolean;
}

export class MpOverlay {
  readonly root: HTMLDivElement;
  private readonly tagLayer: HTMLDivElement;
  private readonly feedEl: HTMLDivElement;
  private readonly raceEl: HTMLDivElement;
  private readonly resultsEl: HTMLDivElement;
  private readonly tags = new Map<number, TagEl>();
  private readonly v = new THREE.Vector3();
  private readonly camSpace = new THREE.Vector3();
  private unsub: Array<() => void> = [];
  private feed: Array<{ entry: FeedEntry; age: number; el: HTMLDivElement }> = [];
  /** The room's latest state (players' kills and deaths, the race), and when it came (performance.now()). */
  state: RoomState | null = null;
  private stateAt = 0;
  private localPlayerId = 0;
  /** The race countdown holds the local player's controls until GO. */
  private countdown = false;
  private countdownAt = 0;
  /** Wall-clock time (Date.now()) of the last GO, for comparing two clients. */
  goAt: number | null = null;
  private raceKey = '';
  private resultsKey = '';
  /** Name tags drawn the last frame (tests, __gta7.net). */
  lastTags: NameTagInfo[] = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'mp-overlay hidden';
    this.tagLayer = document.createElement('div');
    this.tagLayer.className = 'mp-tags';
    this.feedEl = document.createElement('div');
    this.feedEl.className = 'mp-feed';
    this.raceEl = document.createElement('div');
    this.raceEl.className = 'mp-race hidden';
    this.resultsEl = document.createElement('div');
    this.resultsEl.className = 'mp-results hidden';
    this.root.append(this.tagLayer, this.feedEl, this.raceEl, this.resultsEl);
    parent.appendChild(this.root);
  }

  bind(view: ViewState, localPlayerId: number): void {
    this.unbind();
    this.localPlayerId = localPlayerId;
    const on = view.events.on as unknown as (type: string, fn: (e: Record<string, unknown>) => void) => () => void;
    const ev = view.events;
    this.unsub.push(
      on.call(ev, ROOM_EVENT, (e) => {
        this.state = e.state as RoomState;
        this.stateAt = performance.now();
      }),
      on.call(ev, FEED_EVENT, (e) => this.addFeed(e as unknown as FeedEntry)),
      on.call(ev, 'streetRunCountdown', (e) => {
        if ((e.playerId ?? 0) !== this.localPlayerId) return;
        const count = e.count as number;
        this.countdown = count > 0;
        this.countdownAt = performance.now();
        if (count === 0) this.goAt = Date.now();
      }),
    );
    this.root.classList.remove('hidden');
  }

  unbind(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.state = null;
    this.countdown = false;
    this.goAt = null;
    for (const f of this.feed) f.el.remove();
    this.feed = [];
    for (const t of this.tags.values()) t.el.remove();
    this.tags.clear();
    this.lastTags = [];
    this.raceKey = '';
    this.resultsKey = '';
    this.raceEl.classList.add('hidden');
    this.resultsEl.classList.add('hidden');
    this.root.classList.add('hidden');
  }

  /** The race countdown is on for the local player: his input waits for GO. */
  get locked(): boolean {
    if (!this.countdown) return false;
    // A lost GO (or a race called off) cannot hold the controls past the countdown and a margin.
    if (performance.now() - this.countdownAt > 4000) this.countdown = false;
    return this.countdown;
  }

  /** The race as last reported, null when none is on. */
  get race(): RaceView | null {
    return this.state?.race ?? null;
  }

  /** The local player is lined up or racing (not out of it, not in an open lobby). */
  get inRace(): boolean {
    const r = this.race;
    if (!r || r.stage === 'lobby' || r.stage === 'results') return false;
    return r.entrants.some((e) => e.playerId === this.localPlayerId && e.status === 'racing');
  }

  /** Seconds left to join the open race, as of now. */
  joinLeft(serverTick: number): number {
    const r = this.race;
    const s = this.state;
    if (!r || !s || r.stage !== 'lobby' || r.closeTick < 0) return 0;
    return Math.max(0, (r.closeTick - serverTick) / s.tickRate);
  }

  private addFeed(entry: FeedEntry): void {
    const el = document.createElement('div');
    el.className = `mp-feed-line ${entry.kind}`;
    const name = (n: string | undefined, id: number | undefined) => {
      const slot = this.state?.players.find((p) => p.playerId === id)?.slot ?? -1;
      const color = slot >= 0 ? cssColor(playerColor(slot)) : '#fff';
      return `<b style="color:${color}">${escapeHtml(n ?? '')}</b>`;
    };
    if (entry.kind === 'kill' || entry.kind === 'wreck') {
      el.innerHTML = `${name(entry.killer, entry.killerId)} <span class="mp-feed-verb">${entry.kind === 'kill' ? 'killed' : 'wrecked'}</span> ${name(entry.victim, entry.victimId)}${entry.kind === 'wreck' ? "<span class=\"mp-feed-verb\">'s car</span>" : ''}`;
    } else el.textContent = entry.text;
    el.dataset.text = entry.text;
    this.feedEl.appendChild(el);
    this.feed.push({ entry, age: 0, el });
    while (this.feed.length > FEED_LINES) this.feed.shift()!.el.remove();
  }

  /** The kill feed's lines now on screen, oldest first. */
  feedLines(): string[] {
    return this.feed.map((f) => f.entry.text);
  }

  /** One frame, after the world was drawn with `camera` (so the tags sit on this frame's positions). */
  update(dt: number, view: ViewState, camera: THREE.PerspectiveCamera, serverTick: number, menuOpen = false): void {
    for (const f of [...this.feed]) {
      f.age += dt;
      f.el.style.opacity = String(Math.max(0, Math.min(1, (FEED_TIME - f.age) / 0.6)));
      if (f.age >= FEED_TIME) {
        f.el.remove();
        this.feed.splice(this.feed.indexOf(f), 1);
      }
    }
    // Under a menu screen the tags would float over its panel.
    this.tagLayer.classList.toggle('hidden', menuOpen);
    this.updateTags(view, camera);
    this.updateRace(serverTick);
  }

  private updateTags(view: ViewState, camera: THREE.PerspectiveCamera): void {
    const w = this.root.clientWidth || window.innerWidth;
    const hgt = this.root.clientHeight || window.innerHeight;
    const shown = new Set<number>();
    const drawn: NameTagInfo[] = [];
    camera.updateMatrixWorld();
    for (const p of view.players) {
      if (p.id === this.localPlayerId || p.slot === undefined || p.slot < 0) continue;
      const c = p.character;
      if (c.id === 0 || c.removed) continue;
      const head = headOf(p);
      this.v.set(head.x, head.y, head.z);
      this.camSpace.copy(this.v).applyMatrix4(camera.matrixWorldInverse);
      const distance = this.v.distanceTo(camera.position);
      // Behind the camera, or past the range: no tag.
      if (this.camSpace.z > -0.5 || distance > NAME_TAG_RANGE) continue;
      this.v.project(camera);
      if (Math.abs(this.v.x) > 1.15 || Math.abs(this.v.y) > 1.15) continue;
      const x = (this.v.x + 1) * 0.5 * w;
      const y = (1 - this.v.y) * 0.5 * hgt;
      // A tag over someone behind a building stays, faint: it still says where he is.
      const seen = view.world.lineOfSight(camera.position.x, camera.position.y, camera.position.z, head.x, head.y, head.z);
      const opacity = Math.min(1, (NAME_TAG_RANGE - distance) / NAME_TAG_FADE) * (p.down ? 0.55 : 1) * (seen ? 1 : 0.45);
      shown.add(p.id);
      let t = this.tags.get(p.id);
      const name = p.name ?? '';
      if (!t) {
        const el = document.createElement('div');
        el.className = 'mp-tag';
        this.tagLayer.appendChild(el);
        t = { el, name: '' };
        this.tags.set(p.id, t);
      }
      if (t.name !== name || t.el.dataset.slot !== String(p.slot)) {
        t.name = name;
        t.el.dataset.slot = String(p.slot);
        t.el.dataset.playerId = String(p.id);
        t.el.innerHTML = `<span class="mp-tag-dot" style="background:${cssColor(playerColor(p.slot))}"></span>${escapeHtml(name)}`;
      }
      const scale = Math.max(0.8, Math.min(1.1, 1.15 - distance / 200));
      t.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
      t.el.style.opacity = opacity.toFixed(3);
      drawn.push({ playerId: p.id, name, x, y, distance, opacity, occluded: !seen });
    }
    for (const [id, t] of this.tags) {
      if (shown.has(id)) continue;
      t.el.remove();
      this.tags.delete(id);
    }
    this.lastTags = drawn;
  }

  private updateRace(serverTick: number): void {
    const race = this.race;
    const me = this.localPlayerId;
    const mine = race?.entrants.find((e) => e.playerId === me);
    // The panel: an open race for everyone (an invitation), a race under way for its racers.
    const panel = race && (race.stage === 'lobby' || (mine && race.stage !== 'results')) ? race : null;
    if (!panel) {
      if (this.raceKey) this.raceEl.classList.add('hidden');
      this.raceKey = '';
    } else {
      const left = Math.ceil(this.joinLeft(serverTick));
      const key = JSON.stringify([panel.stage, panel.entrants.map((e) => [e.name, e.status, e.gate, e.position]), left, !!mine]);
      if (key !== this.raceKey) {
        this.raceKey = key;
        this.raceEl.classList.remove('hidden');
        const head = panel.stage === 'lobby' ? `HEAD-TO-HEAD · JOIN IN ${left} S` : panel.stage === 'countdown' ? 'HEAD-TO-HEAD · GET READY' : 'HEAD-TO-HEAD';
        const rows = panel.entrants.map((e) => {
          const what = panel.stage === 'lobby' ? '' : e.status === 'finished' ? `P${e.position} ${formatRunTime(e.time ?? 0)}` : e.status === 'dnf' ? 'DNF' : e.status === 'timeout' ? 'OUT OF TIME' : `${e.gate}/${panel.gates}`;
          return `<li class="${e.playerId === me ? 'you' : ''}" data-player-id="${e.playerId}"><span class="mp-race-name">${escapeHtml(e.name)}</span><span class="mp-race-what">${what}</span></li>`;
        }).join('');
        const hint = panel.stage === 'lobby' ? (mine ? (panel.hostId === me ? 'Pause › STREET RUNS › START NOW to go now' : 'Waiting for the start') : 'Pause › STREET RUNS to join, or T at the start') : '';
        this.raceEl.innerHTML = `<div class="mp-race-head">${head}</div><div class="mp-race-course">${escapeHtml(panel.courseName)}</div><ol class="mp-race-list">${rows}</ol>${hint ? `<div class="mp-race-hint">${hint}</div>` : ''}`;
      }
    }
    // Results for the racers, the same table on every client (the server's order).
    const results = race && race.stage === 'results' && mine ? race : null;
    if (!results) {
      if (this.resultsKey) this.resultsEl.classList.add('hidden');
      this.resultsKey = '';
      return;
    }
    const key = JSON.stringify(results.entrants);
    if (key === this.resultsKey) return;
    this.resultsKey = key;
    const medal = (m: string | null) => (m ? `<span class="mp-medal ${m}">${m.toUpperCase()}</span>` : '');
    const rows = results.entrants.map((e) => {
      const time = e.status === 'finished' && e.time !== null ? formatRunTime(e.time) : e.status === 'timeout' ? 'OUT OF TIME' : 'DNF';
      return `<tr class="${e.playerId === me ? 'you' : ''}" data-player-id="${e.playerId}"><td>${e.position > 0 ? e.position : '–'}</td><td>${escapeHtml(e.name)}</td><td class="num">${time}</td><td>${medal(e.medal)}</td></tr>`;
    }).join('');
    this.resultsEl.innerHTML = `<div class="mp-results-head">RESULTS · ${escapeHtml(results.courseName.toUpperCase())}</div><table class="mp-table"><thead><tr><th>#</th><th>DRIVER</th><th class="num">TIME</th><th>MEDAL</th></tr></thead><tbody>${rows}</tbody></table>`;
    this.resultsEl.classList.remove('hidden');
  }

  /** For __gta7.net. */
  debug(): Record<string, unknown> {
    return { state: this.state, stateAgeMs: this.state ? Math.round(performance.now() - this.stateAt) : -1, feed: this.feedLines(), goAt: this.goAt, locked: this.locked, tags: this.lastTags };
  }
}

/** Where a player's name tag hangs: above his head, or above the roof of the vehicle he sits in. */
export function headOf(p: PlayerView): { x: number; y: number; z: number } {
  const c = p.character;
  const v = c.vehicle;
  if (v && c.state === 'inVehicle') return { x: v.pos.x, y: v.pos.y + (v.spec.class === 'boat' ? 2.2 : 2.3), z: v.pos.z };
  const lying = c.state === 'dead' || c.state === 'knocked';
  return { x: c.pos.x, y: c.pos.y + (lying ? 0.7 : c.height + 0.3), z: c.pos.z };
}
