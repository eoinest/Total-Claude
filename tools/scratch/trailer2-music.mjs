#!/usr/bin/env node
/**
 * trailer2-music.mjs — decode a licensed music file, measure its beat grid, and cut a bed to
 * exactly the length of a film.
 *
 * There is still no ffmpeg on this machine (Playwright's bundled build is `--disable-everything`
 * with libvpx and png: no decoders, no audio anything), so the decode happens where every other
 * audio decode in this repo happens — inside a Chromium page, through
 * `OfflineAudioContext.decodeAudioData`, which resamples to 48 kHz on the way out. The page does
 * nothing but decode and POST the samples back; all of the measurement and all of the editing is
 * Node-side and therefore diffable.
 *
 *   node tools/scratch/trailer2-music.mjs --in=x.mp3 --analyse
 *   node tools/scratch/trailer2-music.mjs --in=x.mp3 --grid=12.5 --bars=16
 *   node tools/scratch/trailer2-music.mjs --in=x.mp3 --from=61.71 --frames=855 \
 *        --fadein=0.0 --fadeout=1.6 --gain=1.0 --out=/tmp/…/music.f32
 *
 * **Nothing here touches `src/`.** It is an edit-side tool: its input is a downloaded, licensed
 * audio file and its output is the interleaved 48 kHz stereo Float32 buffer that
 * `trailer-encode.mjs` and `trailer-mp4-encode.mjs` already take as `--pcm`.
 *
 * ## Why the tempo is measured rather than read off a web page
 *
 * The cut is beat-matched, so every shot boundary in the shot script is a multiple of one beat
 * from the bed's first downbeat. A BPM taken from a track listing is rounded, and a rounded BPM
 * drifts by a whole frame of picture inside twenty seconds. This measures the period from the
 * audio itself: a spectral-flux onset envelope at 100 Hz, autocorrelated over 0.25–1.5 s, then
 * refined to the sample by maximising the envelope sum over a comb at the winning period.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const IN = args.get('in');
if (!IN) { console.error('need --in=<file.mp3|file.wav>'); process.exit(2); }
const PORT = Number(args.get('port') ?? 5947);
const RATE = 48000;
const CH = 2;
const FPS = 30;

if (!/\.(mp3|wav)$/i.test(IN)) {
  console.error(`refusing ${path.extname(IN)}: this tool takes .mp3 and .wav and nothing else.`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------
// Decode, in a page
// ---------------------------------------------------------------------------------------

const src = await readFile(IN);
let got = null;
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><meta charset=utf-8><title>tc decode</title>'
      + '<script type="module" src="/page.js"></script>');
  }
  if (u.pathname === '/page.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(`
      const r = await fetch('/audio'); const buf = await r.arrayBuffer();
      const ctx = new OfflineAudioContext(${CH}, 1, ${RATE});
      const ab = await ctx.decodeAudioData(buf);
      const n = ab.length, out = new Float32Array(n * ${CH});
      const L = ab.getChannelData(0);
      const R = ab.numberOfChannels > 1 ? ab.getChannelData(1) : L;
      for (let i = 0; i < n; i++) { out[i * 2] = L[i]; out[i * 2 + 1] = R[i]; }
      await fetch('/pcm?rate=' + ab.sampleRate + '&n=' + n, { method: 'POST', body: out.buffer });
      window.__done = true;
    `);
  }
  if (u.pathname === '/audio') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(src);
  }
  if (u.pathname === '/pcm' && req.method === 'POST') {
    const bufs = []; for await (const c of req) bufs.push(c);
    got = { rate: Number(u.searchParams.get('rate')), n: Number(u.searchParams.get('n')),
      buf: Buffer.concat(bufs) };
    res.writeHead(204); return res.end();
  }
  res.writeHead(404); res.end('no');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => { console.error('pageerror:', e.message); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__done === true, null, { timeout: 180000 });
await browser.close();
server.close();

if (!got) { console.error('the page decoded nothing'); process.exit(1); }
if (got.rate !== RATE) console.warn(`! decoded at ${got.rate} Hz, expected ${RATE}`);
const pcm = new Float32Array(got.buf.buffer, got.buf.byteOffset, got.buf.byteLength / 4);
const N = got.n;
const dur = N / RATE;
console.log(`${path.basename(IN)}  ${(src.length / 1e6).toFixed(2)} MB  ->  `
  + `${N} samples/ch @ ${got.rate} Hz  ${dur.toFixed(3)} s`);

// ---------------------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------------------

const mono = new Float32Array(N);
for (let i = 0; i < N; i++) mono[i] = (pcm[i * 2] + pcm[i * 2 + 1]) * 0.5;

const rms = (a, from = 0, n = a.length) => {
  let s = 0; for (let i = from; i < from + n; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, n));
};
const peak = (a) => { let p = 0; for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i])); return p; };
const dbfs = (x) => (x > 0 ? +(20 * Math.log10(x)).toFixed(2) : -Infinity);

/**
 * Onset envelope: half-wave-rectified spectral flux over a 1024-point Hann-windowed DFT at a
 * 480-sample hop, which is exactly 100 Hz and exactly 1/16 of a second at 48 kHz. The DFT is a
 * plain O(n²) Goertzel-free loop over 64 log-spaced bins rather than a real FFT, because 64 bins
 * of a 1024-point window at 100 Hz over four minutes is a few seconds of work and an FFT is a
 * page of code that could be wrong.
 */
