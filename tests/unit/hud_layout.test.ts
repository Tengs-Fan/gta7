// The top-right HUD column (status cluster plus its toast stack), the title card keeping clear of it, and the radar's
// route line starting at the player. Node has no DOM, so the HUD runs against a small fake one; element boxes are
// whatever a test sets (nothing is laid out unless it says so).

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sim } from '../../src/sim/sim';
import { Hud, trimRoute } from '../../src/ui/hud';
import { MapImage } from '../../src/ui/mapRender';
import { teleport, world, legacyLane } from './helpers';

type Box = { left: number; top: number; width: number; height: number };

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
  set value(v: string) {
    this.set.clear();
    for (const c of v.split(/\s+/)) if (c) this.set.add(c);
  }
}

const ctx2d: unknown = new Proxy({} as Record<string | symbol, unknown>, {
  get: (t, k) => (k in t ? t[k] : () => ({ addColorStop: () => undefined, width: 0 })),
  set: (t, k, v) => {
    t[k] = v;
    return true;
  },
});

class FakeStyle {
  readonly props = new Map<string, string>();
  setProperty(k: string, v: string): void {
    this.props.set(k, v);
  }
}

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  readonly style = new FakeStyle();
  width = 300;
  height = 150;
  offsetWidth = 0;
  /** The element's layout box; a function of the moment for boxes that depend on what the HUD shows. */
  box: Box | (() => Box) = { left: 0, top: 0, width: 0, height: 0 };
  private text = '';
  set className(v: string) {
    this.classList.value = v;
  }
  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
  }
  set innerHTML(v: string) {
    this.children = [];
    const stack: FakeElement[] = [this];
    for (const [, close, , attrs, selfClose] of v.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
      if (close) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const el = new FakeElement();
      for (const [, k, val] of attrs!.matchAll(/([\w-]+)="([^"]*)"/g)) {
        if (k === 'class') el.className = val!;
        else if (k!.startsWith('data-')) el.dataset[k!.slice(5)] = val!;
      }
      stack[stack.length - 1]!.appendChild(el);
      if (!selfClose) stack.push(el);
    }
  }
  appendChild(c: FakeElement): FakeElement {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(): FakeElement[] {
    return this.all().filter((e) => 'el' in e.dataset);
  }
  getContext(): unknown {
    return ctx2d;
  }
  getBoundingClientRect(): Box {
    return typeof this.box === 'function' ? this.box() : this.box;
  }
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new FakeElement() });
  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const quickSim = () => new Sim({ world: world(), ambient: false, police: false });

function makeHud() {
  const root = new FakeElement();
  const hud = new Hud(root as unknown as HTMLElement, new MapImage(world()));
  const internals = hud as unknown as {
    el: Record<string, FakeElement>;
    root: FakeElement;
    route: Array<{ x: number; z: number }>;
    routeShown: Array<{ x: number; z: number }>;
    showBig(m: { text: string; sub: string; style: string; duration: number }): void;
  };
  const el = internals.el;
  const run = (sim: Sim, seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) hud.update(1 / 60, sim, 0, false, null, 0);
  };
  /** The toast texts up, top to bottom. */
  const shown = () => [el.toast2!, el.toast1!, el.toast!].filter((e) => e.classList.contains('show')).map((e) => e.textContent);
  return { hud, el, internals, run, shown };
}

