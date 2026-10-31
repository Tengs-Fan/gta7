// Las Lomas County's farms (world/country/farms.ts) in the sim: the cows, the scarecrows and the propane tank.
// - A cow tipped at night (E beside a standing one, TIP_FROM to TIP_TO; in single player only) or knocked over by a car
//   lies there until DAWN, when every cow in the county gets back up. That is a rule of the clock alone, which a
//   multiplayer client's mirror applies as well (net/mirror.ts): no message stands a prop up again.
// - Twenty scarecrows to knock down: SCARECROWS n/20 for each and SCARECROW_REWARD for the set, once. They are kept per
//   Progress and saved (FARMS_KEY), as the pumpkins are (sim/farm.ts), in single player only.
// - The propane tank behind the dairy goes up when it breaks, on the tick after: a car breaks it inside its collision step.
// - The dairy's farmer stands at his pasture's gate while a player is within DAIRYMAN_NEAR of it, and is gone past
//   DAIRYMAN_FAR, as Old Man Hollister keeps his porch (sim/farm.ts), in sims with ambient life only; the audio has him
//   shout at a cow going over.
// Nothing here draws sim.rng, and only a player near the dairy brings its farmer out, so a run that never comes near the
// farms runs as it did.

import { formatMoney } from '../core/math';
import { COW_COUNT, PROPANE, SCARECROW_COUNT, type CountyFarms } from '../world/country/farms';
import type { StaticCollider } from '../world/colliders';
import type { StaticWorld } from '../world/staticWorld';
import { registerCompletion } from './completion';
import { makeBrain } from './brains';
import type { Appearance, Character } from './entities';
import type { Marker } from './interactions';
import type { Progress } from './progress';
import { registerSaveCodec } from './saveExt';
import type { Sim } from './sim';
import { registerSystem } from './systems';
import type { PlayerView, ViewState } from './viewState';

export const SCARECROW_REWARD = 3000;
export const FARMS_KEY = 'farms';
/** Cows are tipped from TIP_FROM to TIP_TO (hours, over midnight), and every cow stands up again at DAWN. */
export const TIP_FROM = 21;
export const TIP_TO = 5;
export const DAWN = 6;
/** How near (m, from the cow's middle) a player stands to tip one: just past her flank. */
export const TIP_REACH = 2.2;
/** The dairy's farmer is out at his gate while a player is within DAIRYMAN_NEAR m of it, and gone past DAIRYMAN_FAR. */
export const DAIRYMAN_NEAR = 120;
export const DAIRYMAN_FAR = 140;
/** A white T-shirt under denim, a green feed cap. */
const DAIRYMAN_LOOK: Appearance = { skin: 0xc68e6a, shirt: 0xe9e4d8, pants: 0x34557f, hair: 0x5a4636, hat: 0x2f6b3a, height: 1.02, build: 1.18 };
/** The propane tank's blast: its radius (m) and damage, a burning car's. */
const PROPANE_BLAST = 7.5;
const PROPANE_DAMAGE = 360;

export function canTip(hours: number): boolean {
  return hours >= TIP_FROM || hours < TIP_TO;
}

/** Whether the clock passed DAWN going from `before` to `now` (hours): forward, by less than half a day. */
export function passedDawn(before: number, now: number): boolean {
  const ahead = (now - before + 24) % 24;
  const dawn = (DAWN - before + 24) % 24;
  return ahead < 12 && dawn > 0 && dawn <= ahead;
}

/** Stands every knocked-over cow up again if the clock passed dawn from `before` to `now`: their prop indices. */
export function cowsAtDawn(world: StaticWorld, before: number, now: number): number[] {
  return passedDawn(before, now) ? world.restoreProps('cow') : [];
}

function colliderOf(world: StaticWorld, prop: number): StaticCollider {
  return world.grid.colliders[world.propColliders[prop]!]!;
}

/** A marker at each cow (Interactions, in single player): not drawn (renderer.ts), it only takes the E beside her. */
export function cowMarkers(world: StaticWorld): Marker[] {
  return world.layout.country.farms.cows.map((i, k) => {
    const p = world.layout.props[i]!;
    return { id: `cow:${k}`, kind: 'cow', x: p.x, z: p.z, radius: TIP_REACH, label: '', color: 0xffffff, ref: String(k) };
  });
}

/** What standing beside cow `k` says: none while she is down. */
export function cowPrompt(sim: Sim, k: number): string | null {
  if (colliderOf(sim.world, sim.world.layout.country.farms.cows[k]!).broken) return null;
  return canTip(sim.clock.hours) ? 'Press E to tip the cow' : 'She is wide awake. Come back after dark.';
}

/** The player in `slot` tips cow `k` over, away from him, if she stands and it is night. */
export function tipCow(sim: Sim, slot: PlayerView, k: number): void {
  const farms = sim.world.layout.country.farms;
  const i = farms.cows[k]!;
  const c = colliderOf(sim.world, i);
  if (c.broken || !canTip(sim.clock.hours)) return;
  sim.world.breakCollider(c);
  const p = sim.world.layout.props[i]!;
  const me = slot.character.pos;
  const d = Math.hypot(p.x - me.x, p.z - me.z) || 1;
  sim.events.emit('propBroken', { index: i, dirX: (p.x - me.x) / d, dirZ: (p.z - me.z) / d });
  const down = farms.cows.filter((j) => colliderOf(sim.world, j).broken).length;
  sim.events.emit('big', { text: `COW TIPPED ${down}/${COW_COUNT}`, sub: '', style: 'info', duration: 2, ...slot.tag });
}

/**
 * The dairy's farmer while he is out, else null (the audio has him shout): the mission character at his gate, found among
 * the view's characters, so a multiplayer client's mirror of the server finds him too.
 */
