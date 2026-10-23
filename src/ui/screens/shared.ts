// Pieces every menu screen uses: the stack-facing context a screen talks to, DOM helpers and the button list.

import type { KeyLabels, UiActions } from '../../input/input';
import type { QualityTier } from '../../render/quality';
import { playerOf, type PlayerView, type ViewState } from '../../sim/viewState';
import type { StreetRunCourse, StreetRunMedal } from '../../sim/streetRuns';
import type { RaceCommand, RaceView } from '../../net/lobby';
import type { Settings, SlotInfo } from '../../settings';
import type { InputDevice } from '../glyphs';
import { escapeHtml } from '../hud';
import type { MapImage } from '../mapRender';

/** A course's medal target times in seconds, as the sim judges them. */
export type StreetRunMedalTimes = Pick<StreetRunCourse, StreetRunMedal>;

export interface MenuHost {
  hasSave(): boolean;
  newGame(): void;
  /** Start the standalone driving challenge from the title screen. */
  startStreetRun?(id?: string): void;
  streetRunCourses?(): Array<{ id: string; title: string; description: string; best?: number; medals?: StreetRunMedalTimes; distance?: number; reward?: number }>;
  /** Loads a save: slot `slot`, or the current slot when absent. */
  continueGame(slot?: number): void;
  resume(): void;
  quitToTitle(): void;
  abandonMission(): void;
  /** Retry the retained failed attempt, including after the quick retry prompt expires. */
  retryMission?(): void;
  settings(): Settings;
  applySettings(s: Settings): void;
  deleteSave(): void;
  sim(): ViewState | null;
  /** Id of the player slot this screen belongs to (slot 0 when absent). */
  localPlayerId?(): number;
  setWaypoint(p: { x: number; z: number } | null): void;
  waypoint(): { x: number; z: number } | null;
  click(): void;
  /**
   * The tier 'auto' picked at boot, whether the renderer was created with MSAA (only a reload changes that), and
   * whether it can post-process at all (without half-float targets there is no FXAA; absent means it can).
   */
  quality?(): { auto: QualityTier; msaa: boolean; software?: boolean; post?: boolean };
  /** Hands the next key press (its code) to `cb` and nothing else, for a rebind; cancelCapture drops the wait. */
  captureKey?(cb: (code: string) => void): void;
  /** The save slots (see settings.ts); absent: a single save, as before slots. */
  slots?(): SlotInfo[];
  /** Saves the running game into slot `slot` (the safehouse's picker). */
  saveToSlot?(slot: number): void;
  deleteSlot?(slot: number): void;
  /** NEW GAME's question when some slot holds a save: where the new game will autosave. */
  newGameNote?(): string;
  cancelCapture?(): void;
  /** Joins a multiplayer room with the MULTIPLAYER screen's values; absent: no MULTIPLAYER entry on the title. */
  joinMultiplayer?(opts: MultiplayerFields): void;
  /** The MULTIPLAYER screen's values to start from (the last ones joined with, else the defaults). */
  multiplayerFields?(): MultiplayerFields;
  /** The room this game plays in (players, the head-to-head race); null in single player. */
  multiplayer?(): MultiplayerMenuHost | null;
}

export interface MultiplayerFields {
  name: string;
  server: string;
  room: string;
}

export interface MultiplayerPlayerRow {
  playerId: number;
  name: string;
  /** css colour of his name tag and blip. */
  color: string;
  you: boolean;
  watching: boolean;
  kills: number;
  deaths: number;
}

export interface MultiplayerMenuHost {
  roomId(): string;
  players(): MultiplayerPlayerRow[];
  race(): RaceView | null;
  /** Seconds left to join an open race (0 when none is open). */
  raceJoinLeft(): number;
  courses(): Array<{ id: string; name: string; description: string; distance: number }>;
  raceCommand(cmd: RaceCommand): void;
}

/** The player this menu belongs to, once a game is running. */
export function localPlayer(host: MenuHost): PlayerView | null {
  const sim = host.sim();
  return sim ? playerOf(sim, host.localPlayerId?.() ?? 0) : null;
}

export interface Screen {
  el: HTMLElement;
  /** Called every frame while on top, once the screen's input guard is over (dt: the frame time). */
  input(ui: UiActions, dt: number): void;
  /**
   * Called every frame while on top, also during the input guard (for animated screens like the map). `ui` is that
   * frame's input, to watch what is held, never to act on: during the guard it may be the key that opened the screen.
   */
  tick?(dt: number, ui: UiActions): void;
  /** Called when the screen is on top again after the one above it closed. */
  refresh?(): void;
  close?(): void;
  /** The screen pans with the left stick itself (the map): the stick makes it no up / down / left / right steps. */
  pans?: boolean;
}

/** What a screen needs of the Menus controller that owns the screen stack. */
export interface MenuCtx {
  readonly host: MenuHost;
  readonly map: MapImage;
  readonly keys: KeyLabels;
  /** The device of the last input: the map and shop name its buttons. */
  readonly device: InputDevice;
  push(s: Screen): void;
  pop(): void;
  closeAll(): void;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** A vertical list of buttons with keyboard / gamepad selection. */
export class ButtonList {
  readonly el = h('div', 'menu');
  private buttons: HTMLButtonElement[] = [];
  private sel = 0;

