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

class FakeParam {
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
  }
  setValueAtTime(v: number, t: number): this {
    this.check(v, t);
    this.target = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.check(v, t);
    this.target = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.check(v, t);
    if (v === 0) throw new RangeError('The float target value provided (0) should not be in the range (-1.40130e-45, 1.40130e-45).');
    this.target = v;
    return this;
  }
  setTargetAtTime(v: number, t: number, tc: number): this {
    this.check(v, t, tc);
    this.target = v;
    return this;
  }
  cancelScheduledValues(t: number): this {
    this.check(t);
    return this;
  }
}

class FakeNode {
  readonly outputs: unknown[] = [];
  connect<T>(d: T): T {
    this.outputs.push(d);
    return d;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  readonly playbackRate = new FakeParam(1);
  startAt = 0;
  offset = 0;
  stopAt = Infinity;
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
  start(): void {}
  stop(): void {}
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  currentTime = 1;
  state = 'running';
  readonly sampleRate = 8000;
  readonly destination = new FakeNode();
  readonly sources: FakeSource[] = [];
  constructor() {
    FakeAudioContext.last = this;
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
  createDynamicsCompressor(): FakeNode {
    return Object.assign(new FakeNode(), { threshold: new FakeParam(-24), ratio: new FakeParam(12) });
  }
  createBiquadFilter(): FakeNode {
    return Object.assign(new FakeNode(), { type: 'lowpass', frequency: new FakeParam(350), Q: new FakeParam(1), gain: new FakeParam(0) });
  }
  createOscillator(): FakeOscillator {
    return new FakeOscillator();
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createStereoPanner(): FakeNode {
    return Object.assign(new FakeNode(), { pan: new FakeParam(0) });
  }
  createDelay(): FakeNode {
    return Object.assign(new FakeNode(), { delayTime: new FakeParam(0) });
  }
  createBuffer(_channels: number, length: number, rate: number): unknown {
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
    let exits = 0;
    sim.events.on('vehicleExit', () => exits++);
    for (const ch of 'FIXMYRIDE') key(`Key${ch}`, ch.toLowerCase());
    // F got the player out, and the cheat put him back; its M no longer opens the map (round 2: typed cheats without side effects).
    expect(exits).toBe(1);
    expect(sim.player.vehicle).toBe(v);
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
    // No menu to close any more, and the player is back at the wheel (round 2: typed cheats without side effects).
    expect(game.menus.open).toBe(false);
    expect(sim.player.vehicle).toBe(v);
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
// Round 2 (harness): pointer lock under automation, the jump that comes with a re-lock, and typed cheats.

describe('round 2 harness', () => {
  /** A fake performance.now() the tests below advance by hand. */
  const clock = { now: 1000 };

  /** QWERTY letters whose keys have a binding (see BOUND_CODES and LETTER_SHORTCUTS in input.ts). */
  const BOUND_LETTERS = new Set('WASDFEHRQTPMV');
  const CODES = ['CHILLOUT', 'GUNSGALORE', 'FIXMYRIDE', 'IMMORTAL', 'MONEYTREE', 'SUNSET', 'NIGHTOWL', 'SPAWNSPORTS', 'COPMAGNET'] as const;

  describe('pointer lock under browser automation', () => {
    it('is refused under webdriver: no request is made and clicks shoot unlocked', () => {
      vi.stubGlobal('navigator', { webdriver: true, getGamepads: () => [] });
      const canvas = new FakeElement('canvas');
      const inp = new Input(canvas as unknown as HTMLCanvasElement);
      inp.attach();
      inp.wantsPointerLock = () => true; // in game, no menu open
      // The capture click itself already shoots.
      canvas.dispatchEvent(ev('mousedown', { button: 0 }));
      const first = inp.poll(1 / 60);
      inp.endFrame();
      expect(first.player.fire).toBe(true);
      expect(first.player.firePressed).toBe(true);
      dom.win.dispatchEvent(ev('mouseup', { button: 0 }));
      expect(inp.requestPointerLock()).toBe(false);
      canvas.dispatchEvent(ev('mousedown', { button: 0 }));
      expect(inp.poll(1 / 60).player.fire).toBe(true);
      expect(dom.lockRequests).toBe(0);
    });

    it('lock=1 in the URL asks for it anyway', () => {
      vi.stubGlobal('navigator', { webdriver: true, getGamepads: () => [] });
      vi.stubGlobal('location', { search: '?intro=0&lock=1' });
      const inp = newInput();
      inp.attach();
      expect(inp.requestPointerLock()).toBe(true);
      expect(dom.lockRequests).toBe(1);
    });

    it('a new game under automation never asks for the lock, so it never pauses for losing it', async () => {
      vi.stubGlobal('navigator', { webdriver: true, getGamepads: () => [] });
      const canvas = new FakeElement('canvas');
      const game = new Game(canvas as unknown as HTMLCanvasElement, new FakeElement('div') as unknown as HTMLElement);
      game.newGame();
      await flush();
      canvas.dispatchEvent(ev('mousedown', { button: 0 }));
      dom.doc.dispatchEvent(new Event('pointerlockchange'));
      expect(dom.lockRequests).toBe(0);
      expect(game.menus.open).toBe(false);
    });
  });

  describe('re-capturing the mouse does not swing the camera', () => {
    beforeEach(() => {
      clock.now = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    });

    function setup() {
      const canvas = new FakeElement('canvas');
      const inp = new Input(canvas as unknown as HTMLCanvasElement);
      inp.attach();
      const lock = () => {
        dom.doc.pointerLockElement = canvas;
        dom.doc.dispatchEvent(new Event('pointerlockchange'));
      };
      /** One mouse move, then a frame: the look input it produced. */
      const move = (x: number, y: number) => {
        dom.win.dispatchEvent(ev('mousemove', { movementX: x, movementY: y }));
        const fi = inp.poll(1 / 60);
        inp.endFrame();
        return [fi.lookX, fi.lookY];
      };
      return { lock, move };
    }

    it('drops the jump by the cursor offset that comes with the lock', () => {
      const { lock, move } = setup();
      lock();
      expect(move(-640, -360)).toEqual([0, 0]);
      clock.now += 50;
      expect(move(5, 3)).toEqual([0, 0]); // still settling
      clock.now += 100;
      expect(move(5, 3)).toEqual([5, 3]);
    });

    it('drops a single move of more than a third of the window', () => {
      const { lock, move } = setup();
      lock();
      clock.now += 150;
      expect(move(900, 0)).toEqual([0, 0]); // 1280 / 3 = 427
      expect(move(300, 0)).toEqual([300, 0]);
      expect(move(0, 250)).toEqual([0, 0]); // 720 / 3 = 240
      expect(move(-200, 200)).toEqual([-200, 200]);
      expect(move(NaN, 0)).toEqual([0, 0]);
    });

    it('closing the map leaves the camera where it was', async () => {
      const canvas = new FakeElement('canvas');
      const game = new Game(canvas as unknown as HTMLCanvasElement, new FakeElement('div') as unknown as HTMLElement);
      const g = game as unknown as { running: boolean; last: number; frame: (now: number) => void };
      g.running = true;
      g.last = clock.now;
      const frames = (n: number) => {
        for (let i = 0; i < n; i++) {
          clock.now += 1000 / 60;
          g.frame(clock.now);
        }
      };
      const key = (code: string, k: string) => {
        dom.win.dispatchEvent(keyEv('keydown', code, k));
        frames(2);
        dom.win.dispatchEvent(keyEv('keyup', code, k));
        frames(1);
      };
      game.newGame();
      await flush();
      frames(5);
      const cam = game.renderer.cameraCtl;
      key('KeyM', 'm');
      await flush();
      expect(game.menus.open).toBe(true);
      frames(20);
      const yaw = cam.yaw;
      const pitch = cam.pitch;
      key('KeyM', 'm'); // closes the map and re-captures the mouse
      await flush();
      expect(dom.doc.pointerLockElement).toBe(canvas);
      // What Chrome sends next: a move by minus the cursor position.
      dom.win.dispatchEvent(ev('mousemove', { movementX: -640, movementY: -360 }));
      frames(2);
      expect(cam.yaw).toBe(yaw);
      expect(cam.pitch).toBe(pitch);
    });
  });

  describe('typed cheat codes', () => {
    beforeEach(() => {
      clock.now = 5000;
      vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    });

    /** The action edges a key could fire. */
    const edges = (f: FrameInput) => ({
      enterExit: f.player.enterExit,
      interact: f.player.interact,
      job: f.player.job,
      reload: f.player.reload,
      horn: f.player.hornPressed,
      prevWeapon: f.player.prevWeapon,
      radio: f.ui.radioNext || f.ui.radioPrev,
      camera: f.ui.camera,
      map: f.ui.map,
      pause: f.ui.pause,
    });
    const NO_EDGES = { enterExit: false, interact: false, job: false, reload: false, horn: false, prevWeapon: false, radio: false, camera: false, map: false, pause: false };
    /** Any input at all, movement and menu navigation included. */
    const anything = (f: FrameInput) =>
      Object.values(edges(f)).some(Boolean) || f.player.moveX !== 0 || f.player.moveZ !== 0 || f.player.horn || f.ui.up || f.ui.down || f.ui.left || f.ui.right || f.ui.confirm || f.ui.back;

    function setup(inVehicle = false) {
      const inp = newInput();
      inp.attach();
      inp.inVehicle = inVehicle;
      const taken: string[] = [];
      /** Types `text` at `ms` per key (each held for half of it); returns the input of the frame after each keydown. */
      const type = (text: string, ms = 130): FrameInput[] =>
        [...text].map((ch) => {
          const code = `Key${ch.toUpperCase()}`;
          dom.win.dispatchEvent(keyEv('keydown', code, ch.toLowerCase()));
          const fi = inp.poll(1 / 60);
          inp.endFrame();
          clock.now += ms / 2;
          dom.win.dispatchEvent(keyEv('keyup', code, ch.toLowerCase()));
          inp.poll(1 / 60);
          inp.endFrame();
          clock.now += ms / 2;
          taken.push(...inp.takeCheats().map((t) => t.code));
          return fi;
        });
      return { inp, type, taken };
    }

    it('each of the 9 codes is taken once, and from its third letter on its keys fire no action', () => {
      for (const inVehicle of [false, true]) {
        for (const code of CODES) {
          const { inp, type, taken } = setup(inVehicle);
          const frames = type(code);
          expect(taken, code).toEqual([code]);
          frames.forEach((f, i) => {
            if (i >= 2) expect(edges(f), `${code} letter ${i + 1}${inVehicle ? ' in a car' : ''}`).toEqual(NO_EDGES);
          });
          inp.detach();
        }
      }
    });

    it('once the letters typed include an unbound key, the code does nothing else at all', () => {
      for (const code of CODES) {
        const { inp, type } = setup();
        const frames = type(code);
        // From the third letter, as soon as one letter so far has no binding (play never types those).
        let from = 2;
        while (![...code.slice(0, from + 1)].some((ch) => !BOUND_LETTERS.has(ch))) from++;
        frames.forEach((f, i) => {
          if (i >= from) expect(anything(f), `${code} letter ${i + 1}`).toBe(false);
        });
        inp.detach();
      }
    });

    it("a code's first letters still act (Game undoes them)", () => {
      const first = (code: string) => {
        const { inp, type } = setup();
        const frames = type(code);
        inp.detach();
        return frames;
      };
      expect(first('FIXMYRIDE')[0]!.player.enterExit).toBe(true);
      expect(first('MONEYTREE')[0]!.ui.map).toBe(true);
      expect(first('IMMORTAL')[1]!.ui.map).toBe(true);
      expect(first('SPAWNSPORTS')[1]!.ui.pause).toBe(true);
      // S P A W are all keys of play (back, pause, left, forward): they act until the N.
      expect(first('SPAWNSPORTS')[3]!.player.moveZ).toBe(1);
      expect(first('COPMAGNET')[2]!.ui.pause).toBe(false);
    });

    it('play (WASD, SPAM) and codes typed with long pauses match nothing and swallow no key', () => {
      const { type, taken } = setup();
      const does: Record<string, (f: FrameInput) => boolean> = {
        W: (f) => f.player.moveZ === 1,
        A: (f) => f.player.moveX === -1,
        S: (f) => f.player.moveZ === -1,
        D: (f) => f.player.moveX === 1,
        P: (f) => f.ui.pause,
        M: (f) => f.ui.map,
        F: (f) => f.player.enterExit,
        R: (f) => f.player.reload,
        E: (f) => f.player.interact,
        T: (f) => f.player.job,
      };
      const check = (text: string, ms = 130) =>
        type(text, ms).forEach((f, i) => {
          const act = does[text[i]!];
          if (act) expect(act(f), `${text} letter ${i + 1}`).toBe(true);
        });
      check('WASD');
      check('SPAM');
      check('WASDSPAMWASD');
      check('FIX');
      clock.now += 2000;
      check('MYRIDE');
      check('SUNSET', 1600); // slower than 1.5 s a key
      expect(taken).toEqual([]);
    });

    it('a held key typing a code stays swallowed while it repeats, and acts again once pressed anew', () => {
      const { inp, type } = setup();
      type('COP'.slice(0, 2));
      dom.win.dispatchEvent(keyEv('keydown', 'KeyP', 'p'));
      dom.win.dispatchEvent(ev('keydown', { code: 'KeyP', key: 'p', repeat: true }));
      expect(inp.poll(1 / 60).ui.pause).toBe(false);
      inp.endFrame();
      dom.win.dispatchEvent(keyEv('keyup', 'KeyP', 'p'));
      clock.now += 2000;
      dom.win.dispatchEvent(keyEv('keydown', 'KeyP', 'p'));
      expect(inp.poll(1 / 60).ui.pause).toBe(true);
    });
  });

  describe('typed cheats in the game', () => {
    beforeEach(() => {
      clock.now = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    });

    async function playing() {
      const game = new Game(new FakeElement('canvas') as unknown as HTMLCanvasElement, new FakeElement('div') as unknown as HTMLElement);
      const g = game as unknown as { running: boolean; last: number; frame: (now: number) => void };
      g.running = true;
      g.last = clock.now;
      const frames = (n: number) => {
        for (let i = 0; i < n; i++) {
          clock.now += 1000 / 60;
          g.frame(clock.now);
        }
      };
      /** Types `text` at `perKey` frames a key (8 frames: 133 ms). */
      const type = (text: string, perKey = 8) => {
        for (const ch of text) {
          const code = `Key${ch.toUpperCase()}`;
          dom.win.dispatchEvent(keyEv('keydown', code, ch.toLowerCase()));
          frames(perKey / 2);
          dom.win.dispatchEvent(keyEv('keyup', code, ch.toLowerCase()));
          frames(perKey / 2);
        }
      };
      /** Presses a key that is not a letter (Escape). */
      const press = (code: string) => {
        dom.win.dispatchEvent(keyEv('keydown', code, code));
        frames(2);
        dom.win.dispatchEvent(keyEv('keyup', code, code));
        frames(2);
      };
      game.newGame();
      await flush();
      frames(3);
      return { game, sim: game.sim, frames, type, press };
    }

    it('FIXMYRIDE in a car at 20 m/s: its F bails out, and the cheat puts the player back in his repaired car', async () => {
      const { game, sim, frames, type } = await playing();
      const lane = [...sim.roads.lanes].sort((a, b) => b.length - a.length)[0]!;
      const v = sim.spawnVehicle('sedan', lane.sx + lane.dx * 5, lane.sz + lane.dz * 5, lane.heading);
      placeInCar(sim, v);
      v.health = v.spec.health * 0.4;
      v.vel.x = lane.dx * 20;
      v.vel.z = lane.dz * 20;
      frames(1);
      let bails = 0;
      sim.events.on('vehicleExit', () => bails++);
      type('FIXMYRIDE');
      expect(bails).toBe(1);
      frames(30);
      expect(sim.player.vehicle).toBe(v);
      expect(sim.player.state).toBe('inVehicle');
      expect(v.health).toBe(v.spec.health);
      expect(sim.player.health).toBe(sim.player.maxHealth); // the bail's 6 health came back
      expect(game.menus.open).toBe(false);
    });

    it('FIXMYRIDE in a bus at 10 m/s: its F brakes before getting out, and the cheat still ends with the player at the wheel', async () => {
      const { sim, frames, type } = await playing();
      const lane = [...sim.roads.lanes].sort((a, b) => b.length - a.length)[0]!;
      const v = sim.spawnVehicle('bus', lane.sx + lane.dx * 8, lane.sz + lane.dz * 8, lane.heading);
      placeInCar(sim, v);
      v.vel.x = lane.dx * 10.9;
      v.vel.z = lane.dz * 10.9;
      frames(1);
      let exits = 0;
      sim.events.on('vehicleExit', () => exits++);
      type('FIXMYRIDE');
      frames(60);
      expect(exits).toBe(1);
      expect(sim.player.vehicle).toBe(v);
      expect(sim.player.health).toBe(sim.player.maxHealth); // a stop-and-get-out, not a bail
    });

    it('FIXMYRIDE typed slowly (350 ms a key) at 20 m/s still puts the player back at the wheel', async () => {
      const { sim, frames, type } = await playing();
      const lane = [...sim.roads.lanes].sort((a, b) => b.length - a.length)[0]!;
      const v = sim.spawnVehicle('sedan', lane.sx + lane.dx * 5, lane.sz + lane.dz * 5, lane.heading);
      placeInCar(sim, v);
      v.vel.x = lane.dx * 20;
      v.vel.z = lane.dz * 20;
      frames(1);
      type('FIXMYRIDE', 21);
      frames(10);
      expect(sim.player.vehicle).toBe(v);
      expect(v.health).toBe(v.spec.health);
    });

    it('an exit the player made himself before typing FIXMYRIDE is not undone', async () => {
      const { game, sim, frames, type, press } = await playing();
      const rp = roadPoint(sim);
      const v = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
      placeInCar(sim, v);
      v.health = v.spec.health * 0.5;
      frames(2);
      type('F'); // gets out
      expect(sim.player.vehicle).toBe(null);
      press('Escape'); // and pauses, so the code's own F does nothing
      type('FIXMYRIDE');
      frames(10);
      expect(sim.player.vehicle).toBe(null);
      expect(v.health).toBe(v.spec.health); // still the ride that gets fixed
      expect(game.menus.open).toBe(true);
    });

    it("SUNSET typed on Mama Lou's marker starts no mission and sets the clock", async () => {
      const { game, sim, frames, type } = await playing();
      const lou = sim.world.layout.pois.find((q) => q.id === 'lou')!;
      sim.player.pos.x = lou.x;
      sim.player.pos.z = lou.z;
      sim.player.pos.y = sim.world.groundHeight(lou.x, lou.z);
      frames(5);
      expect(sim.interactions.prompt()).toContain('Wheels');
      type('SUNSET');
      frames(30);
      expect(sim.missions.active).toBe(null);
      expect(sim.clock.hours).toBeCloseTo(18.3, 1);
      expect(game.menus.open).toBe(false);
      // Whereas E alone does start it.
      type('E');
      expect(sim.missions.active?.def.id).toBe('wheels');
    });

    it('MONEYTREE adds $50,000 and closes the map its M opened', async () => {
      const { game, sim, frames, type } = await playing();
      const money = sim.progress.money;
      type('M');
      expect(game.menus.open).toBe(true);
      type('ONEYTREE');
      frames(30);
      expect(sim.progress.money).toBe(money + 50000);
      expect(game.menus.open).toBe(false);
    });

    it('IMMORTAL and SPAWNSPORTS close the map and the pause menu their first letters opened', async () => {
      const { game, sim, frames, type } = await playing();
      let opened = 0;
      const sports = () => sim.vehicles.filter((v) => v.kind === 'sports').length;
      const cars = sports();
      for (const code of ['IMMORTAL', 'SPAWNSPORTS']) {
        for (const ch of code) {
          type(ch);
          if (game.menus.open) opened++;
        }
        frames(30);
        expect(game.menus.open, code).toBe(false);
      }
      expect(opened).toBeGreaterThan(0);
      expect(sim.cheats.godMode).toBe(true);
      expect(sports()).toBe(cars + 1);
    });

    it('MONEYTREE typed slowly (350 ms a key) still closes the map its M opened', async () => {
      const { game, sim, frames, type } = await playing();
      const money = sim.progress.money;
      type('MONEYTREE', 21);
      frames(30);
      expect(sim.progress.money).toBe(money + 50000);
      expect(game.menus.open).toBe(false);
    });

    it('a pause menu opened with Escape just before a code stays open', async () => {
      const { game, sim, frames, type, press } = await playing();
      sim.wanted.setLevel(2);
      press('Escape');
      expect(game.menus.open).toBe(true);
      type('CHILLOUT');
      frames(30);
      expect(sim.wanted.level).toBe(0);
      expect(game.menus.open).toBe(true);
    });

    it('so does one opened with Escape in the middle of a code', async () => {
      const { game, sim, frames, type, press } = await playing();
      type('SUN');
      press('Escape');
      expect(game.menus.open).toBe(true);
      type('SET');
      frames(30);
      expect(sim.clock.hours).toBeCloseTo(18.3, 1);
      expect(game.menus.open).toBe(true);
    });

    it('and one already open when a code types its M: the M opened nothing', async () => {
      const { game, sim, frames, type } = await playing();
      type('P');
      expect(game.menus.open).toBe(true);
      frames(20);
      type('IMMORTAL');
      frames(30);
      expect(sim.cheats.godMode).toBe(true);
      expect(game.menus.open).toBe(true);
    });

    it('only the screen a key opened is closed: a shop opened meanwhile stays open', async () => {
      const { game, sim, frames, type } = await playing();
      type('M');
      frames(20); // past the map's input guard
      type('M'); // closes it again
      expect(game.menus.open).toBe(false);
      sim.events.emit('shopOpen', { poi: 'guns_south' });
      expect(game.menus.open).toBe(true);
      type('SUNSET'); // all within 2 s of opening the map
      frames(10);
      expect(sim.clock.hours).toBeCloseTo(18.3, 1);
      expect(game.menus.open).toBe(true);
    });

    it('a screen opened well before the code was typed stays open', async () => {
      const { game, sim, frames, type } = await playing();
      type('M');
      expect(game.menus.open).toBe(true);
      frames(180); // 3 s on the map
      type('NIGHTOWL');
      frames(10);
      expect(sim.clock.hours).toBeCloseTo(23, 1);
      expect(game.menus.open).toBe(true);
    });
  });

  describe('crash resilience in the game', () => {
    function running() {
      const uiRoot = new FakeElement('div');
      const game = new Game(new FakeElement('canvas') as unknown as HTMLCanvasElement, uiRoot as unknown as HTMLElement);
      const g = game as unknown as { running: boolean; last: number; frame: (now: number) => void };
      let now = 1000;
      g.running = true;
      g.last = now;
      const frames = (n: number) => {
        for (let i = 0; i < n; i++) {
          now += 1000 / 60;
          g.frame(now);
        }
      };
      const button = (label: string) => uiRoot.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label);
      return { game, uiRoot, frames, button };
    }

    it('a menu action that throws shows the error screen instead of escaping the click', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { game, uiRoot, button } = running();
      vi.spyOn(game, 'newGame').mockImplementation(() => {
        throw new Error('broken new game');
      });
      expect(() => button('NEW GAME')!.click()).not.toThrow();
      expect(game.isCrashed).toBe(true);
      expect(uiRoot.children.some((c) => c.classList.contains('error'))).toBe(true);
      expect(err).toHaveBeenCalledWith('GTA7 crashed', expect.any(Error));
    });

    it("leaving the gun shop with a broken resume shows the error screen too (the shop's LEAVE is a DOM click)", async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { game, button } = running();
      game.newGame();
      await flush();
      game.sim.events.emit('shopOpen', { poi: 'guns_south' });
      vi.spyOn(game, 'resume').mockImplementation(() => {
        throw new Error('broken resume');
      });
      expect(() => button('LEAVE')!.click()).not.toThrow();
      expect(game.isCrashed).toBe(true);
    });

    it('COPY DETAILS copies a report of the session and its last events', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal('navigator', { getGamepads: () => [], clipboard: { writeText }, userAgent: 'FakeBrowser/1.0' });
      const { game, frames, button } = running();
      game.newGame();
      await flush();
      frames(2);
      const sim = game.sim;
      for (let i = 0; i < 40; i++) sim.events.emit('explosion', { x: i, y: 0, z: 0, radius: 7.5 });
      sim.events.emit('message', { text: 'Last words.', duration: 1 });
      vi.spyOn(game.hud, 'update').mockImplementation(() => {
        throw new Error('hud exploded');
      });
      frames(1);
      expect(game.isCrashed).toBe(true);
      button('COPY DETAILS')!.click();
      await flush();
      expect(writeText).toHaveBeenCalledTimes(1);
      const report = (writeText.mock.calls[0] as unknown as [string])[0];
      expect(report).toContain('Error: hud exploded');
      expect(report).toContain('mode: game');
      expect(report).toMatch(/sim time: \d+\.\d\d s/);
      expect(report).toContain('mission: none');
      expect(report).toMatch(/zone: \S+/);
      expect(report).toMatch(/player: normal, health 100, armor 0, fists, vehicle none, wanted 0/);
      // The setting defaults to 'auto', which the fake DOM (no WebGL, unknown GPU) resolves to Medium.
      expect(report).toContain('quality: auto (rendering medium)');
      expect(report).toContain('browser: FakeBrowser/1.0');
      // Only the last 30 events are kept, the newest last.
      const events = report.slice(report.indexOf('last 30 events'));
      expect(events.split('\n')).toHaveLength(31);
      expect(events).not.toContain('explosion at 9, 0');
      expect(events).toContain('explosion at 39, 0');
      expect(events.trimEnd().endsWith('message Last words.')).toBe(true);
      expect(button('COPIED')).toBeDefined();
    });

    it('without a clipboard the report is shown to copy by hand', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { game, uiRoot, frames, button } = running();
      game.newGame();
      await flush();
      vi.spyOn(game.hud, 'update').mockImplementation(() => {
        throw new Error('hud exploded');
      });
      frames(1);
      const area = uiRoot.all().find((e) => e.tagName === 'TEXTAREA')! as FakeElement & { hidden: boolean; focus(): void; select(): void };
      let selected = false;
      area.focus = () => undefined;
      area.select = () => {
        selected = true;
      };
      expect(area.hidden).toBe(true);
      button('COPY DETAILS')!.click();
      expect(area.hidden).toBe(false);
      expect(selected).toBe(true);
      expect(area.value).toContain('Error: hud exploded');
    });
  });
});

