// GLB decoding shared by the browser and Node backends.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export function createGltfLoader(): GLTFLoader {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}

export function parseGlb(loader: GLTFLoader, data: ArrayBuffer): Promise<GLTF> {
  return new Promise((resolve, reject) => loader.parse(data, '', resolve, reject));
}

/** Every distinct material under `root`. */
export function materialsOf(root: THREE.Object3D): THREE.Material[] {
  const out = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(m)) m.forEach((x) => out.add(x));
    else if (m) out.add(m);
  });
  return [...out];
}