describe('toast stack', () => {
  it('keeps at most three toasts, the newest at the bottom, and a fourth pushes the oldest out', () => {
    const { hud, el, run, shown } = makeHud();
    const sim = quickSim();
    hud.bind(sim);
    hud.toast('Waypoint reached');
    expect(shown()).toEqual(['Waypoint reached']);
    // The newest is always the `.toast` slot (what the browser tests read).
    expect(el.toast!.textContent).toBe('Waypoint reached');
    run(sim, 0.2);
    hud.toast('Autosaved');
    hud.toast('Weather: rain');
    expect(shown()).toEqual(['Waypoint reached', 'Autosaved', 'Weather: rain']);
    hud.toast('Game saved');
    expect(shown()).toEqual(['Autosaved', 'Weather: rain', 'Game saved']);
    expect(el.toast!.textContent).toBe('Game saved');
    expect(el.toast!.classList.contains('enter')).toBe(true);
  });

  it('the same message again only stays up longer', () => {
    const { hud, run, shown } = makeHud();
    const sim = quickSim();
    hud.bind(sim);
    hud.toast('Autosaved');
    run(sim, 2);
    hud.toast('Autosaved');
    expect(shown()).toEqual(['Autosaved']);
    run(sim, 2);
    expect(shown()).toEqual(['Autosaved']);
    run(sim, 1);
    expect(shown()).toEqual([]);
  });

  it('each toast fades out after its time and the rest move up into its place', () => {
    const { hud, el, run, shown } = makeHud();
    const sim = quickSim();
    hud.bind(sim);
    hud.toast('First');
    run(sim, 1);
    hud.toast('Second');
    run(sim, 1);
    hud.toast('Third');
    expect(shown()).toEqual(['First', 'Second', 'Third']);
    // First's 2.5 s are up: it fades out in place...
    run(sim, 0.6);
    expect(shown()).toEqual(['First', 'Second', 'Third']);
    expect(el.toast2!.classList.contains('leaving')).toBe(true);
    expect(el.toast1!.classList.contains('leaving')).toBe(false);
    // ...then goes, and the others close up.
    run(sim, 0.25);
    expect(shown()).toEqual(['Second', 'Third']);
    expect(el.toast2!.classList.contains('show')).toBe(false);
    expect(el.toast1!.classList.contains('leaving')).toBe(false);
    run(sim, 1);
    expect(shown()).toEqual(['Third']);
    expect(el.toast!.textContent).toBe('Third');
    run(sim, 1);
    expect(shown()).toEqual([]);
  });

  it('never shows more than three, however fast they come', () => {
    const { hud, run, shown } = makeHud();
    const sim = quickSim();
    hud.bind(sim);
    for (let i = 0; i < 20; i++) {
      hud.toast(`Message ${i}`);
      run(sim, 0.1);
      expect(shown().length).toBeLessThanOrEqual(3);
    }
    expect(shown()).toEqual(['Message 17', 'Message 18', 'Message 19']);
  });

  it('a new game starts with no toasts', () => {
    const { hud, run, shown } = makeHud();
    const s1 = quickSim();
    hud.bind(s1);
    hud.toast('Game saved');
    hud.toast('Autosaved');
    run(s1, 0.3);
    hud.setVisible(false);
    const s2 = quickSim();
    hud.bind(s2);
    expect(shown()).toEqual([]);
    run(s2, 0.1);
    expect(shown()).toEqual([]);
  });

  it('stacks under the status cluster in the same column', () => {
    const { el } = makeHud();
    const column = el.column!;
    expect(column.classList.contains('hud-right')).toBe(true);
    expect(column.children[0]!.classList.contains('hud-tr')).toBe(true);
    const stack = column.children[1]!;
    expect(stack.classList.contains('toasts')).toBe(true);
    expect(stack.children).toEqual([el.toast2, el.toast1, el.toast]);
    // One element is the newest toast (`.toast`); the older ones are `.toast-prev`.
    expect(el.toast!.classList.contains('toast')).toBe(true);
    expect(el.toast1!.classList.contains('toast')).toBe(false);
    expect(el.toast2!.classList.contains('toast-prev')).toBe(true);
  });

  it('style.css lays the column out as one flex column with no absolute or anchor-placed toast', () => {
    const css = readFileSync(new URL('../../src/ui/style.css', import.meta.url), 'utf8');
    const rule = (sel: string) => {
      const m = css.match(new RegExp(`(^|\\n)${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`));
      return m?.[2] ?? '';
    };
    const column = rule('.hud-right');
    expect(column).toMatch(/position: absolute/);
    expect(column).toMatch(/display: flex/);
    expect(column).toMatch(/flex-direction: column/);
    // The cluster is a flow item of the column now, not placed on its own.
    expect(rule('.hud-tr')).not.toMatch(/position: absolute/);
    expect(css).not.toMatch(/status-cluster/);
    expect(rule('.toasts')).toMatch(/flex-direction: column/);
    const toast = css.match(/\n\.toast,\n\.toast-prev \{([^}]*)\}/)?.[1] ?? '';
    expect(toast).not.toBe('');
    expect(toast).not.toMatch(/position|top:|anchor/);
    expect(css).toMatch(/\.toast:not\(\.show\),\n\.toast-prev:not\(\.show\) \{\s*display: none;/);
  });

  it('in a short window drops the oldest toasts early rather than run into the vehicle panel', () => {
    const { hud, el, run, shown } = makeHud();
    const sim = quickSim();
    hud.bind(sim);
    // The column: the cluster 200 px tall, each toast 40 px more.
    el.column!.box = () => ({ left: 1064, top: 22, width: 190, height: 200 + 40 * shown().length });
    el.drive!.box = { left: 1040, top: 300, width: 220, height: 160 };
    el.drive!.classList.add('hidden');
    hud.toast('A');
    hud.toast('B');
    hud.toast('C');
    run(sim, 0.1);
    expect(shown()).toEqual(['A', 'B', 'C']);
    // The panel up (bound to the HUD, it would show in a car): only what fits above it stays.
    el.drive!.classList.remove('hidden');
    (hud as unknown as { fitToasts(): void }).fitToasts();
    expect(shown()).toEqual(['C']);
    expect(el.column!.getBoundingClientRect().top + el.column!.getBoundingClientRect().height).toBeLessThanOrEqual(300 - 8);
  });
});