// ---------------------------------------------------------------------------
// Round 2 (quality): graphics tiers in the Game and the settings row, and WebGL context loss.

/** A Game on the fake DOM, driven frame by frame (as in 'game flows'). */
function makeQualityGame() {
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
  const overlay = () => uiRoot.children.find((c) => c.classList.contains('gfx-lost')) ?? null;
  const sfx = () => (game.audio as unknown as { sfx: unknown }).sfx;
  return { game, canvas, uiRoot, frames, overlay, sfx };
}

describe('r2 quality: tiers in the game and the settings row', () => {
  it("resolves 'auto' once at boot and gives every sim the tier's traffic and pedestrian density", () => {
    const { game } = makeQualityGame();
    // No usable WebGL here, so the GPU is unknown: Auto means Medium.
    expect(game.settings.quality).toBe('auto');
    expect(game.autoTier).toBe('medium');
    expect(game.renderer.currentQuality).toBe('medium');
    expect([game.sim.traffic.density, game.sim.peds.density]).toEqual([0.9, 0.9]); // the title's sim
    game.newGame();
    const sim = game.sim;
    expect([sim.traffic.density, sim.peds.density]).toEqual([0.9, 0.9]);
    game.applySettings({ ...game.settings, quality: 'low' }, false);
    expect(game.renderer.currentQuality).toBe('low');
    expect([sim.traffic.density, sim.peds.density]).toEqual([0.75, 0.75]);
    const lowTargets = [sim.traffic.targetCount, sim.peds.targetCount];
    game.applySettings({ ...game.settings, quality: 'high' }, false);
    expect([sim.traffic.density, sim.peds.density]).toEqual([1, 1]);
    // Fewer ambient cars and people are kept around on Low.
    expect(lowTargets[0]).toBeLessThan(sim.traffic.targetCount);
    expect(lowTargets[1]).toBeLessThan(sim.peds.targetCount);
    game.applySettings({ ...game.settings, quality: 'auto' }, false);
    expect(game.renderer.currentQuality).toBe('medium');
    expect(sim.traffic.density).toBe(0.9);
  });

  it('a saved fixed tier wins over Auto at boot', () => {
    (dom.win as unknown as { localStorage: FakeStorage }).localStorage.setItem('gta7.settings.v1', JSON.stringify({ quality: 'low', master: 0.8, music: 0.6, sfx: 0.85, sensitivity: 1, invertY: false, fov: 68 }));
    const { game } = makeQualityGame();
    expect(game.settings.quality).toBe('low');
    expect(game.renderer.currentQuality).toBe('low');
    expect([game.sim.traffic.density, game.sim.peds.density]).toEqual([0.75, 0.75]);
  });

  it('the settings row offers AUTO (tier) and says when the anti-aliasing change waits for a reload', () => {
    let applied: Settings | null = null;
    let current: Settings = { quality: 'high', master: 0.8, music: 0.6, sfx: 0.85, sensitivity: 1, invertY: false, fov: 68 };
    const host = stubHost({
      settings: () => current,
      applySettings: (s) => {
        applied = s;
        current = s;
      },
      quality: () => ({ auto: 'high', msaa: true }),
    });
    const menus = new Menus(new FakeElement('div') as unknown as HTMLElement, host, new MapImage(world()));
    menus.showSettings();
    const top = menus.top!.el as unknown as FakeElement;
    const select = top.all().find((e) => e.tagName === 'SELECT')!;
    const note = top.all().find((e) => e.classList.contains('setting-note'))!;
    expect(select.children.map((o) => o.textContent)).toEqual(['AUTO (HIGH)', 'LOW', 'MEDIUM', 'HIGH']);
    expect(select.children.map((o) => o.value)).toEqual(['auto', 'low', 'medium', 'high']);
    expect(note.classList.contains('hidden')).toBe(true);
    const pick = (q: string) => {
      select.value = q;
      select.dispatchEvent(new Event('change'));
    };
    pick('low');
    expect(applied!.quality).toBe('low');
    expect(note.classList.contains('hidden')).toBe(false);
    expect(note.textContent).toBe('Anti-aliasing turns off after a reload.');
    pick('medium');
    expect(note.classList.contains('hidden')).toBe(true);
    pick('auto');
    expect(applied!.quality).toBe('auto');
    expect(note.classList.contains('hidden')).toBe(true);
    // Keyboard / gamepad: left and right walk AUTO, LOW, MEDIUM, HIGH and stop at the ends.
    const press = (over: Partial<UiActions>) => menus.input({ ...NO_UI, ...over }, 0.3);
    press({ right: true });
    expect(current.quality).toBe('low');
    press({ left: true });
    press({ left: true });
    expect(current.quality).toBe('auto');
    // A renderer started on Low (no MSAA) says the opposite for Medium and High.
    menus.closeAll();
    const lowHost = stubHost({ settings: () => current, quality: () => ({ auto: 'low', msaa: false }) });
    const m2 = new Menus(new FakeElement('div') as unknown as HTMLElement, lowHost, new MapImage(world()));
    m2.showSettings();
    const top2 = m2.top!.el as unknown as FakeElement;
    const select2 = top2.all().find((e) => e.tagName === 'SELECT')!;
    const note2 = top2.all().find((e) => e.classList.contains('setting-note'))!;
    expect(select2.children[0]!.textContent).toBe('AUTO (LOW)');
    expect(note2.classList.contains('hidden')).toBe(true);
    select2.value = 'high';
    select2.dispatchEvent(new Event('change'));
    expect(note2.textContent).toBe('Anti-aliasing turns on after a reload.');
  });
});

