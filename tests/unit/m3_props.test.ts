// Mission 3, track F: props and foliage. Modelled street furniture fitted to the old models, leaf-card canopies with
// branches and wind, curved ringed palms that still dissolve for the camera, beach and yard dressing, furnished garages,
// and everything the sim sees (placements, colliders, foliage envelopes) as it was at d98da7b. Headless (canvas stubs).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assets } from '../../src/render/assets';
import { loadAssetsFromDisk, unloadAssets } from '../../src/render/assets/testing';
import { DRESSING_SIZE, DressingRules, dressingItems, footprint, GARAGE_ITEM_HEIGHT, garageSpecs, houseLots, type DressingItem } from '../../src/render/dressing';
import {
  broadleafClusters, broadleafGeometry, broadleafTexture, BROADLEAF_SCALE, LEAF_ATLAS_ID, LEAF_CARDS, LEAF_TILES, PALM_RING, palmCurve, palmTrunkGeometry, TREE_LIMBS,
} from '../../src/render/foliage';
import { benchGeometry, binGeometry, bollardGeometry, hydrantGeometry, lampHeadGeometry, lampLensGeometry, lampPoleGeometry, lampShadowGeometry, railGeometry, signalBulbAt, signalPoleGeometry, triangles } from '../../src/render/furniture';
import { OCCLUDER_AXIS, occluderOpacity } from '../../src/render/occluderFade';
import { foliageSpheres, LAMP_HEAD, palmAxis, palmLean, palmMatrix, PropsView } from '../../src/render/props';
import { SiteView } from '../../src/render/siteView';
import { HARDWARE_CHUNK_SIZE, spatialKey } from '../../src/render/spatial';
import { SHADOW_LAYER } from '../../src/render/vehicleBatches';
import { WIND_AMP_MAX, windAmplitude, windMaxDisplacement, windOffset } from '../../src/render/wind';
import { Sim } from '../../src/sim/sim';
import type { Prop } from '../../src/world/layout';
import { world } from './helpers';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  const ctx2d = (): unknown => {
    const store: Record<string | symbol, unknown> = {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      measureText: () => ({ width: 100 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
    return new Proxy(store, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  };
  const canvas = (): Record<string, unknown> => ({ width: 300, height: 150, clientWidth: 1280, clientHeight: 720, style: {}, getContext: (kind: string) => (kind === '2d' ? ctx2d() : null), addEventListener: () => {}, removeEventListener: () => {} });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

const W = world();
const v = (x: number, y: number, z: number) => ({ x, y, z });
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const sha = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex');

/** What d98da7b drew for each street-furniture kind: triangles and the bounding box (all its parts together). */
const BEFORE = {
  lamp: { tris: 226, size: [0.42, 6.602, 2.15] },
  bench: { tris: 48, size: [1.8, 0.955, 0.455] },
  bin: { tris: 40, size: [0.57, 1.0, 0.6] },
  hydrant: { tris: 136, size: [0.52, 0.81, 0.4] },
  signal: { tris: 108, size: [0.42, 5.2, 0.45] },
} as const;

function sizeOf(...gs: THREE.BufferGeometry[]): THREE.Vector3 {
  const b = new THREE.Box3();
  for (const g of gs) {
    g.computeBoundingBox();
    b.union(g.boundingBox!);
  }
  return b.getSize(new THREE.Vector3());
}

function minY(...gs: THREE.BufferGeometry[]): number {
  return Math.min(...gs.map((g) => (g.computeBoundingBox(), g.boundingBox!.min.y)));
}

const partsOf = (g: THREE.BufferGeometry): string[] => g.userData.parts as string[];
const count = (g: THREE.BufferGeometry, part: string) => partsOf(g).filter((p) => p === part).length;

describe('VAL-PRP-001 street furniture is modelled and fits the old models', () => {
  const bulb = new THREE.IcosahedronGeometry(0.11, 0);
  const bulbs = [0, 1, 2].map((k) => bulb.clone().translate(...signalBulbAt(k)));
  const kinds = {
    lamp: [lampPoleGeometry(LAMP_HEAD), lampHeadGeometry(LAMP_HEAD), lampLensGeometry(LAMP_HEAD)],
    bench: [benchGeometry()],
    bin: [binGeometry()],
    hydrant: [hydrantGeometry()],
    signal: [signalPoleGeometry(), ...bulbs],
  };

  it('each kind has its listed parts', () => {
    const [pole, head] = kinds.lamp;
    expect(partsOf(pole!)).toEqual(expect.arrayContaining(['base', 'pole', 'arm']));
    expect(partsOf(head!)).toContain('head');
    expect(count(kinds.bench[0]!, 'slat')).toBeGreaterThanOrEqual(4);
    expect(partsOf(kinds.bench[0]!)).toEqual(expect.arrayContaining(['leg', 'armrest']));
    expect(partsOf(kinds.bin[0]!)).toEqual(expect.arrayContaining(['body', 'rim', 'lid']));
    expect(partsOf(kinds.hydrant[0]!)).toEqual(expect.arrayContaining(['body', 'bonnet']));
    expect(count(kinds.hydrant[0]!, 'cap')).toBeGreaterThanOrEqual(2);
    const signal = kinds.signal[0]!;
    expect(partsOf(signal)).toEqual(expect.arrayContaining(['pole', 'head']));
    expect(count(signal, 'lens')).toBe(3);
    expect(count(signal, 'visor')).toBe(3);
    expect(partsOf(railGeometry())).toEqual(expect.arrayContaining(['post', 'rail']));
    expect(partsOf(bollardGeometry())).toEqual(expect.arrayContaining(['post', 'cap']));
  });

  it('triangles between twice the d98da7b count and 3,000, the box within 15% per axis, the foot on the ground', () => {
    const report: string[] = [];
    for (const [kind, gs] of Object.entries(kinds) as Array<[keyof typeof BEFORE, THREE.BufferGeometry[]]>) {
      const tris = gs.reduce((n, g) => n + triangles(g), 0);
      const size = sizeOf(...gs);
      report.push(`${kind}: ${tris} tris (was ${BEFORE[kind].tris}), size ${size.toArray().map((x) => x.toFixed(3)).join(' x ')} (was ${BEFORE[kind].size.join(' x ')}), foot ${minY(...gs).toFixed(3)}`);
      expect(tris, kind).toBeGreaterThanOrEqual(2 * BEFORE[kind].tris);
      expect(tris, kind).toBeLessThanOrEqual(3000);
      size.toArray().forEach((s, i) => {
        expect(s / BEFORE[kind].size[i]!, `${kind} axis ${i}`).toBeGreaterThanOrEqual(0.85);
        expect(s / BEFORE[kind].size[i]!, `${kind} axis ${i}`).toBeLessThanOrEqual(1.15);
      });
      expect(Math.abs(minY(...gs)), kind).toBeLessThanOrEqual(0.02);
    }
    console.log(['[props] furniture vs d98da7b', ...report].join('\n'));
  });

  it('signs: round posts and a rim round a plate with a printed face and a plain back, fitted to the d98da7b sign', () => {
    const sites = new SiteView(W);
    const report: string[] = [];
    let signs = 0;
    sites.group.traverse((o) => {
      const plate = o.children.find((c) => c.name === 'sign-plate') as THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial[]> | undefined;
      if (!plate) return;
      signs++;
      const frame = o.children.find((c) => c.name === 'sign-frame') as THREE.Mesh;
      expect(frame, 'frame').toBeTruthy();
      expect(count(frame.geometry, 'post')).toBe(2);
      expect(partsOf(frame.geometry)).toEqual(expect.arrayContaining(['base', 'cap', 'clamp', 'frame']));
      // BoxGeometry groups: +x, -x, +y, -y, +z (the printed face), -z (the back).
      const face = plate.material[4]!;
      const back = plate.material[5]!;
      expect(face.map, 'printed face').toBeTruthy();
      expect(back.map, 'plain back').toBeNull();
      expect(back.emissiveMap).toBeNull();
      // d98da7b: the plate and two 10 cm square posts behind it, 6 cm back, from the ground to its top edge.
      const { width: w, height: h } = plate.geometry.parameters;
      const bottom = plate.position.y - h / 2;
      const was = [w, bottom + h, 0.15];
      const box3 = new THREE.Box3();
      for (const m of [plate, frame] as THREE.Mesh[]) {
        m.updateMatrix();
        m.geometry.computeBoundingBox();
        box3.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrix));
      }
      const size = box3.getSize(new THREE.Vector3()).toArray();
      const tris = triangles(plate.geometry) + triangles(frame.geometry);
      report.push(`sign ${w}x${h} at ${bottom}: ${tris} tris (was 36), size ${size.map((s) => s.toFixed(3)).join(' x ')} (was ${was.map((s) => s.toFixed(3)).join(' x ')}), foot ${box3.min.y.toFixed(3)}`);
      expect(tris).toBeGreaterThanOrEqual(2 * 36);
      expect(tris).toBeLessThanOrEqual(3000);
      size.forEach((s, i) => {
        expect(s / was[i]!, `axis ${i}`).toBeGreaterThanOrEqual(0.85);
        expect(s / was[i]!, `axis ${i}`).toBeLessThanOrEqual(1.15);
      });
      expect(Math.abs(box3.min.y)).toBeLessThanOrEqual(0.02);
    });
    console.log(['[props] signs vs d98da7b', ...report].join('\n'));
    expect(signs).toBeGreaterThanOrEqual(6);
  });

  it('the props view draws these models', () => {
    const props = new PropsView(W);
    const names = new Set<string>();
    props.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) names.add(o.geometry.name);
    });
    for (const n of ['lamp-pole', 'lamp-head', 'lamp-lens', 'bench', 'bin', 'hydrant', 'signal-pole', 'dress-rail', 'dress-bollard'].map((n) => n.replace('dress-', ''))) expect(names, n).toContain(n);
  });
});

