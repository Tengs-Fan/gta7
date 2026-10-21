// In-game heads-up display: status cluster, radar, messages and prompts.

import { formatMoney, formatTime, wrapAngle } from '../core/math';
import { KeyLabels } from '../input/input';
import type { DamageKind } from '../sim/combat';
import type { BigStyle, SimEvents } from '../sim/events';
import type { MissionDef } from '../sim/missions/runner';
import type { Sim } from '../sim/sim';
import { WEAPONS, type WeaponId } from '../sim/specs';
import { formatRunTime } from '../sim/streetRuns';
import { formatKeys, padGlyph, type InputDevice } from './glyphs';
import { collectBlips, drawBlip, drawPoliceOverlay, gpsRoute, MAP_SCALE, type Blip, type MapImage } from './mapRender';

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
/** Damage kinds that show the hitmarker when the player deals them. */
const WEAPON_HIT: Readonly<Record<DamageKind, boolean>> = { bullet: true, melee: true, explosion: true, vehicle: false, fall: false, fire: false, impact: false, drown: false };
/** Hitmarker display time (s) for a hit and for a kill; the kill colour keeps its own time, whatever hits follow. */
const HIT_TIME = 0.12;
const KILL_TIME = 0.25;
/** The subtitle's fade-out (style.css .subtitle transition, s): the prompt stays above it until it is gone. */
const SUBTITLE_FADE = 0.25;
/**
 * Within this distance (m) of where the GPS route leads, it is not drawn: the marker is in sight, and the route would only run out to the nearest junction and back.
 * The player's own waypoint is reached there, and cleared.
 */
