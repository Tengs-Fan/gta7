// The static server's content types and caching for models, textures, the HDRI, decoders and JSON.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type GameServer } from '../../server/server';
import { TYPES } from '../../server/static';
import { socketPath } from './net_helpers';

let server: GameServer;
let sock: string;

function head(path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: sock, path, method: 'HEAD' }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'gta7-static-assets-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  writeFileSync(join(root, 'package.json'), '{}');
  for (const f of ['swat-Dk3jL9aX.glb', 'rig-Ab12Cd34.gltf', 'rig-Ab12Cd34.bin', 'albedo-BBUtUThS.webp', 'sky_1k-C35ymwQp.hdr', 'basis-Zx9Yw8Vv.ktx2', 'meshopt-Qq1Ww2Ee.wasm', 'manifest-GbUrXahw.json', 'long-unhashed-name.glb']) {
    writeFileSync(join(dist, 'assets', f), 'x');
  }
  writeFileSync(join(dist, 'manifest.json'), '{}');
  sock = socketPath('static-assets');
  server = await startServer({ socketPath: sock, distDir: dist, statusLogMs: 0, log: () => {} });
});

afterAll(async () => {
  await server.close();
});

describe('content types', () => {
  it('lists the web 3D and image types', () => {
    expect(TYPES['.glb']).toBe('model/gltf-binary');
    expect(TYPES['.gltf']).toBe('model/gltf+json');
    expect(TYPES['.bin']).toBe('application/octet-stream');
    expect(TYPES['.webp']).toBe('image/webp');
    expect(TYPES['.hdr']).toBe('image/vnd.radiance');
    expect(TYPES['.ktx2']).toBe('image/ktx2');
    expect(TYPES['.wasm']).toBe('application/wasm');
    expect(TYPES['.json']).toMatch(/^application\/json/);
  });

  it.each([
    ['/assets/swat-Dk3jL9aX.glb', 'model/gltf-binary'],
    ['/assets/rig-Ab12Cd34.gltf', 'model/gltf+json'],
    ['/assets/rig-Ab12Cd34.bin', 'application/octet-stream'],
    ['/assets/albedo-BBUtUThS.webp', 'image/webp'],
    ['/assets/sky_1k-C35ymwQp.hdr', 'image/vnd.radiance'],
    ['/assets/basis-Zx9Yw8Vv.ktx2', 'image/ktx2'],
    ['/assets/meshopt-Qq1Ww2Ee.wasm', 'application/wasm'],
    ['/assets/manifest-GbUrXahw.json', 'application/json'],
  ])('serves %s as %s', async (path, type) => {
    const r = await head(path);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(new RegExp(`^${type.replace(/[+.]/g, '\\$&')}`));
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('caching', () => {
  it.each(['swat-Dk3jL9aX.glb', 'rig-Ab12Cd34.gltf', 'rig-Ab12Cd34.bin', 'albedo-BBUtUThS.webp', 'sky_1k-C35ymwQp.hdr', 'basis-Zx9Yw8Vv.ktx2', 'meshopt-Qq1Ww2Ee.wasm', 'manifest-GbUrXahw.json'])(
    'caches the hashed %s for a year',
    async (name) => {
      const cc = String((await head(`/assets/${name}`)).headers['cache-control']);
      expect(cc).toContain('immutable');
      expect(Number(/max-age=(\d+)/.exec(cc)![1])).toBeGreaterThanOrEqual(31_536_000);
    },
  );

  it('does not cache a long unhashed name for a year, nor index.html', async () => {
    expect(String((await head('/assets/long-unhashed-name.glb')).headers['cache-control'])).not.toContain('immutable');
    expect(String((await head('/manifest.json')).headers['cache-control'])).not.toContain('immutable');
    expect(String((await head('/')).headers['cache-control'])).toBe('no-cache');
  });
});

describe('safety', () => {
  it('returns 404 for a missing asset and refuses path traversal', async () => {
    expect((await head('/assets/missing-AbCd1234.glb')).status).toBe(404);
    expect((await head('/../package.json')).status).toBe(404);
    expect((await head('/%2e%2e/package.json')).status).toBe(404);
  });
});
