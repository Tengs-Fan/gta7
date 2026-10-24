// Shared paths and helpers for the asset scripts (fetch.mjs, build.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SOURCES_JSON = path.join(ROOT, 'scripts', 'assets', 'sources.json');
export const OUT_DIR = path.join(ROOT, 'src', 'assets');

/** Raw downloads live outside the repo; override with GTA7_ASSETS_SRC. */
export const SRC_DIR = process.env.GTA7_ASSETS_SRC
  ? path.resolve(process.env.GTA7_ASSETS_SRC)
  : path.join(os.homedir(), 'Projects', 'gta7-assets-src');

export function readSources() {
  return JSON.parse(fs.readFileSync(SOURCES_JSON, 'utf8')).sources;
}

/** One source per line so concurrent additions merge cleanly. */
export function formatSources(sources) {
  return `{"sources":[\n${sources.map((s) => `  ${JSON.stringify(s)}`).join(',\n')}\n]}\n`;
}

export function writeSources(sources) {
  fs.writeFileSync(SOURCES_JSON, formatSources(sources));
}

export function srcPath(rel) {
  return path.join(SRC_DIR, rel);
}
