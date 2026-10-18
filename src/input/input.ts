// Keyboard, mouse (pointer lock) and gamepad input mapped to game actions.

import { neutralInput, type PlayerInput } from '../sim/input';
import { cheatPrefixLength, completedCheat, type TypedCheat } from './cheats';

export interface UiActions {
  pause: boolean;
  map: boolean;
  camera: boolean;
  radioNext: boolean;
  radioPrev: boolean;
  confirm: boolean;
  back: boolean;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export interface FrameInput {
  player: PlayerInput;
  lookX: number;
  lookY: number;
  ui: UiActions;
  /** Last device that produced input ('kb' or 'pad'), for HUD hints. */
  device: 'kb' | 'pad';
}

const PREVENT = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1']);
const DEADZONE = 0.18;
/** Right-stick turn rate in look units per second (the old per-frame 14 / 10 at 60 fps). */
const STICK_LOOK_X = 14 * 60;
const STICK_LOOK_Y = 10 * 60;
/** RT counts as pulled above PRESS and as released below RELEASE (hysteresis against jitter). */
const TRIGGER_PRESS = 0.4;
const TRIGGER_RELEASE = 0.3;
/**
 * A wheel pause longer than this (ms) starts a new gesture; within one, every WHEEL_STEP px is another step.
 * Touchpad and smooth-scroll streams send an event every frame (~16 ms), while separate wheel notches,
 * even macOS's 4 px ones, come further apart unless spun faster than about 15 per second.
 * Weapon switching and the map's zoom both step this way.
 */
export const WHEEL_GESTURE_GAP = 60;
export const WHEEL_STEP = 100;
/** Every physical key that poll() reads by code. */
const BOUND_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space',
  'KeyF', 'Enter', 'KeyE', 'KeyH', 'KeyR', 'KeyQ', 'KeyT', 'KeyP', 'KeyM', 'KeyV', 'Escape', 'Backspace',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
]);
const LETTER_SHORTCUTS = new Set(['e', 'f', 'h', 'm', 'p', 'q', 'r', 't', 'v']);
/** A letter typed longer ago than this (ms) before the next one no longer counts towards a cheat code. */
const CHEAT_GAP_MS = 1500;
/** From this many letters into a cheat code, the keys typing it do nothing else (see Input.typeLetter). */
const CHEAT_SWALLOW_AT = 3;
/**
 * How long (ms) an F press that would get the player out for good waits for the I of FIXMYRIDE (see Input.exitAtStake):
 * as long as the code itself allows between two letters, so that whatever pace it is typed at its F never acts.
 */
const EXIT_HOLD_MS = CHEAT_GAP_MS;
/** Mouse moves are dropped this long (ms) after pointer lock is gained: the first one jumps by the cursor's offset. */
const LOCK_SETTLE_MS = 100;
/**
 * A frame at 60 fps (ms). Browsers send one mousemove per frame with the frame's motion summed, so a move
 * after a long frame (30 fps, a hitch) carries that much more: the jump limit grows with the time since the
 * last poll, up to MOVE_FRAMES_MAX frames.
 */
const FRAME_MS = 1000 / 60;
const MOVE_FRAMES_MAX = 6;
/** A move within this long (ms) of the one before it can continue its motion (see the mousemove handler). */
const MOVE_RUN_MS = 150;
/** Keys that ask for the map or the pause menu, and keys that get in or out of a vehicle. */
const SCREEN_KEYS = new Set(['KeyM', 'KeyP', 'Escape']);
const EXIT_KEYS = new Set(['KeyF', 'Enter']);
/** KeyboardEvent.key of the modifier keys: pressed between the letters of a code typed in capitals, they type nothing. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'Symbol', 'SymbolLock', 'NumLock', 'ScrollLock', 'OS']);

/**
 * Whether pointer lock must be refused: under browser automation (navigator.webdriver) headless Chromium
 * that grants it can stop delivering frames and grow its memory without bound. `lock=1` in the URL asks
 * for it anyway. Unit tests (Node) stub a navigator without webdriver.
 */
function automationRefusesLock(): boolean {
  try {
    if (typeof navigator === 'undefined' || navigator.webdriver !== true) return false;
    return new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('lock') !== '1';
  } catch {
    return false;
  }
}

/**
 * Whether the mouse move (x, y) carries at least a quarter of move `m` along m's line: two moves of one
 * turn (a hand speeds up and slows down over a few frames, it never starts or stops dead).
 */
