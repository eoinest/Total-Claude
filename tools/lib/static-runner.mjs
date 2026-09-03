#!/usr/bin/env node
/**
 * The production build, served to the machine next door.
 *
 * ## The measurement this exists for
 *
 * `npm run host` served the **Vite dev server**, and it did so for a reader who is not the
 * host. The host never feels that: his browser is on loopback, warm, and holds every transform
 * from the last run. The guest on the other laptop gets the un-warmed version of the same
 * thing — `<script src="/@vite/client">`, then 184 separate `/src/*.ts` fetches transformed on
 * demand and Vite's 6.17 MB pre-bundled three. Measured over 192.168.1.77 from a cold second
 * browser: **194 requests, 23.19 MB, 6.8 s to the lobby** on a 30 Mbit/s Wi-Fi profile. The
 * owner's friend opened the link and said it *"takes wayyyy too long to load"*, which was an
 * accurate report.
 *
 * The production build is one hashed entry and three chunks, gzipped — **6 requests, 821 kB,
 * 0.35 s** on the same profile — out of a 30 MB tree whose textures the optimiser has already
 * taken from 164.9 MB to 4.6 MB. Nothing about that build was new; it is what `npm run deploy`
 * has always shipped. It was simply not what the guest was being given. This file is the server
 * that gives it to them. `tools/qa-hostload.mjs` is the instrument for every number above.
 *
 * ## What it has to keep
 *
 * It is not a general file server dropped in beside a lobby that happens to work. Two things
 * travel in the document and the lobby refuses to guess either of them:
 *
 *   - **`<meta name="tc-relay">`** — the port of the relay `tools/host-lan.mjs` started beside
 *     this server. `resolveRelay()` in `src/ui/NetLobby.ts` ranks four sources and *"never a
 *     guess"* is the design; with the tag missing the server drops out of the ranking and every
 *     join silently falls through to "nothing", with a disabled Create button and a refusal
 *     about a static upload. A static server that forgot this tag would break the whole product
 *     while serving every byte correctly, which is why it is injected here and asserted in
 *     `tools/qa-net.mjs`'s `lan` arm.
 *   - **`<meta name="tc-lan">`** — the plaque, on a LAN bind only, so a host who opened
 *     `localhost` still gets an invite link naming the address the guest can reach.
 *
 * Both are written by `tools/lib/vite-runner.mjs` for the dev path. Neither is re-spelled here:
 * `lanPlaqueFor` and `relayPlaqueFor` live in `./server-plaques.mjs` and both runners import
 * them, because two spellings of the same fact is how the Bonjour name came to be wrong in two
 * files at once.
 *
 * ## And one thing it has to remove
 *
 * `vite.config.ts` injects `<script defer src="/_vercel/insights/script.js">` at build time.
 * On Vercel that file exists. Here it does not, and Chromium writes *"Failed to load resource:
 * the server responded with a status of 404"* into the console for it — unsuppressably, on
 * every load. Four console-cleanliness checks in `tools/qa-net.mjs` would go red on a beacon
 * for an analytics service the LAN has never heard of. The tag is stripped on the way out
 * rather than answered with a stub, because a request that is never made is cheaper than one
 * that is answered emptily.
 *
 * ## How it serves
 *
 *   - **MIME by extension**, from one table, with `charset=utf-8` on the text types.
 *   - **`Cache-Control` in three tiers.** `/bundle/*` is content-hashed by Rollup, so it is
 *     `immutable` for a year — a returning guest re-downloads none of it. `/assets/*` is *not*
 *     hashed (the optimiser rewrites the same filenames), so it gets an hour and an ETag: free
 *     inside the hour, a 304 of a few hundred bytes after it. HTML is `no-cache`, which means
 *     revalidate-every-time and not do-not-store — a rebuild has to be visible on the next
 *     reload or the owner changes code and wonders why nothing moved.
 *   - **Brotli and gzip for text**, negotiated from `Accept-Encoding`, computed once per file
 *     and memoised by mtime. Only above 1 kB, where the framing costs less than it saves, and
 *     never for a range request.
 *   - **Byte ranges**, on the identity representation, for the HDRIs — 22 MB of them, and a
 *     stream that cannot be resumed is a stream that starts again.
 *
 * ## Usage
 *
 *     node tools/lib/static-runner.mjs --port=5958 --root=/path/to/tree \
 *          --host=0.0.0.0 --relay-port=5959 --parent=<pid>
 *
 * Callers should not run this by hand. `startVite({ mode: 'static' })` in
 * `tools/lib/browser-budget.mjs` spawns it, with the same guard, registry entry and parent
 * watch the dev runner gets.
 */

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { lanPlaqueFor, relayPlaqueFor } from './server-plaques.mjs';