describe('VAL-PRP-002 lamp heads, halos and signal lenses keep their positions', () => {
  it('LAMP_HEAD is unchanged and the lens and head are centred on it', () => {
    expect(LAMP_HEAD).toEqual({ y: 6.3, reach: 1.55 });
    const lens = lampLensGeometry(LAMP_HEAD);
    lens.computeBoundingBox();
    expect(lens.boundingBox!.min.y).toBeCloseTo(6.3, 6);
    expect((lens.boundingBox!.min.z + lens.boundingBox!.max.z) / 2).toBeCloseTo(1.55, 6);
    const head = lampHeadGeometry(LAMP_HEAD);
    head.computeBoundingBox();
    expect((head.boundingBox!.min.z + head.boundingBox!.max.z) / 2).toBeCloseTo(1.55, 6);
  });

  it('every lamp halo is within 0.15 m of its drawn lens', () => {
    const props = new PropsView(W);
    const halos = props.group.getObjectByName('lampHalos') as THREE.Points;
    const pos = halos.geometry.getAttribute('position');
    const lamps = W.layout.props.filter((p) => p.kind === 'lamp');
    let worst = 0;
    lamps.forEach((p, k) => {
      const reach = LAMP_HEAD.reach * p.scale;
      const lens = new THREE.Vector3(p.x + Math.sin(p.rot) * reach, p.y + (LAMP_HEAD.y + 0.0125) * p.scale, p.z + Math.cos(p.rot) * reach);
      worst = Math.max(worst, lens.distanceTo(new THREE.Vector3(pos.getX(k), pos.getY(k), pos.getZ(k))));
    });
    console.log(`[props] worst halo-to-lens distance over ${lamps.length} lamps: ${worst.toFixed(4)} m`);
    expect(worst).toBeLessThan(0.15);
  });

  it('signal bulbs sit where d98da7b put them, each under its own visor', () => {
    for (let k = 0; k < 3; k++) expect(signalBulbAt(k)).toEqual([0, 4.88 - k * 0.33, 0.21]);
    const g = signalPoleGeometry();
    expect(count(g, 'visor')).toBe(3);
  });
});

