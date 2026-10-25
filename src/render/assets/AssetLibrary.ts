// The asset library: models, textures and the HDRI listed in src/assets/manifest.json.
//
// Boot calls `preload` once, behind the loading screen. Afterwards every view asks synchronously (`model`, `clone`,
// `texture`, ...) and builds its procedural version when the answer is undefined: in Node tests (empty library), when
// a request failed, and on the software tier where a view chooses to. The library never throws and never changes
// after `preload` settles, so a response that arrives late cannot swap a model in the middle of play.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { AssetBackend } from './backend';
import { materialsOf } from './gltf';
import type { AssetKind, Manifest, ManifestEntry, ModelBounds } from './types';

/** Boot waits at most this long for assets; whatever has not arrived by then uses the procedural fallback. */
export const PRELOAD_TIMEOUT_MS = 12_000;
const CONCURRENCY = 8;

export interface ModelTemplate {
  entry: ManifestEntry;
  /** Shared by every clone: geometry, materials and skins are never mutated, clone before changing anything. */
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

export interface PreloadProgress {
  id: string;
  loadedBytes: number;
  totalBytes: number;
}

export interface PreloadReport {
  /** Entries in the manifest, the number loaded, and the ids that fell back (failed, timed out or never started). */
  manifest: number;
  loaded: number;
  failed: string[];
  timedOut: boolean;
  /** The manifest itself could not be read: the whole game uses procedural models. */
  manifestFailed: boolean;
  bytes: number;
  ms: number;
  decodeMs: number;
}

export type ProgressCallback = (fraction: number, info?: PreloadProgress) => void;

export interface PreloadOptions {
  backend: AssetBackend;
  timeoutMs?: number;
  /** Only these manifest entries are loaded (tests). */
  filter?: (entry: ManifestEntry) => boolean;
  concurrency?: number;
}

const EMPTY_REPORT = (): PreloadReport => ({ manifest: 0, loaded: 0, failed: [], timedOut: false, manifestFailed: false, bytes: 0, ms: 0, decodeMs: 0 });

function mark(name: string): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') performance.mark(name);
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class AssetLibrary {
  private manifestData: Manifest | null = null;
  private readonly entries = new Map<string, ManifestEntry>();
  private readonly models = new Map<string, ModelTemplate>();
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly failedIds = new Set<string>();
  private readonly warned = new Set<string>();
  private sealed = false;
  private loading: Promise<PreloadReport> | null = null;
  private lastReport: PreloadReport = EMPTY_REPORT();
  private warm: THREE.Group | null = null;

  /** True once `preload` has settled (also when nothing could be loaded). */
  get ready(): boolean {
    return this.sealed;
  }

  get report(): PreloadReport {
    return this.lastReport;
  }

  get manifest(): Manifest | null {
    return this.manifestData;
  }

  /** Loads everything the manifest lists. Resolves, never rejects, never takes longer than the timeout. */
  preload(onProgress: ProgressCallback | undefined, opts: PreloadOptions): Promise<PreloadReport> {
    if (this.loading) return this.loading;
    this.loading = this.run(onProgress, opts);
    return this.loading;
  }

  private async run(onProgress: ProgressCallback | undefined, opts: PreloadOptions): Promise<PreloadReport> {
    const { backend } = opts;
    const t0 = performance.now();
    mark('assets:preload-start');
    const abort = new AbortController();
    const report = EMPTY_REPORT();
    let decodeMs = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
        resolve();
      }, opts.timeoutMs ?? PRELOAD_TIMEOUT_MS);
    });
    const progressed = { last: 0 };
    const emit = (fraction: number, info?: PreloadProgress, force = false): void => {
      const f = Math.min(1, Math.max(progressed.last, fraction));
      if (f === progressed.last && !force) return;
      progressed.last = f;
      try {
        onProgress?.(f, info);
      } catch {
        // A faulty progress listener never blocks boot.
      }
    };
    emit(0, undefined, true);

    const work = (async () => {
      let manifest: Manifest;
      try {
        manifest = await backend.manifest(abort.signal);
      } catch (e) {
        report.manifestFailed = true;
        this.warnOnce('manifest', `GTA7 assets: manifest unavailable (${reasonOf(e)}); using the procedural models`);
        return;
      }
      if (this.sealed) return;
      const list = manifest.entries.filter((e) => !opts.filter || opts.filter(e));
      this.manifestData = { version: manifest.version, entries: list };
      for (const e of list) this.entries.set(e.id, e);
      report.manifest = list.length;
      const total = list.reduce((sum, e) => sum + Math.max(1, e.bytes), 0);
      const done = new Map<string, number>();
      const sum = (): number => {
        let s = 0;
        for (const v of done.values()) s += v;
        return s;
      };
      const queue = list.slice();
      const worker = async (): Promise<void> => {
        for (let entry = queue.shift(); entry && !abort.signal.aborted; entry = queue.shift()) {
          const weight = Math.max(1, entry.bytes);
          try {
            const data = await backend.fetch(entry, (loaded) => {
              if (this.sealed) return;
              done.set(entry!.id, Math.min(weight, loaded));
              emit(sum() / total, { id: entry!.id, loadedBytes: sum(), totalBytes: total });
            }, abort.signal);
            if (abort.signal.aborted) return;
            const d0 = performance.now();
            const decoded = await backend.decode(entry, data);
            decodeMs += performance.now() - d0;
            if (abort.signal.aborted || this.sealed) return;
            if (decoded.type === 'model') this.models.set(entry.id, { entry, scene: decoded.scene, animations: decoded.animations });
            else this.textures.set(entry.id, decoded.texture);
            report.bytes += data.byteLength;
          } catch (e) {
            if (abort.signal.aborted) return;
            this.failedIds.add(entry.id);
            this.warnOnce(entry.id, `GTA7 assets: ${entry.id} failed (${reasonOf(e)}); using the procedural model`);
          }
          done.set(entry.id, weight);
          emit(sum() / total, { id: entry.id, loadedBytes: sum(), totalBytes: total }, true);
        }
      };
      await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? CONCURRENCY, queue.length) }, worker));
    })();

    await Promise.race([work.catch(() => undefined), timeout]);
    clearTimeout(timer);
    // From here on nothing is added: a late response is dropped (and aborted when it can be).
    this.sealed = true;
    abort.abort();
    report.timedOut = timedOut;
    for (const e of this.entries.values()) {
      if (this.models.has(e.id) || this.textures.has(e.id)) continue;
      if (!this.failedIds.has(e.id)) {
        this.failedIds.add(e.id);
        if (timedOut) this.warnOnce(e.id, `GTA7 assets: ${e.id} timed out; using the procedural model`);
      }
    }
    report.loaded = this.models.size + this.textures.size;
    report.failed = [...this.failedIds].sort();
    report.ms = performance.now() - t0;
    report.decodeMs = decodeMs;
    mark('assets:preload-end');
    if (typeof performance.measure === 'function') {
      try {
        performance.measure('assets:preload', 'assets:preload-start', 'assets:preload-end');
      } catch {
        // Marks are cleared by some tools.
      }
    }
    this.lastReport = report;
    emit(1, undefined, true);
    return report;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }

  has(id: string): boolean {
    return this.models.has(id) || this.textures.has(id);
  }

  entry(id: string): ManifestEntry | undefined {
    return this.entries.get(id);
  }

  /** Ids of loaded assets, optionally of one kind. */
  ids(kind?: AssetKind): string[] {
    const out: string[] = [];
    for (const id of [...this.models.keys(), ...this.textures.keys()]) if (!kind || this.entries.get(id)?.kind === kind) out.push(id);
    return out.sort();
  }

  /** The loaded model, or undefined (not loaded, failed, wrong id): build the procedural version. */
  model(id: string): ModelTemplate | undefined {
    return this.models.get(id);
  }

  texture(id: string): THREE.Texture | undefined {
    return this.textures.get(id);
  }

  /** A fresh copy of a loaded model (skeletons rebound), sharing geometry and materials. Undefined when not loaded. */
  clone(id: string): THREE.Object3D | undefined {
    const t = this.models.get(id);
    return t ? SkeletonUtils.clone(t.scene) : undefined;
  }

  /** The model's footprint from the manifest, or undefined. */
  bounds(id: string): ModelBounds | undefined {
    const b = this.entries.get(id)?.bounds;
    return b && 'min' in b ? b : undefined;
  }

  socket(id: string, name: string): [number, number, number] | undefined {
    return this.entries.get(id)?.sockets?.[name];
  }

  /**
   * Like `model`, but an id the manifest does not know (a typo in a view) is reported once. A missing or failed asset
   * stays silent here: the loader already reported it.
   */
  use(id: string): ModelTemplate | undefined {
    const t = this.models.get(id);
    if (!t && this.manifestData && !this.entries.has(id)) this.warnOnce(`unknown:${id}`, `GTA7 assets: unknown asset id ${id}; using the procedural model`);
    return t;
  }

  /** Every material of every loaded model, once. */
  materials(): THREE.Material[] {
    const out = new Set<THREE.Material>();
    for (const t of this.models.values()) for (const m of materialsOf(t.scene)) out.add(m);
    return [...out];
  }

  /**
   * One clone of every loaded model, parked below the map. The renderer adds it to the scene while it compiles shaders
   * so the first use of an asset costs no program build; it is not part of the scene during play. Cached once the
   * preload has settled, so a second warm-up (tier switch, context restore) reuses the same objects; a group built
   * while models are still arriving is not cached, or the models that land later would never be warmed.
   */
  warmGroup(): THREE.Group {
    if (this.warm) return this.warm;
    const group = new THREE.Group();
    group.name = 'asset-warmup';
    group.position.set(0, -60, 0);
    for (const id of this.models.keys()) {
      const copy = this.clone(id);
      if (!copy) continue;
      copy.traverse((o) => {
        o.frustumCulled = false;
      });
      group.add(copy);
    }
    if (this.sealed) this.warm = group;
    return group;
  }

  /** Test hook: forgets everything, including the warm-up group. */
  clear(): void {
    this.manifestData = null;
    this.entries.clear();
    this.models.clear();
    this.textures.clear();
    this.failedIds.clear();
    this.warned.clear();
    this.warm = null;
    this.sealed = false;
    this.loading = null;
    this.lastReport = EMPTY_REPORT();
  }
}

/** The library the game uses. */
export const assets = new AssetLibrary();
