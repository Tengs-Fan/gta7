// Street furniture and landmarks as instanced meshes, with night lighting,
// live traffic signal bulbs and breakable props.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import { axisOf, type Dir } from '../world/roads';
import type { Prop, PropKind } from '../world/layout';
import type { StaticWorld } from '../world/staticWorld';
import { adTexture, AD_COUNT, glowTexture, groundTexture } from './textures';

interface InstanceRef {
  mesh: THREE.InstancedMesh;
  index: number;
  base: THREE.Matrix4;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of prepared) {
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((g.getAttribute('position').count) * 2), 2));
  }
  const m = mergeGeometries(prepared, false);
  if (!m) throw new Error('mergeGeometries failed');
  return m;
}

function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function cyl(rt: number, rb: number, h: number, seg: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  g.translate(x, y + h / 2, z);
  return g;
}

export class PropsView {
  readonly group = new THREE.Group();
  private readonly refs = new Map<number, InstanceRef[]>();
  private readonly bulbMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
  private readonly poolMat: THREE.MeshBasicMaterial;
  private signalBulbs: THREE.InstancedMesh | null = null;
  private signalProps: Prop[] = [];
  private signalPropIndex: number[] = [];
  private readonly brokenSignals = new Set<number>();
  private ferris: { wheel: THREE.Group; gondolas: THREE.InstancedMesh; lights: THREE.InstancedMesh; x: number; y: number; z: number; rot: number } | null = null;
  private lighthouseBeam: THREE.Mesh | null = null;
  private antennaLights: THREE.InstancedMesh | null = null;
  private readonly antennaMat = new THREE.MeshBasicMaterial({ color: 0x220000 });
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpC = new THREE.Color();

