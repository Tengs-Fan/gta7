// Menu screens (title, pause, map, stats, controls, settings, shop, credits)
// managed as a stack. Keyboard, gamepad and mouse can all drive them. Each screen lives in ./screens; this
// controller owns the stack, the input guard and the shared stick stepping.

import { KeyLabels, type UiActions } from '../input/input';
import { type InputDevice } from './glyphs';
import type { MapImage } from './mapRender';
import { showControls } from './screens/controls';
import { showMap } from './screens/map';
import { showPause } from './screens/pause';
import { showSettings } from './screens/settings';
import { showSlots, type SlotPickerMode } from './screens/slots';
import { showShop } from './screens/shop';
import { showStats } from './screens/stats';
import { showStreetRuns } from './screens/streetRuns';
import { showPlayers, showRaces } from './screens/mpRoom';
import { showCredits, showTitle } from './screens/title';
import { h, showConfirm, type MenuCtx, type MenuHost, type Screen } from './screens/shared';
import { screenOpener } from './screens/registry';
import './screens/exportBoard';
import './screens/customs';
import { showPhone, type PhoneHost } from './widgets/phone';

export { NEW_GAME_WARNING } from './screens/title';
export type { MenuHost, StreetRunMedalTimes } from './screens/shared';

type StickDir = 'up' | 'down' | 'left' | 'right';
/** The left stick steps a menu once pushed past STICK_PRESS along its main axis, and is let go below STICK_RELEASE... */
const STICK_PRESS = 0.5;
const STICK_RELEASE = 0.3;
/** ...and held, it steps again after STICK_REPEAT_DELAY seconds, then every STICK_REPEAT seconds. */
const STICK_REPEAT_DELAY = 0.4;
const STICK_REPEAT = 0.13;

/** How far the stick (x, y) leans the way of `dir`. */
function stickAlong(dir: StickDir, x: number, y: number): number {
  return dir === 'right' ? x : dir === 'left' ? -x : dir === 'down' ? y : -y;
}

export class Menus {
  readonly root: HTMLDivElement;
  private stack: Screen[] = [];
  /** Seconds since the top screen appeared; input is ignored briefly so the
   *  key that opened a screen (or exited pointer lock) cannot also close it. */
  private age = 0;
  /** The device of the last input (see input()): the map and shop name its buttons. */
  private device: InputDevice = 'kb';
  /**
   * The left stick's steps (see stickStep): the direction it holds, the time to its next step, and whether it has been
   * seen at rest since the top screen appeared (held from play or through the press that opened it, it does nothing).
   */
  private stick: { dir: StickDir | null; wait: number; armed: boolean } = { dir: null, wait: 0, armed: false };

  /** What the screens see of this controller. */
  private readonly ctx: MenuCtx;

  constructor(parent: HTMLElement, private readonly host: MenuHost, private readonly map: MapImage, private readonly keys = new KeyLabels()) {
    this.root = h('div');
    parent.appendChild(this.root);
    const menus = this;
    this.ctx = {
      host: this.host,
      map: this.map,
      keys: this.keys,
      get device() {
        return menus.device;
      },
      push: (s) => menus.push(s),
      pop: () => menus.pop(),
      closeAll: () => menus.closeAll(),
    };
  }

  get open(): boolean {
    return this.stack.length > 0;
  }

  get top(): Screen | null {
    return this.stack[this.stack.length - 1] ?? null;
  }

  private push(s: Screen): void {
    const prev = this.top;
    if (prev) prev.el.classList.add('hidden');
    this.stack.push(s);
    this.root.appendChild(s.el);
    this.age = 0;
    this.stick = { dir: null, wait: 0, armed: false };
  }

  pop(): void {
    const s = this.stack.pop();
    if (!s) return;
    s.close?.();
    s.el.remove();
    this.top?.el.classList.remove('hidden');
    this.top?.refresh?.();
    this.age = 0;
    this.stick = { dir: null, wait: 0, armed: false };
  }

  closeAll(): void {
    while (this.stack.length) this.pop();
  }

