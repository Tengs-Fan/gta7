// Hollister Farm (world/attractions.ts): forty pumpkins to smash, PUMPKIN SMASH n/40 for each and PUMPKIN_REWARD for the
// set, once. The smashed ones are kept per Progress and saved (FARM_KEY); they do not grow back, but a new game stands
// every prop up again (StaticWorld.resetBroken), and a loaded game counts each one only once. Old Man Hollister stands
// in front of his porch while a player is near: spawned within HOLLISTER_NEAR of it and gone beyond HOLLISTER_FAR, so
// the rest of the city never sees him (nor the sim's ids and draws). Only in sims with ambient life: a multiplayer
// client's predictor moves its player alone, and the server's sim has him out for everyone.

import { formatMoney } from '../core/math';
import { attractionOf, type FarmAnchors } from '../world/attractions';
import { registerCompletion } from './completion';
import type { Appearance, Character } from './entities';
import type { Progress } from './progress';
import { registerSaveCodec } from './saveExt';
import type { Sim } from './sim';
import { registerSystem } from './systems';
import { makeBrain } from './brains';
import type { ViewState } from './viewState';

export const PUMPKIN_COUNT = 40;
export const PUMPKIN_REWARD = 2000;
export const FARM_KEY = 'farm';
/** Old Man Hollister is out on his porch while a player is within HOLLISTER_NEAR m of it, and gone past HOLLISTER_FAR. */
export const HOLLISTER_NEAR = 120;
export const HOLLISTER_FAR = 140;

/** Flannel, denim, white hair under a straw hat. */
const HOLLISTER_LOOK: Appearance = { skin: 0xd9a07a, shirt: 0x9c2a1e, pants: 0x2f4f7f, hair: 0xe4e0d8, hat: 0xd6b85a, height: 0.95, build: 1.12 };

export interface FarmState {
  /** The pumpkins smashed, by their place in the farm's list (0..PUMPKIN_COUNT - 1). */
  smashed: Set<number>;
  /** The set's reward is paid. */
  paid: boolean;
}

const states = new WeakMap<Progress, FarmState>();

export function farmState(p: Progress): FarmState {
  let s = states.get(p);
  if (!s) {
    s = { smashed: new Set(), paid: false };
    states.set(p, s);
  }
  return s;
}

interface FarmRuntime {
  farm: FarmAnchors;
  /** A pumpkin's place in the list, by prop index. */
  pumpkin: Map<number, number>;
  hollister: Character | null;
}

const runtime = new WeakMap<Sim, FarmRuntime>();

function rt(sim: Sim): FarmRuntime {
  let r = runtime.get(sim);
  if (!r) {
    const farm = attractionOf(sim.world.layout, 'farm').anchors;
    const fresh: FarmRuntime = { farm, pumpkin: new Map(farm.pumpkins.map((prop, k) => [prop, k])), hollister: null };
    sim.events.on('propBroken', (e) => {
      const k = fresh.pumpkin.get(e.index);
      if (k !== undefined) smash(sim, k);
    });
    r = fresh;
    runtime.set(sim, r);
  }
  return r;
}

/**
 * Old Man Hollister while he is out, else null (the audio has him shout): the mission character in front of the porch,
 * found among the view's characters, so a multiplayer client's mirror of the server finds him too.
 */
export function hollister(view: Pick<ViewState, 'world' | 'characters'>): Character | null {
  const at = attractionOf(view.world.layout, 'farm').anchors.porch;
  return view.characters.find((c) => c.role === 'mission' && !c.removed && Math.hypot(c.pos.x - at.x, c.pos.z - at.z) < 2) ?? null;
}

/** A pumpkin smashed (by slot 0's player: whoever smashes them in single player). */
function smash(sim: Sim, k: number): void {
  const s = farmState(sim.progress);
  if (s.smashed.has(k)) return;
  s.smashed.add(k);
  const n = s.smashed.size;
  if (n < PUMPKIN_COUNT || s.paid) {
    sim.events.emit('big', { text: `PUMPKIN SMASH ${n}/${PUMPKIN_COUNT}`, sub: '', style: 'info', duration: 2 });
    return;
  }
  s.paid = true;
  sim.progress.addMoney(PUMPKIN_REWARD);
  sim.events.emit('money', { amount: PUMPKIN_REWARD });
  sim.events.emit('big', { text: `PUMPKIN SMASH ${n}/${PUMPKIN_COUNT}`, sub: `Every last one. ${formatMoney(PUMPKIN_REWARD)}`, style: 'passed', duration: 4 });
  sim.events.emit('activityMilestone', { kind: 'pumpkins', reward: PUMPKIN_REWARD });
}

function updateHollister(sim: Sim, r: FarmRuntime): void {
  const at = r.farm.porch;
  let d = Infinity;
  for (const slot of sim.players) {
    const p = slot.pos();
    d = Math.min(d, Math.hypot(p.x - at.x, p.z - at.z));
  }
  const h = r.hollister;
  if (h && (h.removed || d > HOLLISTER_FAR)) {
    sim.removeCharacter(h);
    r.hollister = null;
  } else if (!h && d < HOLLISTER_NEAR) {
    const c = sim.spawnCharacter('mission', at.x, at.z, HOLLISTER_LOOK);
    c.heading = at.heading;
    c.persistent = true;
    const b = makeBrain('stand');
    b.homeX = at.x;
    b.homeZ = at.z;
    c.brain = b;
    r.hollister = c;
  }
}

registerSystem({
  id: 'farm',
  slot: 'afterInteractions',
  update(sim) {
    const r = rt(sim);
    if (sim.ambient) updateHollister(sim, r);
  },
  reset(sim) {
    runtime.delete(sim);
  },
});

// ---------------------------------------------------------------------------
// Save extension and checklist

interface FarmSave {
  smashed: number[];
  paid: boolean;
}

export function parseFarm(raw: unknown): FarmSave | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const smashed = Array.isArray(o.smashed) ? [...new Set(o.smashed.filter((k): k is number => Number.isInteger(k) && k >= 0 && k < PUMPKIN_COUNT))] : [];
  return { smashed, paid: o.paid === true };
}

registerSaveCodec<FarmSave>({
  key: FARM_KEY,
  serialize: (sim) => {
    const s = farmState(sim.progress);
    return s.smashed.size > 0 ? { smashed: [...s.smashed].sort((a, b) => a - b), paid: s.paid } : undefined;
  },
  parse: parseFarm,
  apply: (sim, value) => {
    const s = farmState(sim.progress);
    s.smashed = new Set(value.smashed);
    s.paid = value.paid;
  },
});

registerCompletion({
  id: 'pumpkins',
  group: 'collectibles',
  rows: (_view, me) => [{ id: 'pumpkins', group: 'collectibles', label: 'Pumpkins smashed', done: farmState(me.progress).smashed.size, total: PUMPKIN_COUNT }],
});