  constructor(private readonly world: StaticWorld) {
    this.group.name = 'props';
    this.poolMat = new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0xffc27a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const byKind = new Map<PropKind, number[]>();
    world.layout.props.forEach((p, i) => {
      let l = byKind.get(p.kind);
      if (!l) {
        l = [];
        byKind.set(p.kind, l);
      }
      l.push(i);
    });
    const get = (k: PropKind) => byKind.get(k) ?? [];

    this.buildTrees(get('tree'), get('bush'));
    this.buildPalms(get('palm'));
    this.buildLamps(get('lamp'));
    this.buildSignals(get('signal'));
    this.buildSimple(get('hydrant'), merged([cyl(0.17, 0.2, 0.62, 8), new THREE.SphereGeometry(0.16, 8, 6).translate(0, 0.65, 0), cyl(0.06, 0.06, 0.3, 6, 0, 0.32, 0).rotateZ(Math.PI / 2).translate(0.3, 0.1, 0)]), new THREE.MeshStandardMaterial({ color: 0xc0281c, roughness: 0.5 }));
    this.buildSimple(get('bench'), merged([box(1.8, 0.08, 0.45, 0, 0.45, 0), box(1.8, 0.4, 0.06, 0, 0.75, -0.2), box(0.08, 0.45, 0.4, -0.8, 0.22, 0), box(0.08, 0.45, 0.4, 0.8, 0.22, 0)]), new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.85 }));
    this.buildSimple(get('bin'), cyl(0.3, 0.26, 1.0, 10), new THREE.MeshStandardMaterial({ color: 0x1e4d2b, roughness: 0.7, metalness: 0.2 }));
    this.buildContainers(get('container'));
    for (const i of get('fountain')) this.buildFountain(world.layout.props[i]!);
    for (const i of get('crane')) this.buildCrane(world.layout.props[i]!);
    for (const i of get('lighthouse')) this.buildLighthouse(world.layout.props[i]!);
    for (const i of get('ferris')) this.buildFerris(world.layout.props[i]!);
    for (const i of get('boat')) this.buildBoat(world.layout.props[i]!);
    get('billboard').forEach((i, k) => this.buildBillboard(world.layout.props[i]!, k));
    this.buildRoofProps();
  }

  private makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, props: number[], matrixFor: (p: Prop, m: THREE.Matrix4) => void, opts: { shadow?: boolean; color?: (p: Prop, c: THREE.Color) => void; track?: boolean } = {}): THREE.InstancedMesh | null {
    if (props.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, props.length);
    mesh.castShadow = opts.shadow ?? true;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    props.forEach((pi, k) => {
      const p = this.world.layout.props[pi]!;
      matrixFor(p, m);
      mesh.setMatrixAt(k, m);
      if (opts.color) {
        opts.color(p, c);
        mesh.setColorAt(k, c);
      }
      if (opts.track ?? true) {
        let l = this.refs.get(pi);
        if (!l) {
          l = [];
          this.refs.set(pi, l);
        }
        l.push({ mesh, index: k, base: m.clone() });
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    return mesh;
  }

  private static standard(p: Prop, m: THREE.Matrix4): void {
    m.compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot), new THREE.Vector3(p.scale, p.scale, p.scale));
  }

  private buildSimple(props: number[], geo: THREE.BufferGeometry, mat: THREE.Material): void {
    this.makeInstanced(geo, mat, props, PropsView.standard);
  }

  private buildTrees(trees: number[], bushes: number[]): void {
    const rng = new Rng(77);
    const trunk = cyl(0.16, 0.26, 3.2, 6);
    const foliage = merged([
      new THREE.IcosahedronGeometry(1.7, 0).scale(1, 1.1, 1).translate(0, 4.3, 0),
      new THREE.IcosahedronGeometry(1.25, 0).translate(0.7, 5.3, 0.3),
      new THREE.IcosahedronGeometry(1.1, 0).translate(-0.6, 5.0, -0.5),
    ]);
    this.makeInstanced(trunk, new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 0.95 }), trees, PropsView.standard);
    this.makeInstanced(foliage, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), trees, PropsView.standard, {
      color: (_p, c) => c.setHSL(0.26 + rng.range(-0.04, 0.05), rng.range(0.45, 0.65), rng.range(0.24, 0.36)),
    });
    const bush = new THREE.IcosahedronGeometry(0.85, 0).scale(1.2, 0.75, 1.1).translate(0, 0.55, 0);
    this.makeInstanced(bush, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), bushes, PropsView.standard, {
      color: (_p, c) => c.setHSL(0.27 + rng.range(-0.03, 0.04), 0.5, rng.range(0.22, 0.32)),
      shadow: false,
    });
  }

  private buildPalms(palms: number[]): void {
    const rng = new Rng(78);
    const trunk = merged([cyl(0.14, 0.24, 8.5, 7), cyl(0.3, 0.3, 0.5, 7, 0, 8.3, 0)]);
    const fronds: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 8; i++) {
      const f = new THREE.BoxGeometry(0.5, 0.05, 3.4);
      f.translate(0, 0, 1.7);
      f.rotateX(0.45 + (i % 2) * 0.25);
      f.rotateY((i / 8) * Math.PI * 2);
      f.translate(0, 8.7, 0);
      fronds.push(f);
    }
    this.makeInstanced(trunk, new THREE.MeshStandardMaterial({ color: 0x8b6b4a, roughness: 0.95 }), palms, PropsView.standard);
    this.makeInstanced(merged(fronds), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide }), palms, PropsView.standard, {
      color: (_p, c) => c.setHSL(0.28 + rng.range(-0.03, 0.03), 0.55, rng.range(0.26, 0.34)),
    });
  }

  private buildLamps(lamps: number[]): void {
    const pole = merged([cyl(0.07, 0.11, 6.5, 6), box(0.08, 0.08, 1.7, 0, 6.45, 0.8), box(0.42, 0.14, 0.6, 0, 6.38, 1.55)]);
    this.makeInstanced(pole, new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.5, metalness: 0.6 }), lamps, PropsView.standard);
    const bulbGeo = box(0.32, 0.04, 0.46, 0, 6.29, 1.55);
    this.makeInstanced(bulbGeo, this.bulbMat, lamps, PropsView.standard, { shadow: false });
    const pool = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.makeInstanced(pool, this.poolMat, lamps, (p, m) => {
      const fx = Math.sin(p.rot);
      const fz = Math.cos(p.rot);
      m.compose(new THREE.Vector3(p.x + fx * 1.6, p.y + 0.04, p.z + fz * 1.6), new THREE.Quaternion(), new THREE.Vector3(13, 1, 13));
    }, { shadow: false });
  }

  private buildSignals(signals: number[]): void {
    const L = this.world.layout;
    const pole = merged([cyl(0.09, 0.11, 5.2, 6), box(0.36, 1.05, 0.28, 0, 4.55, 0.05), box(0.42, 0.06, 0.36, 0, 5.1, 0.05)]);
    this.makeInstanced(pole, new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.6, metalness: 0.4 }), signals, PropsView.standard);
    this.signalProps = signals.map((i) => L.props[i]!);
    this.signalPropIndex = signals;
    // Three bulbs per signal.
    // Low-poly bulbs: there are three per signal head, citywide.
    const bulb = new THREE.IcosahedronGeometry(0.11, 0);
    const mesh = new THREE.InstancedMesh(bulb, new THREE.MeshBasicMaterial({ color: 0xffffff }), signals.length * 3);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    signals.forEach((pi, k) => {
      const p = L.props[pi]!;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot);
      for (let b = 0; b < 3; b++) {
        v.set(0, 4.88 - b * 0.33, 0.21).applyQuaternion(q);
        m.makeTranslation(p.x + v.x, p.y + v.y, p.z + v.z);
        mesh.setMatrixAt(k * 3 + b, m);
        mesh.setColorAt(k * 3 + b, new THREE.Color(0x111111));
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.signalBulbs = mesh;
  }

  private buildContainers(list: number[]): void {
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ map: groundTexture('metal', 9), roughness: 0.7, metalness: 0.3 });
    this.makeInstanced(geo, mat, list, (p, m) => m.compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion(), new THREE.Vector3(p.w, p.h, p.d)), { color: (p, c) => c.setHex(p.color) });
  }

  private buildFountain(p: Prop): void {
    const g = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: 0xc8c2b4, roughness: 0.9 });
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.4, 0.7, 24, 1, true), stone);
    ring.position.y = 0.35;
    const water = new THREE.Mesh(new THREE.CircleGeometry(3.25, 24).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3f8fb8, roughness: 0.1, metalness: 0.1 }));
    water.position.y = 0.5;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 2.2, 10), stone);
    col.position.y = 1.1;
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 0.4, 0.4, 14), stone);
    bowl.position.y = 2.2;
    g.add(ring, water, col, bowl);
    g.position.set(p.x, p.y, p.z);
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.group.add(g);
  }

  private buildCrane(p: Prop): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0xe0a21a, roughness: 0.6, metalness: 0.3 });
    const parts: THREE.BufferGeometry[] = [];
    for (const [lx, lz] of [[-6, -5], [6, -5], [-6, 5], [6, 5]] as const) parts.push(box(1.0, 30, 1.0, lx, 15, lz));
    parts.push(box(13.2, 1.6, 1.4, 0, 29, -5), box(13.2, 1.6, 1.4, 0, 29, 5), box(1.4, 1.6, 11.4, -6, 29, 0), box(1.4, 1.6, 11.4, 6, 29, 0));
    parts.push(box(2.2, 2.0, 46, 0, 31.6, 12), box(3, 3, 3, 0, 27.5, 3.5));
    const mesh = new THREE.Mesh(merged(parts), mat);
    mesh.position.set(p.x, 0, p.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private buildLighthouse(p: Prop): void {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#f2f2f2' : '#c0302a';
      ctx.fillRect(0, i * 16, 16, 16);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 3.4, 24, 18), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
    tower.position.set(p.x, p.y + 12, p.z);
    tower.castShadow = true;
    const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 2.4, 12), new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffe9a0, emissiveIntensity: 0.5, roughness: 0.2 }));
    lantern.position.set(p.x, p.y + 25.2, p.z);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(2.1, 2.2, 12), new THREE.MeshStandardMaterial({ color: 0x8f1f1a, roughness: 0.5 }));
    cap.position.set(p.x, p.y + 27.5, p.z);
    const beamGeo = new THREE.ConeGeometry(5, 90, 16, 1, true);
    beamGeo.translate(0, -45, 0);
    beamGeo.rotateZ(Math.PI / 2);
    const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xfff4c8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.set(p.x, p.y + 25.2, p.z);
    this.lighthouseBeam = beam;
    this.group.add(tower, lantern, cap, beam);
  }

  private buildFerris(p: Prop): void {
    const R = 22;
    const hubY = p.y + R + 4;
    const steel = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4, metalness: 0.5 });
    const wheel = new THREE.Group();
    const rimParts: THREE.BufferGeometry[] = [];
    for (const z of [-1.6, 1.6]) {
      rimParts.push(new THREE.TorusGeometry(R, 0.3, 6, 64).translate(0, 0, z));
      rimParts.push(new THREE.TorusGeometry(R * 0.35, 0.2, 6, 24).translate(0, 0, z));
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const s = new THREE.BoxGeometry(0.14, R, 0.14).translate(0, R / 2, z);
        s.rotateZ(a);
        rimParts.push(s);
      }
    }
    rimParts.push(new THREE.CylinderGeometry(0.9, 0.9, 4.2, 12).rotateX(Math.PI / 2));
    const rim = new THREE.Mesh(merged(rimParts), steel);
    rim.castShadow = true;
    wheel.add(rim);
    const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }), 64);
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      this.tmpM.makeTranslation(Math.cos(a) * R, Math.sin(a) * R, i % 2 === 0 ? 1.7 : -1.7);
      lights.setMatrixAt(i, this.tmpM);
      lights.setColorAt(i, new THREE.Color(0x222222));
    }
    wheel.add(lights);
    wheel.position.set(p.x, hubY, p.z);
    wheel.rotation.y = p.rot;
    this.group.add(wheel);
    const gondolas = new THREE.InstancedMesh(merged([box(2.2, 2.0, 2.4, 0, -1.6, 0), box(0.1, 0.8, 0.1, 0, -0.3, 0)]), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }), 16);
    for (let i = 0; i < 16; i++) gondolas.setColorAt(i, new THREE.Color().setHSL(i / 16, 0.7, 0.55));
    gondolas.castShadow = true;
    this.group.add(gondolas);
    // A-frame supports.
    const legs: THREE.BufferGeometry[] = [];
    for (const z of [-3.2, 3.2]) {
      for (const sx of [-1, 1]) {
        const len = Math.hypot(R * 0.55, R + 4);
        const g = new THREE.BoxGeometry(0.6, len, 0.6).translate(0, len / 2, 0);
        g.rotateZ(sx * Math.atan2(R * 0.55, R + 4));
        g.translate(-sx * R * 0.55, 0, z);
        legs.push(g);
      }
    }
    const legMesh = new THREE.Mesh(merged(legs), steel);
    legMesh.position.set(p.x, p.y, p.z);
    legMesh.rotation.y = p.rot;
    legMesh.castShadow = true;
    this.group.add(legMesh);
    this.ferris = { wheel, gondolas, lights, x: p.x, y: hubY, z: p.z, rot: p.rot };
  }

  private buildBoat(p: Prop): void {
    const shape = new THREE.Shape();
    shape.moveTo(-5, 0.6);
    shape.lineTo(4, 0.6);
    shape.quadraticCurveTo(6.5, 0.6, 7, 1.8);
    shape.lineTo(-5, 1.8);
    shape.lineTo(-5, 0.6);
    const hull = new THREE.ExtrudeGeometry(shape, { depth: 2.6, bevelEnabled: false });
    hull.translate(0, -0.6, -1.3);
    const g = new THREE.Group();
    const hullMesh = new THREE.Mesh(hull, new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.4 }));
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.4, 2.0), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 }));
    cabin.position.set(-0.5, 1.8, 0);
    g.add(hullMesh, cabin);
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = p.rot + Math.PI / 2;
    this.group.add(g);
  }

  private buildBillboard(p: Prop, k: number): void {
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.6, metalness: 0.5 });
    const legs = new THREE.Mesh(merged([cyl(0.25, 0.3, 9, 8, -4.5, 0, 0), cyl(0.25, 0.3, 9, 8, 4.5, 0, 0), box(11, 0.3, 0.3, 0, 4.6, 0)]), metal);
    const tex = adTexture(k % AD_COUNT);
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.15, roughness: 0.6 });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(12, 6, 0.3), [metal, metal, metal, metal, mat, mat]);
    panel.position.y = 8.2;
    legs.castShadow = true;
    panel.castShadow = true;
    g.add(legs, panel);
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = p.rot;
    this.group.add(g);
    this.adMaterials.push(mat);
  }

  private readonly adMaterials: THREE.MeshStandardMaterial[] = [];

  private buildRoofProps(): void {
    const all = this.world.layout.buildings.flatMap((b) => b.roofProps);
    const ac = all.filter((r) => r.kind === 'ac');
    const tanks = all.filter((r) => r.kind === 'tank');
    const antennas = all.filter((r) => r.kind === 'antenna');
    const boards = all.filter((r) => r.kind === 'billboard');
    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, list: typeof all, scaleY = true) => {
      if (list.length === 0) return null;
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((r, i) => {
        this.tmpM.compose(new THREE.Vector3(r.x, r.y, r.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.rot), new THREE.Vector3(r.w, scaleY ? r.h : 1, r.d));
        mesh.setMatrixAt(i, this.tmpM);
      });
      mesh.castShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      return mesh;
    };
    inst(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ map: groundTexture('metal', 4), color: 0xb0b4b8, roughness: 0.6, metalness: 0.3 }), ac);
    inst(merged([cyl(0.5, 0.5, 0.8, 10), new THREE.ConeGeometry(0.55, 0.25, 10).translate(0, 0.92, 0), cyl(0.04, 0.04, 0.2, 4, 0.4, -0.2, 0)]), new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 }), tanks);
    inst(box(1, 1, 1, 0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.5, metalness: 0.6 }), antennas);
    if (antennas.length > 0) {
      const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 8, 6), this.antennaMat, antennas.length);
      antennas.forEach((r, i) => {
        this.tmpM.makeTranslation(r.x, r.y + r.h + 0.2, r.z);
        lights.setMatrixAt(i, this.tmpM);
      });
      lights.instanceMatrix.needsUpdate = true;
      lights.computeBoundingSphere();
      this.group.add(lights);
      this.antennaLights = lights;
    }
    boards.forEach((r, k) => {
      const tex = adTexture((k + 2) % AD_COUNT);
      const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.15, roughness: 0.6 });
      const frame = new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.6, metalness: 0.4 });
      const panel = new THREE.Mesh(new THREE.BoxGeometry(r.w, r.h, 0.3), [frame, frame, frame, frame, mat, mat]);
      panel.position.set(r.x, r.y + 1.6 + r.h / 2, r.z);
      panel.rotation.y = r.rot;
      panel.castShadow = true;
      const legs = new THREE.Mesh(merged([box(0.2, 1.7, 0.2, -r.w / 3, 0.85, 0), box(0.2, 1.7, 0.2, r.w / 3, 0.85, 0)]), frame);
      legs.position.set(r.x, r.y, r.z);
      legs.rotation.y = r.rot;
      this.group.add(panel, legs);
      this.adMaterials.push(mat);
    });
  }

  /** Knocks over a breakable prop in the given direction. */
  breakProp(index: number, dirX: number, dirZ: number): void {
    const refs = this.refs.get(index);
    if (!refs) return;
    const p = this.world.layout.props[index]!;
    const l = Math.hypot(dirX, dirZ) || 1;
    const axis = new THREE.Vector3(dirZ / l, 0, -dirX / l);
    const fall = new THREE.Matrix4().makeRotationAxis(axis, Math.PI / 2 - 0.08);
    const toOrigin = new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z);
    const back = new THREE.Matrix4().makeTranslation(p.x, p.y + (p.kind === 'lamp' || p.kind === 'signal' ? 0.15 : 0.2), p.z);
    const hide = p.kind === 'hydrant';
    for (const r of refs) {
      let m: THREE.Matrix4;
      if (hide || r.mesh.material === this.poolMat || r.mesh.material === this.bulbMat) m = new THREE.Matrix4().makeScale(0, 0, 0);
      else m = back.clone().multiply(fall).multiply(toOrigin).multiply(r.base);
      r.mesh.setMatrixAt(r.index, m);
      r.mesh.instanceMatrix.needsUpdate = true;
    }
    if (p.kind === 'signal') this.brokenSignals.add(index);
  }

  /** Puts every knocked-over prop back in place (new game). */
  restoreAll(): void {
    for (const refs of this.refs.values()) {
      for (const r of refs) {
        r.mesh.setMatrixAt(r.index, r.base);
        r.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.brokenSignals.clear();
  }

  update(time: number, night: number): void {
    // Lamps.
    const k = night;
    this.bulbMat.color.setRGB(0.25 + k * 7.5, 0.24 + k * 6, 0.22 + k * 3.8);
    this.poolMat.opacity = k * 0.42;
    for (const m of this.adMaterials) m.emissiveIntensity = 0.12 + k * 1.1;
    // Signals.
    const bulbs = this.signalBulbs;
    if (bulbs) {
      const roads = this.world.roads;
      const off = 0.07;
      this.signalProps.forEach((p, i) => {
        const broken = this.brokenSignals.has(this.signalPropIndex[i]!);
        const st = broken ? 'off' : roads.signalState(p.node, axisOf(p.dir as Dir), time);
        bulbs.setColorAt(i * 3, this.tmpC.setRGB(st === 'red' ? 6 : off + 0.05, st === 'red' ? 0.25 : off, off));
        bulbs.setColorAt(i * 3 + 1, this.tmpC.setRGB(st === 'yellow' ? 6 : off + 0.05, st === 'yellow' ? 3.6 : off, off));
        bulbs.setColorAt(i * 3 + 2, this.tmpC.setRGB(off, st === 'green' ? 5.5 : off + 0.05, st === 'green' ? 2.4 : off));
      });
      if (bulbs.instanceColor) bulbs.instanceColor.needsUpdate = true;
    }
    // Ferris wheel.
    const f = this.ferris;
    if (f) {
      const ang = time * 0.06;
      f.wheel.rotation.z = ang;
      const R = 22;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.rot);
      for (let i = 0; i < 16; i++) {
        const a = ang + (i / 16) * Math.PI * 2;
        const local = new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0).applyQuaternion(q);
        this.tmpM.compose(new THREE.Vector3(f.x + local.x, f.y + local.y, f.z + local.z), q, new THREE.Vector3(1, 1, 1));
        f.gondolas.setMatrixAt(i, this.tmpM);
      }
      f.gondolas.instanceMatrix.needsUpdate = true;
      f.gondolas.computeBoundingSphere();
      for (let i = 0; i < 64; i++) {
        const lit = night > 0.2;
        const hue = (i / 64 + time * 0.05) % 1;
        if (lit) this.tmpC.setHSL(hue, 1, 0.6).multiplyScalar(5);
        else this.tmpC.setRGB(0.15, 0.15, 0.15);
        f.lights.setColorAt(i, this.tmpC);
      }
      if (f.lights.instanceColor) f.lights.instanceColor.needsUpdate = true;
    }
    if (this.lighthouseBeam) {
      this.lighthouseBeam.rotation.y = time * 0.9;
      (this.lighthouseBeam.material as THREE.MeshBasicMaterial).opacity = night * 0.16;
      this.lighthouseBeam.visible = night > 0.05;
    }
    if (this.antennaLights) {
      const on = night > 0.3 && Math.floor(time * 1.2) % 2 === 0;
      this.antennaMat.color.setRGB(on ? 7 : 0.25, on ? 0.3 : 0.02, on ? 0.15 : 0.02);
    }
  }
}
