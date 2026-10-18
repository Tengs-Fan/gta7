// Round 2, fix pass 4 (menus): the pause menu once a mission's goal is met, a full-screen map that ignores a
// direction held since before it opened, and a map canvas backed at the device pixel ratio.
// Node has no DOM: the menus run on the small fakes below (as in r2_fix3_menus.test.ts), whose canvases record
// every 2D drawing call.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiActions } from '../../src/input/input';
import type { Settings } from '../../src/settings';
import type { MissionCtx } from '../../src/sim/missions/runner';
import { missionSpots } from '../../src/sim/missions/spots';
import { Sim } from '../../src/sim/sim';
import { MAP_SCALE, MapImage } from '../../src/ui/mapRender';
import { Menus, type MenuHost } from '../../src/ui/menus';
import { input, step, teleport, world } from './helpers';

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

/** One 2D context call: a method and its arguments, or `=prop` and the value written to it. */
type Call = [string, unknown[]];

/** A 2D context that accepts any drawing call and records it. */
function recordingContext(calls: Call[]): unknown {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) =>
      k in t
        ? t[k]
        : (...args: unknown[]) => {
            calls.push([String(k), args]);
            return { addColorStop: () => undefined, width: 0 };
          },
    set: (t, k, v) => {
      t[k] = v;
      calls.push([`=${String(k)}`, [v]]);
      return true;
    },
  });
}

class FakeElement extends EventTarget {
  readonly tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  disabled = false;
  width = 300;
  height = 150;
  clientWidth = 0;
  clientHeight = 0;
  scrollHeight = 0;
  scrollTop = 0;
  tabIndex = 0;
  /** Every call made on this canvas's 2D context, in order. */
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
  getContext(): unknown {
    this.ctx ??= recordingContext(this.calls);
    return this.ctx;
  }
  /** The map canvas fills the window (style.css): its box on the page, in CSS px, whatever its backing store. */
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight };
  }
  click(): void {
    if (!this.disabled) this.dispatchEvent(new Event('click'));
  }
  focus(): void {}
  scrollBy(): void {}
  setPointerCapture(): void {}
}

class FakeDocument extends EventTarget {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
}

let win: EventTarget & { innerWidth: number; innerHeight: number; devicePixelRatio: number };

