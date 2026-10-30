// Round 2, fix pass 3 (menus): NEW GAME asks before a save is replaced, confirmations open on NO, a full
// localStorage keeps the save reachable, CONTROLS / STATS / CREDITS scroll with keyboard and pad, the map
// works without a mouse, the mouse never selects a greyed-out item, and instructions follow the device.
// Node has no DOM: the browser pieces run on the small fakes below (as in fix_frontend.test.ts), and the
// WebGL renderer is mocked.

import { DEFAULT_BINDINGS } from '../../src/input/bindings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../src/game';
import { Input, type UiActions } from '../../src/input/input';
import { currentSlot, deleteGame, loadGame, loadSettings, loadSlot, slotKey, storeSlot, writeGame, type Settings } from '../../src/settings';
import { Progress, serialize, type SaveData } from '../../src/sim/progress';
import { Sim } from '../../src/sim/sim';
import { MAP_SCALE, MapImage } from '../../src/ui/mapRender';
import { Menus, type MenuHost } from '../../src/ui/menus';
import { world } from './helpers';

vi.mock('../../src/render/renderer', async () => {
  const { CameraController: Cam } = await import('../../src/render/camera');
  class GameRenderer {
    readonly cameraCtl = new Cam(16 / 9);
    currentQuality = 'high';
    msaa = false;
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
  scrollHeight = 0;
  scrollTop = 0;
  tabIndex = 0;
  /** The options of the last focus() call, or null if never focused. */
  focused: { preventScroll?: boolean } | null = null;
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
  focus(opts: { preventScroll?: boolean } = {}): void {
    this.focused = opts;
  }
  /** Scrolls like a browser: clamped to the content, instantly (smooth scrolling only animates the same move). */
  scrollBy(opts: { top?: number }): void {
    this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, this.scrollTop + (opts.top ?? 0)));
  }
  setPointerCapture(): void {}
  requestPointerLock(): unknown {
    return undefined;
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
    this.pointerLockElement = null;
  }
}

/** localStorage as browsers keep it: a quota on the characters of keys and values, which only growing writes can break. */
class QuotaStorage {
  private readonly m = new Map<string, string>();
  constructor(private readonly capacity = Infinity) {}
  get used(): number {
    let n = 0;
    for (const [k, v] of this.m) n += k.length + v.length;
    return n;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    const value = String(v);
    const old = this.m.get(k);
    const next = this.used - (old === undefined ? 0 : k.length + old.length) + k.length + value.length;
    if (next > this.capacity) throw new DOMException(`Setting the value of '${k}' exceeded the quota.`, 'QuotaExceededError');
    this.m.set(k, value);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  /** Fills the storage with other keys (another game on the same origin) until fewer than `left` characters are free. */
  fill(left: number): void {
    for (let i = 0; this.capacity - this.used >= left; i++) {
      const room = this.capacity - this.used - `other.${i}`.length;
      this.m.set(`other.${i}`, 'x'.repeat(Math.max(0, Math.min(5000, room - left + 1))));
    }
  }
}

let win: EventTarget;
let doc: FakeDocument;

function setStorage(s: QuotaStorage | 'blocked'): void {
  if (s === 'blocked') {
    Object.defineProperty(win, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException("Failed to read the 'localStorage' property from 'Window': Access is denied for this document.", 'SecurityError');
      },
    });
  } else Object.defineProperty(win, 'localStorage', { configurable: true, value: s });
}