describe('title card beside the column', () => {
  function setup(windowW: number, columnH: number) {
    const { hud, el, internals, run } = makeHud();
    const sim = quickSim();
    hud.bind(sim);
    internals.root.box = { left: 0, top: 0, width: windowW, height: 720 };
    el.column!.box = { left: windowW - 26 - 190, top: 22, width: 190, height: columnH };
    el.bigT!.box = { left: windowW / 2 - 200, top: 300, width: 400, height: 70 };
    internals.showBig({ text: 'TAXI DRIVER', sub: 'Pick up fares', style: 'info', duration: 3 });
    run(sim, 1 / 60);
    const props = el.big!.style.props;
    return { left: props.get('--title-left') ?? '0px', right: props.get('--title-clear') ?? '0px', run, sim, el, hud };
  }

  it('stays centred where the column ends above it', () => {
    expect(setup(1280, 200)).toMatchObject({ left: '0px', right: '0px' });
  });

  it('keeps centred but clear of a column reaching down beside it in a wide window', () => {
    // 1280 - 1064 + 8 = 224 px each side, leaving 832 px.
    expect(setup(1280, 320)).toMatchObject({ left: '224px', right: '224px' });
  });

  it('moves left of the column in a narrow window', () => {
    // 800 - 584 + 8 = 224 px on the right; 352 px is too narrow a centred band.
    expect(setup(800, 320)).toMatchObject({ left: '0px', right: '224px' });
  });

  it('a new game takes the padding off', () => {
    const { el, hud } = setup(1280, 320);
    hud.bind(quickSim());
    expect(el.big!.style.props.get('--title-clear')).toBe('0px');
    expect(el.big!.style.props.get('--title-left')).toBe('0px');
  });
});