describe('r2 quality: WebGL context loss', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses under an overlay with the sim frozen, and comes back to a paused game when restored', async () => {
    const { game, canvas, uiRoot, frames, overlay, sfx } = makeQualityGame();
    game.newGame();
    await flush();
    frames(5);
    expect(dom.doc.pointerLockElement).toBe(canvas);
    const t0 = game.sim.time;
    const lost = ev('webglcontextlost');
    canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true); // so the browser may restore it
    expect(game.contextLost).toBe(true);
    expect(overlay()!.textContent).toContain('Graphics reset - restoring...');
    // Paused at once, not only when the lost pointer lock is reported.
    expect(game.menus.open).toBe(true);
    await flush();
    expect(dom.doc.pointerLockElement).toBe(null);
    expect(outputGain(sfx())).toBe(0);
    expect(game.menus.open).toBe(true); // the pause menu waits under the overlay
    frames(60);
    // Keys reach nothing while the context is gone.
    dom.win.dispatchEvent(keyEv('keydown', 'Escape', 'Escape'));
    frames(3);
    dom.win.dispatchEvent(keyEv('keyup', 'Escape', 'Escape'));
    expect(game.sim.time).toBe(t0);
    expect(game.menus.open).toBe(true);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(game.contextLost).toBe(false);
    expect(overlay()).toBe(null);
    const top = game.menus.top!.el as unknown as FakeElement;
    expect(top.all().some((e) => e.tagName === 'H2' && e.textContent === 'PAUSED')).toBe(true);
    frames(30);
    expect(game.sim.time).toBe(t0); // still paused
    uiRoot.all().find((e) => e.tagName === 'BUTTON' && e.textContent === 'RESUME')!.click();
    await flush();
    frames(10);
    expect(game.menus.open).toBe(false);
    expect(game.sim.time).toBeGreaterThan(t0);
    expect(outputGain(sfx())).toBeGreaterThan(0);
  });

  it('after 10 s without a restore it asks for a reload, and still recovers if the context comes back later', async () => {
    const { game, canvas, uiRoot, frames, overlay } = makeQualityGame();
    game.newGame();
    await flush();
    frames(2);
    const reload = vi.fn();
    vi.stubGlobal('location', { reload, search: '' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    canvas.dispatchEvent(ev('webglcontextlost'));
    vi.advanceTimersByTime(9_900);
    expect(overlay()!.textContent).toContain('restoring');
    expect(overlay()!.all().some((e) => e.tagName === 'BUTTON')).toBe(false);
    vi.advanceTimersByTime(200);
    expect(uiRoot.children.filter((c) => c.classList.contains('gfx-lost')).length).toBe(1);
    expect(overlay()!.textContent).toContain('Graphics could not be restored. Reload the page.');
    const button = overlay()!.all().find((e) => e.tagName === 'BUTTON' && e.textContent === 'RELOAD')!;
    button.click();
    expect(reload).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(overlay()).toBe(null);
    expect(game.contextLost).toBe(false);
    expect(game.menus.open).toBe(true);
  });

  it('on the title screen the backdrop freezes and carries on once restored', () => {
    const { game, canvas, frames, overlay, sfx } = makeQualityGame();
    game.audio.unlock();
    frames(5);
    expect(game.mode).toBe('title');
    const t0 = game.sim.time;
    canvas.dispatchEvent(ev('webglcontextlost'));
    frames(30);
    expect(game.sim.time).toBe(t0);
    expect(outputGain(sfx())).toBe(0);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(overlay()).toBe(null);
    expect(outputGain(sfx())).toBeGreaterThan(0);
    frames(5);
    expect(game.sim.time).toBeGreaterThan(t0);
    expect(game.mode).toBe('title');
  });

  it('a crash screen stays as it is when the context goes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { game, canvas, frames, overlay } = makeQualityGame();
    game.newGame();
    vi.spyOn(game.hud, 'update').mockImplementation(() => {
      throw new Error('boom');
    });
    frames(1);
    expect(game.isCrashed).toBe(true);
    canvas.dispatchEvent(ev('webglcontextlost'));
    expect(overlay()).toBe(null);
    expect(game.contextLost).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round 2, combat cluster: the reticle, hitmarkers, damage-direction arcs and hit-confirm sounds.

describe('combat feedback on the HUD and in the mix (r2 combat)', () => {
  function hudRig() {
    const hud = new Hud(new FakeElement('div') as unknown as HTMLElement, new MapImage(world()));
    const el = (hud as unknown as { el: Record<string, FakeElement> }).el;
    const sim = quickSim();
    hud.bind(sim);
    const update = (dt: number, camYaw = 0, aiming = false) => hud.update(dt, sim, camYaw, aiming, null, 0);
    const civ = sim.spawnCharacter('civilian', sim.player.pos.x + 5, sim.player.pos.z);
    const cop = sim.spawnCharacter('cop', sim.player.pos.x - 5, sim.player.pos.z);
    type Damage = Parameters<Parameters<typeof sim.events.on<'damage'>>[1]>[0];
    const damage = (over: Partial<Damage>) =>
      sim.events.emit('damage', { victim: civ, attacker: sim.player, healthLoss: 34, armourLoss: 0, kind: 'bullet', zone: 'body', killed: false, dirX: 1, dirZ: 0, ...over });
    /** The arc's rotation in degrees, 0-360 clockwise from the top of the screen. */
    const rotation = (e: FakeElement) => {
      const m = /rotate\((-?[\d.]+)deg\)/.exec(e.style.transform ?? '');
      return m ? ((Number(m[1]) % 360) + 360) % 360 : NaN;
    };
    return { hud, el, sim, update, civ, cop, damage, rotation };
  }

  it("a hit by the player shows the hitmarker for 0.12 s; a kill adds 'kill' for 0.25 s, a headshot 'head'", () => {
    const { el, update, damage, sim, cop } = hudRig();
    const marker = el.hitmarker!;
    expect(marker.classList.contains('show')).toBe(false);
    damage({});
    expect(marker.classList.contains('show')).toBe(true);
    expect(marker.classList.contains('kill')).toBe(false);
    update(1 / 60);
    expect(marker.classList.contains('show')).toBe(true);
    update(0.15);
    expect(marker.classList.contains('show')).toBe(false);
    damage({ killed: true, zone: 'head' });
    expect(marker.classList.contains('show')).toBe(true);
    expect(marker.classList.contains('kill')).toBe(true);
    expect(marker.classList.contains('head')).toBe(true);
    update(0.15);
    expect(marker.classList.contains('show')).toBe(true);
    update(0.15);
    expect(marker.classList.contains('show')).toBe(false);
    expect(marker.classList.contains('kill')).toBe(false);
    expect(marker.classList.contains('head')).toBe(false);
    // Nothing for hits the player did not make: a cop shooting a civilian, fire, a fall.
    damage({ attacker: cop });
    damage({ attacker: null, kind: 'fire', dirX: 0, dirZ: 0 });
    damage({ victim: sim.player, attacker: sim.player, kind: 'explosion' });
    expect(marker.classList.contains('show')).toBe(false);
    // Nor for running people over: it is weapon feedback (bullets, fists, explosions).
    damage({ kind: 'vehicle', killed: true });
    expect(marker.classList.contains('show')).toBe(false);
    damage({ kind: 'melee' });
    expect(marker.classList.contains('show')).toBe(true);
    update(0.2);
    damage({ kind: 'explosion', killed: true });
    expect(marker.classList.contains('kill')).toBe(true);
  });

  it('a hit on the player from directly behind turns the first damage arc to the bottom of the screen; it fades in a second', () => {
    const { el, update, damage, sim, cop, rotation } = hudRig();
    const camYaw = 0.7;
    // The round travels along the camera's view: it came from behind.
    damage({ victim: sim.player, attacker: cop, healthLoss: 0, armourLoss: 20, dirX: Math.sin(camYaw), dirZ: Math.cos(camYaw) });
    update(1 / 60, camYaw);
    const arc = el.dmg0!;
    expect(arc.classList.contains('show')).toBe(true);
    expect(rotation(arc)).toBeGreaterThan(150);
    expect(rotation(arc)).toBeLessThan(210);
    expect(Number(arc.style.opacity)).toBeGreaterThan(0.9);
    update(0.5, camYaw);
    expect(Number(arc.style.opacity)).toBeCloseTo(0.483, 2);
    update(0.6, camYaw);
    expect(arc.classList.contains('show')).toBe(false);
    expect(Number(arc.style.opacity)).toBe(0);
  });

  it('arcs point at the attacker on screen (right is right) and follow the camera; hits from nowhere draw none', () => {
    const { el, update, damage, sim, cop, rotation } = hudRig();
    const yaw = 0.3;
    // Right of the view is (-cos yaw, sin yaw): a shooter there fires along (cos yaw, -sin yaw).
    damage({ victim: sim.player, attacker: cop, dirX: Math.cos(yaw), dirZ: -Math.sin(yaw) });
    update(1 / 60, yaw);
    expect(rotation(el.dmg0!)).toBeCloseTo(90, 0);
    // From the left, in front: other arcs.
    damage({ victim: sim.player, attacker: cop, dirX: -Math.cos(yaw), dirZ: Math.sin(yaw) });
    damage({ victim: sim.player, attacker: null, kind: 'vehicle', dirX: -Math.sin(yaw), dirZ: -Math.cos(yaw) });
    update(1 / 60, yaw);
    expect(rotation(el.dmg1!)).toBeCloseTo(270, 0);
    expect(rotation(el.dmg2!)).toBeCloseTo(0, 0);
    // Turning the camera 90 degrees right (yaw decreases) moves the right-hand attacker to the top.
    update(1 / 60, yaw - Math.PI / 2);
    expect(rotation(el.dmg0!)).toBeCloseTo(0, 0);
    // A second hit from about the same direction refreshes that arc instead of taking another.
    damage({ victim: sim.player, attacker: cop, dirX: Math.cos(yaw + 0.1), dirZ: -Math.sin(yaw + 0.1) });
    update(1 / 60, yaw);
    expect(el.dmg3!.classList.contains('show')).toBe(false);
    // Falls, fire and drowning have no direction.
    damage({ victim: sim.player, attacker: null, kind: 'fall', dirX: 0, dirZ: 0 });
    update(1 / 60, yaw);
    expect(el.dmg3!.classList.contains('show')).toBe(false);
  });

  it("shows the hip reticle with a gun drawn before any shot, the full one while aiming, and 'blocked' in a wall", () => {
    const { el, update, sim } = hudRig();
    const cross = el.cross!;
    update(1 / 60);
    expect(cross.classList.contains('show')).toBe(false);
    sim.player.inventory.give('pistol', 48);
    sim.player.inventory.current = 'pistol';
    update(1 / 60);
    expect(cross.classList.contains('show')).toBe(true);
    expect(cross.classList.contains('hip')).toBe(true);
    expect(cross.classList.contains('blocked')).toBe(false);
    update(1 / 60, 0, true);
    expect(cross.classList.contains('hip')).toBe(false);
    vi.spyOn(sim.combat, 'muzzleBlocked').mockReturnValue(true);
    update(1 / 60);
    expect(cross.classList.contains('blocked')).toBe(true);
    // Swimming, knocked down and in a car hide it.
    for (const state of ['swimming', 'knocked', 'inVehicle'] as const) {
      sim.player.state = state;
      update(1 / 60);
      expect(cross.classList.contains('show'), state).toBe(false);
    }
  });

  it('in the game the reticle is up with a pistol before any shot and loses "hip" while the right button is held', async () => {
    const canvas = new FakeElement('canvas');
    const uiRoot = new FakeElement('div');
    const game = new Game(canvas as unknown as HTMLCanvasElement, uiRoot as unknown as HTMLElement);
    const g = game as unknown as { running: boolean; last: number; frame: (now: number) => void };
    let now = 1000;
    g.running = true;
    g.last = now;
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) {
        now += 1000 / 60;
        g.frame(now);
      }
    };
    game.newGame();
    await flush();
    const p = game.sim.player;
    p.inventory.give('pistol', 48);
    p.inventory.current = 'pistol';
    const cross = uiRoot.all().find((e) => e.dataset.el === 'cross')!;
    frames(2);
    expect(game.sim.progress.stats.shotsFired).toBe(0);
    expect(cross.classList.contains('show')).toBe(true);
    expect(cross.classList.contains('hip')).toBe(true);
    canvas.dispatchEvent(ev('mousedown', { button: 2 }));
    frames(2);
    expect(p.aimZoom).toBe(true);
    expect(cross.classList.contains('show')).toBe(true);
    expect(cross.classList.contains('hip')).toBe(false);
    dom.win.dispatchEvent(ev('mouseup', { button: 2 }));
    frames(2);
    expect(cross.classList.contains('hip')).toBe(true);
  });

  it('one bang per trigger pull, the helicopter still heard, and one hit confirmation per victim per frame on the UI bus', () => {
    const sim = quickSim();
    const audio = new AudioEngine();
    audio.unlock();
    audio.attach(sim);
    const p = sim.player;
    audio.setListener(p.pos.x, p.pos.y + 2, p.pos.z, 0);
    const a = audio as unknown as { gunshot: (...x: unknown[]) => void; hitConfirm: (k: string) => void; tone: (...x: unknown[]) => void; noiseBurst: (...x: unknown[]) => void; uiBus: unknown };
    const gunshot = vi.spyOn(a, 'gunshot');
    const confirm = vi.spyOn(a, 'hitConfirm');
    const tone = vi.spyOn(a, 'tone');
    const noise = vi.spyOn(a, 'noiseBurst');
    const at = { x: p.pos.x, y: p.pos.y + 1, z: p.pos.z };
    sim.events.emit('weaponFired', { shooter: p, weapon: 'shotgun', ...at, dx: 0, dy: 0, dz: 1, pellets: 9 });
    for (let i = 0; i < 9; i++) sim.events.emit('shot', { shooter: p, weapon: 'shotgun', fx: at.x, fy: at.y, fz: at.z, tx: at.x, ty: at.y, tz: at.z + 9, hit: 'world', nx: 0, ny: 0, nz: -1, pellet: i });
    expect(gunshot).toHaveBeenCalledTimes(1);
    sim.events.emit('shot', { shooter: null, weapon: 'rifle', fx: at.x, fy: at.y + 30, fz: at.z, tx: at.x, ty: at.y, tz: at.z, hit: 'none', nx: 0, ny: 1, nz: 0, pellet: 0 });
    expect(gunshot).toHaveBeenCalledTimes(2);
    const civ = sim.spawnCharacter('civilian', p.pos.x + 5, p.pos.z);
    const other = sim.spawnCharacter('civilian', p.pos.x - 5, p.pos.z);
    const hit = (victim: typeof civ, over: Record<string, unknown> = {}) =>
      sim.events.emit('damage', { victim, attacker: p, healthLoss: 13, armourLoss: 0, kind: 'bullet', zone: 'body', killed: false, dirX: 1, dirZ: 0, ...over });
    // Nine pellets on one man (one in the head), a kill on another, and hits the player did not make.
    for (let i = 0; i < 8; i++) hit(civ);
    hit(civ, { zone: 'head' });
    hit(other, { killed: true });
    hit(p, { attacker: other });
    hit(civ, { attacker: other });
    // Running someone over is no weapon hit.
    hit(sim.spawnCharacter('civilian', p.pos.x, p.pos.z + 5), { kind: 'vehicle', killed: true });
    expect(confirm).not.toHaveBeenCalled();
    tone.mockClear();
    noise.mockClear();
    audio.update(1 / 60, sim, true);
    expect(confirm.mock.calls.map((c) => c[0]).sort()).toEqual(['head', 'kill']);
    // Two ticks, the kill's thump and the headshot's crack, all on the UI bus.
    expect(tone.mock.calls.length).toBe(3);
    expect(noise.mock.calls.length).toBe(1);
    expect([...tone.mock.calls, ...noise.mock.calls].every((c) => c[0] === a.uiBus)).toBe(true);
    audio.update(1 / 60, sim, true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Round 2 (cluster "police"): the evade bar and the dispatch scanner line on the HUD.

describe('police HUD: evade bar and dispatch scanner', () => {
  function setup(police = false) {
    const hud = new Hud(new FakeElement('div') as unknown as HTMLElement, new MapImage(world()));
    const el = (hud as unknown as { el: Record<string, FakeElement> }).el;
    const sim = new Sim({ world: world(), ambient: false, police });
    hud.bind(sim);
    /** Advances the sim and the HUD together at 60 fps. */
    const run = (seconds: number) => {
      for (let t = 0; t < seconds; t += 1 / 60) {
        step(sim, 1 / 60);
        hud.update(1 / 60, sim, 0, false, null, sim.time);
      }
    };
    return { el, sim, run };
  }

  it('the evade bar fills with evadeProgress while the stars flash, and is hidden otherwise', () => {
    const { el, sim, run } = setup();
    sim.wanted.setLevel(2);
    run(0.5);
    // The response phase: they know where he is, so there is nothing to show.
    expect(el.evade!.classList.contains('hidden')).toBe(true);
    sim.wanted.responseUntil = 0;
    // He slips out of the search area.
    const n = sim.roads.nearestNode(sim.player.pos.x + 250, sim.player.pos.z);
    sim.player.pos.x = n.x + 9;
    sim.player.pos.z = n.z + 9;
    sim.player.pos.y = sim.world.groundHeight(n.x + 9, n.z + 9);
    run(4);
    expect(sim.wanted.searching).toBe(true);
    expect(el.evade!.classList.contains('hidden')).toBe(false);
    expect(el.evadeFill!.style.width).toBe(`${(sim.wanted.evadeProgress() * 100).toFixed(1)}%`);
    const before = parseFloat(el.evadeFill!.style.width!);
    expect(before).toBeGreaterThan(10);
    run(3);
    expect(parseFloat(el.evadeFill!.style.width!)).toBeCloseTo(before + (3 / sim.wanted.evadeTime()) * 100, 0);
    // Stars a mission pins cannot be lost: no bar for them.
    sim.wanted.floor = 2;
    run(0.1);
    expect(el.evade!.classList.contains('hidden')).toBe(true);
    sim.wanted.floor = 0;
    run(0.1);
    expect(el.evade!.classList.contains('hidden')).toBe(false);
    sim.wanted.clear();
    run(0.1);
    expect(el.evade!.classList.contains('hidden')).toBe(true);
  });

  it('a dispatch line shows on the scanner line for 4.5 s and leaves the subtitle alone', () => {
    const { el, sim, run } = setup();
    sim.events.emit('subtitle', { speaker: 'Mama Lou', text: 'Bring it back in one piece.', duration: 10 });
    run(0.1);
    const subtitle = el.subtitle!.innerHTML;
    sim.events.emit('dispatch', { text: 'All units, shots fired reported in Downtown. Suspect on foot.' });
    run(0.1);
    expect(el.scanner!.classList.contains('show')).toBe(true);
    expect(el.scanner!.textContent).toBe('DISPATCH: All units, shots fired reported in Downtown. Suspect on foot.');
    expect(el.subtitle!.innerHTML).toBe(subtitle);
    expect(el.subtitle!.classList.contains('show')).toBe(true);
    run(4.5);
    expect(el.scanner!.classList.contains('show')).toBe(false);
  });

  it('the police radio speaks on the scanner line when the police are called', () => {
    const { el, sim, run } = setup(true);
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    sim.wanted.setLevel(2);
    run(0.5);
    expect(el.scanner!.classList.contains('show')).toBe(true);
    expect(el.scanner!.textContent).toContain(`DISPATCH: All units, a disturbance reported in ${sim.world.zoneName(sim.player.pos.x, sim.player.pos.z)}.`);
  });
});
