// Synthesised sound effects, engine and siren. Everything is generated with
// WebAudio nodes; there are no audio files.

import { clamp } from '../core/math';
import type { Character } from '../sim/entities';
import type { SimEvents } from '../sim/events';
import type { Sim } from '../sim/sim';
import type { WeaponId } from '../sim/specs';
import { Radio } from './radio';

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

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  /** Pause mute for world sound, a stage of its own so volume changes can't undo it. */
  private pauseGain!: GainNode;
  private paused = false;
  private sfx!: GainNode;
  /** Menu clicks: bypass the pause stage, so menus over a paused game still give feedback. */
  private uiBus!: GainNode;
  private musicBus!: GainNode;
  private noise!: AudioBuffer;
  private engineNodes: { osc1: OscillatorNode; osc2: OscillatorNode; filter: BiquadFilterNode; gain: GainNode; skid: GainNode; skidSrc: AudioBufferSourceNode } | null = null;
  private sirenNodes: { osc: OscillatorNode; gain: GainNode; lfo: OscillatorNode; lfoGain: GainNode } | null = null;
  readonly radio = new Radio();
  private readonly listener: Listener = { x: 0, y: 0, z: 0, yaw: 0 };
  private unsub: Array<() => void> = [];
  private volumes = { master: 0.8, music: 0.6, sfx: 0.85 };
  private lastShot = new Map<WeaponId, number>();
  /** The player's hits this frame, the strongest per victim; played (once each) by update(). */
  private readonly confirms = new Map<Character, HitConfirm>();
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
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 6;
        this.master = ctx.createGain();
        this.pauseGain = ctx.createGain();
        this.pauseGain.gain.value = this.paused ? 0 : 1;
        this.sfx = ctx.createGain();
        this.uiBus = ctx.createGain();
        this.musicBus = ctx.createGain();
        this.sfx.connect(this.pauseGain);
        this.musicBus.connect(this.pauseGain);
        this.pauseGain.connect(this.master);
        this.uiBus.connect(this.master);
        this.master.connect(comp);
        comp.connect(ctx.destination);
        const len = ctx.sampleRate * 2;
        this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.radio.init(ctx, this.musicBus, this.noise);
        this.applyVolumes();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    } catch {
      this.failed = true;
      this.ctx = null;
    }
  }

  setVolumes(master: number, music: number, sfx: number): void {
    const v = this.volumes;
    const vol = (x: number, old: number) => (Number.isFinite(x) ? clamp(x, 0, 1) : old);
    this.volumes = { master: vol(master, v.master), music: vol(music, v.music), sfx: vol(sfx, v.sfx) };
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    this.master.gain.value = this.volumes.master;
    this.sfx.gain.value = this.volumes.sfx;
    this.uiBus.gain.value = this.volumes.sfx;
    this.musicBus.gain.value = this.volumes.music * 0.8;
  }

  /** Mutes the world (effects, engine, siren, radio) under the pause menu, map, shop or crash screen without stopping the radio clock. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    // Remembered even without a context yet, so unlock() starts in the right state.
    this.paused = paused;
    this.radio.setPaused(paused);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.pauseGain.gain.cancelScheduledValues(t);
    this.pauseGain.gain.setTargetAtTime(paused ? 0 : 1, t, 0.05);
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

  attach(sim: Sim): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    // Sound handlers run inside sim.update(): isolate them from it.
    const on = <K extends keyof SimEvents>(type: K, fn: (e: SimEvents[K]) => void) => sim.events.on(type, (e) => this.safely(() => fn(e)));
    this.confirms.clear();
    this.unsub.push(
      // One bang per trigger pull; helicopter rounds come only as 'shot' events.
      on('weaponFired', (e) => this.gunshot(e.weapon, e.x, e.y, e.z, e.shooter?.isPlayer ?? false)),
      on('shot', (e) => {
        if (!e.shooter) this.gunshot(e.weapon, e.fx, e.fy, e.fz, false);
      }),
      on('damage', (e) => {
        if (!e.attacker?.isPlayer || e.victim.isPlayer) return;
        const kind: HitConfirm = e.killed ? 'kill' : e.zone === 'head' ? 'head' : 'hit';
        const prev = this.confirms.get(e.victim);
        if (prev === undefined || CONFIRM_RANK[kind] > CONFIRM_RANK[prev]) this.confirms.set(e.victim, kind);
      }),
      on('explosion', (e) => this.explosion(e.x, e.y, e.z, e.radius)),
      on('impact', (e) => this.impact(e.x, e.y, e.z, e.strength)),
      on('melee', (e) => this.punch(e.x, e.y, e.z, e.hit)),
      on('horn', (e) => this.horn(e.vehicle.pos.x, e.vehicle.pos.y, e.vehicle.pos.z, e.vehicle.spec.police)),
      on('pickup', (e) => this.chime(e.kind === 'money' ? 'cash' : 'pickup')),
      on('money', (e) => {
        if (e.amount >= 500) this.chime('cash');
      }),
      on('splash', (e) => this.splash(e.x, e.y, e.z, e.big)),
      on('propBroken', () => this.thud(0.5)),
      on('reload', (e) => {
        if (e.character.isPlayer) this.reloadClick();
      }),
      on('wanted', (e) => {
        if (e.level > e.previous) this.chime('alert');
      }),
      on('big', (e) => {
        if (e.style === 'passed') this.chime('passed');
        else if (e.style === 'failed' || e.style === 'wasted' || e.style === 'busted') this.chime('fail');
        else if (e.style === 'stunt') this.chime('stunt');
      }),
      on('scream', (e) => this.scream(e.x, e.y, e.z)),
    );
  }

  setListener(x: number, y: number, z: number, yaw: number): void {
    this.listener.x = x;
    this.listener.y = y;
    this.listener.z = z;
    this.listener.yaw = yaw;
  }

  /** Gain and pan for a sound at (x, y, z). Returns null when inaudible. */
  private spatial(x: number, y: number, z: number, ref: number, max: number): { gain: number; pan: number } | null {
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
    return finite(pan) ? { gain, pan } : null;
  }

  private out(pan: number): AudioNode {
    const ctx = this.ctx!;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(this.sfx);
      return p;
    }
    return this.sfx;
  }

  private noiseBurst(dest: AudioNode, t: number, dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, freqEnd?: number): void {
    if (!finite(t, dur, freq, q, gain, freqEnd ?? freq)) return;
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
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 1.5);
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
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  gunshot(w: WeaponId, x: number, y: number, z: number, player: boolean): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    // Rate-limit overlapping shots of the same weapon (SMG crowds).
    const now = ctx.currentTime;
    if (!player && now - (this.lastShot.get(w) ?? 0) < 0.04) return;
    this.lastShot.set(w, now);
    const s = this.spatial(x, y, z, 14, 260);
    if (!s) return;
    const out = this.out(s.pan);
    const g = s.gain * (player ? 1 : 0.8);
    const t = now + 0.005;
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
    const out = this.out(s.pan);
    const t = this.ctx!.currentTime + 0.01;
    const k = clamp(radius / 7.5, 0.5, 1.4) * s.gain;
    this.noiseBurst(out, t, 1.6, 'lowpass', 2200, 0.5, 1.4 * k, 120);
    this.noiseBurst(out, t, 0.25, 'highpass', 1500, 0.5, 0.6 * k);
    this.tone(out, t, 'sine', 70, 28, 1.2, 1.2 * k, 0.005);
  }

  impact(x: number, y: number, z: number, strength: number): void {
    if (!this.ready() || strength < 2.2) return;
    const s = this.spatial(x, y, z, 12, 160);
    if (!s) return;
    const out = this.out(s.pan);
    const t = this.ctx!.currentTime + 0.005;
    const k = clamp(strength / 14, 0.15, 1) * s.gain;
    this.noiseBurst(out, t, 0.18 + k * 0.25, 'bandpass', 700 + Math.random() * 400, 0.9, 1.1 * k, 200);
    if (strength > 8) this.tone(out, t, 'triangle', 900 + Math.random() * 500, 300, 0.25, 0.25 * k);
  }

  punch(x: number, y: number, z: number, hit: boolean): void {
    if (!this.ready()) return;
    const s = this.spatial(x, y, z, 6, 50);
    if (!s) return;
    const out = this.out(s.pan);
    const t = this.ctx!.currentTime;
    if (hit) {
      this.tone(out, t, 'sine', 140, 55, 0.12, 0.9 * s.gain);
      this.noiseBurst(out, t, 0.07, 'lowpass', 1800, 0.6, 0.6 * s.gain);
    } else {
      this.noiseBurst(out, t, 0.12, 'bandpass', 900, 0.8, 0.25 * s.gain, 2400);
    }
  }

  horn(x: number, y: number, z: number, police: boolean): void {
    if (!this.ready() || police) return;
    const s = this.spatial(x, y, z, 14, 140);
    if (!s) return;
    const out = this.out(s.pan);
    const t = this.ctx!.currentTime;
    for (const f of [392, 494]) {
      const o = this.ctx!.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const filt = this.ctx!.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 1800;
      const g = this.ctx!.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18 * s.gain, t + 0.02);
      g.gain.setValueAtTime(0.18 * s.gain, t + 0.38);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      o.connect(filt);
      filt.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + 0.5);
    }
  }

  splash(x: number, y: number, z: number, big: boolean): void {
    if (!this.ready()) return;
    const s = this.spatial(x, y, z, 12, 140);
    if (!s) return;
    this.noiseBurst(this.out(s.pan), this.ctx!.currentTime, big ? 1.1 : 0.5, 'lowpass', 1800, 0.5, (big ? 1 : 0.5) * s.gain, 300);
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
    const out = this.out(s.pan);
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
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12 * s.gain, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
    o.connect(f);
    f.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + 0.7);
  }

  /**
   * Confirms a hit by the player, on the UI bus: a 2.2 kHz tick; a kill adds a 90 Hz thump and a
   * headshot a 3-5 kHz crack.
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

  chime(kind: 'pickup' | 'cash' | 'passed' | 'fail' | 'alert' | 'stunt' | 'ui'): void {
    if (!this.ready()) return;
    const t = this.ctx!.currentTime + 0.01;
    const d = kind === 'ui' ? this.uiBus : this.sfx;
    const seq = (notes: number[], step: number, type: OscillatorType, len: number, gain: number) =>
      notes.forEach((n, i) => this.tone(d, t + i * step, type, n, n * 0.999, len, gain, 0.01));
    switch (kind) {
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
  // Continuous voices: player engine and police siren.

  private ensureEngine(): void {
    if (this.engineNodes || !this.ctx) return;
    const ctx = this.ctx;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc2.type = 'square';
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfx);
    const skidSrc = ctx.createBufferSource();
    skidSrc.buffer = this.noise;
    skidSrc.loop = true;
    const skidF = ctx.createBiquadFilter();
    skidF.type = 'bandpass';
    skidF.frequency.value = 1500;
    skidF.Q.value = 4;
    const skid = ctx.createGain();
    skid.gain.value = 0;
    skidSrc.connect(skidF);
    skidF.connect(skid);
    skid.connect(this.sfx);
    osc1.start();
    osc2.start();
    skidSrc.start();
    this.engineNodes = { osc1, osc2, filter, gain, skid, skidSrc };
  }

  private ensureSiren(): void {
    if (this.sirenNodes || !this.ctx) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 950;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.32;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 380;
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

  update(dt: number, sim: Sim, inGame: boolean): void {
    // At most one confirmation per victim per frame (a shotgun blast is one tick), the strongest one.
    if (this.confirms.size > 0) {
      if (this.ready()) for (const kind of this.confirms.values()) this.safely(() => this.hitConfirm(kind));
      this.confirms.clear();
    }
    if (!this.ready()) return;
    this.safely(() => this.updateVoices(dt, sim, inGame));
  }

  private updateVoices(dt: number, sim: Sim, inGame: boolean): void {
    const t = this.ctx!.currentTime;
    this.ensureEngine();
    this.ensureSiren();
    const v = inGame ? sim.player.vehicle : null;
    const e = this.engineNodes!;
    if (v && !v.destroyed && !v.inWater) {
      // A numeric blow-up the sim repairs can leave rpm / throttle NaN for a while.
      const rpm = finite(v.rpm) ? clamp(v.rpm, 0, 1.1) : 0;
      const throttle = finite(v.controls.throttle) ? clamp(v.controls.throttle, 0, 1) : 0;
      const base = v.spec.kind === 'bus' || v.spec.kind === 'van' || v.spec.kind === 'swat' ? 32 : v.spec.kind === 'sports' ? 55 : 42;
      const f = base + rpm * base * 3.2;
      e.osc1.frequency.setTargetAtTime(f, t, 0.05);
      e.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
      e.filter.frequency.setTargetAtTime(380 + rpm * 2200, t, 0.08);
      e.gain.gain.setTargetAtTime(0.06 + throttle * 0.07 + rpm * 0.03, t, 0.08);
      e.skid.gain.setTargetAtTime(v.skid > 0.3 && !v.airborne ? clamp(v.skid, 0, 1) * 0.22 : 0, t, 0.05);
    } else {
      e.gain.gain.setTargetAtTime(0, t, 0.1);
      e.skid.gain.setTargetAtTime(0, t, 0.05);
    }
    // Siren: loudness from the closest police car with its siren on.
    const s = this.sirenNodes!;
    let best = Infinity;
    if (inGame) {
      for (const u of sim.vehicles) {
        if (!u.siren || u.removed || u.destroyed) continue;
        const d = Math.hypot(u.pos.x - this.listener.x, u.pos.z - this.listener.z);
        if (d < best) best = d;
      }
    }
    const sg = best < 260 ? (1 / (1 + Math.pow(best / 35, 1.5))) * 0.16 : 0;
    s.gain.gain.setTargetAtTime(sg, t, 0.2);
    s.lfo.frequency.setTargetAtTime(sim.wanted.level >= 3 ? 1.6 : 0.32, t, 0.3);
    this.radio.update(dt, inGame && !!v && !v.destroyed);
  }
}