  /** One frame of input for the top screen; `device` is the one that produced the last input (keyboard and mouse, or a pad). */
  input(ui: UiActions, dt: number, device?: InputDevice): void {
    if (device) this.device = device;
    const s = this.top;
    if (!s) return;
    this.age += dt;
    s.tick?.(dt, ui);
    const step = this.stickStep(ui, dt, s);
    if (this.age < 0.25) return;
    s.input(step ? { ...ui, [step]: true } : ui, dt);
  }

  /**
   * This frame's step of the left stick through screen `s`, as a D-pad press: once it is pushed past STICK_PRESS along
   * its main axis (one axis only: a slant does not both pick a settings row and change it), then again while it is held
   * (STICK_REPEAT_*), until it is let go below STICK_RELEASE. None until it has been seen at rest since the screen
   * appeared (see stick), during the screen's input guard, or on the map, which it pans.
   */
  private stickStep(ui: UiActions, dt: number, s: Screen): StickDir | null {
    const st = this.stick;
    // A broken pad axis (NaN) reads as at rest: it must neither step nor hold a step.
    const x = Number.isFinite(ui.stickX) ? ui.stickX! : 0;
    const y = Number.isFinite(ui.stickY) ? ui.stickY! : 0;
    if (st.dir !== null && stickAlong(st.dir, x, y) < STICK_RELEASE) st.dir = null;
    if (Math.max(Math.abs(x), Math.abs(y)) < STICK_RELEASE) st.armed = true;
    if (!st.armed || s.pans || this.age < 0.25) return null;
    if (st.dir === null) {
      const dir: StickDir = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up';
      if (stickAlong(dir, x, y) <= STICK_PRESS) return null;
      st.dir = dir;
      st.wait = STICK_REPEAT_DELAY;
      return dir;
    }
    st.wait -= dt;
    if (st.wait > 0) return null;
    st.wait = Math.max(st.wait + STICK_REPEAT, 0);
    return st.dir;
  }

  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------

  /** Title menu; `notice` is an optional one-line message under the buttons. */
  showTitle(notice?: string): void {
    showTitle(this.ctx, notice);
  }

  /** A real course selection, including the player's saved bests, before entering a car. */
  showStreetRuns(): void {
    showStreetRuns(this.ctx);
  }

  showPause(): void {
    showPause(this.ctx);
  }

  /**
   * A yes / no question over the current screen. Every one guards something that cannot be undone, so it
   * opens on NO: a second press of the key that asked it (or menu mashing) never accepts it.
   */
  confirm(text: string, yes: () => void): void {
    showConfirm(this.ctx, text, yes);
  }

  showControls(): void {
    showControls(this.ctx);
  }

  showCredits(): void {
    showCredits(this.ctx);
  }

  showStats(): void {
    showStats(this.ctx);
  }

  /** The save slot picker (CONTINUE, the safehouse, SETTINGS' DELETE SAVE); `onClose` runs when it closes. */
  showSlots(mode: SlotPickerMode, onClose?: () => void): void {
    showSlots(this.ctx, mode, onClose);
  }

  showSettings(): void {
    showSettings(this.ctx);
  }

  showShop(onClose: () => void): void {
    showShop(this.ctx, onClose);
  }

  /** A screen registered by name (screens/registry.ts); false if there is none or it has nothing to show. */
  showScreen(name: string, onClose: () => void): boolean {
    return screenOpener(name)?.(this.ctx, onClose) ?? false;
  }

  /** Full-screen map; `onClose` runs when it closes (opened from gameplay: resume the game). */
  showMap(onClose?: () => void): void {
    showMap(this.ctx, onClose);
  }

  /** Multiplayer: the room's players; `onClose` runs when it closes (back to play). False in single player. */
  showPlayers(onClose?: () => void): boolean {
    return showPlayers(this.ctx, onClose);
  }

  /** Multiplayer: the head-to-head Street Runs. False in single player. */
  showRaces(onClose?: () => void): boolean {
    return showRaces(this.ctx, onClose);
  }

  /** The phone; `onClose` runs when it closes (resume the game). */
  showPhone(host: PhoneHost, onClose?: () => void): void {
    showPhone(this.ctx, host, onClose);
  }
}