const HOP = 480, WIN = 1024, BINS = 40;
const nFrames = Math.max(1, Math.floor((N - WIN) / HOP));
const hann = new Float32Array(WIN);
for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1));
// Log-spaced bins from 40 Hz to 8 kHz.
const ks = [];
for (let b = 0; b < BINS; b++) {
  const f = 40 * Math.pow(8000 / 40, b / (BINS - 1));
  ks.push((f * WIN) / RATE);
}
const flux = new Float32Array(nFrames);
let prev = new Float32Array(BINS);
const cosT = ks.map((k) => { const a = new Float32Array(WIN); for (let i = 0; i < WIN; i++) a[i] = Math.cos((2 * Math.PI * k * i) / WIN) * hann[i]; return a; });
const sinT = ks.map((k) => { const a = new Float32Array(WIN); for (let i = 0; i < WIN; i++) a[i] = Math.sin((2 * Math.PI * k * i) / WIN) * hann[i]; return a; });
for (let t = 0; t < nFrames; t++) {
  const off = t * HOP;
  let f = 0;
  const cur = new Float32Array(BINS);
  for (let b = 0; b < BINS; b++) {
    let re = 0, im = 0;
    const ct = cosT[b], st = sinT[b];
    for (let i = 0; i < WIN; i++) { const s = mono[off + i]; re += s * ct[i]; im -= s * st[i]; }
    const m = Math.log1p(1000 * Math.sqrt(re * re + im * im) / WIN);
    cur[b] = m;
    const d = m - prev[b];
    if (d > 0) f += d;
  }
  prev = cur;
  flux[t] = f;
}
// Normalise the envelope by a 2 s moving mean so a loud section does not out-vote a quiet one.
const env = new Float32Array(nFrames);
{
  const W = 200; let s = 0;
  for (let t = 0; t < nFrames; t++) {
    s += flux[t]; if (t >= W) s -= flux[t - W];
    const m = s / Math.min(t + 1, W);
    env[t] = Math.max(0, flux[t] - m);
  }
}

/** Autocorrelate the envelope over 0.25–1.5 s and pick the strongest period. */
let bestLag = 0, bestScore = -1;
for (let lag = 25; lag <= 150; lag++) {
  let s = 0;
  for (let t = lag; t < nFrames; t++) s += env[t] * env[t - lag];
  s /= nFrames - lag;
  if (s > bestScore) { bestScore = s; bestLag = lag; }
}
/** Refine to 1/100 s by combing the envelope at multiples of the period. */
let bestP = bestLag, bestComb = -1, bestPhase = 0;
for (let p = bestLag - 2; p <= bestLag + 2; p += 0.02) {
  for (let ph = 0; ph < p; ph += 0.25) {
    let s = 0, n = 0;
    for (let t = ph; t < nFrames; t += p) { s += env[Math.round(t)] ?? 0; n++; }
    s /= Math.max(1, n);
    if (s > bestComb) { bestComb = s; bestP = p; bestPhase = ph; }
  }
}
const beat = bestP / 100;                 // seconds per beat
const bpm = 60 / beat;

if (args.has('analyse')) {
  console.log(`\npeak ${peak(pcm).toFixed(4)} (${dbfs(peak(pcm))} dBFS)  `
    + `rms ${rms(pcm).toFixed(4)} (${dbfs(rms(pcm))} dBFS)`);
  console.log(`\nbeat period ${beat.toFixed(4)} s  =  ${bpm.toFixed(2)} BPM  `
    + `(first beat at ${(bestPhase / 100).toFixed(3)} s, comb score ${bestComb.toFixed(3)})`);
  console.log(`bar (4/4) ${(beat * 4).toFixed(4)} s = ${(beat * 4 * FPS).toFixed(2)} frames at ${FPS} fps`);

  const STEP = Number(args.get('step') ?? 1);
  console.log(`\n     t    rms    dBFS  onset  profile`);
  for (let t = 0; t + STEP <= dur; t += STEP) {
    const i0 = Math.floor(t * RATE) * CH, n = Math.floor(STEP * RATE);
    const r = rms(pcm, i0, n * CH);
    const e0 = Math.floor(t * 100), e1 = Math.min(nFrames, Math.floor((t + STEP) * 100));
    let o = 0; for (let k = e0; k < e1; k++) o = Math.max(o, env[k]);
    const bar = '#'.repeat(Math.round(Math.min(1, r / 0.35) * 44));
    console.log(`${t.toFixed(1).padStart(6)} ${r.toFixed(4)} ${String(dbfs(r)).padStart(7)} `
      + `${o.toFixed(2).padStart(6)}  ${bar}`);
  }
}

