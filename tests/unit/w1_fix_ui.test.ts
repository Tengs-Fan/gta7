// Wave 1 scrutiny fixes for the UI track: the phone's texts reachable by keyboard and pad, newest first (W1-SCR-005);
// retained HUD key labels following a rebind (W1-SCR-006); a legacy save that cannot be migrated for want of space
// still loading (W1-SCR-007); a failed manual save not redirecting later autosaves (W1-SCR-008); and the sniper scope
// leaving the screen when a menu opens (W1-SCR-014). The browser pieces run on the fake DOM in fake_dom.ts.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../src/game';
import { DEFAULT_BINDINGS } from '../../src/input/bindings';
import { KeyLabels } from '../../src/input/input';
import { anySave, currentSlot, deleteSlot, loadGame, loadSlot, setCurrentSlot, slotInfos, slotKey, storeSlot } from '../../src/settings';
import { parseSave, Progress, serialize, type SaveData } from '../../src/sim/progress';
import { formatKeys } from '../../src/ui/glyphs';
import { Hud } from '../../src/ui/hud';
import { MapImage } from '../../src/ui/mapRender';
import { Menus, type MenuHost } from '../../src/ui/menus';
import type { PhoneEntry, PhoneHost } from '../../src/ui/widgets/phone';
import { FakeElement, installPage, QuotaStorage, ui } from './fake_dom';
import { makeSim, world } from './helpers';

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

const LEGACY = 'gta7.save.v1';
const fixtureText = readFileSync(new URL('./fixtures/legacy_v1.save.json', import.meta.url), 'utf8');

