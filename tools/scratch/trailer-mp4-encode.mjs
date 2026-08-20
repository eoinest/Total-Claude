/**
 * trailer-mp4-encode.mjs — the same 22 s cut, as H.264 + AAC in an MP4, under five million
 * bytes.
 *
 * The WebM on the r6 release is the reference and the edit is not reopened: this reads the
 * very same `cut-tw.json` and `mix-tw.f32` that `trailer-tw-cut.mjs` writes, so the beats, the
 * one-take ram and the sound are the shipped ones by construction rather than by resemblance.
 * Only the container and the two codecs change, because X's *upload* endpoint takes MP4 and
 * MOV and will not take a WebM at all.
 *
 * Still no ffmpeg. Playwright's bundled build is `--disable-everything` with libvpx and png —
 * VP8 only, no audio codec, no audio muxer — so it could not have made this file either. The
 * encoders are Chromium's own WebCodecs, reached from a page, with `mp4-muxer` next to them,
 * which is the sibling of the `webm-muxer` the VP9 path uses.
 *
 * The arithmetic does *not* carry over from the VP9 pass, which is the whole reason there is a
 * ladder in here. VP9 was asked for 1.45 Mb/s and delivered 1.62 — it overshoots by about 11 %
 * on this material — and H.264 buys less picture per bit than VP9 does, so both the ask and
 * what comes back have to be measured again from zero rather than scaled.
 *
 *   node tools/scratch/trailer-mp4-encode.mjs --probe
 *   node tools/scratch/trailer-mp4-encode.mjs --ladder=1200000,1600000,2000000
 *   node tools/scratch/trailer-mp4-encode.mjs --bitrate=1700000 --out=/tmp/tc-mp4/x.mp4
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const WORK = args.get('work') ?? '/tmp/tc-mp4';
const CUT = args.get('cut') ?? path.join(WORK, 'cut-tw.json');
const PCM = args.get('pcm') ?? path.join(WORK, 'mix-tw.f32');
const OUT = args.get('out') ?? path.join(WORK, 'total-claude-trailer-720p-twitter.mp4');
const META = args.get('meta') ?? path.join(WORK, 'cut-tw.meta.json');
const PORT = Number(args.get('port') ?? 5281);
const W = Number(args.get('w') ?? 1280);
const H = Number(args.get('h') ?? 720);
const FPS = 30;
/** High profile, level 3.1, no constraint flags: 1280x720p30 sits well inside 3.1. */
const CODEC = args.get('codec') ?? 'avc1.64001f';
const BITRATE = Number(args.get('bitrate') ?? 1700000);
const ABITRATE = Number(args.get('abitrate') ?? 96000);
const GOP = Number(args.get('gop') ?? 150);
/** AAC-LC's encoder delay, taken off in the PCM domain. Measured at 2112 +/- 16 samples
 *  on this machine; 2048 is two whole AAC frames of it and leaves 1.3 ms, which is under
 *  a frame of picture. `trailer-mp4-review.mjs` re-measures what is left. */
const APREROLL = Number(args.get('apreroll') ?? 2048);
const HW = args.get('hw') ?? null;                // 'prefer-hardware' | 'prefer-software'
const RATE = 48000;
const CH = 2;
const PROBE = args.has('probe');
const LADDER = args.has('ladder') ? args.get('ladder').split(',').map(Number) : null;
const ALADDER = args.has('aladder') ? args.get('aladder').split(',').map(Number) : null;
const NOAUDIO = args.has('noaudio');

const cut = JSON.parse(await readFile(CUT, 'utf8'));
const meta = JSON.parse(await readFile(META, 'utf8'));
const N = args.has('n') ? Number(args.get('n')) : cut.length;
const pcm = NOAUDIO ? Buffer.alloc(0) : await readFile(PCM);

const MUXER = (() => {
  const req = createRequire(import.meta.url);
  try { return req.resolve('mp4-muxer/build/mp4-muxer.mjs'); }
  catch { return '/tmp/tc-mp4-deps/node_modules/mp4-muxer/build/mp4-muxer.mjs'; }
})();
const muxerSrc = await readFile(MUXER);
const PAGE = '<!doctype html><meta charset=utf-8><title>tc mp4 encode</title>'
  + '<script type="module" src="/page.js"></script>';
const PAGE_JS = await readFile(new URL('./trailer-mp4-encode-page.js', import.meta.url));

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
    if (u.pathname === '/page.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(PAGE_JS);
    }
    if (u.pathname === '/mp4-muxer.mjs') {
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
   * Asked rather than assumed. The brief says Chromium reports these as supported; a claim
   * about a machine is cheap to check and this is the machine.
   */
  const base = ['avc1.42001f', 'avc1.4d001f', 'avc1.64001f', 'avc1.640020', 'avc1.42e01f',
    'hvc1.1.6.L93.B0', 'vp09.00.31.08', 'av01.0.05M.08'];
  const vc = [];
  for (const hw of [null, 'prefer-hardware', 'prefer-software']) {
    for (const codec of base) {
      vc.push({ codec, width: W, height: H, bitrate: BITRATE, framerate: FPS,
        ...(hw ? { hardwareAcceleration: hw } : {}) });
    }
  }
  const ac = [64000, 96000, 128000, 160000].map((b) => ({ codec: 'mp4a.40.2', sampleRate: RATE,
    numberOfChannels: CH, bitrate: b }))
    .concat([{ codec: 'mp4a.40.5', sampleRate: RATE, numberOfChannels: CH, bitrate: 64000 },
      { codec: 'opus', sampleRate: RATE, numberOfChannels: CH, bitrate: 80000 }]);
  const r = await page.evaluate(([v, a]) => window.__probe(v, a), [vc, ac]);
  console.log(`video encoders at ${W}x${H} (VideoEncoder.isConfigSupported):`);
  for (const x of r.video) {
    console.log(`  ${x.supported ? 'yes' : 'no '}  ${x.codec.padEnd(16)} ${x.hw}`);
  }
  console.log('audio encoders (AudioEncoder.isConfigSupported):');
  for (let i = 0; i < r.audio.length; i++) {
    console.log(`  ${r.audio[i].supported ? 'yes' : 'no '}  ${ac[i].codec} @ ${ac[i].bitrate / 1000} kb/s`);
  }
  await done();
}

