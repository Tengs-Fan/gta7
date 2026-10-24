// PBR texture sets: albedo (sRGB), normal (OpenGL, +Y up) and ORM (R occlusion, G roughness, B metalness) as WebP.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TEXTURE_SIZE, MAX_TEXTURE_SIZE, sharp } from './pipeline.mjs';
import { srcPath } from './lib.mjs';

const WEBP = { albedo: { quality: 84, effort: 6 }, normal: { quality: 88, effort: 6, smartSubsample: false }, orm: { quality: 80, effort: 6 }, emissive: { quality: 80, effort: 6 } };

async function load(file, size) {
  const img = sharp(file).removeAlpha();
  const meta = await img.metadata();
  const side = Math.min(size, meta.width ?? size);
  return { img: side === meta.width ? img : img.resize(side, side, { kernel: 'lanczos3' }), side };
}

async function encode(img, kind) {
  const { data, info } = await img.clone().raw().toBuffer({ resolveWithObject: true });
  const out = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).webp(WEBP[kind]).toBuffer();
  return { buffer: out, width: info.width, height: info.height };
}

/** Builds a channel-packed ORM from separate occlusion/roughness/metalness greyscale maps (missing ones get a constant). */
async function packOrm(maps, size) {
  const channel = async (file, constant) => {
    if (!file) return Buffer.alloc(size * size, constant);
    return sharp(file).resize(size, size, { kernel: 'lanczos3' }).greyscale().raw().toBuffer();
  };
  const [r, g, b] = await Promise.all([channel(maps.ao, 255), channel(maps.rough, 255), channel(maps.metal, 0)]);
  const px = size * size;
  const rgb = Buffer.alloc(px * 3);
  for (let i = 0; i < px; i++) {
    rgb[i * 3] = r[i];
    rgb[i * 3 + 1] = g[i];
    rgb[i * 3 + 2] = b[i];
  }
  return sharp(rgb, { raw: { width: size, height: size, channels: 3 } });
}

/**
 * Builds one PBR set into outDir and returns [{ map, file, width, height, buffer }].
 * `maps` points into the source cache: { albedo, normal, orm } for ready-packed ARM maps (Poly Haven), or
 * { albedo, normal, ao?, rough, metal?, emissive? } for separate maps (ambientCG).
 */
export async function buildTextureSet(def) {
  const size = def.size ?? DEFAULT_TEXTURE_SIZE;
  if (size > MAX_TEXTURE_SIZE) throw new Error(`${def.set}: texture size ${size} exceeds ${MAX_TEXTURE_SIZE}`);
  const m = Object.fromEntries(Object.entries(def.maps).map(([k, v]) => [k, srcPath(v)]));
  const result = [];
  const albedo = await load(m.albedo, size);
  result.push({ map: 'albedo', ...(await encode(albedo.img, 'albedo')) });
  const normal = await load(m.normal, size);
  result.push({ map: 'normal', ...(await encode(normal.img, 'normal')) });
  let orm;
  if (m.orm) orm = (await load(m.orm, size)).img;
  else orm = await packOrm(m, albedo.side);
  result.push({ map: 'orm', ...(await encode(orm, 'orm')) });
  if (m.emissive) {
    const emissive = await load(m.emissive, size);
    result.push({ map: 'emissive', ...(await encode(emissive.img, 'emissive')) });
  }
  return result.map((r) => ({ ...r, file: path.posix.join('textures', def.set, `${r.map}.webp`) }));
}

export function readHdrSize(file) {
  const head = fs.readFileSync(file).subarray(0, 256).toString('latin1');
  const match = head.match(/-Y (\d+) \+X (\d+)/);
  if (!match) throw new Error(`${file}: not a Radiance HDR`);
  return { width: Number(match[2]), height: Number(match[1]) };
}
