// Loads src/assets from disk in Node (Vitest), through the same GLTFLoader + meshopt path the browser uses.
// Standalone textures and the images inside GLBs become 1x1 placeholders: Node cannot decode WebP, and no test
// reads pixels. Import this only from tests and tooling.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import type { AssetBackend, DecodedAsset } from './backend';
import { assets, type AssetLibrary, type PreloadReport } from './AssetLibrary';
import { createGltfLoader, parseGlb } from './gltf';
import { parseManifest, type ManifestEntry } from './types';

export const ASSETS_DIR = resolve(process.cwd(), 'src/assets');

function placeholder(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

/** Runs `fn` with the browser pieces GLTFLoader probes for WebP support and image decoding replaced. */
async function withNodeImages<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as { Image?: unknown; self?: unknown };
  const had = g.Image;
  const hadSelf = g.self;
  g.self = globalThis;
  g.Image = class {
    height = 1;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  };
  try {
    return await fn();
  } finally {
    if (had === undefined) delete g.Image;
    else g.Image = had;
    if (hadSelf === undefined) delete g.self;
    else g.self = hadSelf;
  }
}

async function parseModel(data: ArrayBuffer) {
  const loader = createGltfLoader();
  loader.register((parser) => ({
    name: 'GTA7_NodeTextures',
    beforeRoot() {
      (parser as unknown as { textureLoader: unknown }).textureLoader = { load: (_url: string, onLoad: (t: THREE.Texture) => void) => onLoad(placeholder()), setRequestHeader() {} };
      return null;
    },
  }));
  return withNodeImages(() => parseGlb(loader, data));
}

export function diskBackend(dir: string = ASSETS_DIR): AssetBackend {
  return {
    async manifest() {
      return parseManifest(JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8')));
    },
    async fetch(entry: ManifestEntry, onBytes: (n: number) => void) {
      const buf = await readFile(resolve(dir, entry.file));
      onBytes(buf.byteLength);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
    async decode(entry: ManifestEntry, data: ArrayBuffer): Promise<DecodedAsset> {
      if (entry.kind === 'texture') return { type: 'texture', texture: placeholder() };
      if (entry.kind === 'env') {
        const tex = new HDRLoader().createDataTexture(data);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        return { type: 'texture', texture: tex };
      }
      const gltf = await parseModel(data);
      gltf.scene.name = entry.id;
      return { type: 'model', scene: gltf.scene, animations: gltf.animations };
    },
  };
}

/** Loads (a subset of) the committed assets into `library`, the game's by default. */
export function loadAssetsFromDisk(opts: { library?: AssetLibrary; filter?: (e: ManifestEntry) => boolean; dir?: string } = {}): Promise<PreloadReport> {
  return (opts.library ?? assets).preload(undefined, { backend: diskBackend(opts.dir), filter: opts.filter });
}

/** Empties the game's library again so later tests see the default Node state (no assets). */
export function unloadAssets(): void {
  assets.clear();
}