  /** `initial`: the item selected at first, or the first enabled one after it (else the first enabled one). */
  /** `detail`: an extra element inside the button (after the label); its text joins the accessible description. */
  constructor(items: Array<{ label: string; action: () => void; disabled?: boolean; id?: string; description?: string; detail?: HTMLElement }>, private readonly click: () => void, initial = 0) {
    for (const it of items) {
      const b = h('button');
      b.textContent = it.label;
      b.ariaLabel = it.label;
      b.disabled = !!it.disabled;
      if (it.id) b.dataset.id = it.id;
      if (it.description) b.dataset.description = it.description;
      if (it.detail) b.appendChild(it.detail);
      const spoken = [it.description, it.detail?.textContent].filter(Boolean).join('\n');
      if (spoken) b.ariaDescription = spoken;
      b.addEventListener('click', () => {
        if (b.disabled) return;
        this.click();
        it.action();
      });
      // The mouse picks what it really moves over: never a greyed-out item (which would swallow Enter),
      // and not one that a new screen puts under a resting cursor.
      b.addEventListener('mousemove', () => {
        const i = this.buttons.indexOf(b);
        if (!b.disabled && i !== this.sel) this.select(i);
      });
      // Tab focus and the game's arrow / stick selection should always name the same action.
      b.addEventListener('focus', () => this.select(this.buttons.indexOf(b)));
      this.el.appendChild(b);
      this.buttons.push(b);
    }
    const from = this.buttons.findIndex((b, i) => i >= initial && !b.disabled);
    this.sel = from >= 0 ? from : this.buttons.findIndex((b) => !b.disabled);
    this.select(this.sel);
  }

  private select(i: number): void {
    if (i < 0) return;
    this.sel = i;
    this.buttons.forEach((b, k) => b.classList.toggle('sel', k === i));
    this.buttons[i]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  move(d: number): void {
    const n = this.buttons.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.sel + d * k + n * 10) % n;
      if (!this.buttons[i]!.disabled) {
        this.select(i);
        return;
      }
    }
  }

  /** Enables or disables the button with this id, moving the selection off it if needed. */
  setDisabled(id: string, disabled: boolean): void {
    const b = this.buttons.find((x) => x.dataset.id === id);
    if (!b) return;
    b.disabled = disabled;
    if (this.buttons[this.sel]?.disabled) this.move(1);
  }

  input(ui: UiActions): void {
    if (ui.up) this.move(-1);
    if (ui.down) this.move(1);
    if (ui.confirm) this.buttons[this.sel]?.click();
  }
}

/**
 * A yes / no question over the current screen. Every one guards something that cannot be undone, so it
 * opens on NO: a second press of the key that asked it (or menu mashing) never accepts it.
 */
export function showConfirm(ctx: MenuCtx, text: string, yes: () => void): void {
  const el = h('div', 'screen dim');
  const panel = h('div', 'panel');
  panel.style.width = 'min(520px, 92vw)';
  panel.appendChild(h('p', '', escapeHtml(text)));
  const list = new ButtonList(
    [
      { label: 'YES', action: () => { ctx.pop(); yes(); }, id: 'yes' },
      { label: 'NO', action: () => ctx.pop(), id: 'no' },
    ],
    () => ctx.host.click(),
    1,
  );
  panel.appendChild(list.el);
  el.appendChild(panel);
  ctx.push({ el, input: (ui) => (ui.back ? ctx.pop() : list.input(ui)) });
}

/**
 * Keyboard and gamepad scrolling for a panel that can be taller than the window (CONTROLS, STATS, CREDITS):
 * up / down move it by half its height, and focus() lets Page Up / Down, Home and End scroll it natively.
 * A cue at its bottom edge shows while there is more below, which overlay scrollbars do not.
 */
export function scroller(panel: HTMLElement): { input(ui: UiActions): void; tick(): void; focus(): void } {
  panel.tabIndex = -1;
  const cue = h('div', 'scroll-cue hidden');
  panel.appendChild(cue);
  return {
    input: (ui) => {
      const d = (ui.down ? 1 : 0) - (ui.up ? 1 : 0);
      if (d !== 0) panel.scrollBy?.({ top: d * Math.max(80, panel.clientHeight * 0.5), behavior: 'smooth' });
    },
    tick: () => cue.classList.toggle('hidden', !(panel.scrollHeight - panel.clientHeight - panel.scrollTop > 2)),
    focus: () => panel.focus?.({ preventScroll: true }),
  };
}

/** Pushes a panel screen that BACK, back or confirm closes and up / down scroll (see scroller). */
export function pushScrolling(ctx: MenuCtx, el: HTMLElement, panel: HTMLElement): void {
  const row = h('div', 'row-end');
  const back = h('button', 'btn primary', 'BACK');
  back.addEventListener('click', () => ctx.pop());
  row.appendChild(back);
  panel.appendChild(row);
  const scroll = scroller(panel);
  el.appendChild(panel);
  ctx.push({ el, input: (ui) => (ui.back || ui.confirm ? ctx.pop() : scroll.input(ui)), tick: scroll.tick });
  scroll.focus();
}
