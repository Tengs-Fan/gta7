// Round 2, fix pass 5 (input cluster): F out of a taxi or vigilante job's car acts at once and the job waits for
// FIXMYRIDE, a gamepad changes weapons in a vehicle (LB) so drive-bys work with any weapon drawn on foot, the left stick
// steps through the menus as the D-pad does, and the full-screen map labels each district on its own blocks.
// Node has no DOM or Web Audio: the browser pieces run against the small fakes below (copied from
// r2_fix4_input.test.ts, whose fakes follow fix_frontend.test.ts), and the WebGL renderer is mocked.

import { DEFAULT_BINDINGS } from '../../src/input/bindings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../src/game';
import type { UiActions } from '../../src/input/input';
import type { Settings } from '../../src/settings';
import type { Character, Vehicle } from '../../src/sim/entities';
import { Sim } from '../../src/sim/sim';
import { MapImage } from '../../src/ui/mapRender';
import { Menus, type MenuHost } from '../../src/ui/menus';
import { placeInCar, world } from './helpers';

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

/** One 2D context call: a method and its arguments. */
type Call = [string, unknown[]];

/** A 2D context that accepts any drawing call, and records it while dom.record is on. */
function recordingContext(calls: Call[]): unknown {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) =>
      k in t
        ? t[k]
        : (...args: unknown[]) => {
            if (dom.record) calls.push([String(k), args]);
            return { addColorStop: () => undefined, width: 0 };
          },
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
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
  hidden = false;
  /** As in a browser: an inert element and everything inside it can be neither focused nor clicked. */
  inert = false;
  /** Only an element given a tab index of 0 or more (the canvas in index.html) is a Tab stop besides the form controls. */
  tabIndex = -1;
  /** The calls made on this canvas's 2D context while dom.record was on, in order. */
  readonly calls: Call[] = [];
  private ctx: unknown = null;
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
    if (kind === 'webgl2') return FAKE_GL2;
    this.ctx ??= recordingContext(this.calls);
    return this.ctx;
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
  scrollBy(): void {}
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
  /** Canvas contexts record their calls (see recordingContext). */
  record: false,
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
  dom.record = false;
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

// ---------------------------------------------------------------------------
// Gamepad helpers

type Pad = { connected: boolean; mapping: string; axes: number[]; buttons: Array<{ pressed: boolean; touched: boolean; value: number }> };

/** Connects a standard-mapping pad that the test moves (navigator.getGamepads, read by Input.poll every frame). */
function fakePad(): Pad {
  const pad: Pad = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  vi.stubGlobal('navigator', { getGamepads: () => [pad, null, null, null] });
  return pad;
}

/** Holds pad button `i` (standard mapping: 0 A, 2 X, 4 LB, 5 RB, 9 Start, 13 D-pad down) for `hold` frames, then lets go for `after`. */
function padTap(pad: Pad, frames: (n: number) => void, i: number, hold = 2, after = 2): void {
  pad.buttons[i] = { pressed: true, touched: true, value: 1 };
  frames(hold);
  pad.buttons[i] = { pressed: false, touched: false, value: 0 };
  frames(after);
}

/** The label of the selected button on the top screen (title, pause menu, a question). */
function selected(game: Game): string | undefined {
  const top = game.menus.top!.el as unknown as FakeElement;
  return top.all().find((e) => e.tagName === 'BUTTON' && e.classList.contains('sel'))?.textContent;
}

/** The label of the selected SETTINGS row. */
function selectedRow(game: Game): string | undefined {
  const top = game.menus.top!.el as unknown as FakeElement;
  return top.all().find((e) => e.classList.contains('setting') && e.classList.contains('sel'))?.children[0]?.textContent;
}

// ---------------------------------------------------------------------------

