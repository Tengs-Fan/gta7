// User settings and save-game persistence (localStorage, defensively guarded).

import { DEFAULT_BINDINGS, parseBindings, type KeyBindings } from './input/bindings';
import type { QualitySetting } from './render/quality';
import { parseSave, type SaveData } from './sim/progress';
import type { WeatherMode } from './sim/weather';

export interface Settings {
  /** 'auto' follows the tier picked from the GPU at boot. */
  quality: QualitySetting;
  master: number;
  music: number;
  sfx: number;
  sensitivity: number;
  invertY: boolean;
  fov: number;
  /** Contextual tutorial hints and the steal prompt. */
  hints: boolean;
  /** Hints already shown once (ids from src/ui/hints.ts). Replaced, never changed in place. */
  hintsSeen: readonly string[];
  /** 'dynamic' follows the forecast; 'clear' keeps clear skies. */
  weather: WeatherMode;
  /** The sky and light flash of lightning (off for photosensitivity; the storm and its thunder go on). */
  lightningFlashes: boolean;
  /** The keyboard actions' keys (see input/bindings.ts). */
  bindings: KeyBindings;
  /** Resolution scale, 0.5-1 in RESOLUTION_STEP steps: multiplies the quality tier's own pixel ratio. */
  resolutionScale: number;
  /** Frames per second at most: 30, 60, or 0 for no cap (the display's refresh rate). */
  fpsCap: FpsCap;
  subtitleSize: SubtitleSize;
  /** Blast shake and crash kicks of the camera. */
  cameraShake: boolean;
  /** Map legend categories switched off or on by the player (absent: on). */
  mapLayers: Readonly<Record<string, boolean>>;
}

export type FpsCap = 0 | 30 | 60;
export const FPS_CAPS: readonly FpsCap[] = [30, 60, 0];
export type SubtitleSize = 'small' | 'normal' | 'large';
export const SUBTITLE_SIZES: readonly SubtitleSize[] = ['small', 'normal', 'large'];
export const RESOLUTION_STEP = 0.05;

export const DEFAULT_SETTINGS: Settings = {
  quality: 'auto',
  master: 0.8,
  music: 0.6,
  sfx: 0.85,
  sensitivity: 1,
  invertY: false,
  fov: 68,
  hints: true,
  hintsSeen: [],
  weather: 'dynamic',
  lightningFlashes: true,
  bindings: DEFAULT_BINDINGS,
  resolutionScale: 1,
  fpsCap: 0,
  subtitleSize: 'normal',
  cameraShake: true,
  mapLayers: {},
};

/** A stored resolution scale: 0.5-1 on a RESOLUTION_STEP step, else the default (a typo, 10%, is not clamped into range). */
function resolutionScale(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.5 - 1e-9 || v > 1 + 1e-9) return DEFAULT_SETTINGS.resolutionScale;
  return Math.round(v / RESOLUTION_STEP) * RESOLUTION_STEP;
}

/** At most this many map legend toggles are kept. */
const MAX_MAP_LAYERS = 32;

function mapLayers(v: unknown): Record<string, boolean> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, on] of Object.entries(v as Record<string, unknown>).slice(0, MAX_MAP_LAYERS)) if (/^[a-z][a-zA-Z0-9_-]{0,31}$/.test(k) && typeof on === 'boolean') out[k] = on;
  return out;
}

/** At most this many hint ids are kept: a corrupt or hand-edited file can't grow without bound. */
export const MAX_HINTS_SEEN = 50;

/** The distinct, plausible hint ids of a saved list, capped at MAX_HINTS_SEEN. */
function hintIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const ok = v.filter((x): x is string => typeof x === 'string' && /^[a-z][a-z0-9:_-]{0,31}$/i.test(x));
  return [...new Set(ok)].slice(0, MAX_HINTS_SEEN);
}

const SETTINGS_KEY = 'gta7.settings.v1';
const SAVE_KEY = 'gta7.save.v1';

/**
 * The page's localStorage, or null where there is none. Reading the property throws a SecurityError
 * where site data is blocked. Nothing is written to test it: a full origin (several games on one
 * itch.io or github.io origin) refuses only writes that grow it, while reads, same-size rewrites and
 * removals still work, so a test write would hide a save that is still there.
 */
function storage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether a failed write means the origin's storage quota is used up (names and codes differ by browser). */
function quotaExceeded(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name, code } = err as { name?: unknown; code?: unknown };
  return (typeof name === 'string' && /quota/i.test(name)) || code === 22 || code === 1014;
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(storage()?.getItem(SETTINGS_KEY) ?? 'null') as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
    const q = raw.quality;
    return {
      quality: q === 'auto' || q === 'low' || q === 'medium' || q === 'high' ? q : DEFAULT_SETTINGS.quality,
      master: clampNum(raw.master, 0, 1, DEFAULT_SETTINGS.master),
      music: clampNum(raw.music, 0, 1, DEFAULT_SETTINGS.music),
      sfx: clampNum(raw.sfx, 0, 1, DEFAULT_SETTINGS.sfx),
      sensitivity: clampNum(raw.sensitivity, 0.2, 3, DEFAULT_SETTINGS.sensitivity),
      invertY: raw.invertY === true,
      fov: clampNum(raw.fov, 55, 90, DEFAULT_SETTINGS.fov),
      // Files from before hints existed lack both fields: hints on, nothing seen yet.
      hints: typeof raw.hints === 'boolean' ? raw.hints : DEFAULT_SETTINGS.hints,
      hintsSeen: hintIds(raw.hintsSeen),
      weather: raw.weather === 'clear' || raw.weather === 'dynamic' ? raw.weather : DEFAULT_SETTINGS.weather,
      lightningFlashes: typeof raw.lightningFlashes === 'boolean' ? raw.lightningFlashes : DEFAULT_SETTINGS.lightningFlashes,
      // Files from before wave 1 lack these: defaults.
      bindings: parseBindings(raw.bindings),
      resolutionScale: resolutionScale(raw.resolutionScale),
      fpsCap: FPS_CAPS.includes(raw.fpsCap as FpsCap) ? (raw.fpsCap as FpsCap) : DEFAULT_SETTINGS.fpsCap,
      subtitleSize: SUBTITLE_SIZES.includes(raw.subtitleSize as SubtitleSize) ? (raw.subtitleSize as SubtitleSize) : DEFAULT_SETTINGS.subtitleSize,
      cameraShake: typeof raw.cameraShake === 'boolean' ? raw.cameraShake : DEFAULT_SETTINGS.cameraShake,
      mapLayers: mapLayers(raw.mapLayers),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    storage()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: settings simply won't persist.
  }
}

export function loadGame(): SaveData | null {
  try {
    return parseSave(JSON.parse(storage()?.getItem(SAVE_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

/**
 * Writes the save game. Returns null once it is stored, else a line for the player saying why it was
 * not: the origin's storage is full (the save that was there stays as it was), or there is none.
 */
export function storeGame(data: SaveData): string | null {
  const s = storage();
  if (!s) return 'Could not save: browser storage is unavailable';
  try {
    s.setItem(SAVE_KEY, JSON.stringify(data));
    return null;
  } catch (err) {
    return quotaExceeded(err) ? 'Could not save: browser storage is full' : 'Could not save: browser storage is unavailable';
  }
}

/** Writes the save game; false when it could not be stored (see storeGame for why). */
export function writeGame(data: SaveData): boolean {
  return storeGame(data) === null;
}

export function deleteGame(): void {
  try {
    storage()?.removeItem(SAVE_KEY);
  } catch {
    // Removing needs no quota: only blocked storage throws here, and loadGame finds no save there either.
  }
}
