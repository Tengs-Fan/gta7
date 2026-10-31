// Round 2, fix pass 4 (input cluster): FIXMYRIDE typed in a burning taxi or vigilante car keeps the job, the page
// under the error screen cannot be reached with Tab, and a tutorial hint whose situation ends before half its time is
// not marked read.
// Node has no DOM or Web Audio: the browser pieces run against the small fakes below (copied from
// r2_fix3_input.test.ts, whose fakes follow fix_frontend.test.ts), and the WebGL renderer is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../src/game';
import { loadSettings } from '../../src/settings';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { makeSim, placeInCar, step } from './helpers';

vi.mock('../../src/render/renderer', async () => {
  const { CameraController: Cam } = await import('../../src/render/camera');
  class GameRenderer {
    readonly cameraCtl = new Cam(16 / 9);
    currentQuality = 'high';
    readonly crowd = { hiddenId: -1 };
    readonly props = { restoreAll: () => undefined };
    time = 0;
    setQuality(q: string): void {
      this.currentQuality = q;
    }
    setFov(): void {}
    attach(): void {}
    render(): void {}
    resize(): void {}
  }
  return { GameRenderer };
});

// ---------------------------------------------------------------------------
// Fake DOM

const later = (fn: () => void) => queueMicrotask(fn);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

class FakeClassList {
  private readonly set = new Set<string>();
  add(...cs: string[]): void {
    for (const c of cs) this.set.add(c);
  }
  remove(...cs: string[]): void {
    for (const c of cs) this.set.delete(c);
  }
  toggle(c: string, force?: boolean): boolean {
    const on = force ?? !this.set.has(c);
    if (on) this.set.add(c);
    else this.set.delete(c);
    return on;
  }
  contains(c: string): boolean {
    return this.set.has(c);
  }
  get value(): string {
    return [...this.set].join(' ');
  }
  set value(v: string) {
    this.set.clear();
    for (const c of v.split(/\s+/)) if (c) this.set.add(c);
  }
}

/** A 2D context that accepts any drawing call. */
const ctx2d: unknown = new Proxy({} as Record<string | symbol, unknown>, {
  get: (t, k) => (k in t ? t[k] : () => ({ addColorStop: () => undefined, width: 0 })),
  set: (t, k, v) => {
    t[k] = v;
    return true;
  },
});

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta']);

/** A WebGL 2 context for the GPU probe: every extension present, an unnamed GPU. */
const FAKE_GL2: unknown = { RENDERER: 0x1f01, getExtension: () => ({ loseContext: () => undefined }), getParameter: () => '' };

class FakeElement extends EventTarget {
  readonly tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = Object.defineProperty({}, 'setProperty', { value: () => undefined, writable: true });
  readonly attrs: Record<string, string> = {};
  disabled = false;
  checked = false;
  selected = false;
  value = '';
  type = '';
  min = '';
  max = '';
  step = '';
  width = 300;
  height = 150;
  clientWidth = 0;
  clientHeight = 0;
  offsetWidth = 0;
  hidden = false;
  /** As in a browser: an inert element and everything inside it can be neither focused nor clicked. */
  inert = false;
  /** Only an element given a tab index of 0 or more (the canvas in index.html) is a Tab stop besides the form controls. */
  tabIndex = -1;
  private text = '';
  private html = '';

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get className(): string {
    return this.classList.value;
  }
  set className(v: string) {
    this.classList.value = v;
  }
  get textContent(): string {
    return this.text || this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(v: string) {
    this.html = v;
    this.text = v.replace(/<[^>]*>/g, '');
    this.children = [];
    parseInto(this, v);
  }
  appendChild<T extends FakeElement>(c: T): T {
    c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: FakeElement[]): void {
    for (const c of cs) this.appendChild(c);
  }
  remove(): void {
    const p = this.parent;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parent = null;
  }
  /** All descendants, depth first. */
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(sel: string): FakeElement[] {
    return this.all().filter((e) => (sel === '[data-el]' ? 'el' in e.dataset : e.tagName === sel.toUpperCase()));
  }
  getContext(kind?: string): unknown {
    return kind === 'webgl2' ? FAKE_GL2 : ctx2d;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.width, height: this.height };
  }
  click(): void {
    if (!this.disabled) this.dispatchEvent(new Event('click'));
  }
  /** Moves the document's focus here, with the blur and focus events a browser sends. */
  focus(): void {
    const prev = dom.doc.activeElement;
    if (prev === this) return;
    dom.doc.activeElement = this;
    prev?.dispatchEvent(new Event('blur'));
    this.dispatchEvent(new Event('focus'));
  }
  select(): void {}
  setPointerCapture(): void {}
  requestPointerLock(): unknown {
    return dom.lockRequest(this);
  }
}