describe('VAL-PRP-003 trees have branches and leaf cards', () => {
  it('at least 60 alpha-tested cards per canopy, textured from the leaf atlas tiles', () => {
    for (const kind of ['tree', 'bush'] as const) {
      const g = broadleafGeometry(kind);
      expect(g.userData.leafCards, kind).toBe(LEAF_CARDS[kind]);
      expect(LEAF_CARDS[kind]).toBeGreaterThanOrEqual(60);
      // Two faces of two triangles per card.
      expect(triangles(g), kind).toBe(LEAF_CARDS[kind] * 4);
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        const inTile = LEAF_TILES.some(([u0, v0, u1, v1]) => uv.getX(i) >= u0 - 1e-6 && uv.getX(i) <= u1 + 1e-6 && uv.getY(i) >= v0 - 1e-6 && uv.getY(i) <= v1 + 1e-6);
        if (!inTile) throw new Error(`${kind}: uv ${i} outside the atlas tiles`);
      }
    }
  });

  it('the leaf material is alpha-tested, never blended, with the atlas from src/assets/textures', () => {
    const props = new PropsView(W);
    const mats = new Set<THREE.MeshStandardMaterial>();
    props.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && (o.material as THREE.Material).name.startsWith('broadleaf-')) mats.add(o.material as THREE.MeshStandardMaterial);
    });
    expect(mats.size).toBe(2);
    for (const m of mats) {
      expect(m.alphaTest).toBeGreaterThan(0);
      expect(m.transparent).toBe(false);
      expect(m.blending).toBe(THREE.NormalBlending);
      expect(m.depthWrite).toBe(true);
      expect(m.map).toBeTruthy();
    }
    expect(existsSync(resolve(process.cwd(), 'src/assets/textures/leaf_atlas/albedo.webp'))).toBe(true);
  });

  it('with the assets loaded, the canopies use the leaf atlas texture', async () => {
    await loadAssetsFromDisk({ filter: (e) => e.id === LEAF_ATLAS_ID });
    try {
      expect(assets.entry(LEAF_ATLAS_ID)?.file).toBe('textures/leaf_atlas/albedo.webp');
      expect(broadleafTexture()).toBe(assets.texture(LEAF_ATLAS_ID));
    } finally {
      unloadAssets();
    }
  });

  it('the trunk splits into at least 3 branches below the canopy', () => {
    const lowest = Math.min(...broadleafClusters('tree').map(({ at, scale }) => at[1] - scale[1]));
    const below = TREE_LIMBS.filter((l) => l.from[1] < lowest && Math.hypot(l.to[0] - l.from[0], l.to[2] - l.from[2]) > 0.5);
    expect(lowest).toBeGreaterThan(2.5);
    expect(below.length).toBeGreaterThanOrEqual(3);
  });
});

