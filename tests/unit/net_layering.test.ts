// Layering of the multiplayer code (same rules as cross_determinism's layering check for core, world and sim): the
// protocol and the server never touch three.js or the DOM, the protocol imports no presentation code, and the ws
// package stays on the server (the browser bundle has none of it).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.ts$/.test(f) ? [p] : [];
  });
}

/** Source with comments and string/template contents blanked, so only code is searched. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => (m.startsWith('/') ? '' : m[0]! + m[0]!));
}

const importsOf = (src: string) => [...src.matchAll(/(?:from|import|require\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);

const PURE_NET = ['src/net/protocol.ts', 'src/net/wire.ts', 'src/sim/snapshot.ts'].map((f) => join(ROOT, f));
const SERVER = sources(join(ROOT, 'server'));
const SCANNED = [...PURE_NET, ...SERVER];

describe('layering: the protocol and the server stay free of three.js and the browser', () => {
  it('scans the protocol and every server file', () => {
    const names = SCANNED.map((f) => relative(ROOT, f));
    console.log(`[layering] scanned ${names.length} files: ${names.join(', ')}`);
    expect(names).toContain('src/net/protocol.ts');
    expect(names).toContain('server/main.ts');
    expect(SERVER.length).toBeGreaterThanOrEqual(10);
  });

  it('nothing imports three or three/addons', () => {
    const bad = SCANNED.filter((f) => importsOf(readFileSync(f, 'utf8')).some((s) => s === 'three' || s.startsWith('three/')));
    expect(bad).toEqual([]);
  });

  it('no code references document, window or localStorage', () => {
    const bad = SCANNED.flatMap((f) => [...codeOnly(readFileSync(f, 'utf8')).matchAll(/(?<![\w$.])(document|window|localStorage)\b/g)].map((m) => `${relative(ROOT, f)}: ${m[1]}`));
    expect(bad).toEqual([]);
  });

  it('the protocol imports nothing from render, ui, audio or input, and no Node module', () => {
    const bad = PURE_NET.flatMap((f) => importsOf(readFileSync(f, 'utf8')).filter((s) => /(^|\/)(render|ui|audio|input)\//.test(s) || s.startsWith('node:') || s === 'ws').map((s) => `${relative(ROOT, f)}: ${s}`));
    expect(bad).toEqual([]);
  });

  it('ws is used only by server/ (and tests), and the browser bundle has none of it', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.dependencies.ws).toBeDefined();
    expect(pkg.devDependencies.tsx).toBeDefined();
    const clientImportsWs = sources(join(ROOT, 'src')).filter((f) => importsOf(readFileSync(f, 'utf8')).includes('ws'));
    expect(clientImportsWs).toEqual([]);
    const assets = join(ROOT, 'dist', 'assets');
    if (!existsSync(assets)) return;
    // Strings only the ws package carries: its handshake GUID, its server class, its permessage-deflate option.
    const marks = ['258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'WebSocketServer', 'perMessageDeflate', 'Sec-WebSocket-Accept'];
    const hits = readdirSync(assets).filter((f) => /\.js$/.test(f)).flatMap((f) => {
      const js = readFileSync(join(assets, f), 'utf8');
      return marks.filter((m) => js.includes(m)).map((m) => `${f}: ${m}`);
    });
    expect(hits).toEqual([]);
  });
});
