// Synthesised sound effects, the player's vehicle, sirens, the ambience bed and the mix (mixer.ts).
// Everything is generated with WebAudio nodes; there are no audio files.

import { clamp } from '../core/math';
import type { Vehicle } from '../sim/entities';
import type { SimEvents } from '../sim/events';
import { playerOf, type PlayerView, type ViewState } from '../sim/viewState';
import type { VehicleKind, WeaponId } from '../sim/specs';
import type { Rect } from '../world/layout';
import type { StaticWorld } from '../world/staticWorld';
import { Ambience, shoreInfo, type AmbienceFrame, type ShoreInfo } from './ambience';
import { dopplerFactor } from './doppler';
import { EchoBank } from './echo';
import { EngineVoice } from './engineVoice';
import { distanceCutoff, EXPLOSION_DUCK_RANGE, Glider, Mixer, mixTargets, OPEN_HZ, withinParam, type MixTargets } from './mixer';
import { Radio } from './radio';
import { PoliceScanner } from './scanner';
import { NodeTally } from './tally';
import { DEFAULT_HORN, engineProfile } from './vehicleProfiles';

interface Listener {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export type HitConfirm = 'hit' | 'kill' | 'head';
const CONFIRM_RANK: Readonly<Record<HitConfirm, number>> = { hit: 0, head: 1, kill: 2 };

/** AudioParams throw on NaN / Infinity, so every computed value is checked before use. */
function finite(...xs: number[]): boolean {
  for (const x of xs) if (!Number.isFinite(x)) return false;
  return true;
}

/** Peak gain of the player's held horn. */
const HORN_LEVEL = 0.15;
/** Peak gain of the nearest police siren. */
const SIREN_LEVEL = 0.4;
/** Siren pitch and wail depth (Hz) before the Doppler shift. */
const SIREN_HZ = 950;
const SIREN_SWEEP = 380;
/** Time constant of the Doppler glide: the pitch slides through a pass-by instead of stepping. */
const DOPPLER_TAU = 0.06;
/** Scream peak: 14 dB above the old 0.12. */
const SCREAM_LEVEL = 0.12 * Math.pow(10, 14 / 20);
/** Seconds an explosion keeps the music ducked before it recovers. */
const EXPLOSION_HOLD = 0.15;
/**
 * Music volume from which the car radio is fully present in the mix (the default is 0.6).
 * Below it the engine steps back under the radio only as far as the radio can be heard; at 0 not at all.
 */
const RADIO_FULL = 0.3;

export class AudioEngine {
  ctx: AudioContext | null = null;
  /** The bus graph and master chain; null until unlock(). */
  mixer: Mixer | null = null;
  private paused = false;
  /** World one-shots (gunfire, impacts, explosions...). */
  private sfx!: GainNode;
  /** Menu clicks and HUD stings: bypass the pause stage and every duck. */
  private uiBus!: GainNode;
  private musicBus!: GainNode;
  /** The player's engine, tyres, wind and horn. */
  private vehicleBus!: GainNode;
  private noise!: AudioBuffer;
  private engine: EngineVoice | null = null;
  private ambience: Ambience | null = null;
  private hornNodes: { osc1: OscillatorNode; osc2: OscillatorNode; gain: GainNode } | null = null;
  private hornKind: VehicleKind | null = null;
  private sirenNodes: { osc: OscillatorNode; gain: GainNode; lfo: OscillatorNode; lfoGain: GainNode } | null = null;
  /** Doppler factor last applied to the siren. */
  private sirenDoppler = 1;
  readonly radio = new Radio();
  /** Sources started by the talk station, the barks and the echoes, and how many still play. */
  readonly nodes = new NodeTally();
  private scanner: PoliceScanner | null = null;
  private echo: EchoBank | null = null;
  private readonly listener: Listener = { x: 0, y: 0, z: 0, yaw: 0 };
  private unsub: Array<() => void> = [];
  /** Id of the player slot this listener belongs to: player-scoped events about others are not for it. */
  private localPlayerId = 0;

  private me(sim: ViewState): PlayerView {
    return playerOf(sim, this.localPlayerId);
  }

