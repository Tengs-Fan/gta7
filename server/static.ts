// Serves the built client (dist/) read-only. Paths are decoded and resolved, and anything that would resolve outside
// the root (dot segments, encoded slashes, NUL bytes) is refused before the file system is touched.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

/** The file a request path maps to inside `root`, or null when it is malformed or would leave the root. */
export function resolveStatic(root: string, url: string): string | null {
  const q = url.indexOf('?');
  const rawPath = (q >= 0 ? url.slice(0, q) : url).split('#')[0]!;
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!path.startsWith('/') || path.includes('\0') || path.includes('\\')) return null;
  if (path.split('/').some((seg) => seg === '..')) return null;
  if (path.endsWith('/')) path += 'index.html';
  const base = resolve(root);
  const file = resolve(base, '.' + path);
  if (file !== base && !file.startsWith(base + sep)) return null;
  return file;
}

function plain(res: ServerResponse, code: number, text: string, head: boolean): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text), 'x-content-type-options': 'nosniff' });
  res.end(head ? undefined : text);
}

export async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) {
    res.setHeader('allow', 'GET, HEAD');
    return plain(res, 405, 'Method not allowed\n', head);
  }
  const file = resolveStatic(root, req.url ?? '/');
  if (!file) return plain(res, 404, 'Not found\n', head);
  let info;
  try {
    info = await stat(file);
  } catch {
    return plain(res, 404, 'Not found\n', head);
  }
  if (!info.isFile()) return plain(res, 404, 'Not found\n', head);
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const hashed = /[.-][A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|svg|webp)$/.test(file);
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'cache-control': type.startsWith('text/html') ? 'no-cache' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  });
  if (head) {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
