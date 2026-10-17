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
    let settings: Settings = { quality: 'high', master: 0.8, music: 0.6, sfx: 0.85, sensitivity: 1, invertY: false, fov: 68, hints: true, hintsSeen: [] };
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
    press({ down: true }); // tutorial hints
    press({ right: true });
    expect(settings().hints).toBe(false);
    press({ confirm: true });
    expect(settings().hints).toBe(true);
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
    settings: () => ({ quality: 'high', master: 0.8, music: 0.6, sfx: 0.85, sensitivity: 1, invertY: false, fov: 68, hints: true, hintsSeen: [] }),
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
// Round 2, onboarding: Lou's opening call, the next-step line, the route to the contact, key
// glyphs for the active device, first-time hints and the help queue, the mission offer card and
// objectives that clear. Modules are imported dynamically so this block adds no top-level imports.

/** A Game on the fake DOM, stepped through its real frame loop at 60 fps. */
function onboardingGame() {
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
  const seconds = (s: number) => frames(Math.round(s * 60));
  const el = (name: string) => uiRoot.all().find((e) => e.dataset.el === name)!;
  const showing = (name: string) => el(name).classList.contains('show');
  const prompt = () => (el('prompt').classList.contains('hidden') ? null : el('prompt').innerHTML);
  return { game, canvas, uiRoot, frames, seconds, el, showing, prompt };
}

