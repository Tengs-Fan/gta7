// Presentation code reads the game through ViewState and a local player id, and player-scoped events carry an
// optional playerId that single-player listeners treat as slot 0.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../src/game';
import type { SimEvents } from '../../src/sim/events';
import { Sim } from '../../src/sim/sim';
import { playerOf, type ViewState } from '../../src/sim/viewState';
import { Hud } from '../../src/ui/hud';
import { MapImage } from '../../src/ui/mapRender';
import { world } from './helpers';

// Game wires the renderer in; this Node suite has no GPU or canvas.
vi.mock('../../src/render/renderer', () => ({ GameRenderer: class {} }));

const ROOT = join(__dirname, '../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const PRESENTATION = [
  'src/render/renderer.ts',
  'src/render/camera.ts',
  'src/render/crowd.ts',
  'src/ui/hud.ts',
  'src/ui/hints.ts',
  'src/ui/mapRender.ts',
  'src/ui/menus.ts',
  'src/ui/screens/shared.ts',
  'src/ui/screens/title.ts',
  'src/ui/screens/pause.ts',
  'src/ui/screens/settings.ts',
  'src/ui/screens/shop.ts',
  'src/ui/screens/map.ts',
  'src/ui/screens/stats.ts',
  'src/ui/screens/streetRuns.ts',
  'src/ui/screens/controls.ts',
  'src/audio/audio.ts',
];

describe('ViewState', () => {
  it('the Sim satisfies it, and the local player is found by id', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    const view: ViewState = sim;
    expect(playerOf(view, 0).character).toBe(sim.player);
    const b = sim.addPlayer(sim.player.pos.x + 5, sim.player.pos.z);
    expect(playerOf(view, 1).character).toBe(b.character);
    expect(playerOf(view, 1).wanted).toBe(b.wanted);
    expect(playerOf(view, 7).character).toBe(sim.player);
  });

  it('no presentation file imports the Sim class or type', () => {
    for (const file of PRESENTATION) {
      const src = read(file);
      expect(src, file).not.toMatch(/from\s+'(\.\.\/)+sim\/sim'/);
    }
  });

  it('the types-only module holds no three.js or DOM reference', () => {
    const src = read('src/sim/viewState.ts').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/from\s+'three/);
    expect(src).not.toMatch(/\b(document|window|localStorage)\b/);
    expect(src).not.toMatch(/^import(?!\s+type)/m);
  });

  it('the renderer, camera, HUD, hints, audio and screens take the local player id', () => {
    for (const file of ['src/render/renderer.ts', 'src/ui/hud.ts', 'src/audio/audio.ts']) expect(read(file), file).toMatch(/localPlayerId/);
    expect(read('src/render/camera.ts')).toMatch(/localPlayerId = 0/);
    expect(read('src/ui/hints.ts')).toMatch(/localPlayerId = 0/);
    expect(read('src/ui/screens/shared.ts')).toMatch(/localPlayerId\?\(\)/);
    for (const file of PRESENTATION) expect(read(file), file).not.toMatch(/\bsim\.player\b/);
  });
});

describe('player-scoped events carry an optional playerId', () => {
  const SCOPED = [
    'money', 'wanted', 'dispatch', 'wasted', 'busted', 'respawn', 'message', 'subtitle', 'big', 'objective', 'stunt', 'shopOpen', 'saveRequested',
    'sprayed', 'fade', 'missionStarted', 'missionEnded', 'activityEnded', 'activityMilestone', 'streetRunCountdown', 'streetRunCheckpoint', 'streetRunFinished',
  ] as const;

  it('every one of them has playerId?: number in its payload type', () => {
    type Has<K extends keyof SimEvents> = SimEvents[K] extends { playerId?: number } ? true : never;
    const check: { [K in (typeof SCOPED)[number]]: Has<K> } = Object.fromEntries(SCOPED.map((k) => [k, true])) as never;
    expect(Object.keys(check).length).toBe(SCOPED.length);
    const src = read('src/sim/events.ts');
    for (const name of SCOPED) expect(src, name).toMatch(new RegExp(`^  ${name}: .*PlayerScoped`, 'm'));
  });

  it('slot 0’s events come without a playerId in a one-seat sim, and every slot of a two-seat sim carries its id', () => {
    const single = new Sim({ world: world(), ambient: false, police: false });
    const one: Array<[string, number | undefined]> = [];
    single.events.on('wanted', (e) => one.push(['wanted', e.playerId]));
    single.events.on('wasted', (e) => one.push(['wasted', e.playerId]));
    single.wanted.setLevel(2);
    single.playerDied();
    expect(one).toEqual([['wanted', undefined], ['wasted', undefined]]);

    const sim = new Sim({ world: world(), ambient: false, police: false });
    const b = sim.addPlayer(sim.player.pos.x + 5, sim.player.pos.z);
    const seen: Array<[string, number | undefined]> = [];
    sim.events.on('wanted', (e) => seen.push(['wanted', e.playerId]));
    sim.events.on('wasted', (e) => seen.push(['wasted', e.playerId]));
    sim.events.on('big', (e) => seen.push(['big', e.playerId]));
    sim.wanted.setLevel(2);
    sim.playerDied();
    b.wanted.setLevel(1);
    sim.playerDied(b);
    expect(seen).toEqual([['wanted', 0], ['wasted', 0], ['big', 0], ['wanted', 1], ['wasted', 1], ['big', 1]]);
  });
});

