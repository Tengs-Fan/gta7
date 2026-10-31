// Eternal Palms Cemetery's epitaphs (world/attractions.ts): twelve headstones that stand whatever hits them, each with
// a marker in front of it. E there shows its line, and the first reading of each counts (EPITAPHS n/12); the ones read
// are kept per Progress and saved (EPITAPH_KEY). A read stone's marker dims (for slot 0, whose marker colours these are).

import { attractionOf } from '../world/attractions';
import type { StaticWorld } from '../world/staticWorld';
import { registerCompletion } from './completion';
import type { Marker } from './interactions';
import type { Progress } from './progress';
import { registerSaveCodec } from './saveExt';
import type { Sim } from './sim';
import type { PlayerView } from './viewState';

/** The stones' lines, in the cemetery's epitaph order. Original, and as the city's drivers would want them. */
export const EPITAPHS: readonly string[] = [
  'HERE LIES GARY. HE HAD RIGHT OF WAY.',
  'BELOVED MOTHER. FEARLESS MERGER.',
  'DIED AS HE LIVED: AT A YELLOW LIGHT.',
  'SHE FINALLY FOUND PARKING.',
  'HE ALWAYS SAID THE BRAKES WERE OPTIONAL. HE WAS WRONG ONCE.',
  'BELOVED UNCLE. HONKED AT EVERYTHING. HONK ONCE FOR HIM.',
  'GONE TO THAT BIG CAR WASH IN THE SKY.',
  'HE WENT TO SOUTHGATE TO GET A SANDWICH.',
  'HERE LIES DALE. HE WAS JUST GOING TO MOVE HIS CAR.',
  'LOVING WIFE. KEPT THE RECEIPT FOR EVERYTHING. EVEN THIS.',
  'FINALLY GOT THROUGH ON THE AZURA TALK CALL-IN LINE. CHET HUNG UP.',
  'HE ASKED THE GULLS NICELY. THE GULLS SAID NO.',
];

export const EPITAPH_KEY = 'epitaphs';
const UNREAD = 0xffe08a;
const READ = 0x7d8796;

const states = new WeakMap<Progress, Set<number>>();

/** The epitaphs read by a player, by their place in EPITAPHS. */
export function epitaphsRead(p: Progress): Set<number> {
  let s = states.get(p);
  if (!s) {
    s = new Set();
    states.set(p, s);
  }
  return s;
}

const markerId = (k: number, read: boolean) => `epitaph:${k}${read ? ':read' : ''}`;

/** The stones' markers (Interactions), unread: E in one reads its stone. */
export function epitaphMarkers(world: StaticWorld): Marker[] {
  return attractionOf(world.layout, 'cemetery').anchors.epitaphs.map((e, k) => ({ id: markerId(k, false), kind: 'epitaph', x: e.x, z: e.z, radius: 1.5, label: 'Press E to read', color: UNREAD, ref: String(k) }));
}

/** Shows epitaph `k` to the player in `slot`; the first reading counts and dims the stone's marker. */
export function readEpitaph(sim: Sim, slot: PlayerView, k: number): void {
  const read = epitaphsRead(slot.progress);
  const first = !read.has(k);
  read.add(k);
  sim.events.emit('big', { text: EPITAPHS[k]!, sub: first ? `EPITAPHS ${read.size}/${EPITAPHS.length}` : '', style: 'info', duration: 5, ...slot.tag });
  if (first && slot.id === 0) dim(sim, k);
}

/** Gives a read stone's marker its dim colour (the renderer makes a new view for a new id). */
function dim(sim: Sim, k: number): void {
  const m = sim.interactions.markers.find((q) => q.kind === 'epitaph' && q.ref === String(k))!;
  m.id = markerId(k, true);
  m.color = READ;
}

registerSaveCodec<number[]>({
  key: EPITAPH_KEY,
  serialize: (sim) => {
    const s = epitaphsRead(sim.progress);
    return s.size > 0 ? [...s].sort((a, b) => a - b) : undefined;
  },
  parse: (raw) => (Array.isArray(raw) ? [...new Set(raw.filter((k): k is number => Number.isInteger(k) && k >= 0 && k < EPITAPHS.length))] : undefined),
  apply: (sim, value) => {
    const s = epitaphsRead(sim.progress);
    for (const k of value) {
      s.add(k);
      dim(sim, k);
    }
  },
});

registerCompletion({
  id: 'epitaphs',
  group: 'collectibles',
  rows: (_view, me) => [{ id: 'epitaphs', group: 'collectibles', label: 'Epitaphs read', done: epitaphsRead(me.progress).size, total: EPITAPHS.length }],
});