beforeEach(() => {
  win = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1 });
  vi.stubGlobal('document', new FakeDocument());
  vi.stubGlobal('window', win);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An event of `type` carrying the given properties (PointerEvent doesn't exist in Node). */
function ev(type: string, props: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  return e;
}

function pointer(target: FakeElement, kind: 'down' | 'up', x: number, y: number): void {
  target.dispatchEvent(ev(`pointer${kind}`, { clientX: x, clientY: y, buttons: kind === 'down' ? 1 : 0, button: 0, pointerId: 1 }));
}

const ui = (over: Partial<UiActions> = {}): UiActions => ({ pause: false, map: false, camera: false, radioNext: false, radioPrev: false, confirm: false, back: false, up: false, down: false, left: false, right: false, ...over });

function makeMenus(sim: Sim | null) {
  let waypoint: { x: number; z: number } | null = null;
  const settings: Settings = { quality: 'high', master: 0.8, music: 0.6, sfx: 0.85, sensitivity: 1, invertY: false, fov: 68, hints: true, hintsSeen: [] };
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
  const menus = new Menus(new FakeElement('div') as unknown as HTMLElement, host, new MapImage(world()));
  const top = () => menus.top!.el as unknown as FakeElement;
  const button = (label: string) => top().all().find((e) => e.tagName === 'BUTTON' && e.textContent === label);
  const labels = () => top().all().filter((e) => e.tagName === 'BUTTON').map((e) => e.textContent);
  /** One frame of menu input, past the 0.25 s guard of a screen that just opened. */
  const press = (over: Partial<UiActions>) => menus.input(ui(over), 0.3);
  return { menus, host, top, button, labels, press, waypoint: () => waypoint };
}

// ---------------------------------------------------------------------------

describe('the pause menu once a mission goal is met (low)', () => {
  /** Steps until the predicate holds (or fails after `max` seconds). */
  function stepUntil(sim: Sim, pred: () => boolean, max: number): void {
    for (let t = 0; t < max && !pred(); t += 1 / 60) sim.update(1 / 60, input());
    expect(pred(), 'condition not reached in time').toBe(true);
  }

  /** Plays Wheels up to Lou's closing hand-over: a car driven into her bay, so its goal is met (MissionCtx.complete). */
  function wheelsDelivered(): { sim: Sim; m: MissionCtx } {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    sim.cheats.godMode = true;
    step(sim, 0.1);
    const marker = sim.interactions.markers.find((k) => k.kind === 'mission' && k.ref === 'wheels')!;
    teleport(sim, marker.x, marker.z);
    step(sim, 0.1);
    sim.update(1 / 60, input({ interact: true }));
    const m = sim.missions.active!;
    expect(m.def.id).toBe('wheels');
    stepUntil(sim, () => m.objectiveText === 'Steal a car', 20);
    const spots = missionSpots(sim.world);
    const car = sim.spawnVehicle('sedan', spots.louBay.x, spots.louBay.z, spots.lou.heading + Math.PI);
    sim.seat(sim.player, car, 0);
    stepUntil(sim, () => m.won, 3);
    return { sim, m };
  }

  /** The pause panel's mission line. */
  const line = (top: () => FakeElement) => top().all().find((e) => e.tagName === 'P')!.textContent;

  it('during the closing hand-over there is no ABANDON MISSION (an abandon would pass it), and the line says it is complete', () => {
    const { sim, m } = wheelsDelivered();
    // Still the active mission, and an abandon now would pass it (MissionCtx.fail past the goal).
    expect(sim.missions.active).toBe(m);
    const rig = makeMenus(sim);
    rig.menus.showPause();
    expect(rig.labels()).toEqual(['RESUME', 'MAP', 'STATS', 'CONTROLS', 'SETTINGS', 'QUIT TO TITLE']);
    expect(line(rig.top)).toBe('Mission: Wheels — complete');
    expect(rig.top().all().some((e) => e.textContent.includes('start it again'))).toBe(false);
    // Keyboard and pad: up from RESUME wraps to QUIT TO TITLE, which still asks first.
    rig.press({ up: true });
    rig.press({ confirm: true });
    expect(rig.button('NO')!.classList.contains('sel')).toBe(true);
    expect(rig.host.abandonMission).not.toHaveBeenCalled();
  });

  it('before the goal the pause menu still offers ABANDON MISSION, with its warning, and shows the objective', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    expect(sim.missions.start('wheels')).toBe(true);
    const m = sim.missions.active!;
    m.objective('Steal a car');
    const rig = makeMenus(sim);
    rig.menus.showPause();
    expect(rig.labels()).toEqual(['RESUME', 'MAP', 'STATS', 'CONTROLS', 'SETTINGS', 'ABANDON MISSION', 'QUIT TO TITLE']);
    expect(line(rig.top)).toBe('Mission: Wheels — Steal a car');
    rig.button('ABANDON MISSION')!.click();
    expect(rig.top().all().find((e) => e.tagName === 'P')!.textContent).toBe('Abandon the mission? You will have to start it again from the beginning.');
    rig.button('YES')!.click();
    expect(rig.host.abandonMission).toHaveBeenCalledTimes(1);
    // The goal met (as each script does after its last objective): the item goes.
    rig.menus.closeAll();
    m.complete();
    rig.menus.showPause();
    expect(rig.button('ABANDON MISSION')).toBeUndefined();
    expect(line(rig.top)).toBe('Mission: Wheels — complete');
  });
});

