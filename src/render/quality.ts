// Graphics quality tiers: one fixed table of what each tier costs, and the Auto pick made
// once at boot from the GPU (no runtime governor, so frame-time measurements stay deterministic).
// Pure apart from probeGpu(), and free of three.js so the sim side and tests can import it.

export type QualityTier = 'low' | 'medium' | 'high';
/** What the player picks in SETTINGS; 'auto' is resolved once at boot with pickTier(). */
export type QualitySetting = 'auto' | QualityTier;

export const QUALITY_TIERS: readonly QualityTier[] = ['low', 'medium', 'high'];

export interface TierSpec {
  /** Highest devicePixelRatio rendered at. */
  dprCap: number;
  /** Fraction of that pixel ratio actually rendered (the browser scales the canvas up). */
  renderScale: number;
  /** 4x MSAA. A WebGL context attribute (it also sizes three's HDR scene target), so it is only chosen when the renderer is created. */
  msaa: boolean;
  /** Anti-aliasing: MSAA from the context, or FXAA in FinishPass (hardware HDR renderers only). */
  aa: 'msaa' | 'fxaa' | 'none';
  /** Time-of-day colour grade and vignette in FinishPass. */
  grade: boolean;
  shadows: boolean;
  shadowSize: number;
  bloom: boolean;
  /** 'all': every dynamic point light (siren, muzzle flash, explosion); 'few': they share FEW_POINT_LIGHTS; 'none': none. */
  pointLights: 'all' | 'few' | 'none';
  /** The player's headlight spot. */
  headlight: boolean;
  /** Ambient (traffic and parked) cars farther than this from the camera are not drawn. */
  vehicleDistance: number;
  trafficDensity: number;
  pedDensity: number;
}

/** Dynamic point lights shared by the siren, muzzle flash and explosion flash on 'few'. */
export const FEW_POINT_LIGHTS = 2;

/** High is the original look; Medium and Low trade it away step by step for integrated GPUs and HiDPI laptops. */
export const QUALITY: Readonly<Record<QualityTier, Readonly<TierSpec>>> = {
  high: { dprCap: 1.5, renderScale: 1, msaa: true, aa: 'msaa', grade: true, shadows: true, shadowSize: 2048, bloom: true, pointLights: 'all', headlight: true, vehicleDistance: Infinity, trafficDensity: 1, pedDensity: 1 },
  medium: { dprCap: 1, renderScale: 0.85, msaa: true, aa: 'msaa', grade: true, shadows: true, shadowSize: 1024, bloom: true, pointLights: 'few', headlight: true, vehicleDistance: Infinity, trafficDensity: 0.9, pedDensity: 0.9 },
  // Tone mapping and the output colour space are untouched, so Low keeps the same colours.
  low: { dprCap: 1, renderScale: 0.67, msaa: false, aa: 'fxaa', grade: true, shadows: false, shadowSize: 1024, bloom: false, pointLights: 'none', headlight: false, vehicleDistance: 150, trafficDensity: 0.75, pedDensity: 0.75 },
};

/** The renderer's pixel ratio at a tier on a display with this devicePixelRatio. */
export function pixelRatioFor(tier: QualityTier, devicePixelRatio: number): number {
  const t = QUALITY[tier];
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, t.dprCap) * t.renderScale;
}

/**
 * Software rasterisers have a separate pixel budget. UI text stays at native CSS resolution;
 * Low favours responsive driving, while Medium/High let the player spend more on world detail.
 * Bound the drawing buffer as well as its scale so maximising the window does not multiply cost.
 */
export function softwarePixelRatioFor(tier: QualityTier, width: number, height: number, devicePixelRatio = 1): number {
  const scale = tier === 'high' ? 0.67 : tier === 'medium' ? 0.5 : 0.45;
  const pixels = tier === 'high' ? 350_000 : tier === 'medium' ? 200_000 : 130_000;
  const area = Math.max(1, width) * Math.max(1, height);
  return Math.min(pixelRatioFor(tier, devicePixelRatio), scale, Math.sqrt(pixels / area));
}

/** Pixels in the drawing buffer at a tier for a canvas of cssWidth x cssHeight CSS pixels. */
export function drawingBufferPixels(tier: QualityTier, cssWidth: number, cssHeight: number, devicePixelRatio: number): number {
  const r = pixelRatioFor(tier, devicePixelRatio);
  return Math.floor(cssWidth * r) * Math.floor(cssHeight * r);
}

/** Auto picks Low for an integrated GPU whose Medium drawing buffer would exceed this. */
export const AUTO_MAX_PIXELS = 3.5e6;

export type GpuClass = 'software' | 'integrated' | 'discrete' | 'unknown';

