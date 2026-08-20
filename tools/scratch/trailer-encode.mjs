/**
 * trailer-encode.mjs — encode the trailer at native 1080p, with sound, using no ffmpeg.
 *
 * The released cut is 1600x900 VP8 at 14.2 MB, and both of those numbers are artefacts of the
 * only encoder the previous pass could reach: Playwright's bundled ffmpeg, built
 * `--disable-everything` with `libvpx` (VP8) and `png`. No VP9, no AV1, and no audio codec or
 * audio muxer at all. VP8 at 1080p over eighty-four seconds of grass, dust and eight thousand
 * moving men pinned its quantiser at the ceiling for the whole run and still came out at
 * 68.8 MB, so the picture was downscaled to fit a file that was going to live in every clone.
 * It is not going in a clone any more — it is a release asset — so the constraint is gone.
 *
 * Chromium has better encoders than that ffmpeg does, and they are reachable from a page:
 * `VideoEncoder` (VP9 / AV1) and `AudioEncoder` (Opus), both WebCodecs. `webm-muxer` takes
 * their output directly. So the whole encode happens in one page:
 *
 *   frames (1920x1080 JPEG, over a local HTTP server) -> createImageBitmap -> VideoFrame
 *      -> VideoEncoder -> ─┐
 *   mix.f32 (48 kHz stereo) -> AudioData -> AudioEncoder (Opus) -> ─┴─> webm-muxer -> POST back
 *
 * Nothing is installed system-wide; the only new dependency is the muxer.
 *
 *   node tools/scratch/trailer-encode.mjs --probe            # what this Chromium can encode
 *   node tools/scratch/trailer-encode.mjs --bench=150        # fps and bytes/frame, per codec
 *   node tools/scratch/trailer-encode.mjs --codec=vp09.00.41.08 --bitrate=16000000
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const WORK = args.get('work') ?? '/tmp/tc-sound';
const CUT = args.get('cut') ?? '/tmp/tc-trailer-frames/cut.json';
const PCM = args.get('pcm') ?? path.join(WORK, 'mix.f32');
const OUT = args.get('out') ?? path.join(WORK, 'total-claude-trailer-sound.webm');
const PORT = Number(args.get('port') ?? 5238);
const FPS = 30;
const CODEC = args.get('codec') ?? 'vp09.00.41.08';
const BITRATE = Number(args.get('bitrate') ?? 16000000);
const ABITRATE = Number(args.get('abitrate') ?? 128000);
const GOP = Number(args.get('gop') ?? 150);
const RATE = Number(args.get('rate') ?? 48000);
const CH = 2;
const PROBE = args.has('probe');
const BENCH = args.has('bench') ? Number(args.get('bench')) : 0;
// Where a bench starts. Benching the opening beat measures a dawn field at rest; the encode
// is decided by the clash, the escalade and the gate mouth in shadow, so those are the frames
// a bench should see. Frame 1710 is the ram push at 0:57.
const FROM = Number(args.get('from') ?? 0);
const NOAUDIO = args.has('noaudio');

const cut = JSON.parse(await readFile(CUT, 'utf8'));
const ALL = FROM ? cut.slice(FROM) : cut;
const N = BENCH || ALL.length;
const pcm = NOAUDIO ? Buffer.alloc(0) : await readFile(PCM);
/*
 * `webm-muxer` is the one dependency this needs, and it is served to the page rather than
 * imported here: the muxing happens next to the encoders, in the browser. Resolved from
 * `node_modules` normally; the scratch prefix is the fallback for a git worktree whose
 * `node_modules` is a symlink to a checkout that has not installed it yet.
 */
const MUXER = (() => {
  const req = createRequire(import.meta.url);
  try { return req.resolve('webm-muxer/build/webm-muxer.mjs'); }
  catch { return '/tmp/tc-sound-deps/node_modules/webm-muxer/build/webm-muxer.mjs'; }
})();
const muxerSrc = await readFile(MUXER);