/** A 2D context that records every call with the stroke and fill style current at the time. */
function recordingCtx() {
  const calls: Array<{ fn: string; args: unknown[]; strokeStyle: unknown; fillStyle: unknown }> = [];
  const state: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(state, {
    get: (t, k) =>
      k in t
        ? t[k]
        : (...args: unknown[]) => {
            calls.push({ fn: String(k), args, strokeStyle: t.strokeStyle, fillStyle: t.fillStyle });
            return { addColorStop: () => undefined, width: 0 };
          },
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
  return { ctx, calls };
}

/** A save in which these story missions are done. */
function saveWithDone(...ids: string[]): void {
  const prog = new Progress();
  for (const id of ids) prog.markDone(id);
  expect(writeGame(serialize(prog, [], 0, 12, 1))).toBe(true);
}

/** Puts the player on foot 2.3 m beside the driver's door of a new parked car (as the e2e tests do). */
function besideNewCar(sim: Sim, kind: 'sedan' | 'compact' = 'sedan') {
  const rp = roadPoint(sim, 40, 30);
  const v = sim.spawnVehicle(kind, rp.x, rp.z, rp.heading);
  v.owner = 'parked';
  const p = sim.player;
  if (p.vehicle) sim.playerCtl.ejectPlayer(true);
  p.pos.x = v.pos.x + Math.cos(v.heading) * 2.3;
  p.pos.z = v.pos.z - Math.sin(v.heading) * 2.3;
  p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
  p.vel.x = 0;
  p.vel.z = 0;
  return v;
}

describe('R2 onboarding: Mama Lou calls on New Game', () => {
  it('newGame() starts Wheels 2.5 s in; newGame({ intro: false }) does not', async () => {
    const a = onboardingGame();
    a.game.newGame();
    await flush();
    a.seconds(2.3);
    expect(a.game.sim.missions.active).toBe(null);
    a.seconds(0.7);
    expect(a.game.sim.missions.active?.def.id).toBe('wheels');

    const b = onboardingGame();
    b.game.newGame({ intro: false });
    await flush();
    b.seconds(3);
    expect(b.game.sim.missions.active).toBe(null);
  });

  it('?intro=0 in the page URL turns the call off', async () => {
    vi.stubGlobal('location', { search: '?lock=1&intro=0' });
    const { game, seconds } = onboardingGame();
    game.newGame();
    await flush();
    seconds(4);
    expect(game.sim.missions.active).toBe(null);
  });

  it('the call waits while a menu is open', async () => {
    const { game, seconds } = onboardingGame();
    game.newGame();
    await flush();
    seconds(1);
    game.pause();
    expect(game.menus.open).toBe(true);
    seconds(5);
    expect(game.sim.missions.active).toBe(null);
    game.resume();
    seconds(1.4);
    expect(game.sim.missions.active).toBe(null);
    seconds(0.3);
    expect(game.sim.missions.active?.def.id).toBe('wheels');
  });

  it('a wanted level calls it off, and the next-step line points at Lou instead', async () => {
    const { game, seconds, el, showing } = onboardingGame();
    game.newGame();
    await flush();
    game.sim.cheats.godMode = true;
    game.sim.missions.noBust = true;
    game.sim.wanted.setLevel(1);
    seconds(2.4);
    expect(showing('objective')).toBe(false);
    seconds(0.6);
    expect(game.sim.missions.active).toBe(null);
    expect(showing('objective')).toBe(true);
    expect(el('objective').textContent).toBe('Next: Mama Lou has work - L on your radar');
    // Once only: losing the stars later does not bring the call back.
    game.sim.wanted.clear();
    seconds(3);
    expect(game.sim.missions.active).toBe(null);
  });

  it('the welcome text matches the opening: the pink route without the call, the call itself with it', async () => {
    const a = onboardingGame();
    a.game.newGame({ intro: false });
    expect(a.el('help').innerHTML).toContain('follow the <b class="lou">pink route</b> to the <b class="lou">L</b> on your radar');
    expect(a.el('help').innerHTML).toContain('Steal a ride with <kbd>F</kbd>.');
    const b = onboardingGame();
    b.game.newGame();
    expect(b.el('help').innerHTML).toContain('Mama Lou has work for you.');
    expect(b.el('help').innerHTML).not.toContain('route');
    expect(b.el('help').innerHTML).toContain('Steal a ride with <kbd>F</kbd>.');
  });

  it('continueGame() never calls; the next-step line names the contact who has work', async () => {
    saveWithDone('wheels');
    const a = onboardingGame();
    a.game.continueGame();
    await flush();
    a.seconds(3);
    expect(a.game.sim.missions.active).toBe(null);
    expect(a.showing('objective')).toBe(true);
    expect(a.el('objective').classList.contains('next')).toBe(true);
    expect(a.el('objective').textContent).toBe('Next: Mama Lou has work - L on your radar');
    a.seconds(5.5);
    expect(a.showing('objective')).toBe(false);

    saveWithDone('wheels', 'delivery', 'repo');
    const b = onboardingGame();
    b.game.continueGame();
    await flush();
    b.seconds(1);
    expect(b.game.sim.missions.active).toBe(null);
    expect(b.el('objective').textContent).toBe('Next: Dex Moreau has work - D on your radar');
  });

  it('the line returns after respawning and after a passed mission (once its cards are gone), and leaves when a mission starts', async () => {
    saveWithDone('wheels');
    const { game, seconds, el, showing } = onboardingGame();
    game.continueGame();
    await flush();
    const sim = game.sim;
    seconds(9);
    expect(showing('objective')).toBe(false);
    sim.playerDied();
    seconds(5.2);
    expect(sim.playerDown).toBe(false);
    expect(showing('objective')).toBe(true);
    expect(el('objective').textContent).toContain('Mama Lou');
    // Starting a mission takes the line off at once.
    expect(sim.missions.start('delivery')).toBe(true);
    seconds(1 / 60);
    expect(showing('objective')).toBe(false);
    expect(el('objective').classList.contains('next')).toBe(false);
    // Pass it: no line while DELIVERY / MISSION PASSED are up, then the next contact.
    sim.missions.active!.done = true;
    seconds(0.5);
    expect(el('bigT').textContent).toBe('HOT DELIVERY');
    expect(showing('objective')).toBe(false);
    seconds(3.5);
    expect(el('bigT').textContent).toBe('MISSION PASSED');
    expect(showing('objective')).toBe(false);
    seconds(5);
    expect(showing('objective')).toBe(true);
    expect(el('objective').textContent).toBe('Next: Mama Lou has work - L on your radar');
  });

  it('debug newGame(opts) forwards to the game', async () => {
    const { installDebugApi } = await import('../../src/debug');
    const { game, seconds } = onboardingGame();
    installDebugApi(game);
    const api = (dom.win as unknown as { __gta7: { newGame(o?: { intro?: boolean }): void } }).__gta7;
    api.newGame({ intro: false });
    await flush();
    seconds(3);
    expect(game.mode).toBe('game');
    expect(game.sim.missions.active).toBe(null);
  });
});

describe('R2 onboarding: the GPS route leads to the contact and the L stays on top', () => {
  it('a new game sets no waypoint: the route runs pink to Lou and her L is the last blip drawn there', async () => {
    const mapRender = await import('../../src/ui/mapRender');
    const { game, frames } = onboardingGame();
    game.newGame({ intro: false });
    await flush();
    expect(game.hud.waypoint).toBe(null);
    const rec = recordingCtx();
    (game.hud as unknown as { radarCtx: unknown }).radarCtx = rec.ctx;
    const draw = vi.spyOn(mapRender, 'drawBlip');
    frames(2);
    const lou = game.sim.world.layout.pois.find((p) => p.id === 'lou')!;
    const route = (game.hud as unknown as { route: Array<{ x: number; z: number }> }).route;
    expect(route.length).toBeGreaterThan(2);
    expect(route[route.length - 1]).toEqual({ x: lou.x, z: lou.z });
    expect(rec.calls.some((c) => c.fn === 'stroke' && c.strokeStyle === '#ff4fa3')).toBe(true);
    expect(rec.calls.some((c) => c.fn === 'stroke' && (c.strokeStyle === '#c04fff' || c.strokeStyle === '#ffd23d'))).toBe(false);
    const atLou = draw.mock.calls.map((c) => c[1]).filter((b) => b.sticky && b.x === lou.x && b.z === lou.z);
    expect(atLou.length).toBeGreaterThan(0);
    expect(atLou[atLou.length - 1]!.label).toBe('L');

    // The player's own waypoint (here right on Lou) turns the route purple and goes under her L.
    draw.mockClear();
    rec.calls.length = 0;
    game.hud.waypoint = { x: lou.x, z: lou.z };
    frames(1);
    expect(rec.calls.some((c) => c.fn === 'stroke' && c.strokeStyle === '#c04fff')).toBe(true);
    expect(rec.calls.some((c) => c.fn === 'stroke' && c.strokeStyle === '#ff4fa3')).toBe(false);
    const order = draw.mock.calls.map((c) => c[1]);
    const wp = order.findIndex((b) => b.color === '#c04fff');
    const l = order.findIndex((b) => b.label === 'L');
    expect(wp).toBeGreaterThanOrEqual(0);
    expect(l).toBeGreaterThan(wp);
  });

  it('the route turns teal for Dex, yellow for an objective, and the full map draws W under L', async () => {
    const mapRender = await import('../../src/ui/mapRender');
    saveWithDone('wheels', 'delivery', 'repo');
    const { game, frames } = onboardingGame();
    game.continueGame();
    await flush();
    const rec = recordingCtx();
    (game.hud as unknown as { radarCtx: unknown }).radarCtx = rec.ctx;
    frames(2);
    const dex = game.sim.world.layout.pois.find((p) => p.id === 'dex')!;
    const route = (game.hud as unknown as { route: Array<{ x: number; z: number }> }).route;
    expect(route[route.length - 1]).toEqual({ x: dex.x, z: dex.z });
    expect(rec.calls.some((c) => c.fn === 'stroke' && c.strokeStyle === '#38e1d2')).toBe(true);
    // A mission objective marker: yellow.
    rec.calls.length = 0;
    expect(game.sim.missions.start('loose_lips')).toBe(true);
    const m = game.sim.missions.active!;
    m.mark({ x: dex.x + 200, z: dex.z }, 'Somewhere', 0x3dd9ff);
    frames(2);
    expect(rec.calls.some((c) => c.fn === 'stroke' && c.strokeStyle === '#ffd23d')).toBe(true);
    m.fail('test');
    frames(2);

    // Full map: a waypoint on Lou's spot is drawn before (under) her L.
    const lou = game.sim.world.layout.pois.find((p) => p.id === 'lou')!;
    const sim = quickSim();
    sim.missions.refreshMarkers();
    const menus = new Menus(new FakeElement('div') as unknown as HTMLElement, stubHost({ sim: () => sim, waypoint: () => ({ x: lou.x, z: lou.z }) }), new MapImage(world()));
    const draw = vi.spyOn(mapRender, 'drawBlip');
    menus.showMap();
    menus.input(NO_UI, 0.3);
    const order = draw.mock.calls.map((c) => c[1]);
    const w = order.findIndex((b) => b.label === 'W');
    const l = order.findIndex((b) => b.label === 'L');
    expect(w).toBeGreaterThanOrEqual(0);
    expect(l).toBeGreaterThan(w);
  });
});

describe('R2 onboarding: key glyphs for the active device', () => {
  it('converts the three literal key forms, and nothing else, for keyboard and pad', async () => {
    const { formatKeys } = await import('../../src/ui/glyphs');
    const kb = (s: string) => formatKeys(s, 'kb');
    const pad = (s: string, inVehicle = false) => formatKeys(s, 'pad', { inVehicle });
    expect(kb('Press E to shop at Bang Bang Guns')).toBe('Press <kbd>E</kbd> to shop at Bang Bang Guns');
    expect(kb('drive a taxi and press T.')).toBe('drive a taxi and press <kbd>T</kbd>.');
    expect(kb('Steal a ride with <kbd>F</kbd>.')).toBe('Steal a ride with <kbd>F</kbd>.');
    expect(kb('Hold <kbd>Space</kbd>, retry (E), pause with Press Esc')).toBe('Hold <kbd>Space</kbd>, retry <kbd>E</kbd>, pause with Press <kbd>Esc</kbd>');
    expect(kb('Right-click to aim, left-click to shoot.')).toBe('Right-click to aim, left-click to shoot.');
    // Only exact key mentions: prose, other letters in parentheses and longer words stay as they are.
    for (const s of ['a Spray Shack (S on the radar)', 'Plan (A) or (B)', 'Expressway E', 'Press a button', 'Pressed E', '<b class="lou">L</b>', 'Press Entertainment']) {
      expect(kb(s)).toBe(s);
      expect(pad(s)).toBe(s);
    }
    const glyph = (s: string) => /<kbd class="pad ([^"]+)"/.exec(s)?.[1];
    expect(glyph(pad('Press E to start "Wheels"'))).toBe('dpad');
    expect(pad('Press E to start "Wheels"')).toContain('aria-label="D-pad up"');
    expect(pad('Press T')).toContain('aria-label="D-pad down"');
    expect(pad('Press F to get out!')).toBe('Press <kbd class="pad pad-y">Y</kbd> to get out!');
    expect(pad('<kbd>R</kbd> reloads')).toBe('<kbd class="pad pad-b">B</kbd> reloads');
    expect(pad('<kbd>R</kbd> changes the station', true)).toContain('aria-label="D-pad right"');
    expect(pad('<kbd>M</kbd> map, <kbd>V</kbd> camera, (P) pause, <kbd>Esc</kbd> too')).toBe(
      '<kbd class="pad pad-back">Back</kbd> map, <kbd class="pad pad-r3">R3</kbd> camera, <kbd class="pad pad-start">Start</kbd> pause, <kbd class="pad pad-start">Start</kbd> too',
    );
    // Space jumps (X) on foot and is the handbrake (RB) in a car; Shift sprints (A).
    expect(pad('<kbd>Space</kbd>')).toBe('<kbd class="pad pad-x">X</kbd>');
    expect(pad('<kbd>Space</kbd>', true)).toBe('<kbd class="pad pad-rb">RB</kbd>');
    expect(pad('<kbd>Shift</kbd>')).toBe('<kbd class="pad pad-a">A</kbd>');
    // The triggers shoot and aim on foot; in a car RT is the throttle and X shoots.
    expect(pad('Right-click to aim, left-click to shoot.')).toBe('<kbd class="pad pad-lt">LT</kbd> to aim, <kbd class="pad pad-rt">RT</kbd> to shoot.');
    expect(pad('left click to shoot', true)).toBe('<kbd class="pad pad-x">X</kbd> to shoot');
    // A key with no pad button keeps its keycap.
    expect(pad('Press W')).toBe('Press <kbd>W</kbd>');
  });

  it('names keys once, as printed on the layout (no keycap is read again as another key)', async () => {
    const { formatKeys } = await import('../../src/ui/glyphs');
    const labels = new KeyLabels();
    // Colemak: the F binding sits on the key printed T, the T binding on the key printed G.
    const typed: Array<[string, string]> = [['KeyE', 'f'], ['KeyF', 't'], ['KeyT', 'g'], ['KeyG', 'd']];
    for (const [code, key] of typed) labels.learn({ code, key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false } as KeyboardEvent);
    expect(formatKeys('<kbd>F</kbd>, then Press T and (T)', 'kb', { labels })).toBe('<kbd>T</kbd>, then Press <kbd>G</kbd> and <kbd>G</kbd>');
  });

  it("the HUD draws Lou's start prompt with a D-pad glyph on a pad and her E keycap on a keyboard", () => {
    const hud = new Hud(new FakeElement('div') as unknown as HTMLElement, new MapImage(world()));
    const el = (hud as unknown as { el: Record<string, FakeElement> }).el;
    const sim = quickSim();
    hud.bind(sim);
    sim.missions.refreshMarkers();
    const marker = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === 'wheels')!;
    sim.player.pos.x = marker.x;
    sim.player.pos.z = marker.z;
    const prompt = sim.interactions.prompt();
    expect(prompt).toBe('Press E to start "Wheels"');
    hud.device = 'pad';
    hud.update(1 / 60, sim, 0, false, prompt, 0);
    expect(el.prompt!.innerHTML).toContain('<kbd class="pad dpad" aria-label="D-pad up">');
    expect(el.prompt!.innerHTML).not.toContain('<kbd>E</kbd>');
    hud.device = 'kb';
    hud.update(1 / 60, sim, 0, false, prompt, 0);
    expect(el.prompt!.innerHTML).toContain('Press <kbd>E</kbd> to start');
    expect(el.prompt!.innerHTML).not.toContain('pad');
  });

  it('a showing help box is redrawn when the player switches device', () => {
    const hud = new Hud(new FakeElement('div') as unknown as HTMLElement, new MapImage(world()));
    const el = (hud as unknown as { el: Record<string, FakeElement> }).el;
    const sim = quickSim();
    hud.bind(sim);
    sim.events.emit('message', { text: 'Your vehicle is on fire! Press F to get out!', duration: 3 });
    expect(el.help!.innerHTML).toBe('Your vehicle is on fire! Press <kbd>F</kbd> to get out!');
    hud.device = 'pad';
    hud.update(1 / 60, sim, 0, false, null, 0);
    expect(el.help!.innerHTML).toBe('Your vehicle is on fire! Press <kbd class="pad pad-y">Y</kbd> to get out!');
  });

  it('the game hands the device of the last input to the HUD', async () => {
    const pad = fakePad();
    const { game, frames, el } = onboardingGame();
    game.newGame({ intro: false });
    await flush();
    frames(1);
    expect(game.hud.device).toBe('kb');
    pad.buttons[4]!.pressed = true; // LB
    frames(1);
    pad.buttons[4]!.pressed = false;
    frames(1);
    expect(game.hud.device).toBe('pad');
    expect(el('help').innerHTML).toContain('<kbd class="pad pad-y">Y</kbd>');
  });
});

