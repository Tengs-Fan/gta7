// In-game heads-up display: status cluster, radar, messages and prompts.

import { formatMoney, formatTime } from '../core/math';
import { KeyLabels } from '../input/input';
import type { BigStyle } from '../sim/events';
import type { MissionDef } from '../sim/missions/runner';
import type { Sim } from '../sim/sim';
import { WEAPONS, type WeaponId } from '../sim/specs';
import { formatKeys, type InputDevice } from './glyphs';
import { collectBlips, drawBlip, gpsRoute, MAP_SCALE, type Blip, type MapImage } from './mapRender';

const STAR = '<svg viewBox="0 0 24 24"><path d="M12 1.8l3.1 6.6 7.2.9-5.3 5 1.4 7.2L12 18l-6.4 3.5L7 14.3l-5.3-5 7.2-.9z"/></svg>';

export const WEAPON_ICONS: Record<WeaponId, string> = {
  fists: '<svg viewBox="0 0 64 40"><path d="M18 10c0-3 2-5 5-5h16c4 0 7 3 7 7v6l4 2v9c0 4-3 7-7 7H25c-4 0-7-3-7-7z M24 10v8 M30 9v9 M36 9v9 M42 10v8" stroke="#222" stroke-width="1.5"/></svg>',
  pistol: '<svg viewBox="0 0 64 40"><path d="M8 10h42l4 4v4H30l-3 3h-5l-4 13H9l5-15-6-2z"/></svg>',
  smg: '<svg viewBox="0 0 64 40"><path d="M4 13h46l6 3v4H38l-2 3h-6l-2 12h-7l2-12h-6l-3 8H8l3-10-7-2zM50 11h8v2h-8z"/></svg>',
  shotgun: '<svg viewBox="0 0 64 40"><path d="M2 15h48l10 1v3H40l-4 2H26l-8 9H8l7-10H2z"/></svg>',
  rifle: '<svg viewBox="0 0 64 40"><path d="M2 14h52l8 2v3H44l-3 3h-5l-2 10h-6l2-10h-5l-5 9h-8l5-10H2z M30 12h8v2h-8z"/></svg>',
  rocket: '<svg viewBox="0 0 64 40"><path d="M2 14h50l8 4-8 4H2z M18 22h6l2 10h-6z M34 22h5l1 6h-5z"/></svg>',
};

interface BigMsg {
  text: string;
  sub: string;
  style: BigStyle;
  duration: number;
}

/** A message (sim or game news) shows at once; a hint (tutorial) waits for a quiet moment. */
export type HelpKind = 'message' | 'hint';

/** Bookkeeping for a tutorial hint (see Hud.help). */
export interface HintOptions {
  /** Names the hint while it waits or shows (see hintPending). */
  id: string;
  /** Called once it has been on screen for half its time: from then on it counts as read. */
  onRead?: () => void;
  /** Asked when its turn comes: a hint that no longer applies is dropped unread. */
  valid?: () => boolean;
}

interface HelpEntry {
  text: string;
  duration: number;
  kind: HelpKind;
  /** Whether the player was in a vehicle when it was raised (R and Space mean other things there). */
  inVehicle: boolean;
  hint?: HintOptions;
}

/** Hints waiting for the help box; more are refused. */
const MAX_QUEUED_HINTS = 3;
/** Seconds the help box stays empty before a queued hint takes it, so a new box reads as new. */
const HINT_GAP = 0.5;
/** How long the next-step line stays up. */
const NEXT_STEP_SECONDS = 8;
const CONTACTS = {
  lou: { name: 'Mama Lou', letter: 'L', color: '#ff4fa3' },
  dex: { name: 'Dex Moreau', letter: 'D', color: '#38e1d2' },
} as const;
/** GPS route colours: the player's own waypoint, a mission or job objective. */
const ROUTE_WAYPOINT = '#c04fff';
const ROUTE_OBJECTIVE = '#ffd23d';

// What the DOM shows initially; bind() returns to these for every new session.
const initialShown = () => ({ money: -1, health: -1, armor: -1, weapon: '', ammo: '', clock: '', stars: -1, flash: false, status: '', zone: '' });
const initialTimers = () => ({ help: 0, subtitle: 0, zone: 0, radio: 0, toast: 0, delta: 0, hurt: 0, objective: 0 });
/** Elements shown with the 'show' class for a while. */
const TIMED = ['help', 'subtitle', 'objective', 'zone', 'radio', 'toast', 'delta', 'big'];