describe('VAL-PRP-004 foliage moves in the wind', () => {
  /** The largest displacement over 30 s of render time at a point. */
  const peak = (x: number, y: number, z: number, h: number, speed: number) => {
    let best = 0;
    for (let t = 0; t < 30; t += 0.02) best = Math.max(best, Math.hypot(...windOffset(x, y, z, h, 1, t, windAmplitude(speed), 1, 0)));
    return best;
  };

  it('2 to 15 cm at the canopy edge in clear weather, at most 40 cm in a storm, 1.5 times more or better', () => {
    const tree = W.layout.props.find((p) => p.kind === 'tree')!;
    const g = broadleafGeometry('tree');
    g.computeBoundingBox();
    const top = g.boundingBox!.max.y * tree.scale;
    const clear = peak(tree.x, tree.y + top, tree.z, top, 2);
    const storm = peak(tree.x, tree.y + top, tree.z, top, 12);
    console.log(`[props] wind at the canopy edge (${top.toFixed(2)} m): clear ${(clear * 100).toFixed(1)} cm, storm ${(storm * 100).toFixed(1)} cm`);
    expect(clear).toBeGreaterThanOrEqual(0.02);
    expect(clear).toBeLessThanOrEqual(0.15);
    expect(storm).toBeLessThanOrEqual(0.4);
    expect(storm).toBeGreaterThanOrEqual(1.5 * clear);
  });

  it('nothing moves at the trunk base or below 1 m', () => {
    for (const h of [0, 0.3, 0.6, 0.99, 1]) expect(peak(3, h, 7, h, 12), `${h}`).toBe(0);
  });

  it('wind is a function of render time and position only, and drives uniforms, never programs', () => {
    expect(windOffset.length).toBe(9);
    const props = new PropsView(W);
    const mats: THREE.Material[] = [];
    props.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && /broadleaf|palm-fronds/.test((o.material as THREE.Material).name)) mats.push(o.material as THREE.Material);
    });
    const keys = mats.map((m) => m.customProgramCacheKey());
    const versions = mats.map((m) => m.version);
    for (let k = 0; k <= 10; k++) {
      props.setWind({ x: k * 1.2, z: k * 0.3 });
      props.update(k, 0, 0);
    }
    props.setWindEnabled(false);
    expect(props.wind.amp).toBe(0);
    props.setWindEnabled(true);
    expect(props.wind.amp).toBeCloseTo(windAmplitude(Math.hypot(12, 3)), 9);
    expect(mats.map((m) => m.customProgramCacheKey())).toEqual(keys);
    expect(mats.map((m) => m.version)).toEqual(versions);
  });
});

describe('VAL-PRP-005 palms have curved, ringed trunks and still dissolve for the camera', () => {
  const palms = W.layout.props.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'palm');

  it('every palm leans 0.4 to 1.5 m at its top, by a hash of where it stands', () => {
    const leans = palms.map(({ p }) => {
      const m = palmMatrix(p, new THREE.Matrix4());
      const top = new THREE.Vector3(palmCurve(8.5), 8.5, 0).applyMatrix4(m);
      return Math.hypot(top.x - p.x, top.z - p.z);
    });
    for (const [k, l] of leans.entries()) {
      expect(l, `palm ${k}`).toBeGreaterThanOrEqual(0.4);
      expect(l, `palm ${k}`).toBeLessThanOrEqual(1.5);
      expect(l).toBeCloseTo(palmLean(palms[k]!.p), 6);
    }
    const mean = leans.reduce((a, b) => a + b, 0) / leans.length;
    const sd = Math.sqrt(leans.reduce((a, b) => a + (b - mean) ** 2, 0) / leans.length);
    console.log(`[props] palm leans: ${Math.min(...leans).toFixed(2)}..${Math.max(...leans).toFixed(2)} m, mean ${mean.toFixed(2)}, sd ${sd.toFixed(2)}`);
    expect(sd).toBeGreaterThan(0.15);
    // The same palm leans the same way whatever else is loaded.
    expect(palmLean({ ...palms[0]!.p })).toBe(palmLean(palms[0]!.p));
  });

  it('the trunk has ring geometry: its radius steps up and down once per ring', () => {
    const g = palmTrunkGeometry();
    const pos = g.getAttribute('position');
    const radius = new Map<number, number>();
    for (let i = 0; i < pos.count; i++) {
      const y = Math.round(pos.getY(i) * 1000) / 1000;
      if (y < 0.5 || y > 8) continue;
      radius.set(y, Math.max(radius.get(y) ?? 0, Math.hypot(pos.getX(i) - palmCurve(pos.getY(i)), pos.getZ(i))));
    }
    const ys = [...radius.keys()].sort((a, b) => a - b);
    let drops = 0;
    for (let k = 1; k < ys.length; k++) if (radius.get(ys[k]!)! < radius.get(ys[k - 1]!)! * 0.975) drops++;
    expect(drops).toBeGreaterThanOrEqual(Math.floor(7.5 / PALM_RING) - 2);
    // Inside the 0.3 m collider at the foot.
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) < 0.3) expect(Math.hypot(pos.getX(i), pos.getZ(i))).toBeLessThan(0.3);
  });

  it('a camera whose sight line crosses any part of the curved trunk dissolves it', () => {
    const props = new PropsView(W);
    let checked = 0;
    let straightMisses = 0;
    for (const { p, i } of palms.slice(0, 40)) {
      const m = palmMatrix(p, new THREE.Matrix4());
      const along = new THREE.Vector3(1, 0, 0).transformDirection(m).setY(0).normalize();
      for (const y of [1.5, 3, 4.5, 6, 7.5]) {
        const c = new THREE.Vector3(palmCurve(y), y, 0).applyMatrix4(m);
        // The sight line crosses the trunk at right angles to its lean, 3 m each side.
        const across = new THREE.Vector3(-along.z, 0, along.x);
        const cam = v(c.x - across.x * 3, c.y, c.z - across.z * 3);
        const subject = v(c.x + across.x * 3, c.y, c.z + across.z * 3);
        expect(props.setOccluderView(cam, subject), `palm ${i} at ${y} m`).toContain(i);
        const a = OCCLUDER_AXIS.palm;
        if (occluderOpacity(cam, subject, v(p.x, p.y + a.from * p.scale, p.z), v(p.x, p.y + a.to * p.scale, p.z)) >= 1) straightMisses++;
        checked++;
      }
      expect(palmAxis(p).length).toBeGreaterThan(2);
    }
    console.log(`[props] curved palm occluder: ${checked} sight lines through the trunk all dissolve it (a straight axis would miss ${straightMisses})`);
    expect(straightMisses).toBeGreaterThan(0);
  });
});