function sameTurn(m: { x: number; y: number }, x: number, y: number): boolean {
  return m.x * x + m.y * y >= 0.25 * (m.x * m.x + m.y * m.y);
}

function dz(v: number): number {
  if (Math.abs(v) < DEADZONE) return 0;
  return Math.sign(v) * ((Math.abs(v) - DEADZONE) / (1 - DEADZONE));
}

/** A fresh key press: its number (see Input.presses), the codes it holds down (its own and a letter alias) and the one it acts as. */
interface KeyPress {
  press: number;
  codes: string[];
  action: string;
}

/**
 * Bindings use KeyboardEvent.code (US-QWERTY positions), which is right for WASD but puts
 * e.g. Map on AZERTY's ',' key. A key with no binding of its own therefore also acts as the
 * letter shortcut printed on it. Bound keys never alias, so one key can't fire two actions
 * (AZERTY's 'q' stays strafe-left, Dvorak's 'p' on KeyR stays reload).
 */
function letterAlias(ev: KeyboardEvent): string | null {
  if (BOUND_CODES.has(ev.code) || typeof ev.key !== 'string') return null;
  const k = ev.key.toLowerCase();
  return LETTER_SHORTCUTS.has(k) ? `Key${k.toUpperCase()}` : null;
}

/** A character worth printing as a key label. Keyboards for other scripts also carry the Latin letters. */
const LABEL_CHAR = /^(?!\s)[\p{Script=Latin}\p{Script=Common}]$/u;

type LayoutNavigator = { keyboard?: { getLayoutMap?(): Promise<Iterable<[string, string]>> } };

/**
 * On-screen names for the bound keys. Bindings are positional (KeyboardEvent.code, named after
 * US QWERTY), so on AZERTY the player moves with the keys printed Z Q S D. The layout comes from
 * the Keyboard API where the browser has it (Chromium), else is learned from key presses; keys
 * not seen yet keep their QWERTY names.
 */
export class KeyLabels {
  /** What each physical key types on this layout (lower case). */
  private readonly typed = new Map<string, string>();

  /** Reads the whole layout from navigator.keyboard.getLayoutMap(), where there is one. */
  async load(): Promise<void> {
    try {
      const map = await (navigator as unknown as LayoutNavigator).keyboard?.getLayoutMap?.();
      if (!map) return;
      this.typed.clear();
      for (const [code, key] of map) this.set(code, key);
    } catch {
      // Refused (e.g. in a cross-origin frame): keep learning from key presses.
    }
  }

  /** Learns what a key types from its keydown (with a modifier held it types something else). */
  learn(ev: KeyboardEvent): void {
    if (ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey || ev.getModifierState?.('AltGraph')) return;
    this.set(ev.code, ev.key);
  }

  private set(code: string, key: string): void {
    if (typeof code !== 'string' || !code || typeof key !== 'string' || !LABEL_CHAR.test(key)) return;
    const k = key.toLowerCase();
    for (const [c, v] of this.typed) if (v === k && c !== code) this.typed.delete(c);
    this.typed.set(code, k);
  }

  /** The key that types `ch`, if known. */
  private codeTyping(ch: string): string | undefined {
    for (const [c, v] of this.typed) if (v === ch) return c;
    return undefined;
  }

  /** The printed name of the key bound to a Key* or Digit* code. */
  label(code: string): string {
    const m = /^(Key|Digit)([A-Z0-9])$/.exec(code);
    if (!m) return code;
    const q = m[2]!.toLowerCase();
    // The number row carries its digits on every layout (AZERTY types & é " ' ( - there unshifted).
    if (m[1] === 'Digit') return q;
    const printed = this.codeTyping(q);
    // A letter shortcut also answers to the key printed with its letter if that key is free (see letterAlias).
    if (printed !== undefined && LETTER_SHORTCUTS.has(q) && !BOUND_CODES.has(printed)) return q.toUpperCase();
    // Not seen yet while its QWERTY letter sits on another key: such layouts swap the pair (AZERTY's A / Q, Z / W).
    const own = this.typed.get(code) ?? (printed?.startsWith('Key') ? printed.slice(3).toLowerCase() : q);
    return own.toUpperCase();
  }
}