describe('radar route', () => {
  const straight = Array.from({ length: 21 }, (_, i) => ({ x: i * 10, z: 0 }));

  it('trimRoute starts at the player and drops the points he has passed', () => {
    const r = trimRoute(straight, 35, 2);
    expect(r[0]).toEqual({ x: 35, z: 2 });
    expect(r[1]).toEqual({ x: 40, z: 0 });
    expect(r[r.length - 1]).toEqual({ x: 200, z: 0 });
    expect(r.length).toBe(18);
    // Before the start, or with too little route to trim, nothing is lost.
    expect(trimRoute(straight, -5, 0).slice(1)).toEqual(straight.slice(1));
    expect(trimRoute([{ x: 0, z: 0 }], 5, 5)).toEqual([{ x: 0, z: 0 }]);
  });

  it('trimRoute finds the player on a bend and does not jump to a later leg passing nearby', () => {
    // Out along x, back along z = 6: the return leg passes 6 m from the start.
    const hairpin = [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 50, z: 6 }, { x: 0, z: 6 }];
    expect(trimRoute(hairpin, 10, 1)[1]).toEqual({ x: 50, z: 0 });
    expect(trimRoute(hairpin, 10, 5)[1]).toEqual({ x: 0, z: 6 });
  });

  it('at 30 m/s the drawn line starts at the arrow, and the route is still planned about once a second', () => {
    const { hud, internals } = makeHud();
    const sim = quickSim();
    hud.bind(sim);
    const lane = legacyLane(sim, 40);
    teleport(sim, lane.sx, lane.sz);
    // A waypoint across town; he then drives the route as first planned, at 30 m/s.
    const b = sim.world.layout.bounds;
    const far = [
      { x: b.landMinX + 40, z: b.landMinZ + 40 },
      { x: b.landMinX + 40, z: b.landMaxZ - 40 },
      { x: b.beachStartX - 40, z: b.landMinZ + 40 },
      { x: b.beachStartX - 40, z: b.landMaxZ - 40 },
    ].reduce((a, c) => (Math.hypot(c.x - lane.sx, c.z - lane.sz) > Math.hypot(a.x - lane.sx, a.z - lane.sz) ? c : a));
    hud.waypoint = far;
    hud.update(1 / 60, sim, 0, false, null, 0);
    const path = internals.route.slice();
    expect(path.length).toBeGreaterThan(1);
    const along = (s: number) => {
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i]!;
        const c = path[i + 1]!;
        const l = Math.hypot(c.x - a.x, c.z - a.z);
        if (s <= l || i === path.length - 2) {
          const k = l > 0 ? Math.min(1, s / l) : 0;
          return { x: a.x + (c.x - a.x) * k, z: a.z + (c.z - a.z) * k };
        }
        s -= l;
      }
      return path[0]!;
    };
    const total = path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i]!.x, p.z - path[i]!.z), 0);
    const seconds = 3;
    expect(total).toBeGreaterThan(30 * seconds + 60);
    let plans = 0;
    let last = internals.route;
    let worstStart = 0;
    let worstUntrimmed = 0;
    for (let t = 1 / 60; t < seconds; t += 1 / 60) {
      const p0 = along(30 * t);
      teleport(sim, p0.x, p0.z);
      hud.update(1 / 60, sim, 0, false, null, t);
      if (internals.route !== last) {
        plans++;
        last = internals.route;
      }
      const p = sim.playerPos();
      const first = internals.routeShown[0]!;
      worstStart = Math.max(worstStart, Math.hypot(first.x - p.x, first.z - p.z));
      const raw = internals.route[0]!;
      worstUntrimmed = Math.max(worstUntrimmed, Math.hypot(raw.x - p.x, raw.z - p.z));
    }
    expect(worstStart).toBeLessThan(3);
    // Without the trim the line would start up to a second's drive behind him.
    expect(worstUntrimmed).toBeGreaterThan(20);
    expect(plans).toBeGreaterThanOrEqual(Math.floor(seconds) - 1);
    expect(plans).toBeLessThanOrEqual(Math.ceil(seconds) + 1);
  });
});