export class Hud {
  readonly root: HTMLDivElement;
  private readonly el: Record<string, HTMLElement> = {};
  private readonly radar: HTMLCanvasElement;
  private readonly radarCtx: CanvasRenderingContext2D;
  private shown = initialShown();
  private timers = initialTimers();
  private bigQueue: BigMsg[] = [];
  private bigCur: BigMsg | null = null;
  private bigTimer = 0;
  private moneyDelta = 0;
  private unsub: Array<() => void> = [];
  private route: Array<{ x: number; z: number }> = [];
  private routeTimer = 0;
  private lastHealth = 100;
  private fadeTimeout = 0;
  waypoint: { x: number; z: number } | null = null;
  visible = true;
  /** Device of the last input (Game writes it every frame); keys in HUD text are drawn for it. */
  device: InputDevice = 'kb';
  private sim: Sim | null = null;
  /** What the help box shows, for how long it has, and (for a hint) whether it counts as read yet. */
  private helpCur: (HelpEntry & { shown: number; read: boolean }) | null = null;
  private helpDevice: InputDevice = 'kb';
  private hintQueue: HelpEntry[] = [];
  private hintGap = 0;
  /** showNextStep() was called; the line appears once no big title card is up. */
  private nextPending = false;
  /** Markup last written to the prompt (rewritten only when it changes). */
  private promptHtml = '';
  /** Colour and waypoint the GPS route was planned for; a change re-plans it at once. */
  private routeColor = '';
  private routeWaypoint: { x: number; z: number } | null = null;