describe('VAL-PRP-006 beaches and yards are dressed, visual only', () => {
  const items = dressingItems(W);
  const sim = new Sim({ world: W, ambient: false, police: false });

  it('Ocean Beach: at least 20 items of at least 3 kinds', () => {
    const beach = items.filter((it) => it.area === 'beach');
    const kinds = new Map<string, number>();
    for (const it of beach) kinds.set(it.kind, (kinds.get(it.kind) ?? 0) + 1);
    console.log(`[props] beach dressing: ${beach.length} items ${JSON.stringify(Object.fromEntries(kinds))}`);
    expect(beach.length).toBeGreaterThanOrEqual(20);
    expect(kinds.size).toBeGreaterThanOrEqual(3);
    for (const it of beach) expect(W.zoneName(it.x, it.z)).toBe('Ocean Beach');
  });

  it('at least 80% of the house lots have two or more yard items', () => {
    const lots = houseLots(W);
    const per = new Map<number, Set<string>>();
    const n = new Map<number, number>();
    for (const it of items) if (it.area === 'yard') n.set(it.owner, (n.get(it.owner) ?? 0) + 1);
    for (const it of items) if (it.area === 'yard') (per.get(it.owner) ?? per.set(it.owner, new Set()).get(it.owner)!).add(it.kind);
    const dressed = lots.filter((l) => (n.get(l.building.id) ?? 0) >= 2).length;
    console.log(`[props] yards: ${dressed}/${lots.length} house lots with 2+ items (${((100 * dressed) / lots.length).toFixed(1)}%), ${items.filter((i) => i.area === 'yard').length} items`);
    expect(lots.length).toBeGreaterThan(50);
    expect(dressed / lots.length).toBeGreaterThanOrEqual(0.8);
  });

  it('nothing on a road, a walking line or crossing, a parked-car slot, a spawn, a POI or marker, or a pickup', () => {
    const rules = new DressingRules(W);
    const markers = sim.interactions.markers;
    const pickups = sim.pickups as unknown as Array<{ pos?: { x: number; z: number }; x?: number; z?: number }>;
    let violations = 0;
    const why: string[] = [];
    const outside = items.filter((it) => it.area !== 'garage');
    for (const it of outside) {
      const reason = rules.violation(it);
      const pts = footprint(it);
      let independent: string | null = null;
      for (const [x, z] of [[it.x, it.z] as [number, number], ...pts]) {
        if (W.isOnRoad(x, z)) independent = 'road';
        for (const n of W.walk.nodes) for (const e of n.edges) {
          const m = W.walk.nodes[e.to]!;
          const dx = m.x - n.x, dz = m.z - n.z;
          const l2 = dx * dx + dz * dz;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - n.x) * dx + (z - n.z) * dz) / l2)) : 0;
          if (Math.hypot(x - n.x - dx * t, z - n.z - dz * t) < 1.2) independent = e.crosswalk ? 'crossing' : 'walkway';
        }
        if (W.layout.parking.some((p) => Math.hypot(p.x - x, p.z - z) < 3)) independent = 'parking';
        if (markers.some((mk) => Math.hypot(mk.x - x, mk.z - z) < mk.radius + 1)) independent = 'marker';
        if (W.layout.pois.some((p) => Math.hypot(p.x - x, p.z - z) < 3)) independent = 'poi';
        if (W.layout.openSpots.some((s) => Math.hypot(s.x - x, s.z - z) < 2)) independent = 'pickup spot';
        if (pickups.some((pk) => Math.hypot((pk.pos?.x ?? pk.x ?? 1e9) - x, (pk.pos?.z ?? pk.z ?? 1e9) - z) < 2)) independent = 'pickup';
      }
      if (reason || independent) {
        violations++;
        if (why.length < 10) why.push(`${it.kind} ${it.x.toFixed(1)},${it.z.toFixed(1)}: ${reason ?? independent}`);
      }
    }
    console.log(`[props] placement violations: ${violations} of ${outside.length} items`);
    expect(why).toEqual([]);
    expect(violations).toBe(0);
  });

  it('adds no colliders and uses no sim randomness: the same items every time, the colliders as at d98da7b', () => {
    const before = W.grid.colliders.length;
    new PropsView(W);
    expect(W.grid.colliders.length).toBe(before);
    const again = dressingItems(world());
    expect(sha(again.map((i) => [i.kind, r6(i.x), r6(i.z), r6(i.rot)]))).toBe(sha(items.map((i) => [i.kind, r6(i.x), r6(i.z), r6(i.rot)])));
  });

  it('is instanced in the prop cells: one mesh per kind and cell', () => {
    const props = new PropsView(W, HARDWARE_CHUNK_SIZE);
    for (const [kind, meshes] of props.dressing) {
      const cells = new Set(items.filter((i) => i.kind === kind).map((i) => `${Math.floor(i.x / HARDWARE_CHUNK_SIZE)},${Math.floor(i.z / HARDWARE_CHUNK_SIZE)}`));
      expect(meshes.length, kind).toBe(cells.size);
      expect(meshes.reduce((n, m) => n + m.count, 0), kind).toBe(items.filter((i) => i.kind === kind).length);
    }
  });
});

