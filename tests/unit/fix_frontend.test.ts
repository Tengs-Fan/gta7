// Regression tests for the frontend review fixes: input (gamepad trigger and look, wheel,
// pointer-lock capture, keyboard layouts), audio, HUD, menus and the Game flows around them.
// Node has no DOM or Web Audio, so the browser pieces run against small fakes defined below,
// and the WebGL renderer is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/audio';
import { wrapAngle } from '../../src/core/math';
import { Game } from '../../src/game';
import { Input, KeyLabels, type FrameInput, type UiActions } from '../../src/input/input';
import { CameraController } from '../../src/render/camera';
import { writeGame, type Settings } from '../../src/settings';
import { Progress, serialize } from '../../src/sim/progress';
import { Sim } from '../../src/sim/sim';
import { Hud } from '../../src/ui/hud';
import { MAP_SCALE, MapImage } from '../../src/ui/mapRender';
import { Menus, type MenuHost } from '../../src/ui/menus';
import { placeInCar, roadPoint, step, world } from './helpers';

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

class FakeElement extends EventTarget {
  readonly tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
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
  getContext(): unknown {
    return ctx2d;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.width, height: this.height };
  }
  click(): void {
    if (!this.disabled) this.dispatchEvent(new Event('click'));
  }
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
// Fake Web Audio: AudioParams throw on non-finite values like browsers do.
// Every param logs its calls and every node records its kind,
// so tests can inspect the graph and the automation that was scheduled.

type ParamCall = { op: 'value' | 'set' | 'linear' | 'exp' | 'target' | 'cancel'; v: number; t: number; tc?: number };

