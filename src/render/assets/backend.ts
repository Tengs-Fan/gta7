import type * as THREE from 'three';
import type { Manifest, ManifestEntry } from './types';

export type DecodedAsset =
  | { type: 'model'; scene: THREE.Group; animations: THREE.AnimationClip[] }
  | { type: 'texture'; texture: THREE.Texture };

/**
 * Where the library gets its bytes and how it decodes them. The browser backend fetches hashed URLs; the Node backend
 * (testing.ts) reads src/assets from disk; tests can supply their own, for example one that stalls.
 */
export interface AssetBackend {
  manifest(signal: AbortSignal): Promise<Manifest>;
  /** `onBytes` reports the bytes received so far. */
  fetch(entry: ManifestEntry, onBytes: (loaded: number) => void, signal: AbortSignal): Promise<ArrayBuffer>;
  decode(entry: ManifestEntry, data: ArrayBuffer): Promise<DecodedAsset>;
}
