// First-time tutorial hints and the steal prompt. Each hint shows once ever: its id goes into
// Settings.hintsSeen, which is saved with the settings. Game owns the system and updates it after
// Sim.update; the HUD's help queue decides when a queued hint actually appears (never over a
// message, never while a subtitle is up).

import type { Vehicle } from '../sim/entities';
import type { Sim } from '../sim/sim';
import type { InputDevice } from './glyphs';

export interface HintHost {
  /** Tutorial hints are switched on in the settings. */
  enabled(): boolean;
  /** Ids of the hints already shown (Settings.hintsSeen). */
  seen(): readonly string[];
  /** Records a shown hint for good. */
  markSeen(id: string): void;
  /** Queues a hint on the HUD; false when the queue is full (the rule then tries again later). */
  show(html: string, duration: number): boolean;
}

export interface HintFrame {
  /** Device of the last input. */
  device: InputDevice;
  /** The mouse is free in play although pointer lock is available, so the camera ignores it. */
  mouseFree: boolean;
}

/** Vehicle entries that still get the steal prompt next to a car. */
export const STEAL_PROMPTS = 5;

interface Rule {
  id: string;
  /** HUD text; keys are named by their QWERTY binding and drawn for the active device. */
  text: string;
  duration: number;
  when(sim: Sim, hints: HintSystem): boolean;
}

const RULES: readonly Rule[] = [
  {
    id: 'drive',
    text: 'Hold <kbd>Space</kbd> for the handbrake. <kbd>R</kbd> changes the radio station.',
    duration: 7,
    when: (sim) => sim.player.vehicle?.driver === sim.player && !sim.playerDown,
  },
  {
    id: 'wanted',
    text: 'Break line of sight and leave the search area, or drive into a Spray Shack (S on the radar).',
    duration: 8,
    when: (sim) => sim.wanted.level > 0 && !sim.playerDown,
  },
  {
    id: 'weapon',
    text: 'Right-click to aim, left-click to shoot. <kbd>R</kbd> reloads.',
    duration: 7,
    when: (sim) => sim.player.state === 'normal' && sim.player.inventory.current !== 'fists' && !sim.playerDown,
  },
  {
    id: 'health',
    text: 'Health is low: buy First Aid at Bang Bang Guns or save at the safehouse.',
    duration: 7,
    when: (sim) => sim.player.alive && !sim.playerDown && sim.player.health < sim.player.maxHealth * 0.35,
  },
  {
    id: 'mouse',
    text: 'Click the game to control the camera.',
    duration: 5,
    when: (_sim, hints) => hints.mouseFreeFor > 1,
  },
];

/** A car worth suggesting: it drives and is not about to blow up. */
function intact(v: Vehicle): boolean {
  return v.drivable && !v.burning && v.health > 0;
}

export class HintSystem {
  /** Seconds the mouse has been free in play on a keyboard (see HintFrame.mouseFree). */
  mouseFreeFor = 0;

  constructor(private readonly host: HintHost) {}

  /** Counts the player's vehicle entries for the steal prompt. Returns the unsubscribe function. */
  bind(sim: Sim): () => void {
    this.mouseFreeFor = 0;
    return sim.events.on('vehicleEnter', (e) => {
      if (!e.character.isPlayer) return;
      const n = this.stealCount();
      if (n < STEAL_PROMPTS) this.host.markSeen(`steal:${n + 1}`);
    });
  }

  /** Vehicle entries counted so far (persisted as steal:1 .. steal:5). */
  stealCount(): number {
    return this.host.seen().filter((id) => /^steal:[1-9]$/.test(id)).length;
  }

  /** Call once per frame of play, after Sim.update. */
  update(dt: number, sim: Sim, frame: HintFrame): void {
    // A pad player has no use for the mouse.
    this.mouseFreeFor = frame.mouseFree && frame.device === 'kb' ? this.mouseFreeFor + dt : 0;
    if (!this.host.enabled()) return;
    for (const r of RULES) {
      if (this.host.seen().includes(r.id) || !r.when(sim, this)) continue;
      if (this.host.show(r.text, r.duration)) this.host.markSeen(r.id);
    }
  }

  /** 'Press F to steal the ...' next to an enterable car, for the first few entries (null otherwise). */
  stealPrompt(sim: Sim): string | null {
    if (!this.host.enabled() || this.stealCount() >= STEAL_PROMPTS) return null;
    const p = sim.player;
    // Markers and the job prompt have the prompt slot first.
    if (p.state !== 'normal' || sim.playerDown || sim.interactions.current()) return null;
    const v = sim.playerCtl.findEnterable(p);
    if (!v || !intact(v)) return null;
    // Nobody steals the car they just got out of.
    return `Press F to ${v.lastDriver === p ? 'get in' : 'steal'} the ${v.spec.name}`;
  }
}
