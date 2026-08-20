/**
 * trailer-review.mjs — watch and listen to the finished file, rather than trusting the pipeline.
 *
 * Everything upstream of here can be green and the file still be wrong: a track that muxes
 * cleanly and decodes to silence, a video track a player refuses, an audio track a second out
 * of step with the picture. So this opens the *delivered file* in Chromium and asks it five
 * questions, none of which the encoder can answer on its own:
 *
 *   1. Does a `<video>` element accept it, and what does it say the duration and size are?
 *   2. Do stills pulled out of it by seeking look like the trailer?
 *   3. Does `decodeAudioData` get a real waveform out of the muxed Opus, and does the
 *      per-beat RMS of *that* match what the mixdown wrote? (Decoding the delivered file is
 *      the only proof that the sound survived muxing.)
 *   4. Played back for real — element -> MediaElementAudioSource -> Analyser — does the meter
 *      move? A file can decode and still be routed to nothing.
 *   5. What does it look like: a waveform and a spectrogram, so the mix can be judged beat by
 *      beat instead of asserted about.
 *
 *   node tools/scratch/trailer-review.mjs --file=/tmp/tc-sound/xxx.webm
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BEATS, FPS } from './trailer-shot.mjs';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const FILE = args.get('file') ?? '/tmp/tc-sound/total-claude-trailer-sound.webm';
const OUT = args.get('out') ?? '/tmp/tc-sound/review';
const PORT = Number(args.get('port') ?? 5239);
const SHOTS = (args.get('shots') ?? '2,10,20,30,39.8,43,50,57.2,62,70,76,80,85.5')
  .split(',').map(Number);

await mkdir(OUT, { recursive: true });
const buf = await readFile(FILE);
const size = (await stat(FILE)).size;
const bounds = [];
let t = 0;
for (const b of BEATS) { const d = (b.at[1] - b.at[0]); bounds.push({ id: b.id, in: t, out: t + d }); t += d; }

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/v.webm') {
    /*
     * Range requests, because without them the element will not seek.
     *
     * The first version answered with the whole file and `Accept-Ranges: none`, and every
     * `currentTime = t` silently did nothing: seventeen stills all reported `mediaTime`
     * 0.066 s. A media element treats a resource it cannot range-request as unseekable no
     * matter how much of it is already in the buffer.
     */
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const a = range[1] ? Number(range[1]) : 0;
      const b = range[2] ? Number(range[2]) : buf.length - 1;
      res.writeHead(206, { 'content-type': 'video/webm', 'accept-ranges': 'bytes',
        'content-range': `bytes ${a}-${b}/${buf.length}`, 'content-length': b - a + 1 });
      return res.end(buf.subarray(a, b + 1));
    }
    res.writeHead(200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes',
      'content-length': buf.length });
    return res.end(buf);
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><meta charset=utf-8><body style="margin:0;background:#000">'
    + '<video id=v src="/v.webm" preload=auto '
    + 'style="position:fixed;left:0;top:0;width:1920px;height:1080px"></video>');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));


/*
 * Seek and wait for the frame to actually be *presented*.
 *
 * `onseeked` fires when the media pipeline has moved, not when a decoded frame is on the
 * compositor, and `drawImage` on a paused `<video>` before that point paints nothing — the
 * first pass of this file wrote seventeen identically black JPEGs and reported success.
 * `requestVideoFrameCallback` is the event that means "there is a frame", and a short play
 * is the fallback for the case where a paused seek does not present one.
 */
const SEEK_HELPER = `window.__playAt = async (t) => {
  const v = document.getElementById('v');
  v.muted = true;
  await new Promise((r) => { v.onseeked = r; v.currentTime = t; });
  await v.play();
  // Two presented frames, so the compositor is showing this seek and not the one before it.
  const got = [];
  for (let k = 0; k < 2; k++) {
    got.push(await new Promise((r) => {
      let done = false;
      const f = (x) => { if (!done) { done = true; r(x); } };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback((now, md) => f(md.mediaTime));
      setTimeout(() => f(-1), 600);
    }));
  }
  return got[got.length - 1];
};
window.__pause = () => { const v = document.getElementById('v'); v.pause(); v.muted = false; };`;

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=metal'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.addScriptTag({ content: SEEK_HELPER });

// ---- 1. does a player take it? -------------------------------------------
const meta = await page.evaluate(async () => {
  const v = document.getElementById('v');
  await new Promise((r, j) => {
    if (v.readyState >= 1) return r();
    v.onloadedmetadata = r; v.onerror = () => j(new Error('video error ' + (v.error && v.error.message)));
  });
  return { duration: v.duration, w: v.videoWidth, h: v.videoHeight,
    canVP9: MediaSource.isTypeSupported('video/webm; codecs="vp9,opus"'),
    audioTracks: v.audioTracks ? v.audioTracks.length : null };
});
console.log(`file   ${FILE}  ${(size / 1e6).toFixed(1)} MB`);
console.log(`player accepts it: ${meta.w}x${meta.h}  ${meta.duration.toFixed(3)} s`);

