#!/usr/bin/env node
/**
 * menu-plates.mjs — regenerate the three backdrops behind the menu and the loading screen.
 *
 * One command, and it is the answer to the only real objection to pre-rendering a menu
 * backdrop: *it goes stale the day the map changes.*
 *
 *     node tools/menu-plates.mjs --port=5941
 *
 * That shoots `tools/shots/menu-plates.shot.mjs` through `tools/film.mjs` — the real
 * simulation, the real terrain, cameras on rails — encodes each shot to a seamless-looping
 * VP9 WebM, writes a poster still and a thumbnail beside it, and drops the lot into
 * `public/menu/`. Nothing is retouched and nothing is drawn by hand, so a plate is always a
 * photograph of the game as it is on the tree that made it.
 *
 * ---------------------------------------------------------------------------
 * Why this is not just `film.mjs --encode`
 * ---------------------------------------------------------------------------
 *
 * Three things the studio's own encoder cannot do, all of them specific to a backdrop rather
 * than to a film:
 *
 *  1. **VP9.** `film.mjs` encodes with Playwright's bundled ffmpeg, which is built
 *     `--disable-everything` with `libvpx` and carries VP8 and no more. VP8 at the bitrate a
 *     menu can afford is mush. Chromium's own `VideoEncoder` has VP9 and AV1, reachable from
 *     a page, which is the route `tools/scratch/trailer-encode.mjs` opened for the trailer;
 *     this is the same route with the frame size unpinned.
 *  2. **The loop dissolve.** See `tools/lib/menu-plates-page.js`. A backdrop plays forever, so
 *     the wrap has to be invisible, and the cheapest place to buy that is in the encode: the
 *     last second is dissolved into the first and the output comes out a second shorter. It
 *     costs no runtime code, no second `<video>` element and no bytes.
 *  3. **The stills.** The poster has to be *frame 0 of the video*, or the handover from the
 *     still that covers the load to the clip that replaces it is a visible jump.
 *
 * ---------------------------------------------------------------------------
 * The formats, and what happens when a browser has neither
 * ---------------------------------------------------------------------------
 *
 * **AVIF only, no WebP fallback.** Every engine has shipped AVIF since Edge 121 in January
 * 2024, and a browser that cannot decode one cannot run a WebGL2 game with MSAA, floating
 * point render targets and `createImageBitmap` either. Carrying a second copy of every still
 * to serve a browser that would fail four lines later is 40% more bytes for nothing.
 *
 * **VP9 in WebM**, which is Chrome, Edge, Firefox and Safari 14+.
 *
 * Both degrade to something rather than to nothing, which is the reason the decision is
 * cheap: `MenuBackdrop` shows the poster until the video reports it can play, and the poster
 * sits on top of the same gradient the menu had before any of this existed. A browser with no
 * VP9 keeps the still; a browser with no AVIF keeps the gradient, which is exactly what
 * shipped last week.
 *
 * ---------------------------------------------------------------------------
 * Flags
 * ---------------------------------------------------------------------------
 *
 *   --skip-capture     frames are already in --work; encode and write only
 *   --shots=a,b        only these plates
 *   --work=DIR         frame directory (default /tmp/tc-menu-plates)
 *   --out=DIR          where the plates land (default public/menu)
 *   --port=N           vite port for the capture (never 5173 — the owner's)
 *   --eport=N          port for the encoder's own frame server
 *   --vw= --vh=        video size (default 1280x720)
 *   --pw= --ph=        poster size (default 1600x900, the capture size)
 *   --tw= --th=        thumbnail size (default 480x270)
 *   --bitrate=N        VP9 target, bits/s (default 700000)
 *   --dissolve=N       loop crossfade, frames (default 30)
 *   --quality=N        AVIF quality 1..100 (default 52 poster, 46 thumb)
 *   --probe            print which codecs this Chromium can encode, and stop
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const num = (k, d) => Number(args.get(k) ?? d);

const SHOT = path.join(ROOT, 'tools', 'shots', 'menu-plates.shot.mjs');
const WORK = args.get('work') ?? '/tmp/tc-menu-plates';
const OUT = path.resolve(ROOT, args.get('out') ?? 'public/menu');
const PORT = num('port', 5941);
const EPORT = num('eport', 5942);
const VW = num('vw', 1280); const VH = num('vh', 720);
const PW = num('pw', 1600); const PH = num('ph', 900);
const TW = num('tw', 480); const TH = num('th', 270);
const BITRATE = num('bitrate', 700000);
const DISSOLVE = num('dissolve', 30);
const PQ = num('quality', 52);
const TQ = num('thumbquality', 46);
const CODEC = args.get('codec') ?? 'vp09.00.31.08';
const FPS = 30;
const ONLY = args.get('shots')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;

const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
const kb = (n) => `${(n / 1000).toFixed(0)} kB`;

// ---------------------------------------------------------------------------
// 1. Capture
// ---------------------------------------------------------------------------

if (!args.has('skip-capture') && !args.has('probe')) {
  const argv = [
    path.join(ROOT, 'tools', 'film.mjs'), SHOT,
    '--nooverlay', '--noencode', `--out=${WORK}`, `--port=${PORT}`,
    `--w=${PW}`, `--h=${PH}`,
  ];
  if (ONLY) argv.push(`--shots=${ONLY.join(',')}`, '--keepframes');
  console.log(`• capture   node ${argv.slice(1).map((a) => path.basename(a)).join(' ')}`);
  const r = spawnSync(process.execPath, argv, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error('capture failed'); process.exit(1); }
}

const FRAMEDIR = path.join(WORK, 'menu-plates', 'frames');
const all = (await readdir(FRAMEDIR)).filter((f) => f.endsWith('.jpg')).sort();
/** `<shot>-NNNNN.jpg` -> shot id -> the ordered frame list for that plate. */
const byShot = new Map();
for (const f of all) {
  const id = f.replace(/-\d+\.jpg$/, '');
  if (ONLY && !ONLY.includes(id)) continue;
  (byShot.get(id) ?? byShot.set(id, []).get(id)).push(path.join(FRAMEDIR, f));
}
if (byShot.size === 0) { console.error(`no frames in ${FRAMEDIR}`); process.exit(1); }

