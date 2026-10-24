// The asset library: synchronous lookup with an undefined answer for anything not loaded, progress driven by the real
// preload, per-asset fallback, the preload timeout, and loading the committed GLBs from disk in Node.
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetLibrary, assets, PRELOAD_TIMEOUT_MS } from '../../src/render/assets/AssetLibrary';
import type { AssetBackend } from '../../src/render/assets/backend';
import { diskBackend, loadAssetsFromDisk, unloadAssets } from '../../src/render/assets/testing';
import type { Manifest, ManifestEntry } from '../../src/render/assets/types';

const entry = (id: string, bytes = 100): ManifestEntry => ({ id, file: `${id}.glb`, kind: 'prop', bytes, bounds: { min: [0, 0, 0], max: [1, 1, 1] }, license: 'x' });

/** A backend over made-up entries; `fetch` and `decode` can be replaced per test. */
function fakeBackend(ids: string[], over: Partial<AssetBackend> = {}): AssetBackend {
  const manifest: Manifest = { version: 1, entries: ids.map((id) => entry(id)) };
  return {
    manifest: async () => manifest,
    fetch: async (e, onBytes) => {
      onBytes(e.bytes / 2);
      onBytes(e.bytes);
      return new ArrayBuffer(e.bytes);
    },
    decode: async (e) => {
      const scene = new THREE.Group();
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: e.id })));
      return { type: 'model', scene, animations: [] };
    },
    ...over,
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
  unloadAssets();
});