const args = new Map(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const i = a.indexOf('=');
      return i === -1 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)];
    })
);

const PORT = Number(args.get('port'));
const ROOT = args.get('root') ? path.resolve(args.get('root')) : process.cwd();
const DIST = path.resolve(args.get('dist') || path.join(ROOT, 'dist'));
const HOST = args.get('host') || '127.0.0.1';
const PARENT = Number(args.get('parent') || process.ppid);
const RELAY_PORT = Number(args.get('relay-port') || 0);
const LAN_PREFER = args.get('lan') || '';
const WATCH_MS = Number(process.env.TC_VITE_WATCH_MS || 2000);

if (!Number.isFinite(PORT) || PORT <= 0) {
  console.error('static-runner: --port=<n> is required');
  process.exit(2);
}
/* The same refusal `vite-runner.mjs` makes, for the same reason: 5173 is the owner's game. */
if (PORT === 5173 && process.env.TC_ALLOW_OWNER_PORT !== '1') {
  console.error("static-runner: 5173 belongs to the owner's playtest server. Use the 5900s.");
  process.exit(2);
}

try {
  await stat(path.join(DIST, 'index.html'));
} catch {
  console.error(`static-runner: ${path.join(DIST, 'index.html')} does not exist.`);
  console.error('Nothing to serve. `npm run build` writes it; `npm run host` does that for you.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types, and which of them are worth compressing
// ---------------------------------------------------------------------------

/**
 * One table, by extension. Everything the build actually emits is here; anything else gets
 * `application/octet-stream`, which a browser will download rather than mis-execute.
 *
 * `.hdr` is `image/vnd.radiance`. It is not a picture and no browser renders it — `RGBELoader`
 * reads the bytes itself — but naming it correctly keeps it out of the compressible set below,
 * which matters: Radiance RGBE is already dense and brotli spends 400 ms on a 6 MB file to save
 * about two per cent of it.
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.exr': 'image/x-exr',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';

/**
 * Worth compressing, and the threshold is not decoration.
 *
 * Text and JSON and SVG and wasm compress by three to five times; WebP, Radiance and the fonts
 * are already compressed and brotli makes them very slightly *larger* while costing CPU on
 * every first request. Below 1 kB the encoding framing and the extra round of headers is most
 * of the file.
 */
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|wasm|xml)|image\/svg\+xml)/;
const COMPRESS_MIN = 1024;

/**
 * Three tiers, and the middle one is the judgement.
 *
 * `/bundle/` is Rollup output with a content hash in every filename, so the name changes when
 * the bytes do and a year of `immutable` can never serve a stale one.
 *
 * `/assets/` is *not* hashed — `tools/optimize-assets.mjs` writes `rock_albedo.webp` over
 * `rock_albedo.webp` — so an immutable year there would pin a guest to whatever textures they
 * first saw. An hour with an ETag gives the returning guest a free cache hit inside the hour
 * and a 304 costing a few hundred bytes after it, and a rebuild is picked up within the hour
 * whatever they do.
 *
 * HTML is `no-cache`, which is *revalidate every time*, not *never store*. That is the whole
 * mechanism by which a rebuild becomes visible: the document is re-checked on every load, and
 * it names the new hashed bundle.
 */