  constructor(parent: HTMLElement, private readonly map: MapImage, private readonly keys = new KeyLabels()) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="vignette" data-el="vignette"></div>
      <div class="hud-tr">
        <div class="hud-row"><div class="clock" data-el="clock">00:00</div><div class="weapon" data-el="weapon"><span data-el="wicon"></span><span class="ammo" data-el="ammo"></span></div></div>
        <div class="bars"><div class="bar health" data-el="hbar"><i data-el="health"></i></div><div class="bar armor" data-el="abar"><i data-el="armor"></i></div></div>
        <div class="money" data-el="money">$0</div>
        <div class="money-delta" data-el="delta"></div>
        <div class="stars" data-el="stars">${STAR.repeat(5)}</div>
        <div class="status hidden" data-el="status"></div>
      </div>
      <div class="radar"><canvas width="220" height="220" data-el="radar"></canvas></div>
      <div class="help" data-el="help"></div>
      <div class="radio" data-el="radio"></div>
      <div class="prompt hidden" data-el="prompt"></div>
      <div class="subtitle" data-el="subtitle"></div>
      <div class="objective" data-el="objective"></div>
      <div class="big" data-el="big"><div class="t" data-el="bigT"></div><div class="s" data-el="bigS"></div></div>
      <div class="zone" data-el="zone"></div>
      <div class="toast" data-el="toast"></div>
      <div class="crosshair" data-el="cross"><i></i></div>
      <div class="fade" data-el="fade"></div>
    `;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => {
      this.el[e.dataset.el!] = e;
    });
    this.radar = this.el.radar as HTMLCanvasElement;
    this.radarCtx = this.radar.getContext('2d')!;
  }

  bind(sim: Sim): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.sim = sim;
    this.reset(sim);
    const ev = sim.events;
    // A finished mission's or rampage's last objective must not linger next to its PASSED / FAILED.
    const clearObjective = () => {
      this.timers.objective = 0;
      this.el.objective!.classList.remove('show');
    };
    this.unsub.push(
      ev.on('message', (e) => this.help(e.text, e.duration)),
      ev.on('subtitle', (e) => {
        this.el.subtitle!.innerHTML = `<b>${escapeHtml(e.speaker)}:</b> ${escapeHtml(e.text)}`;
        this.el.subtitle!.classList.add('show');
        this.timers.subtitle = e.duration;
        // Dialogue takes the stage: a hint not read yet steps back and returns after it.
        if (this.helpCur?.kind === 'hint' && !this.helpCur.read) this.interruptHint();
      }),
      ev.on('objective', (e) => {
        this.el.objective!.classList.remove('next');
        // An empty objective (one just reached) leaves at once instead of lingering under the dialogue.
        if (!e.text) {
          clearObjective();
          return;
        }
        this.el.objective!.textContent = e.text;
        this.el.objective!.classList.add('show');
        this.timers.objective = 7;
      }),
      ev.on('big', (e) => {
        // Wasted / busted replace everything immediately.
        if (e.style === 'wasted' || e.style === 'busted') {
          this.bigQueue = [];
          this.showBig(e);
        } else this.bigQueue.push(e);
      }),
      ev.on('money', (e) => {
        this.moneyDelta += e.amount;
        this.timers.delta = 2.5;
      }),
      ev.on('vehicleEnter', (e) => {
        if (e.character.isPlayer) this.flashZone(e.vehicle.spec.name, '');
      }),
      ev.on('fade', (e) => {
        this.el.fade!.classList.add('on');
        window.clearTimeout(this.fadeTimeout);
        this.fadeTimeout = window.setTimeout(() => this.el.fade!.classList.remove('on'), Math.max(200, e.duration * 1000 - 500));
      }),
      ev.on('respawn', () => {
        this.lastHealth = sim.player.health;
      }),
      ev.on('missionEnded', clearObjective),
      ev.on('activityEnded', clearObjective),
    );
  }

  /** Clears everything the previous session left on screen (the HUD is reused across games). */
  private reset(sim: Sim): void {
    this.shown = initialShown();
    this.timers = initialTimers();
    this.bigQueue = [];
    this.bigCur = null;
    this.bigTimer = 0;
    this.moneyDelta = 0;
    this.route = [];
    this.routeTimer = 0;
    this.lastHealth = sim.player.health;
    this.waypoint = null;
    this.helpCur = null;
    this.hintQueue = [];
    this.hintGap = 0;
    this.nextPending = false;
    this.promptHtml = '';
    this.routeColor = '';
    this.routeWaypoint = null;
    this.el.help!.classList.remove('hint');
    this.el.objective!.classList.remove('next');
    this.el.prompt!.classList.remove('card', 'lou', 'dex');
    window.clearTimeout(this.fadeTimeout);
    const el = this.el;
    for (const k of TIMED) el[k]!.classList.remove('show');
    el.fade!.classList.remove('on');
    el.money!.classList.remove('pop');
    // update() only writes these when they change, and '' is also a valid new-session value.
    el.ammo!.textContent = '';
    el.status!.textContent = '';
    el.status!.classList.add('hidden');
  }

  /**
   * Shows text in the help box. Keys are named by their QWERTY binding ('Press E', <kbd>E</kbd>)
   * and drawn for the active device. A message shows at once and cuts a hint short; a hint never
   * covers a message and does not appear while a subtitle is up: it waits in a queue of at most
   * MAX_QUEUED_HINTS. Returns false when a hint was refused because that queue is full.
   */
  help(text: string, duration = 4, kind: HelpKind = 'message', hint?: HintOptions): boolean {
    const entry: HelpEntry = { text, duration, kind, inVehicle: !!this.sim?.player.vehicle, hint };
    if (kind === 'hint') {
      if (this.helpCur || this.hintGap > 0 || this.timers.subtitle > 0 || this.hintQueue.length > 0) {
        if (this.hintQueue.length >= MAX_QUEUED_HINTS) return false;
        this.hintQueue.push(entry);
        return true;
      }
    } else this.interruptHint();
    this.showHelp(entry);
    return true;
  }

  /** Whether the hint with this id waits in the queue or is on screen. */
  hintPending(id: string): boolean {
    return this.helpCur?.hint?.id === id || this.hintQueue.some((e) => e.hint?.id === id);
  }

  /** Drops the queued hints and takes a showing one off (tutorial hints were switched off). */
  clearHints(): void {
    this.hintQueue = [];
    if (this.helpCur?.kind !== 'hint') return;
    this.helpCur = null;
    this.timers.help = 0;
    this.el.help!.classList.remove('show');
  }

  /** Takes a showing hint off the screen; one not read yet goes back to the front of the queue. */
  private interruptHint(): void {
    const cur = this.helpCur;
    if (cur?.kind !== 'hint') return;
    if (!cur.read && this.hintQueue.length < MAX_QUEUED_HINTS) this.hintQueue.unshift({ text: cur.text, duration: cur.duration, kind: 'hint', inVehicle: cur.inVehicle, hint: cur.hint });
    this.helpCur = null;
    this.timers.help = 0;
    this.el.help!.classList.remove('show');
    this.hintGap = HINT_GAP;
  }

  private showHelp(e: HelpEntry): void {
    this.helpCur = { ...e, shown: 0, read: false };
    this.timers.help = e.duration;
    this.hintGap = 0;
    this.el.help!.classList.toggle('hint', e.kind === 'hint');
    this.renderHelp();
    this.el.help!.classList.add('show');
  }

  private renderHelp(): void {
    const cur = this.helpCur;
    if (!cur) return;
    this.helpDevice = this.device;
    this.el.help!.innerHTML = formatKeys(cur.text, this.device, { labels: this.keys, inVehicle: cur.inVehicle });
  }

  /** Expires the help box, redraws it for a new device and lets the next queued hint in. */
  private updateHelp(dt: number): void {
    const cur = this.helpCur;
    if (cur && this.timers.help > 0) {
      cur.shown += dt;
      if (cur.kind === 'hint' && !cur.read && cur.shown >= cur.duration / 2) this.markRead(cur);
      if (this.helpDevice !== this.device) this.renderHelp();
      return;
    }
    if (cur) {
      if (cur.kind === 'hint' && !cur.read) this.markRead(cur);
      this.helpCur = null;
      this.el.help!.classList.remove('show');
      this.hintGap = HINT_GAP;
    }
    if (this.hintGap > 0) {
      this.hintGap -= dt;
      return;
    }
    if (this.timers.subtitle > 0) return;
    while (this.hintQueue.length > 0) {
      const next = this.hintQueue.shift()!;
      // Waited too long: what it explains is over (the stars are gone, the health is back).
      if (next.hint?.valid && !next.hint.valid()) continue;
      this.showHelp(next);
      return;
    }
  }

  private markRead(cur: { read: boolean; hint?: HintOptions }): void {
    cur.read = true;
    cur.hint?.onRead?.();
  }

  toast(text: string): void {
    this.el.toast!.textContent = text;
    this.el.toast!.classList.add('show');
    this.timers.toast = 2.5;
  }

  showRadio(name: string): void {
    this.el.radio!.textContent = name;
    this.el.radio!.classList.add('show');
    this.timers.radio = 2.5;
  }

  private flashZone(name: string, sub: string): void {
    this.el.zone!.innerHTML = `${escapeHtml(name)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}`;
    this.el.zone!.classList.add('show');
    this.timers.zone = 3;
  }

  private showBig(m: BigMsg): void {
    this.bigCur = m;
    this.bigTimer = m.duration;
    const big = this.el.big!;
    big.className = `big show ${m.style}`;
    this.el.bigT!.textContent = m.text;
    // The sub-line is plain sim text, but it may name a key ('MISSION FAILED ... Press E to retry').
    this.el.bigS!.innerHTML = formatKeys(escapeHtml(m.sub), this.device, { labels: this.keys, inVehicle: !!this.sim?.player.vehicle });
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.classList.toggle('hidden', !v);
  }

  update(dt: number, sim: Sim, camYaw: number, aiming: boolean, prompt: string | null, time: number): void {
    if (!this.visible) return;
    const p = sim.player;
    const prog = sim.progress;
    const el = this.el;

    // Timed elements.
    for (const k of Object.keys(this.timers) as Array<keyof typeof this.timers>) if (this.timers[k] > 0) this.timers[k] -= dt;
    this.updateHelp(dt);
    if (this.timers.subtitle <= 0) el.subtitle!.classList.remove('show');
    if (this.timers.zone <= 0) el.zone!.classList.remove('show');
    if (this.timers.radio <= 0) el.radio!.classList.remove('show');
    if (this.timers.toast <= 0) el.toast!.classList.remove('show');
    if (this.timers.delta <= 0) this.moneyDelta = 0;
    const objText = sim.missions.active?.objectiveText ?? '';
    if (objText && this.timers.objective <= 0 && this.timers.subtitle <= 0) {
      el.objective!.textContent = objText;
      el.objective!.classList.add('show');
    } else if (!objText && this.timers.objective <= 0) el.objective!.classList.remove('show');

    if (this.bigCur) {
      this.bigTimer -= dt;
      if (this.bigTimer <= 0) {
        this.bigCur = null;
        el.big!.classList.remove('show');
      }
    } else if (this.bigQueue.length > 0) {
      this.showBig(this.bigQueue.shift()!);
    }
    this.updateNextStep(sim);

    // Status cluster.
    const clock = sim.clock.label();
    if (clock !== this.shown.clock) {
      this.shown.clock = clock;
      el.clock!.textContent = clock;
    }
    if (prog.money !== this.shown.money) {
      if (this.shown.money >= 0) {
        el.money!.classList.remove('pop');
        void el.money!.offsetWidth;
        el.money!.classList.add('pop');
      }
      this.shown.money = prog.money;
      el.money!.textContent = formatMoney(prog.money);
    }
    // Hidden when the window expired and also when gains and losses inside it cancel out.
    if (this.moneyDelta !== 0) {
      el.delta!.textContent = `${this.moneyDelta > 0 ? '+' : '-'}${formatMoney(Math.abs(this.moneyDelta))}`;
      el.delta!.style.color = this.moneyDelta > 0 ? 'var(--money)' : '#ff6a5a';
      el.delta!.classList.add('show');
    } else el.delta!.classList.remove('show');
    const hp = Math.max(0, p.health) / p.maxHealth;
    if (Math.abs(hp - this.shown.health) > 0.001) {
      this.shown.health = hp;
      el.health!.style.transform = `scaleX(${hp})`;
      el.hbar!.classList.toggle('ok', hp > 0.5);
      el.hbar!.classList.toggle('low', hp < 0.25 && p.alive);
    }
    const ar = p.armor / 100;
    if (Math.abs(ar - this.shown.armor) > 0.001) {
      this.shown.armor = ar;
      el.armor!.style.transform = `scaleX(${ar})`;
      el.abar!.classList.toggle('hidden', ar <= 0);
    }
    if (p.health < this.lastHealth - 0.5) {
      this.timers.hurt = 0.35;
    }
    this.lastHealth = p.health;
    el.vignette!.style.opacity = String(Math.max(0, this.timers.hurt / 0.35) * 0.8 + (hp < 0.25 && p.alive ? 0.35 + Math.sin(time * 6) * 0.1 : 0));

    const w = p.inventory.current;
    if (w !== this.shown.weapon) {
      this.shown.weapon = w;
      el.wicon!.innerHTML = WEAPON_ICONS[w];
    }
    const slot = p.inventory.slot();
    const ammo = w === 'fists' ? '' : p.reloadTimer > 0 ? 'RELOAD' : `${slot.clip}/${slot.ammo}`;
    if (ammo !== this.shown.ammo) {
      this.shown.ammo = ammo;
      el.ammo!.textContent = ammo;
    }
    const stars = sim.wanted.level;
    const flash = sim.wanted.searching;
    if (stars !== this.shown.stars || flash !== this.shown.flash) {
      this.shown.stars = stars;
      this.shown.flash = flash;
      el.stars!.querySelectorAll('svg').forEach((s, i) => s.classList.toggle('on', i < stars));
      el.stars!.classList.toggle('flash', flash);
    }
    const status = this.statusText(sim);
    if (status !== this.shown.status) {
      this.shown.status = status;
      el.status!.textContent = status;
      el.status!.classList.toggle('hidden', !status);
    }

    // Zone changes.
    const pos = sim.playerPos();
    const zone = sim.world.zoneName(pos.x, pos.z);
    if (zone !== this.shown.zone) {
      if (this.shown.zone) this.flashZone(zone, '');
      this.shown.zone = zone;
    }

    // Prompt + crosshair.
    if (prompt) {
      this.renderPrompt(sim, prompt);
      el.prompt!.classList.remove('hidden');
    } else el.prompt!.classList.add('hidden');
    const showCross = aiming && p.alive && !sim.playerDown && p.inventory.current !== 'fists';
    el.cross!.classList.toggle('show', showCross);

    this.drawRadar(sim, camYaw, time, dt);
  }

  /** The prompt slot: an offer card at a contact's marker, else the prompt with its key glyphs. */
  private renderPrompt(sim: Sim, prompt: string): void {
    const m = sim.interactions.current();
    const def = m?.kind === 'mission' && !sim.missions.active ? sim.missions.defs.find((d) => d.id === m.ref) : undefined;
    // The card names the mission already, so its start line drops the quoted title.
    const line = def ? prompt.replace(/\s*"[^"]*"\s*$/, '') : prompt;
    const start = formatKeys(line, this.device, { labels: this.keys, inVehicle: !!sim.player.vehicle });
    const el = this.el.prompt!;
    el.classList.toggle('card', !!def);
    el.classList.toggle('lou', def?.giver === 'lou');
    el.classList.toggle('dex', def?.giver === 'dex');
    const html = def ? missionCard(def, start) : start;
    if (html !== this.promptHtml) {
      this.promptHtml = html;
      el.innerHTML = html;
    }
  }

  /**
   * Shows where the story goes next ('Next: Mama Lou has work - L on your radar') for a few
   * seconds, once no title card is up, unless a mission or a side job is running by then.
   */
  showNextStep(sim: Sim): void {
    if (!sim.missions.active && !sim.activities.busy && sim.missions.offers().length > 0) this.nextPending = true;
  }

  private updateNextStep(sim: Sim): void {
    const o = this.el.objective!;
    const busy = !!sim.missions.active || sim.activities.busy;
    // A mission or job taking over removes the line at once.
    if (busy && o.classList.contains('next')) {
      o.classList.remove('next', 'show');
      this.timers.objective = 0;
    }
    if (!this.nextPending || this.bigCur || this.bigQueue.length > 0) return;
    this.nextPending = false;
    const d = busy ? undefined : sim.missions.offers()[0];
    if (!d) return;
    const c = CONTACTS[d.giver];
    o.textContent = `Next: ${c.name} has work - ${c.letter} on your radar`;
    o.classList.add('show', 'next');
    this.timers.objective = NEXT_STEP_SECONDS;
  }

  private statusText(sim: Sim): string {
    const m = sim.missions.active;
    if (m) {
      if (m.timer) return `${m.timer.label} ${formatTime(m.timer.endsAt - sim.time)}`;
      if (m.counter) return m.counter;
    }
    return sim.activities.status() ?? '';
  }

  private drawRadar(sim: Sim, camYaw: number, time: number, dt: number): void {
    const ctx = this.radarCtx;
    const W = this.radar.width;
    const H = this.radar.height;
    const cx = W / 2;
    const cy = H / 2;
    const p = sim.playerPos();
    const v = sim.player.vehicle;
    const speed = v ? v.speed : 0;
    const zoom = 0.75 - Math.min(0.3, speed / 120); // px per metre; zooms out at speed
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath();
    ctx.arc(cx, cy, W / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#16384f';
    ctx.fillRect(0, 0, W, H);
    // Rotate so that the camera's forward direction points up.
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI + camYaw);
    ctx.scale(zoom / MAP_SCALE, zoom / MAP_SCALE);
    ctx.translate(-(p.x - this.map.minX) * MAP_SCALE, -(p.z - this.map.minZ) * MAP_SCALE);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.map.canvas, 0, 0);
    // GPS route to the waypoint or first objective.
    this.routeTimer -= dt;
    const target = this.routeTarget(sim);
    // A different kind of target (a waypoint set, a mission started) is planned at once.
    if (target && (target.color !== this.routeColor || this.waypoint !== this.routeWaypoint)) this.routeTimer = 0;
    if (target && this.routeTimer <= 0) {
      this.routeTimer = 1;
      this.routeColor = target.color;
      this.routeWaypoint = this.waypoint;
      this.route = gpsRoute(sim, target.x, target.z);
    }
    if (!target) {
      this.route = [];
      this.routeColor = '';
    }
    if (this.route.length > 1) {
      ctx.strokeStyle = this.routeColor;
      ctx.lineWidth = 6 / zoom;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      this.route.forEach((pt, i) => {
        const x = (pt.x - this.map.minX) * MAP_SCALE;
        const y = (pt.z - this.map.minZ) * MAP_SCALE;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.restore();

    // Blips in screen space.
    const range = W / 2 - 10;
    const toScreen = (x: number, z: number) => {
      const dx = (x - p.x) * zoom;
      const dz = (z - p.z) * zoom;
      const a = Math.PI + camYaw;
      const c = Math.cos(a);
      const s = Math.sin(a);
      return { x: cx + dx * c - dz * s, y: cy + dx * s + dz * c };
    };
    // The waypoint goes first, under the rest: a contact's L / D on the same spot stays on top.
    const blips: Blip[] = this.waypoint ? [{ x: this.waypoint.x, z: this.waypoint.z, color: ROUTE_WAYPOINT, label: '', sticky: true, shape: 'square' }] : [];
    blips.push(...collectBlips(sim, time));
    for (const b of blips) {
      let s = toScreen(b.x, b.z);
      const dx = s.x - cx;
      const dy = s.y - cy;
      const d = Math.hypot(dx, dy);
      if (d > range) {
        if (!b.sticky) continue;
        s = { x: cx + (dx / d) * range, y: cy + (dy / d) * range };
      }
      drawBlip(ctx, b, s.x, s.y, b.shape === 'dot' ? 9 : 14);
    }
    // North marker.
    const n = toScreen(p.x, p.z - 10000);
    const nd = Math.hypot(n.x - cx, n.y - cy) || 1;
    const nx = cx + ((n.x - cx) / nd) * (W / 2 - 12);
    const ny = cy + ((n.y - cy) / nd) * (W / 2 - 12);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 16px Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeText('N', nx, ny);
    ctx.fillText('N', nx, ny);
    // Player arrow (relative to the camera).
    const ph = sim.player.vehicle ? sim.player.vehicle.heading : sim.player.heading;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-(ph - camYaw));
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Health / armour ring.
    const hp = Math.max(0, sim.player.health) / sim.player.maxHealth;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.arc(cx, cy, W / 2 - 3, Math.PI * 0.6, Math.PI * 1.4);
    ctx.stroke();
    ctx.strokeStyle = hp > 0.5 ? '#6fd36f' : '#e2453c';
    ctx.beginPath();
    ctx.arc(cx, cy, W / 2 - 3, Math.PI * 1.4 - Math.PI * 0.8 * hp, Math.PI * 1.4);
    ctx.stroke();
  }

  /**
   * Where the GPS route leads, in its colour: the player's own waypoint, else the first mission or
   * job objective, else (with neither going on) the contact who has work next.
   */
  private routeTarget(sim: Sim): { x: number; z: number; color: string } | null {
    if (this.waypoint) return { x: this.waypoint.x, z: this.waypoint.z, color: ROUTE_WAYPOINT };
    const objs = [...(sim.missions.active?.markers ?? []), ...sim.activities.objectives()];
    const o = objs[0];
    if (o) {
      const t = o.vehicle ?? o.character;
      return t ? { x: t.pos.x, z: t.pos.z, color: ROUTE_OBJECTIVE } : { x: o.x, z: o.z, color: ROUTE_OBJECTIVE };
    }
    if (sim.missions.active || sim.activities.busy) return null;
    const d = sim.missions.offers()[0];
    if (!d) return null;
    const poi = sim.world.layout.pois.find((p) => p.id === d.giver);
    return poi ? { x: poi.x, z: poi.z, color: CONTACTS[d.giver].color } : null;
  }
}

/** The prompt at a contact's marker: who offers what for how much, and how to start it. */
function missionCard(def: MissionDef, start: string): string {
  const c = CONTACTS[def.giver];
  return (
    `<div class="card-head"><span class="card-giver">${c.name}</span><span class="card-reward">${formatMoney(def.reward)}</span></div>` +
    `<div class="card-title">${escapeHtml(def.title)}</div><div class="card-blurb">${escapeHtml(def.blurb)}</div><div class="card-start">${start}</div>`
  );
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function weaponName(id: WeaponId): string {
  return WEAPONS[id].name;
}
