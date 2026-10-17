import type { V3 } from '../core/math';

/**
 * Per-frame player intent, produced by the input layer (keyboard, mouse,
 * gamepad, or test bots) and consumed by the simulation.
 * "Pressed" flags are true only on the frame the button went down.
 */
export interface PlayerInput {
  /** On-foot movement relative to the camera: x = right, z = forward, each -1..1. */
  moveX: number;
  moveZ: number;
  /** Heading the camera looks along (for camera-relative movement). */
  cameraYaw: number;
  /** World-space ray through the crosshair. */
  aimOrigin: V3;
  aimDir: V3;
  sprint: boolean;
  jump: boolean;
  fire: boolean;
  firePressed: boolean;
  aim: boolean;
  enterExit: boolean;
  interact: boolean;
  reload: boolean;
  nextWeapon: boolean;
  prevWeapon: boolean;
  /** Weapon slot selected this frame (0 = fists) or -1. */
  selectSlot: number;
  // Vehicle
  throttle: number;
  brake: number;
  steer: number;
  /**
   * The steer value is digital: a steering key (A/D/arrows) is held and no stick overrides it, so
   * the player controller shapes it (see PlayerController.steerFor). With no key held (a centred
   * stick or a released key) the value passes straight through, as an analog one does.
   */
  steerDigital: boolean;
  handbrake: boolean;
  horn: boolean;
  hornPressed: boolean;
  /** Toggle taxi / vigilante job (pressed). */
  job: boolean;
}

export function neutralInput(): PlayerInput {
  return {
    moveX: 0,
    moveZ: 0,
    cameraYaw: 0,
    aimOrigin: { x: 0, y: 0, z: 0 },
    aimDir: { x: 0, y: 0, z: 1 },
    sprint: false,
    jump: false,
    fire: false,
    firePressed: false,
    aim: false,
    enterExit: false,
    interact: false,
    reload: false,
    nextWeapon: false,
    prevWeapon: false,
    selectSlot: -1,
    throttle: 0,
    brake: 0,
    steer: 0,
    steerDigital: false,
    handbrake: false,
    horn: false,
    hornPressed: false,
    job: false,
  };
}
