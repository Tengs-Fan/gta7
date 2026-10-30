// The committed assets under src/assets: optimised formats, a complete manifest, bone maps and sockets.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { atlases, CHARACTER_BONES, SPEC_DIMS } from '../../scripts/assets/catalog.mjs';
import { VEHICLE_SPECS } from '../../src/sim/specs';
import { CHARACTER_JOINTS, parseManifest, WHEEL_SOCKETS, type ManifestEntry } from '../../src/render/assets/types';

const ROOT = join(process.cwd(), 'src/assets');
const manifest = parseManifest(JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [relative(ROOT, full).split(sep).join('/')];
  });
}

interface Glb {
  json: { extensionsUsed?: string[]; extensionsRequired?: string[]; images?: Array<{ mimeType?: string; bufferView?: number; uri?: string }>; bufferViews?: Array<{ byteOffset?: number; byteLength: number }>; nodes?: Array<{ name?: string }>; skins?: unknown[]; animations?: Array<{ name?: string }> };
  bin: Buffer;
}

function readGlb(file: string): Glb {
  const buf = readFileSync(join(ROOT, file));
  expect(buf.readUInt32LE(0)).toBe(0x46546c67);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen;
  const bin = binStart < buf.length ? buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart)) : Buffer.alloc(0);
  return { json, bin };
}

const glbEntries = manifest.entries.filter((e) => e.file.endsWith('.glb'));
const dims = (e: ManifestEntry) => e.bounds as { width: number; height: number };

describe('manifest', () => {
  it('has a unique id and an existing file for every entry, and an entry for every file', () => {
    const ids = new Set<string>();
    for (const e of manifest.entries) {
      expect(ids.has(e.id), `duplicate ${e.id}`).toBe(false);
      ids.add(e.id);
      expect(typeof e.file).toBe('string');
      expect(typeof e.kind).toBe('string');
      expect(e.bounds, e.id).toBeTruthy();
      expect(typeof e.license, e.id).toBe('string');
      expect(statSync(join(ROOT, e.file)).size, `${e.id} bytes`).toBe(e.bytes);
    }
    // speech/ is the speech build's, checked by speech.test.ts.
    const files = filesUnder(ROOT).filter((f) => f !== 'manifest.json' && !f.startsWith('speech/')).sort();
    expect(files).toEqual(manifest.entries.map((e) => e.file).sort());
    console.log(`manifest check: ${manifest.entries.length} entries, ${files.length} files`);
  });

  it('keeps every file under 5 MB and the whole set within the budget', () => {
    let total = 0;
    for (const e of manifest.entries) {
      expect(e.bytes, e.id).toBeLessThan(5_000_000);
      total += e.bytes;
    }
    expect(total).toBeLessThan(30_000_000);
  });

  it('is sorted and has only models, textures and the sky in their folders', () => {
    const ids = manifest.entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
    for (const e of manifest.entries) {
      if (e.kind === 'texture') expect(e.file).toMatch(/^textures\/[^/]+\/[a-z]+\.webp$/);
      else if (e.kind === 'env') expect(e.file).toMatch(/^env\/.+\.hdr$/);
      else expect(e.file).toMatch(/^models\/.+\.glb$/);
    }
  });
});

describe('GLB files', () => {
  it('are meshopt-compressed and carry only WebP images no larger than 1024 px', async () => {
    let images = 0;
    for (const e of glbEntries) {
      const { json, bin } = readGlb(e.file);
      expect(json.extensionsUsed, e.id).toContain('EXT_meshopt_compression');
      for (const img of json.images ?? []) {
        images++;
        expect(img.uri, `${e.id} external image`).toBeUndefined();
        expect(img.mimeType, e.id).toBe('image/webp');
        const view = json.bufferViews![img.bufferView!]!;
        const meta = await sharp(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)).metadata();
        expect(meta.format, e.id).toBe('webp');
        expect(Math.max(meta.width!, meta.height!), e.id).toBeLessThanOrEqual(1024);
      }
    }
    expect(glbEntries.length).toBeGreaterThan(50);
    expect(images).toBeGreaterThan(20);
  });

  it('standalone textures are WebP, at most 1024 px, with the size the manifest records', async () => {
    const textures = manifest.entries.filter((e) => e.kind === 'texture');
    expect(textures.length).toBeGreaterThan(30);
    for (const e of textures) {
      expect(e.file.endsWith('.webp')).toBe(true);
      const meta = await sharp(join(ROOT, e.file)).metadata();
      expect(meta.format, e.id).toBe('webp');
      expect(Math.max(meta.width!, meta.height!), e.id).toBeLessThanOrEqual(1024);
      expect([meta.width, meta.height], e.id).toEqual([dims(e).width, dims(e).height]);
    }
  });

  it('every PBR set has albedo, normal and orm maps of one size', () => {
    const sets = new Map<string, ManifestEntry[]>();
    // Alpha atlases (the leaf cards) are a single albedo-with-alpha map, not PBR sets; checked below.
    const alpha = new Set(atlases.map((a) => a.set));
    for (const e of manifest.entries.filter((x) => x.kind === 'texture' && !alpha.has(x.set!))) sets.set(e.set!, [...(sets.get(e.set!) ?? []), e]);
    for (const [set, maps] of sets) {
      const names = maps.map((m) => m.map);
      expect(names, set).toEqual(expect.arrayContaining(['albedo', 'normal', 'orm']));
      expect(new Set(maps.map((m) => `${dims(m).width}x${dims(m).height}`)).size, set).toBe(1);
    }
  });

  it('every alpha atlas is one square albedo map with an alpha channel', () => {
    for (const a of atlases) {
      const maps = manifest.entries.filter((e) => e.kind === 'texture' && e.set === a.set);
      expect(maps.map((m) => m.map), a.set).toEqual(['albedo']);
      expect(dims(maps[0]!).width, a.set).toBe(dims(maps[0]!).height);
      // WebP "VP8X" header with the alpha flag (0x10).
      const head = readFileSync(join(ROOT, maps[0]!.file)).subarray(0, 21);
      expect(head.subarray(12, 16).toString('latin1'), a.set).toBe('VP8X');
      expect(head[20]! & 0x10, a.set).toBe(0x10);
    }
  });

  it('the sky is a 2:1 Radiance HDR', () => {
    const sky = manifest.entries.find((e) => e.kind === 'env')!;
    expect(sky.id).toBe('env.sky');
    expect(dims(sky).width).toBe(dims(sky).height * 2);
    expect(readFileSync(join(ROOT, sky.file)).subarray(0, 10).toString('latin1')).toBe('#?RADIANCE');
  });
});