describe('VAL-PRP-007 garages are furnished', () => {
  const items = dressingItems(W);
  const specs = garageSpecs(W);

  it('Lou\'s, the spray shacks and the safehouse garage: 5+ kinds inside, bays clear by 0.3 m, the entrance clear', () => {
    expect(specs.map((g) => g.name)).toEqual(expect.arrayContaining(['lou', 'safehouse']));
    const report: string[] = [];
    specs.forEach((g, gi) => {
      const mine = items.filter((it) => it.area === 'garage' && it.owner === gi);
      // The fixture's housing and tubes are one ceiling light.
      const kinds = new Set(mine.map((it) => (it.kind === 'lamptube' ? 'lamphousing' : it.kind)));
      let worst = Infinity;
      const floor = W.groundHeight(g.ox + g.dx * g.depth / 2, g.oz + g.dz * g.depth / 2);
      for (const it of mine) {
        const pts = footprint(it).map(([x, z]) => [(x - g.ox) * g.ax + (z - g.oz) * g.az, (x - g.ox) * g.dx + (z - g.oz) * g.dz] as const);
        for (const [x, z] of footprint(it)) expect(x >= g.rect.minX - 1e-6 && x <= g.rect.maxX + 1e-6 && z >= g.rect.minZ - 1e-6 && z <= g.rect.maxZ + 1e-6, `${g.name} ${it.kind} inside`).toBe(true);
        // Inside the walls (0.5 m; the carport's back wall 0.12 m).
        for (const [u, w] of pts) {
          expect(Math.abs(u), `${g.name} ${it.kind} u`).toBeLessThanOrEqual(g.halfWidth + 1e-6);
          expect(w, `${g.name} ${it.kind} w`).toBeLessThanOrEqual(g.depth + 1e-6);
          expect(w, `${g.name} ${it.kind} w`).toBeGreaterThanOrEqual(0);
        }
        const [y0, y1] = GARAGE_ITEM_HEIGHT[it.kind]!;
        const lo = it.y - floor + y0;
        const hi = it.y - floor + y1;
        const u0 = Math.min(...pts.map((p) => p[0])), u1 = Math.max(...pts.map((p) => p[0]));
        const w0 = Math.min(...pts.map((p) => p[1])), w1 = Math.max(...pts.map((p) => p[1]));
        if (lo < g.bayHeight) {
          for (const [bu0, bw0, bu1, bw1] of g.bays) {
            const gap = Math.max(bu0 - u1, u0 - bu1, bw0 - w1, w0 - bw1);
            worst = Math.min(worst, gap);
            expect(gap, `${g.name} ${it.kind} clear of bay`).toBeGreaterThanOrEqual(0.3);
          }
          expect(w0, `${g.name} ${it.kind} entrance`).toBeGreaterThanOrEqual(g.entrance);
        } else {
          expect(hi).toBeLessThanOrEqual(g.ceiling + 0.4);
        }
      }
      report.push(`${g.name}: ${kinds.size} kinds (${[...kinds].join(', ')}), ${mine.length} items, nearest bay ${worst.toFixed(2)} m`);
      expect(kinds.size, g.name).toBeGreaterThanOrEqual(5);
    });
    console.log(['[props] garages', ...report].join('\n'));
  });

  it('wall-mounted pieces stand against their wall', () => {
    for (const it of items.filter((i) => i.back)) expect(DRESSING_SIZE[it.kind][1]).toBe(it.hz);
  });
});