export function dairyman(view: Pick<ViewState, 'world' | 'characters'>): Character | null {
  const at = view.world.layout.country.farms.dairyman;
  return view.characters.find((c) => c.role === 'mission' && !c.removed && Math.hypot(c.pos.x - at.x, c.pos.z - at.z) < 2) ?? null;
}

export interface FarmsState {
  /** The scarecrows knocked down, by their place in the farms' list (0..SCARECROW_COUNT - 1). */
  knocked: Set<number>;
  /** The set's reward is paid. */
  paid: boolean;
}

const states = new WeakMap<Progress, FarmsState>();

export function farmsState(p: Progress): FarmsState {
  let s = states.get(p);
  if (!s) {
    s = { knocked: new Set(), paid: false };
    states.set(p, s);
  }
  return s;
}

interface FarmsRuntime {
  farms: CountyFarms;
  /** A scarecrow's place in the list, by prop index. */
  scarecrow: Map<number, number>;
  /** The clock's hours at the last update, for the dawn rule. */
  hours: number;
  /** The propane tank broke and goes up next update. */
  blast: boolean;
  dairyman: Character | null;
}

const runtime = new WeakMap<Sim, FarmsRuntime>();

function rt(sim: Sim): FarmsRuntime {
  let r = runtime.get(sim);
  if (!r) {
    const farms = sim.world.layout.country.farms;
    const fresh: FarmsRuntime = { farms, scarecrow: new Map(farms.scarecrows.map((prop, k) => [prop, k])), hours: sim.clock.hours, blast: false, dairyman: null };
    sim.events.on('propBroken', (e) => {
      if (e.index === fresh.farms.propane) fresh.blast = true;
      const k = fresh.scarecrow.get(e.index);
      if (k !== undefined && !sim.multiplayer) knock(sim, k);
    });
    r = fresh;
    runtime.set(sim, r);
  }
  return r;
}

/** A scarecrow knocked down (by slot 0's player: whoever does it in single player). */
function knock(sim: Sim, k: number): void {
  const s = farmsState(sim.progress);
  if (s.knocked.has(k)) return;
  s.knocked.add(k);
  const n = s.knocked.size;
  if (n < SCARECROW_COUNT || s.paid) {
    sim.events.emit('big', { text: `SCARECROWS ${n}/${SCARECROW_COUNT}`, sub: '', style: 'info', duration: 2 });
    return;
  }
  s.paid = true;
  sim.progress.addMoney(SCARECROW_REWARD);
  sim.events.emit('money', { amount: SCARECROW_REWARD });
  sim.events.emit('big', { text: `SCARECROWS ${n}/${SCARECROW_COUNT}`, sub: `The crows thank you. ${formatMoney(SCARECROW_REWARD)}`, style: 'passed', duration: 4 });
  sim.events.emit('activityMilestone', { kind: 'scarecrows', reward: SCARECROW_REWARD });
}

function updateDairyman(sim: Sim, r: FarmsRuntime): void {
  const at = r.farms.dairyman;
  let d = Infinity;
  for (const slot of sim.players) {
    const p = slot.pos();
    d = Math.min(d, Math.hypot(p.x - at.x, p.z - at.z));
  }
  const h = r.dairyman;
  if (h && (h.removed || d > DAIRYMAN_FAR)) {
    sim.removeCharacter(h);
    r.dairyman = null;
  } else if (!h && d < DAIRYMAN_NEAR) {
    const c = sim.spawnCharacter('mission', at.x, at.z, DAIRYMAN_LOOK);
    c.heading = at.heading;
    c.persistent = true;
    const b = makeBrain('stand');
    b.homeX = at.x;
    b.homeZ = at.z;
    c.brain = b;
    r.dairyman = c;
  }
}

registerSystem({
  id: 'farms',
  slot: 'afterInteractions',
  update(sim) {
    const r = rt(sim);
    const up = cowsAtDawn(sim.world, r.hours, sim.clock.hours);
    r.hours = sim.clock.hours;
    if (up.length > 0) sim.events.emit('propsRestored', { indices: up });
    if (sim.ambient) updateDairyman(sim, r);
    if (r.blast) {
      r.blast = false;
      const p = sim.world.layout.props[r.farms.propane]!;
      sim.combat.explosion(p.x, p.y + PROPANE.axis, p.z, PROPANE_BLAST, PROPANE_DAMAGE, null, null);
    }
  },
  reset(sim) {
    runtime.delete(sim);
  },
});

// ---------------------------------------------------------------------------
// Save extension and checklist

interface FarmsSave {
  knocked: number[];
  paid: boolean;
}

export function parseFarms(raw: unknown): FarmsSave | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const knocked = Array.isArray(o.knocked) ? [...new Set(o.knocked.filter((k): k is number => Number.isInteger(k) && k >= 0 && k < SCARECROW_COUNT))] : [];
  return { knocked, paid: o.paid === true };
}

registerSaveCodec<FarmsSave>({
  key: FARMS_KEY,
  serialize: (sim) => {
    const s = farmsState(sim.progress);
    return s.knocked.size > 0 ? { knocked: [...s.knocked].sort((a, b) => a - b), paid: s.paid } : undefined;
  },
  parse: parseFarms,
  apply: (sim, value) => {
    const s = farmsState(sim.progress);
    s.knocked = new Set(value.knocked);
    s.paid = value.paid;
  },
});

registerCompletion({
  id: 'scarecrows',
  group: 'collectibles',
  rows: (_view, me) => [{ id: 'scarecrows', group: 'collectibles', label: 'Scarecrows knocked down', done: farmsState(me.progress).knocked.size, total: SCARECROW_COUNT }],
});
