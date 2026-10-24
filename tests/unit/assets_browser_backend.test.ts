// The browser backend with fetch and createImageBitmap stubbed: relative hashed URLs, streamed byte progress, and
// textures that keep their ImageBitmap for re-upload after a lost context.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserBackend } from '../../src/render/assets/browser';
import type { ManifestEntry } from '../../src/render/assets/types';

const manifest = JSON.parse(readFileSync(join(process.cwd(), 'src/assets/manifest.json'), 'utf8')).entries as ManifestEntry[];
const entry = (id: string) => manifest.find((e) => e.id === id)!;

afterEach(() => vi.unstubAllGlobals());

describe('browser backend', () => {
  it('requests every file at a URL that is not root-absolute under /assets/', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => (urls.push(url), new Response(new Uint8Array(4))));
    await browserBackend.manifest(new AbortController().signal).catch(() => undefined);
    for (const e of manifest) await browserBackend.fetch(e, () => {}, new AbortController().signal);
    expect(urls).toHaveLength(manifest.length + 1);
    for (const u of urls) {
      expect(u.startsWith('/assets/'), u).toBe(false);
      expect(u).toMatch(/\.(glb|webp|hdr|json)(\?.*)?$/);
    }
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('reports bytes as the body streams in and throws on a non-200 answer', async () => {
    const chunks = [new Uint8Array(30), new Uint8Array(30), new Uint8Array(40)];
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } })));
    const seen: number[] = [];
    const buf = await browserBackend.fetch(entry('prop.q.bench'), (n) => seen.push(n), new AbortController().signal);
    expect(seen).toEqual([30, 60, 100]);
    expect(buf.byteLength).toBe(100);
    vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }));
    await expect(browserBackend.fetch(entry('prop.q.bench'), () => {}, new AbortController().signal)).rejects.toThrow('HTTP 404');
  });

  it('rejects a file that is not part of the build', async () => {
    await expect(browserBackend.fetch({ ...entry('prop.q.bench'), file: 'models/props/nope.glb' }, () => {}, new AbortController().signal)).rejects.toThrow('not part of this build');
  });

  it('keeps the ImageBitmap of a texture: it is never closed, so the texture can be uploaded again', async () => {
    const close = vi.fn();
    const bitmap = { width: 512, height: 512, close } as unknown as ImageBitmap;
    const create = vi.fn(async () => bitmap);
    vi.stubGlobal('createImageBitmap', create);
    const albedo = await browserBackend.decode(entry('tex.asphalt_02.albedo'), new ArrayBuffer(8));
    const orm = await browserBackend.decode(entry('tex.asphalt_02.orm'), new ArrayBuffer(8));
    if (albedo.type !== 'texture' || orm.type !== 'texture') throw new Error('expected textures');
    expect(albedo.texture.image).toBe(bitmap);
    expect(albedo.texture.flipY).toBe(false);
    expect(albedo.texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(orm.texture.colorSpace).toBe(THREE.NoColorSpace);
    expect(albedo.texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(close).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({ imageOrientation: 'flipY' }));
  });

  it('decodes the sky as an equirectangular half-float texture', async () => {
    const hdr = readFileSync(join(process.cwd(), 'src/assets/env/sky_1k.hdr'));
    const sky = await browserBackend.decode(entry('env.sky'), hdr.buffer.slice(hdr.byteOffset, hdr.byteOffset + hdr.byteLength) as ArrayBuffer);
    if (sky.type !== 'texture') throw new Error('expected a texture');
    expect(sky.texture.mapping).toBe(THREE.EquirectangularReflectionMapping);
    const image = sky.texture.image as { width: number; height: number };
    expect([image.width, image.height]).toEqual([1024, 512]);
  });
});
