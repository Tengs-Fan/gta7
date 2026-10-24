// The browser backend: fetches the manifest and the files Vite hashed into dist/assets (relative URLs, so the game works
// from any base path such as GitHub Pages /gta7/), decodes GLBs with GLTFLoader + meshopt, WebP with createImageBitmap
// and the sky with HDRLoader.
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import manifestUrl from '../../assets/manifest.json?url';
import type { AssetBackend, DecodedAsset } from './backend';
import { createGltfLoader, parseGlb } from './gltf';
import { parseManifest, type ManifestEntry } from './types';

// import.meta.glob keys are relative to this file; values are the content-hashed URLs.
const URLS = import.meta.glob('../../assets/**/*.{glb,webp,hdr}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

function urlOf(entry: ManifestEntry): string {
  const url = URLS[`../../assets/${entry.file}`];
  if (!url) throw new Error(`${entry.file} is not part of this build`);
  return url;
}

async function readBody(res: Response, onBytes: (loaded: number) => void): Promise<ArrayBuffer> {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onBytes(buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onBytes(loaded);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

async function decodeTexture(entry: ManifestEntry, data: ArrayBuffer): Promise<THREE.Texture> {
  const bitmap = await createImageBitmap(new Blob([data], { type: 'image/webp' }), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  // The bitmap is kept (never closed) so three can upload it again after a lost WebGL context.
  const tex = new THREE.Texture(bitmap);
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = entry.map === 'albedo' || entry.map === 'emissive' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.name = entry.id;
  tex.needsUpdate = true;
  return tex;
}

export const browserBackend: AssetBackend = {
  async manifest(signal) {
    const res = await fetch(manifestUrl, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseManifest(await res.json());
  },

  async fetch(entry, onBytes, signal) {
    const res = await fetch(urlOf(entry), { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return readBody(res, onBytes);
  },

  async decode(entry, data): Promise<DecodedAsset> {
    if (entry.kind === 'texture') return { type: 'texture', texture: await decodeTexture(entry, data) };
    if (entry.kind === 'env') {
      const tex = new HDRLoader().createDataTexture(data);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.name = entry.id;
      return { type: 'texture', texture: tex };
    }
    const gltf = await parseGlb(createGltfLoader(), data);
    gltf.scene.name = entry.id;
    return { type: 'model', scene: gltf.scene, animations: gltf.animations };
  },
};
