#!/usr/bin/env node
// Downloads every source listed in sources.json into the asset source cache (default ~/Projects/gta7-assets-src,
// override with GTA7_ASSETS_SRC) and verifies size and sha256. Re-running downloads nothing and re-verifies.
//
//   node scripts/assets/fetch.mjs            download what is missing, verify everything
//   node scripts/assets/fetch.mjs --record   also fill in bytes/sha256 for sources that do not have them yet
//   node scripts/assets/fetch.mjs --verify   never download; fail when a file is missing or differs
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readSources, writeSources, srcPath, SRC_DIR } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const record = args.has('--record');
const verifyOnly = args.has('--verify');
// Poly Haven asks API users for a unique agent; the other hosts accept it too.
const USER_AGENT = 'gta7-assets (https://github.com/tengs-fan/gta7)';

function sha256File(file) {
  const h = createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
      return;
    } catch (e) {
      lastError = e;
      fs.rmSync(tmp, { force: true });
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`download failed for ${url}: ${lastError?.message ?? lastError}`);
}

function extract(zip, dir, sha) {
  const marker = path.join(dir, '.extracted');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === sha) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`unzip failed for ${zip}`);
  fs.writeFileSync(marker, sha);
  return true;
}

const sources = readSources();
const problems = [];
let downloaded = 0;
let verified = 0;
let recorded = 0;
let extracted = 0;

for (const source of sources) {
  for (const file of source.files) {
    const dest = srcPath(file.path);
    let fresh = false;
    if (!fs.existsSync(dest)) {
      if (verifyOnly) {
        problems.push(`${source.id}: missing ${file.path}`);
        continue;
      }
      console.log(`downloading ${file.path}`);
      try {
        await download(file.url, dest);
      } catch (e) {
        problems.push(`${source.id}: ${e.message}`);
        continue;
      }
      downloaded++;
      fresh = true;
    }
    const size = fs.statSync(dest).size;
    const sha = sha256File(dest);
    if (file.sha256 === undefined) {
      if (record) {
        file.bytes = size;
        file.sha256 = sha;
        recorded++;
      } else {
        problems.push(`${source.id}: ${file.path} has no recorded sha256 (run with --record)`);
        continue;
      }
    } else if (file.sha256 !== sha || file.bytes !== size) {
      problems.push(`${source.id}: ${file.path} differs from sources.json (expected ${file.bytes} bytes / ${file.sha256}, got ${size} / ${sha})${fresh ? ' right after download' : ''}`);
      continue;
    }
    verified++;
    if (file.extract) {
      try {
        if (extract(dest, srcPath(file.extract), sha)) extracted++;
      } catch (e) {
        problems.push(`${source.id}: ${e.message}`);
      }
    }
  }
}

if (recorded > 0) writeSources(sources);
console.log(`source cache ${SRC_DIR}`);
console.log(`sources ${sources.length}, files verified ${verified}, downloaded ${downloaded}, recorded ${recorded}, archives extracted ${extracted}`);
if (problems.length) {
  for (const p of problems) console.error(`ERROR ${p}`);
  process.exit(1);
}