/** Rough GPU class from a WebGL renderer string (UNMASKED_RENDERER_WEBGL or RENDERER). */
export function gpuClass(renderer: string): GpuClass {
  const s = renderer.toLowerCase();
  if (!s.trim()) return 'unknown';
  if (/swiftshader|llvmpipe|softpipe|lavapipe|basic render|software/.test(s)) return 'software';
  // Phones, tablets and ARM laptops.
  if (/mali|adreno|powervr|imgtec|videocore|tegra/.test(s)) return 'integrated';
  const apple = /apple m\d+(\s+(pro|max|ultra))?/.exec(s);
  if (apple) return apple[2] ? 'discrete' : 'integrated';
  if (/nvidia|geforce|quadro|\brtx\b|\bgtx\b/.test(s)) {
    // GeForce MX parts are entry-level laptop chips, about as fast as a good integrated GPU.
    return /geforce\s*mx/.test(s) ? 'integrated' : 'discrete';
  }
  if (/radeon|\bamd\b/.test(s)) {
    if (/radeon(\s*\(tm\))?\s+pro\b/.test(s)) return 'discrete';
    // Ryzen APUs report 'Vega 3' to 'Vega 11' (some as 'RX Vega 10'); the desktop cards are
    // 'RX Vega 56 / 64', plain 'RX Vega' and 'RX Vega M'.
    const vega = /vega\s*(\d+)?/.exec(s);
    if (vega) return vega[1] && Number(vega[1]) <= 11 ? 'integrated' : 'discrete';
    if (/radeon(\s*\(tm\))?\s+graphics/.test(s)) return 'integrated';
    if (/radeon(\s*\(tm\))?\s+rx\b/.test(s)) return 'discrete';
    return 'unknown';
  }
  if (/intel/.test(s)) return /arc(\s*\(tm\))?\s+[ab]\d{3}\b/.test(s) ? 'discrete' : 'integrated';
  return 'unknown';
}

export interface DisplayInfo {
  /** UNMASKED_RENDERER_WEBGL, or RENDERER where that is unavailable; '' when unknown. */
  renderer: string;
  devicePixelRatio?: number;
  /** Screen size in CSS pixels (what window.screen reports). */
  screenWidth?: number;
  screenHeight?: number;
}

/**
 * The tier 'auto' stands for, picked once at boot: software rasterisers get Low, integrated and
 * mobile GPUs Medium (Low when Medium's drawing buffer for a full-screen canvas would exceed
 * AUTO_MAX_PIXELS), discrete GPUs High and anything unrecognised Medium.
 */
export function pickTier(info: DisplayInfo): QualityTier {
  switch (gpuClass(info.renderer)) {
    case 'software':
      return 'low';
    case 'discrete':
      return 'high';
    case 'integrated': {
      const w = info.screenWidth && info.screenWidth > 0 ? info.screenWidth : 1920;
      const h = info.screenHeight && info.screenHeight > 0 ? info.screenHeight : 1080;
      return drawingBufferPixels('medium', w, h, info.devicePixelRatio ?? 1) > AUTO_MAX_PIXELS ? 'low' : 'medium';
    }
    default:
      return 'medium';
  }
}

export interface GpuProbe {
  /** Renderer string for pickTier ('' when WebGL 2 or the string is unavailable). */
  renderer: string;
  /** Half-float colour buffers can be rendered to (needed for the HDR output and bloom). */
  halfFloat: boolean;
}

/** Strings browsers report in RENDERER instead of the real GPU. */
const MASKED_RENDERER = /^(webkit webgl|mozilla|apple gpu)?$/i;

/**
 * Asks a throwaway WebGL 2 context (same power preference as the game's) what GPU it runs on and
 * whether half-float targets work, then releases it. Never throws.
 */
export function probeGpu(): GpuProbe {
  const out: GpuProbe = { renderer: '', halfFloat: false };
  let gl: WebGL2RenderingContext | null = null;
  try {
    if (typeof document === 'undefined') return out;
    const canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl2', { powerPreference: 'high-performance' }) as WebGL2RenderingContext | null;
    if (!gl) return out;
    out.halfFloat = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    // Firefox reports the real (sanitised) GPU in RENDERER and deprecates the debug extension, so
    // the extension is only asked for when RENDERER is masked.
    const plain = gl.getParameter(gl.RENDERER) as unknown;
    let name = typeof plain === 'string' ? plain : '';
    if (MASKED_RENDERER.test(name.trim())) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
      const unmasked = dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as unknown) : null;
      if (typeof unmasked === 'string' && unmasked) name = unmasked;
    }
    out.renderer = name;
  } catch {
    // No usable probe: unknown GPU (and no half-float targets unless that answer came first).
  } finally {
    // Release the throwaway context whatever happened, so it does not count against the page's limit.
    try {
      const lose = gl?.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null | undefined;
      if (typeof lose?.loseContext === 'function') lose.loseContext();
    } catch {
      // Best effort.
    }
  }
  return out;
}