describe('R2 onboarding: the help queue', () => {
  function setup() {
    const hud = new Hud(new FakeElement('div') as unknown as HTMLElement, new MapImage(world()));
    const el = (hud as unknown as { el: Record<string, FakeElement> }).el;
    const sim = quickSim();
    hud.bind(sim);
    const run = (seconds: number) => {
      for (let t = 0; t < seconds - 1e-9; t += 1 / 60) hud.update(1 / 60, sim, 0, false, null, 0);
    };
    const help = () => (el.help!.classList.contains('show') ? el.help!.innerHTML : null);
    return { hud, el, sim, run, help };
  }

  it('a message replaces a showing hint at once; a hint never replaces a showing message', () => {
    const { hud, el, sim, run, help } = setup();
    expect(hud.help('Hint one', 5, 'hint')).toBe(true);
    expect(help()).toBe('Hint one');
    expect(el.help!.classList.contains('hint')).toBe(true);
    sim.events.emit('message', { text: 'Bail paid: $100.', duration: 2 });
    expect(help()).toBe('Bail paid: $100.');
    expect(el.help!.classList.contains('hint')).toBe(false);
    expect(hud.help('Hint two', 4, 'hint')).toBe(true);
    run(1);
    expect(help()).toBe('Bail paid: $100.');
    // After the message and a short gap, the interrupted hint comes back first, then the next one.
    run(1.2);
    expect(help()).toBe(null);
    run(0.5);
    expect(help()).toBe('Hint one');
    run(5.6);
    expect(help()).toBe('Hint two');
  });

  it('holds at most three hints, and none appear while a subtitle is up', () => {
    const { hud, sim, run, help } = setup();
    sim.events.emit('subtitle', { speaker: 'Mama Lou', text: 'Welcome home, baby.', duration: 3 });
    expect(hud.help('Hint 1', 2, 'hint')).toBe(true);
    expect(hud.help('Hint 2', 2, 'hint')).toBe(true);
    expect(hud.help('Hint 3', 2, 'hint')).toBe(true);
    expect(hud.help('Hint 4', 2, 'hint')).toBe(false);
    run(2.9);
    expect(help()).toBe(null);
    run(0.2);
    expect(help()).toBe('Hint 1');
    // A message still shows at once over a waiting queue.
    sim.events.emit('message', { text: 'Good as new.', duration: 1 });
    expect(help()).toBe('Good as new.');
  });

  it('dialogue starting over an unread hint sends it back to the queue; a read one stays up', () => {
    const { hud, sim, run, help } = setup();
    const read: string[] = [];
    expect(hud.help('Hint one', 6, 'hint', { id: 'one', onRead: () => read.push('one') })).toBe(true);
    run(1);
    expect(help()).toBe('Hint one');
    sim.events.emit('subtitle', { speaker: 'Mama Lou', text: 'Welcome home, baby.', duration: 4 });
    expect(help()).toBe(null);
    expect(hud.hintPending('one')).toBe(true);
    run(3.9);
    expect(help()).toBe(null);
    run(0.2);
    expect(help()).toBe('Hint one');
    run(2.9);
    expect(read).toEqual([]);
    run(0.2);
    expect(read).toEqual(['one']);
    // Read by now: another line of dialogue leaves it up to finish.
    sim.events.emit('subtitle', { speaker: 'Mama Lou', text: 'Bring me a car.', duration: 2 });
    expect(help()).toBe('Hint one');
    run(3);
    expect(help()).toBe(null);
    expect(read).toEqual(['one']);
    expect(hud.hintPending('one')).toBe(false);
  });

  it('switching hints off drops the queue and ends a showing hint', async () => {
    const { game, frames, el } = onboardingGame();
    game.newGame({ intro: false });
    await flush();
    expect(game.hud.help('A hint', 5, 'hint')).toBe(true); // queued behind the welcome message
    game.applySettings({ ...game.settings, hints: false }, true);
    frames(60 * 10);
    expect(el('help').innerHTML).not.toContain('A hint');
  });
});

