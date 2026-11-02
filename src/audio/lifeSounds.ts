// What Las Lomas County's countryside lets the ear know: a sheet the view of its life (render/country/life) writes each
// frame and the audio (fieldVoices.ts) reads, so neither imports the other. The three engines are continuous voices (the
// crop-duster's, the combine's, the balloon's burner) with where each is, how it moves and how loud it is (0 silent, 1
// at its full voice), and the crows' caws and the dog's barks are shots, drained by the audio as it plays them.

export interface LifeSource {
  x: number;
  y: number;
  z: number;
  /** Velocity (m/s), for the Doppler shift and the engine's labouring in a climb. */
  vx: number;
  vy: number;
  vz: number;
  level: number;
}

export interface LifeShot {
  kind: 'caw' | 'bark';
  x: number;
  y: number;
  z: number;
}

/** Shots waiting beyond this many are dropped (nobody is listening). */
export const MAX_SHOTS = 8;

export interface LifeSounds {
  plane: LifeSource;
  combine: LifeSource;
  burner: LifeSource;
  shots: LifeShot[];
}

const source = (): LifeSource => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, level: 0 });

export const newLifeSounds = (): LifeSounds => ({ plane: source(), combine: source(), burner: source(), shots: [] });

/** The one sheet there is: the game has one countryside and one pair of ears. */
export const lifeSounds: LifeSounds = newLifeSounds();

/** Queues a shot for the audio to play. */
export function shoot(s: LifeSounds, kind: LifeShot['kind'], x: number, y: number, z: number): void {
  if (s.shots.length < MAX_SHOTS) s.shots.push({ kind, x, y, z });
}