if (args.has('onsets')) {
  const [a, b] = args.get('onsets').split(':').map(Number);
  const i0 = Math.max(1, Math.floor(a * 100)), i1 = Math.min(nFrames - 1, Math.floor(b * 100));
  const pk = [];
  for (let t = i0; t < i1; t++) {
    if (env[t] > env[t - 1] && env[t] >= env[t + 1]) pk.push({ t: t / 100, v: env[t] });
  }
  pk.sort((x, y) => y.v - x.v);
  const top = pk.slice(0, Number(args.get('n') ?? 40)).sort((x, y) => x.t - y.t);
  console.log(`\nstrongest onsets in ${a}..${b} s (of ${pk.length} peaks):`);
  let last = null;
  for (const p of top) {
    const gap = last === null ? null : p.t - last;
    console.log(`  ${p.t.toFixed(2).padStart(7)}  strength ${p.v.toFixed(2).padStart(6)}`
      + (gap === null ? '' : `   +${gap.toFixed(3)} s = ${(gap / beat).toFixed(2)} beats`));
    last = p.t;
  }
}

if (args.has('grid')) {
  const g0 = Number(args.get('grid'));
  const bars = Number(args.get('bars') ?? 8);
  console.log(`\nbeat grid from ${g0.toFixed(3)} s, ${beat.toFixed(4)} s/beat:`);
  for (let b = 0; b <= bars * 4; b++) {
    const t = g0 + b * beat;
    const mark = b % 4 === 0 ? `bar ${b / 4 + 1}` : '';
    console.log(`  beat ${String(b).padStart(3)}  t ${t.toFixed(4)}  `
      + `+${(b * beat).toFixed(4)} s  ${(b * beat * FPS).toFixed(2)} frames  ${mark}`);
  }
}

// ---------------------------------------------------------------------------------------
// The bed
// ---------------------------------------------------------------------------------------

if (args.has('out')) {
  const FROM = Number(args.get('from') ?? 0);
  const FRAMES = Number(args.get('frames'));
  if (!Number.isFinite(FRAMES) || FRAMES <= 0) { console.error('need --frames=<picture frame count>'); process.exit(2); }
  const total = Math.round((FRAMES / FPS) * RATE);
  const FADEIN = Number(args.get('fadein') ?? 0);
  const FADEOUT = Number(args.get('fadeout') ?? 0);
  const GAIN = Number(args.get('gain') ?? 1);
  /** `--duck=t0:t1:g,…` — seconds into the bed, and the gain to hold across that span. */
  const DUCK = (args.get('duck') ?? '').split(',').filter(Boolean).map((s) => {
    const [a, b, g] = s.split(':').map(Number); return { a, b, g };
  });
  const OUT = args.get('out');

  const from = Math.round(FROM * RATE);
  if (from + total > N) {
    console.error(`the bed runs off the end: need ${((from + total) / RATE).toFixed(2)} s of a `
      + `${dur.toFixed(2)} s track`);
    process.exit(1);
  }
  const mix = new Float32Array(total * CH);
  const fi = Math.round(FADEIN * RATE), fo = Math.round(FADEOUT * RATE);
  for (let i = 0; i < total; i++) {
    let g = GAIN;
    if (fi && i < fi) g *= i / fi;
    if (fo && i > total - fo) g *= (total - i) / fo;
    const t = i / RATE;
    for (const d of DUCK) {
      if (t >= d.a && t < d.b) {
        // 60 ms of ramp either side, so a duck is not a click.
        const r = 0.06;
        const up = Math.min(1, (t - d.a) / r), dn = Math.min(1, (d.b - t) / r);
        g *= 1 + (d.g - 1) * Math.min(up, dn);
      }
    }
    mix[i * CH] = pcm[(from + i) * CH] * g;
    mix[i * CH + 1] = pcm[(from + i) * CH + 1] * g;
  }
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, Buffer.from(mix.buffer));
  const r = rms(mix), p = peak(mix);
  console.log(`\nbed: ${FROM.toFixed(3)} s .. ${(FROM + total / RATE).toFixed(3)} s of the track`);
  console.log(`     ${FRAMES} picture frames = ${(FRAMES / FPS).toFixed(3)} s = ${total} samples/ch`);
  console.log(`     rms ${r.toFixed(4)} (${dbfs(r)} dBFS)  peak ${p.toFixed(4)} (${dbfs(p)} dBFS)`);
  if (p >= 0.999) console.warn('  ! the bed touches full scale');
  if (r === 0) throw new Error('the bed is silent');
  console.log(`-> ${OUT}  ${(mix.byteLength / 1e6).toFixed(1)} MB raw f32 stereo`);
}
