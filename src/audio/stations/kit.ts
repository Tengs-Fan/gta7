// The radio's instruments: one-shot voices scheduled a little ahead on the station's output, with sends to the
// tempo echo and to a small comb reverb. Every voice builds its own short-lived nodes and stops them after its tail.

export function midi(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export interface SynthOpts {
  attack?: number;
  release?: number;
  /** Cents between the two detuned voices (one voice when absent). */
  detune?: number;
  /** Echo send. */
  send?: number;
  /** Reverb send. */
  verb?: number;
  /** Low-pass sweep from three times the cutoff down to it over the note's first quarter second. */
  filterEnv?: boolean;
  q?: number;
  /** A custom waveform in place of `type`. */
  wave?: PeriodicWave;
  /** No low-pass: the oscillator straight into its envelope. */
  raw?: boolean;
  /** Starts at this multiple of the pitch and slides to it over `glideTime`. */
  glide?: number;
  glideTime?: number;
  /** Bends to this multiple of the pitch over the note, after the attack. */
  bend?: number;
  /** Pitch wobble: rate (Hz) and depth (cents). */
  vibrato?: readonly [number, number];
  /** Amplitude chop at this rate (Hz), each cycle a hard attack that decays: tremolo picking. */
  tremolo?: number;
}

export interface HitOpts {
  q?: number;
  verb?: number;
  attack?: number;
  /** The filter sweeps from `freq` to this over the hit. */
  sweepTo?: number;
}

export class Kit {
  private readonly pulses = new Map<number, PeriodicWave>();

  constructor(
    readonly ctx: AudioContext,
    private readonly out: AudioNode,
    private readonly noise: AudioBuffer,
    private readonly echo: AudioNode,
    private readonly verb: AudioNode,
  ) {}

  /** One sample: notes start this long after their envelope's first event. */
  private get sample(): number {
    return 1 / this.ctx.sampleRate;
  }

  /** Envelope on a fresh gain: silent from creation (notes are scheduled ahead) until `t`. */
  env(g: GainNode, t: number, peak: number, attack: number, hold: number, release: number): void {
    g.gain.value = 0;
    // After a stalled frame a note can be due a little in the past: the zero must not land after it starts.
    g.gain.setValueAtTime(0, Math.min(this.ctx.currentTime, t));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    g.gain.linearRampToValueAtTime(0, t + attack + hold + release + 0.01);
  }

  /** Once `src` has played, cuts `out` loose so the voice's nodes stop rendering and can be collected. */
  private free(src: AudioScheduledSourceNode, out: AudioNode): void {
    src.onended = () => out.disconnect();
  }

  /** `node` into the echo and the reverb at these levels. */
  private sends(node: AudioNode, echo = 0, verb = 0): void {
    if (echo > 0) {
      const s = this.ctx.createGain();
      s.gain.value = echo;
      node.connect(s);
      s.connect(this.echo);
    }
    if (verb > 0) {
      const s = this.ctx.createGain();
      s.gain.value = verb;
      node.connect(s);
      s.connect(this.verb);
    }
  }

  /** A pulse wave of this duty cycle (0.125, 0.25, 0.5), built once. */
  pulse(duty: number): PeriodicWave {
    let w = this.pulses.get(duty);
    if (!w) {
      const n = 32;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let h = 1; h < n; h++) {
        real[h] = Math.sin(2 * Math.PI * h * duty) / (Math.PI * h);
        imag[h] = (1 - Math.cos(2 * Math.PI * h * duty)) / (Math.PI * h);
      }
      w = this.ctx.createPeriodicWave(real, imag);
      this.pulses.set(duty, w);
    }
    return w;
  }

  kick(t: number, k = 1, from = 150, to = 44, decay = 0.3): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + 0.12);
    const g = ctx.createGain();
    this.env(g, t, 0.85 * k, 0.003, 0.02, decay);
    o.connect(g);
    g.connect(this.out);
    this.free(o, g);
    o.start(t + this.sample);
    o.stop(t + decay + 0.1);
  }

  noiseHit(t: number, type: BiquadFilterType, freq: number, dur: number, gain: number, send = 0, o: HitOpts = {}): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    if (o.sweepTo) {
      f.frequency.setValueAtTime(freq, t);
      f.frequency.exponentialRampToValueAtTime(o.sweepTo, t + (o.attack ?? 0) + dur);
    } else f.frequency.value = freq;
    if (o.q) f.Q.value = o.q;
    const g = ctx.createGain();
    this.env(g, t, gain, o.attack ?? 0.002, 0.005, dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.out);
    this.sends(g, send, o.verb);
    this.free(src, g);
    src.start(t + this.sample, Math.random() * 1.5);
    src.stop(t + (o.attack ?? 0) + dur + 0.05);
  }

  snare(t: number, big: boolean, k = 1, verb = 0): void {
    this.noiseHit(t, 'bandpass', 1900, big ? 0.22 : 0.15, 0.42 * k, big ? 0.6 : 0, { verb });
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(200, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.08);
    const g = ctx.createGain();
    this.env(g, t, 0.25 * k, 0.002, 0.01, 0.1);
    o.connect(g);
    g.connect(this.out);
    this.free(o, g);
    o.start(t + this.sample);
    o.stop(t + 0.2);
  }

  clap(t: number, k = 1): void {
    for (let i = 0; i < 3; i++) this.noiseHit(t + i * 0.011, 'bandpass', 1300, 0.12, 0.28 * k, i === 2 ? 0.4 : 0);
  }

  hat(t: number, open: boolean, gain = 0.13): void {
    this.noiseHit(t, 'highpass', 7500, open ? 0.22 : 0.035, gain);
  }

  /** A rimshot or cross-stick click. */
  rim(t: number, gain = 0.2, send = 0, verb = 0): void {
    this.noiseHit(t, 'bandpass', 2600, 0.035, gain, send, { q: 4, verb });
  }

  /** A tuned drum: a sine that drops a fifth onto `freq`. */
  tom(t: number, freq: number, gain = 0.45, verb = 0.15): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(freq * 1.5, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.06);
    const g = ctx.createGain();
    this.env(g, t, gain, 0.002, 0.03, 0.32);
    o.connect(g);
    g.connect(this.out);
    this.sends(g, 0, verb);
    this.free(o, g);
    o.start(t + this.sample);
    o.stop(t + 0.45);
  }

  crash(t: number, gain = 0.12): void {
    this.noiseHit(t, 'highpass', 4800, 1.4, gain, 0, { verb: 0.3 });
  }

  ride(t: number, gain = 0.07): void {
    this.noiseHit(t, 'bandpass', 6800, 0.32, gain, 0, { q: 1.4 });
  }

  /** A brush stroke or shaker: noise swelling in over `attack`. */
  brush(t: number, dur: number, gain: number, attack = 0.04, freq = 4200): void {
    this.noiseHit(t, 'bandpass', freq, dur, gain, 0, { q: 0.8, attack });
  }

  synth(t: number, freq: number, dur: number, type: OscillatorType, gain: number, cutoff: number, opts: SynthOpts = {}): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const attack = opts.attack ?? 0.005;
    const release = opts.release ?? 0.08;
    const end = t + dur + release + 0.05;
    this.env(g, t, gain, attack, Math.max(0, dur - attack), release);
    let into: AudioNode = g;
    if (!opts.raw) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = opts.q ?? 1.5;
      if (opts.filterEnv) {
        f.frequency.setValueAtTime(cutoff * 3, t);
        f.frequency.exponentialRampToValueAtTime(cutoff, t + Math.min(dur, 0.25));
      } else f.frequency.value = cutoff;
      f.connect(g);
      into = f;
    }
    let tail: AudioNode = g;
    if (opts.tremolo) {
      // Each cycle of an inverted saw is a pick: full level at once, then falling away.
      const chop = ctx.createGain();
      chop.gain.value = 0.55;
      const lfo = ctx.createOscillator();
      lfo.type = 'sawtooth';
      lfo.frequency.value = opts.tremolo;
      const depth = ctx.createGain();
      depth.gain.value = -0.45;
      lfo.connect(depth);
      depth.connect(chop.gain);
      g.connect(chop);
      tail = chop;
      lfo.start(t + this.sample);
      lfo.stop(end);
    }
    tail.connect(this.out);
    this.sends(tail, opts.send, opts.verb);
    let wobble: GainNode | null = null;
    if (opts.vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = opts.vibrato[0];
      wobble = ctx.createGain();
      wobble.gain.value = opts.vibrato[1];
      lfo.connect(wobble);
      lfo.start(t + this.sample);
      lfo.stop(end);
    }
    const voices = opts.detune ? [-opts.detune, opts.detune] : [0];
    for (const d of voices) {
      const o = ctx.createOscillator();
      if (opts.wave) o.setPeriodicWave(opts.wave);
      else o.type = type;
      if (opts.glide) {
        o.frequency.setValueAtTime(freq * opts.glide, t);
        o.frequency.exponentialRampToValueAtTime(freq, t + (opts.glideTime ?? 0.08));
      } else o.frequency.value = freq;
      if (opts.bend) {
        o.frequency.setValueAtTime(freq, t + attack);
        o.frequency.exponentialRampToValueAtTime(freq * opts.bend, t + Math.max(attack + 0.02, dur));
      }
      o.detune.value = d;
      if (wobble) wobble.connect(o.detune);
      o.connect(into);
      this.free(o, tail);
      o.start(t + this.sample);
      o.stop(end);
    }
  }

  /** A plucked string: bright at the pick, darkening fast. */
  pluck(t: number, freq: number, dur: number, gain: number, bright = 3000, opts: SynthOpts = {}): void {
    this.synth(t, freq, dur, 'sawtooth', gain, bright / 3, { filterEnv: true, release: 0.18, q: 0.9, ...opts });
  }

  /** An electric piano: a sine carrier rung by a sine at the same pitch whose depth dies away (two-operator FM). */
  epiano(t: number, freq: number, dur: number, gain: number, verb = 0.2): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    this.env(g, t, gain, 0.004, Math.max(0, dur * 0.3), dur * 0.7 + 0.4);
    const car = ctx.createOscillator();
    car.frequency.value = freq;
    const mod = ctx.createOscillator();
    mod.frequency.value = freq;
    const index = ctx.createGain();
    index.gain.setValueAtTime(freq * 1.8, t);
    index.gain.exponentialRampToValueAtTime(freq * 0.25, t + 0.6);
    mod.connect(index);
    index.connect(car.frequency);
    car.connect(g);
    g.connect(this.out);
    this.sends(g, 0, verb);
    const end = t + dur + 0.5;
    this.free(car, g);
    car.start(t + this.sample);
    mod.start(t + this.sample);
    car.stop(end);
    mod.stop(end);
  }

  /** A strummed chord: the strings in turn, `spread` seconds apart, low to high (high to low on an upstroke). */
  strum(t: number, freqs: readonly number[], dur: number, gain: number, up = false, spread = 0.012, opts: SynthOpts = {}): void {
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[up ? freqs.length - 1 - i : i]!;
      this.pluck(t + i * spread, f, dur, gain, 3400, opts);
    }
  }
}