describe('the full-screen map and a direction held since before it opened (low)', () => {
  function mapRig() {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    const rig = makeMenus(sim);
    rig.menus.showMap();
    const canvas = rig.top().children[0]!;
    const map = (rig.menus as unknown as { map: MapImage }).map;
    const base = Math.min(win.innerWidth / (map.canvas.width / MAP_SCALE), win.innerHeight / (map.canvas.height / MAP_SCALE));
    const b = sim.world.layout.bounds;
    const centre = { x: (b.landMinX + b.beachEndX) / 2, z: (b.landMinZ + b.landMaxZ) / 2 };
    /** World metres a second at full deflection: 0.8 of the smaller side of the page (CSS px) a second, at zoom 0. */
    const speed = (0.8 * Math.min(win.innerWidth, win.innerHeight)) / base;
    /** One 60 fps frame of menu input (the screen's input guard counts these too). */
    const frame = (over: Partial<UiActions> = {}) => rig.menus.input(ui(over), 1 / 60);
    /** Where a click at (x, y) on the page drops the waypoint, which is then put back: no menu input runs. */
    const clickAt = (x: number, y: number) => {
      const keep = rig.waypoint();
      rig.host.setWaypoint(null);
      pointer(canvas, 'down', x, y);
      pointer(canvas, 'up', x, y);
      const w = rig.waypoint()!;
      rig.host.setWaypoint(keep);
      return w;
    };
    /** The view centre: where a click on the cross in the middle of the page drops the waypoint. */
    const viewCentre = () => clickAt(win.innerWidth / 2, win.innerHeight / 2);
    return { ...rig, sim, canvas, base, centre, speed, frame, clickAt, viewCentre };
  }

  it('W held from driving through the opening and the input guard pans nothing; let go and held again, it pans', () => {
    const { frame, viewCentre, centre, speed } = mapRig();
    // W went down in play before M opened the map, and stays down for a second.
    for (let i = 0; i < 60; i++) frame({ panY: -1 });
    expect(viewCentre().x).toBeCloseTo(centre.x, 6);
    expect(viewCentre().z).toBeCloseTo(centre.z, 6);
    // Let go, then held again: the view pans north at 0.8 of the view a second.
    frame({});
    for (let i = 0; i < 30; i++) frame({ panY: -1 });
    expect(viewCentre().x).toBeCloseTo(centre.x, 6);
    expect(viewCentre().z - centre.z).toBeCloseTo(-speed * 0.5, 4);
  });

  it('the left stick held while steering pans nothing until it comes back to the centre', () => {
    const { frame, viewCentre, centre, speed } = mapRig();
    for (let i = 0; i < 60; i++) frame({ panX: 0.7, panY: -0.4 });
    expect(viewCentre().x).toBeCloseTo(centre.x, 6);
    expect(viewCentre().z).toBeCloseTo(centre.z, 6);
    frame({ panX: 0, panY: 0 });
    for (let i = 0; i < 30; i++) frame({ panX: 0.5, panY: 0 });
    expect(viewCentre().x - centre.x).toBeCloseTo(speed * 0.25, 4);
    expect(viewCentre().z).toBeCloseTo(centre.z, 6);
  });

  it('each axis is let go on its own: with W still held from driving, D pans east while W still pans nothing', () => {
    const { frame, viewCentre, centre, speed, base } = mapRig();
    for (let i = 0; i < 30; i++) frame({ panY: -1 });
    // D pressed (its 60 px step) and held for half a second, W still down.
    frame({ right: true, panX: 1, panY: -1 });
    for (let i = 0; i < 29; i++) frame({ panX: 1, panY: -1 });
    expect(viewCentre().x - centre.x).toBeCloseTo(60 / base + speed * 0.5, 4);
    expect(viewCentre().z).toBeCloseTo(centre.z, 6);
  });

  it('presses still step the view 60 px while a direction held from before is ignored', () => {
    const { frame, viewCentre, centre, base } = mapRig();
    for (let i = 0; i < 30; i++) frame({ panY: -1 });
    // ArrowUp pressed while W is still held from driving: the step, and no held pan.
    frame({ up: true, panY: -1 });
    frame({ panY: -1 });
    expect((viewCentre().z - centre.z) * base).toBeCloseTo(-60, 6);
    expect(viewCentre().x).toBeCloseTo(centre.x, 6);
  });

  it('a direction pressed and held right after the map opens, inside the input guard, pans once the guard is over', () => {
    const { frame, viewCentre, centre, speed } = mapRig();
    // The frame after M: nothing held. Then the right arrow, held from the next frame on.
    frame({});
    let elapsed = 1 / 60;
    let panned = 0;
    for (let i = 0; i < 60; i++) {
      elapsed += 1 / 60;
      frame({ panX: 1 });
      if (elapsed >= 0.25 + 1e-9) panned += 1 / 60;
    }
    // Every frame past the 0.25 s guard panned (give or take the one on its edge).
    expect(viewCentre().x - centre.x).toBeGreaterThan(speed * (panned - 1.5 / 60));
    expect(viewCentre().x - centre.x).toBeLessThan(speed * (panned + 1.5 / 60));
  });
});