const cacheControl = (urlPath, mime) => {
  if (mime.startsWith('text/html')) return 'no-cache';
  if (urlPath.startsWith('/bundle/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
};

// ---------------------------------------------------------------------------
// The document, with the two tags the lobby depends on
// ---------------------------------------------------------------------------

const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * `<meta name="tc-lan">` and `<meta name="tc-relay">`, injected into the built HTML.
 *
 * Character for character the tags `vite-runner.mjs` writes through `transformIndexHtml`, from
 * the same two functions, so the document a guest gets from the production path and the one a
 * guest gets from `--dev` differ in the bundle and in nothing the lobby reads.
 *
 * The Vercel beacon goes out here; see the header. `order: 'post'` in `vite.config.ts` put it
 * immediately before `</head>`, and the regex is anchored on the exact string that plugin
 * writes rather than on "any script tag", so a future third-party tag is not silently eaten.
 */
const injectTags = (html) => {
  const tags = [];
  const plaque = lanPlaqueFor({ host: HOST, port: PORT, relayPort: RELAY_PORT, prefer: LAN_PREFER });
  if (plaque) tags.push(`<meta name="tc-lan" content="${attr(JSON.stringify(plaque))}">`);
  const relay = relayPlaqueFor(RELAY_PORT);
  if (relay) tags.push(`<meta name="tc-relay" content="${attr(relay)}">`);
  let out = html.replace(/\s*<script defer src="\/_vercel\/insights\/script\.js"><\/script>/g, '');
  if (tags.length) out = out.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    ${tags.join('\n    ')}`);
  return out;
};

/** Transformed documents and compressed bodies, both keyed by mtime so a rebuild invalidates. */
const htmlCache = new Map();
const zipCache = new Map();

const transformedHtml = async (abs, st) => {
  const key = `${abs}:${st.mtimeMs}:${st.size}`;
  const hit = htmlCache.get(key);
  if (hit) return hit;
  const body = Buffer.from(injectTags(await readFile(abs, 'utf8')), 'utf8');
  // Two entries, not one: `index.html` and `viewer.html` are both live, and a cache of size
  // one would evict whichever was asked for second on every single request.
  if (htmlCache.size > 4) htmlCache.clear();
  htmlCache.set(key, body);
  return body;
};

/**
 * Compress once, keep the result.
 *
 * Brotli at quality 5 rather than 11: on `main-*.js` (789 kB) quality 11 takes about 2.5 s and
 * saves 4 % over quality 5's 60 ms. The first guest pays the compression, and 2.5 s of it on
 * the critical path would have undone a good part of what this whole change bought.
 */
const compressed = (buf, enc, key) => {
  const ck = `${key}:${enc}`;
  const hit = zipCache.get(ck);
  if (hit) return hit;
  const out = enc === 'br'
    ? zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    })
    : zlib.gzipSync(buf, { level: 6 });
  if (zipCache.size > 400) zipCache.clear();
  zipCache.set(ck, out);
  return out;
};

/** `br` if the client takes it, else `gzip`, else nothing. Order is by ratio, not preference. */
const negotiate = (accept) => {
  const a = String(accept ?? '').toLowerCase();
  if (/\bbr\b/.test(a)) return 'br';
  if (/\bgzip\b/.test(a)) return 'gzip';
  return null;
};

// ---------------------------------------------------------------------------
// The identity of this tree, for the harnesses that ask before they reuse a port
// ---------------------------------------------------------------------------

/**
 * `/__tc/tree`, and it says `static-runner` so a caller can tell which of the two it got.
 *
 * `probeTree()` in `tools/lib/browser-budget.mjs` accepts both names; `mode` is the field to
 * branch on. A harness that wants a dev server and finds this is being told something true and
 * useful, which is more than the previous answer — silence, and a warning about an
 * "unidentified listener".
 */
const treeIdentity = () => ({
  tc: 'static-runner',
  mode: 'static',
  root: ROOT,
  dist: DIST,
  pid: process.pid,
  port: PORT,
  host: HOST,
  parent: PARENT,
  startedAt: new Date().toISOString(),
});

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

const HEADERS_BASE = { 'x-tc-served': 'static' };

const send = (res, status, headers, body) => {
  res.writeHead(status, { ...HEADERS_BASE, ...headers });
  if (body === undefined || body === null) res.end();
  else res.end(body);
};

/**
 * Resolve a URL path inside `dist`, or refuse.
 *
 * `path.resolve` after decoding, then a containment check against `DIST + sep`. A traversal is
 * a 403 rather than a 404 because the two are different facts and a server that blurs them is
 * a server whose logs cannot be read.
 */
const resolveInDist = (urlPath) => {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const abs = path.resolve(DIST, `.${path.posix.normalize(decoded)}`);
  if (abs !== DIST && !abs.startsWith(DIST + path.sep)) return null;
  return abs;
};

const etagOf = (st, enc) => `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}${enc ? `-${enc}` : ''}"`;

const server = http.createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    send(res, 405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, 'method not allowed\n');
    return;
  }

  const urlPath = (req.url ?? '/').split('?')[0].split('#')[0];

  if (urlPath === '/__tc/tree') {
    send(res, 200, { 'content-type': 'application/json', 'cache-control': 'no-store' },
      JSON.stringify(treeIdentity()));
    return;
  }
  if (urlPath === '/__tc/lan') {
    const plaque = lanPlaqueFor({ host: HOST, port: PORT, relayPort: RELAY_PORT, prefer: LAN_PREFER });
    send(res, plaque ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' },
      plaque ? JSON.stringify(plaque) : '{"error":"not serving on a LAN address"}');
    return;
  }

  let abs = resolveInDist(urlPath);
  if (!abs) {
    send(res, 403, { 'content-type': 'text/plain; charset=utf-8' }, 'forbidden\n');
    return;
  }

  let st;
  try {
    st = await stat(abs);
    if (st.isDirectory()) {
      abs = path.join(abs, 'index.html');
      st = await stat(abs);
    }
  } catch {
    /*
     * A 404, and deliberately not an index.html fallback.
     *
     * This app routes entirely in the query string — `?room=`, `?mp=1`, `?battle=` — and has no
     * history paths at all, so every unknown path is a genuinely missing file. Serving the
     * document for one would turn a broken asset reference into a page that loads, renders
     * nothing and says nothing, which is the failure `tools/qa-preview.mjs` was written to
     * catch and would then be unable to see.
     */
    send(res, 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      `not found: ${urlPath}\n`);
    return;
  }

  const mime = mimeOf(abs);
  const isHtml = mime.startsWith('text/html');
  const cc = cacheControl(urlPath, mime);

  /*
   * HTML is read, transformed and served from memory: the two meta tags are computed per
   * process, not per file, so there is nothing to stream and a range request for a 1.4 kB
   * document is not a case worth having.
   */
  if (isHtml) {
    const body = await transformedHtml(abs, st);
    const enc = body.length >= COMPRESS_MIN ? negotiate(req.headers['accept-encoding']) : null;
    const payload = enc ? compressed(body, enc, `${abs}:${st.mtimeMs}:html`) : body;
    const etag = `"${payload.length.toString(16)}-${Math.round(st.mtimeMs).toString(16)}${enc ? `-${enc}` : ''}"`;
    const headers = {
      'content-type': mime,
      'cache-control': cc,
      vary: 'Accept-Encoding',
      etag,
      'last-modified': st.mtime.toUTCString(),
      'content-length': String(payload.length),
      ...(enc ? { 'content-encoding': enc } : {}),
    };
    if (req.headers['if-none-match'] === etag) {
      // `Vary` on the 304 too: the ETag is per-encoding, so a cache that stored this without it
      // could hand a brotli body to a client that only asked for gzip.
      send(res, 304, { etag, 'cache-control': cc, vary: 'Accept-Encoding' });
      return;
    }
    send(res, 200, headers, method === 'HEAD' ? undefined : payload);
    return;
  }

  /*
   * Byte ranges, on the identity representation only.
   *
   * A `Range` on a compressed body means a range of the *compressed* bytes, which no client
   * asks for and no client would know what to do with; RFC 9110 lets a server ignore the range
   * but not lie about it, so the encoding is simply not offered when a range is asked for.
   *
   * Only a single range is honoured. `multipart/byteranges` exists and nothing in this product
   * emits it — `RGBELoader` and `fetch` both ask for one interval — so an unparsed or multi
   * range falls through to a plain 200, which is a legal answer to any `Range`.
   */
  const rangeHeader = req.headers.range;
  const wantsRange = typeof rangeHeader === 'string' && /^bytes=\d*-\d*$/.test(rangeHeader.trim());
  const enc = !wantsRange && COMPRESSIBLE.test(mime) && st.size >= COMPRESS_MIN
    ? negotiate(req.headers['accept-encoding'])
    : null;
  const etag = etagOf(st, enc);

  if (req.headers['if-none-match'] === etag
    || (!req.headers['if-none-match'] && req.headers['if-modified-since']
      && new Date(req.headers['if-modified-since']).getTime() >= Math.floor(st.mtimeMs / 1000) * 1000)) {
    send(res, 304, {
      etag,
      'cache-control': cc,
      'accept-ranges': 'bytes',
      ...(COMPRESSIBLE.test(mime) ? { vary: 'Accept-Encoding' } : {}),
    });
    return;
  }

  const common = {
    'content-type': mime,
    'cache-control': cc,
    'accept-ranges': 'bytes',
    etag,
    'last-modified': st.mtime.toUTCString(),
    ...(COMPRESSIBLE.test(mime) ? { vary: 'Accept-Encoding' } : {}),
  };

  if (enc) {
    const payload = compressed(await readFile(abs), enc, `${abs}:${st.mtimeMs}`);
    send(res, 200,
      { ...common, 'content-encoding': enc, 'content-length': String(payload.length) },
      method === 'HEAD' ? undefined : payload);
    return;
  }

  if (wantsRange) {
    const [rawStart, rawEnd] = rangeHeader.trim().slice(6).split('-');
    let start;
    let end;
    if (rawStart === '') {
      // `bytes=-500` — the last 500 bytes, which is a suffix length and not an offset.
      const suffix = Number(rawEnd);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        send(res, 416, { 'content-range': `bytes */${st.size}` });
        return;
      }
      start = Math.max(0, st.size - suffix);
      end = st.size - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === '' ? st.size - 1 : Number(rawEnd);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
      send(res, 416, { ...common, 'content-range': `bytes */${st.size}` });
      return;
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, {
      ...HEADERS_BASE,
      ...common,
      'content-range': `bytes ${start}-${end}/${st.size}`,
      'content-length': String(end - start + 1),
    });
    if (method === 'HEAD') { res.end(); return; }
    createReadStream(abs, { start, end }).on('error', () => res.destroy()).pipe(res);
    return;
  }

  res.writeHead(200, { ...HEADERS_BASE, ...common, 'content-length': String(st.size) });
  if (method === 'HEAD') { res.end(); return; }
  createReadStream(abs).on('error', () => res.destroy()).pipe(res);
});

