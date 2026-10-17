// Regression tests for the frontend review fixes: input (gamepad trigger and look, wheel,
// pointer-lock capture, keyboard layouts), audio, HUD, menus and the Game flows around them.
// Node has no DOM or Web Audio, so the browser pieces run against small fakes defined below,
// and the WebGL renderer is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/audio';
import { wrapAngle } from '../../src/core/math';
import { Game } from '../../src/game';
import { Input, type UiActions } from '../../src/input/input';
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