describe('R2 onboarding: first-time hints and the steal prompt', () => {
  it('2 m beside a parked car the prompt offers to steal it, for the first five vehicle entries only', async () => {
    const { game, frames, prompt } = onboardingGame();
    game.newGame({ intro: false });
    await flush();
    const sim = game.sim;
    sim.cheats.godMode = true;
    const v = besideNewCar(sim);
    frames(2);
    expect(prompt()).toMatch(/steal the/i);
    expect(prompt()).toBe(`Press <kbd>F</kbd> to steal the ${v.spec.name}`);
    // A real entry with F counts as the first.
    dom.win.dispatchEvent(keyEv('keydown', 'KeyF', 'f'));
    frames(2);
    dom.win.dispatchEvent(keyEv('keyup', 'KeyF', 'f'));
    for (let i = 0; i < 180 && sim.player.vehicle !== v; i++) frames(1);
    expect(sim.player.vehicle).toBe(v);
    expect(game.settings.hintsSeen).toContain('steal:1');
    // Out again, next to the car he just sat in: not a theft any more.
    sim.playerCtl.ejectPlayer(true);
    frames(30);
    expect(prompt()).toBe(`Press <kbd>F</kbd> to get in the ${v.spec.name}`);
    for (let i = 0; i < 4; i++) sim.events.emit('vehicleEnter', { vehicle: v, character: sim.player, jacked: false });
    expect(game.settings.hintsSeen.filter((id) => id.startsWith('steal:'))).toEqual(['steal:1', 'steal:2', 'steal:3', 'steal:4', 'steal:5']);
    frames(2);
    expect(prompt()).toBe(null);
  });

  it('says "get in" next to the car the player last drove, and gives way to a marker', async () => {
    const { game, frames, prompt } = onboardingGame();
    game.newGame({ intro: false });
    await flush();
    const sim = game.sim;
    const v = besideNewCar(sim, 'compact');
    v.lastDriver = sim.player;
    frames(2);
    expect(prompt()).toBe(`Press <kbd>F</kbd> to get in the ${v.spec.name}`);
    // On the safehouse marker (with a car right there) the marker's prompt wins.
    const save = sim.interactions.markers.find((m) => m.kind === 'save')!;
    const car = sim.spawnVehicle('sedan', save.x + 2.2, save.z, 0);
    car.owner = 'parked';
    sim.player.pos.x = save.x;
    sim.player.pos.z = save.z;
    frames(2);
    expect(prompt()).toBe('Press <kbd>E</kbd> to save your game');
  });

  it('the first star explains how to lose the cops, once the welcome message is done', async () => {
    const { game, seconds, el } = onboardingGame();
    game.newGame({ intro: false });
    await flush();
    const sim = game.sim;
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    sim.wanted.setLevel(1);
    seconds(2);
    expect(el('help').innerHTML).toContain('Welcome to San Azura');
    seconds(8);
    expect(el('help').classList.contains('show')).toBe(true);
    expect(el('help').innerHTML).toContain('Spray');
    expect(el('help').classList.contains('hint')).toBe(true);
    // Remembered once it has been up for half its 8 s.
    expect(game.settings.hintsSeen).not.toContain('wanted');
    seconds(4);
    expect(game.settings.hintsSeen).toContain('wanted');
  });

  it('hintsSeen persists across a new Game on the same storage', async () => {
    const a = onboardingGame();
    a.game.newGame({ intro: false });
    await flush();
    a.game.sim.cheats.godMode = true;
    a.game.sim.missions.noBust = true;
    a.game.sim.wanted.setLevel(1);
    a.seconds(14);
    expect(a.game.settings.hintsSeen).toContain('wanted');
    const b = onboardingGame();
    expect(b.game.settings.hintsSeen).toContain('wanted');
    b.game.newGame({ intro: false });
    await flush();
    b.game.sim.cheats.godMode = true;
    b.game.sim.missions.noBust = true;
    b.game.sim.wanted.setLevel(1);
    let spray = false;
    for (let i = 0; i < 60 * 12; i++) {
      b.frames(1);
      if (b.el('help').innerHTML.includes('Spray')) spray = true;
    }
    expect(spray).toBe(false);
  });

  it('with hints off there is no hint and no steal prompt', async () => {
    const { game, frames, el, prompt } = onboardingGame();
    game.applySettings({ ...game.settings, hints: false }, true);
    game.newGame({ intro: false });
    await flush();
    const sim = game.sim;
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    besideNewCar(sim);
    sim.wanted.setLevel(1);
    sim.player.inventory.give('pistol', 48);
    sim.player.inventory.current = 'pistol';
    let hint = false;
    for (let i = 0; i < 60 * 11; i++) {
      frames(1);
      if (el('help').classList.contains('hint')) hint = true;
      if (prompt()?.includes('steal')) hint = true;
    }
    expect(hint).toBe(false);
    expect(game.settings.hintsSeen).toEqual([]);
  });

  it('each rule fires on its own condition (a free mouse, driving, a gun, low health) and they take turns', async () => {
    dom.lockMode = 'manual'; // the lock request stays pending: the mouse is free
    const { game, seconds, el } = onboardingGame();
    game.newGame({ intro: false });
    await flush();
    const sim = game.sim;
    sim.cheats.godMode = true;
    const hud = game.hud;
    seconds(1.2);
    expect(hud.hintPending('mouse')).toBe(true);
    const v = besideNewCar(sim);
    placeInCar(sim, v);
    seconds(0.1);
    expect(hud.hintPending('drive')).toBe(true);
    sim.player.inventory.give('pistol', 48);
    sim.player.inventory.current = 'pistol';
    sim.player.health = 30;
    seconds(0.1);
    // In the car the gun hint does not apply yet; the low-health one takes the third queue slot.
    // Nothing counts as seen before it has been read.
    expect(hud.hintPending('health')).toBe(true);
    expect(hud.hintPending('weapon')).toBe(false);
    expect(game.settings.hintsSeen).toEqual([]);
    // They take turns in the help box after the welcome message; each is remembered once read.
    const seen: string[] = [];
    for (let i = 0; i < 60 * 40; i++) {
      // Out of the car once the driving hint has been read, so the gun hint applies.
      if (sim.player.vehicle && game.settings.hintsSeen.includes('drive')) sim.playerCtl.ejectPlayer(true);
      seconds(1 / 60);
      const h = el('help');
      if (h.classList.contains('show') && h.classList.contains('hint') && seen[seen.length - 1] !== h.innerHTML) seen.push(h.innerHTML);
    }
    expect(seen.map((s) => s.replace(/<[^>]*>/g, '').split('.')[0])).toEqual(['Click the game to control the camera', 'Hold Space for the handbrake', 'Health is low: buy First Aid at Bang Bang Guns or save at the safehouse', 'Right-click to aim, left-click to shoot']);
    expect(game.settings.hintsSeen).toEqual(['mouse', 'drive', 'health', 'weapon']);
  });

  it('a hint counts as seen only once read: one still queued when hints go off or a new game starts comes back', async () => {
    const { game, seconds, el } = onboardingGame();
    game.newGame({ intro: false });
    await flush();
    game.sim.cheats.godMode = true;
    game.sim.missions.noBust = true;
    game.sim.wanted.setLevel(1);
    seconds(2);
    expect(game.hud.hintPending('wanted')).toBe(true); // waiting behind the welcome message
    expect(game.settings.hintsSeen).not.toContain('wanted');
    // Hints off and on again before its turn: dropped from the queue, not remembered, queued again.
    game.applySettings({ ...game.settings, hints: false }, true);
    expect(game.hud.hintPending('wanted')).toBe(false);
    game.applySettings({ ...game.settings, hints: true }, true);
    seconds(0.1);
    expect(game.hud.hintPending('wanted')).toBe(true);
    // A new game before its turn: still unseen, and back with the next star.
    game.newGame({ intro: false });
    await flush();
    expect(game.hud.hintPending('wanted')).toBe(false);
    expect(game.settings.hintsSeen).not.toContain('wanted');
    game.sim.cheats.godMode = true;
    game.sim.missions.noBust = true;
    game.sim.wanted.setLevel(1);
    seconds(9.7);
    expect(el('help').innerHTML).toContain('Spray');
    expect(game.settings.hintsSeen).not.toContain('wanted'); // on screen, not read yet
    seconds(4);
    expect(game.settings.hintsSeen).toContain('wanted');
  });

  it('a queued hint that no longer applies when its turn comes is dropped unread, and comes back when it applies again', async () => {
    const { game, seconds, el } = onboardingGame();
    game.newGame({ intro: false });
    await flush();
    const sim = game.sim;
    sim.player.health = 30;
    seconds(1);
    expect(game.hud.hintPending('health')).toBe(true);
    sim.player.health = sim.player.maxHealth; // First Aid before the welcome message is over
    let shown = false;
    for (let i = 0; i < 60 * 10; i++) {
      seconds(1 / 60);
      if (el('help').innerHTML.includes('Health is low')) shown = true;
    }
    expect(shown).toBe(false);
    expect(game.hud.hintPending('health')).toBe(false);
    expect(game.settings.hintsSeen).not.toContain('health');
    sim.player.health = 30;
    seconds(0.1);
    expect(el('help').innerHTML).toContain('Health is low');
  });

  it('no mouse hint on a pad or where pointer lock is unavailable', async () => {
    const a = onboardingGame();
    Object.assign(a.canvas, {
      requestPointerLock: () => {
        throw new Error('unsupported');
      },
    });
    a.game.newGame({ intro: false });
    await flush();
    a.seconds(2);
    expect(a.game.settings.hintsSeen).not.toContain('mouse');

    dom.lockMode = 'manual';
    const pad = fakePad();
    const b = onboardingGame();
    b.game.newGame({ intro: false });
    await flush();
    pad.axes[2] = 0.5; // nudging the right stick makes the pad the active device
    b.seconds(2);
    expect(b.game.hud.device).toBe('pad');
    expect(b.game.settings.hintsSeen).not.toContain('mouse');
  });

  it('a full seen list (a bad settings file) still records a new hint, so it shows once', async () => {
    const storage = (dom.win as unknown as { localStorage: FakeStorage }).localStorage;
    storage.setItem('gta7.settings.v1', JSON.stringify({ hintsSeen: Array.from({ length: 50 }, (_, i) => `junk${i}`) }));
    const { game, seconds } = onboardingGame();
    expect(game.settings.hintsSeen.length).toBe(50);
    game.newGame({ intro: false });
    await flush();
    const help = vi.spyOn(game.hud, 'help');
    game.sim.cheats.godMode = true;
    game.sim.missions.noBust = true;
    game.sim.wanted.setLevel(1);
    seconds(20);
    expect(help.mock.calls.filter((c) => c[2] === 'hint' && c[0].includes('Spray')).length).toBe(1);
    expect(game.settings.hintsSeen.length).toBe(50);
    expect(game.settings.hintsSeen).toContain('wanted');
    expect(game.settings.hintsSeen).not.toContain('junk0');
  });

  it('settings: old files get hints on, and the seen list is validated and capped', async () => {
    const { loadSettings, saveSettings, MAX_HINTS_SEEN } = await import('../../src/settings');
    const storage = (dom.win as unknown as { localStorage: FakeStorage }).localStorage;
    storage.setItem('gta7.settings.v1', JSON.stringify({ quality: 'medium', master: 0.5 }));
    const old = loadSettings();
    expect(old.hints).toBe(true);
    expect(old.hintsSeen).toEqual([]);
    expect(old.quality).toBe('medium');
    const many = Array.from({ length: 70 }, (_, i) => `rule${i}`);
    storage.setItem('gta7.settings.v1', JSON.stringify({ hints: false, hintsSeen: [7, 'wanted', 'wanted', '', '<img src=x>', 'x'.repeat(40), null, 'steal:1', ...many] }));
    const s = loadSettings();
    expect(s.hints).toBe(false);
    expect(s.hintsSeen.slice(0, 3)).toEqual(['wanted', 'steal:1', 'rule0']);
    expect(s.hintsSeen.length).toBe(MAX_HINTS_SEEN);
    saveSettings({ ...s, hints: true, hintsSeen: ['drive'] });
    expect(loadSettings().hintsSeen).toEqual(['drive']);
    expect(loadSettings().hints).toBe(true);
  });
});