describe('VAL-PRP-008 placements, colliders and foliage envelopes are as at d98da7b', () => {
  // Recorded at d98da7b (tests/unit/m3_props.test.ts hashes run against an archive of that commit), re-recorded when
  // the map was broken up and when its four bays were drowned and the ring road bridged across their mouths (docs/map.md), which moves, adds
  // and drops props and adds colliders, and when Hillcrest Green rose into a hill and Azura Point into a bluff: their
  // props stand on them (every one kept), and the sight cores, the letters and the lookout's parapet are colliders; and
  // when the attractions pass rebuilt two cells (their yards' trees gone, the farm's and the cemetery's props and solids
  // added), when Turbine Row and Smuggler's Key appended theirs, and when AzuraLink's pylons and stations were appended
  // to the colliders; and on the merged round-2 head, where all four passes stand together and the trees in front of the
  // SAN AZURA letters are bushes (their kind, trunks and envelopes).
  const D98 = {
    props: '1a01b0818b2ab9478c3b1af626c1b7f3355fb5815efbfee075e0c2efe25224be',
    colliders: '90c170900ea027f8e371569aecda53ecbe4c72adc2a67e96ee7c46393cd3f28e',
    envelopes: 'ea3cbd9d5cc97c4f50cacf114dd37a248c57c3a7d6ca9c1229e0da7b543740dc',
  };

  it('prop placements, world colliders and envelopes hash as at d98da7b', () => {
    const props = W.layout.props.map((p) => [p.kind, r6(p.x), r6(p.y), r6(p.z), r6(p.rot), r6(p.scale)]);
    const colliders = W.grid.colliders.map((c) => [c.circle, r6(c.minX), r6(c.minZ), r6(c.maxX), r6(c.maxZ), r6(c.r), r6(c.y0), r6(c.y1), c.tag, c.breakable, c.propIndex]);
    const env = W.layout.props.filter((p) => p.kind === 'tree' || p.kind === 'bush').map((p) => foliageSpheres(p).map((s) => [r6(s.x), r6(s.y), r6(s.z), r6(s.r)]));
    expect({ props: sha(props), colliders: sha(colliders), envelopes: sha(env) }).toEqual(D98);
  });

  it('every leaf-card vertex, pushed as far as a storm can, stays inside an envelope, for every tree and bush', () => {
    let outside = 0;
    let checked = 0;
    const m = new THREE.Matrix4();
    const p3 = new THREE.Vector3();
    const geo = { tree: broadleafGeometry('tree'), bush: broadleafGeometry('bush') };
    for (const q of W.layout.props) {
      if (q.kind !== 'tree' && q.kind !== 'bush') continue;
      expect(q.scale).toBeGreaterThanOrEqual(BROADLEAF_SCALE.min);
      expect(q.scale).toBeLessThanOrEqual(BROADLEAF_SCALE.max);
      const spheres = foliageSpheres(q);
      m.compose(new THREE.Vector3(q.x, q.y, q.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), q.rot), new THREE.Vector3(q.scale, q.scale, q.scale));
      const pos = geo[q.kind].getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        p3.fromBufferAttribute(pos, i).applyMatrix4(m);
        const push = windMaxDisplacement(p3.y - q.y, WIND_AMP_MAX);
        if (!spheres.some((s) => Math.hypot(p3.x - s.x, p3.y - s.y, p3.z - s.z) + push <= s.r + 1e-6)) outside++;
        checked++;
      }
    }
    console.log(`[props] leaf vertices checked against the envelopes at storm sway: ${checked}, outside ${outside}`);
    expect(outside).toBe(0);
  });
});

describe('VAL-PRP-009 the dissolve, halo and clip patches are on the new materials', () => {
  const props = new PropsView(W);
  const compiled = (mat: THREE.Material) => {
    const lib = mat instanceof THREE.MeshBasicMaterial ? THREE.ShaderLib.basic : mat instanceof THREE.PointsMaterial ? THREE.ShaderLib.points : THREE.ShaderLib.standard;
    const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
    mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    return shader;
  };
  const byGeo = new Map<string, THREE.Material>();
  props.group.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) byGeo.set(o.geometry.name || (o.material as THREE.Material).name, o.material as THREE.Material);
  });

  it('foliage near-lens dissolve and wind on the leaf cards and palm fronds', () => {
    const report: string[] = [];
    props.group.traverse((o) => {
      if (!(o instanceof THREE.InstancedMesh)) return;
      const mat = o.material as THREE.Material;
      if (!/broadleaf|palm-fronds/.test(mat.name)) return;
      const s = compiled(mat);
      expect(s.vertexShader).toContain('vFadeWorld');
      expect(s.fragmentShader).toContain('fadeBayer4( gl_FragCoord.xy )');
      expect(s.vertexShader).toContain('windOffset( windWorld');
      report.push(mat.name);
    });
    expect(new Set(report)).toEqual(new Set(['broadleaf-canopy', 'broadleaf-shrub', 'palm-fronds']));
  });

  it('occluder dissolve on the lamp parts, the signal pole and bulbs and both trunks; the palm bends it', () => {
    let palm = 0;
    props.group.traverse((o) => {
      if (!(o instanceof THREE.InstancedMesh)) return;
      const mat = o.material as THREE.Material;
      if (mat.customProgramCacheKey() !== 'gta7-occluder') return;
      const s = compiled(mat);
      expect(s.vertexShader).toContain('vOccKeep = min(');
      expect(s.vertexShader).toContain('uOccBend');
      expect(s.fragmentShader).toContain('occBayer4( gl_FragCoord.xy ) >= vOccKeep ) discard;');
      if ((s.uniforms.uOccBend as { value: number }).value > 0) palm++;
    });
    expect(palm).toBeGreaterThan(0);
    for (const n of ['lamp-pole', 'lamp-head', 'lamp-lens', 'signal-pole']) expect(byGeo.get(n)!.customProgramCacheKey(), n).toBe('gta7-occluder');
  });

  it('lamp halos keep their halo shader and the pools their clip', () => {
    const halos = props.group.getObjectByName('lampHalos') as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
    expect(halos.material.customProgramCacheKey()).toBe('gta7-halo');
    expect(compiled(halos.material).vertexShader).toContain('gl_PointSize = max( gl_PointSize');
    let clip = 0;
    props.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && (o.material as THREE.Material).customProgramCacheKey() === 'gta7-clip-rect') clip++;
    });
    expect(clip).toBeGreaterThan(0);
  });
});