export class Input {
  private readonly held = new Set<string>();
  /** The codes pressed since the last frame, built by poll() from `fresh`. */
  private readonly down = new Set<string>();
  /**
   * Key presses since the last frame, in order. Kept as presses until poll() so that a cheat code completed before the
   * frame can take its own letters back (see typeLetter).
   */
  private fresh: KeyPress[] = [];
  private mouseHeld = 0;
  private mouseDown = 0;
  private lookX = 0;
  private lookY = 0;
  /** Queued weapon steps from the wheel (+ next, - previous), at most one used per frame. */
  private wheelSteps = 0;
  private wheelAcc = 0;
  private wheelT = -Infinity;
  /** Letter alias added for a held physical key (see letterAlias), released with it. */
  private readonly aliases = new Map<string, string>();
  private padPrev: boolean[] = [];
  /** navigator.getGamepads() threw (the page's permissions policy leaves out 'gamepad'): no pads for the rest of the session. */
  private padsBlocked = false;
  private rtDown = false;
  private device: 'kb' | 'pad' = 'kb';
  private lockRequestT = -Infinity;
  /** A pointer-lock request made by a capture click has not been answered yet. */
  private captureRequested = false;
  /** Pointer lock was refused for a capture click (sandboxed frame, no API): clicks shoot unlocked. */
  private lockUnavailable = false;
  /** Read once: pointer lock is refused under automation (see automationRefusesLock). */
  private readonly noLock = automationRefusesLock();
  /** Mouse moves are dropped until this time (performance.now() ms), just after pointer lock is gained. */
  private ignoreMoveUntil = -Infinity;
  /** Pointer lock was gained and no mouse move has come since: the next one carries the jump, whenever it comes. */
  private lockJump = false;
  /** The last mouse move (performance.now() ms and movement), and when poll() last ran. */
  private lastMove = { t: -Infinity, x: 0, y: 0 };
  private pollT = -Infinity;
  /** A move too big for one frame that the next move has to confirm as part of a turn (see the mousemove handler). */
  private heldMove: { t: number; x: number; y: number } | null = null;
  /** E skipped a line of dialogue in a vehicle: it does not honk until released. */
  private eSkipped = false;
  /** Key presses so far (auto-repeats aside), numbering each one. */
  private presses = 0;
  /** The press that asked for the map or the pause menu since the last frame, or -1. */
  private screenPress = -1;
  /** The latest press that asked to get in or out of a vehicle, or -1. */
  private exitPress = -1;
  /** Last typed letters for cheat codes (upper case), and when the newest was typed (performance.now() ms). */
  typed = '';
  private typedAt = -Infinity;
  /** One flag per letter of `typed`: '1' where it was typed with a key that has no binding. */
  private typedFree = '';
  /** The press that typed each letter of `typed`. */
  private typedPresses: number[] = [];
  /** The presses that typed the letters of the cheat code being typed (or just completed), oldest first. */
  private codePresses: number[] = [];
  /** Cheat codes typed and not taken yet. */
  private readonly cheats: TypedCheat[] = [];
  /** Keys swallowed for typing a cheat code, until released. */
  private readonly swallowed = new Set<string>();
  /**
   * An F press held back while exitAtStake, and when (performance.now() ms): F is also the first letter of FIXMYRIDE.
   * The next key settles it: an I typing on is the code, and the F does nothing; anything else lets it act (a second F
   * at once, and that one asks for nothing more). So do EXIT_HOLD_MS going by, the window losing focus, and the exit no
   * longer being at stake (the car caught fire, the job ended); once the player is out anyway it is dropped.
   */
  private heldExit: { key: KeyPress; t: number } | null = null;
  /** The physical key (KeyboardEvent.code) that typed each letter of `typed`. */
  private typedKeys: string[] = [];
  inVehicle = false;
  /**
   * Getting out of the vehicle now could not be undone (set by the game each frame): it would end a taxi or vigilante
   * job, or a bail could kill. FIXMYRIDE's F gets the player out, so an F press then waits for the next key (heldExit).
   */
  exitAtStake = false;
  /**
   * A menu, the map or the shop is open (set by the game each frame). There A and D change settings and M and P close
   * screens, so a cheat code's keys do nothing from its third letter on, even keys of play, and from its second once an
   * unbound letter came (in play, only from the third, once an unbound letter came).
   */
  menuOpen = false;
  /**
   * A line of dialogue can be skipped (set by the game each frame, see MissionSystem.lineSkippable). In a
   * vehicle, where E is the horn, a fresh E press then skips the line instead of honking.
   */
  skipLine = false;
  enabled = true;
  /** Whether gameplay wants the mouse captured right now (set by the game). */
  wantsPointerLock: () => boolean = () => false;
  /**
   * Whether the mouse's back and forward buttons must not leave the page (set by the game): a game is on, even
   * under a menu, where the pointer is free and the browser would navigate.
   */
  guardNavigation: () => boolean = () => false;
  /** Names of the keys on the player's keyboard layout, for prompts and menus. */
  readonly labels = new KeyLabels();
  private readonly listeners: Array<[EventTarget, string, EventListener]> = [];

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(): void {
    const on = (t: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn, opts);
      this.listeners.push([t, type, fn]);
    };
    void this.labels.load();
    on(window, 'keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (PREVENT.has(ev.code)) ev.preventDefault();
      this.labels.learn(ev);
      this.device = 'kb';
      const alias = letterAlias(ev);
      const press = ev.repeat ? -1 : ++this.presses;
      // A key typing a cheat code does nothing else, also while it auto-repeats, until it is released.
      const typing = ev.repeat ? this.swallowed.has(ev.code) : this.typeLetter(ev.key, BOUND_CODES.has(ev.code) || alias !== null, press, ev.code);
      // A modifier (Shift for a capital I) says nothing about whether a held F starts FIXMYRIDE.
      const released = !ev.repeat && !MODIFIER_KEYS.has(ev.key) && this.settleHeldExit();
      if (typing) {
        this.swallowed.add(ev.code);
        return;
      }
      this.swallowed.delete(ev.code);
      const codes = alias ? [ev.code, alias] : [ev.code];
      if (alias) this.aliases.set(ev.code, alias);
      for (const code of codes) this.held.add(code);
      if (ev.repeat) return;
      const key: KeyPress = { press, codes, action: alias ?? ev.code };
      // A second F while one was held back: that one gets out now, and this one is the same request.
      if (released && key.action === 'KeyF') return;
      if (key.action === 'KeyF' && this.inVehicle && this.exitAtStake && !this.menuOpen) this.heldExit = { key, t: performance.now() };
      else this.fresh.push(key);
    });
    on(window, 'keyup', (e) => {
      const code = (e as KeyboardEvent).code;
      this.swallowed.delete(code);
      this.held.delete(code);
      const alias = this.aliases.get(code);
      if (alias) {
        this.held.delete(alias);
        this.aliases.delete(code);
      }
    });
    on(window, 'blur', () => {
      // No letter of FIXMYRIDE can follow a held F now: it acts, as it would have at once without the hold.
      this.releaseHeldExit();
      this.held.clear();
      this.aliases.clear();
      this.swallowed.clear();
      this.mouseHeld = 0;
      this.wheelSteps = 0;
      this.wheelAcc = 0;
    });
    on(this.canvas, 'mousedown', (e) => {
      const ev = e as MouseEvent;
      this.device = 'kb';
      if (this.wantsPointerLock() && !this.pointerLocked) {
        const asked = this.requestPointerLock();
        // The click that captures the mouse is not also a trigger pull. Where pointer lock is
        // refused, clicks still have to shoot.
        if (!this.lockUnavailable) {
          if (asked) this.captureRequested = true;
          return;
        }
      }
      this.mouseHeld |= 1 << ev.button;
      this.mouseDown |= 1 << ev.button;
    });
    on(document, 'pointerlockchange', () => {
      this.lockRequestT = -Infinity;
      this.captureRequested = false;
      if (this.pointerLocked) {
        this.lockUnavailable = false;
        this.ignoreMoveUntil = performance.now() + LOCK_SETTLE_MS;
        this.lockJump = true;
      }
    });
    on(document, 'pointerlockerror', () => this.lockRefused());
    // The mouse's back and forward buttons go back and forth in the history unless their release (Chrome) or
    // press is cancelled. With the pointer locked they never do, but menus, the map and the shop free it.
    const keepPage = (e: Event) => {
      const b = (e as MouseEvent).button;
      if ((b === 3 || b === 4) && this.guardNavigation()) e.preventDefault();
    };
    on(window, 'mousedown', keepPage);
    on(window, 'mouseup', (e) => {
      keepPage(e);
      this.mouseHeld &= ~(1 << (e as MouseEvent).button);
    });
    on(window, 'mousemove', (e) => {
      const ev = e as MouseEvent;
      if (document.pointerLockElement !== this.canvas) return;
      const mx = ev.movementX;
      const my = ev.movementY;
      if (!Number.isFinite(mx) || !Number.isFinite(my)) return;
      const now = performance.now();
      // Gaining the lock (closing the map, resuming) delivers a move by the cursor's offset from where it was
      // locked, which would swing the camera round: drop the first move after it, whenever it comes, and any
      // that come while the lock settles.
      if (this.lockJump || now < this.ignoreMoveUntil) {
        this.lockJump = false;
        this.lastMove = { t: -Infinity, x: 0, y: 0 };
        this.heldMove = null;
        return;
      }
      // Any other jump (a glitch) is a single move of more than a third of the window per frame's worth of
      // motion that does not belong to a turn. A real turn that fast builds up over the moves before it in the
      // same direction (the one before carries at least a quarter of it along its line), or, started all at
      // once, goes on in the moves after it: such a move is held back for the next one to confirm it.
      const held = this.heldMove;
      this.heldMove = null;
      if (held && now - held.t <= MOVE_RUN_MS && sameTurn(held, mx, my)) {
        this.lookX += held.x;
        this.lookY += held.y;
      }
      const w = window.innerWidth > 0 ? window.innerWidth : 1280;
      const h = window.innerHeight > 0 ? window.innerHeight : 720;
      const frames = Math.min(MOVE_FRAMES_MAX, Math.max(1, (now - this.pollT) / FRAME_MS));
      const big = Math.abs(mx) > (w / 3) * frames || Math.abs(my) > (h / 3) * frames;
      const prev = this.lastMove;
      const continues = now - prev.t <= MOVE_RUN_MS && sameTurn({ x: mx, y: my }, prev.x, prev.y);
      this.lastMove = { t: now, x: mx, y: my };
      if (big && !continues) {
        this.heldMove = { t: now, x: mx, y: my };
        return;
      }
      this.lookX += mx;
      this.lookY += my;
    });
    on(this.canvas, 'contextmenu', (e) => e.preventDefault());
    on(this.canvas, 'wheel', (e) => {
      e.preventDefault();
      this.wheelEvent(e as WheelEvent);
    }, { passive: false });
  }

  detach(): void {
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    this.listeners.length = 0;
  }

  /**
   * One weapon step per wheel gesture, plus one per WHEEL_STEP px of further travel within it.
   * A touchpad or smooth-scroll stream sends dozens of small events per swipe, which must not
   * cycle through every weapon; separate notches of any size still step once each.
   */
  private wheelEvent(ev: WheelEvent): void {
    const unit = ev.deltaMode === 1 ? 40 : ev.deltaMode === 2 ? 800 : 1;
    const dy = ev.deltaY * unit;
    // Ctrl+wheel is a touchpad pinch; mostly-horizontal swipes are not weapon changes.
    if (ev.ctrlKey || !Number.isFinite(dy) || dy === 0 || Math.abs(ev.deltaX * unit) > Math.abs(dy)) return;
    const dir = Math.sign(dy);
    const queue = () => {
      this.wheelSteps = Math.max(-6, Math.min(6, this.wheelSteps + dir));
    };
    if (ev.timeStamp - this.wheelT > WHEEL_GESTURE_GAP) {
      queue();
      this.wheelAcc = 0;
    } else {
      if (Math.sign(this.wheelAcc) === -dir) this.wheelAcc = 0;
      this.wheelAcc += dy;
      while (Math.abs(this.wheelAcc) >= WHEEL_STEP) {
        queue();
        this.wheelAcc -= dir * WHEEL_STEP;
      }
    }
    this.wheelT = ev.timeStamp;
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** Asks for pointer lock. Returns false when no request was made (locked, pending or unsupported). */
  requestPointerLock(): boolean {
    if (this.pointerLocked) return false;
    if (this.noLock) {
      // Under automation clicks shoot unlocked, as where the browser refuses the lock.
      this.lockUnavailable = true;
      return false;
    }
    // A second request while one is pending makes Chrome fire pointerlockchange before the
    // lock is granted, which the game would read as losing the lock.
    const now = performance.now();
    if (now - this.lockRequestT < 500) return false;
    this.lockRequestT = now;
    try {
      const r = this.canvas.requestPointerLock() as unknown;
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => this.lockRefused());
      return true;
    } catch {
      // Pointer lock unsupported (e.g. headless). Mouse look is then unavailable, keyboard still works.
      this.lockRequestT = -Infinity;
      this.lockUnavailable = true;
      return false;
    }
  }

  private lockRefused(): void {
    this.lockRequestT = -Infinity;
    // Only a refusal of a request made by a click (a user gesture) means the lock is unavailable.
    if (this.captureRequested) this.lockUnavailable = true;
    this.captureRequested = false;
  }

  exitPointerLock(): void {
    if (this.pointerLocked) document.exitPointerLock();
  }

  /** False once pointer lock turned out to be refused or missing (clicks then shoot without it). */
  get lockAvailable(): boolean {
    return !this.lockUnavailable;
  }

  private key(...codes: string[]): boolean {
    return codes.some((c) => this.held.has(c));
  }

  private pressed(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** Builds this frame's input (dt: frame time in seconds). Call once per frame, then endFrame(). */
  poll(dt: number): FrameInput {
    this.pollT = performance.now();
    // A held F: dropped once the player is out anyway; it acts now if no letter of FIXMYRIDE followed in time, or if
    // getting out is no longer for good (the car caught fire: 'Press F to get out!').
    if (this.heldExit && !this.inVehicle) this.heldExit = null;
    else if (this.heldExit && (!this.exitAtStake || this.pollT - this.heldExit.t > EXIT_HOLD_MS)) this.releaseHeldExit();
    this.down.clear();
    this.screenPress = -1;
    for (const k of this.fresh) {
      for (const c of k.codes) this.down.add(c);
      if (SCREEN_KEYS.has(k.action)) this.screenPress = k.press;
      if (EXIT_KEYS.has(k.action)) this.exitPress = k.press;
    }
    const p = neutralInput();
    const ui: UiActions = { pause: false, map: false, camera: false, radioNext: false, radioPrev: false, confirm: false, back: false, up: false, down: false, left: false, right: false };
    let lookX = this.lookX;
    let lookY = this.lookY;
    const wheel = Math.sign(this.wheelSteps);
    this.wheelSteps -= wheel;

    if (this.enabled) {
      const fwd = this.key('KeyW', 'ArrowUp') ? 1 : 0;
      const back = this.key('KeyS', 'ArrowDown') ? 1 : 0;
      const left = this.key('KeyA', 'ArrowLeft') ? 1 : 0;
      const right = this.key('KeyD', 'ArrowRight') ? 1 : 0;
      p.moveZ = fwd - back;
      p.moveX = right - left;
      p.throttle = fwd;
      p.brake = back;
      p.steer = right - left;
      p.steerDigital = left + right > 0;
      p.sprint = this.key('ShiftLeft', 'ShiftRight');
      p.jump = this.pressed('Space');
      p.handbrake = this.key('Space');
      p.fire = (this.mouseHeld & 1) !== 0;
      p.firePressed = (this.mouseDown & 1) !== 0;
      p.aim = (this.mouseHeld & 4) !== 0;
      p.enterExit = this.pressed('KeyF', 'Enter');
      // In a vehicle E is the horn, but a fresh press skips a line of dialogue that can be skipped, and then
      // honks only once let go and pressed again (H is the horn alone).
      const e = this.pressed('KeyE');
      // Each fresh press decides anew (it may have been let go and pressed again between two polls).
      if (e) this.eSkipped = this.inVehicle && this.skipLine;
      else if (!this.key('KeyE')) this.eSkipped = false;
      p.interact = e && (!this.inVehicle || this.eSkipped);
      const horn = this.eSkipped ? ['KeyH'] : ['KeyE', 'KeyH'];
      p.horn = this.inVehicle && this.key(...horn);
      p.hornPressed = this.inVehicle && this.pressed(...horn);
      p.reload = !this.inVehicle && this.pressed('KeyR');
      p.prevWeapon = this.pressed('KeyQ') || wheel < 0;
      p.nextWeapon = wheel > 0;
      p.job = this.pressed('KeyT');
      for (let i = 0; i < 6; i++) if (this.pressed(`Digit${i + 1}`)) p.selectSlot = i;
      ui.radioNext = this.inVehicle && this.pressed('KeyR');
      ui.radioPrev = this.inVehicle && this.pressed('KeyQ');
      if (this.inVehicle) p.prevWeapon = wheel < 0;
    }
    ui.pause = this.pressed('Escape', 'KeyP');
    ui.map = this.pressed('KeyM');
    ui.camera = this.pressed('KeyV');
    ui.confirm = this.pressed('Enter', 'Space');
    ui.back = this.pressed('Escape', 'Backspace');
    ui.up = this.pressed('ArrowUp', 'KeyW');
    ui.down = this.pressed('ArrowDown', 'KeyS');
    ui.left = this.pressed('ArrowLeft', 'KeyA');
    ui.right = this.pressed('ArrowRight', 'KeyD');

    // Gamepad (standard mapping).
    const pad = this.standardPad();
    if (pad) {
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      const bv = (i: number) => pad.buttons[i]?.value ?? 0;
      const was = (i: number) => !!this.padPrev[i];
      const tap = (i: number) => b(i) && !was(i);
      const lx = dz(pad.axes[0] ?? 0);
      const ly = dz(pad.axes[1] ?? 0);
      const rx = dz(pad.axes[2] ?? 0);
      const ry = dz(pad.axes[3] ?? 0);
      const any = lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0 || pad.buttons.some((x) => x.pressed);
      if (any) this.device = 'pad';
      // RT keeps its own threshold history: GamepadButton.pressed turns on far below the 0.4
      // pull, so it can't supply the press edge. Updated every poll, so a trigger still held
      // from a menu or from driving doesn't count as a fresh press.
      const rtWas = this.rtDown;
      this.rtDown = bv(7) > (rtWas ? TRIGGER_RELEASE : TRIGGER_PRESS);
      if (this.enabled && any) {
        if (lx !== 0 || ly !== 0) {
          p.moveX = lx;
          p.moveZ = -ly;
          p.steer = lx;
          p.steerDigital = false;
        }
        p.sprint = p.sprint || b(0);
        if (this.inVehicle) {
          p.throttle = Math.max(p.throttle, bv(7));
          p.brake = Math.max(p.brake, bv(6));
          p.handbrake = p.handbrake || b(5) || b(0);
          p.horn = p.horn || b(10);
          p.hornPressed = p.hornPressed || tap(10);
          p.fire = p.fire || b(2);
          p.firePressed = p.firePressed || tap(2);
          // D-pad up is interact on foot; in a vehicle it skips a line of dialogue (the horn is L3).
          if (this.skipLine) p.interact = p.interact || tap(12);
          ui.radioNext = ui.radioNext || tap(15);
          ui.radioPrev = ui.radioPrev || tap(14);
        } else {
          p.fire = p.fire || this.rtDown;
          p.firePressed = p.firePressed || (this.rtDown && !rtWas);
          p.aim = p.aim || bv(6) > 0.4;
          p.jump = p.jump || tap(2);
          p.reload = p.reload || tap(1);
          p.prevWeapon = p.prevWeapon || tap(4);
          p.nextWeapon = p.nextWeapon || tap(5);
          p.interact = p.interact || tap(12);
        }
        p.enterExit = p.enterExit || tap(3);
        p.job = p.job || tap(13);
        // The stick is a turn rate, unlike mouse deltas, so it scales with the frame time.
        lookX += rx * STICK_LOOK_X * dt;
        lookY += ry * STICK_LOOK_Y * dt;
      }
      ui.pause = ui.pause || tap(9);
      ui.map = ui.map || tap(8);
      ui.camera = ui.camera || tap(11);
      ui.confirm = ui.confirm || tap(0);
      ui.back = ui.back || tap(1);
      ui.up = ui.up || tap(12);
      ui.down = ui.down || tap(13);
      ui.left = ui.left || tap(14);
      ui.right = ui.right || tap(15);
      this.padPrev = pad.buttons.map((x) => x.pressed);
    } else this.rtDown = false;
    return { player: p, lookX, lookY, ui, device: this.device };
  }

  /**
   * The first connected pad with the standard mapping, or null. Where the page's permissions policy leaves out
   * 'gamepad' (a hardening header, a cross-origin frame without allow="gamepad") getGamepads() throws a
   * SecurityError: that means no pads, and keeps meaning it, as a document's policy cannot change.
   */
  standardPad(): Gamepad | null {
    if (this.padsBlocked || typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    try {
      return Array.from(navigator.getGamepads() ?? []).find((g) => g && g.connected && g.mapping === 'standard') ?? null;
    } catch {
      this.padsBlocked = true;
      return null;
    }
  }

  endFrame(): void {
    this.fresh = [];
    this.down.clear();
    this.screenPress = -1;
    this.mouseDown = 0;
    this.lookX = 0;
    this.lookY = 0;
  }

  /** The cheat codes typed since the last call, oldest first. */
  takeCheats(): TypedCheat[] {
    return this.cheats.splice(0);
  }

  /**
   * The key press (numbered as in TypedCheat.presses) behind this frame's map or pause request, or -1 (none, or
   * the gamepad): the game tells by it whether a cheat code's own letter opened a screen.
   */
  get screenKeyPress(): number {
    return this.screenPress;
  }

  /** The latest key press that asked to get in or out of a vehicle (numbered as in TypedCheat.presses), or -1. */
  get exitKeyPress(): number {
    return this.exitPress;
  }

  /** The F press held back for FIXMYRIDE acts after all: at the next frame. */
  private releaseHeldExit(): void {
    const h = this.heldExit;
    this.heldExit = null;
    if (h) this.fresh.push(h.key);
  }

  /**
   * A new key press settles a held F: typing on with the code (F I...), the F was its first letter and does nothing;
   * anything else lets it act. Returns true when it was let act.
   */
  private settleHeldExit(): boolean {
    const h = this.heldExit;
    if (!h) return false;
    if (this.codePresses.length >= 2 && this.codePresses.includes(h.key.press)) {
      this.heldExit = null;
      return false;
    }
    this.releaseHeldExit();
    return true;
  }

  /**
   * Adds a letter typed with physical key `code` to the cheat buffer (`bound`: that key has a binding) and
   * queues a completed code. Returns true when the key is typing a code and must do nothing else: the letter
   * that completes a code, and from the third letter of a code on, in play once the letters so far include one
   * typed with an unbound key. Play alone never types those, so play is never swallowed (S P A, back / pause /
   * left, also starts SPAWNSPORTS). In a menu the third letter on is swallowed in any case (SPAWNSPORTS's A
   * would change a setting), and the second once an unbound letter came (IMMORTAL's M would close the map),
   * while two keys of menu navigation (S then P) still both act.
   *
   * A code's first letters still act, once a frame has seen them, and Game undoes what they did. When the code
   * completes, its letters no frame has seen yet (keys sent faster than frames, as by a macro) are taken back
   * and never act, and its keys still held down do nothing more until released.
   */
  private typeLetter(key: unknown, bound: boolean, press: number, code: string): boolean {
    if (typeof key !== 'string' || key.length !== 1 || !/[a-z]/i.test(key)) return false;
    const now = performance.now();
    if (now - this.typedAt > CHEAT_GAP_MS) {
      this.typed = '';
      this.typedFree = '';
      this.typedPresses = [];
      this.typedKeys = [];
    }
    this.typedAt = now;
    this.typed = (this.typed + key.toUpperCase()).slice(-24);
    this.typedFree = (this.typedFree + (bound ? '0' : '1')).slice(-24);
    this.typedPresses = [...this.typedPresses, press].slice(-24);
    this.typedKeys = [...this.typedKeys, code].slice(-24);
    const n = cheatPrefixLength(this.typed);
    this.codePresses = n > 0 ? this.typedPresses.slice(-n) : [];
    const free = n > 0 && this.typedFree.slice(-n).includes('1');
    const swallow = this.menuOpen ? n >= (free ? 2 : CHEAT_SWALLOW_AT) : n >= CHEAT_SWALLOW_AT && free;
    const cheat = completedCheat(this.typed);
    if (!cheat) return swallow;
    const presses = this.typedPresses.slice(-cheat.length);
    this.cheats.push({ code: cheat, presses });
    this.codePresses = presses;
    this.fresh = this.fresh.filter((k) => !presses.includes(k.press));
    if (this.heldExit && presses.includes(this.heldExit.key.press)) this.heldExit = null;
    for (const k of this.typedKeys.slice(-cheat.length)) {
      if (k === code || !this.held.has(k)) continue;
      this.held.delete(k);
      const alias = this.aliases.get(k);
      if (alias) this.held.delete(alias);
      this.aliases.delete(k);
      this.swallowed.add(k);
    }
    this.typed = '';
    this.typedFree = '';
    this.typedPresses = [];
    this.typedKeys = [];
    return true;
  }
}