let storage: QuotaStorage;
beforeEach(() => {
  storage = installPage().storage;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function aSave(money: number): SaveData {
  const p = new Progress();
  p.markDone('wheels');
  p.money = money;
  return serialize(p, [{ id: 'pistol', ammo: 40 }], 20, 13.5, 2);
}

/** A Game on the fake DOM, driven through its real frame loop at 60 fps. */
function makeGame() {
  const uiRoot = new FakeElement('div');
  const game = new Game(new FakeElement('canvas') as unknown as HTMLCanvasElement, uiRoot as unknown as HTMLElement);
  const g = game as unknown as { running: boolean; last: number; frame: (now: number) => void; menuHost(): MenuHost; openMap(): void };
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
  const toast = () => uiRoot.all().find((e) => e.dataset.el === 'toast')!.textContent;
  const el = (name: string) => uiRoot.all().find((e) => e.dataset.el === name)!;
  return { game, uiRoot, frames, button, toast, el, host: () => g.menuHost(), openMap: () => g.openMap() };
}

// ---------------------------------------------------------------------------

describe('W1-SCR-005: the phone texts are reachable with the keyboard and pad, newest first', () => {
  function openTexts(n: number) {
    const sim = makeSim({ ambient: false });
    const texts: PhoneEntry[] = Array.from({ length: n }, (_, i) => ({ kind: 'earning', from: 'Bank', text: `Payment ${n - i}`, amount: n - i, day: 1, time: '12:00' }));
    const host: PhoneHost = { view: () => sim, me: () => sim.players[0]!, texts: () => texts, callContact: () => undefined, callCab: () => undefined, openMap: () => undefined, pause: () => undefined, click: vi.fn() };
    const menus = new Menus(new FakeElement('div') as unknown as HTMLElement, {} as MenuHost, new MapImage(world()));
    menus.showPhone(host);
    const top = () => menus.top!.el as unknown as FakeElement;
    const press = (over: Parameters<typeof ui>[0]) => menus.input(ui(over), 0.3, 'kb');
    const selected = () => top().all().filter((e) => e.classList.contains('sel'));
    // Down to Texts (after Lou, Dex and Azura Cab), and open it.
    for (let i = 0; i < 3; i++) press({ down: true });
    expect(selected()[0]!.textContent).toContain('Texts');
    press({ confirm: true });
    return { top, press, selected, host, texts };
  }

  it('opens on the newest text, in view, and up / down step through every one to the oldest and BACK', () => {
    const { press, selected, host } = openTexts(12);
    const clicks = (host.click as ReturnType<typeof vi.fn>).mock.calls.length;
    const sel = selected();
    expect(sel).toHaveLength(1);
    expect(sel[0]!.classList.contains('phone-text')).toBe(true);
    expect(sel[0]!.textContent).toContain('Payment 12');
    expect(sel[0]!.scrolledIntoView).toBeGreaterThan(0);
    const seen = [sel[0]!.textContent];
    for (let i = 0; i < 11; i++) {
      press({ down: true });
      const s = selected()[0]!;
      expect(s.scrolledIntoView).toBeGreaterThan(0);
      seen.push(s.textContent);
    }
    expect(seen.map((t) => /Payment (\d+)/.exec(t)![1])).toEqual(['12', '11', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1']);
    // Confirm on a text does nothing (no chime, still on TEXTS).
    press({ confirm: true });
    expect((host.click as ReturnType<typeof vi.fn>).mock.calls.length).toBe(clicks);
    press({ down: true });
    expect(selected()[0]!.textContent).toContain('Back');
    // Up from the newest wraps to BACK too.
    press({ down: true });
    expect(selected()[0]!.textContent).toContain('Payment 12');
    press({ up: true });
    expect(selected()[0]!.textContent).toContain('Back');
    press({ confirm: true });
    expect(selected()[0]!.textContent).toContain('Mama Lou');
  });

  it('with no texts, BACK is selected', () => {
    const { selected } = openTexts(0);
    expect(selected()[0]!.textContent).toContain('Back');
  });
});

// ---------------------------------------------------------------------------

describe('W1-SCR-006: help and big-message key labels follow a rebind', () => {
  it('a showing help line and a big message sub-line redraw with the new keys; reset puts them back', () => {
    const keys = new KeyLabels();
    const hud = new Hud(new FakeElement('div') as unknown as HTMLElement, new MapImage(world()), keys);
    const el = (hud as unknown as { el: Record<string, FakeElement> }).el;
    const sim = makeSim({ ambient: false });
    const frame = () => hud.update(1 / 60, sim, 0, false, null, 0);
    const help = 'Steal a ride with <kbd>F</kbd>.';
    const sub = 'Press E to retry';
    hud.help(help, 9);
    (hud as unknown as { showBig(m: { text: string; sub: string; style: string; duration: number }): void }).showBig({ text: 'MISSION FAILED', sub, style: 'failed', duration: 6 });
    frame();
    expect(el.help!.innerHTML).toBe(formatKeys(help, 'kb', { labels: keys }));
    expect(el.help!.innerHTML).toMatch(/>F</);
    expect(el.bigS!.innerHTML).toMatch(/>E</);
    keys.keymap.set({ ...DEFAULT_BINDINGS, enterExit: 'KeyG', interact: 'KeyK' });
    frame();
    console.log('help after rebind:', el.help!.innerHTML, '| big sub:', el.bigS!.innerHTML);
    expect(el.help!.innerHTML).toBe(formatKeys(help, 'kb', { labels: keys }));
    expect(el.help!.innerHTML).toMatch(/>G</);
    expect(el.help!.innerHTML).not.toMatch(/>F</);
    expect(el.bigS!.innerHTML).toMatch(/>K</);
    expect(el.bigS!.innerHTML).not.toMatch(/>E</);
    keys.keymap.set(DEFAULT_BINDINGS);
    frame();
    expect(el.help!.innerHTML).toMatch(/>F</);
    expect(el.bigS!.innerHTML).toMatch(/>E</);
  });

  it('in the game: pausing on the welcome line, moving enter / exit to G and resuming shows G', () => {
    const { game, frames, el, host } = makeGame();
    game.newGame({ intro: false });
    frames(2);
    expect(el('help').innerHTML).toMatch(/>F</);
    game.pause();
    frames(2);
    host().applySettings({ ...game.settings, bindings: { ...DEFAULT_BINDINGS, enterExit: 'KeyG' } });
    game.resume();
    frames(1);
    expect(el('help').classList.contains('show')).toBe(true);
    expect(el('help').innerHTML).toMatch(/>G</);
    expect(el('help').innerHTML).not.toMatch(/>F</);
  });
});

// ---------------------------------------------------------------------------

describe('W1-SCR-007: a legacy save that cannot be copied for want of room still loads', () => {
  it('shows as slot 1, keeps CONTINUE, loads, and moves once there is room, without a duplicate', () => {
    storage.setItem(LEGACY, fixtureText);
    storage.readOnly = true;
    const infos = slotInfos();
    console.log('quota-blocked migration: slots', infos.map((i) => i.state), 'anySave', anySave(), 'keys', storage.keys);
    expect(infos.map((i) => i.state)).toEqual(['ok', 'empty', 'empty']);
    expect(infos[0]!.data).toEqual(parseSave(JSON.parse(fixtureText)));
    expect(anySave()).toBe(true);
    expect(loadSlot(1)!.money).toBe(18450);
    setCurrentSlot(1);
    expect(loadGame()!.money).toBe(18450);
    expect(storage.getItem(LEGACY)).toBe(fixtureText);
    expect(storage.keys).toEqual([LEGACY]);
    // Room again: it moves into slot 1 byte for byte, once.
    storage.readOnly = false;
    expect(slotInfos().map((i) => i.state)).toEqual(['ok', 'empty', 'empty']);
    expect(storage.getItem(slotKey(1))).toBe(fixtureText);
    expect(storage.getItem(LEGACY)).toBeNull();
  });

  it('CONTINUE in the game loads it through the slot picker', () => {
    storage.setItem(LEGACY, fixtureText);
    storage.readOnly = true;
    const { game, button } = makeGame();
    expect(button('CONTINUE')!.disabled).toBe(false);
    button('CONTINUE')!.click();
    expect(button('SLOT 1')!.disabled).toBe(false);
    button('SLOT 1')!.click();
    expect(game.mode).toBe('game');
    expect(game.sim.progress.money).toBe(18450);
    expect(game.sim.progress.missionsDone).toEqual(expect.arrayContaining(['wheels', 'delivery', 'repo']));
  });

  it('a smaller save over the slot it shows in replaces it; it never reappears in another slot', () => {
    const small = aSave(77);
    // Room for the old save and a small one, not for a second copy of the old one.
    const room = LEGACY.length + fixtureText.length + slotKey(1).length + JSON.stringify(small).length + 'gta7.saves.v1{"last":1}'.length + 20;
    expect(room).toBeLessThan(LEGACY.length + 2 * fixtureText.length + slotKey(1).length);
    storage = installPage(new QuotaStorage(room)).storage;
    storage.setItem(LEGACY, fixtureText);
    expect(slotInfos().map((i) => i.state)).toEqual(['ok', 'empty', 'empty']);
    expect(storage.getItem(slotKey(1))).toBeNull();
    expect(storeSlot(1, small)).toBeNull();
    expect(storage.getItem(LEGACY)).toBeNull();
    expect(slotInfos().map((i) => i.state)).toEqual(['ok', 'empty', 'empty']);
    expect(loadSlot(1)!.money).toBe(77);
  });

  it('deleting the slot it shows in removes it; it does not move to another slot', () => {
    storage.setItem(LEGACY, fixtureText);
    storage.readOnly = true;
    expect(slotInfos()[0]!.state).toBe('ok');
    deleteSlot(1);
    storage.readOnly = false;
    expect(slotInfos().map((i) => i.state)).toEqual(['empty', 'empty', 'empty']);
    expect(storage.getItem(LEGACY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('W1-SCR-008: a failed safehouse save does not redirect later autosaves', () => {
  it('slot 2 fails for want of room: autosaves keep going to slot 1, the slot the game was loaded from', () => {
    const store = new QuotaStorage(60_000);
    storage = installPage(store).storage;
    expect(storeSlot(1, aSave(1111))).toBeNull();
    const { game, button, toast, frames } = makeGame();
    button('CONTINUE')!.click();
    button('SLOT 1')!.click();
    expect(game.mode).toBe('game');
    expect(currentSlot()).toBe(1);
    store.fill(15);
    game.sim.events.emit('saveRequested', { poi: 'safehouse' });
    button('SLOT 2')!.click();
    expect(toast()).toBe('Could not save: browser storage is full');
    expect(store.getItem(slotKey(2))).toBeNull();
    expect(currentSlot()).toBe(1);
    // Room again (another slot deleted, say): the next autosave writes slot 1, not slot 2.
    store.unfill();
    game.sim.progress.addMoney(7);
    game.sim.events.emit('saveRequested', { poi: 'auto' });
    frames(1);
    expect(toast()).toBe('Autosaved');
    expect(store.getItem(slotKey(2))).toBeNull();
    expect(loadSlot(1)!.money).toBe(game.sim.progress.money);
  });

  it('a successful save into slot 2 makes it the autosave slot', () => {
    expect(storeSlot(1, aSave(1111))).toBeNull();
    const { game, button, frames } = makeGame();
    button('CONTINUE')!.click();
    button('SLOT 1')!.click();
    game.sim.events.emit('saveRequested', { poi: 'safehouse' });
    button('SLOT 2')!.click();
    expect(currentSlot()).toBe(2);
    const slot1 = storage.getItem(slotKey(1));
    game.sim.progress.addMoney(9);
    game.sim.events.emit('saveRequested', { poi: 'auto' });
    frames(1);
    expect(loadSlot(2)!.money).toBe(game.sim.progress.money);
    expect(storage.getItem(slotKey(1))).toBe(slot1);
  });
});

// ---------------------------------------------------------------------------

describe('W1-SCR-014: the sniper scope leaves the screen when a menu opens over it', () => {
  function scopedGame() {
    const harness = makeGame();
    harness.game.newGame({ intro: false });
    harness.frames(2);
    const cam = harness.game.renderer.cameraCtl;
    // The mocked renderer never updates the camera: stand in for a frame looking through the scope.
    cam.scoped = true;
    harness.frames(1);
    expect(harness.game.scope.visible).toBe(true);
    expect(harness.game.scope.el.classList.contains('hidden')).toBe(false);
    return { ...harness, cam };
  }

  it('the pause menu: the mask goes at once and stays off on its frames; back in play it follows the aim again', () => {
    const { game, frames, cam } = scopedGame();
    game.pause();
    expect(game.scope.visible).toBe(false);
    frames(10);
    expect(game.menus.open).toBe(true);
    expect(game.scope.visible).toBe(false);
    expect(game.scope.el.classList.contains('hidden')).toBe(true);
    game.resume();
    frames(1);
    expect(game.scope.visible).toBe(true);
    cam.scoped = false;
    frames(1);
    expect(game.scope.visible).toBe(false);
  });

  it('the map and the phone too', () => {
    const { game, frames, openMap } = scopedGame();
    openMap();
    frames(5);
    expect(game.menus.open).toBe(true);
    expect(game.scope.visible).toBe(false);
    game.resume();
    frames(1);
    expect(game.scope.visible).toBe(true);
    // A menu frame alone (a screen opened some other way) clears it as well.
    game.menus.showPhone((game as unknown as { phoneHost(): PhoneHost }).phoneHost());
    frames(1);
    expect(game.scope.visible).toBe(false);
  });
});