describe('empty library (the Node default)', () => {
  it('answers every lookup synchronously with undefined and builds no warm-up objects', () => {
    const lib = new AssetLibrary();
    expect(lib.model('veh.q.police')).toBeUndefined();
    expect(lib.texture('tex.asphalt_02.albedo')).toBeUndefined();
    expect(lib.clone('char.swat')).toBeUndefined();
    expect(lib.bounds('char.swat')).toBeUndefined();
    expect(lib.has('char.swat')).toBe(false);
    expect(lib.ids()).toEqual([]);
    expect(lib.materials()).toEqual([]);
    expect(lib.warmGroup().children).toHaveLength(0);
    expect(lib.ready).toBe(false);
  });

  it('the shared library starts empty so existing suites run on the procedural models', () => {
    expect(assets.ids()).toEqual([]);
    expect(assets.manifest).toBeNull();
  });

  it('reports an unknown id once, and stays silent before a manifest exists or for known ids that failed', async () => {
    const lib = new AssetLibrary();
    expect(lib.use('nope')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    await lib.preload(undefined, { backend: fakeBackend(['a']) });
    expect(lib.use('nope')).toBeUndefined();
    expect(lib.use('nope')).toBeUndefined();
    expect(lib.use('a')).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('preload', () => {
  it('reports rising progress from 0 to 1 with at least one call per asset', async () => {
    const lib = new AssetLibrary();
    const ids = ['a', 'b', 'c', 'd'];
    const seen: number[] = [];
    const perAsset = new Map<string, number>();
    const report = await lib.preload((f, info) => {
      seen.push(f);
      if (info) perAsset.set(info.id, (perAsset.get(info.id) ?? 0) + 1);
    }, { backend: fakeBackend(ids) });
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(new Set(seen).size).toBeGreaterThanOrEqual(ids.length);
    for (const id of ids) expect(perAsset.get(id) ?? 0).toBeGreaterThanOrEqual(1);
    expect(report).toMatchObject({ manifest: 4, loaded: 4, failed: [], timedOut: false, manifestFailed: false });
    expect(lib.ready).toBe(true);
    expect(lib.ids()).toEqual(ids);
  });

  it('weights progress by bytes, so a big file moves the bar further', async () => {
    const lib = new AssetLibrary();
    const manifest: Manifest = { version: 1, entries: [entry('small', 10), entry('big', 990)] };
    const at: Record<string, number> = {};
    await lib.preload((f, info) => {
      if (info) at[info.id] = f;
    }, { backend: { ...fakeBackend([]), manifest: async () => manifest }, concurrency: 1 });
    expect(at.small!).toBeCloseTo(0.01, 2);
    expect(at.big!).toBeCloseTo(1, 5);
  });

  it('never calls back backwards, even when a backend reports bytes out of order', async () => {
    const lib = new AssetLibrary();
    const seen: number[] = [];
    await lib.preload((f) => seen.push(f), {
      backend: fakeBackend(['a'], { fetch: async (e, onBytes) => (onBytes(90), onBytes(40), onBytes(e.bytes), new ArrayBuffer(e.bytes)) }),
    });
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it('is shared: a second call returns the first call', async () => {
    const lib = new AssetLibrary();
    const backend = fakeBackend(['a']);
    const first = lib.preload(undefined, { backend });
    expect(lib.preload(undefined, { backend })).toBe(first);
    await first;
  });
});

describe('fallback', () => {
  it('a failing asset is missing from the library, warns once, and the rest still loads', async () => {
    const lib = new AssetLibrary();
    const report = await lib.preload(undefined, {
      backend: fakeBackend(['good', 'bad'], { fetch: async (e, onBytes) => (e.id === 'bad' ? Promise.reject(new Error('HTTP 404')) : (onBytes(e.bytes), new ArrayBuffer(e.bytes))) }),
    });
    expect(lib.model('good')).toBeDefined();
    expect(lib.model('bad')).toBeUndefined();
    expect(lib.use('bad')).toBeUndefined();
    expect(report.failed).toEqual(['bad']);
    expect(report.loaded).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('bad');
  });

  it('a decode error falls back the same way', async () => {
    const lib = new AssetLibrary();
    const report = await lib.preload(undefined, { backend: fakeBackend(['x'], { decode: async () => Promise.reject(new Error('corrupt')) }) });
    expect(report.failed).toEqual(['x']);
    expect(lib.model('x')).toBeUndefined();
  });

  it('an unreadable manifest leaves the library empty, warns once and still settles', async () => {
    const lib = new AssetLibrary();
    const seen: number[] = [];
    const report = await lib.preload((f) => seen.push(f), { backend: fakeBackend([], { manifest: async () => Promise.reject(new Error('HTTP 404')) }) });
    expect(report.manifestFailed).toBe(true);
    expect(report.loaded).toBe(0);
    expect(lib.ids()).toEqual([]);
    expect(seen[seen.length - 1]).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('timeout', () => {
  it('names a timeout of at most 15 s', () => {
    expect(PRELOAD_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it('resolves after the timeout when a request never answers, and keeps what arrived', async () => {
    vi.useFakeTimers();
    const lib = new AssetLibrary();
    const backend = fakeBackend(['fast', 'stuck'], { fetch: (e, onBytes) => (e.id === 'stuck' ? new Promise<ArrayBuffer>(() => {}) : (onBytes(e.bytes), Promise.resolve(new ArrayBuffer(e.bytes)))) });
    let settled = false;
    const done = lib.preload(undefined, { backend }).then((r) => ((settled = true), r));
    await vi.advanceTimersByTimeAsync(PRELOAD_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const report = await done;
    expect(report.timedOut).toBe(true);
    expect(report.failed).toEqual(['stuck']);
    expect(lib.model('fast')).toBeDefined();
    expect(lib.model('stuck')).toBeUndefined();
  });

  it('resolves when every request stalls', async () => {
    vi.useFakeTimers();
    const lib = new AssetLibrary();
    const backend = fakeBackend(['a', 'b', 'c'], { fetch: () => new Promise<ArrayBuffer>(() => {}) });
    const done = lib.preload(undefined, { backend, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    const report = await done;
    expect(report).toMatchObject({ timedOut: true, loaded: 0 });
    expect(report.failed).toEqual(['a', 'b', 'c']);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('drops a response that arrives after the timeout instead of swapping a model in', async () => {
    vi.useFakeTimers();
    const lib = new AssetLibrary();
    let release!: (b: ArrayBuffer) => void;
    const late = new Promise<ArrayBuffer>((r) => (release = r));
    const done = lib.preload(undefined, { backend: fakeBackend(['late'], { fetch: () => late }), timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    release(new ArrayBuffer(100));
    await vi.advanceTimersByTimeAsync(10);
    expect(lib.model('late')).toBeUndefined();
    expect(lib.ids()).toEqual([]);
    expect(lib.report.failed).toEqual(['late']);
  });
});

describe('committed assets loaded from disk in Node', () => {
  it('loads every manifest entry through GLTFLoader + meshopt without failures', async () => {
    const lib = new AssetLibrary();
    const seen: number[] = [];
    const report = await lib.preload((f) => seen.push(f), { backend: diskBackend() });
    expect(report.manifestFailed).toBe(false);
    expect(report.failed).toEqual([]);
    expect(report.loaded).toBe(report.manifest);
    expect(report.manifest).toBeGreaterThan(100);
    expect(seen[seen.length - 1]).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('restores the globals the loader needed', async () => {
    const g = globalThis as Record<string, unknown>;
    const before = { Image: g.Image, self: g.self };
    await loadAssetsFromDisk({ library: new AssetLibrary(), filter: (e) => e.id === 'char.swat' });
    expect({ Image: g.Image, self: g.self }).toEqual(before);
  });

  it('returns independent skinned clones of a character that share geometry and materials', async () => {
    await loadAssetsFromDisk({ filter: (e) => e.id === 'char.swat' });
    const a = assets.clone('char.swat')!;
    const b = assets.clone('char.swat')!;
    const skinned = (root: THREE.Object3D): THREE.SkinnedMesh[] => {
      const out: THREE.SkinnedMesh[] = [];
      root.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh);
      });
      return out;
    };
    const sa = skinned(a);
    const sb = skinned(b);
    expect(sa.length).toBeGreaterThan(0);
    expect(sa.length).toBe(sb.length);
    expect(sa[0]!.geometry).toBe(sb[0]!.geometry);
    expect(sa[0]!.material).toBe(sb[0]!.material);
    expect(sa[0]!.skeleton).not.toBe(sb[0]!.skeleton);
    expect(sa[0]!.skeleton.bones[0]).not.toBe(sb[0]!.skeleton.bones[0]);
    sa[0]!.computeBoundingBox();
    expect(sa[0]!.boundingBox!.max.y).toBeLessThan(2);
    const head = skinned(a).map((m) => (m.computeBoundingBox(), m.boundingBox!.max.y));
    expect(Math.max(...head)).toBeGreaterThan(1.5);
    expect(Math.max(...head)).toBeLessThan(1.9);
  });

  it('keeps the wheels of a car as separate nodes at the socket positions', async () => {
    await loadAssetsFromDisk({ filter: (e) => e.id === 'veh.k.police' });
    const car = assets.clone('veh.k.police')!;
    car.updateMatrixWorld(true);
    const entry = assets.entry('veh.k.police')!;
    for (const [role, node] of Object.entries(entry.wheelNodes!)) {
      const wheel = car.getObjectByName(node)!;
      expect(wheel, `${role} wheel`).toBeDefined();
      const p = new THREE.Vector3().setFromMatrixPosition(wheel.matrixWorld);
      const socket = entry.sockets![`wheel${role.toUpperCase()}`]!;
      expect(p.distanceTo(new THREE.Vector3(...socket))).toBeLessThan(0.02);
    }
  });

  it('fits the vehicle to its normalised bounds: wheels on y = 0, +Z forward', async () => {
    await loadAssetsFromDisk({ filter: (e) => e.kind === 'vehicle' });
    for (const id of assets.ids('vehicle')) {
      const b = assets.bounds(id)!;
      expect(b.min[1], id).toBeCloseTo(0, 2);
      expect(Math.abs(b.max[0] + b.min[0]), id).toBeLessThan(0.05);
      expect(Math.abs(b.max[2] + b.min[2]), id).toBeLessThan(0.05);
      const sockets = assets.entry(id)!.sockets!;
      expect(sockets.wheelFL![2], id).toBeGreaterThan(sockets.wheelRL![2]);
      expect(sockets.wheelFL![0], id).toBeGreaterThan(0);
      expect(sockets.wheelFR![0], id).toBeLessThan(0);
    }
  });
});