let closing = false;
const shutdown = (why, code) => {
  if (closing) return;
  closing = true;
  try { server.close(); } catch { /* already down */ }
  if (why) process.stderr.write(`static-runner: exiting (${why})\n`);
  process.exit(code ?? 0);
};
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(sig, 0));

server.on('error', (err) => {
  process.stderr.write(`static-runner: failed to listen on ${PORT}: ${err?.message ?? err}\n`);
  process.exit(1);
});

await new Promise((ok) => server.listen(PORT, HOST, ok));

/*
 * `TC_VITE_READY`, and the token is deliberately unchanged.
 *
 * It is the string `startVite()` in `tools/lib/browser-budget.mjs` waits for, and both runners
 * go through that one function. Inventing `TC_STATIC_READY` would have bought a more accurate
 * word and a second readiness path to keep in step with the first; the payload carries
 * `mode: 'static'` for anybody who needs to know which came up.
 */
process.stdout.write(
  `TC_VITE_READY ${JSON.stringify({
    port: PORT,
    base: `http://127.0.0.1:${PORT}`,
    host: HOST,
    mode: 'static',
    dist: DIST,
    lan: lanPlaqueFor({ host: HOST, port: PORT, relayPort: RELAY_PORT, prefer: LAN_PREFER }),
    pid: process.pid,
    root: ROOT,
  })}\n`
);

/*
 * Warm the compressor for the two files on the critical path, off the request path.
 *
 * Without this the *first* guest pays for brotli on `main-*.js` and the shared chunks — about
 * 120 ms at quality 5 — and the first guest is the only one this whole change is about. The
 * work happens after `listen` and after the hello line, so it costs the caller nothing.
 */
void (async () => {
  try {
    const html = await readFile(path.join(DIST, 'index.html'), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="(\/bundle\/[^"]+)"/g)) {
      const abs = path.join(DIST, m[1].slice(1));
      const st = await stat(abs).catch(() => null);
      if (!st || !COMPRESSIBLE.test(mimeOf(abs)) || st.size < COMPRESS_MIN) continue;
      const buf = await readFile(abs);
      for (const enc of ['br', 'gzip']) compressed(buf, enc, `${abs}:${st.mtimeMs}`);
    }
  } catch { /* the request path recomputes; this is only an optimisation */ }
})();

/*
 * The parent watch, identical in mechanism to `vite-runner.mjs`'s and for the same reason:
 * macOS has no `PR_SET_PDEATHSIG`, so a poll of `kill(pid, 0)` is the portable way to die with
 * a parent that was SIGKILLed and never got to send anything.
 */
const watch = setInterval(() => {
  if (!Number.isFinite(PARENT) || PARENT <= 1) { shutdown('no parent to watch', 0); return; }
  try {
    process.kill(PARENT, 0);
  } catch (err) {
    if (err?.code === 'ESRCH') shutdown(`parent ${PARENT} is gone`, 0);
    // EPERM: alive, not ours to signal. Keep serving.
  }
}, WATCH_MS);
watch.unref();