describe('F out of an intact taxi or vigilante car acts at once, and the job waits for FIXMYRIDE (lead: no 1.5 s hold)', () => {
  it('mid-fare with a streak of 4: back at the wheel with the same fare seated, the streak and the job', async () => {
    const { sim, frames, type, taxi, job, fare } = await taxiWithFare();
    job.fares = 4;
    const n = watch(sim);
    const said = messages(sim);
    keyDown('KeyF', 'f');
    frames(1);
    // No wait for the next letter: out at once.
    expect(n.exits).toBe(1);
    expect(sim.player.vehicle).toBe(null);
    keyUp('KeyF', 'f');
    frames(3);
    type('IXMYRIDE');
    frames(30);
    expect(n.jobsEnded).toBe(0);
    expect(said.filter((t) => /ended/i.test(t))).toEqual([]);
    expect(sim.activities.job).toBe(job);
    expect(job.fares).toBe(4);
    expect(job.stage).toBe('dropoff');
    expect(job.fare).toBe(fare);
    expect(fare.vehicle).toBe(taxi);
    expect(sim.player.vehicle).toBe(taxi);
    expect(sim.activities.status()).toMatch(/FARES 4$/);
  });

  it('the cab taken by someone else while the code is typed ends the job at once, and the code puts nobody back in it', async () => {
    const { sim, frames, type, taxi } = await taxiWithFare();
    const n = watch(sim);
    keyDown('KeyF', 'f');
    frames(1);
    keyUp('KeyF', 'f');
    frames(3);
    expect(n.exits).toBe(1);
    expect(n.jobsEnded).toBe(0);
    const thief = sim.spawnCharacter('civilian', taxi.pos.x + 4, taxi.pos.z);
    sim.seat(thief, taxi, 0);
    frames(1);
    expect(n.jobsEnded).toBe(1);
    expect(sim.activities.job).toBe(null);
    type('IXMYRIDE');
    frames(10);
    expect(sim.player.vehicle).toBe(null);
    expect(taxi.driver).toBe(thief);
  });

  it('in a vigilante car the job waits with its level, suspect and target, and goes on with them once the code is in', async () => {
    const { sim, frames, type } = await playing();
    const { v: car } = driving(sim, 'police');
    frames(2);
    sim.activities.toggleJob();
    const job = sim.activities.job as unknown as { kind: string; level: number; target: Vehicle | null; suspect: Character | null };
    expect(job?.kind).toBe('vigilante');
    // A suspect can take a moment to find room on the road (Activities.spawnSuspect retries after 2 s).
    for (let i = 0; i < 6 * 60 && !job.target; i++) frames(1);
    expect(job.target).not.toBe(null);
    job.level = 3;
    // A frame or two of the job for the game to see (Game.step: Input.exitAtStake, as it was before fix pass 5).
    frames(2);
    const { target, suspect } = job;
    const n = watch(sim);
    type('FIXMYRIDE');
    frames(30);
    expect(n.exits).toBe(1);
    expect(n.jobsEnded).toBe(0);
    expect(sim.activities.job).toBe(job);
    expect(job.level).toBe(3);
    expect(job.target).toBe(target);
    expect(job.suspect).toBe(suspect);
    expect(sim.player.vehicle).toBe(car);
  });
});

// ---------------------------------------------------------------------------