class FakeParam {
  readonly log: ParamCall[] = [];
  /** The default value the param was created with. */
  readonly initial: number;
  constructor(public target = 0) {
    this.initial = target;
  }
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
  startAt = 0;
  offset = 0;
  stopAt = Infinity;
  constructor() {
    super('source');
  }
  start(t = 0, offset = 0): void {
    if (!Number.isFinite(t) || !Number.isFinite(offset)) throw new TypeError('non-finite start');
    this.startAt = t;
    this.offset = offset;
  }
  stop(t = 0): void {
    if (!Number.isFinite(t)) throw new TypeError('non-finite stop');
    this.stopAt = t;
  }
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam(0);
  wave: unknown = null;
  startAt = NaN;
  constructor() {
    super('oscillator');
  }
  setPeriodicWave(w: unknown): void {
    this.wave = w;
    this.type = 'custom';
  }
  start(t = 0): void {
    if (!Number.isFinite(t)) throw new TypeError('non-finite start');
    this.startAt = t;
  }
  stop(): void {}
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  currentTime = 1;
  state = 'running';
  readonly sampleRate = 8000;
  readonly destination = new FakeNode('destination');
  readonly sources: FakeSource[] = [];
  /** Every node created, in order. */
  readonly nodes: FakeNode[] = [];
  /** Number of create*() calls of any kind (nodes, buffers and periodic waves). */
  created = 0;
  constructor() {
    FakeAudioContext.last = this;
  }
  private track<T extends FakeNode>(n: T): T {
    this.created++;
    this.nodes.push(n);
    return n;
  }
  createGain(): FakeGain {
    return this.track(new FakeGain());
  }
  createDynamicsCompressor(): FakeNode {
    return this.track(
      Object.assign(new FakeNode('compressor'), { threshold: new FakeParam(-24), knee: new FakeParam(30), ratio: new FakeParam(12), attack: new FakeParam(0.003), release: new FakeParam(0.25) }),
    );
  }
  createBiquadFilter(): FakeNode {
    return this.track(Object.assign(new FakeNode('biquad'), { type: 'lowpass', frequency: new FakeParam(350), Q: new FakeParam(1), gain: new FakeParam(0) }));
  }
  createOscillator(): FakeOscillator {
    return this.track(new FakeOscillator());
  }
  createBufferSource(): FakeSource {
    const s = this.track(new FakeSource());
    this.sources.push(s);
    return s;
  }
  createStereoPanner(): FakeNode {
    return this.track(Object.assign(new FakeNode('panner'), { pan: new FakeParam(0) }));
  }
  createDelay(): FakeNode {
    return this.track(Object.assign(new FakeNode('delay'), { delayTime: new FakeParam(0) }));
  }
  createWaveShaper(): FakeNode {
    return this.track(Object.assign(new FakeNode('waveshaper'), { curve: null as Float32Array | null, oversample: 'none' }));
  }
  createAnalyser(): FakeNode {
    return this.track(Object.assign(new FakeNode('analyser'), { fftSize: 2048, getFloatTimeDomainData: (b: Float32Array) => b.fill(0) }));
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array, opts?: unknown): unknown {
    this.created++;
    return { real, imag, opts };
  }
  createBuffer(_channels: number, length: number, rate: number): unknown {
    this.created++;
    const data = new Float32Array(length);
    return { duration: length / rate, length, sampleRate: rate, getChannelData: () => data };
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

/** Product of the gain stages from `node` to the destination (the compressor passes through). */
function outputGain(node: unknown): number {
  const ctx = FakeAudioContext.last!;
  let g = 1;
  let n = node as FakeNode;
  for (let i = 0; i < 20 && n !== ctx.destination; i++) {
    if (n instanceof FakeGain) g *= n.gain.target;
    n = n.outputs[0] as FakeNode;
    if (!n) return NaN;
  }
  return g;
}

// ---------------------------------------------------------------------------
// Shared fake environment

const dom = {
  doc: new FakeDocument(),
  win: new EventTarget(),
  /** 'grant' / 'deny' answer pointer-lock requests asynchronously like a browser; 'manual' leaves them pending. */
  lockMode: 'grant' as 'grant' | 'deny' | 'manual',
  lockRequests: 0,
  lockRequest(el: FakeElement): unknown {
    this.lockRequests++;
    const doc = this.doc;
    if (this.lockMode === 'grant') {
      later(() => {
        doc.pointerLockElement = el;
        doc.dispatchEvent(new Event('pointerlockchange'));
      });
    } else if (this.lockMode === 'deny') later(() => doc.dispatchEvent(new Event('pointerlockerror')));
    return undefined;
  },
};

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
  dom.lockMode = 'grant';
  dom.lockRequests = 0;
  FakeAudioContext.last = null;
  vi.stubGlobal('document', dom.doc);
  vi.stubGlobal('window', dom.win);
  vi.stubGlobal('navigator', { getGamepads: () => [] });
  vi.stubGlobal('requestAnimationFrame', () => 0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An event of `type` carrying the given properties (KeyboardEvent, WheelEvent... don't exist in Node). */
function ev(type: string, props: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  return e;
}

const keyEv = (type: 'keydown' | 'keyup', code: string, key: string) => ev(type, { code, key, repeat: false });

/** A pointer event plus the compatibility mouse event a browser sends after it. */
function pointer(target: FakeElement, kind: 'down' | 'move' | 'up', x: number, y: number, buttons: number, button = kind === 'move' ? -1 : 0): void {
  target.dispatchEvent(ev(`pointer${kind}`, { clientX: x, clientY: y, buttons, button, pointerId: 1 }));
  target.dispatchEvent(ev(`mouse${kind}`, { clientX: x, clientY: y, buttons, button: Math.max(0, button) }));
}

type Pad = { connected: boolean; mapping: string; axes: number[]; buttons: Array<{ pressed: boolean; touched: boolean; value: number }> };

function fakePad(): Pad {
  const pad: Pad = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  vi.stubGlobal('navigator', { getGamepads: () => [pad, null, null, null] });
  return pad;
}

/** Browsers flag an analog trigger as pressed from about 30/255 of its travel. */
function pull(pad: Pad, i: number, v: number): void {
  pad.buttons[i]!.value = v;
  pad.buttons[i]!.pressed = v > 30 / 255;
}

const newInput = () => new Input(new FakeElement('canvas') as unknown as HTMLCanvasElement);
const quickSim = () => new Sim({ world: world(), ambient: false, police: false });

// ---------------------------------------------------------------------------

describe('gamepad trigger (RT)', () => {
  it('a normal-speed pull fires a semi-auto pistol exactly once', () => {
    const pad = fakePad();
    const inp = newInput();
    const sim = quickSim();
    const p = sim.player;
    p.inventory.give('pistol', 48);
    p.inventory.current = 'pistol';
    let shots = 0;
    sim.events.on('shot', (e) => {
      if (e.shooter === p) shots++;
    });
    let presses = 0;
    // 0 -> 0.25 -> 0.6 -> 1 over a few frames, then held for a second.
    for (const v of [0, 0.25, 0.6, 1, ...Array<number>(60).fill(1)]) {
      pull(pad, 7, v);
      const fi = inp.poll(1 / 60);
      inp.endFrame();
      if (fi.player.firePressed) presses++;
      step(sim, 1 / 60, fi.player);
    }
    expect(presses).toBe(1);
    expect(shots).toBe(1);
  });

  it('jitter around the threshold is one press; a release re-arms it', () => {
    const pad = fakePad();
    const inp = newInput();
    const presses = (values: number[]) =>
      values.filter((v) => {
        pull(pad, 7, v);
        const fi = inp.poll(1 / 60);
        inp.endFrame();
        return fi.player.firePressed;
      }).length;
    expect(presses([0, 0.5, 0.39, 0.41, 0.38, 0.42, 0.39, 0.41])).toBe(1);
    expect(presses([0.1, 0, 0.2, 0.5, 0.9])).toBe(1);
  });

  it('a trigger still held from driving is not a fresh press on foot', () => {
    const pad = fakePad();
    const inp = newInput();
    inp.inVehicle = true;
    for (let i = 0; i < 5; i++) {
      pull(pad, 7, 1);
      inp.poll(1 / 60);
      inp.endFrame();
    }
    inp.inVehicle = false;
    const fi = inp.poll(1 / 60);
    expect(fi.player.fire).toBe(true);
    expect(fi.player.firePressed).toBe(false);
  });
});

describe('gamepad look', () => {
  it('turns at the same rate at 30, 60 and 144 fps', () => {
    for (const fps of [30, 60, 144]) {
      const pad = fakePad();
      pad.axes[2] = 1; // right stick fully right
      const inp = newInput();
      const cam = new CameraController(16 / 9);
      const yaw0 = cam.yaw;
      for (let i = 0; i < fps; i++) {
        const fi = inp.poll(1 / fps);
        inp.endFrame();
        cam.look(fi.lookX, fi.lookY);
      }
      // One second at full deflection keeps the old 60 fps feel: 14 * 60 * 0.0024 = 2.016 rad.
      expect(wrapAngle(cam.yaw - yaw0)).toBeCloseTo(-2.016, 3);
    }
  });
});

describe('mouse wheel weapon switching', () => {
  function wheel() {
    const canvas = new FakeElement('canvas');
    const inp = new Input(canvas as unknown as HTMLCanvasElement);
    inp.attach();
    let t = 1000;
    /** One wheel event per frame, `gap` ms apart; returns the weapon steps it caused. */
    return (deltas: number[], gap = 16, deltaMode = 0, ctrlKey = false) => {
      let next = 0;
      let prev = 0;
      const frame = () => {
        const fi = inp.poll(1 / 60);
        inp.endFrame();
        if (fi.player.nextWeapon) next++;
        if (fi.player.prevWeapon) prev++;
      };
      for (const deltaY of deltas) {
        t += gap;
        canvas.dispatchEvent(ev('wheel', { deltaY, deltaX: 0, deltaMode, ctrlKey, timeStamp: t }));
        frame();
      }
      for (let i = 0; i < 10; i++) frame();
      t += 1000;
      return { next, prev };
    };
  }

  it('a touchpad brush or pinch does not spin through the weapons', () => {
    const scroll = wheel();
    expect(scroll(Array<number>(25).fill(3))).toEqual({ next: 1, prev: 0 }); // ~75 px of smooth scrolling
    expect(scroll(Array<number>(10).fill(5), 16, 0, true)).toEqual({ next: 0, prev: 0 }); // pinch-zoom
  });

  it('each wheel notch still switches once', () => {
    const scroll = wheel();
    expect(scroll([100])).toEqual({ next: 1, prev: 0 });
    expect(scroll([-4, -4, -4], 300)).toEqual({ next: 0, prev: 3 }); // slow small macOS notches
    expect(scroll([3], 16, 1)).toEqual({ next: 1, prev: 0 }); // Firefox line mode
    expect(scroll([100, 100, 100], 30)).toEqual({ next: 3, prev: 0 }); // fast spin
  });
});

describe('mouse capture click', () => {
  function setup() {
    const canvas = new FakeElement('canvas');
    const inp = new Input(canvas as unknown as HTMLCanvasElement);
    inp.attach();
    inp.wantsPointerLock = () => true; // in game, no menu open
    const click = () => {
      canvas.dispatchEvent(ev('mousedown', { button: 0 }));
      const fi = inp.poll(1 / 60);
      inp.endFrame();
      dom.win.dispatchEvent(ev('mouseup', { button: 0 }));
      return fi.player.firePressed;
    };
    return { canvas, click };
  }

  it('the click that re-captures the mouse does not shoot', () => {
    dom.lockMode = 'manual';
    const { canvas, click } = setup();
    expect(click()).toBe(false);
    expect(dom.lockRequests).toBe(1);
    dom.doc.pointerLockElement = canvas;
    dom.doc.dispatchEvent(new Event('pointerlockchange'));
    expect(click()).toBe(true);
  });

  it('where pointer lock is refused (sandboxed frame) clicks still shoot', async () => {
    dom.lockMode = 'deny';
    const { click } = setup();
    expect(click()).toBe(false);
    await flush();
    expect(click()).toBe(true);
    expect(click()).toBe(true);
  });

  it('without the pointer lock API clicks shoot right away', () => {
    const { canvas, click } = setup();
    Object.assign(canvas, {
      requestPointerLock: () => {
        throw new Error('unsupported');
      },
    });
    expect(click()).toBe(true);
  });
});

describe('letter shortcuts on other keyboard layouts', () => {
  function setup() {
    const inp = newInput();
    inp.attach();
    const press = (code: string, key: string) => {
      dom.win.dispatchEvent(keyEv('keydown', code, key));
      const fi = inp.poll(1 / 60);
      inp.endFrame();
      dom.win.dispatchEvent(keyEv('keyup', code, key));
      return fi;
    };
    return { inp, press };
  }

  it('AZERTY: the key labelled M opens the map, ZQSD only moves', () => {
    const { press } = setup();
    expect(press('Semicolon', 'm').ui.map).toBe(true);
    const left = press('KeyA', 'q');
    expect(left.player.moveX).toBe(-1);
    expect(left.player.prevWeapon).toBe(false);
  });

  it('a bound key never fires a second action by its label (Dvorak)', () => {
    const { press } = setup();
    const r = press('KeyR', 'p');
    expect(r.player.reload).toBe(true);
    expect(r.ui.pause).toBe(false);
    expect(press('KeyL', 'p').ui.pause).toBe(true);
  });

  it('a held alias (horn) is released with its key', () => {
    const { inp } = setup();
    inp.inVehicle = true;
    dom.win.dispatchEvent(keyEv('keydown', 'KeyJ', 'h'));
    expect(inp.poll(1 / 60).player.horn).toBe(true);
    inp.endFrame();
    expect(inp.poll(1 / 60).player.horn).toBe(true);
    inp.endFrame();
    dom.win.dispatchEvent(keyEv('keyup', 'KeyJ', 'h'));
    expect(inp.poll(1 / 60).player.horn).toBe(false);
  });
});

describe('audio', () => {
  it('changing a setting in the pause menu keeps the game muted', () => {
    const audio = new AudioEngine();
    audio.unlock();
    const sfx = (audio as unknown as { sfx: unknown }).sfx;
    expect(outputGain(sfx)).toBeGreaterThan(0);
    audio.setPaused(true);
    audio.setVolumes(0.5, 0.5, 0.5);
    expect(outputGain(sfx)).toBe(0);
    // Menu clicks stay audible over the paused game.
    expect(outputGain((audio as unknown as { uiBus: unknown }).uiBus)).toBeCloseTo(0.25, 6);
    audio.setPaused(false);
    expect(outputGain(sfx)).toBeCloseTo(0.25, 6); // the new volumes apply on resume
  });

  it('remembers a pause requested before the AudioContext exists', () => {
    const audio = new AudioEngine();
    audio.setPaused(true);
    audio.unlock();
    expect(outputGain((audio as unknown as { sfx: unknown }).sfx)).toBe(0);
  });

  it('a NaN on the player car or in an event never reaches an AudioParam', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sim = quickSim();
    const rp = roadPoint(sim);
    const v = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    placeInCar(sim, v);
    const audio = new AudioEngine();
    audio.unlock();
    audio.attach(sim);
    audio.setListener(v.pos.x, v.pos.y, v.pos.z, 0);
    v.rpm = NaN;
    v.controls.throttle = NaN;
    audio.update(1 / 60, sim, true);
    sim.events.emit('explosion', { x: NaN, y: 0, z: 0, radius: 7.5 });
    sim.events.emit('explosion', { x: v.pos.x, y: v.pos.y, z: v.pos.z, radius: NaN });
    sim.events.emit('impact', { x: v.pos.x, y: v.pos.y, z: v.pos.z, strength: NaN, vehicle: null });
    audio.setListener(NaN, 0, 0, NaN);
    sim.events.emit('melee', { x: 0, y: 0, z: 0, hit: true });
    audio.update(1 / 60, sim, true);
    // The guards kept every value finite, so nothing even had to be caught.
    expect(warn).not.toHaveBeenCalled();
  });

  it('long noise bursts are not cut short by the random buffer offset', () => {
    const audio = new AudioEngine();
    audio.unlock();
    const ctx = FakeAudioContext.last!;
    const buffer = (audio as unknown as { noise: { duration: number } }).noise;
    vi.spyOn(Math, 'random').mockReturnValue(0.999); // latest start offset, fastest playback
    audio.explosion(0, 0, 0, 7.5);
    expect(ctx.sources.length).toBeGreaterThan(0);
    for (const s of ctx.sources) {
      const needed = s.offset + (s.stopAt - s.startAt) * s.playbackRate.target;
      expect(s.loop || needed <= buffer.duration).toBe(true);
    }
  });
});

describe('HUD', () => {
  function makeHud() {
    const hud = new Hud(new FakeElement('div') as unknown as HTMLElement, new MapImage(world()));
    const el = (hud as unknown as { el: Record<string, FakeElement> }).el;
    const run = (sim: Sim, seconds: number) => {
      for (let t = 0; t < seconds; t += 1 / 60) hud.update(1 / 60, sim, 0, false, null, 0);
    };
    return { hud, el, run };
  }

  it('hides the money delta when gains and losses cancel out', () => {
    const { hud, el, run } = makeHud();
    const sim = quickSim();
    hud.bind(sim);
    sim.events.emit('money', { amount: 100 });
    run(sim, 0.2);
    expect(el.delta!.classList.contains('show')).toBe(true);
    sim.events.emit('money', { amount: -100 });
    run(sim, 4);
    expect(el.delta!.classList.contains('show')).toBe(false);
    sim.events.emit('money', { amount: 250 });
    run(sim, 1);
    expect(el.delta!.textContent).toBe('+$250');
    expect(el.delta!.classList.contains('show')).toBe(true);
    run(sim, 2);
    expect(el.delta!.classList.contains('show')).toBe(false);
  });

  it('a new game does not inherit the previous session’s HUD', () => {
    const { hud, el, run } = makeHud();
    const s1 = quickSim();
    hud.bind(s1);
    s1.player.inventory.give('pistol', 48);
    s1.player.inventory.current = 'pistol';
    s1.events.emit('money', { amount: 50000 });
    hud.toast('Game saved');
    run(s1, 0.3);
    expect(el.delta!.classList.contains('show')).toBe(true);
    expect(el.ammo!.textContent).not.toBe('');
    // Quit to the title right away (the hidden HUD's timers freeze), then start a new game.
    hud.setVisible(false);
    const s2 = quickSim();
    hud.bind(s2);
    hud.setVisible(true);
    run(s2, 1 / 60);
    expect(el.delta!.classList.contains('show')).toBe(false);
    expect(el.toast!.classList.contains('show')).toBe(false);
    expect(el.ammo!.textContent).toBe('');
  });

  it('hides the objective as soon as the mission ends', () => {
    const { hud, el, run } = makeHud();
    const sim = quickSim();
    hud.bind(sim);
    sim.events.emit('objective', { text: 'Deliver the package to Hillcrest' });
    run(sim, 0.5);
    expect(el.objective!.classList.contains('show')).toBe(true);
    sim.events.emit('missionEnded', { id: 'delivery', passed: true });
    run(sim, 1 / 60);
    expect(el.objective!.classList.contains('show')).toBe(false);
  });
});

describe('menus', () => {
  const ui = (over: Partial<UiActions> = {}): UiActions => ({ pause: false, map: false, camera: false, radioNext: false, radioPrev: false, confirm: false, back: false, up: false, down: false, left: false, right: false, ...over });

  function makeMenus(over: Partial<MenuHost> = {}) {
    let saved = true;
    let settings: Settings = { quality: 'high', master: 0.8, music: 0.6, sfx: 0.85, sensitivity: 1, invertY: false, fov: 68 };
    let waypoint: { x: number; z: number } | null = null;
    const host: MenuHost = {
      hasSave: () => saved,
      newGame: vi.fn(),
      continueGame: vi.fn(),
      resume: vi.fn(),
      quitToTitle: vi.fn(),
      abandonMission: vi.fn(),
      settings: () => settings,
      applySettings: (s) => {
        settings = s;
      },
      deleteSave: () => {
        saved = false;
      },
      sim: () => null,
      setWaypoint: (p) => {
        waypoint = p;
      },
      waypoint: () => waypoint,
      click: () => undefined,
      ...over,
    };
    const menus = new Menus(new FakeElement('div') as unknown as HTMLElement, host, new MapImage(world()));
    const top = () => menus.top!.el as unknown as FakeElement;
    const button = (label: string) => top().all().find((e) => e.tagName === 'BUTTON' && e.textContent === label)!;
    return { menus, top, button, settings: () => settings, waypoint: () => waypoint };
  }

  it('CONTINUE is disabled after deleting the save from SETTINGS', () => {
    const { menus, button } = makeMenus();
    menus.showTitle();
    const cont = button('CONTINUE');
    expect(cont.disabled).toBe(false);
    button('SETTINGS').click();
    button('DELETE SAVE').click();
    button('YES').click();
    button('BACK').click();
    expect(button('CONTINUE')).toBe(cont);
    expect(cont.disabled).toBe(true);
    // Keyboard / gamepad selection moved to NEW GAME.
    expect(cont.classList.contains('sel')).toBe(false);
    expect(button('NEW GAME').classList.contains('sel')).toBe(true);
  });

  it('SETTINGS can be driven with keyboard / gamepad', () => {
    const { menus, settings } = makeMenus({ hasSave: () => false });
    menus.showSettings();
    const press = (over: Partial<UiActions>) => menus.input(ui(over), 0.3);
    press({ down: true }); // master volume
    press({ right: true });
    expect(settings().master).toBe(0.85);
    press({ left: true });
    press({ left: true });
    expect(settings().master).toBe(0.75);
    press({ up: true }); // graphics quality
    press({ left: true });
    expect(settings().quality).toBe('medium');
    for (let i = 0; i < 5; i++) press({ down: true }); // field of view
    press({ right: true });
    expect(settings().fov).toBe(73);
    press({ down: true }); // invert look Y
    press({ confirm: true });
    expect(settings().invertY).toBe(true);
    press({ down: true }); // DELETE SAVE is disabled without a save: straight to BACK
    press({ confirm: true });
    expect(menus.open).toBe(false);
  });

  it('a map drag ends when the button is released outside the canvas', () => {
    const sim = quickSim();
    const { menus, top, waypoint } = makeMenus({ sim: () => sim });
    menus.showMap();
    menus.input(ui(), 0.3); // first frame sizes the canvas to the window
    const canvas = top().children[0]!;
    const legend = top().all().find((e) => e.classList.contains('map-legend'))!;
    const map = (menus as unknown as { map: MapImage }).map;
    const k = Math.min(1280 / (map.canvas.width / MAP_SCALE), 720 / (map.canvas.height / MAP_SCALE));
    const b = sim.world.layout.bounds;
    const cx = (b.landMinX + b.beachEndX) / 2;
    const cz = (b.landMinZ + b.landMaxZ) / 2;
    pointer(canvas, 'down', 500, 300, 1);
    pointer(canvas, 'move', 600, 300, 1); // drag 100 px to the right
    pointer(legend, 'up', 600, 300, 0); // released over the legend
    pointer(canvas, 'move', 700, 300, 0); // hovering afterwards must not pan
    // A click at the centre drops the waypoint at the view centre.
    pointer(canvas, 'down', 640, 360, 1);
    pointer(canvas, 'up', 640, 360, 0);
    expect(waypoint()!.x).toBeCloseTo(cx - 100 / k, 6);
    expect(waypoint()!.z).toBeCloseTo(cz, 6);
    // A right click neither drags nor moves the waypoint.
    const wp = waypoint();
    pointer(canvas, 'down', 100, 100, 2, 2);
    pointer(canvas, 'up', 100, 100, 0, 2);
    expect(waypoint()).toBe(wp);
  });

  it('closing a map opened from gameplay runs its close hook', () => {
    const sim = quickSim();
    const { menus } = makeMenus({ sim: () => sim });
    const onClose = vi.fn();
    menus.showMap(onClose);
    menus.input(ui({ map: true }), 0.3);
    expect(menus.open).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('game flows', () => {
  function makeGame() {
    const canvas = new FakeElement('canvas');
    const uiRoot = new FakeElement('div');
    const game = new Game(canvas as unknown as HTMLCanvasElement, uiRoot as unknown as HTMLElement);
    const g = game as unknown as { running: boolean; last: number; frame: (now: number) => void };
    let now = 1000;
    g.running = true; // as after start(); requestAnimationFrame is stubbed
    g.last = now;
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) {
        now += 1000 / 60;
        g.frame(now);
      }
    };
    const key = (code: string, k: string) => {
      dom.win.dispatchEvent(keyEv('keydown', code, k));
      frames(2);
      dom.win.dispatchEvent(keyEv('keyup', code, k));
      frames(1);
    };
    return { game, canvas, uiRoot, frames, key };
  }

  it('the map pauses like the pause menu, closing it resumes, and re-capturing does not shoot', async () => {
    const { game, canvas, frames, key } = makeGame();
    game.newGame();
    await flush();
    expect(dom.doc.pointerLockElement).toBe(canvas);
    const sfx = (game.audio as unknown as { sfx: unknown }).sfx;
    const p = game.sim.player;
    p.inventory.give('pistol', 48);
    p.inventory.current = 'pistol';
    frames(2);
    key('KeyM', 'm');
    await flush();
    expect(game.menus.open).toBe(true);
    expect(dom.doc.pointerLockElement).toBe(null);
    expect(outputGain(sfx)).toBe(0);
    frames(20); // past the menu's input guard
    dom.lockMode = 'manual'; // the re-lock is still pending when the player clicks
    key('KeyM', 'm');
    expect(game.menus.open).toBe(false);
    expect(dom.lockRequests).toBe(2);
    expect(outputGain(sfx)).toBeGreaterThan(0);
    canvas.dispatchEvent(ev('mousedown', { button: 0 }));
    frames(2);
    dom.win.dispatchEvent(ev('mouseup', { button: 0 }));
    expect(game.sim.progress.stats.shotsFired).toBe(0);
    // Once locked, clicks shoot as usual.
    dom.doc.pointerLockElement = canvas;
    dom.doc.dispatchEvent(new Event('pointerlockchange'));
    canvas.dispatchEvent(ev('mousedown', { button: 0 }));
    frames(2);
    expect(game.sim.progress.stats.shotsFired).toBe(1);
  });

  it('the gun shop also mutes the frozen world until it is left', async () => {
    const { game, uiRoot } = makeGame();
    game.newGame();
    await flush();
    const sfx = (game.audio as unknown as { sfx: unknown }).sfx;
    game.sim.events.emit('shopOpen', { poi: 'guns_south' });
    expect(game.menus.open).toBe(true);
    expect(outputGain(sfx)).toBe(0);
    const leave = uiRoot.all().find((e) => e.tagName === 'BUTTON' && e.textContent === 'LEAVE')!;
    leave.click();
    expect(game.menus.open).toBe(false);
    expect(outputGain(sfx)).toBeGreaterThan(0);
  });

  it('a crash frees the cursor and silences the frozen voices', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { game, uiRoot, frames } = makeGame();
    game.newGame();
    await flush();
    frames(2);
    expect(dom.doc.pointerLockElement).not.toBe(null);
    vi.spyOn(game.hud, 'update').mockImplementation(() => {
      throw new Error('boom');
    });
    frames(1);
    expect(game.isCrashed).toBe(true);
    await flush();
    expect(dom.doc.pointerLockElement).toBe(null);
    expect(outputGain((game.audio as unknown as { sfx: unknown }).sfx)).toBe(0);
    // Neither the lost lock nor hiding the tab stacks a pause menu under the error screen.
    dom.doc.hidden = true;
    dom.doc.dispatchEvent(new Event('visibilitychange'));
    expect(game.menus.open).toBe(false);
    expect(uiRoot.children.some((c) => c.classList.contains('error'))).toBe(true);
  });

  it('FIXMYRIDE repairs the car the player just got out of', async () => {
    const { game, frames, key } = makeGame();
    game.newGame();
    await flush();
    const sim = game.sim;
    const pp = sim.playerPos();
    const lane = sim.roads.nearestLane(pp.x, pp.z).lane;
    const v = sim.spawnVehicle('sedan', lane.sx + lane.dx * 10, lane.sz + lane.dz * 10, lane.heading);
    placeInCar(sim, v);
    v.health = v.spec.health * 0.3;
    frames(3);
    for (const ch of 'FIXMYRIDE') key(`Key${ch}`, ch.toLowerCase());
    expect(sim.player.vehicle).toBe(null); // F got the player out...
    expect(game.menus.open).toBe(true); // ...and M opened the map
    frames(20);
    key('Escape', 'Escape');
    frames(2);
    expect(game.menus.open).toBe(false);
    expect(v.health).toBe(v.spec.health);
  });

  it('FIXMYRIDE also puts a car lying on its roof back on its wheels', async () => {
    const { game, frames, key } = makeGame();
    game.newGame();
    await flush();
    const sim = game.sim;
    const pp = sim.playerPos();
    const lane = sim.roads.nearestLane(pp.x, pp.z).lane;
    const v = sim.spawnVehicle('sedan', lane.sx + lane.dx * 10, lane.sz + lane.dz * 10, lane.heading);
    placeInCar(sim, v);
    // As after landing a jump upside down: undrivable and about to blow.
    v.flipped = true;
    v.roll = Math.PI;
    sim.combat.igniteVehicle(v, 3.5);
    frames(3);
    for (const ch of 'FIXMYRIDE') key(`Key${ch}`, ch.toLowerCase());
    frames(20);
    key('Escape', 'Escape');
    frames(2);
    expect(game.menus.open).toBe(false);
    expect(v.flipped).toBe(false);
    expect(v.burning).toBe(false);
    expect(v.drivable).toBe(true);
    frames(30);
    expect(Math.abs(wrapAngle(v.roll))).toBeLessThan(0.1);
  });

  it('shows no crosshair while the player is knocked down, even with the aim button held', async () => {
    const { game, canvas, uiRoot, frames } = makeGame();
    game.newGame();
    await flush();
    const p = game.sim.player;
    p.inventory.give('pistol', 48);
    p.inventory.current = 'pistol';
    const cross = uiRoot.all().find((e) => e.dataset.el === 'cross')!;
    canvas.dispatchEvent(ev('mousedown', { button: 2 }));
    frames(2);
    expect(cross.classList.contains('show')).toBe(true);
    p.state = 'knocked';
    p.knockTimer = 3;
    frames(2);
    expect(cross.classList.contains('show')).toBe(false);
    dom.win.dispatchEvent(ev('mouseup', { button: 2 }));
  });

  it('CONTINUE without a save stays on the title instead of silently starting over', () => {
    const { game } = makeGame();
    game.continueGame();
    expect(game.mode).toBe('title');
    const top = game.menus.top!.el as unknown as FakeElement;
    expect(top.all().some((e) => e.classList.contains('title-note'))).toBe(true);
    // With a save it continues as before.
    expect(writeGame(serialize(new Progress(), [], 0, 12, 1))).toBe(true);
    game.continueGame();
    expect(game.mode).toBe('game');
  });
});

// ---------------------------------------------------------------------------
// Round 1b: issues found by re-reviewing the round-1 fixes.

const NO_UI: UiActions = { pause: false, map: false, camera: false, radioNext: false, radioPrev: false, confirm: false, back: false, up: false, down: false, left: false, right: false };

function stubHost(over: Partial<MenuHost> = {}): MenuHost {
  return {
    hasSave: () => false,
    newGame: vi.fn(),
    continueGame: vi.fn(),
    resume: vi.fn(),
    quitToTitle: vi.fn(),
    abandonMission: vi.fn(),
    settings: () => ({ quality: 'high', master: 0.8, music: 0.6, sfx: 0.85, sensitivity: 1, invertY: false, fov: 68 }),
    applySettings: () => undefined,
    deleteSave: () => undefined,
    sim: () => null,
    setWaypoint: () => undefined,
    waypoint: () => null,
    click: () => undefined,
    ...over,
  };
}

describe('side activity objective on the HUD', () => {
  function setup() {
    const hud = new Hud(new FakeElement('div') as unknown as HTMLElement, new MapImage(world()));
    const el = (hud as unknown as { el: Record<string, FakeElement> }).el;
    const sim = quickSim();
    hud.bind(sim);
    let ended = 0;
    sim.events.on('activityEnded', () => ended++);
    /** Advances the side activity and the HUD together at 60 fps. */
    const run = (seconds: number) => {
      for (let t = 0; t < seconds; t += 1 / 60) {
        sim.activities.update(1 / 60);
        hud.update(1 / 60, sim, 0, false, null, 0);
      }
    };
    const kill = () => {
      const p = sim.player.pos;
      const g = sim.spawnCharacter('gang', p.x + 6, p.z);
      g.missionTag = 'rampage';
      sim.combat.kill(g, sim.player, 'bullet', 1, 0);
    };
    const objective = () => (el.objective!.classList.contains('show') ? el.objective!.textContent : null);
    const startRampage = () => {
      expect(sim.activities.startRampage('rampage:0')).toBe(true);
      for (let i = 0; i < 5; i++) {
        kill();
        run(0.5);
      }
      run(1.5); // the RAMPAGE! title is over, so the result banner shows at once
      expect(objective()).toBe('Rampage: 5/12 gang members');
    };
    return { el, sim, run, kill, objective, startRampage, ended: () => ended };
  }

  it('RAMPAGE PASSED takes the kill count off the screen', () => {
    const { el, sim, run, kill, objective, startRampage, ended } = setup();
    startRampage();
    for (let i = 5; i < 11; i++) {
      kill();
      run(0.5);
    }
    expect(objective()).toBe('Rampage: 11/12 gang members');
    kill();
    run(1 / 60);
    expect(sim.activities.busy).toBe(false);
    expect(ended()).toBe(1);
    expect(el.bigT!.textContent).toBe('RAMPAGE PASSED');
    expect(objective()).toBe(null);
  });

  it('RAMPAGE FAILED (out of time) takes it off too', () => {
    const { el, sim, run, objective, startRampage, ended } = setup();
    startRampage();
    (sim.activities.job as { timer: number }).timer = 0.05;
    run(0.1);
    expect(sim.activities.busy).toBe(false);
    expect(ended()).toBe(1);
    expect(el.bigT!.textContent).toBe('RAMPAGE FAILED');
    expect(objective()).toBe(null);
  });

  it('so does getting wasted mid-rampage', () => {
    const { el, sim, run, objective, startRampage, ended } = setup();
    startRampage();
    sim.playerDied();
    run(1 / 60);
    expect(ended()).toBe(1);
    expect(el.bigT!.textContent).toBe('WASTED');
    expect(el.help!.textContent).toBe('Rampage failed.');
    expect(objective()).toBe(null);
  });
});

/** A map screen to scroll on; zoom() reads the zoom level back. */
function mapWheelRig() {
  const sim = quickSim();
  let wp: { x: number; z: number } | null = null;
  const host = stubHost({ sim: () => sim, setWaypoint: (p) => (wp = p), waypoint: () => wp });
  const menus = new Menus(new FakeElement('div') as unknown as HTMLElement, host, new MapImage(world()));
  menus.showMap();
  menus.input(NO_UI, 0.3); // the first frame sizes the canvas to the 1280 x 720 window
  const canvas = (menus.top!.el as unknown as FakeElement).children[0]!;
  const map = (menus as unknown as { map: MapImage }).map;
  const base = Math.min(1280 / (map.canvas.width / MAP_SCALE), 720 / (map.canvas.height / MAP_SCALE));
  const b = sim.world.layout.bounds;
  const cx = (b.landMinX + b.beachEndX) / 2;
  /** The zoom level, read back from where a click 100 px right of the centre drops the waypoint. */
  const zoom = () => {
    wp = null;
    pointer(canvas, 'down', 740, 360, 1);
    pointer(canvas, 'up', 740, 360, 0);
    const k = 100 / (wp!.x - cx);
    wp = null;
    return Math.log(k / base) / Math.log(1.5);
  };
  let t = 1000;
  /** `times` wheel events `gap` ms apart, the first `pause` ms after the previous call's last one. */
  const wheel = (deltaY: number, times = 1, { gap = 16, pause = 1000, ...more }: { gap?: number; pause?: number; deltaX?: number; deltaMode?: number; ctrlKey?: boolean } = {}) => {
    for (let i = 0; i < times; i++) {
      t += i === 0 ? pause : gap;
      canvas.dispatchEvent(ev('wheel', { deltaY, deltaX: 0, deltaMode: 0, ctrlKey: false, timeStamp: t, ...more }));
    }
  };
  return { zoom, wheel };
}

describe('map wheel zoom', () => {
  it('zooms a step per notch, and by distance within a gesture', () => {
    const { zoom, wheel } = mapWheelRig();
    expect(zoom()).toBeCloseTo(0, 6);
    wheel(-100); // one classic notch
    expect(zoom()).toBeCloseTo(0.5, 6);
    wheel(100);
    expect(zoom()).toBeCloseTo(0, 6);
    wheel(-3, 25); // a 75 px touchpad brush used to slam to full zoom: one step, then 72 px of travel
    expect(zoom()).toBeCloseTo(0.86, 6);
    wheel(-3, 1, { deltaMode: 1 }); // Firefox line mode: one notch of 3 lines
    expect(zoom()).toBeCloseTo(1.36, 6);
  });

  it('ignores horizontal swipes and stays within its limits', () => {
    const { zoom, wheel } = mapWheelRig();
    wheel(-200);
    expect(zoom()).toBeCloseTo(0.5, 6);
    wheel(0, 10, { deltaX: 40 });
    wheel(5, 10, { deltaX: 40 });
    expect(zoom()).toBeCloseTo(0.5, 6);
    wheel(-100, 20);
    expect(zoom()).toBeCloseTo(4, 6);
    wheel(100, 20);
    expect(zoom()).toBeCloseTo(0, 6);
  });
});

describe('quick small wheel notches', () => {
  function setup() {
    const canvas = new FakeElement('canvas');
    const inp = new Input(canvas as unknown as HTMLCanvasElement);
    inp.attach();
    let t = 1000;
    /** One wheel event per frame, `gap` ms apart; returns the weapon steps they caused. */
    return (deltas: number[], gap: number) => {
      let next = 0;
      let prev = 0;
      const frame = () => {
        const fi = inp.poll(1 / 60);
        inp.endFrame();
        if (fi.player.nextWeapon) next++;
        if (fi.player.prevWeapon) prev++;
      };
      for (const deltaY of deltas) {
        t += gap;
        canvas.dispatchEvent(ev('wheel', { deltaY, deltaX: 0, deltaMode: 0, ctrlKey: false, timeStamp: t }));
        frame();
      }
      for (let i = 0; i < 10; i++) frame();
      t += 1000;
      return { next, prev };
    };
  }

  it('each step once even when a few come quickly (macOS 4 px, Linux 53 px notches)', () => {
    const scroll = setup();
    expect(scroll([-4, -4, -4], 100)).toEqual({ next: 0, prev: 3 });
    expect(scroll(Array<number>(5).fill(4), 120)).toEqual({ next: 5, prev: 0 });
    expect(scroll(Array<number>(5).fill(53), 80)).toEqual({ next: 5, prev: 0 });
  });

  it('a touchpad stream is still one gesture', () => {
    const scroll = setup();
    expect(scroll(Array<number>(30).fill(10), 16)).toEqual({ next: 3, prev: 0 }); // 300 px: 1 + one per 100 px after the first event
    expect(scroll(Array<number>(25).fill(-3), 8)).toEqual({ next: 0, prev: 1 }); // 120 Hz brush
  });
});

describe('key names follow the keyboard layout', () => {
  /** A map like navigator.keyboard.getLayoutMap() returns: each row's codes, in QWERTY order, to what they type. */
  function layoutMap(rows: { digits?: string; top: string; home: string; bottom: string }): Map<string, string> {
    const codes = {
      digits: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'],
      top: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'],
      home: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
      bottom: ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'],
    };
    const m = new Map<string, string>();
    for (const [row, chars] of Object.entries({ digits: '1234567890', ...rows })) [...chars].forEach((ch, i) => m.set(codes[row as keyof typeof codes][i]!, ch));
    return m;
  }
  const AZERTY = layoutMap({ digits: '&é"\'(-è_çà', top: 'azertyuiop', home: 'qsdfghjklm', bottom: 'wxcvbn,;:!' });
  const DVORAK = layoutMap({ top: '\',.pyfgcrl', home: 'aoeuidhtns', bottom: ';qjkxbmwvz' });
  const COLEMAK = layoutMap({ top: 'qwfpgjluy;', home: 'arstdhneio', bottom: 'zxcvbkm,./' });
  const COLEMAK_DH = layoutMap({ top: 'qwfpbjluy;', home: 'arstgmneio', bottom: 'zxcdvkh,./' });

  function setup(layout: Map<string, string> | 'none' | 'refused') {
    const getLayoutMap = layout === 'refused' ? () => Promise.reject(new Error('SecurityError')) : async () => layout;
    vi.stubGlobal('navigator', { getGamepads: () => [], ...(layout === 'none' ? {} : { keyboard: { getLayoutMap } }) });
    const inp = newInput();
    inp.attach();
    const press = (code: string, key: string, mods: Record<string, boolean> = {}) => {
      dom.win.dispatchEvent(ev('keydown', { code, key, repeat: false, ...mods }));
      const fi = inp.poll(1 / 60);
      inp.endFrame();
      dom.win.dispatchEvent(keyEv('keyup', code, key));
      return fi;
    };
    /** The keyboard rows of the CONTROLS screen, label by action. */
    const controls = () => {
      const menus = new Menus(new FakeElement('div') as unknown as HTMLElement, stubHost(), new MapImage(world()), inp.labels);
      menus.showControls();
      const html = (menus.top!.el as unknown as FakeElement).children.find((c) => c.classList.contains('panel'))!.innerHTML;
      const [keyboard, rest] = html.split('<h3>Gamepad</h3>');
      const rows = Object.fromEntries([...keyboard!.matchAll(/<div><span>([^<]*)<\/span><span>([^<]*)<\/span><\/div>/g)].map((m) => [m[1]!, m[2]!]));
      return { rows, tips: rest!.slice(rest!.indexOf('<h3>Tips</h3>')) };
    };
    return { inp, press, controls };
  }

  /** Each labelled action and how to tell that it fired. */
  const ACTIONS: Array<[string, (f: FrameInput) => boolean]> = [
    ['KeyW', (f) => f.player.moveZ === 1],
    ['KeyA', (f) => f.player.moveX === -1],
    ['KeyS', (f) => f.player.moveZ === -1],
    ['KeyD', (f) => f.player.moveX === 1],
    ['KeyF', (f) => f.player.enterExit],
    ['KeyE', (f) => f.player.interact],
    ['KeyR', (f) => f.player.reload],
    ['KeyQ', (f) => f.player.prevWeapon],
    ['KeyT', (f) => f.player.job],
    ['KeyV', (f) => f.ui.camera],
    ['KeyM', (f) => f.ui.map],
    ['KeyP', (f) => f.ui.pause],
  ];

  it('AZERTY (Keyboard API): CONTROLS says Z Q S D to move and A for the previous weapon', async () => {
    const { controls } = setup(AZERTY);
    await flush();
    const { rows } = controls();
    expect(rows['Move / Drive']).toBe('Z Q S D');
    expect(rows['Weapons']).toBe('1-6, A, wheel');
    // M works on its printed key too (letter alias), and the other shortcuts sit where QWERTY has them.
    expect([rows['Map'], rows['Enter / Exit vehicle'], rows['Interact / Horn'], rows['Reload / Next radio'], rows['Taxi / Vigilante job'], rows['Camera distance'], rows['Pause']]).toEqual(['M', 'F', 'E', 'R', 'T', 'V', 'Esc / P']);
  });

  it('every label names a key that really does the job (AZERTY, Dvorak, Colemak, Colemak-DH)', async () => {
    for (const layout of [AZERTY, DVORAK, COLEMAK, COLEMAK_DH]) {
      const { inp, press } = setup(layout);
      await flush();
      for (const [code, fired] of ACTIONS) {
        const label = inp.labels.label(code);
        const physical = [...layout].find(([, ch]) => ch.toUpperCase() === label);
        expect(physical, `${code} is labelled ${label}`).toBeDefined();
        expect(fired(press(physical![0], physical![1])), `${code} is labelled ${label}`).toBe(true);
      }
      inp.detach();
    }
  });

  it('prompts, tips, the map hint and the welcome help use the same names', async () => {
    const { inp, controls } = setup(COLEMAK_DH);
    await flush();
    const hud = new Hud(new FakeElement('div') as unknown as HTMLElement, new MapImage(world()), inp.labels);
    const el = (hud as unknown as { el: Record<string, FakeElement> }).el;
    const sim = quickSim();
    hud.bind(sim);
    hud.update(1 / 60, sim, 0, false, 'Press E to shop at Bang Bang Guns', 0);
    expect(el.prompt!.innerHTML).toBe('Press <kbd>E</kbd> to shop at Bang Bang Guns'); // 'e' is on a free key: the alias works
    hud.update(1 / 60, sim, 0, false, 'Press T to start a taxi job', 0);
    expect(el.prompt!.innerHTML).toBe('Press <kbd>B</kbd> to start a taxi job');
    sim.events.emit('message', { text: 'Jobs: drive a taxi or a police car and press T.', duration: 3 });
    expect(el.help!.innerHTML).toBe('Jobs: drive a taxi or a police car and press <kbd>B</kbd>.');
    // The sim's own burning-car warning, end to end: it names the enter/exit key, printed T here.
    const rp = roadPoint(sim);
    const car = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    placeInCar(sim, car);
    sim.combat.igniteVehicle(car, 4);
    expect(el.help!.innerHTML).toBe('Your vehicle is on fire! Press <kbd>T</kbd> to get out!');
    expect(controls().tips).toContain('Steal any car with <kbd>T</kbd>');
    const menus = new Menus(new FakeElement('div') as unknown as HTMLElement, stubHost({ sim: () => sim }), new MapImage(world()), inp.labels);
    menus.showMap();
    const hint = (menus.top!.el as unknown as FakeElement).children.find((c) => c.classList.contains('map-hint'))!;
    expect(hint.innerHTML).toContain('<kbd>H</kbd>/<kbd>Esc</kbd> to close');
  });

  it('the game wires the layout into its HUD and menus', async () => {
    vi.stubGlobal('navigator', { getGamepads: () => [], keyboard: { getLayoutMap: async () => COLEMAK } });
    const uiRoot = new FakeElement('div');
    const game = new Game(new FakeElement('canvas') as unknown as HTMLCanvasElement, uiRoot as unknown as HTMLElement);
    await flush();
    game.menus.showControls();
    expect((game.menus.top!.el as unknown as FakeElement).all().find((c) => c.classList.contains('panel'))!.innerHTML).toContain('<span>Move / Drive</span><span>W A R S</span>');
    game.newGame();
    expect(uiRoot.all().find((e) => e.dataset.el === 'help')!.innerHTML).toContain('Steal a ride with <kbd>T</kbd>.');
  });

  it('without the Keyboard API the names are learned from key presses', () => {
    const { inp, press, controls } = setup('none');
    const names = () => ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyM', 'Digit1'].map((c) => inp.labels.label(c)).join(' ');
    expect(names()).toBe('W A S D Q M 1');
    // Modifiers (here AltGr) and other scripts type something else than the key's own label.
    press('KeyE', '€', { ctrlKey: true, altKey: true });
    press('KeyW', 'ц');
    press('Digit1', '&');
    expect(names()).toBe('W A S D Q M 1');
    expect(inp.labels.label('KeyE')).toBe('E');
    // AZERTY: moving teaches Z and Q; QWERTY's Q is then known to be elsewhere, so its key is A.
    press('KeyW', 'z');
    press('KeyA', 'q');
    expect(names()).toBe('Z Q S D A M 1');
    expect(controls().rows['Weapons']).toBe('1-6, A, wheel');
    press('KeyM', ',');
    expect(inp.labels.label('KeyM')).toBe(',');
    press('Semicolon', 'm'); // the key printed M opens the map through its letter alias
    expect(inp.labels.label('KeyM')).toBe('M');
  });

  it('QWERTY names when the layout is unknown or the Keyboard API refuses', async () => {
    expect(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyM'].map((c) => new KeyLabels().label(c))).toEqual(['W', 'A', 'S', 'D', 'Q', 'M']);
    const { controls } = setup('refused');
    await flush();
    const { rows } = controls();
    expect(rows['Move / Drive']).toBe('W A S D');
    expect(rows['Weapons']).toBe('1-6, Q, wheel');
  });
});

// ---------------------------------------------------------------------------
// Round 1c: issues found by re-reviewing the round-1b fixes.

describe('map wheel zoom: a notch is one step on every platform', () => {
  it('separate macOS 4 px notches are one 0.5 step each', () => {
    const { zoom, wheel } = mapWheelRig();
    wheel(-4); // one slow notch used to zoom 0.02
    expect(zoom()).toBeCloseTo(0.5, 6);
    wheel(-4, 3, { gap: 100 }); // a few in quick succession
    expect(zoom()).toBeCloseTo(2, 6);
    wheel(4, 2, { gap: 300 });
    expect(zoom()).toBeCloseTo(1, 6);
  });

  it('a Linux 53 px notch is one step', () => {
    const { zoom, wheel } = mapWheelRig();
    wheel(-53);
    expect(zoom()).toBeCloseTo(0.5, 6);
    wheel(-53, 2, { gap: 80 });
    expect(zoom()).toBeCloseTo(1.5, 6);
  });

  it('a page-mode notch moves at most one step, even within a gesture', () => {
    const { zoom, wheel } = mapWheelRig();
    wheel(-1, 1, { deltaMode: 2 }); // one page used to jump the whole range
    expect(zoom()).toBeCloseTo(0.5, 6);
    wheel(-1, 2, { deltaMode: 2, gap: 30 });
    expect(zoom()).toBeCloseTo(1.5, 6);
  });

  it('a touchpad brush stays well under the full range, and a fast spin keeps every notch', () => {
    const { zoom, wheel } = mapWheelRig();
    wheel(-1.5, 50, { gap: 8 }); // 75 px at 120 Hz: one step, then 73.5 px of travel
    expect(zoom()).toBeCloseTo(0.8675, 6);
    wheel(1.5, 50, { gap: 8 });
    expect(zoom()).toBeCloseTo(0, 6);
    wheel(-100, 3, { gap: 30 }); // Windows notches spun fast are one gesture, still a step each
    expect(zoom()).toBeCloseTo(1.5, 6);
  });

  it('a stray vertical event in a sideways swipe is not a whole step', () => {
    const { zoom, wheel } = mapWheelRig();
    wheel(-1, 1, { deltaX: 10 }); // a sideways two-finger swipe, which does not zoom
    for (let i = 0; i < 5; i++) {
      wheel(-1, 5, { deltaX: 10, pause: 16 });
      wheel(-3, 1, { deltaX: 1, pause: 16 }); // now and then one event is mostly vertical
    }
    expect(zoom()).toBeCloseTo(5 * 3 * 0.005, 6);
  });

  it('a touchpad pinch (ctrl+wheel) zooms like a two-finger scroll', () => {
    const { zoom, wheel } = mapWheelRig();
    wheel(-4, 20, { ctrlKey: true });
    expect(zoom()).toBeCloseTo(0.5 + 19 * 4 * 0.005, 6);
  });
});

// ---------------------------------------------------------------------------
// Round 2, audio cluster: the rebuilt mix, the vehicle voices and the ambience bed,
// against the fake context above (the pure parts are in r2_audio.test.ts).

describe('round 2 audio: mix, voices and ambience', () => {
  type MixerT = import('../../src/audio/mixer').Mixer;
  type AmbienceT = import('../../src/audio/ambience').Ambience;
  type EngineVoiceT = import('../../src/audio/engineVoice').EngineVoice;
  type InputT = import('../../src/sim/input').PlayerInput;
  type VehicleT = import('../../src/sim/entities').Vehicle;
  type Internals = {
    mixer: MixerT;
    ambience: AmbienceT;
    engine: EngineVoiceT;
    hornNodes: { osc1: FakeOscillator; osc2: FakeOscillator; gain: FakeGain };
    inVehicle: boolean;
  };
  const db = (g: number) => 20 * Math.log10(g);
  const P = (x: unknown) => x as FakeParam;

  /** Value of a fake AudioParam at `time`, replaying its logged automation like a browser would. */
  function paramAt(p: FakeParam, time: number): number {
    let v = p.initial;
    let evs: ParamCall[] = [];
    for (const c of p.log) {
      if (c.op === 'value') {
        // The code under test only sets .value on creation: the value before any automation.
        if (evs.length === 0) v = c.v;
      } else if (c.op === 'cancel') evs = evs.filter((e) => e.t < c.t);
      else evs.push(c);
    }
    const order = evs.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map((x) => x.e);
    let at = -Infinity;
    let target: ParamCall | null = null;
    const evolve = (to: number) => {
      if (target && to > at) v = target.v + (v - target.v) * Math.exp(-(to - at) / target.tc!);
      at = Math.max(at, to);
    };
    for (const e of order) {
      if (e.t > time) {
        // A ramp runs from the previous event to its own end time.
        if (e.op === 'linear') return v + ((e.v - v) * (time - at)) / (e.t - at);
        if (e.op === 'exp') return v * Math.pow(e.v / v, (time - at) / (e.t - at));
        break;
      }
      evolve(e.t);
      if (e.op === 'target') target = e;
      else {
        target = null;
        v = e.v;
      }
      at = e.t;
    }
    evolve(time);
    return v;
  }

  /** The graph path from a node to the speakers (following first connections). */
  function pathOf(node: unknown): FakeNode[] {
    const ctx = FakeAudioContext.last!;
    const out: FakeNode[] = [];
    let n = node as FakeNode;
    for (let i = 0; i < 40 && n; i++) {
      out.push(n);
      if (n === ctx.destination) break;
      n = n.outputs[0] as FakeNode;
    }
    return out;
  }

  /** An unlocked engine on a quick sim, with the listener a few metres behind the player. */
  function rig() {
    const sim = quickSim();
    const neutral: InputT = { ...sim.lastInput };
    const audio = new AudioEngine();
    audio.unlock();
    const ctx = FakeAudioContext.last!;
    audio.attach(sim);
    const inner = audio as unknown as Internals;
    const listen = () => {
      const p = sim.playerPos();
      audio.setListener(p.x, p.y + 2, p.z - 5, 0);
    };
    const input = (over: Partial<InputT> = {}): InputT => ({ ...neutral, ...over });
    /** Runs `n` frames of sim + audio, advancing the audio clock with them. */
    const frames = (n: number, inp: InputT | ((i: number) => InputT) = input(), dt = 1 / 60) => {
      for (let i = 0; i < n; i++) {
        ctx.currentTime += dt;
        sim.update(dt, typeof inp === 'function' ? inp(i) : inp);
        listen();
        audio.update(dt, sim, true);
      }
    };
    listen();
    return { sim, audio, ctx, inner, input, frames, listen };
  }

  function seatInCar(sim: Sim, kind: import('../../src/sim/specs').VehicleKind = 'sedan'): VehicleT {
    const rp = roadPoint(sim);
    const v = sim.spawnVehicle(kind, rp.x, rp.z, rp.heading);
    placeInCar(sim, v);
    return v;
  }

  it('every bus reaches the speakers through the bus compressor, the limiter and the tanh soft clip', () => {
    const audio = new AudioEngine();
    audio.unlock();
    const ctx = FakeAudioContext.last!;
    const m = (audio as unknown as Internals).mixer;
    for (const bus of [m.sfx, m.vehicleBus, m.ambBus, m.musicBus, m.uiBus]) {
      const kinds = pathOf(bus).map((n) => n.kind);
      expect(kinds.slice(-4)).toEqual(['compressor', 'compressor', 'waveshaper', 'destination']);
    }
    const [comp, lim, clip] = pathOf(m.sfx).slice(-4) as unknown as Array<Record<string, FakeParam> & FakeNode & { curve: Float32Array; oversample: string }>;
    expect([comp!.threshold!.target, comp!.knee!.target, comp!.ratio!.target, comp!.attack!.target, comp!.release!.target]).toEqual([-18, 6, 3, 0.005, 0.15]);
    expect([lim!.threshold!.target, lim!.knee!.target, lim!.ratio!.target, lim!.attack!.target, lim!.release!.target]).toEqual([-2, 0, 20, 0.001, 0.08]);
    expect(clip!.curve.length).toBe(1024);
    expect(clip!.oversample).toBe('2x');
    expect(Math.max(...Array.from(clip!.curve, Math.abs))).toBeLessThan(1);
    // The test tap hangs off the final stage, after the speakers' connection.
    expect(clip!.outputs[0]).toBe(ctx.destination);
    expect((clip!.outputs as FakeNode[]).some((o) => o.kind === 'analyser')).toBe(true);
    expect(audio.mixer!.analyser).toBe(clip!.outputs[1]);
  });

  it('the pause stage mutes the world, vehicle, ambience and music buses but not the UI', () => {
    const audio = new AudioEngine();
    audio.unlock();
    const m = (audio as unknown as Internals).mixer;
    for (const bus of [m.sfx, m.vehicleBus, m.ambBus, m.musicBus, m.uiBus]) expect(outputGain(bus)).toBeGreaterThan(0);
    audio.setPaused(true);
    for (const bus of [m.sfx, m.vehicleBus, m.ambBus, m.musicBus]) expect(outputGain(bus)).toBe(0);
    expect(outputGain(m.uiBus)).toBeGreaterThan(0);
    // Volumes scale the buses as before: the radio bus carries the music volume.
    audio.setPaused(false);
    audio.setVolumes(1, 0.5, 1);
    expect(outputGain(m.musicBus)).toBeCloseTo(0.5 * 0.8, 6);
    expect(outputGain(m.ambBus)).toBeCloseTo(1, 6);
  });

  it('one-shot envelopes are silent from creation and their sources start a sample after the envelope', () => {
    const { audio, ctx, sim, listen } = rig();
    const v = seatInCar(sim);
    listen();
    const L = { ...sim.playerPos() };
    const before = ctx.nodes.length;
    const envelopes = (fn: () => void) => {
      const b = ctx.nodes.length;
      fn();
      return ctx.nodes.slice(b).filter((n) => n instanceof FakeGain).length;
    };
    const routines: Array<[string, () => void]> = [
      ['gunshot', () => audio.gunshot('pistol', L.x + 30, 1, L.z, false)],
      ['player gunshot', () => audio.gunshot('shotgun', L.x + 1, 1, L.z, true)],
      ['explosion', () => audio.explosion(L.x + 40, 1, L.z, 7.5)],
      ['impact', () => audio.impact(L.x + 5, 1, L.z, 12)],
      ['punch', () => audio.punch(L.x + 2, 1, L.z, true)],
      ['scream', () => audio.scream(L.x + 6, 1, L.z)],
      ['horn tap', () => audio.horn(L.x + 10, 1, L.z, false)],
      ['splash', () => audio.splash(L.x + 8, 0, L.z, true)],
      ['reload', () => audio.reloadClick()],
      ['door', () => audio.doorThunk(v)],
      ['chime', () => audio.chime('passed')],
      [
        'radio',
        () => {
          // The radio's notes and its tuning static.
          for (let i = 0; i < 20; i++) {
            ctx.currentTime += 0.05;
            audio.radio.update(0.05, true);
          }
        },
      ],
    ];
    for (const [name, fn] of routines) expect(envelopes(fn), name).toBeGreaterThan(0);
    const fresh = ctx.nodes.slice(before);
    const gains = fresh.filter((n): n is FakeGain => n instanceof FakeGain && n.gain.log.some((c) => c.op !== 'value'));
    expect(gains.length).toBeGreaterThan(30);
    for (const g of gains) {
      expect(g.gain.log[0]).toMatchObject({ op: 'value', v: 0 });
      expect(g.gain.log[1]).toMatchObject({ op: 'set', v: 0 });
      expect(g.gain.log[1]!.t).toBeLessThanOrEqual(g.gain.log[2]!.t);
    }
    const sources = fresh.filter((n): n is FakeSource | FakeOscillator => n instanceof FakeSource || n instanceof FakeOscillator);
    expect(sources.length).toBeGreaterThan(30);
    for (const s of sources) {
      const env = pathOf(s).find((n): n is FakeGain => n instanceof FakeGain)!;
      expect(s.startAt).toBeCloseTo(env.gain.log[2]!.t + 1 / ctx.sampleRate, 9);
    }
  });

  it('one shotgun pull (nine pellets in a frame) plays one gunshot; NPC shots stay rate-limited', () => {
    const { sim, audio, input, frames } = rig();
    const p = sim.player;
    p.inventory.give('shotgun', 30);
    p.inventory.current = 'shotgun';
    frames(60); // draw it
    let pellets = 0;
    sim.events.on('shot', () => pellets++);
    const before = audio.counters.gunshots;
    frames(1, input({ fire: true, firePressed: true }));
    expect(pellets).toBe(9);
    expect(audio.counters.gunshots - before).toBe(1);
    // The same in one frame from synthetic events, whatever their source.
    const shot = { shooter: p, weapon: 'shotgun' as const, fx: p.pos.x, fy: 1.4, fz: p.pos.z, tx: p.pos.x, ty: 1, tz: p.pos.z + 20, hit: 'world' as const, nx: 0, ny: 1, nz: 0 };
    for (let i = 0; i < 9; i++) sim.events.emit('shot', shot);
    expect(audio.counters.gunshots - before).toBe(2);
    frames(1);
    sim.events.emit('shot', shot);
    expect(audio.counters.gunshots - before).toBe(3);
    // An NPC's pellets keep the old 40 ms limiter (shared with the player's shots of that weapon).
    const npc = sim.spawnCharacter('gang', p.pos.x + 5, p.pos.z);
    FakeAudioContext.last!.currentTime += 0.05;
    for (let i = 0; i < 9; i++) sim.events.emit('shot', { ...shot, shooter: npc });
    expect(audio.counters.gunshots - before).toBe(4);
  });

  it('a held horn is one continuous voice at the car’s horn notes that lets go within 0.1 s', () => {
    const { sim, ctx, inner, input, frames } = rig();
    seatInCar(sim, 'bus');
    frames(5);
    inner.ambience.random = () => 0.999; // no ambience one-shots while counting oscillators
    const h = inner.hornNodes;
    let taps = 0;
    sim.events.on('horn', () => taps++);
    const oscBefore = ctx.nodes.filter((n) => n instanceof FakeOscillator).length;
    const pressAt = ctx.currentTime;
    frames(120, (i) => input({ horn: true, hornPressed: i === 0 }));
    // The sim still reports taps (pedestrians react to them), but no new voice is started.
    expect(taps).toBeGreaterThanOrEqual(4);
    expect(ctx.nodes.filter((n) => n instanceof FakeOscillator).length).toBe(oscBefore);
    expect([h.osc1.frequency.target, h.osc2.frequency.target]).toEqual([220, 277]);
    const peak = paramAt(h.gain.gain, pressAt + 1);
    expect(peak).toBeCloseTo(0.15, 4);
    expect(paramAt(h.gain.gain, pressAt + 1 / 60 + 0.015)).toBeGreaterThan(0.9 * peak);
    const releaseAt = ctx.currentTime;
    frames(10);
    expect(paramAt(h.gain.gain, releaseAt + 1 / 60 + 0.1)).toBeLessThan(0.01 * peak);
    // AI horn taps are unchanged: a two-note honk each.
    const ai = sim.spawnVehicle('sedan', sim.playerPos().x + 12, sim.playerPos().z, 0);
    const n0 = ctx.nodes.filter((n) => n instanceof FakeOscillator).length;
    sim.onHorn(ai);
    expect(ctx.nodes.filter((n) => n instanceof FakeOscillator).length).toBe(n0 + 2);
  });

  it('the radio echo follows a dotted eighth of each song’s tempo', () => {
    const audio = new AudioEngine();
    audio.unlock();
    const ctx = FakeAudioContext.last!;
    const radio = audio.radio as unknown as { delay: { delayTime: FakeParam }; song: { bpm: number } | null; update(dt: number, inCar: boolean): void; next(): string };
    radio.update(1 / 60, true);
    expect(radio.song).not.toBe(null);
    const delay = radio.delay.delayTime;
    expect(delay.log.at(-1)!.op).toBe('target');
    expect(delay.target).toBeCloseTo((0.75 * 60) / radio.song!.bpm, 9);
    for (let k = 0; k < 2; k++) {
      radio.next();
      ctx.currentTime += 0.1;
      radio.update(0.1, true);
      expect(delay.target).toBeCloseTo((0.75 * 60) / radio.song!.bpm, 9);
      expect(delay.target).toBeGreaterThan(0.3);
    }
  });

  it('a radio note that falls due a little in the past after a stall still opens its envelope', () => {
    const audio = new AudioEngine();
    audio.unlock();
    const ctx = FakeAudioContext.last!;
    const radio = audio.radio as unknown as { update(dt: number, inCar: boolean): void; nextTime: number };
    radio.update(1 / 60, true);
    ctx.currentTime += 0.5;
    // The scheduler is 0.15 s behind (it only resyncs when more than 0.2 s late).
    radio.nextTime = ctx.currentTime - 0.15;
    const before = ctx.nodes.length;
    radio.update(1 / 60, true);
    const envs = ctx.nodes.slice(before).filter((n): n is FakeGain => n instanceof FakeGain && n.gain.log.length > 2);
    expect(envs.length).toBeGreaterThan(0);
    for (const g of envs) {
      expect(g.gain.log[1]).toMatchObject({ op: 'set', v: 0 });
      // A zero after the note's start would cut the note off.
      expect(g.gain.log[1]!.t).toBeLessThanOrEqual(g.gain.log[2]!.t);
    }
  });

  it('a subtitle ducks the music by 9 dB and the ambience by 6 dB for its duration', () => {
    const { sim, inner, frames } = rig();
    frames(5);
    const music = P(inner.mixer.musicMix.gain);
    const amb = P(inner.mixer.ambMix.gain);
    expect(music.target).toBeCloseTo(0.8, 9);
    sim.events.emit('subtitle', { speaker: 'Mama Lou', text: 'Bring me a car.', duration: 2 });
    frames(1);
    expect(music.target).toBeLessThanOrEqual(0.35);
    expect(db(music.target / 0.8)).toBeCloseTo(-9, 6);
    expect(db(amb.target)).toBeCloseTo(-6, 6);
    frames(110);
    expect(music.target).toBeLessThan(0.35);
    frames(12);
    expect(music.target).toBeCloseTo(0.8, 9);
    expect(amb.target).toBeCloseTo(1, 9);
  });

  it('an explosion 20 m away ducks the music within 50 ms and lets go within 1.5 s; one 100 m away does not', () => {
    const { sim, ctx, inner, frames } = rig();
    frames(5);
    const music = P(inner.mixer.musicMix.gain);
    const p = sim.playerPos();
    const t0 = ctx.currentTime;
    sim.events.emit('explosion', { x: p.x + 20, y: p.y, z: p.z - 5, radius: 7.5 });
    frames(1);
    expect(paramAt(music, t0 + 0.05)).toBeLessThanOrEqual(0.5);
    frames(90);
    expect(paramAt(music, t0 + 1.5)).toBeGreaterThanOrEqual(0.8 * Math.pow(10, -0.5 / 20));
    const far = rig();
    far.frames(5);
    const farMusic = P(far.inner.mixer.musicMix.gain);
    const q = far.sim.playerPos();
    const t1 = far.ctx.currentTime;
    far.sim.events.emit('explosion', { x: q.x + 100, y: q.y, z: q.z - 5, radius: 7.5 });
    far.frames(3);
    expect(paramAt(farMusic, t1 + 0.05)).toBeCloseTo(0.8, 6);
  });

  it('a result card ducks every bus but the UI 10 dB while it shows, and its sting plays on the UI bus', () => {
    const { sim, ctx, inner, frames } = rig();
    frames(5);
    const m = inner.mixer;
    const before = ctx.nodes.length;
    sim.events.emit('big', { text: 'WASTED', sub: '', style: 'wasted', duration: 1 });
    const sting = ctx.nodes.slice(before).filter((n): n is FakeGain => n instanceof FakeGain);
    expect(sting.length).toBeGreaterThan(0);
    for (const g of sting) expect(g.outputs[0]).toBe(m.uiBus);
    frames(1);
    expect(db(P(m.sfxMix.gain).target)).toBeCloseTo(-10, 6);
    expect(db(P(m.ambMix.gain).target)).toBeCloseTo(-10, 6);
    expect(db(P(m.vehMix.gain).target)).toBeCloseTo(-10, 6);
    expect(db(P(m.musicMix.gain).target / 0.8)).toBeCloseTo(-10, 6);
    expect(outputGain(m.uiBus)).toBeCloseTo(0.85 * 0.8, 6);
    frames(60);
    expect(P(m.sfxMix.gain).target).toBeCloseTo(1, 9);
    // A mission title card is not a result: no duck.
    sim.events.emit('big', { text: 'WHEELS', sub: 'Mama Lou', style: 'title', duration: 3 });
    frames(1);
    expect(P(m.sfxMix.gain).target).toBeCloseTo(1, 9);
  });

  it('in a car the world is muffled; with the radio on the engine steps back under it', () => {
    const { sim, audio, inner, frames } = rig();
    frames(2);
    const m = inner.mixer;
    seatInCar(sim);
    frames(2);
    expect(P(m.sfxLowpass.frequency).target).toBe(1800);
    expect(db(P(m.sfxMix.gain).target)).toBeCloseTo(-4, 6);
    expect(P((inner.ambience as unknown as { carFilter: { frequency: unknown } }).carFilter.frequency).target).toBe(900);
    expect(audio.radio.playing).toBe(true);
    expect(db(P(m.vehMix.gain).target)).toBeCloseTo(-7, 6);
    expect(P(m.vehHighpass.frequency).target).toBe(60);
    expect(P(m.vehPeak.gain).target).toBe(-4);
    expect(P(m.musicMix.gain).target).toBe(1);
    audio.radio.prev(); // RADIO OFF
    frames(2);
    expect(audio.radio.playing).toBe(false);
    expect(P(m.vehMix.gain).target).toBe(1);
    // The player's own shots from the car go to the vehicle bus, not through the muffling.
    const ctx = FakeAudioContext.last!;
    const before = ctx.nodes.length;
    const p = sim.playerPos();
    audio.gunshot('smg', p.x + 1, p.y + 1, p.z, true);
    const panner = ctx.nodes.slice(before).find((n) => n.kind === 'panner')!;
    expect(pathOf(panner)).toContain(m.vehicleBus as unknown as FakeNode);
  });

  it('the ambience falls back to the context rate where low-rate buffers are refused', () => {
    const audio = new AudioEngine();
    audio.unlock();
    const base = FakeAudioContext.last!;
    // A 48 kHz context that, like older browsers, refuses buffers below 22.05 kHz.
    const made: number[] = [];
    const ctx = Object.create(base, {
      sampleRate: { value: 48000 },
      createBuffer: {
        value: (channels: number, length: number, rate: number) => {
          if (rate < 22050) throw new DOMException('rate not supported', 'NotSupportedError');
          made.push(rate);
          return base.createBuffer(channels, length, rate);
        },
      },
    }) as FakeAudioContext;
    const Amb = (audio as unknown as Internals).ambience.constructor as new (c: unknown, d: unknown) => AmbienceT;
    const amb = new Amb(ctx, new FakeNode());
    expect((amb as unknown as { rate: number }).rate).toBe(48000);
    for (let i = 0; i < 6; i++) amb.update(1 / 60, base.currentTime, { district: 'park', hours: 23, shoreDist: 500, height: 0, traffic: 0, inVehicle: false, seaPan: 0, trafficPan: 0 });
    expect(amb.ready).toBe(true);
    expect(made.length).toBeGreaterThanOrEqual(4);
    expect(made.every((r) => r === 48000)).toBe(true);
  });

  it('60 s of the ambience bed create no new persistent nodes', () => {
    const { sim, ctx, inner, frames } = rig();
    frames(10);
    expect(inner.ambience.ready).toBe(true);
    inner.ambience.random = () => 0.999; // no one-shots
    const created = ctx.created;
    const p = sim.player;
    const spots: Array<[number, number, number]> = [
      [p.pos.x, p.pos.z, 12],
      [sim.world.bounds.beachStartX + 20, 0, 18.6],
      [0, 0, 23],
      [sim.world.bounds.landMinX + 10, 100, 3],
    ];
    for (const [x, z, h] of spots) {
      p.pos.x = x;
      p.pos.z = z;
      p.pos.y = sim.world.groundHeight(x, z);
      sim.clock.set(h);
      frames(900);
    }
    expect(ctx.created).toBe(created);
  });

  it('ambience one-shots play by place and time, at most two a second', () => {
    const { sim, ctx, inner, frames } = rig();
    const park = sim.world.layout.blocks.find((b) => b.district === 'park')!;
    const p = sim.player;
    p.pos.x = (park.rect.minX + park.rect.maxX) / 2 + 10;
    p.pos.z = (park.rect.minZ + park.rect.maxZ) / 2 + 10;
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    sim.clock.set(23);
    sim.clock.rate = 0;
    const amb = inner.ambience as unknown as { play: (kind: string) => void };
    const starts: Array<[string, number]> = [];
    const play = amb.play.bind(amb);
    amb.play = (kind: string, ...rest: unknown[]) => {
      starts.push([kind, ctx.currentTime]);
      (play as (...a: unknown[]) => void)(kind, ...rest);
    };
    frames(3600);
    expect(starts.length).toBeGreaterThan(20);
    expect(starts.length).toBeLessThanOrEqual(120);
    for (let i = 1; i < starts.length; i++) expect(starts[i]![1] - starts[i - 1]![1]).toBeGreaterThanOrEqual(0.5 - 1e-9);
    const kinds = new Set(starts.map((s) => s[0]));
    expect(kinds.has('crickets')).toBe(true);
    expect(kinds.has('birds')).toBe(false);
  });

  it('120 frames of driving create no new nodes after the first, and the engine wave is built once per kind', () => {
    const { sim, audio, ctx, inner, input, frames } = rig();
    const v = seatInCar(sim);
    audio.radio.prev(); // the radio's notes are one-shots: switch it off
    frames(10);
    inner.ambience.random = () => 0.999;
    expect(inner.engine.wavesBuilt).toBe(1);
    const created = ctx.created;
    frames(120, input({ throttle: 1 }));
    expect(ctx.created).toBe(created);
    expect(v.speed).toBeGreaterThan(10);
    expect(inner.engine.dips).toBeGreaterThan(0);
    expect(inner.engine.wavesBuilt).toBe(1);
    // Another kind builds its own wave; coming back reuses the first.
    const bus = sim.spawnVehicle('bus', v.pos.x + 30, v.pos.z, 0);
    sim.playerCtl.ejectPlayer(true);
    placeInCar(sim, bus);
    frames(2);
    expect(inner.engine.currentKind).toBe('bus');
    sim.playerCtl.ejectPlayer(true);
    placeInCar(sim, v);
    frames(2);
    expect(inner.engine.currentKind).toBe('sedan');
    expect(inner.engine.wavesBuilt).toBe(2);
  });

  it('an upshift under power dips the engine by at least 4 dB for 50-120 ms; a downshift does not', () => {
    const { sim, audio, ctx, inner, frames } = rig();
    const v = seatInCar(sim);
    frames(5);
    const dip = P(inner.engine.dip.gain);
    const step = () => {
      ctx.currentTime += 1 / 60;
      audio.update(1 / 60, sim, true);
    };
    v.controls.throttle = 1;
    v.gear = 2;
    const t0 = ctx.currentTime + 1 / 60;
    step();
    expect(inner.engine.dips).toBe(1);
    let min = 1;
    let first = Infinity;
    let last = -Infinity;
    let below4 = 0;
    for (let t = t0; t < t0 + 0.3; t += 0.0005) {
      const g = paramAt(dip, t);
      min = Math.min(min, g);
      if (g < 0.999) {
        first = Math.min(first, t);
        last = Math.max(last, t);
      }
      if (db(g) <= -4) below4 += 0.0005;
    }
    expect(db(min)).toBeLessThanOrEqual(-4);
    expect(last - first).toBeGreaterThanOrEqual(0.05);
    expect(last - first).toBeLessThanOrEqual(0.12);
    expect(below4).toBeGreaterThanOrEqual(0.04);
    for (let i = 0; i < 30; i++) step();
    v.gear = 1;
    step();
    expect(inner.engine.dips).toBe(1);
    // Rolling faster without the throttle is not a shift the engine feels.
    v.controls.throttle = 0;
    v.gear = 2;
    step();
    expect(inner.engine.dips).toBe(1);
  });

  it('a skid above 0.5 raises the tyre squeal; it stops with the skid', () => {
    const { sim, audio, ctx, inner, frames } = rig();
    const v = seatInCar(sim);
    frames(5);
    const eng = inner.engine as unknown as { squealGain: FakeGain; squeal1: FakeOscillator };
    const step = () => {
      ctx.currentTime += 1 / 60;
      audio.update(1 / 60, sim, true);
    };
    expect(eng.squealGain.gain.target).toBe(0);
    v.skid = 0.8;
    step();
    expect(eng.squealGain.gain.target).toBeGreaterThan(0.02);
    expect(eng.squeal1.frequency.target).toBeGreaterThanOrEqual(900);
    expect(eng.squeal1.frequency.target).toBeLessThanOrEqual(1400);
    v.skid = 0;
    step();
    expect(eng.squealGain.gain.target).toBe(0);
  });

  it('the player’s door thunks once on getting in and once on getting out', () => {
    const { sim, audio } = rig();
    const rp = roadPoint(sim);
    const v = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    audio.setListener(rp.x + 4, 2, rp.z + 4, 0);
    const n0 = audio.counters.doorThunks;
    sim.events.emit('vehicleEnter', { vehicle: v, character: sim.player, jacked: false });
    expect(audio.counters.doorThunks).toBe(n0 + 1);
    sim.events.emit('vehicleExit', { vehicle: v, character: sim.player });
    expect(audio.counters.doorThunks).toBe(n0 + 2);
    const npc = sim.spawnCharacter('civilian', rp.x + 3, rp.z);
    sim.events.emit('vehicleEnter', { vehicle: v, character: npc, jacked: false });
    expect(audio.counters.doorThunks).toBe(n0 + 2);
  });

  it('far explosions arrive at the speed of sound (up to 0.8 s late), and every one-shot is low-passed by distance', () => {
    const { sim, ctx, audio } = rig();
    const p = { ...sim.playerPos() };
    audio.setListener(p.x, p.y, p.z, 0);
    const blast = (d: number) => {
      const b = ctx.nodes.length;
      audio.explosion(p.x + d, p.y, p.z, 7.5);
      const made = ctx.nodes.slice(b);
      const start = Math.min(...made.filter((n): n is FakeSource => n instanceof FakeSource).map((n) => n.startAt));
      const lp = made.find((n) => n.kind === 'biquad') as FakeNode & { frequency: FakeParam };
      return { delay: start - ctx.currentTime, cutoff: lp.frequency.target };
    };
    const near = blast(50);
    expect(near.delay).toBeLessThan(0.02);
    expect(near.cutoff).toBeCloseTo(20000 * Math.exp(-50 / 120), 3);
    const far = blast(200);
    expect(far.delay).toBeCloseTo(0.01 + 200 / 343 + 1 / ctx.sampleRate, 6);
    expect(far.cutoff).toBeCloseTo(20000 * Math.exp(-200 / 120), 3);
    expect(blast(600).delay).toBeCloseTo(0.01 + 0.8 + 1 / ctx.sampleRate, 6);
  });

  it('sirens peak at 0.4 (8 dB louder than before) and screams 14 dB louder', () => {
    const { sim, ctx, audio, frames } = rig();
    frames(2);
    const p = sim.playerPos();
    const cop = sim.spawnVehicle('police', p.x, p.z - 5, 0);
    cop.siren = true;
    frames(1);
    const siren = (audio as unknown as { sirenNodes: { gain: FakeGain } }).sirenNodes.gain;
    // At the listener's own position the distance law gives the peak.
    expect(siren.gain.target).toBeGreaterThan(0.39);
    expect(siren.gain.target).toBeLessThanOrEqual(0.4);
    const b = ctx.nodes.length;
    const L = { ...sim.playerPos() };
    audio.setListener(L.x, L.y, L.z, 0);
    audio.scream(L.x, L.y, L.z);
    const env = ctx.nodes.slice(b).find((n): n is FakeGain => n instanceof FakeGain)!;
    const peak = Math.max(...env.gain.log.map((c) => (Number.isFinite(c.v) ? c.v : 0)));
    expect(db(peak / 0.12)).toBeCloseTo(14, 3);
  });

  it('the title screen moves the listener with its flyover camera', () => {
    const canvas = new FakeElement('canvas');
    const game = new Game(canvas as unknown as HTMLCanvasElement, new FakeElement('div') as unknown as HTMLElement);
    game.audio.unlock();
    game.step(1 / 60, { ui: {}, player: {} } as unknown as FrameInput);
    const cam = game.renderer.cameraCtl.camera.position;
    cam.set(12, 95, -40);
    game.step(1 / 60, { ui: {}, player: {} } as unknown as FrameInput);
    const L = (game.audio as unknown as { listener: { x: number; y: number; z: number } }).listener;
    expect([L.x, L.y, L.z]).toEqual([cam.x, cam.y, cam.z]);
    expect(game.mode).toBe('title');
  });

  it('broken vehicle or camera state never reaches an AudioParam', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sim, audio, ctx } = rig();
    const v = seatInCar(sim);
    for (let i = 0; i < 12; i++) {
      ctx.currentTime += 1 / 60;
      audio.update(1 / 60, sim, true);
    }
    Object.assign(v, { speed: NaN, skid: NaN, gear: NaN, rpm: Infinity });
    v.controls.throttle = NaN;
    sim.clock.hours = NaN;
    audio.setListener(NaN, NaN, NaN, NaN);
    for (let i = 0; i < 3; i++) {
      ctx.currentTime += 1 / 60;
      audio.update(1 / 60, sim, true);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
