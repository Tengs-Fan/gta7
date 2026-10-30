#!/usr/bin/env node
// `npm run assets`: rebuilds src/assets/** (models, textures, env), src/assets/manifest.json and LICENSES-ASSETS.md
// from the source cache filled by fetch.mjs. Everything is deterministic: two runs produce identical bytes.
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '@gltf-transform/core';
import { atlases, boats, envs, props, SPEC_DIMS, textureSets, vehicles } from './catalog.mjs';
import { buildLeafAtlas } from './leafAtlas.mjs';
import { OUT_DIR, ROOT, readSources, srcPath } from './lib.mjs';
import {
  boundsOf, io, nodeCentre, normalize, optimize, recenterNode, sceneOf, triangleCount, writeGlb,
} from './pipeline.mjs';
import { buildTextureSet, readHdrSize } from './textures.mjs';
import { writeLicenses } from './licenses.mjs';

const sources = readSources();
const sourceIds = new Set(sources.map((s) => s.id));
const written = new Map();
const entries = [];

function emit(file, buffer) {
  if (written.has(file)) throw new Error(`duplicate output ${file}`);
  const dest = path.join(OUT_DIR, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(buffer)) fs.writeFileSync(dest, buffer);
  written.set(file, buffer.length);
}

function addEntry(entry) {
  if (!sourceIds.has(entry.license)) throw new Error(`${entry.id}: license ${entry.license} is not a source in sources.json`);
  if (entries.some((e) => e.id === entry.id)) throw new Error(`duplicate id ${entry.id}`);
  entries.push(entry);
}

async function readModel(def) {
  const doc = await io.read(srcPath(def.src));
  doc.setLogger(new Logger(Logger.Verbosity.ERROR));
  doc.getRoot().getAsset().generator = 'gta7 asset build';
  return doc;
}

async function finishModel(doc, def, extra) {
  await optimize(doc, { lossless: def.lossless });
  const file = def.out;
  const buffer = await writeGlb(doc, file);
  emit(file, buffer);
  addEntry({
    id: def.id, file, kind: def.kind, bytes: buffer.length, bounds: boundsOf(sceneOf(doc)), triangles: triangleCount(doc), license: def.license, ...extra,
  });
}

async function buildVehicle(def) {
  const doc = await readModel(def);
  const nodes = doc.getRoot().listNodes();
  const byName = (n) => {
    const node = nodes.find((x) => x.getName() === n);
    if (!node) throw new Error(`${def.id}: node ${n} missing`);
    return node;
  };
  const roles = {};
  for (const [role, source] of Object.entries(def.wheels)) {
    byName(source).setName(`wheel_${role}`);
    roles[role] = `wheel_${role}`;
  }
  const scale = normalize(doc, { length: def.length, origin: def.origin });
  for (const name of Object.values(roles)) recenterNode(byName(name));
  const c = Object.fromEntries(Object.keys(roles).map((role) => [role, nodeCentre(doc, roles[role])]));
  const sockets = { wheelFL: c.fl.centre, wheelFR: c.fr.centre };
  if (c.rear) {
    sockets.wheelRL = [c.fl.centre[0], c.rear.centre[1], c.rear.centre[2]];
    sockets.wheelRR = [c.fr.centre[0], c.rear.centre[1], c.rear.centre[2]];
  } else {
    sockets.wheelRL = c.rl.centre;
    sockets.wheelRR = c.rr.centre;
  }
  await finishModel(doc, def, {
    spec: def.spec, fit: fitRatios(doc, def.spec), scale: Math.round(scale * 1e4) / 1e4, wheelNodes: roles, sockets, wheelRadius: c.fl.radius,
  });
}

/** Normalised bounds over the footprint of the fitted VEHICLE_SPECS kind: above 1 means the model sticks out. */
function fitRatios(doc, spec) {
  if (!spec) return undefined;
  const b = boundsOf(sceneOf(doc));
  const dims = SPEC_DIMS[spec];
  if (!dims) throw new Error(`unknown spec ${spec}`);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]].map((v, i) => Math.round((v / dims[i]) * 100) / 100);
}

async function buildBoat(def) {
  const doc = await readModel(def);
  const scale = normalize(doc, { length: def.length, origin: def.origin });
  await finishModel(doc, def, { spec: def.spec, fit: fitRatios(doc, def.spec), scale: Math.round(scale * 1e4) / 1e4 });
}

async function buildProp(def) {
  const doc = await readModel(def);
  const scale = normalize(doc, { scale: def.scale, height: def.height, width: def.width, length: def.length, origin: def.origin ?? 'ground' });
  await finishModel(doc, def, { scale: Math.round(scale * 1e4) / 1e4 });
}

async function buildTextures(def) {
  const maps = await buildTextureSet(def);
  for (const m of maps) {
    emit(m.file, m.buffer);
    addEntry({
      id: `tex.${def.set}.${m.map}`, file: m.file, kind: 'texture', set: def.set, map: m.map, bytes: m.buffer.length,
      bounds: { width: m.width, height: m.height }, license: def.license,
    });
  }
}

async function buildAtlas(def) {
  const { buffer, width, height } = await buildLeafAtlas(def);
  const file = `textures/${def.set}/albedo.webp`;
  emit(file, buffer);
  addEntry({ id: `tex.${def.set}.albedo`, file, kind: 'texture', set: def.set, map: 'albedo', bytes: buffer.length, bounds: { width, height }, license: def.license });
}

function buildEnv(def) {
  const buffer = fs.readFileSync(srcPath(def.src));
  emit(def.out, buffer);
  addEntry({ id: def.id, file: def.out, kind: def.kind, bytes: buffer.length, bounds: readHdrSize(srcPath(def.src)), license: def.license });
}

for (const def of vehicles) await buildVehicle(def);
for (const def of boats) await buildBoat(def);
for (const def of props) await buildProp(def);
for (const def of textureSets) await buildTextures(def);
for (const def of atlases) await buildAtlas(def);
for (const def of envs) buildEnv(def);

entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const manifest = `{"version":1,"entries":[\n${entries.map((e) => `  ${JSON.stringify(e)}`).join(',\n')}\n]}\n`;
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), manifest);

// Remove outputs that the catalog no longer produces.
function prune(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(OUT_DIR, full).split(path.sep).join('/');
    if (fs.statSync(full).isDirectory()) {
      prune(full);
      if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
    } else if (rel !== 'manifest.json' && !written.has(rel)) {
      fs.rmSync(full);
      console.log(`removed stale ${rel}`);
    }
  }
}
prune(OUT_DIR);

writeLicenses(sources, entries, path.join(ROOT, 'LICENSES-ASSETS.md'));

const total = [...written.values()].reduce((a, b) => a + b, 0);
const byKind = {};
for (const e of entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + e.bytes;
console.log(`${entries.length} manifest entries, ${written.size} files, ${(total / 1e6).toFixed(2)} MB`);
console.log(Object.entries(byKind).map(([k, v]) => `${k} ${(v / 1e6).toFixed(2)} MB`).join(', '));
