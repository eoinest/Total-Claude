/**
 * trailer-tw-encode.mjs — the 22 s cut at 1280x720, VP9 + Opus, under five million bytes.
 *
 * Same pipeline as `trailer-encode.mjs` and for the same reason: Playwright's bundled ffmpeg
 * is built `--disable-everything` with libvpx and png — VP8 only, no audio codec, no audio
 * muxer — so the encoders that can do this job are Chromium's own WebCodecs, reached from a
 * page, with `webm-muxer` next to them. Nothing is installed system-wide.
 *
 * What is different is the arithmetic. Five megabytes over the 86 s cut is 465 kb/s, and this
 * material — dust, smoke, thousands of moving men — does not survive that at any resolution.
 * So the cut is 21.8 s instead, which buys about 1.7 Mb/s, and the frame is 1280x720 rather
 * than 1080p because the file is a *source for Twitter's transcoder*, not the finished
 * artefact: banding and blocking survive a second pass and get worse, so bits per pixel matter
 * more than pixels.
 *
 *   node tools/scratch/trailer-tw-encode.mjs --probe
 *   node tools/scratch/trailer-tw-encode.mjs --ladder=1200000,1600000,2000000,2400000
 *   node tools/scratch/trailer-tw-encode.mjs --bitrate=1700000 --out=/tmp/tc-tw/x.webm
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const WORK = args.get('work') ?? '/tmp/tc-tw';
const CUT = args.get('cut') ?? path.join(WORK, 'cut-tw.json');
const PCM = args.get('pcm') ?? path.join(WORK, 'mix-tw.f32');
const OUT = args.get('out') ?? path.join(WORK, 'total-claude-trailer-720p-twitter.webm');
const META = args.get('meta') ?? path.join(WORK, 'cut-tw.meta.json');
const PORT = Number(args.get('port') ?? 5272);
const W = Number(args.get('w') ?? 1280);
const H = Number(args.get('h') ?? 720);
const FPS = 30;
const CODEC = args.get('codec') ?? 'vp09.00.31.08';   // profile 0, level 3.1, 8-bit: 720p30
const BITRATE = Number(args.get('bitrate') ?? 1700000);
const ABITRATE = Number(args.get('abitrate') ?? 80000);
const GOP = Number(args.get('gop') ?? 150);
const RATE = 48000;
const CH = 2;
const PROBE = args.has('probe');
const LADDER = args.has('ladder') ? args.get('ladder').split(',').map(Number) : null;
const NOAUDIO = args.has('noaudio');

const cut = JSON.parse(await readFile(CUT, 'utf8'));
const meta = JSON.parse(await readFile(META, 'utf8'));
const N = args.has('n') ? Number(args.get('n')) : cut.length;
const pcm = NOAUDIO ? Buffer.alloc(0) : await readFile(PCM);

const MUXER = (() => {
  const req = createRequire(import.meta.url);
  try { return req.resolve('webm-muxer/build/webm-muxer.mjs'); }
  catch { return '/tmp/tc-sound-deps/node_modules/webm-muxer/build/webm-muxer.mjs'; }
})();
const muxerSrc = await readFile(MUXER);
const PAGE = '<!doctype html><meta charset=utf-8><title>tc tw encode</title>'
  + '<script type="module" src="/page.js"></script>';
const PAGE_JS = await readFile(new URL('./trailer-tw-encode-page.js', import.meta.url));

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
      const b = await readFile(cut[Number(u.pathname.slice(3))]);
      res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(b);
    }
    if (u.pathname === '/log' && req.method === 'POST') {
      const bufs = []; for await (const c of req) bufs.push(c);
      console.log('  ' + Buffer.concat(bufs).toString('utf8').slice(0, 400));
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

const done = async (code = 0) => { await browser.close(); server.close(); process.exit(code); };

if (PROBE) {
  /*
   * The probe also asks about H.264 and AAC, which this file does not use.
   *
   * X/Twitter's *upload* endpoint takes MP4 and MOV, not WebM, so whether this machine can
   * make an MP4 at all without ffmpeg is worth knowing and is one API call to find out. The
   * brief asks for VP9 + Opus and that is what ships; this is so the answer is on the record
   * rather than assumed either way.
   */
  const vc = ['vp09.00.31.08', 'vp09.00.40.08', 'vp09.02.31.10', 'av01.0.05M.08', 'avc1.42001f',
    'avc1.4d001f', 'avc1.64001f', 'hvc1.1.6.L93.B0', 'vp8']
    .map((codec) => ({ codec, width: W, height: H, bitrate: BITRATE, framerate: FPS }));
  const ac = [64000, 80000, 96000, 128000].map((b) => ({ codec: 'opus', sampleRate: RATE,
    numberOfChannels: CH, bitrate: b }))
    .concat([{ codec: 'mp4a.40.2', sampleRate: RATE, numberOfChannels: CH, bitrate: 96000 }]);
  const r = await page.evaluate(([v, a]) => window.__probe(v, a), [vc, ac]);
  console.log(`video encoders at ${W}x${H}:`);
  for (const x of r.video) console.log(`  ${x.supported ? 'yes' : 'no '}  ${x.codec}`);
  console.log('audio encoders:');
  for (let i = 0; i < r.audio.length; i++) {
    console.log(`  ${r.audio[i].supported ? 'yes' : 'no '}  ${ac[i].codec} @ ${ac[i].bitrate / 1000} kb/s`);
  }
  await done();
}