describe('R2 onboarding: the mission offer card', () => {
  it("at Lou's marker the prompt is a card with the title, giver, blurb, reward and start line; elsewhere the plain label", () => {
    const hud = new Hud(new FakeElement('div') as unknown as HTMLElement, new MapImage(world()));
    const el = (hud as unknown as { el: Record<string, FakeElement> }).el;
    const sim = quickSim();
    hud.bind(sim);
    sim.missions.refreshMarkers();
    const at = (m: { x: number; z: number }) => {
      sim.player.pos.x = m.x;
      sim.player.pos.z = m.z;
      hud.update(1 / 60, sim, 0, false, sim.interactions.prompt(), 0);
      return el.prompt!;
    };
    const lou = at(sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === 'wheels')!);
    expect(lou.classList.contains('card')).toBe(true);
    expect(lou.classList.contains('lou')).toBe(true);
    for (const s of ['Wheels', 'Mama Lou needs a car', '$500', 'Mama Lou']) expect(lou.textContent).toContain(s);
    expect(lou.innerHTML).toContain('<div class="card-start">Press <kbd>E</kbd> to start</div>');
    // Wanted: the card stays and says why it can't start yet.
    sim.wanted.setLevel(1);
    hud.update(1 / 60, sim, 0, false, sim.interactions.prompt(), 0);
    expect(lou.textContent).toContain('Lose the cops before starting a mission.');
    sim.wanted.clear();
    const shop = at(sim.interactions.markers.find((m) => m.kind === 'gunshop')!);
    expect(shop.classList.contains('card')).toBe(false);
    expect(shop.innerHTML).toBe('Press <kbd>E</kbd> to shop at Bang Bang Guns');
    // Dex's card wears his colour.
    for (const id of ['wheels', 'delivery', 'repo']) sim.progress.markDone(id);
    sim.missions.refreshMarkers();
    const dex = at(sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === 'loose_lips')!);
    expect(dex.classList.contains('dex')).toBe(true);
    expect(dex.classList.contains('lou')).toBe(false);
    expect(dex.textContent).toContain('Dex Moreau');
    expect(dex.textContent).toContain('$4,000');
  });
});