describe('VAL-PRP-010 props stay instanced within budget', () => {
  it('the lamps cast their shadow with one low-poly stand-in per cell on the shadow layer, which goes when a lamp is knocked down', () => {
    const props = new PropsView(W, HARDWARE_CHUNK_SIZE);
    const lamps = W.layout.props.flatMap((p, i) => (p.kind === 'lamp' ? [i] : []));
    const stand: THREE.InstancedMesh[] = [];
    props.group.traverse((o) => {
      if (!(o instanceof THREE.InstancedMesh)) return;
      if (o.geometry.name === 'shadow-lamp') stand.push(o);
      // The drawn lamp parts cast none.
      if (o.geometry.name.startsWith('lamp-')) expect(o.castShadow, o.geometry.name).toBe(false);
    });
    const cells = new Set(lamps.map((i) => spatialKey(W.layout.props[i]!.x, W.layout.props[i]!.z, HARDWARE_CHUNK_SIZE)));
    expect(stand.length).toBe(cells.size);
    expect(stand.reduce((n, m) => n + m.count, 0)).toBe(lamps.length);
    for (const m of stand) {
      expect(m.castShadow).toBe(true);
      expect(m.layers.isEnabled(SHADOW_LAYER)).toBe(true);
      expect(m.layers.isEnabled(0)).toBe(false);
    }
    // A fraction of the drawn lamp's triangles, with the same outline (within 15 cm) as its pole, arm and head.
    const drawn = sizeOf(lampPoleGeometry(LAMP_HEAD), lampHeadGeometry(LAMP_HEAD));
    const proxy = lampShadowGeometry(LAMP_HEAD);
    const ps = sizeOf(proxy);
    const tris = triangles(proxy);
    const full = triangles(lampPoleGeometry(LAMP_HEAD)) + triangles(lampHeadGeometry(LAMP_HEAD));
    console.log(`[props] lamp shadow caster: ${tris} triangles for the drawn ${full}, size ${ps.toArray().map((s) => s.toFixed(2)).join(' x ')} (drawn ${drawn.toArray().map((s) => s.toFixed(2)).join(' x ')})`);
    expect(tris).toBeLessThan(full / 5);
    for (let k = 0; k < 3; k++) expect(Math.abs(ps.getComponent(k) - drawn.getComponent(k)), `axis ${k}`).toBeLessThan(0.15);
    // Knocked down: its stand-in goes with it; a new game brings it back.
    const target = lamps[3]!;
    const refs = (props as unknown as { shadowRefs: Map<number, Array<{ mesh: THREE.InstancedMesh; index: number }>> }).shadowRefs.get(target)!;
    expect(refs.length).toBe(1);
    const scale = () => {
      const m = new THREE.Matrix4();
      refs[0]!.mesh.getMatrixAt(refs[0]!.index, m);
      return new THREE.Vector3().setFromMatrixScale(m).length();
    };
    expect(scale()).toBeGreaterThan(0);
    props.breakProp(target, 1, 0);
    expect(scale()).toBe(0);
    props.restoreAll();
    expect(scale()).toBeGreaterThan(0);
  });

  it('at most 1.5 times the d98da7b prop meshes (387) at the hardware cell size, and no more per kind than cells', () => {
    const props = new PropsView(W, HARDWARE_CHUNK_SIZE);
    let meshes = 0;
    let tris = 0;
    const perGeo = new Map<string, number>();
    props.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      meshes++;
      tris += triangles(o.geometry) * (o instanceof THREE.InstancedMesh ? o.count : 1);
      if (o instanceof THREE.InstancedMesh) perGeo.set(o.geometry.uuid, (perGeo.get(o.geometry.uuid) ?? 0) + 1);
    });
    const cells = new Set(W.layout.props.map((p) => `${Math.floor(p.x / HARDWARE_CHUNK_SIZE)},${Math.floor(p.z / HARDWARE_CHUNK_SIZE)}`)).size;
    console.log(`[props] ${meshes} prop meshes (d98da7b 387, cap ${Math.floor(387 * 1.5)}), ${tris} triangles over the whole city, ${cells} cells`);
    expect(meshes).toBeLessThanOrEqual(Math.floor(387 * 1.5));
    for (const n of perGeo.values()) expect(n).toBeLessThanOrEqual(cells + 4);
  });
});

beforeAll(() => {
  unloadAssets();
});
afterAll(() => {
  unloadAssets();
});

void ({} as Prop);
void ({} as DressingItem);
