import { makeBrain } from '../brains';
import { releaseCharacter } from './shared';
import type { Character } from '../entities';
import type { ActivityDef, ActivityHost } from './types';

export interface RampageJob {
  kind: 'rampage';
  tag: string;
  kills: number;
  need: number;
  timer: number;
  spawnTimer: number;
  centerX: number;
  centerZ: number;
}

/**
 * The rampage each gang member was spawned for. Several players may run rampages at once (multiplayer): each counts,
 * credits and releases only its own enemies. A 'rampage'-tagged character with no entry (tagged by hand) belongs to
 * whichever rampage looks at it, as every tagged one did when there could be only one.
 */
const owners = new WeakMap<Character, RampageJob>();

function ownedBy(c: Character, j: RampageJob): boolean {
  return c.missionTag === 'rampage' && (owners.get(c) ?? j) === j;
}

function updateRampage(host: ActivityHost, j: RampageJob, dt: number): void {
  const sim = host.sim;
  j.timer -= dt;
  if (j.kills >= j.need) {
    sim.progress.rampages.push(j.tag);
    sim.progress.addMoney(2000);
    sim.events.emit('money', { amount: 2000 });
    sim.events.emit('big', { text: 'RAMPAGE PASSED', sub: '$2,000', style: 'passed', duration: 4 });
    host.end('');
    sim.events.emit('activityMilestone', { kind: 'rampage', reward: 2000 });
    return;
  }
  if (j.timer <= 0) {
    sim.events.emit('big', { text: 'RAMPAGE FAILED', sub: '', style: 'failed', duration: 3 });
    host.end('');
    return;
  }
  j.spawnTimer -= dt;
  if (j.spawnTimer > 0) return;
  j.spawnTimer = 1.2;
  const alive = sim.characters.filter((c) => ownedBy(c, j) && c.alive && !c.removed).length;
  if (alive >= 7) return;
  const pp = sim.playerPos();
  const pt = sim.world.walk.randomPointNear(sim.rng, pp.x, pp.z, 22, 48);
  if (!pt || sim.world.waterDepth(pt.x, pt.z) > -0.1) return;
  const g = sim.spawnCharacter('gang', pt.x, pt.z);
  g.owner = 'mission';
  g.persistent = true;
  g.missionTag = 'rampage';
  owners.set(g, j);
  g.cash = 25;
  const b = makeBrain('fight');
  b.hostile = true;
  b.brave = true;
  b.target = sim.player;
  b.modeTimer = 999;
  b.accuracy = 0.25;
  g.brain = b;
  if (sim.rng.chance(0.45)) {
    g.inventory.infinite = true;
    g.inventory.give('pistol', 999);
    g.inventory.current = 'pistol';
  }
}

/** Started by a rampage pickup (Activities.startRampage), never by the job key. */
export const rampageActivity: ActivityDef<RampageJob> = {
  kind: 'rampage',

  canStart: () => false,

  prompt: () => null,

  start(host, _slot, _vehicle, tag = '') {
    if (host.job) return false;
    const sim = host.sim;
    const pp = sim.playerPos();
    const j: RampageJob = { kind: 'rampage', tag, kills: 0, need: 12, timer: 75, spawnTimer: 0, centerX: pp.x, centerZ: pp.z };
    host.job = j;
    sim.player.inventory.give('smg', 300);
    sim.player.inventory.current = 'smg';
    sim.events.emit('big', { text: 'RAMPAGE!', sub: 'Kill 12 gang members in 75 seconds', style: 'title', duration: 3.5 });
    return true;
  },

  update: updateRampage,

  end(host, j) {
    const sim = host.sim;
    for (const c of sim.characters) {
      if (!ownedBy(c, j)) continue;
      owners.delete(c);
      releaseCharacter(c);
    }
    if (!sim.progress.rampages.includes(j.tag)) sim.pickupSys.rearmRampage(j.tag, 25, sim.progress);
  },

  objectives: () => [],

  status: (j) => `RAMPAGE ${j.kills}/${j.need}  ·  ${Math.ceil(j.timer)}`,

  // A mission takes over quietly from a taxi or vigilante job (its markers are used on foot, which ends those
  // anyway), but a rampage it calls off is said out loud: the markers refuse to start one during it.
  abortText: (reason) => (reason === 'mission' ? 'Rampage abandoned.' : 'Rampage failed.'),

  attach(host) {
    host.sim.events.on('characterKilled', (e) => {
      // The kill counts for the rampage of the player who made it.
      const slot = e.killer?.isPlayer ? host.sim.slotOf(e.killer) : undefined;
      if (!slot) return;
      const h = host.hostOf(slot);
      const j = h.job as RampageJob | null;
      if (j && j.kind === 'rampage' && ownedBy(e.victim, j)) {
        j.kills++;
        if (j.kills < j.need) h.sim.events.emit('objective', { text: `Rampage: ${j.kills}/${j.need} gang members` });
      }
    });
  },
};
