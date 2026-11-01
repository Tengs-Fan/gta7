// First-time tutorial hints. Each hint is read once ever: once it has been
// on screen for half its time its id goes into Settings.hintsSeen, which is saved with the
// settings. A hint still waiting in the HUD's queue is not seen yet, so quitting, reloading or
// switching hints off before its turn brings it back next time. Game owns the system and updates
// it after Sim.update; the HUD's help queue decides when a hint appears (never over a message,
// never while a subtitle is up).

import { HAIL_STARS } from '../sim/activities/taxiHail';
import { isGun } from '../sim/specs';
import { playerOf, type PlayerView, type ViewState } from '../sim/viewState';
import type { InputDevice } from './glyphs';
import type { HintOptions } from './hud';

export interface HintHost {
  /** Tutorial hints are switched on in the settings. */
  enabled(): boolean;
  /** Ids of the hints already read (Settings.hintsSeen). */
  seen(): readonly string[];
  /** Records a read hint for good. */
  markSeen(id: string): void;
  /** Queues a hint on the HUD; false when the queue is full (the rule then tries again later). */
  show(html: string, duration: number, opts: HintOptions): boolean;
  /** Whether the HUD holds this hint, queued or on screen. */
  pending(id: string): boolean;
}

export interface HintFrame {
  /** Device of the last input. */
  device: InputDevice;
  /** The mouse is free in play although pointer lock is available, so the camera ignores it. */
  mouseFree: boolean;
}

interface Rule {
  id: string;
  /** HUD text; keys are named by their QWERTY binding and drawn for the active device. */
  text: string;
  duration: number;
  when(sim: ViewState, me: PlayerView, hints: HintSystem): boolean;
}

const RULES: readonly Rule[] = [
  {
    id: 'drive',
    text: 'Hold <kbd>Space</kbd> for the handbrake. <kbd>R</kbd> changes the radio station.',
    duration: 7,
    when: (_sim, me) => me.character.vehicle?.driver === me.character && !me.down,
  },
  {
    id: 'taxi',
    text: 'People at the curb wave down cabs: pull up beside one to take the fare. Or stop and press <kbd>T</kbd> for a taxi job.',
    duration: 8,
    when: (sim, me) => me.character.vehicle?.kind === 'taxi' && me.character.vehicle.driver === me.character && !me.down && me.wanted.level <= HAIL_STARS && !sim.activities.busy && !sim.missions.active,
  },
  {
    id: 'taxi:shift',
    text: 'Quicker trips pay more, and every fifth fare pays a $500 bonus. <kbd>T</kbd> ends the taxi job.',
    duration: 8,
    when: (sim, me) => sim.activities.job?.kind === 'taxi' && !me.down,
  },
  {
    id: 'wanted',
    text: 'Break line of sight and leave the search area, or drive into a Spray Shack (S on the radar).',
    duration: 8,
    when: (_sim, me) => me.wanted.level > 0 && !me.down,
  },
  {
    id: 'weapon',
    text: 'Right-click to aim, left-click to shoot. <kbd>R</kbd> reloads.',
    duration: 7,
    when: (_sim, me) => me.character.state === 'normal' && isGun(me.character.inventory.current) && !me.down,
  },
  {
    id: 'health',
    text: 'Health is low: buy First Aid at Bang Bang Guns or save at the safehouse.',
    duration: 7,
    when: (sim, me) => lowHealth(me) && sim.interactions.canSave(me),
  },
  {
    id: 'health:restricted',
    text: 'Health is low: grab a health pickup or buy First Aid at Bang Bang Guns.',
    duration: 7,
    // Saving is unavailable during a mission, a rampage or a police chase. Keep this separate
    // from the safehouse lesson so reading it does not consume advice that only helps later.
    when: (sim, me) => lowHealth(me) && !sim.interactions.canSave(me),
  },
  {
    id: 'mouse',
    text: 'Click the game to control the camera.',
    duration: 5,
    when: (_sim, _me, hints) => hints.mouseFreeFor > 1,
  },
];

function lowHealth(me: PlayerView): boolean {
  const p = me.character;
  return p.alive && !me.down && p.health < p.maxHealth * 0.35;
}

export class HintSystem {
  /** Seconds the mouse has been free in play on a keyboard (see HintFrame.mouseFree). */
  mouseFreeFor = 0;

  /** Id of the player slot the hints are for. */
  localPlayerId = 0;

  constructor(private readonly host: HintHost) {}

  /** Starts the system for the player in slot `localPlayerId` of a new game. */
  bind(localPlayerId = 0): void {
    this.mouseFreeFor = 0;
    this.localPlayerId = localPlayerId;
  }

  /** Call once per frame of play, after Sim.update. */
  update(dt: number, sim: ViewState, frame: HintFrame): void {
    // A pad player has no use for the mouse.
    this.mouseFreeFor = frame.mouseFree && frame.device === 'kb' ? this.mouseFreeFor + dt : 0;
    if (!this.host.enabled()) return;
    const me = playerOf(sim, this.localPlayerId);
    for (const r of RULES) {
      if (this.host.seen().includes(r.id) || this.host.pending(r.id) || !r.when(sim, me, this)) continue;
      this.host.show(r.text, r.duration, { id: r.id, valid: () => r.when(sim, playerOf(sim, this.localPlayerId), this), onRead: () => this.host.markSeen(r.id) });
    }
  }
}