type FakeEl = {
  children: FakeEl[];
  classList: { add(...c: string[]): void; remove(...c: string[]): void; toggle(c: string, f?: boolean): boolean; contains(c: string): boolean; value: string };
  textContent: string;
};

describe('the HUD and the game treat an event without a playerId as slot 0', () => {
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
  class FakeElement {
    children: FakeElement[] = [];
    parent: FakeElement | null = null;
    readonly classList = new FakeClassList();
    readonly dataset: Record<string, string> = {};
    readonly style = { setProperty: () => undefined } as unknown as CSSStyleDeclaration;
    width = 300;
    height = 150;
    offsetWidth = 0;
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
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 };
    }
  }

  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => new FakeElement() });
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function rig(localPlayerId: number) {
    const hud = new Hud(new FakeElement() as unknown as HTMLElement, new MapImage(world()));
    const el = (hud as unknown as { el: Record<string, FakeEl> }).el;
    const sim = new Sim({ world: world(), ambient: false, police: false });
    sim.addPlayer(sim.player.pos.x + 5, sim.player.pos.z);
    hud.bind(sim, localPlayerId);
    const run = () => {
      for (let i = 0; i < 12; i++) hud.update(1 / 60, sim, 0, false, null, 0);
    };
    return { sim, el, run };
  }

  it('money: no playerId and playerId 0 move the delta display alike', () => {
    const shown = (payload: SimEvents['money']) => {
      const { sim, el, run } = rig(0);
      sim.events.emit('money', payload);
      run();
      return [el.delta!.classList.contains('show'), el.delta!.textContent];
    };
    expect(shown({ amount: 120 })).toEqual([true, '+$120']);
    expect(shown({ amount: 120, playerId: 0 })).toEqual([true, '+$120']);
  });

  it('big messages: no playerId and playerId 0 both show the card, another player’s does not', () => {
    const shown = (playerId: number | undefined, local = 0) => {
      const { sim, el, run } = rig(local);
      sim.events.emit('big', { text: 'MISSION PASSED', sub: '', style: 'passed', duration: 4, ...(playerId === undefined ? {} : { playerId }) });
      run();
      return el.big!.classList.contains('show');
    };
    expect(shown(undefined)).toBe(true);
    expect(shown(0)).toBe(true);
    expect(shown(1)).toBe(false);
    expect(shown(1, 1)).toBe(true);
    expect(shown(undefined, 1)).toBe(false);
  });

  it('the game saves on a saveRequested without a playerId or with playerId 0, not for another player', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    // The safehouse opens the save slot picker (wave 1: three slots), which saves once a slot is chosen.
    const save = vi.fn();
    const game = { save, openSavePicker: save, pendingAutosave: false };
    const bindSaves = (Game.prototype as unknown as { bindSaves(sim: Sim): Array<() => void> }).bindSaves;
    bindSaves.call(game, sim);
    sim.events.emit('saveRequested', { poi: 'safehouse' });
    sim.events.emit('saveRequested', { poi: 'safehouse', playerId: 0 });
    expect(save).toHaveBeenCalledTimes(2);
    sim.events.emit('saveRequested', { poi: 'safehouse', playerId: 1 });
    expect(save).toHaveBeenCalledTimes(2);
  });
});
