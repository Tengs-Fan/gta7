// Boot order and the loading screen's bar: fonts, then the asset preload, then the game.
import { describe, expect, it, vi } from 'vitest';
import { runBoot, type BootSteps } from '../../src/boot';
import { loadingMarkup, setLoadingProgress } from '../../src/loadingScreen';
import { AssetLibrary } from '../../src/render/assets/AssetLibrary';
import type { AssetBackend } from '../../src/render/assets/backend';

function steps(log: string[], over: Partial<BootSteps> = {}): BootSteps {
  return {
    showLoading: () => (log.push('loading'), true),
    fonts: async () => void log.push('fonts'),
    assets: async (p) => {
      log.push('assets');
      p(0.5);
    },
    onProgress: (f) => log.push(`progress ${f}`),
    paint: async () => void log.push('paint'),
    startGame: () => void log.push('game'),
    ...over,
  };
}

describe('runBoot', () => {
  it('shows the loading screen, then fonts, then assets, then paints, then builds the game', async () => {
    const log: string[] = [];
    await runBoot(steps(log));
    expect(log).toEqual(['loading', 'fonts', 'assets', 'progress 0.5', 'progress 1', 'paint', 'game']);
  });

  it('builds the game only after a slow preload has settled', async () => {
    const log: string[] = [];
    let finish!: () => void;
    const slow = new Promise<void>((r) => (finish = r));
    const done = runBoot(steps(log, { assets: async () => (log.push('assets start'), await slow, void log.push('assets end')) }));
    await Promise.resolve();
    await Promise.resolve();
    expect(log).not.toContain('game');
    finish();
    await done;
    expect(log.indexOf('assets end')).toBeLessThan(log.indexOf('game'));
  });

  it('stops when the loading screen reports an unsupported browser', async () => {
    const log: string[] = [];
    expect(await runBoot(steps(log, { showLoading: () => false }))).toBe(false);
    expect(log).toEqual([]);
  });
});

describe('loading bar', () => {
  function fakeUi() {
    const fill = { style: { width: '0%' } as Record<string, string> };
    const attrs: Record<string, string> = {};
    const bar = { dataset: {} as Record<string, string>, setAttribute: (k: string, v: string) => (attrs[k] = v), querySelector: () => fill };
    const ui = { querySelector: () => bar };
    return { ui: ui as unknown as ParentNode, fill, attrs, bar };
  }

  it('markup starts at 0% with a progressbar role', () => {
    expect(loadingMarkup()).toContain('role="progressbar"');
    expect(loadingMarkup()).toContain('width:0%');
    expect(loadingMarkup()).toContain('LOADING SAN AZURA');
  });

  it('follows the real preload: the fill never decreases and takes several values', async () => {
    const { ui, fill, bar } = fakeUi();
    const widths: number[] = [];
    const lib = new AssetLibrary();
    const backend: AssetBackend = {
      manifest: async () => ({ version: 1, entries: ['a', 'b', 'c', 'd'].map((id) => ({ id, file: id, kind: 'prop' as const, bytes: 1000, bounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] }, license: 'x' })) }),
      fetch: async (e, onBytes) => (onBytes(e.bytes / 2), onBytes(e.bytes), new ArrayBuffer(e.bytes)),
      decode: async () => ({ type: 'model', scene: new (await import('three')).Group(), animations: [] }),
    };
    await runBoot(steps([], {
      assets: (p) => lib.preload(p, { backend }),
      onProgress: (f) => {
        setLoadingProgress(ui, f);
        widths.push(parseFloat(fill.style.width!));
      },
    }));
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThanOrEqual(widths[i - 1]!);
    expect(new Set(widths).size).toBeGreaterThanOrEqual(3);
    expect(widths[0]).toBe(0);
    expect(widths[widths.length - 1]).toBe(100);
    expect(bar.dataset.progress).toBe('100');
  });

  it('clamps and ignores a missing bar', () => {
    const { ui, fill } = fakeUi();
    setLoadingProgress(ui, 2);
    expect(fill.style.width).toBe('100%');
    setLoadingProgress(ui, -1);
    expect(fill.style.width).toBe('0%');
    expect(() => setLoadingProgress({ querySelector: () => null } as unknown as ParentNode, 0.5)).not.toThrow();
    vi.restoreAllMocks();
  });
});