/** Builds child elements (tags and attributes only) for the markup the UI writes via innerHTML. */
function parseInto(root: FakeElement, html: string): void {
  const stack = [root];
  for (const [, close, tag, attrs, selfClose] of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = new FakeElement(tag!.toLowerCase());
    for (const [, k, v] of attrs!.matchAll(/([\w-]+)="([^"]*)"/g)) {
      if (k === 'class') el.className = v!;
      else if (k!.startsWith('data-')) el.dataset[k!.slice(5)] = v!;
      else if (k === 'width' || k === 'height') el[k] = Number(v);
      else el.attrs[k!] = v!;
    }
    stack[stack.length - 1]!.appendChild(el);
    if (!selfClose && !VOID_TAGS.has(tag!.toLowerCase())) stack.push(el);
  }
}

class FakeDocument extends EventTarget {
  pointerLockElement: FakeElement | null = null;
  activeElement: FakeElement | null = null;
  hidden = false;
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
  exitPointerLock(): void {
    if (!this.pointerLockElement) return;
    this.pointerLockElement = null;
    later(() => this.dispatchEvent(new Event('pointerlockchange')));
  }
}

class FakeStorage {
  private readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Fake Web Audio: every param logs the automation scheduled on it, every node records its kind.

type ParamCall = { op: 'value' | 'set' | 'linear' | 'exp' | 'target' | 'cancel'; v: number; t: number; tc?: number };

class FakeParam {
  readonly log: ParamCall[] = [];
  constructor(public target = 0) {}
  private check(...xs: number[]): void {
    for (const x of xs) if (!Number.isFinite(x)) throw new TypeError('The provided float value is non-finite.');
  }
  get value(): number {
    return this.target;
  }
  set value(v: number) {
    this.check(v);
    this.target = v;
    this.log.push({ op: 'value', v, t: NaN });
  }
  setValueAtTime(v: number, t: number): this {
    this.check(v, t);
    this.target = v;
    this.log.push({ op: 'set', v, t });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.check(v, t);
    this.target = v;
    this.log.push({ op: 'linear', v, t });
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.check(v, t);
    if (v === 0) throw new RangeError('The float target value provided (0) should not be in the range (-1.40130e-45, 1.40130e-45).');
    this.target = v;
    this.log.push({ op: 'exp', v, t });
    return this;
  }
  setTargetAtTime(v: number, t: number, tc: number): this {
    this.check(v, t, tc);
    this.target = v;
    this.log.push({ op: 'target', v, t, tc });
    return this;
  }
  cancelScheduledValues(t: number): this {
    this.check(t);
    this.log.push({ op: 'cancel', v: NaN, t });
    return this;
  }
}

class FakeNode {
  readonly outputs: unknown[] = [];
  constructor(readonly kind = 'node') {}
  connect<T>(d: T): T {
    this.outputs.push(d);
    return d;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
  constructor() {
    super('gain');
  }
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  readonly playbackRate = new FakeParam(1);
  constructor() {
    super('source');
  }
  start(t = 0, offset = 0): void {
    if (!Number.isFinite(t) || !Number.isFinite(offset)) throw new TypeError('non-finite start');
  }
  stop(t = 0): void {
    if (!Number.isFinite(t)) throw new TypeError('non-finite stop');
  }
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam(0);
  constructor() {
    super('oscillator');
  }
  setPeriodicWave(): void {
    this.type = 'custom';
  }
  start(t = 0): void {
    if (!Number.isFinite(t)) throw new TypeError('non-finite start');
  }
  stop(): void {}
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  currentTime = 1;
  state = 'running';
  readonly sampleRate = 8000;
  readonly destination = new FakeNode('destination');
  constructor() {
    FakeAudioContext.last = this;
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
  createDynamicsCompressor(): FakeNode {
    return Object.assign(new FakeNode('compressor'), { threshold: new FakeParam(-24), knee: new FakeParam(30), ratio: new FakeParam(12), attack: new FakeParam(0.003), release: new FakeParam(0.25) });
  }
  createBiquadFilter(): FakeNode {
    return Object.assign(new FakeNode('biquad'), { type: 'lowpass', frequency: new FakeParam(350), Q: new FakeParam(1), gain: new FakeParam(0) });
  }
  createOscillator(): FakeOscillator {
    return new FakeOscillator();
  }
  createBufferSource(): FakeSource {
    return new FakeSource();
  }
  createStereoPanner(): FakeNode {
    return Object.assign(new FakeNode('panner'), { pan: new FakeParam(0) });
  }
  createDelay(): FakeNode {
    return Object.assign(new FakeNode('delay'), { delayTime: new FakeParam(0) });
  }
  createWaveShaper(): FakeNode {
    return Object.assign(new FakeNode('waveshaper'), { curve: null as Float32Array | null, oversample: 'none' });
  }
  createAnalyser(): FakeNode {
    return Object.assign(new FakeNode('analyser'), { fftSize: 2048, getFloatTimeDomainData: (b: Float32Array) => b.fill(0) });
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array): unknown {
    return { real, imag };
  }
  createBuffer(_channels: number, length: number, rate: number): unknown {
    const data = new Float32Array(length);
    return { duration: length / rate, length, sampleRate: rate, getChannelData: () => data };
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Shared fake environment

type FakeWindow = EventTarget & { innerWidth: number; innerHeight: number; devicePixelRatio?: number };

const dom = {
  doc: new FakeDocument(),
  win: new EventTarget() as FakeWindow,
  /** Callbacks passed to requestAnimationFrame, run by runFrames(). */
  rafs: [] as Array<(t: number) => void>,
  lockRequest(el: FakeElement): unknown {
    later(() => {
      this.doc.pointerLockElement = el;
      this.doc.dispatchEvent(new Event('pointerlockchange'));
    });
    return undefined;
  },
};

/** A fake performance.now() that the frames below advance. */
const clock = { now: 1000 };

beforeEach(() => {
  dom.doc = new FakeDocument();
  dom.win = Object.assign(new EventTarget(), {
    innerWidth: 1280,
    innerHeight: 720,
    localStorage: new FakeStorage(),
    AudioContext: FakeAudioContext,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
  dom.rafs = [];
  FakeAudioContext.last = null;
  clock.now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  vi.stubGlobal('document', dom.doc);
  vi.stubGlobal('window', dom.win);
  vi.stubGlobal('navigator', { getGamepads: () => [] });
  vi.stubGlobal('location', { search: '', reload: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    dom.rafs.push(cb);
    return dom.rafs.length;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An event of `type` carrying the given properties (KeyboardEvent, MouseEvent... don't exist in Node). */
function ev(type: string, props: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  if (type.startsWith('key') && !('getModifierState' in props)) Object.defineProperty(e, 'getModifierState', { value: () => false });
  return e;
}

const keyEv = (type: 'keydown' | 'keyup', code: string, key: string) => ev(type, { code, key, repeat: false });
const keyDown = (code: string, key = code) => dom.win.dispatchEvent(keyEv('keydown', code, key));
const keyUp = (code: string, key = code) => dom.win.dispatchEvent(keyEv('keyup', code, key));
const letterCode = (ch: string) => `Key${ch.toUpperCase()}`;

/** A Game on the fake DOM, driven through its real frame loop at 60 fps (performance.now and the audio clock follow). */
function playGame() {
  const canvas = new FakeElement('canvas');
  const uiRoot = new FakeElement('div');
  const game = new Game(canvas as unknown as HTMLCanvasElement, uiRoot as unknown as HTMLElement);
  const g = game as unknown as { running: boolean; last: number; frame: (now: number) => void };
  g.running = true; // as after start(); requestAnimationFrame is stubbed
  g.last = clock.now;
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) {
      clock.now += 1000 / 60;
      if (FakeAudioContext.last) FakeAudioContext.last.currentTime += 1 / 60;
      g.frame(clock.now);
    }
  };
  const seconds = (s: number) => frames(Math.round(s * 60));
  /** Types `text` at `perKey` frames a key (8 frames: 133 ms), each key held for half of it. */
  const type = (text: string, perKey = 8) => {
    for (const ch of text) {
      keyDown(letterCode(ch), ch.toLowerCase());
      frames(perKey / 2);
      keyUp(letterCode(ch), ch.toLowerCase());
      frames(perKey / 2);
    }
  };
  /** Presses and releases a key that is not typed as a letter (Escape, Enter...). */
  const press = (code: string) => {
    keyDown(code);
    frames(2);
    keyUp(code);
    frames(2);
  };
  const el = (name: string) => uiRoot.all().find((e) => e.dataset.el === name)!;
  const button = (label: string) => uiRoot.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label);
  return { game, canvas, uiRoot, frames, seconds, type, press, el, button };
}

/** A new game without Lou's opening call, a few frames in. */
async function playing() {
  const h = playGame();
  h.game.newGame({ intro: false });
  await flush();
  h.frames(3);
  return { ...h, sim: h.game.sim };
}

/** The longest lane, for driving fast in a straight line. */
function longLane(sim: Sim) {
  return [...sim.roads.gridLanes].sort((a, b) => b.length - a.length)[0]!;
}

/** Puts the player at the wheel of a new `kind` 8 m into the longest lane. */
function driving(sim: Sim, kind: 'sedan' | 'taxi' | 'police') {
  const lane = longLane(sim);
  const v = sim.spawnVehicle(kind, lane.sx + lane.dx * 8, lane.sz + lane.dz * 8, lane.heading);
  placeInCar(sim, v);
  return { v, lane };
}

function setSpeed(v: Vehicle, lane: { dx: number; dz: number }, speed: number): void {
  v.vel.x = lane.dx * speed;
  v.vel.z = lane.dz * speed;
}

type TaxiJob = { kind: 'taxi'; taxi: Vehicle; stage: 'pickup' | 'dropoff'; fare: Character | null; fares: number; destX: number; destZ: number };

/** A taxi job with its fare seated in the cab (the dropoff stage). */
async function taxiWithFare() {
  const h = await playing();
  const { sim, frames } = h;
  const { v: taxi, lane } = driving(sim, 'taxi');
  frames(2);
  sim.activities.toggleJob();
  const job = sim.activities.job as unknown as TaxiJob;
  expect(job?.kind).toBe('taxi');
  // Bring the fare to the cab's kerb side: within 9 m of a stopped cab he walks to its door and gets in, within
  // 4 s at most (Activities.board).
  const fare = job.fare!;
  teleportCharacter(sim, fare, taxi.pos.x - Math.cos(taxi.heading) * 3, taxi.pos.z + Math.sin(taxi.heading) * 3);
  for (let i = 0; i < 5 * 60 && job.stage !== 'dropoff'; i++) frames(1);
  expect(job.stage).toBe('dropoff');
  expect(fare.vehicle).toBe(taxi);
  return { ...h, taxi, lane, job, fare };
}

function teleportCharacter(sim: Sim, c: Character, x: number, z: number): void {
  c.pos.x = x;
  c.pos.z = z;
  c.pos.y = sim.world.groundHeight(x, z);
  c.vel.x = 0;
  c.vel.z = 0;
}

/** Counts the player's exits from vehicles and the side jobs that end. */
function watch(sim: Sim) {
  const n = { exits: 0, jobsEnded: 0 };
  sim.events.on('vehicleExit', (e) => {
    if (e.character === sim.player) n.exits++;
  });
  sim.events.on('activityEnded', () => n.jobsEnded++);
  return n;
}

// ---------------------------------------------------------------------------

/** The texts of the messages the sim shows from now on. */
function messages(sim: Sim): string[] {
  const out: string[] = [];
  sim.events.on('message', (e) => out.push(e.text));
  return out;
}

/** Presses F once (one frame down, then let go): out of a burning car it gets the player out at once. */
function pressF(frames: (n: number) => void): void {
  keyDown('KeyF', 'f');
  frames(1);
  keyUp('KeyF', 'f');
  frames(3);
}

describe('FIXMYRIDE typed in a burning taxi or vigilante car keeps the job', () => {
  for (const speed of [0, 14]) {
    it(`in a cab burning at ${speed} m/s its F gets him out at once, and the code puts him back at the wheel with the job, its streak and the fire out`, async () => {
      const { sim, frames, type, taxi, lane, job } = await taxiWithFare();
      job.fares = 3;
      // The shortest fuse damage lights (Combat.damageVehicle): it blows up 3.5 s on.
      sim.combat.igniteVehicle(taxi, 3.5);
      setSpeed(taxi, lane, speed);
      frames(1);
      // The fare ran from the fire, and the next one waits somewhere.
      expect(taxi.burning).toBe(true);
      expect(job.stage).toBe('pickup');
      const n = watch(sim);
      const said = messages(sim);
      pressF(frames);
      // No wait out of a burning car ('Press F to get out!'): at 14 m/s a bail.
      expect(n.exits).toBe(1);
      expect(sim.player.vehicle).toBe(null);
      expect(sim.activities.job).toBe(job);
      type('IXMYRIDE');
      frames(30);
      expect(n.jobsEnded).toBe(0);
      expect(said.filter((t) => /ended/i.test(t))).toEqual([]);
      expect(sim.activities.job).toBe(job);
      expect(job.fares).toBe(3);
      expect(sim.player.alive).toBe(true);
      expect(sim.player.vehicle).toBe(taxi);
      expect(taxi.burning).toBe(false);
      expect(taxi.destroyed).toBe(false);
      expect(taxi.health).toBe(taxi.spec.health);
      // Back on the job: the cab picks up its next fare as before.
      expect(sim.activities.status()).toBe('FARES 3');
    });
  }

  it('in a cab burning at 8 m/s its F brakes for the stop before getting out, and the code keeps him at the wheel with the job', async () => {
    const { sim, frames, type, taxi, lane, job } = await taxiWithFare();
    job.fares = 2;
    sim.combat.igniteVehicle(taxi, 3.5);
    setSpeed(taxi, lane, 8);
    frames(1);
    const n = watch(sim);
    pressF(frames);
    // Braking, not out yet (PlayerController: between 3.5 and 11 m/s the exit waits for the stop).
    expect(n.exits).toBe(0);
    type('IXMYRIDE');
    frames(30);
    // The cab stops before the code is in: out at the stop, the job waiting, and put back.
    expect(n.exits).toBe(1);
    expect(n.jobsEnded).toBe(0);
    expect(sim.activities.job).toBe(job);
    expect(job.fares).toBe(2);
    expect(sim.player.vehicle).toBe(taxi);
    expect(taxi.burning).toBe(false);
  });

  it('in a burning vigilante car its F gets him out at once, and the code puts him back at the wheel with the job at its level', async () => {
    const { sim, frames, type } = await playing();
    const { v: car } = driving(sim, 'police');
    frames(2);
    sim.activities.toggleJob();
    const job = sim.activities.job as unknown as { kind: string; level: number; timer: number };
    expect(job?.kind).toBe('vigilante');
    job.level = 3;
    sim.combat.igniteVehicle(car, 3.5);
    frames(1);
    const n = watch(sim);
    pressF(frames);
    expect(n.exits).toBe(1);
    expect(sim.player.vehicle).toBe(null);
    type('IXMYRIDE');
    frames(30);
    expect(n.jobsEnded).toBe(0);
    expect(sim.activities.job).toBe(job);
    expect(job.level).toBe(3);
    expect(sim.player.vehicle).toBe(car);
    expect(car.burning).toBe(false);
    expect(car.health).toBe(car.spec.health);
  });

  describe('a real F out of a burning job car still ends the job', () => {
    /** A taxi job whose cab burns on a long fuse (nothing blows up during the test), the player got out by F. */
    async function outOfBurningCab() {
      const h = await taxiWithFare();
      h.sim.combat.igniteVehicle(h.taxi, 30);
      h.frames(1);
      const n = watch(h.sim);
      const said = messages(h.sim);
      keyDown('KeyF', 'f');
      h.frames(1);
      expect(n.exits).toBe(1);
      return { ...h, n, said };
    }

    it('at the next key that is no letter of the code (here W, running off)', async () => {
      const { sim, frames, n, said } = await outOfBurningCab();
      keyUp('KeyF', 'f');
      frames(2);
      expect(n.jobsEnded).toBe(0);
      keyDown('KeyW', 'w');
      frames(1);
      keyUp('KeyW', 'w');
      expect(n.jobsEnded).toBe(1);
      expect(sim.activities.job).toBe(null);
      expect(said).toContain('Taxi job ended. Fares: 0.');
    });

    it('at a second F (getting back in), as when he got out', async () => {
      const { sim, frames, n } = await outOfBurningCab();
      keyUp('KeyF', 'f');
      frames(3);
      expect(n.jobsEnded).toBe(0);
      keyDown('KeyF', 'f');
      frames(1);
      keyUp('KeyF', 'f');
      expect(n.jobsEnded).toBe(1);
      expect(sim.activities.job).toBe(null);
    });

    it('at an Enter (getting back in, the other exit key, which types no letter), as when he got out', async () => {
      const { sim, frames, n } = await outOfBurningCab();
      keyUp('KeyF', 'f');
      frames(3);
      expect(n.jobsEnded).toBe(0);
      keyDown('Enter');
      frames(1);
      keyUp('Enter');
      expect(n.jobsEnded).toBe(1);
      expect(sim.activities.job).toBe(null);
    });

    it('when the cab blows up during the wait, the code being typed or not', async () => {
      const h = await taxiWithFare();
      const { sim, frames, type, taxi } = h;
      sim.cheats.godMode = true; // he lives through the blast: the job ends for the car, not for him
      sim.combat.igniteVehicle(taxi, 0.3);
      frames(1);
      const n = watch(sim);
      pressF(frames);
      expect(n.exits).toBe(1);
      expect(n.jobsEnded).toBe(0);
      expect(taxi.destroyed).toBe(false);
      type('IXM');
      expect(taxi.destroyed).toBe(true);
      expect(n.jobsEnded).toBe(1);
      expect(sim.activities.job).toBe(null);
      expect(sim.player.alive).toBe(true);
    });

    it('once the time a code allows between two letters (1.5 s) has gone by with no next letter', async () => {
      const { sim, frames, n } = await outOfBurningCab();
      keyUp('KeyF', 'f');
      frames(84);
      expect(n.jobsEnded).toBe(0);
      expect(sim.activities.job).not.toBe(null);
      frames(8);
      expect(n.jobsEnded).toBe(1);
      expect(sim.activities.job).toBe(null);
    });
  });

  it('Activities waits for the player only while his way out may be undone, and only while its car can take him back', () => {
    const sim = makeSim();
    const lane = longLane(sim);
    const taxi = sim.spawnVehicle('taxi', lane.sx + lane.dx * 8, lane.sz + lane.dz * 8, lane.heading);
    placeInCar(sim, taxi);
    step(sim, 0.1);
    sim.activities.toggleJob();
    const job = sim.activities.job;
    expect(job?.kind).toBe('taxi');
    const ended = watch(sim);
    sim.activities.exitUndoable = true;
    expect(sim.playerCtl.exitVehicle(false)).toBe(true);
    step(sim, 1);
    expect(sim.activities.job).toBe(job);
    expect(sim.activities.status()).toBe('FARES 0');
    // The flag down (the code given up): it ends.
    sim.activities.exitUndoable = false;
    step(sim, 1 / 60);
    expect(ended.jobsEnded).toBe(1);
    expect(sim.activities.job).toBe(null);
    // Someone else at its wheel: the code could not put him back, so it ends at once, flag or not.
    placeInCar(sim, taxi);
    step(sim, 0.1);
    sim.activities.toggleJob();
    expect(sim.activities.job?.kind).toBe('taxi');
    sim.activities.exitUndoable = true;
    expect(sim.playerCtl.exitVehicle(false)).toBe(true);
    step(sim, 0.1);
    expect(sim.activities.job?.kind).toBe('taxi');
    const thief = sim.spawnCharacter('civilian', taxi.pos.x + 4, taxi.pos.z);
    sim.seat(thief, taxi, 0);
    step(sim, 1 / 60);
    expect(ended.jobsEnded).toBe(2);
    expect(sim.activities.job).toBe(null);
  });
});

// ---------------------------------------------------------------------------

/**
 * The Tab stops of the page in document order, as a browser finds them: form controls, and other elements given a tab
 * index of 0 or more, none disabled, hidden or inside an inert element.
 */
function tabStops(...roots: FakeElement[]): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (e: FakeElement) => {
    if (e.inert || e.hidden) return;
    const control = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName);
    if (control ? !e.disabled : e.tabIndex >= 0) out.push(e);
    for (const c of e.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

describe('nothing under the error screen can be reached with Tab', () => {
  /** Crashes the game the way the reviewer's probe did: the menus' input handler throws. */
  function crashInMenus(game: Game, frames: (n: number) => void): void {
    vi.spyOn(game.menus, 'input').mockImplementation(() => {
      throw new Error('menus broke');
    });
    frames(1);
    expect(game.isCrashed).toBe(true);
  }

  it('a crash on the pause menu: Tab and Shift+Tab go round RELOAD and COPY DETAILS only, and the page under them is inert', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { game, canvas, uiRoot, frames, press, button } = await playing();
    canvas.tabIndex = 0; // as in index.html
    press('Escape');
    expect(game.menus.open).toBe(true);
    expect(button('QUIT TO TITLE')).toBeDefined();
    crashInMenus(game, frames);
    const overlay = uiRoot.children.find((c) => c.classList.contains('error'))!;
    const reload = button('RELOAD')!;
    const copy = button('COPY DETAILS')!;
    expect(dom.doc.activeElement).toBe(reload);
    // From RELOAD, Shift+Tab goes back to the stop before it in this list (round to the end), Tab on to the next.
    expect(tabStops(canvas, uiRoot)).toEqual([reload, copy]);
    expect(canvas.inert).toBe(true);
    for (const c of uiRoot.children) expect(c.inert, c.className).toBe(c !== overlay);
  });

  it('a crash on the title: the same, its NEW GAME out of reach', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { game, canvas, uiRoot, frames, button } = playGame();
    canvas.tabIndex = 0;
    frames(2);
    expect(button('NEW GAME')).toBeDefined();
    crashInMenus(game, frames);
    expect(tabStops(canvas, uiRoot)).toEqual([button('RELOAD')!, button('COPY DETAILS')!]);
    expect(game.mode).toBe('title');
  });

  it('the crash report shown to copy by hand is a Tab stop too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('navigator', { getGamepads: () => [] }); // no clipboard: the report is shown to copy by hand
    const { game, canvas, uiRoot, frames, press, button } = await playing();
    canvas.tabIndex = 0;
    press('Escape');
    crashInMenus(game, frames);
    button('COPY DETAILS')!.click();
    const report = uiRoot.all().find((e) => e.tagName === 'TEXTAREA')!;
    expect(report.hidden).toBe(false);
    expect(dom.doc.activeElement).toBe(report);
    expect(tabStops(canvas, uiRoot)).toEqual([button('RELOAD')!, button('COPY DETAILS')!, report]);
  });
});

// ---------------------------------------------------------------------------

describe('a tutorial hint taken off once it no longer applies is not marked read', () => {
  /** What the help box shows ('' when nothing). */
  const showing = (el: (name: string) => FakeElement) => (el('help').classList.contains('show') ? el('help').innerHTML : '');

  it('the 7 s drive hint, the player thrown out 3.25 s into it (just before half its time): gone unread, and read on the next drive', async () => {
    const { game, sim, frames, seconds, el } = await playing();
    sim.cheats.godMode = true;
    const { v } = driving(sim, 'sedan');
    // The welcome message goes first.
    for (let i = 0; i < 60 * 12 && !showing(el).includes('handbrake'); i++) frames(1);
    expect(showing(el)).toContain('handbrake');
    frames(195);
    expect(showing(el)).toContain('handbrake');
    sim.playerCtl.ejectPlayer(true);
    seconds(1);
    expect(showing(el)).not.toContain('handbrake');
    expect(game.settings.hintsSeen).not.toContain('drive');
    expect(loadSettings().hintsSeen).not.toContain('drive');
    // Back at the wheel, it shows again and is read this time.
    placeInCar(sim, v);
    for (let i = 0; i < 60 * 3 && !showing(el).includes('handbrake'); i++) frames(1);
    expect(showing(el)).toContain('handbrake');
    seconds(4);
    expect(game.settings.hintsSeen).toContain('drive');
  });

  it('the low-health hint, the player killed 3.2 s into it: gone under WASTED, and neither marked nor saved as read', async () => {
    const { game, sim, frames, seconds, el } = await playing();
    sim.player.health = 30;
    for (let i = 0; i < 60 * 12 && !showing(el).includes('Health is low'); i++) frames(1);
    expect(showing(el)).toContain('Health is low');
    frames(192);
    sim.combat.damageCharacter(sim.player, 100, null, 'fall', 0, 0, 0);
    frames(1);
    expect(sim.deathKind).toBe('wasted');
    seconds(1);
    expect(sim.deathKind).toBe('wasted');
    expect(showing(el)).not.toContain('Health is low');
    expect(game.settings.hintsSeen).not.toContain('health');
    expect(loadSettings().hintsSeen).not.toContain('health');
  });

  it('a passing state at half its time (out of the car and back within 0.2 s) still lets it be read', async () => {
    const { game, sim, frames, seconds, el } = await playing();
    sim.cheats.godMode = true;
    const { v } = driving(sim, 'sedan');
    for (let i = 0; i < 60 * 12 && !showing(el).includes('handbrake'); i++) frames(1);
    expect(showing(el)).toContain('handbrake');
    frames(204);
    sim.playerCtl.ejectPlayer(true);
    frames(12);
    placeInCar(sim, v);
    frames(6);
    expect(showing(el)).toContain('handbrake');
    expect(game.settings.hintsSeen).toContain('drive');
    seconds(4);
    expect(showing(el)).not.toContain('handbrake');
    expect(game.settings.hintsSeen).toContain('drive');
  });
});