  /** An event about the local player; one without a playerId is about slot 0. */
  private mine(e: { playerId?: number }): boolean {
    return (e.playerId ?? 0) === this.localPlayerId;
  }
  private volumes = { master: 0.8, music: 0.6, sfx: 0.85 };
  private lastShot = new Map<WeaponId, number>();
  /**
   * The strongest of the player's hits this frame (kill over headshot over hit), played once by update():
   * one blast that drops six people is one kill confirmation, not six identical thumps in phase.
   */
  private confirm: HitConfirm | null = null;
  /** Frame of the player's last shot per weapon: one trigger pull plays one gunshot. */
  private playerShotFrame = new Map<WeaponId, number>();
  /** Counts update() calls. */
  private frame = 0;
  private subtitleTimer = 0;
  /** Seconds left of the result-card duck: the passed / wasted / busted cards', and the MISSION FAILED cards' apart. */
  private bigTimer = 0;
  private failTimer = 0;
  private explosionTimer = 0;
  private explosionDist = Infinity;
  private inVehicle = false;
  private readonly mix = {} as MixTargets;
  private readonly glide = new Glider();
  private readonly ambFrame = {} as AmbienceFrame;
  private readonly shore = {} as ShoreInfo;
  private softWorld: StaticWorld | null = null;
  private softPatches: Rect[] = [];
  /** Instrumentation for tests: sounds started since the page loaded. */
  readonly counters = { gunshots: 0, doorThunks: 0, scrapes: 0, dispatches: 0, barks: 0, echoes: 0 };
  private failed = false;
  private warned = false;

