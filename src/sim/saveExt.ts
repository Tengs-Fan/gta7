// Save extensions: modules persist their own state under `SaveData.ext[key]` without touching the v1 core.
// A codec validates its own entry on load; anything it rejects is dropped and the module keeps its defaults.

import type { Sim } from './sim';

export interface SaveCodec<T = unknown> {
  /** The key in `SaveData.ext`. */
  key: string;
  /** JSON-safe state of the module right now. Return undefined to leave the key out. */
  serialize(sim: Sim): unknown;
  /** Validates untrusted JSON; undefined means unusable (the entry is ignored). */
  parse(raw: unknown): T | undefined;
  /** Puts parsed state into a fresh sim. Only called with what `parse` returned. */
  apply(sim: Sim, value: T): void;
}

const codecs: Array<SaveCodec<any>> = [];

/** Registration order is the order entries are applied in. A key can have one codec. */
export function registerSaveCodec<T>(codec: SaveCodec<T>): void {
  if (codecs.some((c) => c.key === codec.key)) throw new Error(`save codec already registered: ${codec.key}`);
  codecs.push(codec);
}

export function unregisterSaveCodec(key: string): void {
  const i = codecs.findIndex((c) => c.key === key);
  if (i >= 0) codecs.splice(i, 1);
}

export function saveCodecKeys(): string[] {
  return codecs.map((c) => c.key);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function jsonCopy(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Validates the `ext` of untrusted save JSON. A registered key keeps only what its codec parsed;
 * keys nobody registered (a newer build wrote them) are kept as they are so saving again does not lose them.
 * Returns undefined when there is no usable ext object.
 */
export function parseExt(raw: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(raw)) {
    const codec = codecs.find((c) => c.key === key);
    try {
      if (!codec) {
        if (value !== undefined) entries.push([key, jsonCopy(value)]);
        continue;
      }
      const parsed = codec.parse(value);
      if (parsed !== undefined) entries.push([key, parsed]);
    } catch {
      // A corrupt entry never costs the player the core save.
    }
  }
  return Object.fromEntries(entries);
}

/** Unknown keys of the save the sim was loaded from, written back by serializeExt. */
const carried = new WeakMap<Sim, Record<string, unknown>>();

/** Applies a parsed `ext` to a fresh sim and remembers its unknown keys. */
export function applyExt(sim: Sim, ext: Record<string, unknown> | undefined): void {
  if (!ext) return;
  const unknown: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(ext)) {
    const codec = codecs.find((c) => c.key === key);
    if (!codec) {
      unknown.push([key, value]);
      continue;
    }
    try {
      codec.apply(sim, value);
    } catch {
      // A module that cannot take its state keeps its defaults.
    }
  }
  carried.set(sim, Object.fromEntries(unknown));
}

/** The `ext` to write: carried unknown keys first, then every codec's current state (which wins on a clash). */
export function serializeExt(sim: Sim): Record<string, unknown> | undefined {
  const entries: Array<[string, unknown]> = Object.entries(carried.get(sim) ?? {});
  for (const codec of codecs) {
    let value: unknown;
    try {
      value = codec.serialize(sim);
    } catch {
      continue;
    }
    if (value === undefined) continue;
    const at = entries.findIndex(([k]) => k === codec.key);
    if (at >= 0) entries.splice(at, 1);
    entries.push([codec.key, value]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
