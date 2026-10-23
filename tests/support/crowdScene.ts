// Records what CrowdView draws for a fixed single-player scene: per sampled frame, the instance count of every mesh and
// every instance's matrix and colour. The player stands first in the character list, as in a single-player game.
//
// It touches only the CrowdView and Sim API that exists at 72d0b98 (sync's fifth argument is ignored there), so the same
// file records the pre-refactor baseline in a scratch worktree (scripts/record-crowd-baseline.ts) and replays the scene
// on the current tree (tests/unit/r2_characters.test.ts). CrowdView needs the canvas stubs of installCanvasStubs.

import * as THREE from 'three';
import type { CrowdView } from '../../src/render/crowd';
import { neutralInput, type PlayerInput } from '../../src/sim/input';
import { Sim } from '../../src/sim/sim';
import { StaticWorld } from '../../src/world/staticWorld';

const DT = 1 / 60;
export const CROWD_FRAMES = 240;
/** Frames (1-based, after the sync of that frame) at which the crowd is sampled. */
export const CROWD_SAMPLES = [30, 90, 150, 240] as const;

const r5 = (n: number): number => Math.round(n * 1e5) / 1e5;

export interface CrowdPartSample {
  count: number;
  matrices: number[][];
  colors: number[];
}

export interface CrowdSample {
  frame: number;
  parts: Record<string, CrowdPartSample>;
  weapons: Record<string, CrowdPartSample>;
}

export interface CrowdBaseline {
  dt: number;
  samples: CrowdSample[];
}

function samplePart(mesh: THREE.InstancedMesh): CrowdPartSample {
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const matrices: number[][] = [];
  const colors: number[] = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    matrices.push(m.elements.map(r5));
    if (mesh.instanceColor) {
      mesh.getColorAt(i, c);
      colors.push(c.getHex());
    }
  }
  return { count: mesh.count, matrices, colors };
}

/** Walks, then aims and fires a pistol, among a civilian, a cop and a second civilian, drawing every frame. */
export function recordCrowdScene(cv: CrowdView, localId: (sim: Sim) => number): CrowdBaseline {
  const sim = new Sim({ world: new StaticWorld(), ambient: false, police: false });
  const p = sim.player;
  const x = p.pos.x;
  const z = p.pos.z;
  const near = sim.spawnCharacter('civilian', x + 3, z + 2);
  sim.spawnCharacter('cop', x - 4, z + 5);
  sim.spawnCharacter('civilian', x + 6, z - 3);
  p.inventory.give('pistol', 100);
  p.inventory.current = 'pistol';

  const sync = cv.sync.bind(cv) as (chars: readonly unknown[], camX: number, camZ: number, dt: number, local?: number) => void;
  const samples: CrowdSample[] = [];
  for (let f = 1; f <= CROWD_FRAMES; f++) {
    const o = p.pos;
    let inp: PlayerInput = neutralInput();
    if (f <= 90) inp = { ...inp, moveZ: 1, sprint: f > 60, cameraYaw: 0.4 };
    else {
      const dx = near.pos.x - o.x;
      const dz = near.pos.z - o.z;
      const l = Math.hypot(dx, dz) || 1;
      inp = { ...inp, aim: true, fire: f % 40 === 0, firePressed: f % 40 === 0, cameraYaw: Math.atan2(dx, dz) };
      inp.aimOrigin = { x: o.x - (dx / l) * 3, y: o.y + 2.2, z: o.z - (dz / l) * 3 };
      const ax = dx + (dx / l) * 3;
      const az = dz + (dz / l) * 3;
      const ay = near.pos.y + 1.2 - inp.aimOrigin.y;
      const al = Math.hypot(ax, ay, az) || 1;
      inp.aimDir = { x: ax / al, y: ay / al, z: az / al };
    }
    if (inp.aimOrigin.x === 0 && inp.aimOrigin.y === 0 && inp.aimOrigin.z === 0) inp.aimOrigin = { x: o.x, y: o.y + 3, z: o.z - 6 };
    sim.update(DT, inp);
    sync(sim.characters, sim.player.pos.x, sim.player.pos.z, DT, localId(sim));
    if (!(CROWD_SAMPLES as readonly number[]).includes(f)) continue;
    const internals = cv as unknown as { parts: Record<string, { mesh: THREE.InstancedMesh }>; weapons: Map<string, { mesh: THREE.InstancedMesh }> };
    samples.push({
      frame: f,
      parts: Object.fromEntries(Object.entries(internals.parts).map(([k, v]) => [k, samplePart(v.mesh)])),
      weapons: Object.fromEntries([...internals.weapons].map(([k, v]) => [k, samplePart(v.mesh)])),
    });
  }
  return { dt: DT, samples };
}