describe('the full-screen map canvas at the device pixel ratio (low)', () => {
  /** The map opened at this pixel ratio and window size, drawn once. */
  function mapAt(ratio: number, w = 1280, h = 720) {
    win.devicePixelRatio = ratio;
    win.innerWidth = w;
    win.innerHeight = h;
    const sim = new Sim({ world: world(), ambient: false, police: false });
    const rig = makeMenus(sim);
    rig.menus.showMap();
    const canvas = rig.top().children[0]!;
    rig.menus.input(ui(), 1 / 60); // the first frame sizes the canvas and draws it
    const clickAt = (x: number, y: number) => {
      pointer(canvas, 'down', x, y);
      pointer(canvas, 'up', x, y);
      return rig.waypoint();
    };
    return { ...rig, sim, canvas, clickAt };
  }

  it('the backing store is the page size times the ratio, at most 2, drawn through a matching transform', () => {
    const cases: Array<[ratio: number, w: number, h: number, bw: number, bh: number]> = [
      [1, 1280, 720, 1280, 720],
      [2, 1280, 720, 2560, 1440],
      [3, 1280, 720, 2560, 1440],
      [1.25, 1366, 768, 1708, 960],
    ];
    for (const [ratio, w, h, bw, bh] of cases) {
      const { canvas } = mapAt(ratio, w, h);
      expect([canvas.width, canvas.height], `ratio ${ratio}`).toEqual([bw, bh]);
      // Each frame starts from the transform from CSS px to the backing store (resizing the canvas resets it).
      const first = canvas.calls.findIndex(([k]) => !k.startsWith('='));
      expect(canvas.calls[first], `ratio ${ratio}`).toEqual(['setTransform', [bw / w, 0, 0, bh / h, 0, 0]]);
    }
  });

  it('the drawing itself is in CSS px: every call but the transform is the same at ratio 1 and 2', () => {
    const drawn = (ratio: number) => {
      const { canvas } = mapAt(ratio);
      return JSON.stringify(
        canvas.calls.filter(([k]) => k !== 'setTransform'),
        (_k, v: unknown) => (v instanceof FakeElement ? v.tagName : v),
      );
    };
    const one = drawn(1);
    expect(one).toContain('"fillRect",[0,0,1280,720]');
    expect(drawn(2)).toBe(one);
  });

  it('a click, the cross and the 16 px clear radius land on the same world points at ratio 1 and 2, and the pan speed is the same', () => {
    const run = (ratio: number) => {
      const rig = mapAt(ratio);
      const out: Record<string, unknown> = {};
      out.click = rig.clickAt(900, 200);
      // 17 CSS px off the waypoint sets a new one there; 15 px off that one clears it.
      out.far = rig.clickAt(917, 200);
      out.near = rig.clickAt(932, 200);
      rig.host.setWaypoint(null);
      // A click on the cross is the view centre, where Enter / A put the waypoint.
      out.cross = rig.clickAt(640, 360);
      rig.host.setWaypoint(null);
      rig.press({ confirm: true });
      out.confirm = rig.waypoint();
      rig.host.setWaypoint(null);
      // Held right for half a second: the view moves the same distance.
      for (let i = 0; i < 30; i++) rig.menus.input(ui({ panX: 1 }), 1 / 60);
      out.panned = rig.clickAt(640, 360);
      return out;
    };
    const one = run(1);
    const two = run(2);
    expect(one.near).toBe(null);
    expect(one.far).not.toBe(null);
    expect(one.cross).toEqual(one.confirm);
    for (const k of ['click', 'far', 'cross', 'confirm', 'panned']) {
      const a = one[k] as { x: number; z: number };
      const b = two[k] as { x: number; z: number };
      expect(b.x, k).toBeCloseTo(a.x, 6);
      expect(b.z, k).toBeCloseTo(a.z, 6);
    }
    expect(two.near).toBe(null);
  });
});