describe('R2 onboarding: objectives clear', () => {
  it("an empty 'objective' event hides the objective at once", () => {
    const hud = new Hud(new FakeElement('div') as unknown as HTMLElement, new MapImage(world()));
    const el = (hud as unknown as { el: Record<string, FakeElement> }).el;
    const sim = quickSim();
    hud.bind(sim);
    sim.events.emit('objective', { text: "Drive it into Lou's garage" });
    hud.update(1 / 60, sim, 0, false, null, 0);
    expect(el.objective!.classList.contains('show')).toBe(true);
    sim.events.emit('objective', { text: '' });
    expect(el.objective!.classList.contains('show')).toBe(false);
    hud.update(1 / 60, sim, 0, false, null, 0);
    expect(el.objective!.classList.contains('show')).toBe(false);
  });

  it('the MISSION FAILED sub-line names the retry key for the device', () => {
    const hud = new Hud(new FakeElement('div') as unknown as HTMLElement, new MapImage(world()));
    const el = (hud as unknown as { el: Record<string, FakeElement> }).el;
    const sim = quickSim();
    hud.bind(sim);
    hud.device = 'pad';
    sim.events.emit('big', { text: 'MISSION FAILED', sub: "The buyer walked. - Press E to retry", style: 'failed', duration: 4 });
    hud.update(1 / 60, sim, 0, false, null, 0);
    expect(el.bigS!.innerHTML).toContain('The buyer walked. - Press <kbd class="pad dpad" aria-label="D-pad up">');
  });
});