const run = async (bitrate, abitrate, write) => {
  const job = page.evaluate((c) => window.__encode(c), {
    n: N, w: W, h: H, fps: FPS, codec: CODEC, bitrate, gop: GOP,
    keyframesAt: meta.keyframesAt,
    audioBytes: NOAUDIO ? 0 : pcm.length, rate: RATE, channels: CH, abitrate, write,
  });
  if (!write) return job;
  const [r] = await Promise.all([job,
    page.waitForEvent('download', { timeout: 900000 })
      .then(async (d) => { await mkdir(path.dirname(OUT), { recursive: true }); await d.saveAs(OUT); })]);
  return r;
};

const secs = N / FPS;
if (LADDER) {
  console.log(`ladder: ${N} frames  ${(secs).toFixed(2)} s  ${W}x${H}  ${CODEC}  `
    + `opus ${ABITRATE / 1000} kb/s\n`);
  const rows = [];
  for (const b of LADDER) {
    const r = await run(b, ABITRATE, false);
    if (r.err) { console.error('encode failed:', r.err); await done(1); }
    rows.push({ ask: b, ...r });
    console.log(`  ask ${(b / 1e6).toFixed(2)} Mb/s -> ${r.bytes} B  `
      + `video ${((r.vbytes * 8) / secs / 1e6).toFixed(2)} Mb/s  ${r.secs.toFixed(0)} s`);
  }
  console.log('\nasked Mb/s   total bytes    MB   video Mb/s   audio kb/s   under 5,000,000?');
  for (const r of rows) {
    console.log(`${(r.ask / 1e6).toFixed(2).padStart(9)}  ${String(r.bytes).padStart(12)}  `
      + `${(r.bytes / 1e6).toFixed(2).padStart(5)}  ${((r.vbytes * 8) / secs / 1e6).toFixed(2).padStart(10)}  `
      + `${((r.abytes * 8) / secs / 1000).toFixed(1).padStart(10)}   `
      + `${r.bytes < 5e6 ? 'yes, ' + (5e6 - r.bytes) + ' B spare' : 'NO'}`);
  }
  await done();
}

console.log(`encode ${N} frames  ${W}x${H}  ${CODEC}  ${(BITRATE / 1e6).toFixed(2)} Mb/s  `
  + `gop ${GOP}  keys forced at ${meta.keyframesAt.join(',')}  `
  + `audio ${NOAUDIO ? 'none' : `opus ${ABITRATE / 1000} kb/s`}  ${secs.toFixed(2)} s`);
const r = await run(BITRATE, ABITRATE, true);
if (r.err) { console.error('encode failed:', r.err); await done(1); }
const s = await stat(OUT);
console.log(`\n${s.size} bytes  (${(s.size / 1e6).toFixed(2)} MB)  `
  + `video ${(r.vbytes / 1e6).toFixed(2)} MB / ${((r.vbytes * 8) / secs / 1e6).toFixed(2)} Mb/s  `
  + `audio ${(r.abytes / 1000).toFixed(0)} kB / ${((r.abytes * 8) / secs / 1000).toFixed(1)} kb/s  `
  + `${r.vcount} chunks (${r.keys} key)  ${r.secs.toFixed(0)} s at ${r.fps.toFixed(1)} fps`);
console.log(`headroom under 5,000,000 bytes: ${5e6 - s.size} B`);
console.log(`-> ${OUT}`);
await done();
