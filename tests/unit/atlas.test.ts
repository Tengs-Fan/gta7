// The atlas the attractions, farms, places and roadside oddities paint their boards on (render/city/attractions.ts Atlas): a
// fixed one fails the build rather than let a band run off its canvas; a growing one (the places') is as tall as its bands need,
// to a multiple of 512 px, and a band's v lands on the row it was painted on however much it grew after.

import { describe, expect, it, vi } from 'vitest';
import { Atlas } from '../../src/render/city/attractions';

await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

/** The row of a texture's canvas, from its top, that a v is sampled at once the texture's own transform is applied. */
const rowOf = (t: { repeat: { y: number }; offset: { y: number }; image: { height: number } }, v: number) => (1 - (t.repeat.y * v + t.offset.y)) * t.image.height;

describe('a fixed atlas', () => {
  it('measures v against its own height, and throws at a band that does not fit instead of painting it off the canvas', () => {
    const atlas = new Atlas(100);
    expect(atlas.band(60, () => {})).toEqual([0.4, 1]);
    expect(atlas.band(40, () => {})).toEqual([0, 0.4]);
    expect(() => atlas.band(1, () => {})).toThrow('The atlas is full: a band of 1 px at 100 of 100');
    expect(() => new Atlas(100).band(200, () => {})).toThrow(/atlas is full/);
    // And leaves its texture's uvs as they are.
    const t = atlas.texture();
    expect([t.repeat.x, t.repeat.y, t.offset.x, t.offset.y]).toEqual([1, 1, 0, 0]);
  });
});

describe('a growing atlas', () => {
  it('is as tall as its bands need, rounded up to a multiple of 512 px, its glow twin a quarter of that, and never throws for a board more', () => {
    const atlas = Atlas.growing();
    expect([atlas.canvas.height, atlas.glowCanvas.height]).toEqual([512, 128]);
    atlas.band(8, () => {});
    expect(atlas.canvas.height).toBe(512);
    for (let k = 0; k < 20; k++) atlas.band(300, () => {});
    // 8 + 20 * 300 = 6008 px of bands: twelve steps of 512, 6144.
    expect([atlas.canvas.height, atlas.glowCanvas.height, atlas.canvas.width, atlas.glowCanvas.width]).toEqual([6144, 1536, 1024, 256]);
    atlas.band(200, () => {});
    expect(atlas.canvas.height).toBe(6656);
  });

  it('keeps what it painted when it grows: each growth lays the old canvas on the new, the glow as well', () => {
    const drawn: Array<{ onto: unknown; what: unknown }> = [];
    const doc = (globalThis as unknown as { document: { createElement: (tag: string) => Record<string, unknown> } }).document;
    const make = doc.createElement;
    doc.createElement = (tag) => {
      const c = make(tag);
      const getContext = c.getContext as (kind: string) => Record<string, unknown>;
      c.getContext = (kind: string) => {
        const ctx = getContext(kind);
        ctx.drawImage = (what: unknown) => drawn.push({ onto: c, what });
        return ctx;
      };
      return c;
    };
    try {
      const atlas = Atlas.growing();
      const [first, glow] = [atlas.canvas, atlas.glowCanvas];
      atlas.band(400, () => {}, true);
      expect(drawn).toEqual([]);
      atlas.band(400, () => {}, true);
      expect(atlas.canvas.height).toBe(1024);
      expect(drawn).toEqual([{ onto: atlas.canvas, what: first }, { onto: atlas.glowCanvas, what: glow }]);
    } finally {
      doc.createElement = make;
    }
  });

  it('measures v against 16,384 px whatever it grows to, and its texture maps every band back onto the row it was painted on', () => {
    const atlas = Atlas.growing();
    const painted: Array<{ y: number; h: number; v: [number, number] }> = [];
    let y = 0;
    for (const h of [8, 300, 192, 512, 128, 320, 96, 700, 40, 1300]) {
      painted.push({ y, h, v: atlas.band(h, () => {}) });
      y += h;
    }
    expect(painted[0]!.v).toEqual([1 - 8 / 16384, 1]);
    expect(atlas.canvas.height).toBe(4096);
    for (const glow of [false, true]) {
      const t = atlas.texture(glow);
      expect(t.image.height).toBe(glow ? 1024 : 4096);
      for (const { y: top, h, v } of painted) {
        // The band's top row and its bottom row, as a fraction of the canvas that is the glow's too.
        const k = t.image.height / 4096;
        expect(rowOf(t, v[1])).toBeCloseTo(top * k, 6);
        expect(rowOf(t, v[0])).toBeCloseTo((top + h) * k, 6);
      }
    }
  });

  it('fails the build only past 16,384 px, where no board of the game will come', () => {
    const atlas = Atlas.growing();
    atlas.band(16000, () => {});
    expect(atlas.canvas.height).toBe(16384);
    expect(() => atlas.band(400, () => {})).toThrow('The atlas is full: a band of 400 px at 16000 of 16384');
  });
});