const PAGE = '<!doctype html><meta charset=utf-8><title>tc encode</title>'
  + '<script type="module" src="/page.js"></script>';
const PAGE_JS = await readFile(new URL('./trailer-encode-page.js', import.meta.url));

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
    if (u.pathname === '/page.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(PAGE_JS);
    }
    if (u.pathname === '/webm-muxer.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(muxerSrc);
    }
    if (u.pathname === '/pcm') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(pcm);
    }
    if (u.pathname.startsWith('/f/')) {
      const i = Number(u.pathname.slice(3));
      const b = await readFile(ALL[i]);
      res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(b);
    }
    if (u.pathname === '/log' && req.method === 'POST') {
      const bufs = []; for await (const c of req) bufs.push(c);
      console.log('  ' + Buffer.concat(bufs).toString('utf8').slice(0, 500));
      res.writeHead(204); return res.end();
    }
    if (u.pathname === '/out' && req.method === 'POST') {
      // Straight to disk. A hundred and thirty megabytes is not something to accumulate in
      // an array of chunks and concatenate, and it is certainly not a string.
      await mkdir(path.dirname(OUT), { recursive: true });
      const ws = createWriteStream(OUT);
      await pipeline(req, ws);
      res.writeHead(204); return res.end();
    }
    console.error(`  ! unrouted ${req.method} ${u.pathname}`);
    res.writeHead(404); res.end('no');
  } catch (e) { console.error('  ! server:', e.stack ?? e); res.writeHead(500); res.end('err'); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ acceptDownloads: true });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

const W = 1920, H = 1080;
if (PROBE) {
  const cands = [
    'av01.0.08M.08', 'av01.0.09M.08', 'vp09.00.41.08', 'vp09.00.40.08', 'vp09.02.41.10', 'vp8',
  ].map((codec) => ({ codec, width: W, height: H, bitrate: BITRATE, framerate: FPS }));
  const r = await page.evaluate((c) => window.__probe(c), cands);
  for (const x of r) console.log(`${x.supported ? '✓' : '✗'} ${x.codec}${x.err ? '  ' + x.err : ''}`);
  const ar = await page.evaluate(() => AudioEncoder.isConfigSupported(
    { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }));
  console.log(`${ar.supported ? '✓' : '✗'} opus`);
  await browser.close(); server.close(); process.exit(0);
}

console.log(`encode ${N} frames  ${W}x${H}  ${CODEC}  ${(BITRATE / 1e6).toFixed(1)} Mb/s  `
  + `gop ${GOP}  audio ${NOAUDIO ? 'none' : `opus ${(ABITRATE / 1000)} kb/s, ${(pcm.length / 4 / CH / RATE).toFixed(2)} s`}`);
const job = page.evaluate((c) => window.__encode(c), {
  n: N, w: W, h: H, fps: FPS, codec: CODEC, bitrate: BITRATE, gop: GOP,
  audioBytes: NOAUDIO ? 0 : pcm.length, rate: RATE, channels: CH, abitrate: ABITRATE,
  write: !BENCH,
});
const [r] = BENCH
  ? [await job]
  : await Promise.all([job, page.waitForEvent('download', { timeout: 900000 })
    .then(async (d) => { await mkdir(path.dirname(OUT), { recursive: true }); await d.saveAs(OUT); })]);
await browser.close();
server.close();
if (r.err) { console.error('encode failed:', r.err); process.exit(1); }
console.log(`\n${(r.bytes / 1e6).toFixed(1)} MB total  video ${(r.vbytes / 1e6).toFixed(1)} MB  `
  + `${r.vcount} chunks (${r.keys} key)  ${r.secs.toFixed(0)} s at ${r.fps.toFixed(1)} fps  `
  + `${((r.vbytes * 8) / (N / FPS) / 1e6).toFixed(1)} Mb/s video`);
if (!BENCH) {
  const s = await stat(OUT);
  console.log(`→ ${OUT}  ${(s.size / 1e6).toFixed(1)} MB`);
}
