// Foundations: registerDebug adds window.__gta7.ext.<name> without touching the existing debug hooks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Game } from '../../src/game';

// Hooks and state() fields at the baseline (72d0b98); `ext` is the only addition.
const BASELINE_KEYS = [
  'game', 'sim', 'newGame', 'startStreetRun', 'state', 'teleport', 'spawnVehicle', 'give', 'setWanted', 'setTime', 'setPost',
  'setWeather', 'weather', 'clearWeather', 'lightning', 'forceWeather', 'setClockRate', 'envStats', 'godMode', 'startMission',
  'markDone', 'poi', 'setCamera', 'samplePixels', 'place', 'spawnPedAhead', 'characterAlive',
];
const BASELINE_STATE_KEYS = [
  'mode', 'crashed', 'fps', 'frames', 'menuOpen', 'player', 'wanted', 'money', 'mission', 'objective',
  'missionsDone', 'activity', 'activityStatus', 'hours', 'vehicles', 'police', 'characters', 'deathKind', 'render', 'perf',
];

function fakeGame(): Game {
  const player = { state: 'walking', health: 100, armor: 0, inventory: { current: 'fist' }, vehicle: null, speed: 0 };
  const sim = {
    player,
    playerPos: () => ({ x: 1, y: 2, z: 3 }),
    events: { errors: 0 },
    wanted: { level: 0 },
    progress: { money: 0, missionsDone: new Set<string>() },
    missions: { active: null },
    activities: { job: null, status: () => null },
    clock: { hours: 12 },
    vehicles: [],
    characters: [],
    deathKind: null,
  };
  return {
    sim,
    mode: 'playing',
    isCrashed: false,
    fps: 60,
    frames: 1,
    menus: { open: false },
    renderer: { stats: () => ({}), currentQuality: 'high', post: true, software: false, msaa: true },
    perf: {},
  } as unknown as Game;
}

let win: Record<string, unknown>;

async function load() {
  vi.resetModules();
  return import('../../src/debug');
}

const api = () => win.__gta7 as Record<string, unknown> & { ext: Record<string, unknown>; state(): Record<string, unknown> };

describe('registerDebug', () => {
  beforeEach(() => {
    win = {};
    vi.stubGlobal('window', win);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the baseline hooks and state() fields, and adds only an ext object', async () => {
    const { installDebugApi } = await load();
    installDebugApi(fakeGame());
    expect(Object.keys(api()).filter((k) => k !== 'ext').sort()).toEqual([...BASELINE_KEYS].sort());
    expect(api().ext).toEqual({});
    expect(Object.keys(api().state()).sort()).toEqual([...BASELINE_STATE_KEYS].sort());
  });

  it('exposes an API registered before install', async () => {
    const { installDebugApi, registerDebug } = await load();
    const feature = { ping: () => 'pong' };
    registerDebug('feature', feature);
    installDebugApi(fakeGame());
    expect(api().ext.feature).toBe(feature);
  });

  it('exposes an API registered after install', async () => {
    const { installDebugApi, registerDebug } = await load();
    installDebugApi(fakeGame());
    const feature = { ping: () => 'pong' };
    registerDebug('feature', feature);
    expect(api().ext.feature).toBe(feature);
  });

  it('replaces an earlier registration of the same name, before or after install', async () => {
    const { installDebugApi, registerDebug } = await load();
    registerDebug('feature', 1);
    registerDebug('feature', 2);
    installDebugApi(fakeGame());
    expect(api().ext.feature).toBe(2);
    registerDebug('feature', 3);
    expect(api().ext.feature).toBe(3);
    registerDebug('other', 'x');
    expect(Object.keys(api().ext).sort()).toEqual(['feature', 'other']);
  });

  it('leaves the existing hooks in place after registrations', async () => {
    const { installDebugApi, registerDebug } = await load();
    registerDebug('a', {});
    installDebugApi(fakeGame());
    registerDebug('b', {});
    expect(Object.keys(api()).filter((k) => k !== 'ext').sort()).toEqual([...BASELINE_KEYS].sort());
  });
});