const run = async (bitrate, abitrate, write) => {
  const job = page.evaluate((c) => window.__encode(c), {
    n: N, w: W, h: H, fps: FPS, codec: CODEC, bitrate, gop: GOP, hw: HW,
    keyframesAt: meta.keyframesAt, apreroll: APREROLL,
    audioBytes: NOAUDIO ? 0 : pcm.length, rate: RATE, channels: CH, abitrate, write,
  });
  if (!write) return job;
  const [r] = await Promise.all([job,
    page.waitForEvent('download', { timeout: 900000 })
      .then(async (d) => { await mkdir(path.dirname(OUT), { recursive: true }); await d.saveAs(OUT); })]);
  return r;
};

const PROFILES = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10' };
const say = (r) => `${PROFILES[r.profile] ?? r.profile} profile, level `
  + `${(r.level / 10).toFixed(1)}, constraint flags 0x${(r.constraints ?? 0).toString(16).padStart(2, '0')}`;

const secs = N / FPS;
if (LADDER || ALADDER) {
  console.log(`ladder: ${N} frames  ${secs.toFixed(2)} s  ${W}x${H}  ${CODEC}  `
    + `hw ${HW ?? 'no-preference'}\n`);
  const rows = [];
  for (const b of (LADDER ?? [BITRATE])) {
    for (const ab of (ALADDER ?? [ABITRATE])) {
      const r = await run(b, ab, false);
      if (r.err) { console.error('encode failed:', r.err); await done(1); }
      rows.push({ ask: b, aask: ab, ...r });
      console.log(`  ask ${(b / 1e6).toFixed(2)} Mb/s + aac ${ab / 1000} -> ${r.bytes} B  `
        + `video ${((r.vbytes * 8) / secs / 1e6).toFixed(2)} Mb/s  `
        + `audio ${((r.abytes * 8) / secs / 1000).toFixed(1)} kb/s  ${say(r)}  ${r.secs.toFixed(0)} s`);
    }
  }
  console.log('\nasked Mb/s   aac kb/s   total bytes    MB   video Mb/s   over ask   audio kb/s   under 5,000,000?');
  for (const r of rows) {
    const got = (r.vbytes * 8) / secs;
    console.log(`${(r.ask / 1e6).toFixed(2).padStart(9)}  ${String(r.aask / 1000).padStart(9)}  `
      + `${String(r.bytes).padStart(12)}  ${(r.bytes / 1e6).toFixed(2).padStart(5)}  `
      + `${(got / 1e6).toFixed(2).padStart(10)}  ${(((got / r.ask) - 1) * 100).toFixed(1).padStart(8)}%  `
      + `${((r.abytes * 8) / secs / 1000).toFixed(1).padStart(10)}   `
      + `${r.bytes < 5e6 ? 'yes, ' + (5e6 - r.bytes) + ' B spare' : 'NO, ' + (r.bytes - 5e6) + ' B over'}`);
  }
  await done();
}

console.log(`encode ${N} frames  ${W}x${H}  ${CODEC}  ${(BITRATE / 1e6).toFixed(2)} Mb/s  `
  + `gop ${GOP}  keys forced at ${meta.keyframesAt.join(',')}  `
  + `audio ${NOAUDIO ? 'none' : `aac-lc ${ABITRATE / 1000} kb/s`}  ${secs.toFixed(2)} s`);
const r = await run(BITRATE, ABITRATE, true);
if (r.err) { console.error('encode failed:', r.err); await done(1); }
const s = await stat(OUT);
console.log(`\n${s.size} bytes  (${(s.size / 1e6).toFixed(2)} MB)  `
  + `video ${(r.vbytes / 1e6).toFixed(2)} MB / ${((r.vbytes * 8) / secs / 1e6).toFixed(2)} Mb/s  `
  + `audio ${(r.abytes / 1000).toFixed(0)} kB / ${((r.abytes * 8) / secs / 1000).toFixed(1)} kb/s  `
  + `${r.vcount} chunks (${r.keys} key)  ${r.secs.toFixed(0)} s at ${r.fps.toFixed(1)} fps`);
console.log(`avcC      ${(r.avcC ?? []).slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join(' ')}`
  + `  -> ${say(r)}`);
console.log(`AudioSpecificConfig ${(r.audioDesc ?? []).map((b) => b.toString(16).padStart(2, '0')).join(' ')}`
  + `  packets ${r.audioFirstTs}..${r.audioLastTs} us, ${r.audioDropped} dropped past the picture,`
  + ` pre-roll ${APREROLL} samples (${((APREROLL / RATE) * 1000).toFixed(1)} ms)`);
console.log(`headroom under 5,000,000 bytes: ${5e6 - s.size} B`);
console.log(`-> ${OUT}`);
await done();