// ---- 2. stills, by seeking ------------------------------------------------
/*
 * Screenshot the element, do not `drawImage` it.
 *
 * Painting a paused `<video>` into a canvas gave seventeen identical frames here — the
 * compositor has the frame, the 2D context does not. A Playwright screenshot of the element
 * is the compositor's own output, which is the thing a viewer would be looking at.
 */
const shotAt = [];
for (const s of SHOTS) {
  /*
   * Screenshot while it is *playing*.
   *
   * Headless Chromium does not repaint a paused `<video>` after a seek: both a canvas
   * `drawImage` and an element screenshot came back as seventeen copies of the same early
   * frame, twice, while the audio decoded perfectly. Playing forces the compositor to
   * present, and `requestVideoFrameCallback` reports which frame it presented, so the shot
   * is labelled with the time it actually caught rather than the time it asked for.
   */
  const mt = await page.evaluate((tt) => window.__playAt(tt), s);
  await page.locator('#v').screenshot({
    path: path.join(OUT, `t${String(s).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92,
    animations: 'allow',
  });
  await page.evaluate(() => window.__pause());
  shotAt.push({ asked: s, got: mt < 0 ? null : +mt.toFixed(3) });
}
console.log('stills at: ' + shotAt.map((q) => `${q.asked}->${q.got}`).join(' '));
console.log(`stills → ${OUT}  (${SHOTS.length})`);

// ---- 3/4/5. the sound, decoded out of the delivered file ------------------
const audio = await page.evaluate(async ({ bounds }) => {
  const ab = await (await fetch('/v.webm')).arrayBuffer();
  const ctx = new AudioContext();
  let buf;
  try { buf = await ctx.decodeAudioData(ab.slice(0)); }
  catch (e) { return { err: 'decodeAudioData refused the file: ' + e }; }
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const rate = buf.sampleRate;
  const rms = (a, b) => {
    let s = 0, n = 0;
    for (let i = a; i < b && i < L.length; i++) { s += L[i] * L[i] + R[i] * R[i]; n += 2; }
    return Math.sqrt(s / (n || 1));
  };
  const perBeat = bounds.map((q) => ({ id: q.id,
    rms: +rms(Math.round(q.in * rate), Math.round(q.out * rate)).toFixed(6) }));
  // Per-tenth-second envelope, for the picture below.
  const step = Math.round(rate / 10);
  const env = [];
  for (let i = 0; i < L.length; i += step) env.push(+rms(i, i + step).toFixed(5));

  // A coarse spectrogram: 1024-point FFT every 0.1 s, 40 log-spaced bands.
  const fft = (re, im) => {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
          const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        }
      }
    }
  };
  const NB = 44, NF = 1024;
  const edges = [];
  for (let b = 0; b <= NB; b++) edges.push(30 * Math.pow(16000 / 30, b / NB));
  const spec = [];
  for (let i = 0; i + NF < L.length; i += step) {
    const re = new Float64Array(NF), im = new Float64Array(NF);
    for (let k = 0; k < NF; k++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (NF - 1));
      re[k] = ((L[i + k] + R[i + k]) / 2) * w;
    }
    fft(re, im);
    const col = new Array(NB).fill(0);
    for (let k = 1; k < NF / 2; k++) {
      const f = (k * rate) / NF;
      let b = Math.floor((Math.log(f / 30) / Math.log(16000 / 30)) * NB);
      if (b < 0 || b >= NB) continue;
      col[b] += re[k] * re[k] + im[k] * im[k];
    }
    spec.push(col.map((v) => +(10 * Math.log10(v / NF + 1e-12)).toFixed(1)));
  }

  // ---- 4. real playback through the element, meter on -----------------------
  const v = document.getElementById('v');
  v.muted = false;                       // the seek helper mutes to force a frame out
  const pctx = new AudioContext();
  const src = pctx.createMediaElementSource(v);
  const an = pctx.createAnalyser();
  an.fftSize = 2048;
  src.connect(an); an.connect(pctx.destination);
  const probe = [];
  const data = new Float32Array(an.fftSize);
  for (const at of [3, 25, 60, 82]) {
    await new Promise((r) => { v.onseeked = r; v.currentTime = at; });
    await v.play();
    await new Promise((r) => setTimeout(r, 700));
    let best = 0;
    for (let k = 0; k < 12; k++) {
      an.getFloatTimeDomainData(data);
      let s = 0; for (let i = 0; i < data.length; i++) s += data[i] * data[i];
      best = Math.max(best, Math.sqrt(s / data.length));
      await new Promise((r) => setTimeout(r, 40));
    }
    v.pause();
    probe.push({ at, playedRms: +best.toFixed(5) });
  }
  return { rate, seconds: buf.duration, channels: buf.numberOfChannels,
    perBeat, env, spec, probe, ctxState: pctx.state };
}, { bounds });

if (audio.err) { console.error(audio.err); await browser.close(); server.close(); process.exit(1); }
console.log(`\naudio  ${audio.channels} ch  ${audio.rate} Hz  ${audio.seconds.toFixed(3)} s decoded`);
const mixdown = existsSync('/tmp/tc-sound/mixdown.json')
  ? JSON.parse(await readFile('/tmp/tc-sound/mixdown.json', 'utf8')) : null;
const byId = new Map((mixdown?.beats ?? []).map((b) => [b.id, b]));
console.log('\nbeat              in     out    decoded RMS   dBFS   mixdown RMS   delta');
for (let i = 0; i < audio.perBeat.length; i++) {
  const p = audio.perBeat[i], b = bounds[i], m = byId.get(p.id);
  const d = m ? ((p.rms - m.cutRms) / (m.cutRms || 1)) * 100 : null;
  console.log(`${p.id.padEnd(16)} ${b.in.toFixed(1).padStart(6)} ${b.out.toFixed(1).padStart(6)}  `
    + `${p.rms.toFixed(5)}      ${(20 * Math.log10(p.rms || 1e-9)).toFixed(1).padStart(6)}  `
    + `${m ? m.cutRms.toFixed(5) : '   n/a '}      ${d === null ? '' : d.toFixed(1) + ' %'}`);
}
console.log('\nplayback through a <video> element and an analyser:');
for (const p of audio.probe) console.log(`  t=${p.at}s  peak block RMS ${p.playedRms}`);

// ---- the picture of the sound ---------------------------------------------
const png = await page.evaluate(({ env, spec, bounds, seconds }) => {
  const W = 1720, HW = 220, HS = 300, PAD = 60;
  const c = document.createElement('canvas');
  c.width = W + PAD * 2; c.height = HW + HS + 90;
  const g = c.getContext('2d');
  g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
  const x = (t) => PAD + (t / seconds) * W;
  // waveform envelope
  g.fillStyle = '#7fd1ff';
  for (let i = 0; i < env.length; i++) {
    const h = Math.min(1, env[i] / 0.35) * (HW / 2);
    g.fillRect(PAD + (i / env.length) * W, 20 + HW / 2 - h, Math.max(1, W / env.length), h * 2);
  }
  // spectrogram
  const NB = spec[0] ? spec[0].length : 0;
  for (let i = 0; i < spec.length; i++) {
    for (let b = 0; b < NB; b++) {
      const v = Math.max(0, Math.min(1, (spec[i][b] + 90) / 80));
      const r = Math.round(255 * Math.min(1, v * 1.6));
      const gr = Math.round(255 * Math.max(0, Math.min(1, v * 1.6 - 0.4)));
      const bl = Math.round(255 * Math.max(0, Math.min(1, v * 1.6 - 0.8)));
      g.fillStyle = `rgb(${r},${gr},${bl})`;
      g.fillRect(PAD + (i / spec.length) * W, 40 + HW + HS - ((b + 1) / NB) * HS,
        Math.max(1, W / spec.length) + 1, HS / NB + 1);
    }
  }
  g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.font = '12px monospace';
  for (const b of bounds) {
    g.globalAlpha = 0.55;
    g.beginPath(); g.moveTo(x(b.in), 16); g.lineTo(x(b.in), 40 + HW + HS); g.stroke();
    g.globalAlpha = 1;
    g.save(); g.translate(x(b.in) + 4, 40 + HW + HS + 12); g.rotate(0.5);
    g.fillText(b.id, 0, 0); g.restore();
  }
  g.fillStyle = '#aaa'; g.font = '13px monospace';
  g.fillText('RMS envelope (0.1 s)  full scale = 0.35', PAD, 14);
  g.fillText('spectrogram  30 Hz .. 16 kHz, log', PAD, 36 + HW);
  return c.toDataURL('image/png').split(',')[1];
}, { env: audio.env, spec: audio.spec, bounds, seconds: audio.seconds });
await writeFile(path.join(OUT, 'sound.png'), Buffer.from(png, 'base64'));
console.log(`\nsound picture → ${path.join(OUT, 'sound.png')}`);
await writeFile(path.join(OUT, 'review.json'), JSON.stringify({ file: FILE, size, meta,
  perBeat: audio.perBeat, probe: audio.probe, rate: audio.rate, seconds: audio.seconds }, null, 1));
await browser.close();
server.close();
