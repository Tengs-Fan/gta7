// Round 2, fix pass 3 (input cluster): a gamepad API that throws, the map waypoint, FIXMYRIDE in a job or at low
// health, cheat codes typed in menus or within one frame, the error screens without a mouse, the mouse's back
// button, the radar on HiDPI screens, quitting to the title, audio unlocked by any press, and stale hints.
// Node has no DOM or Web Audio: the browser pieces run against the small fakes below (as in fix_frontend.test.ts,
// whose fakes these follow), and the WebGL renderer is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../src/game';
import { Input, type FrameInput } from '../../src/input/input';
import { loadGame, loadSettings, storeGame } from '../../src/settings';
import { Progress, serialize } from '../../src/sim/progress';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { placeInCar, teleport } from './helpers';

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

/** A 2D context that records every call with the stroke style current at the time. */
function recordingCtx() {
  const calls: Array<{ fn: string; args: unknown[]; strokeStyle: unknown }> = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) =>
      k in t
        ? t[k]
        : (...args: unknown[]) => {
            calls.push({ fn: String(k), args, strokeStyle: t.strokeStyle });
            return { addColorStop: () => undefined, width: 0 };
          },
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
  return { ctx, calls };
}

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

type Pad = { connected: boolean; mapping: string; axes: number[]; buttons: Array<{ pressed: boolean; touched: boolean; value: number }> };

function fakePad(): Pad {
  const pad: Pad = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  vi.stubGlobal('navigator', { getGamepads: () => [pad, null, null, null] });
  return pad;
}

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
  /** Sends all the keys of `text` with no frame in between (a typing macro, or a long hitch), then one frame. */
  const burst = (text: string) => {
    for (const ch of text) {
      keyDown(letterCode(ch), ch.toLowerCase());
      keyUp(letterCode(ch), ch.toLowerCase());
    }
    frames(1);
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
  return { game, canvas, uiRoot, frames, seconds, type, burst, press, el, button };
}

/** A new game without Lou's opening call, a few frames in. */
async function playing() {
  const h = playGame();
  h.game.newGame({ intro: false });
  await flush();
  h.frames(3);
  return { ...h, sim: h.game.sim };
}

const newInput = () => new Input(new FakeElement('canvas') as unknown as HTMLCanvasElement);

