// Shapes shared by the asset manifest (src/assets/manifest.json, written by scripts/assets/build.mjs) and the library.

export type AssetKind = 'character' | 'animation' | 'vehicle' | 'boat' | 'prop' | 'texture' | 'env';

/** Model bounds in metres after the build's normalisation (+Y up, +Z forward). */
export interface ModelBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** Textures and the HDRI have pixel dimensions instead. */
export interface ImageBounds {
  width: number;
  height: number;
}

export interface ManifestEntry {
  id: string;
  /** Path below src/assets, with forward slashes. */
  file: string;
  kind: AssetKind;
  bytes: number;
  bounds: ModelBounds | ImageBounds;
  /** Id of a source in scripts/assets/sources.json, which is also a row of LICENSES-ASSETS.md. */
  license: string;
  triangles?: number;
  /** Characters: police, gang or civilian, and the body type. */
  role?: string;
  body?: string;
  /** Characters: joint name (see CHARACTER_JOINTS) -> bone name as three.js sees it. */
  bones?: Record<string, string>;
  /** Characters: id of the animation entry holding their clips. Animations: the clip names. */
  clips?: string | string[];
  /** Vehicles and boats: the VEHICLE_SPECS kind the model is meant for, and its bounds divided by that spec's footprint. */
  spec?: string | null;
  fit?: [number, number, number];
  scale?: number;
  /** Vehicles: node names of the wheels (fl, fr, rl, rr, or rear for one mesh on the rear axle) and the wheel centres. */
  wheelNodes?: Record<string, string>;
  sockets?: Record<string, [number, number, number]>;
  wheelRadius?: number;
  /** Textures: PBR set and map (albedo, normal, orm, emissive). */
  set?: string;
  map?: string;
}

export interface Manifest {
  version: number;
  entries: ManifestEntry[];
}

/** The joints every character's bone map must cover; they follow SKELETON in sim/pose.ts. */
export const CHARACTER_JOINTS = [
  'pelvis', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'clavicleL', 'shoulderL', 'elbowL', 'wristL', 'clavicleR', 'shoulderR', 'elbowR', 'wristR',
  'hipL', 'kneeL', 'ankleL', 'toeL', 'hipR', 'kneeR', 'ankleR', 'toeR',
] as const;

export const WHEEL_SOCKETS = ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'] as const;

const KINDS: readonly string[] = ['character', 'animation', 'vehicle', 'boat', 'prop', 'texture', 'env'];

/** Throws on a manifest that is not shaped as the build writes it. */
export function parseManifest(json: unknown): Manifest {
  const m = json as Partial<Manifest> | null;
  if (!m || typeof m !== 'object' || !Array.isArray(m.entries)) throw new Error('asset manifest has no entries');
  const seen = new Set<string>();
  for (const e of m.entries) {
    if (!e || typeof e.id !== 'string' || typeof e.file !== 'string' || !KINDS.includes(e.kind) || typeof e.bytes !== 'number') {
      throw new Error(`bad asset manifest entry ${JSON.stringify(e)?.slice(0, 80)}`);
    }
    if (seen.has(e.id)) throw new Error(`duplicate asset id ${e.id}`);
    seen.add(e.id);
  }
  return { version: typeof m.version === 'number' ? m.version : 1, entries: m.entries };
}
