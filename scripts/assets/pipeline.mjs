// glTF-transform helpers: normalise a source model (scale, orientation, origin), optimise it and write a
// meshopt-compressed GLB with WebP textures.
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, getBounds, prune, quantize, reorder, textureCompress, transformMesh, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

await MeshoptEncoder.ready;

export const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
io.setLogger(new Logger(Logger.Verbosity.ERROR));

export const DEFAULT_TEXTURE_SIZE = 512;
export const MAX_TEXTURE_SIZE = 1024;

const round = (n) => Math.round(n * 1000) / 1000;
const round3 = (v) => [round(v[0]), round(v[1]), round(v[2])];

export function sceneOf(doc) {
  const root = doc.getRoot();
  return root.getDefaultScene() ?? root.listScenes()[0];
}

export function boundsOf(scene) {
  const b = getBounds(scene);
  return { min: round3(b.min), max: round3(b.max) };
}

function plan(doc, { scale, length, height, width, origin = 'ground' }) {
  const b = getBounds(sceneOf(doc));
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  let s = scale ?? 1;
  if (scale === undefined) {
    if (length) s = length / size[2];
    else if (height) s = height / size[1];
    else if (width) s = width / size[0];
  }
  const cx = origin === 'bottom-center' ? (b.min[0] + b.max[0]) / 2 : 0;
  const cz = origin === 'bottom-center' ? (b.min[2] + b.max[2]) / 2 : 0;
  return { s, offset: [-cx * s, -b.min[1] * s, -cz * s] };
}

/**
 * Normalises units and origin. `scale` wins over the size targets. `origin` picks the pivot:
 * 'bottom-center' puts the bounding box centre (x, z) at 0 and its lowest point on y = 0, 'ground' keeps the authored x/z
 * and only drops the lowest point to y = 0.
 *
 * Models are baked: every mesh node is flattened to the scene root with an identity transform and the normalisation
 * (and any authored node scale or rotation) written into its vertices, so a wheel node later rotates about its own axes.
 */
export function normalize(doc, opts) {
  const { s, offset } = plan(doc, opts);
  const scene = sceneOf(doc);
  const nodes = doc.getRoot().listNodes().filter((n) => n.getMesh());
  const matrices = new Map(nodes.map((n) => {
    const w = n.getWorldMatrix();
    return [n, [
      w[0] * s, w[1] * s, w[2] * s, 0, w[4] * s, w[5] * s, w[6] * s, 0, w[8] * s, w[9] * s, w[10] * s, 0,
      w[12] * s + offset[0], w[13] * s + offset[1], w[14] * s + offset[2], 1,
    ]];
  }));
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (mesh.listParents().filter((p) => p.propertyType === 'Node').length > 1) throw new Error(`mesh ${mesh.getName()} is shared by several nodes`);
    transformMesh(mesh, matrices.get(node));
    const parent = node.getParentNode();
    if (parent) parent.removeChild(node);
    else scene.removeChild(node);
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
    scene.addChild(node);
  }
  for (const node of doc.getRoot().listNodes()) {
    if (!node.getMesh() && node.listChildren().length === 0) {
      const parent = node.getParentNode();
      if (parent) parent.removeChild(node);
      else scene.removeChild(node);
      node.dispose();
    }
  }
  for (const child of scene.listChildren()) if (!child.getMesh() && child.listChildren().length === 0) child.dispose();
  return s;
}

/** Moves a baked (identity-transform) node's origin to its mesh centre; wheels authored around the model origin cannot spin or steer otherwise. */
export function recenterNode(node) {
  const mesh = node.getMesh();
  if (!mesh || node.getSkin()) return;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const v = [0, 0, 0];
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], v[k]);
        max[k] = Math.max(max[k], v[k]);
      }
    }
  }
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  transformMesh(mesh, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -c[0], -c[1], -c[2], 1]);
  const t = node.getTranslation();
  node.setTranslation([t[0] + c[0], t[1] + c[1], t[2] + c[2]]);
  return c;
}

/** World-space centre and radius of a named node's mesh after normalisation. */
export function nodeCentre(doc, name) {
  const node = doc.getRoot().listNodes().find((n) => n.getName() === name);
  if (!node) throw new Error(`node ${name} not found`);
  const b = getBounds(node);
  return {
    centre: round3([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]),
    radius: round(Math.max(b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2),
    halfWidth: round((b.max[0] - b.min[0]) / 2),
  };
}

export function triangleCount(doc) {
  let tris = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      tris += idx ? idx.getCount() / 3 : prim.getAttribute('POSITION').getCount() / 3;
    }
  }
  return Math.round(tris);
}

/** Welds, dedups, prunes, converts textures to WebP and meshopt-compresses; positions stay float so merged geometry stays simple. */
export async function optimize(doc, { textureSize = DEFAULT_TEXTURE_SIZE, lossless = false, quality = 82 } = {}) {
  if (textureSize > MAX_TEXTURE_SIZE) throw new Error(`texture size ${textureSize} exceeds ${MAX_TEXTURE_SIZE}`);
  const root = doc.getRoot();
  for (const material of root.listMaterials()) material.setExtras({});
  await doc.transform(
    weld(),
    dedup(),
    prune({ keepLeaves: true, keepAttributes: false }),
  );
  if (root.listTextures().length) {
    await doc.transform(
      textureCompress({
        encoder: sharp,
        targetFormat: 'webp',
        resize: [textureSize, textureSize],
        quality,
        lossless,
        effort: 100,
      }),
    );
  }
  await doc.transform(
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    quantize({ pattern: /^(NORMAL|TANGENT)$/, quantizeNormal: 10 }),
  );
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
}

export async function writeGlb(doc, file) {
  const buf = await io.writeBinary(doc);
  return Buffer.from(buf);
}

export { sharp };
