// Keyboard, mouse (pointer lock) and gamepad input mapped to game actions.

import { neutralInput, type PlayerInput } from '../sim/input';

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

function dz(v: number): number {
  if (Math.abs(v) < DEADZONE) return 0;
  return Math.sign(v) * ((Math.abs(v) - DEADZONE) / (1 - DEADZONE));
}

export class Input {
  private readonly held = new Set<string>();
  private readonly down = new Set<string>();
  private mouseHeld = 0;
  private mouseDown = 0;
  private lookX = 0;
  private lookY = 0;
  private wheel = 0;
  private padPrev: boolean[] = [];
  private device: 'kb' | 'pad' = 'kb';
  /** Last typed letters for cheat codes. */
  typed = '';
  inVehicle = false;
  enabled = true;
  private readonly listeners: Array<[EventTarget, string, EventListener]> = [];

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(): void {
    const on = (t: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn, opts);
      this.listeners.push([t, type, fn]);
    };
    on(window, 'keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (PREVENT.has(ev.code)) ev.preventDefault();
      if (!ev.repeat) this.down.add(ev.code);
      this.held.add(ev.code);
      this.device = 'kb';
      if (ev.key.length === 1 && /[a-z]/i.test(ev.key)) this.typed = (this.typed + ev.key.toUpperCase()).slice(-24);
    });
    on(window, 'keyup', (e) => this.held.delete((e as KeyboardEvent).code));
    on(window, 'blur', () => {
      this.held.clear();
      this.mouseHeld = 0;
    });
    on(this.canvas, 'mousedown', (e) => {
      const ev = e as MouseEvent;
      this.mouseHeld |= 1 << ev.button;
      this.mouseDown |= 1 << ev.button;
      this.device = 'kb';
    });
    on(window, 'mouseup', (e) => {
      this.mouseHeld &= ~(1 << (e as MouseEvent).button);
    });
    on(window, 'mousemove', (e) => {
      const ev = e as MouseEvent;
      if (document.pointerLockElement === this.canvas) {
        this.lookX += ev.movementX;
        this.lookY += ev.movementY;
      }
    });
    on(this.canvas, 'contextmenu', (e) => e.preventDefault());
    on(this.canvas, 'wheel', (e) => {
      e.preventDefault();
      this.wheel += Math.sign((e as WheelEvent).deltaY);
    }, { passive: false });
  }

  detach(): void {
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    this.listeners.length = 0;
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  requestPointerLock(): void {
    if (this.pointerLocked) return;
    try {
      const r = this.canvas.requestPointerLock() as unknown;
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => undefined);
    } catch {
      // Pointer lock unsupported (e.g. headless). Mouse look is then unavailable, keyboard still works.
    }
  }

  exitPointerLock(): void {
    if (this.pointerLocked) document.exitPointerLock();
  }

  private key(...codes: string[]): boolean {
    return codes.some((c) => this.held.has(c));
  }

  private pressed(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** Builds this frame's input. Call once per frame, then endFrame(). */
  poll(): FrameInput {
    const p = neutralInput();
    const ui: UiActions = { pause: false, map: false, camera: false, radioNext: false, radioPrev: false, confirm: false, back: false, up: false, down: false, left: false, right: false };
    let lookX = this.lookX;
    let lookY = this.lookY;

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
      p.sprint = this.key('ShiftLeft', 'ShiftRight');
      p.jump = this.pressed('Space');
      p.handbrake = this.key('Space');
      p.fire = (this.mouseHeld & 1) !== 0;
      p.firePressed = (this.mouseDown & 1) !== 0;
      p.aim = (this.mouseHeld & 4) !== 0;
      p.enterExit = this.pressed('KeyF', 'Enter');
      p.interact = !this.inVehicle && this.pressed('KeyE');
      p.horn = this.inVehicle && this.key('KeyE', 'KeyH');
      p.hornPressed = this.inVehicle && this.pressed('KeyE', 'KeyH');
      p.reload = !this.inVehicle && this.pressed('KeyR');
      p.prevWeapon = this.pressed('KeyQ') || this.wheel < 0;
      p.nextWeapon = this.wheel > 0;
      p.job = this.pressed('KeyT');
      for (let i = 0; i < 6; i++) if (this.pressed(`Digit${i + 1}`)) p.selectSlot = i;
      ui.radioNext = this.inVehicle && this.pressed('KeyR');
      ui.radioPrev = this.inVehicle && this.pressed('KeyQ');
      if (this.inVehicle) p.prevWeapon = this.wheel < 0;
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
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads ?? []).find((g) => g && g.connected && g.mapping === 'standard') ?? null;
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
      if (this.enabled && any) {
        if (lx !== 0 || ly !== 0) {
          p.moveX = lx;
          p.moveZ = -ly;
          p.steer = lx;
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
          ui.radioNext = ui.radioNext || tap(15);
          ui.radioPrev = ui.radioPrev || tap(14);
        } else {
          p.fire = p.fire || bv(7) > 0.4;
          p.firePressed = p.firePressed || (bv(7) > 0.4 && !was(7));
          p.aim = p.aim || bv(6) > 0.4;
          p.jump = p.jump || tap(2);
          p.reload = p.reload || tap(1);
          p.prevWeapon = p.prevWeapon || tap(4);
          p.nextWeapon = p.nextWeapon || tap(5);
          p.interact = p.interact || tap(12);
        }
        p.enterExit = p.enterExit || tap(3);
        p.job = p.job || tap(13);
        lookX += rx * 14;
        lookY += ry * 10;
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
    }
    return { player: p, lookX, lookY, ui, device: this.device };
  }

  endFrame(): void {
    this.down.clear();
    this.mouseDown = 0;
    this.lookX = 0;
    this.lookY = 0;
    this.wheel = 0;
  }

  /** Returns and clears a cheat code if the typed buffer ends with one of them. */
  takeCheat<T extends string>(codes: readonly T[]): T | null {
    for (const c of codes) {
      if (this.typed.endsWith(c)) {
        this.typed = '';
        return c;
      }
    }
    return null;
  }
}
