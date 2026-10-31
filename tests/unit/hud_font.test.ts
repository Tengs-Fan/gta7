// The HUD's Chinese font (src/ui/fonts/noto-sans-tc-subset.woff2, built by scripts/assets/font.py): every character
// beyond ASCII the radio line can show (a station's name and tag, its hits, the words of its deep cuts) is in the
// font's character map and in the unicode-range style.css loads it for.

import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { STATIONS } from '../../src/audio/radio';
import { CUTS, HITS } from '../../src/audio/stations/playlists';

/** The characters a WOFF2 font maps: its cmap's Windows Unicode BMP subtable (format 4). */
function fontChars(file: string): Set<number> {
  const b = readFileSync(file);
  expect(b.toString('ascii', 0, 4)).toBe('wOF2');
  // The table directory: a flags byte (the table's index among the known tags, cmap being 0, glyf and loca 10 and 11;
  // 63 for a tag spelled out after it) and the lengths as UIntBase128.
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (;;) {
      const x = b[p++]!;
      v = v * 128 + (x & 0x7f);
      if (!(x & 0x80)) return v;
    }
  };
  let at = 0;
  let cmap = -1;
  for (let i = 0; i < b.readUInt16BE(12); i++) {
    const flags = b[p++]!;
    const index = flags & 0x3f;
    if (index === 63) p += 4;
    const length = base128();
    const transformed = index === 10 || index === 11 ? flags >> 6 === 0 : flags >> 6 !== 0;
    if (index === 0) cmap = at;
    at += transformed ? base128() : length;
  }
  // The tables, run together in the directory's order, as one Brotli stream.
  const t = brotliDecompressSync(b.subarray(p, p + b.readUInt32BE(20)));
  let sub = -1;
  for (let i = 0; i < t.readUInt16BE(cmap + 2); i++) {
    const r = cmap + 4 + i * 8;
    if (t.readUInt16BE(r) === 3 && t.readUInt16BE(r + 2) === 1) sub = cmap + t.readUInt32BE(r + 4);
  }
  expect(t.readUInt16BE(sub)).toBe(4);
  const segs = t.readUInt16BE(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const ranges = deltas + segs * 2;
  const out = new Set<number>();
  for (let s = 0; s < segs; s++) {
    const [end, start, delta, range] = [ends, starts, deltas, ranges].map((a) => t.readUInt16BE(a + s * 2)) as [number, number, number, number];
    for (let c = start; c <= end && c !== 0xffff; c++) {
      const g = range === 0 ? c : t.readUInt16BE(ranges + s * 2 + range + (c - start) * 2);
      if (g !== 0 && (g + delta) % 0x10000 !== 0) out.add(c);
    }
  }
  return out;
}

/** Every character beyond ASCII the radio line can show. */
function shown(): Set<number> {
  const texts = [...STATIONS.flatMap((s) => [s.name, s.tag]), ...Object.values(HITS).flatMap((hits) => hits.flatMap((h) => [h.artist, h.title])), ...Object.values(CUTS).flatMap((c) => [...c.artist, ...c.title].flat())];
  return new Set([...texts.join('')].map((c) => c.codePointAt(0)!).filter((c) => c > 0x7f));
}

describe('the HUD font for Chinese', () => {
  it('has every character beyond ASCII the radio line can show, and style.css loads it for each of them', () => {
    const chars = shown();
    // 月光電台's name, tag, hits and deep cuts.
    expect(chars.size).toBeGreaterThan(100);
    const font = fontChars('src/ui/fonts/noto-sans-tc-subset.woff2');
    expect([...chars].filter((c) => !font.has(c)).map((c) => String.fromCodePoint(c))).toEqual([]);
    const face = /@font-face\s*{[^}]*'Noto Sans TC Subset'[^}]*}/.exec(readFileSync('src/ui/style.css', 'utf8'))![0];
    expect(face).toContain("url('./fonts/noto-sans-tc-subset.woff2')");
    const range = /unicode-range:([^;]+);/.exec(face)![1]!.split(',').map((r) => r.trim().slice(2).split('-').map((h) => parseInt(h, 16)));
    expect([...chars].filter((c) => !range.some(([lo, hi]) => c >= lo! && c <= (hi ?? lo)!)).map((c) => String.fromCodePoint(c))).toEqual([]);
  });

  it('is named with its license in LICENSES-ASSETS.md', () => {
    expect(readFileSync('LICENSES-ASSETS.md', 'utf8')).toMatch(/^\| Noto Sans CJK TC Bold [\d.]+ \| .+ \| https:\/\/github\.com\/notofonts\/noto-cjk \| SIL Open Font License 1\.1 \| src\/ui\/fonts\/noto-sans-tc-subset\.woff2 \|$/m);
  });

  it('reads a character map: the font has the Chinese it was cut to and nothing it was not', () => {
    const font = fontChars('src/ui/fonts/noto-sans-tc-subset.woff2');
    for (const c of '月光電台陪你到天亮，（）') expect(font.has(c.codePointAt(0)!), c).toBe(true);
    for (const c of '日本한국어A') expect(font.has(c.codePointAt(0)!), c).toBe(false);
  });
});
