// Multiplayer client odds and ends: the URL entry (?mp=1&server=&room=&name=, ?lag=), typed server addresses, and the
// client modules staying free of three.js and the DOM (they run in Node for the tests).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BadAddressError, cleanName, defaultServerAddress, netOptionsFromUrl, socketUrl } from '../../src/net/url';

const http = { protocol: 'http:', hostname: '192.168.2.13', port: '4210' };

describe('where a multiplayer game connects to', () => {
  it('only ?mp=1 asks for multiplayer', () => {
    expect(netOptionsFromUrl('?intro=0', http)).toBeNull();
    expect(netOptionsFromUrl('?mp=0&server=x', http)).toBeNull();
  });

  it('defaults: this host on 4210, room lobby, name Player; from an https page localhost', () => {
    expect(netOptionsFromUrl('?mp=1', http)).toEqual({ server: 'ws://192.168.2.13:4210', room: 'lobby', name: 'Player', link: undefined, predict: true });
    expect(defaultServerAddress({ protocol: 'https:', hostname: 'tengs-fan.github.io', port: '' })).toBe('ws://localhost:4210');
  });

  it('takes server, room, name and the simulated link options', () => {
    const o = netOptionsFromUrl('?mp=1&server=127.0.0.1:4236&room=val-cl&name=%20Ann%20%C3%BC%20&lag=100&jitter=15&loss=2', http)!;
    expect(o).toMatchObject({ server: '127.0.0.1:4236', room: 'val-cl', name: 'Ann ü', link: { latencyMs: 100, jitterMs: 15, loss: 0.02 } });
    expect(cleanName('x'.repeat(40))).toHaveLength(24);
    expect(cleanName('  ')).toBe('Player');
  });

  it('turns typed addresses into WebSocket URLs on /ws, and refuses what is none', () => {
    expect(socketUrl('localhost:4210')).toBe('ws://localhost:4210/ws');
    expect(socketUrl('ws://127.0.0.1:4236')).toBe('ws://127.0.0.1:4236/ws');
    expect(socketUrl('http://192.168.2.13:4210/')).toBe('ws://192.168.2.13:4210/ws');
    expect(socketUrl('https://game.example.org')).toBe('wss://game.example.org/ws');
    expect(socketUrl('wss://game.example.org/play')).toBe('wss://game.example.org/play');
    for (const bad of ['', 'not a server!!', 'ftp://x', '://']) expect(() => socketUrl(bad), bad).toThrow(BadAddressError);
  });
});

describe('layering: the client modules run without three.js or the DOM', () => {
  const ROOT = join(__dirname, '../..');
  const files = ['client.ts', 'mirror.ts', 'predictor.ts', 'interp.ts', 'transport.ts', 'url.ts', 'session.ts'].map((f) => join(ROOT, 'src/net', f));
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, '""');

  it('covers every file in src/net', () => {
    const all = readdirSync(join(ROOT, 'src/net')).filter((f) => f.endsWith('.ts'));
    expect(all.sort()).toEqual(['client.ts', 'interp.ts', 'mirror.ts', 'predictor.ts', 'protocol.ts', 'session.ts', 'transport.ts', 'url.ts', 'wire.ts']);
  });

  it('imports no three, render, ui, audio or input code, and references no document, window or localStorage', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) if (m[1] === 'three' || m[1]!.startsWith('three/') || /(^|\/)(render|ui|audio|input)\//.test(m[1]!) || m[1] === 'ws') bad.push(`${f}: ${m[1]}`);
      for (const m of code(src).matchAll(/(?<![\w$.])(document|window|localStorage)\b/g)) bad.push(`${f}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });

  it('single player reaches the client only through a dynamic import', () => {
    const game = readFileSync(join(ROOT, 'src/game.ts'), 'utf8');
    const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
    const staticNet = [...`${game}\n${main}`.matchAll(/^import (?!type)[^\n]*from '\.\/net\/([^']+)'/gm)].map((m) => m[1]);
    expect(staticNet).toEqual(['url']);
    expect(game).toContain("await import('./net/session')");
  });
});