describe('gamepad: LB steps the weapons in a vehicle, so a drive-by can be fired whatever was drawn on foot (medium)', () => {
  /** A new game at the wheel of a sedan with the pistol, SMG and rifle, the rifle drawn, and a pad connected. */
  async function inCarWithRifle() {
    const h = await playing();
    const pad = fakePad();
    const p = h.sim.player;
    p.inventory.give('pistol', 100);
    p.inventory.give('smg', 300);
    p.inventory.give('rifle', 300);
    p.inventory.current = 'rifle';
    const { v } = driving(h.sim, 'sedan');
    h.frames(2);
    expect(p.vehicle).toBe(v);
    return { ...h, pad, p, v };
  }

  it('the rifle drawn, X fires nothing; LB steps back to the SMG, which X fires; RB stays the handbrake', async () => {
    const { sim, frames, pad, p } = await inCarWithRifle();
    const shots = () => sim.progress.stats.shotsFired;
    const before = shots();
    padTap(pad, frames, 2);
    // Only the pistol and the SMG fire from a vehicle (PlayerController.driving).
    expect(shots()).toBe(before);
    padTap(pad, frames, 5);
    expect(p.inventory.current).toBe('rifle');
    padTap(pad, frames, 4);
    expect(p.inventory.current).toBe('smg');
    padTap(pad, frames, 2, 20);
    expect(shots()).toBeGreaterThan(before);
    // On round, as on foot: the pistol, fists, then the rifle again.
    padTap(pad, frames, 4);
    expect(p.inventory.current).toBe('pistol');
    padTap(pad, frames, 4);
    expect(p.inventory.current).toBe('fists');
    padTap(pad, frames, 4);
    expect(p.inventory.current).toBe('rifle');
  });

  it('on foot LB and RB still step back and on', async () => {
    const { sim, frames } = await playing();
    const pad = fakePad();
    const p = sim.player;
    p.inventory.give('pistol', 100);
    p.inventory.give('smg', 300);
    p.inventory.current = 'pistol';
    frames(2);
    padTap(pad, frames, 5);
    expect(p.inventory.current).toBe('smg');
    padTap(pad, frames, 4);
    expect(p.inventory.current).toBe('pistol');
  });
});

// ---------------------------------------------------------------------------

describe('gamepad: the left stick steps through the menus as the D-pad does (medium)', () => {
  // The stick's raw value v reads (|v| - 0.18) / 0.82 past the dead zone: 0.65 is past the 0.5 press point, 0.5 sits
  // between the press point and the 0.3 release point, and 1 is full deflection.
  it('on the title a push moves the selection once; held, it steps again after 0.4 s, then every 0.13 s', () => {
    const pad = fakePad();
    const { game, frames } = playGame();
    frames(30);
    expect(selected(game)).toBe('NEW GAME');
    pad.axes[1] = 1;
    frames(1);
    expect(selected(game)).toBe('STREET RUN');
    frames(20);
    expect(selected(game)).toBe('STREET RUN');
    frames(6);
    expect(selected(game)).toBe('MULTIPLAYER');
    frames(8);
    expect(selected(game)).toBe('CONTROLS');
    frames(8);
    expect(selected(game)).toBe('SETTINGS');
    // Let go, then pushed up past the press point: one step back.
    pad.axes[1] = 0;
    frames(2);
    pad.axes[1] = -0.65;
    frames(1);
    expect(selected(game)).toBe('CONTROLS');
    // Eased off between the press and release points: still the same push, no new step.
    pad.axes[1] = -0.5;
    frames(10);
    expect(selected(game)).toBe('CONTROLS');
    // The D-pad steps as before.
    pad.axes[1] = 0;
    frames(2);
    padTap(pad, frames, 13);
    expect(selected(game)).toBe('SETTINGS');
  });

  it('in SETTINGS the stick picks a row up and down and changes it left and right, one axis at a time', () => {
    const pad = fakePad();
    const { game, frames } = playGame();
    game.applySettings({ ...game.settings, quality: 'low' }, false);
    frames(30);
    game.menus.showSettings();
    frames(30);
    expect(selectedRow(game)).toBe('Graphics quality');
    pad.axes[0] = 1;
    frames(1);
    pad.axes[0] = 0;
    frames(2);
    expect(game.settings.quality).toBe('medium');
    // A slant: its main axis alone, so the row does not change along with the value.
    pad.axes[0] = 1;
    pad.axes[1] = 0.9;
    frames(1);
    pad.axes[0] = 0;
    pad.axes[1] = 0;
    frames(2);
    expect(game.settings.quality).toBe('high');
    expect(selectedRow(game)).toBe('Graphics quality');
    const master = game.settings.master;
    pad.axes[1] = 1;
    frames(1);
    pad.axes[1] = 0;
    frames(2);
    expect(selectedRow(game)).toBe('Master volume');
    pad.axes[0] = -1;
    frames(1);
    pad.axes[0] = 0;
    frames(2);
    expect(game.settings.master).toBeCloseTo(master - 0.05, 6);
  });

  it('a stick held from play when Start opens the pause menu steps nothing until it is let go', async () => {
    const { game, frames } = await playing();
    const pad = fakePad();
    pad.axes[1] = 1;
    frames(10);
    padTap(pad, frames, 9, 1, 0);
    expect(game.menus.open).toBe(true);
    frames(90);
    expect(selected(game)).toBe('RESUME');
    pad.axes[1] = 0;
    frames(2);
    pad.axes[1] = 1;
    frames(1);
    expect(selected(game)).toBe('MAP');
  });

  it('QUIT TO TITLE asked with the stick held still opens on NO, and stays there while the stick is held', async () => {
    const { game, frames } = await playing();
    const pad = fakePad();
    padTap(pad, frames, 9);
    frames(20);
    expect(selected(game)).toBe('RESUME');
    // Up from RESUME wraps to QUIT TO TITLE; A asks, the stick still held up.
    pad.axes[1] = -1;
    frames(1);
    expect(selected(game)).toBe('QUIT TO TITLE');
    padTap(pad, frames, 0, 1, 0);
    expect(selected(game)).toBe('NO');
    frames(90);
    expect(selected(game)).toBe('NO');
    pad.axes[1] = 0;
    frames(2);
    expect(selected(game)).toBe('NO');
    expect(game.mode).toBe('game');
  });
});

