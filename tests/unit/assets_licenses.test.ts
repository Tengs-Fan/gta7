// LICENSES-ASSETS.md covers every asset in the manifest, allows only CC0 and credited CC-BY, and matches sources.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../src/render/assets/types';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const manifest = parseManifest(JSON.parse(read('src/assets/manifest.json')));
const sources = JSON.parse(read('scripts/assets/sources.json')).sources as Array<{ id: string; name: string; author: string; page: string; license: string; credit?: string; files: Array<{ url: string; path: string; bytes?: number; sha256?: string }> }>;
const licensesMd = read('LICENSES-ASSETS.md');
const readme = read('README.md');

interface Row { id: string; name: string; author: string; url: string; license: string; credit: string }

function rows(md: string): Row[] {
  return md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ID') && !l.startsWith('| ---')).map((l) => {
    const c = l.slice(1, -1).split(/(?<!\\)\|/).map((x) => x.trim().replaceAll('\\|', '|'));
    return { id: c[0]!, name: c[1]!, author: c[2]!, url: c[3]!, license: c[4]!, credit: c[5]! };
  });
}

/** Every problem found in a licenses table; empty when it is fine. */
function problems(md: string): string[] {
  const out: string[] = [];
  const table = rows(md);
  const byId = new Map(table.map((r) => [r.id, r]));
  const urls = new Set(sources.flatMap((s) => [s.page, ...s.files.map((f) => f.url)]));
  for (const e of manifest.entries) if (!byId.has(e.license)) out.push(`manifest entry ${e.id}: license ${e.license} has no row`);
  for (const r of table) {
    if (!urls.has(r.url)) out.push(`row ${r.id}: ${r.url} is not in sources.json`);
    if (!/^CC0(-\d(\.\d)?)?$/.test(r.license) && !/^CC-BY(-\d(\.\d)?)?$/.test(r.license)) out.push(`row ${r.id}: license ${r.license} is not CC0 or CC-BY`);
    if (r.license.startsWith('CC-BY') && (!r.credit || !readme.includes(r.credit))) out.push(`row ${r.id}: CC-BY credit missing from the README`);
    if (!r.name || !r.author) out.push(`row ${r.id}: name or author missing`);
    if (/mixamo|soldier\.glb|xbot|michelle/i.test(`${r.name} ${r.url}`)) out.push(`row ${r.id}: forbidden source`);
  }
  for (const s of sources) {
    if (!byId.has(s.id)) out.push(`source ${s.id} has no row`);
    if (/mixamo|soldier\.glb|xbot|michelle/i.test(`${s.name} ${s.page} ${s.files.map((f) => f.url).join(' ')}`)) out.push(`source ${s.id}: forbidden source`);
  }
  return out;
}

describe('LICENSES-ASSETS.md', () => {
  it('covers every manifest entry and only uses CC0 or credited CC-BY', () => {
    const table = rows(licensesMd);
    expect(problems(licensesMd)).toEqual([]);
    const used = new Set(manifest.entries.map((e) => e.license));
    console.log(`licenses check: ${manifest.entries.length} manifest entries use ${used.size} sources; ${table.length} rows; ${sources.length} sources`);
    expect(table.length).toBe(sources.length);
    for (const id of used) expect(table.some((r) => r.id === id)).toBe(true);
  });

  it('every source records a size and sha256 for every file, and an author', () => {
    for (const s of sources) {
      expect(s.author, s.id).toBeTruthy();
      for (const f of s.files) {
        expect(f.sha256, `${s.id} ${f.path}`).toMatch(/^[0-9a-f]{64}$/);
        expect(f.bytes, `${s.id} ${f.path}`).toBeGreaterThan(0);
        expect(f.url, s.id).toMatch(/^https:\/\//);
      }
    }
  });

  it('fails when a row is deleted', () => {
    const lines = licensesMd.split('\n');
    const at = lines.findIndex((l) => l.startsWith('| pp-'));
    expect(problems([...lines.slice(0, at), ...lines.slice(at + 1)].join('\n')).length).toBeGreaterThan(0);
  });

  it('fails when a license is changed to CC-BY-NC', () => {
    const lines = licensesMd.split('\n');
    const at = lines.findIndex((l) => l.startsWith('| kenney-'));
    const cells = lines[at]!.split(' | ');
    cells[4] = 'CC-BY-NC';
    const mutated = [...lines.slice(0, at), cells.join(' | '), ...lines.slice(at + 1)].join('\n');
    expect(problems(mutated).some((p) => p.includes('CC-BY-NC'))).toBe(true);
  });

  it('fails on a CC-BY row whose credit is not in the README', () => {
    const lines = licensesMd.split('\n');
    const at = lines.findIndex((l) => l.startsWith('| kenney-'));
    const cells = lines[at]!.split(' | ');
    cells[4] = 'CC-BY';
    cells[5] = 'Some Credit Text 12345';
    const mutated = [...lines.slice(0, at), cells.join(' | '), ...lines.slice(at + 1)].join('\n');
    expect(problems(mutated).some((p) => p.includes('credit missing'))).toBe(true);
  });

  it('the README has a credits section naming every source family', () => {
    expect(readme).toMatch(/^#+ .*credits/im);
    for (const name of ['Quaternius', 'Kenney', 'Poly Haven', 'ambientCG']) expect(readme).toContain(name);
    expect(readme).toContain('LICENSES-ASSETS.md');
  });

  it('commits no raw source: no archives or source images under src/assets or scripts/assets', async () => {
    const { execFileSync } = await import('node:child_process');
    const files = execFileSync('git', ['ls-files', 'src/assets', 'scripts/assets', '.'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(files.filter((f) => /\.(zip|blend|fbx|obj|jpe?g|png)$/i.test(f) && /^(src\/assets|scripts\/assets)\//.test(f))).toEqual([]);
    expect(files.filter((f) => f.endsWith('.zip'))).toEqual([]);
  });
});