// ---------------------------------------------------------------------------
// 2. Encode
// ---------------------------------------------------------------------------

/*
 * `webm-muxer` is served to the page rather than imported here, because the muxing happens
 * next to the encoders, in the browser. Resolved from `node_modules` normally; the scratch
 * prefix is the fallback a git worktree needs, whose `node_modules` is a symlink to a
 * checkout that has the package in `package.json` and has not run an install since it was
 * added. `trailer-encode.mjs` carries the same pair for the same reason.
 */
const MUXER = (() => {
  const req = createRequire(import.meta.url);
  for (const p of ['webm-muxer/build/webm-muxer.mjs', '/tmp/tc-sound-deps/node_modules/webm-muxer/build/webm-muxer.mjs']) {
    try { return req.resolve(p); } catch { /* next */ }
  }
  throw new Error('webm-muxer not resolvable — `npm i` in the main checkout, or point --muxer at a copy');
})();
const muxerSrc = await readFile(MUXER);
const pageJs = await readFile(new URL('./lib/menu-plates-page.js', import.meta.url));
const PAGE = '<!doctype html><meta charset=utf-8><title>menu plates</title>'
  + '<script type="module" src="/page.js"></script>';

/** The frame list the page is currently allowed to fetch. Swapped between plates. */
let serving = [];

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
    if (u.pathname === '/page.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(pageJs); }
    if (u.pathname === '/webm-muxer.mjs') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(muxerSrc); }
    if (u.pathname.startsWith('/f/')) {
      const b = await readFile(serving[Number(u.pathname.slice(3))]);
      res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(b);
    }
    if (u.pathname === '/log' && req.method === 'POST') {
      const bufs = []; for await (const c of req) bufs.push(c);
      process.stdout.write(`\r    ${Buffer.concat(bufs).toString('utf8').slice(0, 90).padEnd(90)}`);
      res.writeHead(204); return res.end();
    }
    res.writeHead(404); res.end('no');
  } catch (e) { console.error('server:', e); res.writeHead(500); res.end('err'); }
});
await new Promise((r) => server.listen(EPORT, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ acceptDownloads: true });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${EPORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

if (args.has('probe')) {
  const cands = ['av01.0.04M.08', 'vp09.00.31.08', 'vp09.00.41.08', 'vp8']
    .map((codec) => ({ codec, width: VW, height: VH, bitrate: BITRATE, framerate: FPS }));
  for (const r of await page.evaluate((c) => window.__probe(c), cands)) {
    console.log(`${r.supported ? '✓' : '✗'} ${r.codec}${r.err ? '  ' + r.err : ''}`);
  }
  await browser.close(); server.close(); process.exit(0);
}

await mkdir(OUT, { recursive: true });
const report = [];

for (const [id, frames] of byShot) {
  serving = frames;
  console.log(`\n• ${id}  ${frames.length} frames -> ${frames.length - DISSOLVE} at ${VW}x${VH}`);

  const dest = path.join(OUT, `${id}.webm`);
  const job = page.evaluate((o) => window.__encode(o), {
    n: frames.length, dissolve: DISSOLVE, w: VW, h: VH, fps: FPS,
    codec: CODEC, bitrate: BITRATE, gop: 120,
  });
  const [r] = await Promise.all([
    job,
    page.waitForEvent('download', { timeout: 900000 }).then((d) => d.saveAs(dest)),
  ]);
  if (r.err) { console.error(`\n  encode failed: ${r.err}`); process.exit(1); }
  const vs = await stat(dest);

  // The poster is frame 0 of the *output*, which after the dissolve is the tail of the crane,
  // not the head of the capture — so it has to be composited the same way the encoder does or
  // the handover from still to video is a jump.
  const tail = sharp(frames[frames.length - DISSOLVE]).resize(PW, PH, { fit: 'fill' });
  const posterBuf = await tail.avif({ quality: PQ, effort: 6 }).toBuffer();
  await writeFile(path.join(OUT, `${id}.avif`), posterBuf);
  const thumbBuf = await sharp(frames[frames.length - DISSOLVE])
    .resize(TW, TH, { fit: 'cover' }).avif({ quality: TQ, effort: 6 }).toBuffer();
  await writeFile(path.join(OUT, `${id}-thumb.avif`), thumbBuf);

  console.log(`\r  webm  ${mb(vs.size)}  ${r.kbps.toFixed(0)} kb/s  ${r.keys} key of ${r.chunks}`
    + `  ${r.secs.toFixed(0)} s at ${r.fps.toFixed(1)} fps`.padEnd(30));
  console.log(`  avif  poster ${kb(posterBuf.length)} (${PW}x${PH})   thumb ${kb(thumbBuf.length)} (${TW}x${TH})`);
  report.push({ id, webm: vs.size, poster: posterBuf.length, thumb: thumbBuf.length });
}

await browser.close();
server.close();

const total = report.reduce((s, r) => s + r.webm + r.poster + r.thumb, 0);
const firstPaint = report.length ? report[0].poster : 0;
console.log(`\n→ ${path.relative(ROOT, OUT)}/  ${report.length} plate(s), ${mb(total)} on disk`);
console.log(`  a first page open fetches one poster: about ${kb(firstPaint)}.`);
console.log('  the WebM is `preload="none"` and only starts once the menu is idle.');