// ---------------------------------------------------------------------------
// The full-screen map on its own (a stub host), its canvas recording what it draws.

const ui = (over: Partial<UiActions> = {}): UiActions => ({ pause: false, map: false, camera: false, radioNext: false, radioPrev: false, confirm: false, back: false, up: false, down: false, left: false, right: false, ...over });

function mapRig() {
  const sim = new Sim({ world: world(), ambient: false, police: false });
  let waypoint: { x: number; z: number } | null = null;
  const settings: Settings = { quality: 'high', master: 0.8, music: 0.6, sfx: 0.85, sensitivity: 1, invertY: false, fov: 68, hints: true, hintsSeen: [], weather: 'dynamic', lightningFlashes: true, bindings: DEFAULT_BINDINGS, resolutionScale: 1, fpsCap: 0, subtitleSize: 'normal', cameraShake: true, mapLayers: {} };
  const host = {
    hasSave: () => true,
    newGame: vi.fn(),
    continueGame: vi.fn(),
    resume: vi.fn(),
    quitToTitle: vi.fn(),
    abandonMission: vi.fn(),
    settings: () => settings,
    applySettings: () => undefined,
    deleteSave: () => undefined,
    sim: () => sim,
    setWaypoint: (p: { x: number; z: number } | null) => {
      waypoint = p;
    },
    waypoint: () => waypoint,
    click: () => undefined,
  } satisfies MenuHost;
  const map = new MapImage(world());
  const menus = new Menus(new FakeElement('div') as unknown as HTMLElement, host, map);
  menus.showMap();
  const top = menus.top!.el as unknown as FakeElement;
  const canvas = top.children[0]!;
  const vw = dom.win.innerWidth;
  const vh = dom.win.innerHeight;
  const b = sim.world.layout.bounds;
  const centre = { x: (b.landMinX + b.beachEndX) / 2, z: (b.landMinZ + b.landMaxZ) / 2 };
  // Zoom 0 fits the land with as much sea round it on every side as south of it (map.ts).
  const base = Math.min(vw / (2 * (b.worldMaxX - centre.x)), vh / (2 * (b.worldMaxZ - centre.z)));
  /** World metres a second at full deflection: 0.8 of the smaller side of the page a second, at zoom 0. */
  const speed = (0.8 * Math.min(vw, vh)) / base;
  /** One 60 fps frame of menu input (the screen's input guard counts these too). */
  const frame = (over: Partial<UiActions> = {}) => menus.input(ui(over), 1 / 60, 'pad');
  /** The view centre: where a click on the cross in the middle of the page drops the waypoint (then put back). */
  const viewCentre = () => {
    const keep = waypoint;
    waypoint = null;
    for (const kind of ['down', 'up'] as const) canvas.dispatchEvent(ev(`pointer${kind}`, { clientX: vw / 2, clientY: vh / 2, buttons: kind === 'down' ? 1 : 0, button: 0, pointerId: 1 }));
    const w = waypoint as { x: number; z: number } | null;
    waypoint = keep;
    return w!;
  };
  return { sim, menus, canvas, vw, vh, base, centre, speed, frame, viewCentre };
}

