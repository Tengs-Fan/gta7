// Shallow, batched facade relief. Building footprints, roof heights and street
// clearances still come from the simulation; these are architectural finishes.
import type { Building, Tier } from '../world/layout';
import { GeoBuilder, scaleRgb, type RGB } from './geo';
import { FACADE_CELL } from './textures';

const UV = { kind: 'world' as const, scale: 3 };

/** Sills, cornices and structural piers give the window atlases a real silhouette. */
export function facadeRelief(g: GeoBuilder, b: Building, t: Tier, baseY: number, color: RGB): void {
  const width = t.maxX - t.minX;
  const depth = t.maxZ - t.minZ;
  if (Math.min(width, depth) < 3) return;
  const glass = b.style === 'glassBlue' || b.style === 'glassTeal';
  const first = Math.max(t.y0, baseY);
  // The darker aluminum on curtain walls reads as structure; pale stone catches
  // the sun on masonry. Keep all street-level doorways completely clear.
  const finish: RGB = b.style === 'brick' ? [0.55, 0.47, 0.37] : b.style === 'office' ? [0.48, 0.43, 0.35] : b.style === 'warehouse' ? [0.28, 0.31, 0.34] : [0.68, 0.64, 0.56];
  const trim: RGB = glass ? [0.15, 0.19, 0.23] : [color[0] * finish[0], color[1] * finish[1], color[2] * finish[2]];
  const cap: RGB = glass ? [0.3, 0.36, 0.39] : scaleRgb(trim, 1.12);
  const band = (y: number, h: number, out: number, c: RGB): void => {
    g.box(t.minX - out, y, t.minZ - out, t.maxX + out, y + h, t.maxZ + out, { uv: UV, color: c, bottom: true });
  };

  if (b.style === 'house') {
    // Eave fascia has actual thickness even when the gable is viewed edge-on.
    band(t.y1 - 0.16, 0.14, 0.12, [0.82, 0.8, 0.74]);
    return;
  }
  // A continuous shadow line above the storefront and a second at each setback.
  if (first > t.y0 + 0.5 && first < t.y1 - 0.5) band(first - 0.07, 0.14, 0.12, cap);
  if (t.y0 > baseY + 1) band(t.y0 + 0.02, 0.16, 0.12, cap);
  band(t.y1 - 0.17, 0.16, glass ? 0.08 : 0.14, cap);

  const floorH = FACADE_CELL[b.style].h;
  const every = b.style === 'brick' ? 3 : b.style === 'stucco' ? 2 : glass ? 4 : 1;
  const floor0 = Math.max(1, Math.ceil((first - baseY + 0.5) / floorH));
  for (let floor = floor0; baseY + floor * floorH < t.y1 - 0.8; floor++) {
    if (floor % every !== 0) continue;
    const y = baseY + floor * floorH;
    band(y - 0.07, b.style === 'hotel' ? 0.2 : 0.12, b.style === 'hotel' ? 0.18 : 0.1, trim);
  }

  // Corner piers stop above the entrance band; the amount of relief is shallow
  // enough that it never adds a new obstacle to a walkable street or roof.
  const bottom = Math.max(first + 0.18, t.y0 + 3.2);
  if (bottom >= t.y1 - 0.2) return;
  const pierW = glass ? 0.18 : b.style === 'warehouse' ? 0.32 : 0.24;
  for (const x of [t.minX, t.maxX]) {
    for (const z of [t.minZ, t.maxZ]) {
      g.box(x - pierW / 2, bottom, z - pierW / 2, x + pierW / 2, t.y1 - 0.16, z + pierW / 2, { uv: UV, color: trim });
    }
  }

  if (!glass && b.style !== 'warehouse') return;
  // Alternate glass bays receive a slender external mullion. Placing them on the
  // same continuous perimeter coordinate as the facade UV keeps corners aligned.
  const stride = FACADE_CELL[b.style].w * (glass ? 2 : 1);
  const walls = [
    [t.minX, t.maxZ, 1, 0, width, 0],
    [t.maxX, t.maxZ, 0, -1, depth, width],
    [t.maxX, t.minZ, -1, 0, width, width + depth],
    [t.minX, t.minZ, 0, 1, depth, 2 * width + depth],
  ] as const;
  for (const [ax, az, ux, uz, length, perimeter] of walls) {
    const offset = Math.ceil((perimeter + 0.5) / stride) * stride - perimeter;
    for (let d = offset; d < length - 0.5; d += stride) {
      const x = ax + ux * d;
      const z = az + uz * d;
      const dx = ux !== 0 ? 0.055 : 0.07;
      const dz = ux !== 0 ? 0.07 : 0.055;
      g.box(x - dx, bottom, z - dz, x + dx, t.y1 - 0.16, z + dz, { uv: UV, color: cap });
    }
  }
}

/** Flush ironwork sits below the road paint and cannot affect driving. */
export function manhole(g: GeoBuilder, x: number, z: number): void {
  const r = 0.48;
  const segments = 20;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    const ax = x + Math.cos(a) * r;
    const az = z + Math.sin(a) * r;
    const bx = x + Math.cos(b) * r;
    const bz = z + Math.sin(b) * r;
    g.tri(x, 0.009, z, bx, 0.009, bz, ax, 0.009, az, [0.5, 0.5, 1, 0, 0, 0], [0.19, 0.2, 0.21]);
    const aiX = x + Math.cos(a) * (r - 0.045);
    const aiZ = z + Math.sin(a) * (r - 0.045);
    const biX = x + Math.cos(b) * (r - 0.045);
    const biZ = z + Math.sin(b) * (r - 0.045);
    g.quad(ax, 0.011, az, aiX, 0.011, aiZ, biX, 0.011, biZ, bx, 0.011, bz, [0, 0, 1, 0, 1, 1, 0, 1], [0.3, 0.31, 0.31]);
  }
  for (let k = -2; k <= 2; k++) {
    const half = Math.sqrt(0.36 * 0.36 - (k * 0.12) ** 2);
    g.flat(x - half, z + k * 0.12 - 0.018, x + half, z + k * 0.12 + 0.018, 0.012, UV, [0.095, 0.1, 0.11]);
  }
}

export function stormDrain(g: GeoBuilder, x: number, z: number, vertical: boolean): void {
  const halfX = vertical ? 0.19 : 0.48;
  const halfZ = vertical ? 0.48 : 0.19;
  g.flat(x - halfX, z - halfZ, x + halfX, z + halfZ, 0.009, UV, [0.09, 0.105, 0.11]);
  for (let k = -3; k <= 3; k++) {
    const cx = x + (vertical ? 0 : k * 0.12);
    const cz = z + (vertical ? k * 0.12 : 0);
    const sx = vertical ? halfX : 0.024;
    const sz = vertical ? 0.024 : halfZ;
    g.flat(cx - sx, cz - sz, cx + sx, cz + sz, 0.013, UV, [0.27, 0.28, 0.27]);
  }
}