/** The longest lane, for driving fast in a straight line. */
function longLane(sim: Sim) {
  return [...sim.roads.lanes].sort((a, b) => b.length - a.length)[0]!;
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

describe('a gamepad API that throws (a permissions policy without gamepad)', () => {
  /** navigator.getGamepads() as Chromium has it where the 'gamepad' feature is not allowed. */
  function blockGamepads() {
    const calls = { n: 0 };
    vi.stubGlobal('navigator', {
      getGamepads: () => {
        calls.n++;
        throw new DOMException("Failed to execute 'getGamepads' on 'Navigator': Access to the feature \"gamepad\" is disallowed by permissions policy.", 'SecurityError');
      },
    });
    return calls;
  }

  it('poll() still reads the keyboard, and asks for pads only once', () => {
    const calls = blockGamepads();
    const inp = newInput();
    inp.attach();
    keyDown('KeyW', 'w');
    let fi: FrameInput | null = null;
    for (let i = 0; i < 30; i++) {
      fi = inp.poll(1 / 60);
      inp.endFrame();
    }
    expect(fi!.player.moveZ).toBe(1);
    expect(fi!.device).toBe('kb');
    expect(calls.n).toBe(1);
  });

  it('the frame loop runs: the title flies over, and a new game plays with its clock on the HUD', async () => {
    blockGamepads();
    const { game, frames, el } = playGame();
    const t0 = game.sim.time;
    frames(10);
    expect(game.frames).toBe(10);
    expect(game.isCrashed).toBe(false);
    game.newGame({ intro: false });
    await flush();
    const t1 = game.sim.time;
    frames(30);
    expect(game.frames).toBe(40);
    expect(game.sim.time).toBeGreaterThan(t1 + 0.4);
    expect(t1).toBe(0);
    expect(t0).toBe(0);
    expect(el('clock').textContent).toBe(game.sim.clock.label());
    expect(el('clock').textContent).not.toBe('00:00');
    // Keys still drive the game: Escape pauses.
    keyDown('Escape');
    frames(2);
    expect(game.menus.open).toBe(true);
  });

  it('an error thrown while reading the input shows the error screen instead of escaping the frame', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { game, uiRoot, frames } = playGame();
    frames(2);
    vi.spyOn(game.input, 'poll').mockImplementation(() => {
      throw new Error('input broke');
    });
    expect(() => frames(1)).not.toThrow();
    expect(game.isCrashed).toBe(true);
    expect(uiRoot.children.some((c) => c.classList.contains('error'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('the map waypoint is cleared on arrival and by a side job starting', () => {
  const PURPLE = '#c04fff';
  const PINK = '#ff4fa3';
  const YELLOW = '#ffd23d';

  function rig(game: Game) {
    const rec = recordingCtx();
    (game.hud as unknown as { radarCtx: unknown }).radarCtx = rec.ctx;
    const route = () => (game.hud as unknown as { route: Array<{ x: number; z: number }> }).route;
    const strokes = () => rec.calls.filter((c) => c.fn === 'stroke').map((c) => c.strokeStyle);
    return { rec, route, strokes };
  }

  /**
   * A spot in the middle of a lane, with the lane's direction, such that 80 m before it and 60 m past it (on along the
   * same straight street, the city being a grid) are still in the city and over 200 m from Lou's marker.
   */
  function awayFromLou(sim: Sim) {
    const lou = sim.world.layout.pois.find((q) => q.id === 'lou')!;
    const b = sim.world.bounds;
    const ok = (x: number, z: number) => x > b.cityMinX + 30 && x < b.cityMaxX - 30 && z > b.cityMinZ + 30 && z < b.cityMaxZ - 30 && Math.hypot(x - lou.x, z - lou.z) > 200;
    for (const lane of sim.roads.lanes) {
      const x = lane.sx + (lane.dx * lane.length) / 2;
      const z = lane.sz + (lane.dz * lane.length) / 2;
      if (ok(x, z) && ok(x - lane.dx * 80, z - lane.dz * 80) && ok(x + lane.dx * 60, z + lane.dz * 60)) return { x, z, dx: lane.dx, dz: lane.dz, lou };
    }
    throw new Error('no lane away from Lou');
  }

  it('reached within 20 m it is cleared, and once the player moves on the route leads to Lou, not back', async () => {
    const { game, sim, frames, el } = await playing();
    sim.cheats.godMode = true;
    const { route, strokes, rec } = rig(game);
    const spot = awayFromLou(sim);
    teleport(sim, spot.x - spot.dx * 80, spot.z - spot.dz * 80);
    game.hud.waypoint = { x: spot.x, z: spot.z };
    frames(2);
    expect(strokes()).toContain(PURPLE);
    expect(route()[route().length - 1]).toEqual({ x: spot.x, z: spot.z });
    // Through it...
    teleport(sim, spot.x - spot.dx * 10, spot.z - spot.dz * 10);
    frames(1);
    expect(game.hud.waypoint).toBe(null);
    expect(el('toast').textContent).toBe('Waypoint reached');
    expect(el('toast').classList.contains('show')).toBe(true);
    // ...and 60 m on: the route goes to Lou, the contact with work, in her pink.
    teleport(sim, spot.x + spot.dx * 60, spot.z + spot.dz * 60);
    rec.calls.length = 0;
    frames(2);
    expect(strokes()).toContain(PINK);
    expect(strokes()).not.toContain(PURPLE);
    expect(route()[route().length - 1]).toEqual({ x: spot.lou.x, z: spot.lou.z });
  });

  it('a taxi job starting clears a far waypoint: the route turns yellow and leads to the fare', async () => {
    const { game, sim, frames } = await playing();
    sim.cheats.godMode = true;
    const { route, strokes, rec } = rig(game);
    const { v: taxi } = driving(sim, 'taxi');
    game.hud.waypoint = { x: taxi.pos.x + 400, z: taxi.pos.z };
    frames(2);
    expect(strokes()).toContain(PURPLE);
    // T in the cab.
    keyDown('KeyT', 't');
    frames(2);
    keyUp('KeyT', 't');
    expect(sim.activities.job?.kind).toBe('taxi');
    rec.calls.length = 0;
    frames(2);
    expect(game.hud.waypoint).toBe(null);
    expect(strokes()).toContain(YELLOW);
    expect(strokes()).not.toContain(PURPLE);
    const fare = (sim.activities.job as unknown as TaxiJob).fare!;
    const end = route()[route().length - 1]!;
    expect(Math.hypot(end.x - fare.pos.x, end.z - fare.pos.z)).toBeLessThan(1);
  });

  it('a waypoint set during a job stays until it is reached, then the route goes back to the job', async () => {
    const { game, sim, frames } = await playing();
    sim.cheats.godMode = true;
    const { strokes, rec } = rig(game);
    const { v: taxi } = driving(sim, 'taxi');
    frames(2);
    sim.activities.toggleJob();
    frames(2);
    const wp = { x: taxi.pos.x + 300, z: taxi.pos.z };
    game.hud.waypoint = wp;
    rec.calls.length = 0;
    frames(30);
    expect(game.hud.waypoint).toBe(wp);
    expect(strokes()).toContain(PURPLE);
    teleport(sim, wp.x, wp.z + 5);
    frames(1);
    expect(game.hud.waypoint).toBe(null);
    rec.calls.length = 0;
    frames(2);
    expect(sim.activities.job?.kind).toBe('taxi');
    expect(strokes()).toContain(YELLOW);
    expect(strokes()).not.toContain(PURPLE);
  });
});

// ---------------------------------------------------------------------------

describe('FIXMYRIDE in a job keeps the job, and at low health gets nobody out', () => {
  // In a taxi or vigilante job's car the code's F gets the player out at once, as anywhere (fix pass 5: it used to wait
  // up to 1.5 s for the next letter, braking the car), and the job waits for the code, which puts him back at the wheel.
  for (const speed of [0, 8, 20]) {
    it(`typed in a taxi at ${speed} m/s, its F acts at once, and the code puts him back at the wheel with the fare seated and the job going on`, async () => {
      const { sim, frames, type, taxi, lane, job, fare, game } = await taxiWithFare();
      const fares = job.fares;
      taxi.health = taxi.spec.health * 0.4;
      setSpeed(taxi, lane, speed);
      frames(1);
      const n = watch(sim);
      keyDown('KeyF', 'f');
      frames(4);
      keyUp('KeyF', 'f');
      // Out at once, bailing at 20 m/s; at 8 m/s braking for the stop it gets out at (PlayerController.driving).
      expect(n.exits).toBe(speed === 8 ? 0 : 1);
      frames(4);
      type('IXMYRIDE');
      frames(60);
      expect(n.exits).toBe(1);
      expect(n.jobsEnded).toBe(0);
      expect(sim.activities.job).toBe(job);
      expect(job.stage).toBe('dropoff');
      expect(job.fare).toBe(fare);
      expect(job.fares).toBe(fares);
      expect(fare.vehicle).toBe(taxi);
      expect(sim.player.vehicle).toBe(taxi);
      expect(sim.player.health).toBe(sim.player.maxHealth);
      expect(taxi.health).toBe(taxi.spec.health);
      expect(game.menus.open).toBe(false);
    });
  }

  it('typed slowly (about 370 ms a key) in a taxi at 14 m/s, the job waits for it too', async () => {
    const { sim, frames, type, taxi, lane, job, fare } = await taxiWithFare();
    setSpeed(taxi, lane, 14);
    frames(1);
    const n = watch(sim);
    type('FIXMYRIDE', 22);
    frames(30);
    expect(n.exits).toBe(1);
    expect(n.jobsEnded).toBe(0);
    expect(sim.activities.job).toBe(job);
    expect(fare.vehicle).toBe(taxi);
    expect(sim.player.vehicle).toBe(taxi);
  });

  it('typed in a vigilante car at 20 m/s, the job goes on at its level', async () => {
    const { sim, frames, type } = await playing();
    const { v: car, lane } = driving(sim, 'police');
    frames(2);
    sim.activities.toggleJob();
    const job = sim.activities.job as unknown as { kind: string; level: number };
    expect(job?.kind).toBe('vigilante');
    job.level = 2;
    setSpeed(car, lane, 20);
    frames(1);
    const n = watch(sim);
    type('FIXMYRIDE');
    frames(30);
    expect(n.exits).toBe(1);
    expect(n.jobsEnded).toBe(0);
    expect(sim.activities.job).toBe(job);
    expect(job.level).toBe(2);
    expect(sim.player.vehicle).toBe(car);
  });

  it('typed at 20 m/s with 5 health, the player does not bail out to his death: alive, at the wheel, car repaired', async () => {
    const { sim, frames, type } = await playing();
    const { v, lane } = driving(sim, 'sedan');
    v.health = v.spec.health * 0.3;
    sim.player.health = 5;
    setSpeed(v, lane, 20);
    frames(1);
    const n = watch(sim);
    type('FIXMYRIDE');
    frames(30);
    expect(sim.deathKind).toBe(null);
    expect(sim.player.alive).toBe(true);
    expect(sim.player.health).toBe(5);
    expect(n.exits).toBe(0);
    expect(sim.player.vehicle).toBe(v);
    expect(v.health).toBe(v.spec.health);
  });

  it('typed with 1.2 s between its F and its I (the code allows 1.5 s a letter) in a taxi, the job goes on', async () => {
    const { sim, frames, seconds, type, taxi, job, fare } = await taxiWithFare();
    const n = watch(sim);
    keyDown('KeyF', 'f');
    frames(6);
    keyUp('KeyF', 'f');
    seconds(1.1);
    type('IXMYRIDE');
    frames(30);
    expect(n.exits).toBe(1);
    expect(n.jobsEnded).toBe(0);
    expect(sim.activities.job).toBe(job);
    expect(fare.vehicle).toBe(taxi);
    expect(sim.player.vehicle).toBe(taxi);
  });

  it('typed in capitals, Shift pressed for every letter, in a taxi at 14 m/s, the job goes on', async () => {
    const { sim, frames, taxi, lane, job, fare } = await taxiWithFare();
    setSpeed(taxi, lane, 14);
    frames(1);
    const n = watch(sim);
    for (const ch of 'FIXMYRIDE') {
      keyDown('ShiftLeft', 'Shift');
      frames(2);
      keyDown(letterCode(ch), ch);
      frames(2);
      keyUp(letterCode(ch), ch);
      keyUp('ShiftLeft', 'Shift');
      frames(2);
    }
    frames(30);
    expect(n.exits).toBe(1);
    expect(n.jobsEnded).toBe(0);
    expect(sim.activities.job).toBe(job);
    expect(fare.vehicle).toBe(taxi);
    expect(sim.player.vehicle).toBe(taxi);
  });

  it('with no job and full health a real F gets out at once', async () => {
    const { sim, frames } = await playing();
    driving(sim, 'sedan');
    frames(2);
    const n = watch(sim);
    keyDown('KeyF', 'f');
    frames(1);
    expect(n.exits).toBe(1);
    keyUp('KeyF', 'f');
  });

  it('in a taxi job F alone gets out at once (at 8 m/s at the stop it brakes for), and the job ends once 1.5 s go by with no I', async () => {
    const { sim, frames, taxi, lane } = await taxiWithFare();
    setSpeed(taxi, lane, 8);
    frames(1);
    const n = watch(sim);
    keyDown('KeyF', 'f');
    frames(4);
    keyUp('KeyF', 'f');
    let f = 4;
    for (; f < 84 && n.exits === 0; f++) frames(1);
    // Out well before the code's 1.5 s, the cab stopped: no wait for the next letter, no braking but the stop's own.
    expect(n.exits).toBe(1);
    expect(f).toBeLessThan(60);
    expect(taxi.speed).toBeLessThan(3.5);
    expect(sim.player.vehicle).toBe(null);
    // The job waits for the code as long as it allows for the next letter, then ends.
    frames(84 - f);
    expect(n.jobsEnded).toBe(0);
    expect(sim.activities.job).not.toBe(null);
    frames(8);
    expect(n.jobsEnded).toBe(1);
    expect(sim.activities.job).toBe(null);
  });

  it('in a taxi job F gets out at once, and a W after it shows it is no code: the job ends at once', async () => {
    const { sim, frames } = await taxiWithFare();
    const n = watch(sim);
    keyDown('KeyF', 'f');
    frames(1);
    expect(n.exits).toBe(1);
    frames(2);
    expect(n.jobsEnded).toBe(0);
    keyDown('KeyW', 'w');
    frames(1);
    expect(n.jobsEnded).toBe(1);
    expect(sim.activities.job).toBe(null);
    keyUp('KeyF', 'f');
    keyUp('KeyW', 'w');
  });

  it('in a taxi job F gets out at once, and a second F gets back in: the job is over, as getting out always made it', async () => {
    const { sim, frames, taxi } = await taxiWithFare();
    const n = watch(sim);
    keyDown('KeyF', 'f');
    frames(3);
    keyUp('KeyF', 'f');
    frames(3);
    expect(n.exits).toBe(1);
    expect(n.jobsEnded).toBe(0);
    keyDown('KeyF', 'f');
    frames(1);
    keyUp('KeyF', 'f');
    expect(n.jobsEnded).toBe(1);
    frames(60);
    expect(n.exits).toBe(1);
    expect(sim.player.vehicle).toBe(taxi);
    expect(sim.activities.job).toBe(null);
  });

  it('at 20 m/s with 5 health the window losing focus lets a held F act, as it would have without the wait', async () => {
    const { sim, frames } = await playing();
    const { v, lane } = driving(sim, 'sedan');
    sim.player.health = 5;
    setSpeed(v, lane, 20);
    frames(1);
    const n = watch(sim);
    keyDown('KeyF', 'f');
    frames(3);
    expect(n.exits).toBe(0);
    dom.win.dispatchEvent(new Event('blur'));
    frames(1);
    expect(n.exits).toBe(1);
  });

  it('at 13 m/s with 5 health a held F acts once the car slows below the bail speed: braked from before, he gets out at the stop, alive', async () => {
    const { sim, frames } = await playing();
    const { v, lane } = driving(sim, 'sedan');
    sim.player.health = 5;
    setSpeed(v, lane, 13);
    frames(1);
    const n = watch(sim);
    // The brake held down first: a key pressed after the F would settle it (it is no letter of the code), and it acts.
    keyDown('KeyS', 's');
    frames(1);
    expect(v.speed).toBeGreaterThan(11);
    keyDown('KeyF', 'f');
    frames(2);
    keyUp('KeyF', 'f');
    expect(n.exits).toBe(0);
    for (let i = 0; i < 240 && n.exits === 0; i++) frames(1);
    keyUp('KeyS', 's');
    expect(n.exits).toBe(1);
    expect(sim.deathKind).toBe(null);
    expect(sim.player.alive).toBe(true);
    expect(sim.player.health).toBe(5);
    expect(v.speed).toBeLessThan(3.5);
  });

  it('in a taxi job at 10.5 m/s with 5 health, accelerating, F brakes to a safe stop instead of waiting to bail at speed', async () => {
    const { sim, frames, taxi, lane } = await taxiWithFare();
    sim.player.health = 5;
    keyDown('KeyW', 'w');
    setSpeed(taxi, lane, 10.5);
    frames(1);
    expect(taxi.speed).toBeLessThan(11);
    const n = watch(sim);
    keyDown('KeyF', 'f');
    frames(2);
    keyUp('KeyF', 'f');
    let top = 0;
    for (let i = 0; i < 300 && n.exits === 0; i++) {
      frames(1);
      top = Math.max(top, taxi.speed);
    }
    keyUp('KeyW', 'w');
    expect(top).toBeLessThan(11);
    expect(n.exits).toBe(1);
    expect(sim.deathKind).toBe(null);
    expect(sim.player.alive).toBe(true);
    expect(sim.player.health).toBe(5);
  });

  it('typed at 20 m/s with 5 health in a burning car, the player does not bail out to his death: the fire is out and he is at the wheel', async () => {
    const { sim, frames, type } = await playing();
    const { v, lane } = driving(sim, 'sedan');
    sim.player.health = 5;
    setSpeed(v, lane, 20);
    sim.combat.igniteVehicle(v, 5);
    frames(1);
    expect(v.burning).toBe(true);
    const n = watch(sim);
    type('FIXMYRIDE');
    frames(10);
    expect(sim.deathKind).toBe(null);
    expect(sim.player.alive).toBe(true);
    expect(n.exits).toBe(0);
    expect(sim.player.vehicle).toBe(v);
    expect(v.burning).toBe(false);
    expect(v.health).toBe(v.spec.health);
  });

  it('at 10.5 m/s with 5 health, accelerating, F still brakes to a safe stop at once instead of waiting to bail at speed', async () => {
    const { sim, frames } = await playing();
    const { v, lane } = driving(sim, 'sedan');
    sim.player.health = 5;
    keyDown('KeyW', 'w');
    setSpeed(v, lane, 10.5);
    frames(1);
    expect(v.speed).toBeLessThan(11);
    const n = watch(sim);
    keyDown('KeyF', 'f');
    frames(2);
    keyUp('KeyF', 'f');
    for (let i = 0; i < 240 && n.exits === 0; i++) frames(1);
    keyUp('KeyW', 'w');
    expect(n.exits).toBe(1);
    expect(sim.deathKind).toBe(null);
    expect(sim.player.alive).toBe(true);
    expect(sim.player.health).toBe(5);
    expect(v.speed).toBeLessThan(3.5);
  });

  it("no wait where getting out is urgent: in a burning cab mid-fare F acts at once ('Press F to get out!')", async () => {
    const { sim, frames, taxi } = await taxiWithFare();
    sim.combat.igniteVehicle(taxi, 5);
    frames(1);
    const n = watch(sim);
    keyDown('KeyF', 'f');
    frames(1);
    expect(n.exits).toBe(1);
    keyUp('KeyF', 'f');
  });

  it('no wait where getting out costs nothing: 5 health at 3 m/s is no bail', async () => {
    const { sim, frames } = await playing();
    const { v, lane } = driving(sim, 'sedan');
    sim.player.health = 5;
    setSpeed(v, lane, 3);
    frames(1);
    const n = watch(sim);
    keyDown('KeyF', 'f');
    frames(1);
    expect(n.exits).toBe(1);
    expect(sim.player.health).toBe(5);
    keyUp('KeyF', 'f');
  });
});

// ---------------------------------------------------------------------------

describe('a cheat code whose keys all arrive within one frame has no side effects', () => {
  it('MONEYTREE and IMMORTAL leave no map open', async () => {
    const { game, sim, frames, burst } = await playing();
    const money = sim.progress.money;
    burst('MONEYTREE');
    frames(30);
    expect(sim.progress.money).toBe(money + 50000);
    expect(game.menus.open).toBe(false);
    burst('IMMORTAL');
    frames(30);
    expect(sim.cheats.godMode).toBe(true);
    expect(game.menus.open).toBe(false);
  });

  it('SPAWNSPORTS leaves no pause menu open, and its S, A and W never walk the player', async () => {
    const { game, sim, frames, burst } = await playing();
    sim.cheats.godMode = true;
    // The one beside him: traffic may bring another past.
    const sports = () => sim.vehicles.filter((v) => v.kind === 'sports' && Math.hypot(v.pos.x - sim.player.pos.x, v.pos.z - sim.player.pos.z) < 12).length;
    const before = sports();
    frames(30);
    const x = sim.player.pos.x;
    const z = sim.player.pos.z;
    burst('SPAWNSPORTS');
    frames(30);
    expect(sports()).toBe(before + 1);
    expect(game.menus.open).toBe(false);
    expect(Math.hypot(sim.player.pos.x - x, sim.player.pos.z - z)).toBeLessThan(0.05);
  });

  it('a code completed while one of its keys is still held down: that key does nothing more until it is released', async () => {
    const { game, sim, frames } = await playing();
    sim.cheats.godMode = true;
    frames(30);
    const x = sim.player.pos.x;
    const z = sim.player.pos.z;
    // SPAWNSPORTS between two frames (a stall), its A let go only well after: keys overlapping as they are typed.
    for (const ch of 'SPAWNSPORTS') {
      keyDown(letterCode(ch), ch.toLowerCase());
      if (ch !== 'A') keyUp(letterCode(ch), ch.toLowerCase());
    }
    frames(20);
    keyUp('KeyA', 'a');
    frames(5);
    expect(game.menus.open).toBe(false);
    expect(Math.hypot(sim.player.pos.x - x, sim.player.pos.z - z)).toBeLessThan(0.05);
    // Pressed again, the A strafes as usual.
    keyDown('KeyA', 'a');
    frames(20);
    keyUp('KeyA', 'a');
    expect(Math.hypot(sim.player.pos.x - x, sim.player.pos.z - z)).toBeGreaterThan(0.3);
  });

  it('FIXMYRIDE at 20 m/s repairs the car without getting the player out of it', async () => {
    const { sim, frames, burst } = await playing();
    const { v, lane } = driving(sim, 'sedan');
    v.health = v.spec.health * 0.3;
    setSpeed(v, lane, 20);
    frames(1);
    const n = watch(sim);
    burst('FIXMYRIDE');
    frames(30);
    expect(n.exits).toBe(0);
    expect(sim.player.vehicle).toBe(v);
    expect(v.health).toBe(v.spec.health);
    expect(sim.player.health).toBe(sim.player.maxHealth);
  });
});

// ---------------------------------------------------------------------------

describe('cheat codes typed in a menu change nothing there', () => {
  async function settingsOpen() {
    const h = await playing();
    h.press('Escape');
    expect(h.game.menus.open).toBe(true);
    h.frames(20); // past the menu's input guard
    h.button('SETTINGS')!.click();
    h.frames(20);
    const rows = h.uiRoot.all().filter((e) => e.classList.contains('setting'));
    expect(rows.length).toBeGreaterThan(6);
    return { ...h, rows };
  }

  it('SPAWNSPORTS on Settings with Graphics quality selected leaves the master volume alone', async () => {
    const { game, sim, type, frames } = await settingsOpen();
    const sports = sim.vehicles.filter((v) => v.kind === 'sports').length;
    type('SPAWNSPORTS');
    frames(10);
    expect(loadSettings().master).toBe(0.8);
    expect(game.settings.master).toBe(0.8);
    expect(game.menus.open).toBe(true);
    // The code itself still works.
    expect(sim.vehicles.filter((v) => v.kind === 'sports').length).toBe(sports + 1);
  });

  it('SPAWNSPORTS on Settings with Field of view selected leaves Invert look Y alone', async () => {
    const { game, type, frames, rows } = await settingsOpen();
    // The mouse moving over the row selects it (a mouseenter alone does not: a screen may open under a resting cursor).
    rows[5]!.dispatchEvent(new Event('mousemove'));
    expect(rows[5]!.classList.contains('sel')).toBe(true);
    type('SPAWNSPORTS');
    frames(10);
    expect(loadSettings().invertY).toBe(false);
    expect(game.settings.invertY).toBe(false);
    expect(game.settings.fov).toBe(loadSettings().fov);
  });

  it('typed on the pause menu, SPAWNSPORTS never closes it: its P waits for the next key, and the game stays paused', async () => {
    const { game, sim, press, frames, type } = await playing();
    press('Escape');
    frames(20);
    const pauseScreen = game.menus.top;
    expect(pauseScreen?.el.textContent).toContain('PAUSED');
    const sports = sim.vehicles.filter((v) => v.kind === 'sports').length;
    const t = sim.time;
    for (const ch of 'SPAWNSPORTS') {
      type(ch);
      expect(game.menus.top, `after ${ch}`).toBe(pauseScreen);
    }
    frames(10);
    expect(game.menus.top).toBe(pauseScreen);
    expect(sim.time).toBe(t);
    expect(sim.vehicles.filter((v) => v.kind === 'sports').length).toBe(sports + 1);
  });

  it('S then P on the pause menu is still navigation: the P resumes once no letter of a code follows it', async () => {
    const { game, press, frames, type } = await playing();
    press('Escape');
    frames(20);
    expect(game.menus.open).toBe(true);
    type('S');
    keyDown('KeyP', 'p');
    frames(4);
    keyUp('KeyP', 'p');
    expect(game.menus.open).toBe(true);
    frames(90);
    expect(game.menus.open).toBe(false);
    frames(120);
    expect(game.menus.open).toBe(false);
  });

  it('S then P on the pause menu, then any other key (here Escape): the game resumes at once, and only once', async () => {
    const { game, press, frames, type } = await playing();
    press('Escape');
    frames(20);
    type('S');
    keyDown('KeyP', 'p');
    frames(2);
    keyUp('KeyP', 'p');
    expect(game.menus.open).toBe(true);
    keyDown('Escape');
    frames(1);
    keyUp('Escape');
    expect(game.menus.open).toBe(false);
    frames(120);
    expect(game.menus.open).toBe(false);
  });

  it('S then P then P on the pause menu: the second P resumes at once, and does not pause again', async () => {
    const { game, press, frames, type } = await playing();
    press('Escape');
    frames(20);
    type('S');
    type('P');
    expect(game.menus.open).toBe(true);
    keyDown('KeyP', 'p');
    frames(1);
    keyUp('KeyP', 'p');
    expect(game.menus.open).toBe(false);
    frames(120);
    expect(game.menus.open).toBe(false);
  });

  it('IMMORTAL typed on the map never closes it: its second letter, M, does nothing there', async () => {
    const { game, sim, press, frames, type } = await playing();
    press('KeyM');
    frames(20);
    const map = game.menus.top;
    expect(map?.el.classList.contains('map-screen')).toBe(true);
    type('IMMORTAL');
    frames(10);
    expect(sim.cheats.godMode).toBe(true);
    expect(game.menus.top).toBe(map);
  });

  it('MONEYTREE typed on the map: the M that closed it brings it back once the code is in', async () => {
    const { game, sim, press, frames, type } = await playing();
    press('KeyM');
    frames(20);
    expect(game.menus.top?.el.classList.contains('map-screen')).toBe(true);
    const money = sim.progress.money;
    type('MONEYTREE');
    frames(10);
    expect(sim.progress.money).toBe(money + 50000);
    expect(game.menus.open).toBe(true);
    expect(game.menus.top?.el.classList.contains('map-screen')).toBe(true);
  });

  it('MONEYTREE typed on a map opened from the pause menu: the map is back over the pause menu once the code is in', async () => {
    const { game, sim, press, frames, type, button } = await playing();
    press('Escape');
    frames(20);
    const pauseScreen = game.menus.top;
    button('MAP')!.click();
    frames(20);
    expect(game.menus.top?.el.classList.contains('map-screen')).toBe(true);
    const money = sim.progress.money;
    const t = sim.time;
    type('MONEYTREE');
    frames(10);
    expect(sim.progress.money).toBe(money + 50000);
    expect(game.menus.top?.el.classList.contains('map-screen')).toBe(true);
    // Closing it leads back to the same pause menu, the game paused all along.
    keyDown('Escape');
    frames(2);
    keyUp('Escape');
    expect(game.menus.top).toBe(pauseScreen);
    expect(sim.time).toBe(t);
  });
});

// ---------------------------------------------------------------------------

describe('the error screens work without a mouse', () => {
  const runFrames = () => {
    for (const cb of dom.rafs.splice(0)) cb(clock.now);
  };

  it('a crash focuses RELOAD, gives Tab and Space back to the page, and a fresh pad A reloads', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pad = fakePad();
    const { game, frames, button } = await playing();
    // A held through the crash is not a press.
    pad.buttons[0]!.pressed = true;
    frames(2);
    vi.spyOn(game.hud, 'update').mockImplementation(() => {
      throw new Error('hud exploded');
    });
    frames(1);
    expect(game.isCrashed).toBe(true);
    const reload = button('RELOAD')!;
    const copy = button('COPY DETAILS')!;
    expect(dom.doc.activeElement).toBe(reload);
    expect(reload.classList.contains('sel')).toBe(true);
    copy.focus();
    expect(reload.classList.contains('sel')).toBe(false);
    expect(copy.classList.contains('sel')).toBe(true);
    // Input no longer cancels the keys that move between and press buttons.
    for (const code of ['Tab', 'Space', 'ArrowDown']) {
      const e = keyEv('keydown', code, code === 'Space' ? ' ' : code);
      dom.win.dispatchEvent(e);
      expect(e.defaultPrevented, code).toBe(false);
    }
    const reloads = (location as unknown as { reload: ReturnType<typeof vi.fn> }).reload;
    runFrames();
    runFrames();
    expect(reloads).not.toHaveBeenCalled();
    pad.buttons[0]!.pressed = false;
    runFrames();
    expect(reloads).not.toHaveBeenCalled();
    pad.buttons[0]!.pressed = true;
    runFrames();
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it('the lost-graphics RELOAD takes the focus, and Enter or pad A press it', async () => {
    const { game, canvas, frames, uiRoot } = await playing();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    canvas.dispatchEvent(ev('webglcontextlost'));
    frames(5);
    // Still restoring: no button yet, and confirm does nothing.
    keyDown('Enter');
    frames(2);
    keyUp('Enter');
    const reloads = (location as unknown as { reload: ReturnType<typeof vi.fn> }).reload;
    expect(reloads).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_100);
    const overlay = uiRoot.children.find((c) => c.classList.contains('gfx-lost'))!;
    const reload = overlay.all().find((e) => e.tagName === 'BUTTON' && e.textContent === 'RELOAD')!;
    expect(dom.doc.activeElement).toBe(reload);
    expect(reload.classList.contains('sel')).toBe(true);
    keyDown('Enter');
    frames(1);
    keyUp('Enter');
    expect(reloads).toHaveBeenCalledTimes(1);
    expect(game.contextLost).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("the mouse's back and forward buttons", () => {
  it('cannot leave a game, under a menu included; on the title and after a crash they can', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mouse = (type: 'mousedown' | 'mouseup', button: number) => {
      const e = ev(type, { button });
      dom.win.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const { game, frames, press } = playGame();
    frames(2);
    expect(mouse('mouseup', 3)).toBe(false); // the title: nothing to lose yet
    game.newGame({ intro: false });
    await flush();
    frames(2);
    expect(mouse('mouseup', 3)).toBe(true);
    expect(mouse('mouseup', 4)).toBe(true);
    expect(mouse('mousedown', 3)).toBe(true);
    expect(mouse('mouseup', 0)).toBe(false);
    expect(mouse('mouseup', 2)).toBe(false);
    press('Escape');
    expect(game.menus.open).toBe(true);
    expect(mouse('mouseup', 3)).toBe(true);
    game.resume();
    frames(2);
    vi.spyOn(game.hud, 'update').mockImplementation(() => {
      throw new Error('hud exploded');
    });
    frames(1);
    expect(game.isCrashed).toBe(true);
    expect(mouse('mouseup', 3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('the radar on HiDPI screens', () => {
  it('backs its canvas at its CSS size times the pixel ratio and draws the same picture scaled', async () => {
    const { game, frames, el } = await playing();
    const radar = el('radar');
    let css = 214;
    let reads = 0;
    Object.defineProperty(radar, 'clientWidth', {
      get: () => {
        reads++;
        return css;
      },
    });
    dom.win.devicePixelRatio = 2;
    const rec = recordingCtx();
    (game.hud as unknown as { radarCtx: unknown }).radarCtx = rec.ctx;
    frames(1);
    expect(radar.width).toBe(428);
    expect(radar.height).toBe(428);
    const k = 428 / 220;
    expect(rec.calls.find((c) => c.fn === 'setTransform')!.args).toEqual([k, 0, 0, k, 0, 0]);
    // The geometry is the 220 px drawing's: the clip circle about its centre, the health ring inside it.
    expect(rec.calls.find((c) => c.fn === 'arc')!.args.slice(0, 3)).toEqual([110, 110, 110]);
    // Measured again only when the window or the pixel ratio changes.
    frames(10);
    expect(reads).toBe(1);
    css = 144;
    dom.win.innerWidth = 700;
    dom.win.devicePixelRatio = 1;
    rec.calls.length = 0;
    frames(1);
    expect(radar.width).toBe(144);
    expect(rec.calls.find((c) => c.fn === 'setTransform')!.args).toEqual([144 / 220, 0, 0, 144 / 220, 0, 0]);
  });
});

// ---------------------------------------------------------------------------

describe('QUIT TO TITLE and the frozen game sounds', () => {
  it('keeps the world muted until the siren, engine and radio voices have faded out under it', async () => {
    const { game, sim, frames, press } = await playing();
    sim.cheats.godMode = true;
    const { v } = driving(sim, 'sedan');
    const cop = sim.spawnVehicle('police', v.pos.x + Math.cos(v.heading) * 7, v.pos.z - Math.sin(v.heading) * 7, v.heading);
    cop.siren = true;
    // The mocked renderer never moves the camera, where the listener is: put it over the car.
    game.renderer.cameraCtl.camera.position.set(v.pos.x, v.pos.y + 3, v.pos.z);
    frames(40);
    type Voices = { sirenNodes: { gain: { gain: FakeParam } }; engine: { levelNodes: Array<{ gain: FakeParam }> }; radio: { out: { gain: FakeParam } }; mixer: { pauseGain: { gain: FakeParam } } };
    const a = game.audio as unknown as Voices;
    const siren = a.sirenNodes.gain.gain;
    const engine = a.engine.levelNodes[0]!.gain;
    const radio = a.radio.out.gain;
    const stage = a.mixer.pauseGain.gain;
    for (const p of [siren, engine, radio]) expect(p.target).toBeGreaterThan(0);
    press('Escape');
    await flush(); // the pointer-lock change the pause makes
    frames(20);
    expect(stage.target).toBe(0);
    const from = new Map([siren, engine, radio, stage].map((p) => [p, p.log.length]));
    (game as unknown as { quitToTitle(): void }).quitToTitle();
    frames(90);
    expect(game.mode).toBe('title');
    const after = (p: FakeParam) => p.log.slice(from.get(p));
    // The stage opens once, after a pause...
    const opened = after(stage).find((c) => c.op === 'target' && c.v > 0);
    expect(opened).toBeDefined();
    // ...long enough for each voice's fade to 0 to be nearly done: three of its time constants at least.
    for (const [name, p] of [['siren', siren], ['engine', engine], ['radio', radio]] as const) {
      const zero = after(p).find((c) => c.op === 'target' && c.v === 0);
      expect(zero, name).toBeDefined();
      expect(opened!.t - zero!.t, name).toBeGreaterThanOrEqual(3 * zero!.tc! - 1e-9);
    }
    expect(stage.target).toBe(1);
  });

  it('a new game started during that wait keeps the stage shut until the old voices have faded out under it', async () => {
    const { game, sim, frames, press } = await playing();
    sim.cheats.godMode = true;
    const { v } = driving(sim, 'sedan');
    const cop = sim.spawnVehicle('police', v.pos.x + Math.cos(v.heading) * 7, v.pos.z - Math.sin(v.heading) * 7, v.heading);
    cop.siren = true;
    game.renderer.cameraCtl.camera.position.set(v.pos.x, v.pos.y + 3, v.pos.z);
    frames(40);
    type Voices = { sirenNodes: { gain: { gain: FakeParam } }; engine: { levelNodes: Array<{ gain: FakeParam }> }; radio: { out: { gain: FakeParam } }; mixer: { pauseGain: { gain: FakeParam } } };
    const a = game.audio as unknown as Voices;
    const siren = a.sirenNodes.gain.gain;
    const engine = a.engine.levelNodes[0]!.gain;
    const radio = a.radio.out.gain;
    const stage = a.mixer.pauseGain.gain;
    for (const p of [siren, engine, radio]) expect(p.target).toBeGreaterThan(0);
    press('Escape');
    await flush(); // the pointer-lock change the pause makes
    frames(20);
    const from = new Map([siren, engine, radio, stage].map((p) => [p, p.log.length]));
    (game as unknown as { quitToTitle(): void }).quitToTitle();
    frames(12);
    // NEW GAME 0.2 s later, the old voices still fading.
    game.newGame({ intro: false });
    await flush();
    frames(90);
    expect(game.mode).toBe('game');
    const after = (p: FakeParam) => p.log.slice(from.get(p));
    const opened = after(stage).find((c) => c.op === 'target' && c.v > 0);
    expect(opened).toBeDefined();
    for (const [name, p] of [['siren', siren], ['engine', engine], ['radio', radio]] as const) {
      const zero = after(p).find((c) => c.op === 'target' && c.v === 0);
      expect(zero, name).toBeDefined();
      expect(opened!.t - zero!.t, name).toBeGreaterThanOrEqual(3 * zero!.tc! - 1e-9);
    }
    expect(stage.target).toBe(1);
  });

  it('a graphics reset during that wait does not open the stage early', async () => {
    const { game, canvas, frames, press } = await playing();
    press('Escape');
    await flush(); // the pointer-lock change the pause makes
    frames(5);
    const stage = (game.audio as unknown as { mixer: { pauseGain: { gain: FakeParam } } }).mixer.pauseGain.gain;
    (game as unknown as { quitToTitle(): void }).quitToTitle();
    frames(6);
    canvas.dispatchEvent(ev('webglcontextlost'));
    frames(3);
    canvas.dispatchEvent(ev('webglcontextrestored'));
    expect(game.contextLost).toBe(false);
    expect(stage.target).toBe(0);
    // The wait goes on from where it stopped (0.7 s were left)...
    frames(36);
    expect(stage.target).toBe(0);
    // ...and then the title's ambience comes in.
    frames(12);
    expect(stage.target).toBe(1);
  });

  it('a new game straight from the title is not left muted', async () => {
    const { game, frames, press } = await playing();
    press('Escape');
    await flush(); // the pointer-lock change the pause makes
    frames(5);
    (game as unknown as { quitToTitle(): void }).quitToTitle();
    frames(3);
    game.newGame({ intro: false });
    await flush();
    frames(90);
    const stage = (game.audio as unknown as { mixer: { pauseGain: { gain: FakeParam } } }).mixer.pauseGain.gain;
    expect(stage.target).toBe(1);
    expect(game.menus.open).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('audio unlocks on any press on the page', () => {
  it('a pointerdown on the title menus (not the canvas) creates the audio context', () => {
    const { game } = playGame();
    expect(game.audio.ctx).toBe(null);
    dom.doc.dispatchEvent(new Event('pointerdown'));
    expect(game.audio.ctx).not.toBe(null);
    expect(FakeAudioContext.last).not.toBe(null);
  });
});

// ---------------------------------------------------------------------------

describe('a tutorial hint goes once it no longer applies', () => {
  it('the drive hint goes soon after the player gets out, unread, and comes back the next drive', async () => {
    const { game, sim, frames, seconds, el } = await playing();
    sim.cheats.godMode = true;
    const { v } = driving(sim, 'sedan');
    const help = () => (el('help').classList.contains('show') ? el('help').innerHTML : '');
    // The welcome message goes first.
    for (let i = 0; i < 60 * 12 && !help().includes('handbrake'); i++) frames(1);
    expect(help()).toContain('handbrake');
    seconds(1);
    sim.playerCtl.ejectPlayer(true);
    seconds(0.5);
    expect(help()).not.toContain('handbrake');
    expect(game.settings.hintsSeen).not.toContain('drive');
    // Back at the wheel later, it shows again (and is read this time).
    seconds(2);
    placeInCar(sim, v);
    for (let i = 0; i < 60 * 3 && !help().includes('handbrake'); i++) frames(1);
    expect(help()).toContain('handbrake');
    seconds(4);
    expect(game.settings.hintsSeen).toContain('drive');
  });

  it('the low-health hint is not left up under WASTED', async () => {
    const { sim, frames, seconds, el } = await playing();
    sim.player.health = 30;
    const help = () => (el('help').classList.contains('show') ? el('help').innerHTML : '');
    for (let i = 0; i < 60 * 12 && !help().includes('Health is low'); i++) frames(1);
    expect(help()).toContain('Health is low');
    sim.combat.damageCharacter(sim.player, 100, null, 'fall', 0, 0, 0);
    frames(1);
    expect(sim.deathKind).toBe('wasted');
    seconds(0.5);
    expect(sim.deathKind).toBe('wasted');
    expect(help()).not.toContain('Health is low');
  });
});

describe('San Azura quick start and real frame timing', () => {
  it('reports two FPS for half-second frames while retaining the physics time clamp', () => {
    const { game } = playGame();
    game.newGame({ intro: false });
    const g = game as unknown as { frame(now: number): void };
    const start = game.sim.time;
    for (let i = 0; i < 4; i++) {
      clock.now += 500;
      g.frame(clock.now);
    }
    expect(game.fps).toBeCloseTo(2, 6);
    expect(game.perf.frameIntervalMs).toBe(500);
    expect(game.sim.time - start).toBeCloseTo(0.4, 5);
  });

  it('starts a street run at its start line with a sports car and keeps saved progression', () => {
    const progress = new Progress();
    progress.markDone('wheels');
    progress.addMoney(1200);
    const saved = serialize(progress, [{ id: 'pistol', ammo: 40 }], 30, 12, 3);
    expect(storeGame(saved)).toBeNull();
    const before = loadGame();
    const { game, seconds } = playGame();
    game.startStreetRun();
    expect(game.mode).toBe('game');
    expect(game.menus.open).toBe(false);
    expect(game.sim.player.vehicle?.kind).toBe('sports');
    expect(game.sim.activities.job?.kind).toBe('streetRun');
    expect(game.sim.progress.missionsDone).toContain('wheels');
    expect(game.sim.progress.money).toBe(saved.money);
    expect(game.sim.player.inventory.has('pistol')).toBe(true);
    expect(game.sim.player.armor).toBe(30);
    expect(loadGame()).toEqual(before);
    seconds(4);
    expect(game.sim.missions.active).toBeNull();
    expect(game.sim.activities.job?.kind).toBe('streetRun');
  });
});
