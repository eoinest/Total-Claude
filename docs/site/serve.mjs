#!/usr/bin/env node
/**
 * Preview the built site locally. Never 5173 — that port belongs to the owner's playtest
 * server and `vite.config.ts` pins the game's dev server to it.
 *
 * Usage: node serve.mjs [--port=8477] [--dir=dist]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 8477);
if (PORT === 5173) { console.error('refusing 5173'); process.exit(2); }
const DIR = path.resolve(import.meta.dirname, args.get('dir') ?? 'dist');

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.json': 'application/json' };

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const abs = path.join(DIR, p);
    if (!abs.startsWith(DIR)) { res.writeHead(403).end('no'); return; }
    const s = await stat(abs).catch(() => null);
    if (!s?.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`404 ${p}`); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs)] ?? 'application/octet-stream' });
    res.end(await readFile(abs));
  } catch (e) { res.writeHead(500).end(String(e)); }
}).listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}/  (pid ${process.pid})`));