beforeEach(() => {
  doc = new FakeDocument();
  win = Object.assign(new EventTarget(), {
    innerWidth: 1280,
    innerHeight: 720,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
  setStorage(new QuotaStorage());
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', { getGamepads: () => [] });
  vi.stubGlobal('requestAnimationFrame', () => 0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An event of `type` carrying the given properties (KeyboardEvent and friends don't exist in Node). */
function ev(type: string, props: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  if (type.startsWith('key') && !('getModifierState' in props)) Object.defineProperty(e, 'getModifierState', { value: () => false });
  return e;
}

/** A pointer event plus the compatibility mouse event a browser sends after it. */
function pointer(target: FakeElement, kind: 'down' | 'move' | 'up', x: number, y: number, buttons: number): void {
  target.dispatchEvent(ev(`pointer${kind}`, { clientX: x, clientY: y, buttons, button: kind === 'move' ? -1 : 0, pointerId: 1 }));
}

type Pad = { connected: boolean; mapping: string; axes: number[]; buttons: Array<{ pressed: boolean; touched: boolean; value: number }> };

function fakePad(): Pad {
  const pad: Pad = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  vi.stubGlobal('navigator', { getGamepads: () => [pad, null, null, null] });
  return pad;
}

const ui = (over: Partial<UiActions> = {}): UiActions => ({ pause: false, map: false, camera: false, radioNext: false, radioPrev: false, confirm: false, back: false, up: false, down: false, left: false, right: false, ...over });

/** A save with some progress in it. */
function aSave(money = 4321): SaveData {
  const p = new Progress();
  p.markDone('wheels');
  p.addMoney(money);
  return serialize(p, [{ id: 'shotgun', ammo: 30 }], 50, 12, 3);
}

function makeMenus(over: Partial<MenuHost> = {}) {
  let saved = true;
  let settings: Settings = { quality: 'high', master: 0.8, music: 0.6, sfx: 0.85, sensitivity: 1, invertY: false, fov: 68, hints: true, hintsSeen: [], weather: 'dynamic', lightningFlashes: true, bindings: DEFAULT_BINDINGS, resolutionScale: 1, fpsCap: 0, subtitleSize: 'normal', cameraShake: true, mapLayers: {} };
  let waypoint: { x: number; z: number } | null = null;
  const host = {
    hasSave: () => saved,
    newGame: vi.fn(),
    continueGame: vi.fn(),
    resume: vi.fn(),
    quitToTitle: vi.fn(),
    abandonMission: vi.fn(),
    settings: () => settings,
    applySettings: (s: Settings) => {
      settings = s;
    },
    deleteSave: () => {
      saved = false;
    },
    sim: () => null as Sim | null,
    setWaypoint: (p: { x: number; z: number } | null) => {
      waypoint = p;
    },
    waypoint: () => waypoint,
    click: () => undefined,
    ...over,
  } satisfies MenuHost;
  const menus = new Menus(new FakeElement('div') as unknown as HTMLElement, host, new MapImage(world()));
  const top = () => menus.top!.el as unknown as FakeElement;
  const button = (label: string) => top().all().find((e) => e.tagName === 'BUTTON' && e.textContent === label);
  /** One frame of menu input, past the 0.25 s guard of a screen that just opened. */
  const press = (over: Partial<UiActions>, device?: 'kb' | 'pad') => menus.input(ui(over), 0.3, device);
  return { menus, host, top, button, press, saved: () => saved, waypoint: () => waypoint };
}

/** A Game on the fake DOM, driven through its real frame loop at 60 fps. */
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
  const button = (label: string) => uiRoot.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label);
  const toast = () => uiRoot.all().find((e) => e.dataset.el === 'toast')!.textContent;
  return { game, uiRoot, frames, button, toast };
}

// ---------------------------------------------------------------------------

describe('NEW GAME over a save asks first (critical)', () => {
  it('with a save, NEW GAME opens a question on NO, and only YES starts the game', () => {
    const { menus, host, top, button } = makeMenus();
    menus.showTitle();
    button('NEW GAME')!.click();
    expect(host.newGame).not.toHaveBeenCalled();
    expect(top().all().find((e) => e.tagName === 'P')!.textContent).toContain('Start a new game? Your saved game will be replaced the next time the game saves');
    expect(button('NO')!.classList.contains('sel')).toBe(true);
    expect(button('YES')!.classList.contains('sel')).toBe(false);
    button('YES')!.click();
    expect(host.newGame).toHaveBeenCalledTimes(1);
  });

  it('NO, Esc / B and a second confirm press keep the title and the save', () => {
    const { menus, host, button, press, saved } = makeMenus();
    menus.showTitle();
    button('NEW GAME')!.click();
    button('NO')!.click();
    expect(button('CONTINUE')).toBeDefined();
    button('NEW GAME')!.click();
    press({ back: true });
    expect(button('CONTINUE')).toBeDefined();
    // Keyboard / pad: down to NEW GAME, confirm, and confirm again (the mashing case) lands on NO.
    press({ down: true });
    press({ confirm: true });
    expect(button('YES')).toBeDefined();
    press({ confirm: true });
    expect(button('CONTINUE')).toBeDefined();
    expect(host.newGame).not.toHaveBeenCalled();
    expect(saved()).toBe(true);
    // Up to YES accepts.
    press({ confirm: true });
    press({ up: true });
    press({ confirm: true });
    expect(host.newGame).toHaveBeenCalledTimes(1);
  });

  it('without a save NEW GAME starts at once', () => {
    const { menus, host, button } = makeMenus({ hasSave: () => false });
    menus.showTitle();
    button('NEW GAME')!.click();
    expect(host.newGame).toHaveBeenCalledTimes(1);
    expect(button('YES')).toBeUndefined();
  });

  it('in the game, a NEW GAME click and an autosave no longer replace the save behind the player', () => {
    expect(writeGame(aSave())).toBe(true);
    const harness = makeGame();
    const { game, button } = harness;
    button('NEW GAME')!.click();
    expect(game.mode).toBe('title');
    // What the first autosave of a new session would write (Lou's call starts Wheels 2.5 s in).
    game.sim.events.emit('saveRequested', { poi: 'auto' });
    expect(loadGame()!.money).toBe(250 + 4321);
    button('NO')!.click();
    expect(game.mode).toBe('title');
    expect(loadGame()!.missionsDone).toEqual(['wheels']);
    // Saying YES is the player's choice: the game starts, and with save slots (wave 1) it autosaves into the first
    // empty slot, never over the save in slot 1.
    button('NEW GAME')!.click();
    button('YES')!.click();
    expect(game.mode).toBe('game');
    game.sim.events.emit('saveRequested', { poi: 'auto' });
    // Autosaves are queued and written after the next sim frame.
    expect(loadSlot(2)).toBeNull();
    harness.frames(1);
    expect(loadSlot(2)!.missionsDone).toEqual([]);
    expect(loadSlot(1)!.missionsDone).toEqual(['wheels']);
  });
});

describe('every confirmation opens on NO (medium)', () => {
  it('DELETE SAVE: up x2 (round past BACK), confirm, confirm keeps the save; up then confirm deletes it', () => {
    const { menus, button, press, saved } = makeMenus();
    menus.showSettings();
    // DELETE SAVE sits just above BACK, the last row (wave 1 added rows above it).
    for (let i = 0; i < 2; i++) press({ up: true });
    press({ confirm: true });
    expect(button('NO')!.classList.contains('sel')).toBe(true);
    press({ confirm: true });
    expect(saved()).toBe(true);
    expect(button('DELETE SAVE')).toBeDefined();
    press({ confirm: true });
    press({ up: true });
    expect(button('YES')!.classList.contains('sel')).toBe(true);
    press({ confirm: true });
    expect(saved()).toBe(false);
  });

  it('QUIT TO TITLE: P, W, Space, Space (all gameplay keys) no longer quits', () => {
    const { menus, host, button, press } = makeMenus();
    menus.showPause();
    press({ up: true }); // W wraps from RESUME to QUIT TO TITLE
    press({ confirm: true }); // Space
    expect(button('NO')!.classList.contains('sel')).toBe(true);
    press({ confirm: true }); // Space again
    expect(host.quitToTitle).not.toHaveBeenCalled();
    expect(button('RESUME')).toBeDefined();
    press({ confirm: true });
    press({ up: true });
    press({ confirm: true });
    expect(host.quitToTitle).toHaveBeenCalledTimes(1);
  });

  it('ABANDON MISSION asks too, on NO', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    expect(sim.missions.start('wheels')).toBe(true);
    const { menus, host, button, press } = makeMenus({ sim: () => sim });
    menus.showPause();
    button('ABANDON MISSION')!.click();
    expect(host.abandonMission).not.toHaveBeenCalled();
    expect(button('NO')!.classList.contains('sel')).toBe(true);
    press({ confirm: true });
    expect(host.abandonMission).not.toHaveBeenCalled();
    button('ABANDON MISSION')!.click();
    button('YES')!.click();
    expect(host.abandonMission).toHaveBeenCalledTimes(1);
  });
});

describe('a full localStorage keeps the save reachable (medium)', () => {
  /** A save and settings stored while there was room, then the origin filled by another game until a 15-character write fails. */
  function fullStorage() {
    const store = new QuotaStorage(60_000);
    setStorage(store);
    const save = aSave();
    expect(writeGame(save)).toBe(true);
    store.setItem('gta7.settings.v1', JSON.stringify({ quality: 'low', master: 0.3, music: 0.6, sfx: 0.85, sensitivity: 1, invertY: true, fov: 80, hints: false, hintsSeen: ['drive'] }));
    store.fill(15);
    expect(() => store.setItem('__x__', '0123456789')).toThrow();
    return { store, save };
  }

  it('loads the save and the settings, rewrites a save of the same size, and deletes it', () => {
    const { store, save } = fullStorage();
    expect(loadGame()?.money).toBe(save.money);
    const s = loadSettings();
    expect([s.quality, s.master, s.invertY, s.fov, s.hints, s.hintsSeen]).toEqual(['low', 0.3, true, 80, false, ['drive']]);
    // The same save again (as a safehouse save right after a load): no more room needed.
    expect(writeGame(save)).toBe(true);
    deleteGame();
    expect(store.getItem('gta7.save.v1')).toBe(null);
    expect(loadGame()).toBe(null);
  });

  it('the title offers CONTINUE, and a save that needs more room says the storage is full and keeps the old one', () => {
    const { save } = fullStorage();
    const { game, button, toast } = makeGame();
    expect(button('CONTINUE')!.disabled).toBe(false);
    button('CONTINUE')!.click();
    // The slot picker (wave 1): the save is in slot 1.
    button('SLOT 1')!.click();
    expect(game.mode).toBe('game');
    expect(game.sim.progress.money).toBe(save.money);
    // More progress, a longer save: it does not fit.
    for (const id of ['delivery', 'repo', 'loose_lips', 'heatwave']) game.sim.progress.markDone(id);
    game.sim.events.emit('saveRequested', { poi: 'safehouse' });
    button('SLOT 1')!.click();
    button('YES')!.click(); // overwrite slot 1
    expect(toast()).toBe('Could not save: browser storage is full');
    expect(loadGame()!.missionsDone).toEqual(['wheels']);
  });

  it('blocked storage (the property throws) reads as no save and says so when saving', () => {
    setStorage('blocked');
    expect(loadGame()).toBe(null);
    expect(loadSettings().quality).toBe('auto');
    expect(writeGame(aSave())).toBe(false);
    expect(() => deleteGame()).not.toThrow();
    const { game, button, toast } = makeGame();
    expect(button('CONTINUE')!.disabled).toBe(true);
    game.newGame({ intro: false });
    game.sim.events.emit('saveRequested', { poi: 'safehouse' });
    button('SLOT 1')!.click();
    expect(toast()).toBe('Could not save: browser storage is unavailable');
  });
});

describe('CONTROLS, STATS and CREDITS scroll with the keyboard and a pad (medium)', () => {
  /** The open screen's panel, laid out as at 1280 x 720: 931 px of content in a 560 px box. */
  function panelOf(top: () => FakeElement) {
    const panel = top().children.find((c) => c.classList.contains('panel'))!;
    panel.clientHeight = 560;
    panel.scrollHeight = 931;
    return panel;
  }

  for (const screen of ['CONTROLS', 'STATS', 'CREDITS'] as const) {
    it(`${screen}: down / up scroll half a page, the panel takes the focus, and the cue shows while there is more`, () => {
      const sim = new Sim({ world: world(), ambient: false, police: false });
      const { menus, top, button, press } = makeMenus({ sim: () => sim });
      if (screen === 'CONTROLS') menus.showControls();
      else if (screen === 'STATS') menus.showStats();
      else menus.showCredits();
      const panel = panelOf(top);
      expect(panel.tabIndex).toBe(-1);
      expect(panel.focused).toEqual({ preventScroll: true });
      const cue = panel.all().find((e) => e.classList.contains('scroll-cue'))!;
      press({});
      expect(cue.classList.contains('hidden')).toBe(false);
      press({ down: true });
      expect(panel.scrollTop).toBe(280);
      press({ down: true });
      expect(panel.scrollTop).toBe(371); // the end: BACK and the last rows are in view
      press({});
      expect(cue.classList.contains('hidden')).toBe(true);
      press({ up: true });
      expect(panel.scrollTop).toBe(91);
      expect(button('BACK')).toBeDefined();
      press({ back: true });
      expect(menus.open).toBe(false);
    });
  }

  it('the gamepad list names every binding: horn L3, camera R3, X shoots from a vehicle, RT shoots on foot', () => {
    const { menus, top } = makeMenus();
    menus.showControls();
    const html = top().children.find((c) => c.classList.contains('panel'))!.innerHTML;
    const pad = html.slice(html.indexOf('<h3>Gamepad</h3>'), html.indexOf('<h3>Tips</h3>'));
    const rows = [...pad.matchAll(/<div><span>([^<]*)<\/span><span>([^<]*)<\/span><\/div>/g)].map((m) => `${m[1]}: ${m[2]}`);
    expect(rows).toContain('Horn (in a vehicle): L3');
    expect(rows).toContain('Camera distance: R3');
    expect(rows).toContain('Shoot from a vehicle: X');
    expect(rows).toContain('Shoot (on foot) / Accelerate: RT');
    expect(rows.some((r) => r.startsWith('Accelerate / Shoot'))).toBe(false);
  });
});

describe('the full-screen map without a mouse (medium)', () => {
  function mapRig() {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    const rig = makeMenus({ sim: () => sim });
    rig.menus.showMap();
    rig.press({}); // the first frame sizes the canvas to the 1280 x 720 window
    const canvas = rig.top().children[0]!;
    const map = (rig.menus as unknown as { map: MapImage }).map;
    const base = Math.min(1280 / (map.canvas.width / MAP_SCALE), 720 / (map.canvas.height / MAP_SCALE));
    const b = sim.world.layout.bounds;
    const centre = { x: (b.landMinX + b.beachEndX) / 2, z: (b.landMinZ + b.landMaxZ) / 2 };
    const hint = () => rig.top().children.find((c) => c.classList.contains('map-hint'))!.innerHTML;
    /** The scale (px per m), read back from where a click 100 px right of the view centre drops the waypoint. */
    const scale = () => {
      const keep = rig.waypoint();
      rig.host.setWaypoint(null);
      pointer(canvas, 'down', 740, 360, 1);
      pointer(canvas, 'up', 740, 360, 0);
      const wp = rig.waypoint()!;
      rig.host.setWaypoint(keep);
      return 100 / (wp.x - viewCentre().x);
    };
    /** The view centre, read back from a confirm (the cross), which is then undone. */
    const viewCentre = () => {
      const keep = rig.waypoint();
      rig.host.setWaypoint(null);
      rig.press({ confirm: true });
      const c = rig.waypoint()!;
      rig.host.setWaypoint(keep);
      return c;
    };
    return { ...rig, sim, canvas, base, centre, hint, scale, viewCentre };
  }

  it('confirm (Enter, Space, A) sets the waypoint at the cross in the middle, and again clears it', () => {
    const { press, waypoint, centre, top } = mapRig();
    // The cross is a page element over the middle of the canvas (style.css), not drawn into it.
    expect(top().children.filter((c) => c.classList.contains('map-cross'))).toHaveLength(1);
    expect(waypoint()).toBe(null);
    press({ confirm: true });
    expect(waypoint()!.x).toBeCloseTo(centre.x, 6);
    expect(waypoint()!.z).toBeCloseTo(centre.z, 6);
    press({ confirm: true });
    expect(waypoint()).toBe(null);
  });

  it('the zoom actions (+ / -, RB / LB) step the zoom by half a level within its limits', () => {
    const { press, scale, base } = mapRig();
    expect(scale() / base).toBeCloseTo(1, 6);
    press({ zoomIn: true });
    expect(scale() / base).toBeCloseTo(1.5 ** 0.5, 6);
    for (let i = 0; i < 12; i++) press({ zoomIn: true });
    expect(scale() / base).toBeCloseTo(1.5 ** 4, 6);
    press({ zoomOut: true });
    expect(scale() / base).toBeCloseTo(1.5 ** 3.5, 6);
    for (let i = 0; i < 12; i++) press({ zoomOut: true });
    expect(scale() / base).toBeCloseTo(1, 6);
  });

  it('a held direction or the stick pans the view, faster the further it is pushed', () => {
    const { menus, press, viewCentre, centre, base } = mapRig();
    press({});
    const speed = (0.8 * 720) / base; // m per second at full deflection
    for (let i = 0; i < 30; i++) menus.input(ui({ panX: 1 }), 1 / 60);
    expect(viewCentre().x - centre.x).toBeCloseTo(speed * 0.5, 4);
    for (let i = 0; i < 60; i++) menus.input(ui({ panY: -0.5 }), 1 / 60);
    expect(viewCentre().z - centre.z).toBeCloseTo(-speed * 0.5, 4);
  });

  it('each press steps the view 60 px as before, even a tap too short to be seen held, and holding keeps it moving', () => {
    const { menus, press, viewCentre, centre, scale } = mapRig();
    const k = scale();
    // keydown and keyup between two polls (a quick tap, page.keyboard.press): pressed, never held.
    press({ right: true });
    expect((viewCentre().x - centre.x) * k).toBeCloseTo(60, 6);
    press({ down: true });
    expect((viewCentre().z - centre.z) * k).toBeCloseTo(60, 6);
    press({ left: true, up: true });
    expect(viewCentre().x).toBeCloseTo(centre.x, 6);
    expect(viewCentre().z).toBeCloseTo(centre.z, 6);
    // A press still held when Input polls: the step, then the held pan (0.8 of the 720 px view a second).
    menus.input(ui({ right: true, panX: 1 }), 1 / 60);
    expect((viewCentre().x - centre.x) * k).toBeCloseTo(60 + (0.8 * 720) / 60, 6);
  });

  it('the hint names the controls of the device in use, and follows a change of device', () => {
    const { press, hint } = mapRig();
    expect(hint()).toContain('<kbd>Enter</kbd> at the cross');
    expect(hint()).toContain('<kbd>+</kbd> <kbd>-</kbd> to zoom');
    expect(hint()).toContain('<kbd>M</kbd>/<kbd>Esc</kbd> to close');
    press({}, 'pad');
    for (const glyph of ['pad-a', 'pad-lb', 'pad-rb', 'pad-b']) expect(hint()).toContain(`class="pad ${glyph}"`);
    expect(hint()).not.toContain('Click');
    press({}, 'kb');
    expect(hint()).toContain('<kbd>Enter</kbd>');
  });

  it('Input binds them: + and - on any layout, the keypad, RB / LB; held arrows, the D-pad and the stick pan', () => {
    const pad = fakePad();
    const inp = new Input(new FakeElement('canvas') as unknown as HTMLCanvasElement);
    inp.attach();
    const frame = () => {
      const fi = inp.poll(1 / 60);
      inp.endFrame();
      return fi.ui;
    };
    const key = (code: string, k: string) => {
      win.dispatchEvent(ev('keydown', { code, key: k, repeat: false }));
      const u = frame();
      win.dispatchEvent(ev('keyup', { code, key: k, repeat: false }));
      return u;
    };
    expect(key('Equal', '=').zoomIn).toBe(true);
    expect(key('NumpadAdd', '+').zoomIn).toBe(true);
    expect(key('BracketRight', '+').zoomIn).toBe(true); // QWERTZ's + key
    expect(key('Minus', '-').zoomOut).toBe(true);
    expect(key('NumpadSubtract', '-').zoomOut).toBe(true);
    expect(key('Digit6', '-').zoomOut).toBe(true); // AZERTY's - (still weapon slot 6 in play)
    expect(key('KeyW', 'w').zoomIn).toBe(false);
    // Held keys pan; a press alone does not repeat.
    win.dispatchEvent(ev('keydown', { code: 'ArrowRight', key: 'ArrowRight', repeat: false }));
    expect(frame().panX).toBe(1);
    expect(frame().panX).toBe(1);
    win.dispatchEvent(ev('keyup', { code: 'ArrowRight', key: 'ArrowRight', repeat: false }));
    expect(frame().panX).toBe(0);
    // A tap whose keyup comes before the poll is pressed but was never held: the map steps the view for it.
    win.dispatchEvent(ev('keydown', { code: 'ArrowLeft', key: 'ArrowLeft', repeat: false }));
    win.dispatchEvent(ev('keyup', { code: 'ArrowLeft', key: 'ArrowLeft', repeat: false }));
    const tapped = frame();
    expect([tapped.left, tapped.panX]).toEqual([true, 0]);
    // The pad: RB / LB taps zoom, the D-pad and the dead-zoned left stick pan.
    pad.buttons[5]!.pressed = true;
    expect(frame().zoomIn).toBe(true);
    expect(frame().zoomIn).toBe(false);
    pad.buttons[5]!.pressed = false;
    pad.buttons[4]!.pressed = true;
    expect(frame().zoomOut).toBe(true);
    pad.buttons[4]!.pressed = false;
    pad.buttons[14]!.pressed = true;
    expect(frame().panX).toBe(-1);
    pad.buttons[14]!.pressed = false;
    pad.axes[1] = 0.59;
    const u = frame();
    expect(u.panY).toBeCloseTo((0.59 - 0.18) / (1 - 0.18), 6);
    expect(u.panX).toBe(0);
    inp.detach();
  });

  it('in the game, a pad alone opens the map with Back and drops a waypoint with A', async () => {
    const pad = fakePad();
    const { game, frames } = makeGame();
    game.newGame({ intro: false });
    await new Promise((r) => setTimeout(r, 0));
    frames(3);
    const tap = (i: number) => {
      pad.buttons[i]!.pressed = true;
      frames(2);
      pad.buttons[i]!.pressed = false;
      frames(2);
    };
    tap(8); // Back
    expect(game.menus.open).toBe(true);
    frames(20); // past the screen's input guard
    const hint = (game.menus.top!.el as unknown as FakeElement).children.find((c) => c.classList.contains('map-hint'))!;
    expect(hint.innerHTML).toContain('class="pad pad-a"');
    tap(0); // A
    expect(game.hud.waypoint).not.toBe(null);
    tap(0);
    expect(game.hud.waypoint).toBe(null);
  });
});

describe('the mouse and the menu selection (low)', () => {
  it('moving over the greyed-out CONTINUE leaves NEW GAME selected, and Enter still starts a game', () => {
    const { menus, host, button, press } = makeMenus({ hasSave: () => false });
    menus.showTitle();
    const cont = button('CONTINUE')!;
    expect(cont.disabled).toBe(true);
    cont.dispatchEvent(ev('mousemove'));
    cont.dispatchEvent(ev('mouseenter'));
    expect(cont.classList.contains('sel')).toBe(false);
    expect(button('NEW GAME')!.classList.contains('sel')).toBe(true);
    press({ confirm: true });
    expect(host.newGame).toHaveBeenCalledTimes(1);
  });

  it('a real mouse move selects an item, so only one row is lit; a screen opening under the cursor keeps its default', () => {
    const { menus, button } = makeMenus();
    menus.showTitle();
    const lit = () => ['CONTINUE', 'NEW GAME', 'CONTROLS', 'SETTINGS', 'CREDITS'].filter((l) => button(l)!.classList.contains('sel'));
    expect(lit()).toEqual(['CONTINUE']);
    button('CREDITS')!.dispatchEvent(ev('mouseenter')); // no movement: as when a screen appears under a resting cursor
    expect(lit()).toEqual(['CONTINUE']);
    button('CREDITS')!.dispatchEvent(ev('mousemove'));
    expect(lit()).toEqual(['CREDITS']);
  });

  it('in SETTINGS, moving over the greyed-out DELETE SAVE does not select it', () => {
    const { menus, top, button } = makeMenus({ hasSave: () => false });
    menus.showSettings();
    const del = button('DELETE SAVE')!;
    del.dispatchEvent(ev('mouseenter'));
    del.dispatchEvent(ev('mousemove'));
    expect(del.classList.contains('sel')).toBe(false);
    const rows = top().all().filter((e) => e.classList.contains('sel'));
    expect(rows).toHaveLength(1);
    button('BACK')!.dispatchEvent(ev('mousemove'));
    expect(button('BACK')!.classList.contains('sel')).toBe(true);
  });
});

describe('the gun shop says what to press on the device in use (low)', () => {
  it('keyboard: click or Enter, Esc; pad: the D-pad, A and B', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    const { menus, top, press } = makeMenus({ sim: () => sim });
    menus.showShop(() => undefined);
    const line = () => top().all().find((e) => e.classList.contains('shop-how'))!.innerHTML;
    expect(line()).toBe('Click or press <kbd>Enter</kbd> to buy, <kbd>Esc</kbd> to leave.');
    press({}, 'pad');
    expect(line()).toContain('class="pad pad-a"');
    expect(line()).toContain('class="pad pad-b"');
    expect(line()).toContain('aria-label="D-pad up"');
    expect(line()).not.toContain('Enter');
    press({}, 'kb');
    expect(line()).toContain('<kbd>Enter</kbd>');
  });
});

describe('wave 1: three save slots through the game', () => {
  const raw = (slot: number) => (window.localStorage as unknown as QuotaStorage).getItem(slotKey(slot));

  it('the safehouse asks for a slot: BACK saves nothing, an empty slot saves at once, a filled one asks first', () => {
    expect(storeSlot(1, aSave(1111))).toBeNull();
    const { game, button, toast, uiRoot, frames } = makeGame();
    button('CONTINUE')!.click();
    button('SLOT 1')!.click();
    expect(game.mode).toBe('game');
    const slot1 = raw(1);
    game.sim.progress.addMoney(5);
    game.sim.events.emit('saveRequested', { poi: 'safehouse' });
    expect(['SLOT 1', 'SLOT 2', 'SLOT 3', 'BACK'].every((l) => button(l))).toBe(true);
    expect(game.menus.open).toBe(true);
    button('BACK')!.click();
    expect(game.menus.open).toBe(false);
    expect([raw(1), raw(2), raw(3)]).toEqual([slot1, null, null]);
    // Slot 2 is empty: saved there at once.
    game.sim.events.emit('saveRequested', { poi: 'safehouse' });
    button('SLOT 2')!.click();
    expect(toast()).toBe('Game saved');
    expect(game.menus.open).toBe(false);
    expect(loadSlot(2)!.money).toBe(250 + 1111 + 5);
    expect(raw(1)).toBe(slot1);
    // Slot 1 holds a save: it asks, naming it; NO leaves it as it was and goes back to the picker.
    game.sim.events.emit('saveRequested', { poi: 'safehouse' });
    button('SLOT 1')!.click();
    const question = uiRoot.all().find((e) => e.tagName === 'P' && e.textContent.startsWith('Overwrite'))!.textContent;
    expect(question).toContain('slot 1');
    expect(question).toContain('Missions 1/');
    button('NO')!.click();
    expect(raw(1)).toBe(slot1);
    expect(button('SLOT 3')).toBeDefined();
    button('SLOT 1')!.click();
    button('YES')!.click();
    expect(loadSlot(1)!.money).toBe(250 + 1111 + 5);
    // An autosave goes to the slot last saved to (1), not to 2.
    const slot2 = raw(2);
    game.sim.progress.addMoney(7);
    game.sim.events.emit('saveRequested', { poi: 'auto' });
    frames(1);
    expect(loadSlot(1)!.money).toBe(250 + 1111 + 12);
    expect(raw(2)).toBe(slot2);
  });

  it('CONTINUE lists the three slots: empty and unreadable ones cannot be loaded, the chosen one loads', () => {
    expect(storeSlot(1, aSave(100))).toBeNull();
    (window.localStorage as unknown as QuotaStorage).setItem(slotKey(2), '{"broken');
    expect(storeSlot(3, aSave(300))).toBeNull();
    const { game, button, uiRoot } = makeGame();
    button('CONTINUE')!.click();
    expect([button('SLOT 1')!.disabled, button('SLOT 2')!.disabled, button('SLOT 3')!.disabled]).toEqual([false, true, false]);
    expect(uiRoot.all().some((e) => e.classList.contains('slot-summary') && e.textContent === 'Unreadable save')).toBe(true);
    button('SLOT 3')!.click();
    expect(game.sim.progress.money).toBe(250 + 300);
    expect(currentSlot()).toBe(3);
  });

  it("SETTINGS' DELETE SAVE asks which slot, confirms, and removes that one only", () => {
    expect(storeSlot(1, aSave(100))).toBeNull();
    expect(storeSlot(2, aSave(200))).toBeNull();
    const { button } = makeGame();
    button('SETTINGS')!.click();
    button('DELETE SAVE')!.click();
    expect(button('SLOT 3')!.disabled).toBe(true);
    const slot1 = raw(1);
    button('SLOT 2')!.click();
    button('NO')!.click();
    expect(raw(2)).not.toBeNull();
    button('SLOT 2')!.click();
    button('YES')!.click();
    expect(raw(2)).toBeNull();
    expect(raw(1)).toBe(slot1);
  });
});
