// User settings and save-game persistence (localStorage, defensively guarded).

import type { Quality } from './render/renderer';
import { parseSave, type SaveData } from './sim/progress';

export interface Settings {
  quality: Quality;
  master: number;
  music: number;
  sfx: number;
  sensitivity: number;
  invertY: boolean;
  fov: number;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  master: 0.8,
  music: 0.6,
  sfx: 0.85,
  sensitivity: 1,
  invertY: false,
  fov: 68,
};

const SETTINGS_KEY = 'gta7.settings.v1';
const SAVE_KEY = 'gta7.save.v1';

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__gta7_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

export function loadSettings(): Settings {
  const s = storage();
  if (!s) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(s.getItem(SETTINGS_KEY) ?? 'null') as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
    const q = raw.quality;
    return {
      quality: q === 'low' || q === 'medium' || q === 'high' ? q : DEFAULT_SETTINGS.quality,
      master: clampNum(raw.master, 0, 1, DEFAULT_SETTINGS.master),
      music: clampNum(raw.music, 0, 1, DEFAULT_SETTINGS.music),
      sfx: clampNum(raw.sfx, 0, 1, DEFAULT_SETTINGS.sfx),
      sensitivity: clampNum(raw.sensitivity, 0.2, 3, DEFAULT_SETTINGS.sensitivity),
      invertY: raw.invertY === true,
      fov: clampNum(raw.fov, 55, 90, DEFAULT_SETTINGS.fov),
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
  const s = storage();
  if (!s) return null;
  try {
    return parseSave(JSON.parse(s.getItem(SAVE_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

export function writeGame(data: SaveData): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(SAVE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function deleteGame(): void {
  try {
    storage()?.removeItem(SAVE_KEY);
  } catch {
    // ignore
  }
}