const ROUTE_NEAR = 20;
/** Seconds a showing hint may no longer apply (out of the car, health back, wasted) before it is taken off: passing states (getting in) keep it. */
const HINT_STALE = 0.4;
/** The radar's drawing size (px): its backing store follows its CSS size and the device pixel ratio, scaled from this. */
const RADAR_SIZE = 220;
/** Damage-direction arcs: how many at once, how long one fades (s), and within what angle a new hit refreshes an arc already up. */
const ARCS = 4;
const ARC_TIME = 1;
const ARC_MERGE = 0.35;

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
  /** Hitmarker: seconds it stays up, seconds the kill colour has left, and the sim frame of the hits it shows (a shotgun's pellets are one hit). */
  private hitTimer = 0;
  private killTimer = 0;
  private hitFrame = -1;
  /** Seconds a subtitle that went has left to fade out, and the window size its height was measured at (see raisePrompt). */
  private subtitleFade = 0;
  private subtitleW = 0;
  private subtitleH = 0;
  /**
   * What stands at the bottom centre changed (a subtitle, the prompt slot), and the window size and prompt
   * state it was last measured with, for the title card to stay above it (see restack).
   */
  private stackDirty = true;
  private stackW = 0;
  private stackH = 0;
  private promptUp = false;
  /** Damage-direction arcs: seconds left and the world bearing (heading) of where the hit came from. */
  private readonly arcs: Array<{ el: HTMLElement; t: number; bearing: number }> = [];
  /** Police: seconds the dispatch line stays up, and the evade bar as last written ('' = hidden). */
  private scannerTimer = 0;
  private shownEvade = '';
  waypoint: { x: number; z: number } | null = null;
  visible = true;
  /** Device of the last input (Game writes it every frame); keys in HUD text are drawn for it. */
  device: InputDevice = 'kb';
  private sim: Sim | null = null;
  /**
   * What the help box shows, for how long it has, and (for a hint) whether it counts as read yet and for how long it
   * has no longer applied.
   */
  private helpCur: (HelpEntry & { shown: number; read: boolean; stale: number }) | null = null;
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
  /** A side job (taxi, vigilante, rampage) was running last frame: one starting clears the waypoint, as a mission does. */
  private jobRunning = false;
  /** Window size and pixel ratio the radar's backing store was sized for, and its scale from RADAR_SIZE. */
  private radarFit = '';
  private radarScale = 1;
  /** Side-job objectives keep their last announced step visible until the job ends. */
  private activityObjective = '';
  private controlMode = '';
  private navigationText = '';

  constructor(parent: HTMLElement, private readonly map: MapImage, private readonly keys = new KeyLabels()) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="vignette" data-el="vignette"></div>
      <div class="district"><span>SAN AZURA</span><b data-el="district"></b></div>
      <div class="hud-tr">
        <div class="hud-row"><div class="clock" data-el="clock">00:00</div><div class="weapon" data-el="weapon"><span data-el="wicon"></span><span class="ammo" data-el="ammo"></span></div></div>
        <div class="bars"><div class="bar health" data-el="hbar"><i data-el="health"></i></div><div class="bar armor" data-el="abar"><i data-el="armor"></i></div></div>
        <div class="money" data-el="money">$0</div>
        <div class="money-delta" data-el="delta"></div>
        <div class="stars" data-el="stars">${STAR.repeat(5)}</div>
        <div class="status hidden" data-el="status"></div>
        <div class="evade hidden" data-el="evade"><i data-el="evadeFill"></i></div>
        <div class="scanner" data-el="scanner"></div>
      </div>
      <div class="radar"><canvas width="220" height="220" data-el="radar"></canvas></div>
      <div class="navigation hidden" data-el="navigation">
        <span class="nav-arrow" data-el="navArrow"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 17-8-5-8 5z"/></svg></span>
        <div class="nav-copy"><span data-el="navLabel">NEXT STOP</span><b data-el="navName"></b></div>
        <strong data-el="navDistance"></strong>
      </div>
      <div class="drive-panel hidden" data-el="drive">
        <div class="drive-name" data-el="vname"></div>
        <div class="drive-speed"><strong data-el="speed">000</strong><span>KM/H</span></div>
        <div class="drive-condition"><span data-el="conditionLabel">CONDITION</span><b data-el="condition"></b></div>
        <div class="drive-meter"><i data-el="conditionFill"></i></div>
      </div>
      <div class="quick-controls" data-el="quickControls"></div>
      <div class="help" data-el="help"></div>
      <div class="radio" data-el="radio"></div>
      <div class="prompt hidden" data-el="prompt"></div>
      <div class="subtitle" data-el="subtitle"></div>
      <div class="objective" data-el="objective"></div>
      <div class="big" data-el="big"><div class="t" data-el="bigT"></div><div class="s" data-el="bigS"></div></div>
      <div class="zone" data-el="zone"></div>
      <div class="toast" data-el="toast"></div>
      <div class="crosshair" data-el="cross"><i></i></div>
      <div class="hitmarker" data-el="hitmarker"><b></b><b></b><b></b><b></b></div>
      <div class="dmg-dirs">${Array.from({ length: ARCS }, (_, i) => `<div class="dmg-dir" data-el="dmg${i}"></div>`).join('')}</div>
      <div class="fade" data-el="fade"></div>
    `;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => {
      this.el[e.dataset.el!] = e;
    });
    for (let i = 0; i < ARCS; i++) this.arcs.push({ el: this.el[`dmg${i}`]!, t: 0, bearing: 0 });
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
      this.activityObjective = '';
      this.timers.objective = 0;
      this.el.objective!.classList.remove('show');
    };
    this.unsub.push(
      ev.on('message', (e) => this.help(e.text, e.duration)),
      ev.on('subtitle', (e) => {
        const sub = this.el.subtitle!;
        // An empty line (a skipped one, or one a failure cut short) only takes the last line off: it fades out as it was.
        if (!e.text) {
          this.timers.subtitle = 0;
          sub.classList.remove('show');
          return;
        }
        sub.innerHTML = `<b>${escapeHtml(e.speaker)}:</b> ${escapeHtml(e.text)}`;
        sub.classList.add('show');
        this.timers.subtitle = e.duration;
        this.subtitleFade = SUBTITLE_FADE;
        this.raisePrompt();
        // Dialogue takes the stage: a hint not read yet steps back and returns after it.
        if (this.helpCur?.kind === 'hint' && !this.helpCur.read) this.interruptHint();
      }),
      ev.on('objective', (e) => {
        this.activityObjective = e.text;
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
      // Countdown beats are tied to simulation time. They replace a title immediately;
      // queuing them behind that title would say GO after the car was already released.
      ev.on('streetRunCountdown', (e) => {
        const j = sim.activities.job;
        this.bigQueue = [];
        this.showBig({ text: e.count === 0 ? 'GO' : String(e.count), sub: j?.kind === 'streetRun' ? j.course.name : 'STREET RUN', style: 'info', duration: e.count === 0 ? 1.1 : 1.2 });
        this.el.big!.classList.add('countdown');
      }),
      ev.on('streetRunCheckpoint', (e) => {
        if (e.index < e.total) this.toast(`GATE ${e.index}/${e.total}  ·  ${formatRunTime(e.elapsed)}`);
      }),
      ev.on('streetRunFinished', (e) => {
        const text = `${e.medal.toUpperCase()} FINISH`;
        const course = sim.activities.streetRunCourses().find((c) => c.id === e.id);
        this.bigQueue = this.bigQueue.filter((m) => m.text !== text);
        this.showBig({ text, sub: '', style: 'passed', duration: 6 });
        this.el.big!.classList.add('run-result', e.medal);
        this.el.bigS!.innerHTML = `<strong class="result-clock">${formatRunTime(e.time)}</strong><span class="result-meta">${escapeHtml(course?.name ?? 'Street run')} · ${formatMoney(e.reward)}${e.personalBest ? ' · NEW PERSONAL BEST' : ''}</span>`;
      }),
      // A mission starting (a retry above all) makes any MISSION FAILED still up or waiting old news.
      ev.on('missionStarted', () => {
        this.bigQueue = this.bigQueue.filter((m) => m.style !== 'failed');
        if (this.bigCur?.style === 'failed') {
          this.bigCur = null;
          this.bigTimer = 0;
          this.el.big!.classList.remove('show');
        }
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
      ev.on('damage', (e) => this.onDamage(e)),
    );
    // Police radio on its own line: the subtitle belongs to the story.
    this.unsub.push(ev.on('dispatch', (e) => this.showScanner(e.text)));
  }

  private showScanner(text: string): void {
    this.el.scanner!.textContent = `DISPATCH: ${text}`;
    this.el.scanner!.classList.add('show');
    this.scannerTimer = 4.5;
  }

  /**
   * The dispatch line's timer, and the evade bar: how close the player is to losing the stars, while they
   * flash (not while a mission pins them, as nothing can lose those).
   */
  private updatePolice(dt: number, sim: Sim): void {
    if (this.scannerTimer > 0) {
      this.scannerTimer -= dt;
      if (this.scannerTimer <= 0) this.el.scanner!.classList.remove('show');
    }
    const w = sim.wanted;
    const evade = w.level > 0 && w.searching && w.floor === 0 ? `${(w.evadeProgress() * 100).toFixed(1)}%` : '';
    if (evade !== this.shownEvade) {
      this.el.evade!.classList.toggle('hidden', !evade);
      if (evade) this.el.evadeFill!.style.width = evade;
      this.shownEvade = evade;
    }
  }

  /** Hitmarkers for the player's hits; a damage-direction arc for hits on him that came from somewhere. */
  private onDamage(e: SimEvents['damage']): void {
    if (e.attacker?.isPlayer && !e.victim.isPlayer) {
      // Weapon feedback: bullets, fists and explosions, not people run over.
      if (!WEAPON_HIT[e.kind]) return;
      const el = this.el.hitmarker!;
      const frame = this.sim?.frame ?? -1;
      if (frame !== this.hitFrame || this.hitTimer <= 0) {
        // A new hit: the marker pops again (so the hits of a burst can be told apart), in that hit's colour.
        this.hitFrame = frame;
        el.classList.remove('show', 'head');
        void el.offsetWidth;
        el.classList.add('show');
      }
      // The hits of one frame (a shotgun's pellets) show the strongest of them: gold if one was a headshot.
      if (e.zone === 'head') el.classList.add('head');
      // A kill shows red for its own time, whatever hits follow.
      if (e.killed) {
        this.killTimer = KILL_TIME;
        el.classList.add('kill');
      }
      this.hitTimer = Math.max(this.hitTimer, e.killed ? KILL_TIME : HIT_TIME);
    } else if (e.victim.isPlayer && (e.dirX !== 0 || e.dirZ !== 0) && Number.isFinite(e.dirX + e.dirZ)) {
      // The hit travels along (dirX, dirZ): it came from the opposite way.
      const bearing = Math.atan2(-e.dirX, -e.dirZ);
      let arc = this.arcs.find((a) => a.t > 0 && Math.abs(wrapAngle(a.bearing - bearing)) < ARC_MERGE);
      if (!arc) arc = this.arcs.reduce((a, b) => (b.t < a.t ? b : a));
      arc.t = ARC_TIME;
      arc.bearing = bearing;
      arc.el.classList.add('show');
    }
  }

  /** Fades the hitmarker and the damage arcs; an arc points where its hit came from as the camera turns. */
  private updateHitFeedback(dt: number, camYaw: number): void {
    if (this.killTimer > 0) {
      this.killTimer -= dt;
      if (this.killTimer <= 0) this.el.hitmarker!.classList.remove('kill');
    }
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.el.hitmarker!.classList.remove('show', 'kill', 'head');
    }
    for (const a of this.arcs) {
      if (a.t <= 0) continue;
      a.t -= dt;
      if (a.t <= 0) {
        a.el.classList.remove('show');
        a.el.style.opacity = '0';
        continue;
      }
      // The bearing relative to the view is positive to the left (headings turn anticlockwise),
      // and CSS rotates clockwise from the top of the screen.
      const deg = (((-wrapAngle(a.bearing - camYaw) * 180) / Math.PI) % 360 + 360) % 360;
      a.el.style.transform = `rotate(${deg.toFixed(1)}deg)`;
      a.el.style.opacity = (a.t / ARC_TIME).toFixed(3);
    }
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
    this.jobRunning = sim.activities.busy;
    this.activityObjective = '';
    this.controlMode = '';
    this.navigationText = '';
    this.el.drive!.classList.add('hidden');
    this.el.navigation!.classList.add('hidden');
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
    this.hitTimer = 0;
    this.killTimer = 0;
    this.hitFrame = -1;
    el.hitmarker!.classList.remove('show', 'kill', 'head');
    this.subtitleFade = 0;
    this.lowerPrompt();
    this.promptUp = false;
    for (const a of this.arcs) {
      a.t = 0;
      a.el.classList.remove('show');
      a.el.style.opacity = '0';
    }
    this.scannerTimer = 0;
    this.shownEvade = '';
    el.scanner!.classList.remove('show');
    el.evade!.classList.add('hidden');
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
    this.helpCur = { ...e, shown: 0, read: false, stale: 0 };
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
      // A hint whose situation is over (out of the car, the health back, wasted) goes, and unless it was read already it
      // can come back when it applies again.
      if (cur.kind === 'hint' && cur.hint?.valid) {
        cur.stale = cur.hint.valid() ? 0 : cur.stale + dt;
        if (cur.stale >= HINT_STALE) {
          this.helpCur = null;
          this.timers.help = 0;
          this.el.help!.classList.remove('show');
          this.hintGap = HINT_GAP;
          return;
        }
      }
      // Never while it no longer applies: a hint taken off in that grace (the situation over just before half its time,
      // the low-health hint under WASTED) goes unread, and its rule can raise it again in the right situation.
      if (cur.kind === 'hint' && !cur.read && cur.stale === 0 && cur.shown >= cur.duration / 2) this.markRead(cur);
      if (this.helpDevice !== this.device) this.renderHelp();
      return;
    }
    if (cur) {
      if (cur.kind === 'hint' && !cur.read && cur.stale === 0) this.markRead(cur);
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

  /** Takes the subtitle off when its time is up, and lets the prompt back down once it has faded out. */
  private updateSubtitle(dt: number): void {
    if (this.timers.subtitle > 0) {
      // The window was resized under a line: its wrapped height changed.
      if (typeof window !== 'undefined' && (window.innerWidth !== this.subtitleW || window.innerHeight !== this.subtitleH)) this.raisePrompt();
      return;
    }
    this.el.subtitle!.classList.remove('show');
    if (this.subtitleFade <= 0) return;
    this.subtitleFade -= dt;
    if (this.subtitleFade <= 0) this.lowerPrompt();
  }

  /**
   * Keeps the prompt slot (a prompt or a mission offer card) above a showing subtitle: a long line,
   * wrapped to three lines or more, would otherwise grow up over it. style.css places the prompt by
   * --sub-top, the subtitle's top edge above the bottom of the window.
   */
  private raisePrompt(): void {
    if (typeof window === 'undefined') return;
    this.subtitleW = window.innerWidth;
    this.subtitleH = window.innerHeight;
    const box = this.el.subtitle!.getBoundingClientRect();
    // Not laid out (the HUD hidden): nothing to keep clear of.
    const above = this.subtitleH > 0 && box.height > 0 && Number.isFinite(box.top) ? Math.max(0, Math.round(this.subtitleH - box.top)) : 0;
    this.root.style.setProperty?.('--sub-top', `${above}px`);
    this.stackDirty = true;
  }

  /** The prompt slot back in its own place (no subtitle up). */
  private lowerPrompt(): void {
    this.subtitleW = 0;
    this.subtitleH = 0;
    this.root.style.setProperty?.('--sub-top', '0px');
    this.stackDirty = true;
  }

  /**
   * Keeps the title card above what stands at the bottom centre: a subtitle (up or fading out) and the
   * prompt slot above it, whose top edges a long line, a narrow column or a short window raise. style.css
   * places the card by --stack-top, the higher top edge above the bottom of the window. Measured only
   * when one of them changes, or the window does.
   */
  private restack(): void {
    this.stackDirty = false;
    if (typeof window === 'undefined') return;
    const h = window.innerHeight;
    this.stackW = window.innerWidth;
    this.stackH = h;
    let top = 0;
    const raise = (e: HTMLElement) => {
      const box = e.getBoundingClientRect();
      if (h > 0 && box.height > 0 && Number.isFinite(box.top)) top = Math.max(top, Math.round(h - box.top));
    };
    if (this.subtitleW > 0) raise(this.el.subtitle!);
    if (this.promptUp) raise(this.el.prompt!);
    this.root.style.setProperty?.('--stack-top', `${top}px`);
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
    this.updateSubtitle(dt);
    if (this.timers.zone <= 0) el.zone!.classList.remove('show');
    if (this.timers.radio <= 0) el.radio!.classList.remove('show');
    if (this.timers.toast <= 0) el.toast!.classList.remove('show');
    if (this.timers.delta <= 0) this.moneyDelta = 0;
    const objText = sim.missions.active?.objectiveText ?? (sim.activities.busy ? this.activityObjective : '');
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
    this.updatePolice(dt, sim);

    // Zone changes.
    const pos = sim.playerPos();
    const zone = sim.world.zoneName(pos.x, pos.z);
    if (zone !== this.shown.zone) {
      if (this.shown.zone) this.flashZone(zone, '');
      this.shown.zone = zone;
      el.district!.textContent = zone;
    }

    // Prompt + crosshair.
    if (prompt) {
      this.renderPrompt(sim, prompt);
      el.prompt!.classList.remove('hidden');
    } else el.prompt!.classList.add('hidden');
    if (!!prompt !== this.promptUp) {
      this.promptUp = !!prompt;
      this.stackDirty = true;
    }
    if (this.stackDirty || (typeof window !== 'undefined' && (window.innerWidth !== this.stackW || window.innerHeight !== this.stackH))) this.restack();
    // A reticle whenever a gun is out on foot: small and faint for hip fire, full while aiming (`aiming` is the aim button),
    // red while the muzzle is inside a wall (the shot would only hit that wall).
    const showCross = p.state === 'normal' && p.alive && !sim.playerDown && p.inventory.current !== 'fists';
    el.cross!.classList.toggle('show', showCross);
    el.cross!.classList.toggle('hip', showCross && !aiming);
    el.cross!.classList.toggle('blocked', showCross && sim.combat.muzzleBlocked(p));
    this.updateHitFeedback(dt, camYaw);

    this.updateWaypoint(sim);
    this.updateNavigation(sim, camYaw);
    this.updateDriving(sim);
    this.drawRadar(sim, camYaw, time, dt);
  }

  /** A bearing and a real distance to the same destination used by the radar's route. */
  private updateNavigation(sim: Sim, camYaw: number): void {
    const target = this.routeGoal(sim);
    const el = this.el;
    el.navigation!.classList.toggle('hidden', !target || sim.playerDown);
    if (!target) return;
    const active = sim.missions.active;
    const objective = [...(active?.markers ?? []), ...sim.activities.objectives()][0];
    const offer = !active && !sim.activities.busy ? sim.missions.offers()[0] : undefined;
    const name = this.waypoint ? 'Your waypoint' : objective?.label || (offer ? CONTACTS[offer.giver].name : active?.def.title || 'Objective');
    const label = this.waypoint ? 'WAYPOINT' : active ? 'MISSION ROUTE' : sim.activities.busy ? 'ACTIVITY ROUTE' : 'NEXT CONTACT';
    const text = `${label}:${name}`;
    if (text !== this.navigationText) {
      this.navigationText = text;
      el.navName!.textContent = name;
      el.navLabel!.textContent = label;
    }
    const p = sim.playerPos();
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const distance = Math.hypot(dx, dz);
    const distanceText = distance < ROUTE_NEAR ? 'HERE' : distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} m`;
    if (el.navDistance!.textContent !== distanceText) el.navDistance!.textContent = distanceText;
    el.navArrow!.style.transform = `rotate(${(-wrapAngle(Math.atan2(dx, dz) - camYaw) * 180 / Math.PI).toFixed(1)}deg)`;
    el.navArrow!.style.color = target.color;
  }

  /** Speed, mechanical condition and a compact reminder of the controls for the current device. */
  private updateDriving(sim: Sim): void {
    const v = sim.player.vehicle;
    const el = this.el;
    const inVehicle = !!v;
    this.root.classList.toggle('in-vehicle', inVehicle);
    el.drive!.classList.toggle('hidden', !v || sim.playerDown);
    if (v) {
      if (el.vname!.textContent !== v.spec.name) el.vname!.textContent = v.spec.name;
      const speed = String(Math.round(v.speed * 3.6)).padStart(3, '0');
      if (el.speed!.textContent !== speed) el.speed!.textContent = speed;
      const condition = Math.max(0, Math.min(1, v.condition));
      const conditionText = `${Math.round(condition * 100)}%`;
      if (el.condition!.textContent !== conditionText) el.condition!.textContent = conditionText;
      el.conditionFill!.style.transform = `scaleX(${condition})`;
      el.drive!.classList.toggle('damaged', condition < 0.3);
      el.conditionLabel!.textContent = condition < 0.3 ? 'CRITICAL DAMAGE' : 'CONDITION';
    }
    const mode = `${this.device}:${inVehicle}`;
    if (mode === this.controlMode) return;
    this.controlMode = mode;
    const line = inVehicle
      ? `<span>${this.device === 'pad' ? `${padGlyph('rt')} / ${padGlyph('lt')}` : '<kbd>W</kbd><kbd>S</kbd>'} Drive</span><span><kbd>Space</kbd> Handbrake</span><span><kbd>F</kbd> Exit</span>`
      : '<span><kbd>Shift</kbd> Sprint</span><span><kbd>F</kbd> Enter car</span>';
    el.quickControls!.innerHTML = formatKeys(`${line}<span><kbd>M</kbd> Map</span>`, this.device, { labels: this.keys, inVehicle });
  }

  /**
   * The player's own waypoint is done once he gets within ROUTE_NEAR of it (where its route stops anyway): it goes,
   * and the GPS leads to the objective or the contact again. A side job starting clears it as a mission does (game.ts);
   * one set during the job stays until reached.
   */
  private updateWaypoint(sim: Sim): void {
    const busy = sim.activities.busy;
    if (busy && !this.jobRunning) this.waypoint = null;
    this.jobRunning = busy;
    const w = this.waypoint;
    if (!w) return;
    const p = sim.playerPos();
    if (Math.hypot(w.x - p.x, w.z - p.z) >= ROUTE_NEAR) return;
    this.waypoint = null;
    this.toast('Waypoint reached');
  }

  /**
   * Sizes the radar's backing store to its CSS box times the device pixel ratio (both change with the window, the
   * browser zoom and the monitor), so it is drawn sharp instead of stretched; measured only when those change. Returns
   * the scale from RADAR_SIZE drawing units to backing-store pixels.
   */
  private fitRadar(): number {
    const win = typeof window === 'undefined' ? undefined : (window as Partial<Window>);
    const dpr = Math.min(3, win?.devicePixelRatio && win.devicePixelRatio > 0 ? win.devicePixelRatio : 1);
    const key = `${win?.innerWidth ?? 0}x${win?.innerHeight ?? 0}@${dpr}`;
    if (key === this.radarFit) return this.radarScale;
    const css = this.radar.clientWidth;
    // Not laid out (the HUD hidden): measured again next time.
    if (css > 0) this.radarFit = key;
    const px = Math.max(1, Math.round((css > 0 ? css : RADAR_SIZE) * dpr));
    if (this.radar.width !== px) this.radar.width = px;
    if (this.radar.height !== px) this.radar.height = px;
    this.radarScale = px / RADAR_SIZE;
    return this.radarScale;
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
      this.stackDirty = true;
    }
  }

  /**
   * Shows where the story goes next ('Next: Mama Lou has work - L on your radar') for a few
   * seconds, once no title card is up, unless a mission or a side job is running by then or the
   * player stands on that contact's marker.
   */
  showNextStep(sim: Sim): void {
    if (!sim.missions.active && !sim.activities.busy && sim.missions.offers().length > 0) this.nextPending = true;
  }

  private updateNextStep(sim: Sim): void {
    const o = this.el.objective!;
    const busy = !!sim.missions.active || sim.activities.busy;
    // A mission or job taking over removes the line at once, and so does stepping onto the marker it
    // points to, whose offer card says the same.
    if (o.classList.contains('next') && (busy || this.onNextMarker(sim))) {
      o.classList.remove('next', 'show');
      this.timers.objective = 0;
    }
    if (!this.nextPending || this.bigCur || this.bigQueue.length > 0) return;
    this.nextPending = false;
    const d = busy ? undefined : sim.missions.offers()[0];
    // Already on that marker (Wheels hands over at Lou's): the card says it.
    if (!d || this.onNextMarker(sim)) return;
    const c = CONTACTS[d.giver];
    o.textContent = `Next: ${c.name} has work - ${c.letter} on your radar`;
    o.classList.add('show', 'next');
    this.timers.objective = NEXT_STEP_SECONDS;
  }

  /** The player stands on the marker of the next mission on offer, the one the next-step line names. */
  private onNextMarker(sim: Sim): boolean {
    const here = sim.interactions.current();
    return here?.kind === 'mission' && here.ref === sim.missions.offers()[0]?.id;
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
    // Drawn in RADAR_SIZE units whatever the backing store's size (resizing it also resets the transform).
    const k = this.fitRadar();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const W = RADAR_SIZE;
    const H = RADAR_SIZE;
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
    drawPoliceOverlay(ctx, sim, this.map, time, zoom / MAP_SCALE);
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
   * job objective, else (with neither going on) the contact who has work next. Null with none of
   * them, or once the player is within ROUTE_NEAR of it.
   */
  private routeTarget(sim: Sim): { x: number; z: number; color: string } | null {
    const t = this.routeGoal(sim);
    if (!t) return null;
    const p = sim.playerPos();
    return Math.hypot(t.x - p.x, t.z - p.z) < ROUTE_NEAR ? null : t;
  }

  private routeGoal(sim: Sim): { x: number; z: number; color: string } | null {
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
