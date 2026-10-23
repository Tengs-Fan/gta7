import * as THREE from 'three';

/**
 * Software rasterisers benefit far more from simple surface lighting than from a blurry canvas.
 * Keep the art (textures, colours, window occupancy, foliage dissolve, emissive car lamps), while
 * replacing per-pixel physical BRDF / normal / roughness sampling with vertex-lit diffuse light.
 * Sources remain authoritative because the simulation-facing views animate those materials.
 */
export class SoftwareMaterials {
  private readonly replacements = new Map<THREE.MeshStandardMaterial, THREE.MeshLambertMaterial>();
  private readonly fillColor = new THREE.Color();
  private readonly light = {
    uSoftSun: { value: new THREE.Vector3() }, uSoftUp: { value: new THREE.Vector3() },
    uSoftSunColor: { value: new THREE.Color() }, uSoftSky: { value: new THREE.Color() },
    uSoftGround: { value: new THREE.Color() },
  };

  lighting(sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight, fill: THREE.HemisphereLight | null, camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.light.uSoftSun.value.subVectors(sun.position, sun.target.position).transformDirection(camera.matrixWorldInverse);
    this.light.uSoftUp.value.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
    this.light.uSoftSunColor.value.copy(sun.color).multiplyScalar(sun.intensity / Math.PI);
    this.light.uSoftSky.value.copy(hemi.color).multiplyScalar(hemi.intensity / Math.PI);
    this.light.uSoftGround.value.copy(hemi.groundColor).multiplyScalar(hemi.intensity / Math.PI);
    if (fill) {
      this.light.uSoftSky.value.add(this.fillColor.copy(fill.color).multiplyScalar(fill.intensity / Math.PI));
      this.light.uSoftGround.value.add(this.fillColor.copy(fill.groundColor).multiplyScalar(fill.intensity / Math.PI));
    }
  }

  private material(source: THREE.Material): THREE.Material {
    if (!(source instanceof THREE.MeshStandardMaterial)) return source;
    let material = this.replacements.get(source);
    if (!material) {
      material = new THREE.MeshLambertMaterial({
        map: source.map, emissiveMap: source.emissiveMap, alphaMap: source.alphaMap,
        color: source.color, emissive: source.emissive, emissiveIntensity: source.emissiveIntensity,
        vertexColors: source.vertexColors, side: source.side, shadowSide: source.shadowSide,
        transparent: source.transparent, opacity: source.opacity, alphaTest: source.alphaTest,
        depthTest: source.depthTest, depthWrite: source.depthWrite, blending: source.blending,
        polygonOffset: source.polygonOffset, polygonOffsetFactor: source.polygonOffsetFactor,
        polygonOffsetUnits: source.polygonOffsetUnits, flatShading: source.flatShading,
        fog: source.fog, toneMapped: source.toneMapped,
      });
      material.name = `${source.name || 'surface'}-software`;
      // Some views keep a source reference, others mutate mesh.material directly. Sharing colour
      // objects makes both routes update the same surface (weapons change colour when equipped).
      material.color = source.color;
      material.emissive = source.emissive;
      material.onBeforeCompile = (shader, renderer) => {
        // Current three Lambert still evaluates normals/lights per fragment. Move the diffuse
        // work into the vertices: flat city faces keep exactly the same directional shading.
        Object.assign(shader.uniforms, this.light);
        shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
          varying vec3 vSoftLight;
          uniform vec3 uSoftSun, uSoftUp, uSoftSunColor, uSoftSky, uSoftGround;`)
          .replace('#include <normal_vertex>', `#include <normal_vertex>
            vec3 softN = normalize(transformedNormal);
            float softSun = dot(softN, uSoftSun);
            #ifdef DOUBLE_SIDED
              softSun = abs(softSun);
            #endif
            vSoftLight = mix(uSoftGround, uSoftSky, dot(softN, uSoftUp) * 0.5 + 0.5)
              + uSoftSunColor * max(softSun, 0.0);`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vSoftLight;')
          .replace('#include <normal_fragment_begin>', '')
          .replace('#include <normal_fragment_maps>', '')
          .replace('#include <lights_lambert_fragment>', '')
          .replace('#include <lights_fragment_begin>', 'reflectedLight.directDiffuse = diffuseColor.rgb * vSoftLight;')
          .replace('#include <lights_fragment_maps>', '')
          .replace('#include <lights_fragment_end>', '');
        source.onBeforeCompile(shader, renderer);
      };
      material.customProgramCacheKey = () => `software-vertex:${source.customProgramCacheKey()}`;
      this.replacements.set(source, material);
    }
    return material;
  }

  /** Safe to repeat: vehicle damage swaps original material references during sync. */
  apply(root: THREE.Object3D): void {
    root.traverse((o) => {
      // Vehicle parts are drawn by the part batches, whose own meshes get software materials.
      if (!(o instanceof THREE.Mesh) || o.userData.batched) return;
      o.material = Array.isArray(o.material) ? o.material.map((m) => this.material(m)) : this.material(o.material);
      if (Array.isArray(o.material) && o.material.every((m) => m === o.material[0])) o.material = o.material[0]!;
    });
  }

  sync(): void {
    for (const [source, material] of this.replacements) {
      material.color.copy(source.color);
      material.emissive.copy(source.emissive);
      material.emissiveIntensity = source.emissiveIntensity;
      material.opacity = source.opacity;
      material.visible = source.visible;
    }
  }

  dispose(): void {
    for (const material of this.replacements.values()) material.dispose();
    this.replacements.clear();
  }
}