describe('characters', () => {
  const characters = manifest.entries.filter((e) => e.kind === 'character');

  it('the build catalog and the library name the same joints', () => {
    expect(Object.keys(CHARACTER_BONES).sort()).toEqual([...CHARACTER_JOINTS].sort());
  });

  it('every character has a bone map covering all joints, with bones that exist and no dots in their names', () => {
    expect(characters.length).toBeGreaterThanOrEqual(10);
    for (const e of characters) {
      const { json } = readGlb(e.file);
      const names = new Set((json.nodes ?? []).map((n) => n.name));
      expect(json.skins?.length, e.id).toBeGreaterThan(0);
      for (const joint of CHARACTER_JOINTS) {
        const bone = e.bones?.[joint];
        expect(bone, `${e.id} ${joint}`).toBeTruthy();
        expect(names.has(bone), `${e.id} bone ${bone}`).toBe(true);
        expect(bone).not.toContain('.');
      }
      expect(e.clips).toBe('anim.umc');
    }
  });

  it('the clips file holds the rig clips and the same bone names, but no mesh', () => {
    const clips = manifest.entries.find((e) => e.id === 'anim.umc')!;
    const { json } = readGlb(clips.file);
    expect((json.animations ?? []).length).toBe(24);
    expect(clips.clips).toContain('CharacterArmature|Idle');
    const names = new Set((json.nodes ?? []).map((n) => n.name));
    for (const bone of Object.values(CHARACTER_BONES)) expect(names.has(bone), bone).toBe(true);
    expect(json.skins ?? []).toHaveLength(0);
  });

  it('stands about 1.8 m tall', () => {
    for (const e of characters) {
      const b = e.bounds as { min: number[]; max: number[] };
      expect(b.min[1], e.id).toBeGreaterThanOrEqual(-0.01);
      expect(b.max[1], e.id).toBeGreaterThan(1.6);
      expect(b.max[1], e.id).toBeLessThan(2.3);
    }
  });
});

describe('vehicles and boats', () => {
  const vehicles = manifest.entries.filter((e) => e.kind === 'vehicle');

  it('every vehicle has four wheel sockets, wheel nodes and a radius', () => {
    expect(vehicles.length).toBeGreaterThanOrEqual(15);
    for (const e of vehicles) {
      for (const s of WHEEL_SOCKETS) expect(e.sockets?.[s], `${e.id} ${s}`).toHaveLength(3);
      expect(e.wheelRadius, e.id).toBeGreaterThan(0.2);
      const { json } = readGlb(e.file);
      const names = new Set((json.nodes ?? []).map((n) => n.name));
      for (const node of Object.values(e.wheelNodes ?? {})) expect(names.has(node), `${e.id} ${node}`).toBe(true);
    }
  });

  it('the fit table matches VEHICLE_SPECS and every fitted model has a length equal to its spec', () => {
    for (const [kind, [w, h, l]] of Object.entries(SPEC_DIMS)) {
      const spec = VEHICLE_SPECS[kind as keyof typeof VEHICLE_SPECS];
      expect([spec.width, spec.height, spec.length], kind).toEqual([w, h, l]);
    }
    for (const e of manifest.entries.filter((x) => x.spec)) {
      const spec = VEHICLE_SPECS[e.spec as keyof typeof VEHICLE_SPECS];
      const b = e.bounds as { min: number[]; max: number[] };
      expect(b.max[2]! - b.min[2]!, e.id).toBeCloseTo(spec.length, 1);
    }
  });
});