  /** Creates / resumes the AudioContext. Must be called from a user gesture. */
  unlock(): void {
    if (this.failed) return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) {
          this.failed = true;
          return;
        }
        const ctx = new AC();
        this.ctx = ctx;
        const mixer = new Mixer(ctx, this.paused);
        this.mixer = mixer;
        this.sfx = mixer.sfx;
        this.uiBus = mixer.uiBus;
        this.musicBus = mixer.musicBus;
        this.vehicleBus = mixer.vehicleBus;
        const len = ctx.sampleRate * 2;
        this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.radio.init(ctx, this.musicBus, this.noise, this.nodes);
        this.scanner = new PoliceScanner(ctx, this.sfx, this.noise, this.nodes);
        this.echo = new EchoBank(ctx, this.sfx, this.nodes);
        this.engine = new EngineVoice(ctx, this.vehicleBus, this.noise);
        this.ambience = new Ambience(ctx, mixer.ambBus);
        this.buildHorn();
        this.buildSiren();
        this.applyVolumes();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    } catch {
      this.failed = true;
      this.ctx = null;
      this.mixer = null;
    }
  }

  setVolumes(master: number, music: number, sfx: number): void {
    const v = this.volumes;
    const vol = (x: number, old: number) => (Number.isFinite(x) ? clamp(x, 0, 1) : old);
    this.volumes = { master: vol(master, v.master), music: vol(music, v.music), sfx: vol(sfx, v.sfx) };
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.mixer) return;
    this.mixer.setVolumes(this.volumes.master, this.volumes.music, this.volumes.sfx);
  }

  /** Mutes the world (effects, vehicle, ambience, radio) under the pause menu, map, shop or crash screen without stopping the radio clock. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    // Remembered even without a context yet, so unlock() starts in the right state.
    this.paused = paused;
    this.radio.setPaused(paused);
    this.mixer?.setPaused(paused);
  }

  /** Runs a sound routine; an audio bug is logged once and never reaches the game loop. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn('GTA7 audio error', err);
      }
    }
  }

  attach(sim: ViewState, localPlayerId = 0): void {
    this.localPlayerId = localPlayerId;
    for (const u of this.unsub) u();
    this.unsub = [];
    this.subtitleTimer = 0;
    this.bigTimer = 0;
    this.failTimer = 0;
    this.explosionTimer = 0;
    this.explosionDist = Infinity;
    // Sound handlers run inside sim.update(): isolate them from it.
    const on = <K extends keyof SimEvents>(type: K, fn: (e: SimEvents[K]) => void) => sim.events.on(type, (e) => this.safely(() => fn(e)));
    this.confirm = null;
    this.unsub.push(
      // One bang per trigger pull; helicopter rounds come only as 'shot' events.
      on('weaponFired', (e) => this.gunshot(e.weapon, e.x, e.y, e.z, !!e.shooter && e.shooter === this.me(sim).character, sim.world.districtAt(e.x, e.z))),
      on('shot', (e) => {
        if (!e.shooter) this.gunshot(e.weapon, e.fx, e.fy, e.fz, false, sim.world.districtAt(e.fx, e.fz));
      }),
      on('dispatch', (e) => {
        if (!this.mine(e)) return;
        this.counters.dispatches++;
        this.policeBark(e.text);
      }),
      on('damage', (e) => {
        // The player's weapon hits: bullets, fists and explosions, not people run over.
        if (!e.attacker || e.attacker !== this.me(sim).character || e.victim.isPlayer || !(e.kind === 'bullet' || e.kind === 'melee' || e.kind === 'explosion')) return;
        const kind: HitConfirm = e.killed ? 'kill' : e.zone === 'head' ? 'head' : 'hit';
        if (this.confirm === null || CONFIRM_RANK[kind] > CONFIRM_RANK[this.confirm]) this.confirm = kind;
      }),
      on('explosion', (e) => this.explosion(e.x, e.y, e.z, e.radius)),
      // The player's own crashes (his car hitting something, landing, running someone over) sound inside the car,
      // not through the in-car muffling of the world outside.
      on('impact', (e) => this.impact(e.x, e.y, e.z, e.strength, !!e.vehicle && e.vehicle === this.me(sim).character.vehicle)),
      // His car grinding along something, or a faster car grinding along his (reported as that car's scrape, his as `other`).
      on('scrape', (e) => {
        const own = this.me(sim).character.vehicle;
        this.scrape(e.x, e.y, e.z, e.speed, !!own && (e.vehicle === own || e.other === own));
      }),
      on('melee', (e) => this.punch(e.x, e.y, e.z, e.hit)),
      on('horn', (e) => {
        // The player's own horn is a continuous voice (updateHorn); AI taps play here.
        if (e.vehicle === this.me(sim).character.vehicle) return;
        this.horn(e.vehicle.pos.x, e.vehicle.pos.y, e.vehicle.pos.z, e.vehicle.spec.police);
      }),
      on('pickup', (e) => this.chime(e.kind === 'money' ? 'cash' : 'pickup')),
      on('streetRunCountdown', (e) => this.chime(e.count === 0 ? 'go' : 'countdown')),
      on('streetRunCheckpoint', (e) => {
        if (e.index < e.total) this.chime('checkpoint');
      }),
      on('money', (e) => {
        if (this.mine(e) && e.amount >= 500) this.chime('cash');
      }),
      on('splash', (e) => this.splash(e.x, e.y, e.z, e.big)),
      on('propBroken', () => this.thud(0.5)),
      on('reload', (e) => {
        if (e.character === this.me(sim).character) this.reloadClick();
      }),
      on('wanted', (e) => {
        if (this.mine(e) && e.level > e.previous) this.chime('alert');
      }),
      on('big', (e) => {
        if (!this.mine(e)) return;
        if (e.style === 'passed') this.chime('passed');
        else if (e.style === 'failed' || e.style === 'wasted' || e.style === 'busted') this.chime('fail');
        else if (e.style === 'stunt') this.chime('stunt');
        // Result cards duck everything but the UI bus (where their sting plays) while they show.
        if (!finite(e.duration)) return;
        if (e.style === 'failed') this.failTimer = Math.max(this.failTimer, e.duration);
        else if (e.style === 'passed' || e.style === 'wasted' || e.style === 'busted') this.bigTimer = Math.max(this.bigTimer, e.duration);
      }),
      // A mission starting (a retry above all) takes a MISSION FAILED card down, showing or waiting (as the HUD does),
      // and its duck with it.
      on('missionStarted', (e) => {
        if (this.mine(e)) this.failTimer = 0;
      }),
      on('subtitle', (e) => {
        // Dialogue ducks the music and the ambience for as long as the line shows (as in the HUD).
        if (this.mine(e) && finite(e.duration)) this.subtitleTimer = e.duration;
      }),
      on('scream', (e) => this.scream(e.x, e.y, e.z)),
      on('vehicleEnter', (e) => {
        if (e.character === this.me(sim).character) this.doorThunk(e.vehicle);
      }),
      on('vehicleExit', (e) => {
        if (e.character === this.me(sim).character) this.doorThunk(e.vehicle);
      }),
    );
  }

  setListener(x: number, y: number, z: number, yaw: number): void {
    this.listener.x = x;
    this.listener.y = y;
    this.listener.z = z;
    this.listener.yaw = yaw;
  }

  /** Gain, pan, distance low-pass and distance for a sound at (x, y, z). Returns null when inaudible. */
  private spatial(x: number, y: number, z: number, ref: number, max: number): { gain: number; pan: number; cutoff: number; dist: number } | null {
    const L = this.listener;
    const dx = x - L.x;
    const dy = y - L.y;
    const dz = z - L.z;
    const d = Math.hypot(dx, dy, dz);
    if (!(d <= max)) return null; // also drops NaN positions
    const gain = 1 / (1 + Math.pow(d / ref, 1.6));
    const rx = -Math.cos(L.yaw);
    const rz = Math.sin(L.yaw);
    const hd = Math.hypot(dx, dz) || 1;
    const pan = clamp(((dx * rx + dz * rz) / hd) * 0.8, -1, 1);
    return finite(pan) ? { gain, pan, cutoff: distanceCutoff(d), dist: d } : null;
  }

  /** Entry point of a one-shot: a panner and its distance low-pass into `bus` (world effects by default). */
  private out(pan: number, cutoff: number = OPEN_HZ, bus: AudioNode = this.sfx): AudioNode {
    const ctx = this.ctx!;
    let dest = bus;
    if (finite(cutoff) && cutoff < OPEN_HZ) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = withinParam(f.frequency, cutoff);
      f.connect(dest);
      dest = f;
    }
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = finite(pan) ? pan : 0;
      p.connect(dest);
      return p;
    }
    return dest;
  }

  /** A gain for a one-shot envelope: silent from creation until its automation starts. */
  private envGain(): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, this.ctx!.currentTime);
    return g;
  }

  /** One sample: sources start this long after their envelope's first event. */
  private get sample(): number {
    return 1 / this.ctx!.sampleRate;
  }

  private noiseBurst(dest: AudioNode, t: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, freqEnd?: number): void {
    if (!finite(t, dur, freq, q, gain, freqEnd ?? freq) || !(gain > 0) || !(dur > 0)) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    // Loop so a long burst (explosion rumble) can't run off the end of the 2 s buffer from its
    // random start offset; stop() below ends it.
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
    f.Q.value = q;
    const g = this.envGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(Math.min(0.0008, gain * 0.05), t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t + this.sample, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private tone(dest: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, dur: number, gain: number, attack = 0.002): void {
    // The exponential ramp below also rejects a zero peak.
    if (!finite(t, f0, f1, dur, gain, attack) || gain <= 0) return;
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = this.envGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
    o.connect(g);
    g.connect(dest);
    o.start(t + this.sample);
    o.stop(t + dur + 0.05);
  }

  private ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** A police radio bark for a dispatch line (rate-limited: one at a time, BARK_MIN_GAP apart). */
  policeBark(text: string): boolean {
    if (!this.ready() || !this.scanner) return false;
    if (!this.scanner.bark(text)) return false;
    this.counters.barks++;
    return true;
  }

  /**
   * A gunshot at (x, y, z). `district` (where the shooter stands) picks the echo: a downtown canyon rings on, the open
   * beach hardly at all; without it the shot is dry.
   */
  gunshot(w: WeaponId, x: number, y: number, z: number, player: boolean, district?: string): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    if (player) {
      // A shotgun reports nine pellets in the same frame: one trigger pull, one bang.
      if (this.playerShotFrame.get(w) === this.frame) return;
      this.playerShotFrame.set(w, this.frame);
    } else if (now - (this.lastShot.get(w) ?? -Infinity) < 0.04) {
      // Rate-limit overlapping shots of the same weapon (SMG crowds, NPC shotgun pellets).
      return;
    }
    this.lastShot.set(w, now);
    const s = this.spatial(x, y, z, 14, 260);
    if (!s) return;
    // The player's own shots from a car ring inside it, not through the in-car muffling.
    const dry = this.out(s.pan, s.cutoff, player && this.inVehicle ? this.vehicleBus : this.sfx);
    const out = ctx.createGain();
    out.connect(dry);
    const g = s.gain * (player ? 1 : 0.8);
    // Far shots are mostly echo: the send rises as the direct sound falls with distance.
    if (district !== undefined && this.echo?.send(out, district, clamp(1 / Math.sqrt(Math.max(0.05, s.gain)), 1, 2.5))) this.counters.echoes++;
    const t = now + 0.005;
    this.counters.gunshots++;
    switch (w) {
      case 'pistol':
        this.noiseBurst(out, t, 0.16, 'lowpass', 4200, 0.7, 0.9 * g, 900);
        this.tone(out, t, 'sine', 160, 50, 0.12, 0.5 * g);
        break;
      case 'smg':
        this.noiseBurst(out, t, 0.09, 'lowpass', 5200, 0.6, 0.75 * g, 1200);
        this.tone(out, t, 'sine', 180, 60, 0.07, 0.35 * g);
        break;
      case 'shotgun':
        this.noiseBurst(out, t, 0.42, 'lowpass', 2600, 0.6, 1.1 * g, 300);
        this.tone(out, t, 'sine', 110, 38, 0.3, 0.8 * g);
        break;
      case 'rifle':
        this.noiseBurst(out, t, 0.14, 'lowpass', 6000, 0.6, 0.85 * g, 1400);
        this.noiseBurst(out, t, 0.03, 'highpass', 3000, 0.7, 0.4 * g);
        this.tone(out, t, 'sine', 150, 45, 0.1, 0.5 * g);
        break;
      case 'rocket':
        this.noiseBurst(out, t, 0.9, 'bandpass', 600, 1.2, 0.8 * g, 2400);
        this.tone(out, t, 'sine', 90, 40, 0.25, 0.7 * g);
        break;
      default:
        break;
    }
  }

  explosion(x: number, y: number, z: number, radius: number): void {
    if (!this.ready()) return;
    const s = this.spatial(x, y, z, 30, 700);
    if (!s) return;
    if (s.dist <= EXPLOSION_DUCK_RANGE) {
      this.explosionDist = Math.min(this.explosionTimer > 0 ? this.explosionDist : Infinity, s.dist);
      this.explosionTimer = EXPLOSION_HOLD;
    }
    const out = this.out(s.pan, s.cutoff);
    // Far blasts arrive late: sound covers 343 m/s.
    const delay = s.dist > 80 ? Math.min(0.8, s.dist / 343) : 0;
    const t = this.ctx!.currentTime + 0.01 + delay;
    const k = clamp(radius / 7.5, 0.5, 1.4) * s.gain;
    this.noiseBurst(out, t, 1.6, 'lowpass', 2200, 0.5, 1.4 * k, 120);
    this.noiseBurst(out, t, 0.25, 'highpass', 1500, 0.5, 0.6 * k);
    this.tone(out, t, 'sine', 70, 28, 1.2, 1.2 * k, 0.005);
  }

  /** A collision at (x, y, z); `own` is one of the player's car, which plays on the vehicle bus. */
  impact(x: number, y: number, z: number, strength: number, own = false): void {
    if (!this.ready() || strength < 2.2) return;
    const s = this.spatial(x, y, z, 12, 160);
    if (!s) return;
    const out = this.out(s.pan, s.cutoff, own ? this.vehicleBus : this.sfx);
    const t = this.ctx!.currentTime + 0.005;
    const k = clamp(strength / 14, 0.15, 1) * s.gain;
    this.noiseBurst(out, t, 0.18 + k * 0.25, 'bandpass', 700 + Math.random() * 400, 0.9, 1.1 * k, 200);
    if (strength > 8) this.tone(out, t, 'triangle', 900 + Math.random() * 500, 300, 0.25, 0.25 * k);
  }

  /**
   * Metal grinding along a wall or another car at (x, y, z), sliding at `speed` (m/s): a short band-passed noise burst
   * whose loudness and pitch rise with the speed, and a faint metallic ring over it. The sim reports a grinding vehicle
   * up to 15 times a second, so a long scrape is a run of overlapping bursts. `own`: the player's car (vehicle bus).
   */
  scrape(x: number, y: number, z: number, speed: number, own = false): void {
    if (!this.ready() || !(speed > 0)) return;
    const s = this.spatial(x, y, z, 10, 120);
    if (!s) return;
    const out = this.out(s.pan, s.cutoff, own ? this.vehicleBus : this.sfx);
    const t = this.ctx!.currentTime + 0.003;
    // Scrapes start at 4 m/s: quiet and low there, full and bright from 20 m/s.
    const k = clamp((speed - 2) / 18, 0.15, 1) * s.gain;
    const hz = 800 + 85 * Math.min(speed, 36);
    this.noiseBurst(out, t, 0.11, 'bandpass', hz * (0.9 + Math.random() * 0.2), 3, 0.55 * k, hz * 0.75);
    this.tone(out, t, 'triangle', hz * 2.1, hz * 1.8, 0.08, 0.05 * k);
    this.counters.scrapes++;
  }

  punch(x: number, y: number, z: number, hit: boolean): void {
    if (!this.ready()) return;
    const s = this.spatial(x, y, z, 6, 50);
    if (!s) return;
    const out = this.out(s.pan, s.cutoff);
    const t = this.ctx!.currentTime;
    if (hit) {
      this.tone(out, t, 'sine', 140, 55, 0.12, 0.9 * s.gain);
      this.noiseBurst(out, t, 0.07, 'lowpass', 1800, 0.6, 0.6 * s.gain);
    } else {
      this.noiseBurst(out, t, 0.12, 'bandpass', 900, 0.8, 0.25 * s.gain, 2400);
    }
  }

  /** An AI driver's horn tap (the player's own horn is the continuous voice in updateHorn). */
  horn(x: number, y: number, z: number, police: boolean): void {
    if (!this.ready() || police) return;
    const s = this.spatial(x, y, z, 14, 140);
    if (!s) return;
    const ctx = this.ctx!;
    const out = this.out(s.pan, s.cutoff);
    const t = ctx.currentTime;
    for (const f of DEFAULT_HORN) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 1800;
      const g = this.envGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18 * s.gain, t + 0.02);
      g.gain.setValueAtTime(0.18 * s.gain, t + 0.38);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      g.gain.linearRampToValueAtTime(0, t + 0.47);
      o.connect(filt);
      filt.connect(g);
      g.connect(out);
      o.start(t + this.sample);
      o.stop(t + 0.5);
    }
  }

  splash(x: number, y: number, z: number, big: boolean): void {
    if (!this.ready()) return;
    const s = this.spatial(x, y, z, 12, 140);
    if (!s) return;
    this.noiseBurst(this.out(s.pan, s.cutoff), this.ctx!.currentTime, big ? 1.1 : 0.5, 'lowpass', 1800, 0.5, (big ? 1 : 0.5) * s.gain, 300);
  }

  thud(k: number): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(this.sfx, t, 0.2, 'lowpass', 900, 0.6, 0.4 * k, 200);
  }

  scream(x: number, y: number, z: number): void {
    if (!this.ready()) return;
    const s = this.spatial(x, y, z, 8, 70);
    if (!s) return;
    const ctx = this.ctx!;
    const out = this.out(s.pan, s.cutoff);
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const base = 520 + Math.random() * 300;
    o.frequency.setValueAtTime(base, t);
    o.frequency.linearRampToValueAtTime(base * 1.35, t + 0.15);
    o.frequency.linearRampToValueAtTime(base * 0.8, t + 0.6);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1400;
    f.Q.value = 3;
    const g = this.envGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(SCREAM_LEVEL * s.gain, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
    g.gain.linearRampToValueAtTime(0, t + 0.67);
    o.connect(f);
    f.connect(g);
    g.connect(out);
    o.start(t + this.sample);
    o.stop(t + 0.7);
  }

  /**
   * Confirms a hit by the player on the UI bus with a 2.2 kHz tick.
   * A kill adds a 90 Hz thump, a headshot a 3-5 kHz crack.
   */
  hitConfirm(kind: HitConfirm): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime + 0.005;
    const d = this.uiBus;
    this.tone(d, t, 'square', 2200, 2150, 0.025, 0.07, 0.001);
    if (kind === 'kill') this.tone(d, t, 'sine', 90, 55, 0.12, 0.5, 0.004);
    else if (kind === 'head') this.noiseBurst(d, t, 0.04, 'bandpass', 4000, 2, 0.35);
  }

  reloadClick(): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(this.sfx, t, 0.04, 'highpass', 3000, 1, 0.3);
    this.noiseBurst(this.sfx, t + 0.25, 0.05, 'highpass', 2500, 1, 0.35);
  }

  /** The player's car door shutting as they get in or out. */
  doorThunk(v: Vehicle): void {
    if (!this.ready() || v.destroyed || v.inWater) return;
    // The driver's door is on the vehicle's left (local +X).
    const x = v.pos.x + Math.cos(v.heading) * v.halfW;
    const z = v.pos.z - Math.sin(v.heading) * v.halfW;
    const s = this.spatial(x, v.pos.y + 0.8, z, 6, 60);
    if (!s) return;
    const out = this.out(s.pan, s.cutoff);
    const t = this.ctx!.currentTime + 0.005;
    this.tone(out, t, 'sine', 120, 52, 0.16, 0.55 * s.gain, 0.004);
    this.noiseBurst(out, t, 0.08, 'lowpass', 1000, 0.7, 0.45 * s.gain, 250);
    // The latch.
    this.noiseBurst(out, t + 0.012, 0.025, 'bandpass', 2600, 1.4, 0.14 * s.gain);
    this.counters.doorThunks++;
  }

  chime(kind: 'pickup' | 'cash' | 'passed' | 'fail' | 'alert' | 'stunt' | 'ui' | 'countdown' | 'go' | 'checkpoint'): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime + 0.01;
    // HUD stings are not in the world: no in-car muffling, and the result-card duck leaves them on top.
    const d = this.uiBus;
    const seq = (notes: number[], step: number, type: OscillatorType, len: number, gain: number) =>
      notes.forEach((n, i) => this.tone(d, t + i * step, type, n, n * 0.999, len, gain, 0.01));
    switch (kind) {
      case 'countdown':
        seq([440], 0, 'sine', 0.15, 0.2);
        break;
      case 'go':
        seq([880, 1320], 0.06, 'triangle', 0.35, 0.22);
        break;
      case 'checkpoint':
        seq([660, 990], 0.045, 'sine', 0.16, 0.18);
        break;
      case 'pickup':
        seq([660, 880, 1320], 0.06, 'triangle', 0.18, 0.25);
        break;
      case 'cash':
        seq([1568, 2093], 0.07, 'square', 0.12, 0.08);
        break;
      case 'passed':
        seq([523, 659, 784, 1047], 0.12, 'triangle', 0.5, 0.25);
        seq([262, 330, 392], 0, 'sawtooth', 1.4, 0.05);
        break;
      case 'fail':
        seq([392, 311, 233], 0.22, 'sawtooth', 0.5, 0.09);
        break;
      case 'alert':
        seq([880, 660], 0.1, 'square', 0.12, 0.06);
        break;
      case 'stunt':
        seq([523, 784, 1047, 1568], 0.07, 'triangle', 0.3, 0.2);
        break;
      case 'ui':
        seq([1200], 0, 'sine', 0.05, 0.12);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Continuous voices: the player's horn and the police siren (the engine is engineVoice.ts).

  private buildHorn(): void {
    const ctx = this.ctx!;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'square';
    osc2.type = 'square';
    osc1.frequency.value = DEFAULT_HORN[0];
    osc2.frequency.value = DEFAULT_HORN[1];
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 1800;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc1.connect(filt);
    osc2.connect(filt);
    filt.connect(gain);
    gain.connect(this.vehicleBus);
    osc1.start();
    osc2.start();
    this.hornNodes = { osc1, osc2, gain };
  }

  private buildSiren(): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = SIREN_HZ;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.32;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = SIREN_SWEEP;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(this.sfx);
    osc.start();
    lfo.start();
    this.sirenNodes = { osc, gain, lfo, lfoGain };
  }

  update(dt: number, sim: ViewState, inGame: boolean): void {
    this.frame++;
    // One confirmation per frame, the strongest (a shotgun blast is one tick, a multi-kill one thump).
    const confirm = this.confirm;
    if (confirm !== null) {
      this.confirm = null;
      if (this.ready()) this.safely(() => this.hitConfirm(confirm));
    }
    if (!this.ready()) return;
    this.safely(() => this.updateVoices(dt, sim, inGame));
  }

  private updateVoices(dt: number, sim: ViewState, inGame: boolean): void {
    const t = this.ctx!.currentTime;
    const step = finite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    const pv = inGame ? this.me(sim).character.vehicle : null;
    // A wreck or a sinking car has no engine; the radio dies with a wreck.
    const live = pv && !pv.destroyed && !pv.inWater && !pv.removed ? pv : null;
    this.inVehicle = !!pv;
    this.engine!.update(live, t, live ? this.softGround(sim.world, live.pos.x, live.pos.z) : false);
    this.updateHorn(live, t);
    this.updateSiren(sim, inGame, t);
    this.radio.setWanted(inGame ? this.me(sim).wanted.level : 0);
    this.radio.update(dt, inGame && !!pv && !pv.destroyed);
    this.subtitleTimer = Math.max(0, this.subtitleTimer - step);
    this.bigTimer = Math.max(0, this.bigTimer - step);
    this.failTimer = Math.max(0, this.failTimer - step);
    if (this.explosionTimer > 0) {
      this.explosionTimer -= step;
      if (this.explosionTimer <= 0) this.explosionDist = Infinity;
    }
    this.updateAmbience(step, sim, inGame, t);
    // The radio is as present in the mix as the music volume lets it be heard (switched off or at 0: not at all).
    const radio = this.radio.playing ? clamp(this.volumes.music / RADIO_FULL, 0, 1) : 0;
    const m = mixTargets(
      { inVehicle: this.inVehicle, radio, subtitleActive: this.subtitleTimer > 0, explosionDist: this.explosionDist, paused: this.paused, bigScreen: this.bigTimer > 0 || this.failTimer > 0 },
      this.mix,
    );
    this.mixer!.update(m, t, this.explosionTimer > 0);
  }

  /** The player's held horn: one continuous voice at the vehicle's horn notes. */
  private updateHorn(v: Vehicle | null, t: number): void {
    const h = this.hornNodes!;
    if (v && v.kind !== this.hornKind) {
      this.hornKind = v.kind;
      const [f1, f2] = engineProfile(v.kind).horn;
      h.osc1.frequency.setValueAtTime(f1, t);
      h.osc2.frequency.setValueAtTime(f2, t);
    }
    const on = !!v && v.horn;
    // 15 ms attack, 60 ms release (three time constants each).
    this.glide.set(h.gain.gain, on ? HORN_LEVEL : 0, t, on ? 0.005 : 0.02);
  }

  /** Siren loudness from the closest police car with its siren on, its pitch shifted by their relative motion. */
  private updateSiren(sim: ViewState, inGame: boolean, t: number): void {
    const s = this.sirenNodes!;
    let best = Infinity;
    let near: Vehicle | null = null;
    if (inGame) {
      for (const u of sim.vehicles) {
        if (!u.siren || u.removed || u.destroyed) continue;
        const d = Math.hypot(u.pos.x - this.listener.x, u.pos.z - this.listener.z);
        if (d < best) {
          best = d;
          near = u;
        }
      }
    }
    const sg = best < 260 ? (1 / (1 + Math.pow(best / 35, 1.5))) * SIREN_LEVEL : 0;
    this.glide.set(s.gain.gain, sg, t, 0.2);
    let f = 1;
    if (near && sg > 0) {
      // The listener moves with the player (the camera follows him).
      const me = this.me(sim).character;
      const lv = me.vehicle ? me.vehicle.vel : me.vel;
      f = dopplerFactor(near.pos.x, near.pos.z, near.vel.x, near.vel.z, this.listener.x, this.listener.z, lv.x, lv.z);
    }
    this.sirenDoppler = f;
    this.glide.set(s.osc.frequency, SIREN_HZ * f, t, DOPPLER_TAU, 0.0005);
    this.glide.set(s.lfoGain.gain, SIREN_SWEEP * f, t, DOPPLER_TAU, 0.0005);
    this.glide.set(s.lfo.frequency, this.me(sim).wanted.level >= 3 ? 1.6 : 0.32, t, 0.3);
  }

  /** The siren voice now: its pitch before the wail (Doppler-shifted), the factor, its gain and wail rate. */
  sirenInfo(): { frequency: number; doppler: number; gain: number; wail: number } | null {
    const s = this.sirenNodes;
    if (!s) return null;
    return { frequency: s.osc.frequency.value, doppler: this.sirenDoppler, gain: s.gain.gain.value, wail: s.lfo.frequency.value };
  }

  /** Sources the new voices (talk station, barks) still have playing, per kind and in total; echo sends started. */
  liveNodes(): { live: Record<string, number>; started: Record<string, number>; total: number; echoSpaces: number } {
    return { live: { ...this.nodes.live }, started: { ...this.nodes.started }, total: this.nodes.total, echoSpaces: this.echo?.built ?? 0 };
  }

  /** Sand, grass, yards and dirt make the tyres roar louder than asphalt and paving. */
  private softGround(world: StaticWorld, x: number, z: number): boolean {
    if (!finite(x, z)) return false;
    if (x >= world.bounds.beachStartX) return true;
    if (world.isOnRoad(x, z)) return false;
    if (this.softWorld !== world) {
      this.softWorld = world;
      this.softPatches = world.layout.ground.filter((g) => g.kind === 'grass' || g.kind === 'yard' || g.kind === 'dirt').map((g) => g.rect);
    }
    for (const r of this.softPatches) if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return true;
    return false;
  }

  private updateAmbience(dt: number, sim: ViewState, inGame: boolean, t: number): void {
    const L = this.listener;
    // A broken camera pose keeps the bed as it was rather than reading NaN places.
    if (!finite(L.x, L.y, L.z, L.yaw)) return;
    const world = sim.world;
    const shore = shoreInfo(world.bounds, L.x, L.z, this.shore);
    const rx = -Math.cos(L.yaw);
    const rz = Math.sin(L.yaw);
    // Moving traffic within 120 m (in 3D: rooftops and the title flyover hear the street from afar), speed-weighted, and where it is.
    let w = 0;
    let sx = 0;
    let sz = 0;
    const own = this.me(sim).character.vehicle;
    for (const v of sim.vehicles) {
      if (v === own || v.removed || v.destroyed || !(v.speed > 1)) continue;
      const dx = v.pos.x - L.x;
      const dz = v.pos.z - L.z;
      const d = Math.hypot(dx, v.pos.y - L.y, dz);
      if (!(d < 120)) continue;
      const k = Math.min(1, v.speed / 20) * (1 - d / 120);
      const hd = Math.hypot(dx, dz) || 1;
      w += k;
      sx += (dx / hd) * k;
      sz += (dz / hd) * k;
    }
    const f = this.ambFrame;
    f.district = world.districtAt(L.x, L.z);
    f.hours = sim.clock.hours;
    f.shoreDist = shore.dist;
    f.height = inGame ? this.me(sim).character.pos.y : L.y;
    f.traffic = clamp(w / 2.5, 0, 1);
    f.inVehicle = this.inVehicle;
    f.wanted = this.me(sim).wanted.level;
    f.seaPan = shore.dirX * rx + shore.dirZ * rz;
    f.trafficPan = w > 0 ? (sx * rx + sz * rz) / w : 0;
    this.ambience!.update(dt, t, f);
  }
}