describe('the full-screen map pans with the left stick, with none of the steps the stick makes elsewhere', () => {
  it('held right for half a second it pans 0.4 of the view, smoothly: no 60 px step at the push or at a repeat', () => {
    const { frame, viewCentre, centre, speed } = mapRig();
    // Past the input guard, the stick at rest.
    for (let i = 0; i < 60; i++) frame({});
    for (let i = 0; i < 30; i++) frame({ panX: 1, stickX: 1 });
    expect(viewCentre().x - centre.x).toBeCloseTo(speed * 0.5, 4);
    expect(viewCentre().z).toBeCloseTo(centre.z, 6);
  });
});

describe('the full-screen map labels each district on its own blocks (low)', () => {
  it('MIDTOWN, which wraps round Downtown, sits on one of its own blocks; every other label stays at the middle of its blocks', () => {
    const { sim, canvas, frame, vw, vh, base, centre } = mapRig();
    dom.record = true;
    frame({});
    dom.record = false;
    // Where each label is drawn, in the world (zoom 0, the view on the island's centre).
    const drawn = new Map<string, { x: number; z: number }>();
    for (const [fn, args] of canvas.calls) {
      if (fn !== 'fillText') continue;
      const [text, sx, sy] = args as [string, number, number];
      drawn.set(text, { x: centre.x + (sx - vw / 2) / base, z: centre.z + (sy - vh / 2) / base });
    }
    const blocks = sim.world.layout.blocks;
    const zones = [...new Set(blocks.filter((b) => b.district !== 'park').map((b) => b.zone))];
    expect(zones).toContain('Midtown');
    for (const zone of zones) {
      const at = drawn.get(zone.toUpperCase());
      expect(at, zone).toBeDefined();
      expect(sim.world.zoneName(at!.x, at!.z), `${zone}'s label`).toBe(zone);
      const group = blocks.filter((b) => b.zone === zone);
      const mid = {
        x: group.reduce((a, b) => a + (b.rect.minX + b.rect.maxX) / 2, 0) / group.length,
        z: group.reduce((a, b) => a + (b.rect.minZ + b.rect.maxZ) / 2, 0) / group.length,
      };
      if (zone !== 'Midtown') {
        expect(at!.x, zone).toBeCloseTo(mid.x, 3);
        expect(at!.z, zone).toBeCloseTo(mid.z, 3);
        continue;
      }
      // The middle of Midtown's blocks lies in Downtown: the label is on the Midtown block nearest it.
      expect(sim.world.zoneName(mid.x, mid.z)).toBe('Downtown');
      const own = group.map((b) => ({ x: (b.rect.minX + b.rect.maxX) / 2, z: (b.rect.minZ + b.rect.maxZ) / 2 }));
      const nearest = Math.min(...own.map((c) => Math.hypot(c.x - mid.x, c.z - mid.z)));
      expect(own.some((c) => Math.abs(c.x - at!.x) < 1e-3 && Math.abs(c.z - at!.z) < 1e-3 && Math.abs(Math.hypot(c.x - mid.x, c.z - mid.z) - nearest) < 1e-6)).toBe(true);
    }
  });
});
