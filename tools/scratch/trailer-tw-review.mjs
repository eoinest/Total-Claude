/**
 * trailer-tw-review.mjs — decode the delivered file back and measure it, at phone size.
 *
 * Everything upstream can be green and the file still be wrong, and on this job two tools
 * already came back green and wrong: a review script that wrote seventeen identically black
 * stills because headless Chromium will not repaint a paused `<video>` and its server had no
 * range support, so every seek silently did nothing; and a crop checker that scored a clean
 * encode at 23 dB because its reference frame was two frames of camera travel away. Both fixes
 * are carried here and are commented where they apply.
 *
 * Five questions, none of which the encoder can answer about itself:
 *
 *   1. Does a `<video>` take the file, and what does it say the duration and frame size are?
 *   2. **What does it look like at 400 px** — a video in a phone feed, which is the whole
 *      point of this cut. The element is styled to 400 px and screenshotted at that size, so
 *      the browser's own downscale is in the picture, exactly as a feed would do it.
 *   3. Does `decodeAudioData` get a real waveform out of the muxed Opus, and does the per-shot
 *      RMS of *that* match what the cut wrote? Decoding the delivered track is the only proof
 *      the sound survived the mux — the mixdown's own numbers prove nothing about the file.
 *   4. Played for real through a MediaElementAudioSource and an analyser, does the meter move?
 *   5. What did 1280x720 VP9 cost? PSNR of the decoded frame against the *same source frame
 *      downscaled the same way the encoder downscaled it*, so the number is compression and
 *      not resampling, aligned first so it is not motion either.
 *
 *   node tools/scratch/trailer-tw-review.mjs --file=/tmp/tc-tw/x.webm
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const WORK = args.get('work') ?? '/tmp/tc-tw';
const FILE = args.get('file') ?? path.join(WORK, 'total-claude-trailer-720p-twitter.webm');
const CUT = args.get('cut') ?? path.join(WORK, 'cut-tw.json');
const META = args.get('meta') ?? path.join(WORK, 'cut-tw.meta.json');
const OUT = args.get('out') ?? path.join(WORK, 'review');
const PORT = Number(args.get('port') ?? 5273);
const PHONE = Number(args.get('phone') ?? 400);
const W = Number(args.get('w') ?? 1280);
const H = Number(args.get('h') ?? 720);
const FPS = 30;

await mkdir(OUT, { recursive: true });
const buf = await readFile(FILE);
const size = (await stat(FILE)).size;
const cut = JSON.parse(await readFile(CUT, 'utf8'));
const meta = JSON.parse(await readFile(META, 'utf8'));
const bounds = meta.shots.map((s) => ({ id: s.id, in: s.in, out: s.out, cutRms: s.cutRms }));
/** One still per shot, plus the frame the leaves give way on and the one after it. */
const SHOTS = (args.get('shots') ?? [
  0.4, 1.6, 3.2, 4.6, 5.8, 7.4, 8.6, 11.0, 13.4, 14.0, 14.6, 15.6, 16.6, 17.9, 19.4, 21.2,
].join(',')).split(',').map(Number);
/** Where an encode fails first: dust and men at distance, the escalade, the gate in shadow. */
const CROPS = (args.get('crops') ?? '3.6,6.4,11.5,15.2,17.5').split(',').map(Number);

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/v.webm') {
    /*
     * Range requests, because without them the element will not seek. Answering with the whole
     * file and `Accept-Ranges: none` makes a media element treat the resource as unseekable no
     * matter how much of it is buffered, and every `currentTime = t` then silently does
     * nothing — which is how a previous pass got seventeen stills of frame 2.
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
  if (u.pathname.startsWith('/f/')) {
    const i = Number(u.pathname.slice(3));
    if (!cut[i]) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(await readFile(cut[i]));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><meta charset=utf-8><body style="margin:0;background:#000">'
    + `<video id=v src="/v.webm" preload=auto style="position:fixed;left:0;top:0;width:${W}px;height:${H}px"></video>`);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/*
 * Seek, play until a frame is presented, then stop *on that frame*.
 *
 * `onseeked` fires when the pipeline has moved, not when a decoded frame is on the compositor,
 * and headless Chromium will not repaint a paused `<video>` at all — a `drawImage` and an
 * element screenshot both give the same early frame every time. `requestVideoFrameCallback` is
 * the event that means "there is a frame"; the element is paused inside it, and the position
 * it actually stopped at is returned, because the frame that was presented is the only frame a
 * measurement may be made against.
 */
const SEEK_HELPER = `window.__playAt = async (t) => {
  const v = document.getElementById('v');
  v.muted = true;
  await new Promise((r) => { v.onseeked = r; v.currentTime = t; });
  await v.play();
  let mt = -1;
  for (let k = 0; k < 2; k++) {
    await new Promise((r) => {
      let done = false;
      const f = (m) => { if (!done) { done = true; if (m !== undefined) mt = m; if (k === 1) v.pause(); r(); } };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback((now, md) => f(md.mediaTime));
      setTimeout(() => f(), 600);
    });
  }
  v.pause();
  await new Promise((r) => setTimeout(r, 60));
  return { mt, ct: v.currentTime };
};
window.__size = (w, h) => {
  const v = document.getElementById('v');
  v.style.width = w + 'px'; v.style.height = h + 'px';
};`;

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=metal'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.addScriptTag({ content: SEEK_HELPER });

// ---- 1. does a player take it? -------------------------------------------
const info = await page.evaluate(async () => {
  const v = document.getElementById('v');
  await new Promise((r, j) => {
    if (v.readyState >= 1) return r();
    v.onloadedmetadata = r;
    v.onerror = () => j(new Error('video error ' + (v.error && v.error.message)));
  });
  return { duration: v.duration, w: v.videoWidth, h: v.videoHeight,
    canVP9: MediaSource.isTypeSupported('video/webm; codecs="vp9,opus"') };
});
console.log(`file      ${FILE}`);
console.log(`bytes     ${size}  (${(size / 1e6).toFixed(3)} MB)   headroom under 5,000,000: ${5e6 - size} B`);
console.log(`player    accepts it: ${info.w}x${info.h}  ${info.duration.toFixed(3)} s  `
  + `(cut says ${meta.seconds} s, ${meta.frames} frames)`);
if (info.w !== W || info.h !== H) console.error(`! frame size is ${info.w}x${info.h}, expected ${W}x${H}`);

// ---- 2. what it looks like in a feed -------------------------------------
/*
 * Screenshot the element, do not `drawImage` it: the compositor has the frame, a 2D context
 * does not. And screenshot it at 400 px rather than downscaling a 1280 px shot afterwards,
 * so the browser's own scaler is the one in the picture, as it would be on a phone.
 */
const PH = Math.round((PHONE * H) / W);
await page.evaluate(([w, h]) => window.__size(w, h), [PHONE, PH]);
const phoneShots = [];
for (const s of SHOTS) {
  const r = await page.evaluate((t) => window.__playAt(t), s);
  await page.locator('#v').screenshot({
    path: path.join(OUT, `phone-${String(s.toFixed(1)).padStart(5, '0')}.png`),
    type: 'png', animations: 'allow',
  });
  phoneShots.push({ asked: s, got: r.mt < 0 ? null : +r.mt.toFixed(3) });
}
console.log(`\nphone stills at ${PHONE}x${PH}: `
  + phoneShots.map((q) => `${q.asked}->${q.got ?? '?'}`).join(' '));

// a single sheet of them, so the whole cut can be judged at feed size in one look
{
  const files = [];
  for (const s of SHOTS) {
    const p = path.join(OUT, `phone-${String(s.toFixed(1)).padStart(5, '0')}.png`);
    files.push({ t: s, b64: (await readFile(p)).toString('base64') });
  }
  const png = await page.evaluate(async ({ files, PHONE, PH }) => {
    const COLS = 4, GAP = 6, LAB = 18;
    const rows = Math.ceil(files.length / COLS);
    const c = new OffscreenCanvas(COLS * (PHONE + GAP) + GAP, rows * (PH + LAB + GAP) + GAP);
    const g = c.getContext('2d');
    g.fillStyle = '#101010'; g.fillRect(0, 0, c.width, c.height);
    for (let k = 0; k < files.length; k++) {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + files[k].b64)).blob());
      const x = GAP + (k % COLS) * (PHONE + GAP), y = GAP + Math.floor(k / COLS) * (PH + LAB + GAP);
      g.drawImage(bmp, x, y); bmp.close();
      g.fillStyle = '#ffd479'; g.font = '12px monospace';
      g.fillText('t=' + files[k].t.toFixed(1) + 's', x + 2, y + PH + 13);
    }
    const blob = await c.convertToBlob({ type: 'image/png' });
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return btoa(s);
  }, { files, PHONE, PH });
  await writeFile(path.join(OUT, 'phone-sheet.png'), Buffer.from(png, 'base64'));
  console.log(`phone sheet -> ${path.join(OUT, 'phone-sheet.png')}`);
}

// ---- 5. what the encode cost ---------------------------------------------
await page.evaluate(([w, h]) => window.__size(w, h), [W, H]);
console.log('\ncompression, against the source downscaled the same way the encoder did it:');
const psnrs = [];
for (const at of CROPS) {
  const r0 = await page.evaluate((t) => window.__playAt(t), at);
  const shot = await page.locator('#v').screenshot({ type: 'png' });
  const idx = Math.round((r0.mt >= 0 ? r0.mt : r0.ct) * FPS);
  const r = await page.evaluate(async ({ shotB64, idx, W, H }) => {
    const dec = async (u) => createImageBitmap(await (await fetch(u)).blob());
    const enc = await dec('data:image/png;base64,' + shotB64);
    const encPx = (() => {
      const c = new OffscreenCanvas(enc.width, enc.height);
      c.getContext('2d').drawImage(enc, 0, 0);
      return c.getContext('2d').getImageData(0, 0, enc.width, enc.height).data;
    })();
    /*
     * The reference is the source frame put through the *same* downscale the encoder used —
     * 1920x1080 into a 2D context at 1280x720 with `imageSmoothingQuality = 'high'` — so the
     * PSNR is compression and not resampling.
     */
    const ref = async (i) => {
      const src = await dec('/f/' + i);
      const c = new OffscreenCanvas(W, H);
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, src.width, src.height, 0, 0, W, H);
      src.close();
      return g.getImageData(0, 0, W, H).data;
    };
    /*
     * Which source frame is this, really? The compositor stops on whatever frame it stops on,
     * and against a camera moving a metre a second two frames of travel swamp every
     * compression artefact there is — that is how a good encode got scored at 23 dB once. So
     * the reference is chosen by search over a nine-frame window and the offset is printed.
     */
    let best = { i: idx, mse: Infinity, px: null };
    for (let d = -4; d <= 4; d++) {
      if (idx + d < 0) continue;
      let px;
      try { px = await ref(idx + d); } catch { continue; }
      let m = 0, n = 0;
      for (let i = 0; i < px.length; i += 4 * 31) {
        for (let k = 0; k < 3; k++) { m += (px[i + k] - encPx[i + k]) ** 2; n++; }
      }
      m /= n;
      if (m < best.mse) best = { i: idx + d, mse: m, px };
    }
    const rp = best.px;
    // Whole-frame PSNR, and the worst 64x64 tile, which is where blocking would show.
    let mse = 0;
    for (let i = 0; i < rp.length; i += 4) for (let k = 0; k < 3; k++) mse += (rp[i + k] - encPx[i + k]) ** 2;
    mse /= (rp.length / 4) * 3;
    let worst = { x: 0, y: 0, mse: 0 };
    for (let y = 0; y + 64 <= H; y += 64) {
      for (let x = 0; x + 64 <= W; x += 64) {
        let m = 0, n = 0;
        for (let j = y; j < y + 64; j += 2) {
          for (let i = x; i < x + 64; i += 2) {
            const o = (j * W + i) * 4;
            for (let k = 0; k < 3; k++) { m += (rp[o + k] - encPx[o + k]) ** 2; n++; }
          }
        }
        m /= n;
        if (m > worst.mse) worst = { x, y, mse: m };
      }
    }
    // A 1:1 side-by-side of the worst tile's neighbourhood, to look at rather than assert about.
    const CW = 480, CHh = 270;
    const cx = Math.max(0, Math.min(W - CW, worst.x - CW / 2 + 32));
    const cy = Math.max(0, Math.min(H - CHh, worst.y - CHh / 2 + 32));
    const out = new OffscreenCanvas(CW, CHh * 2 + 34);
    const og = out.getContext('2d');
    og.fillStyle = '#000'; og.fillRect(0, 0, out.width, out.height);
    const put = (px, dy) => {
      const im = new ImageData(CW, CHh);
      for (let j = 0; j < CHh; j++) {
        for (let i = 0; i < CW; i++) {
          const o1 = ((cy + j) * W + (cx + i)) * 4, o2 = (j * CW + i) * 4;
          im.data[o2] = px[o1]; im.data[o2 + 1] = px[o1 + 1]; im.data[o2 + 2] = px[o1 + 2]; im.data[o2 + 3] = 255;
        }
      }
      og.putImageData(im, 0, dy);
    };
    put(rp, 0); put(encPx, CHh + 34);
    og.fillStyle = '#ff0'; og.font = 'bold 16px monospace';
    og.fillText('SOURCE frame ' + best.i + ' downscaled 1920->1280 @' + cx + ',' + cy, 8, 18);
    og.fillText('ENCODED VP9 720p  frame PSNR ' + (10 * Math.log10(65025 / mse)).toFixed(2)
      + ' dB  worst tile ' + (10 * Math.log10(65025 / worst.mse)).toFixed(2), 8, CHh + 52);
    const blob = await out.convertToBlob({ type: 'image/png' });
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    enc.close();
    return { png: btoa(s), psnr: 10 * Math.log10(65025 / mse),
      worstPsnr: 10 * Math.log10(65025 / worst.mse), frame: best.i, offset: best.i - idx,
      at: [cx, cy] };
  }, { shotB64: shot.toString('base64'), idx, W, H });
  await writeFile(path.join(OUT, `crop-${at}.png`), Buffer.from(r.png, 'base64'));
  psnrs.push({ at, ...r, png: undefined });
  console.log(`  t=${String(at).padStart(5)}s  frame ${String(r.frame).padStart(3)}`
    + ` (${r.offset >= 0 ? '+' : ''}${r.offset})  PSNR ${r.psnr.toFixed(2)} dB`
    + `  worst 64px tile ${r.worstPsnr.toFixed(2)} dB`);
}

// ---- 3/4. the sound, decoded out of the delivered file --------------------
const audio = await page.evaluate(async ({ bounds }) => {
  const ab = await (await fetch('/v.webm')).arrayBuffer();
  const ctx = new AudioContext();
  let b;
  try { b = await ctx.decodeAudioData(ab.slice(0)); }
  catch (e) { return { err: 'decodeAudioData refused the file: ' + e }; }
  const L = b.getChannelData(0), R = b.numberOfChannels > 1 ? b.getChannelData(1) : L;
  const rate = b.sampleRate;
  const rms = (a, z) => {
    let s = 0, n = 0;
    for (let i = a; i < z && i < L.length; i++) { s += L[i] * L[i] + R[i] * R[i]; n += 2; }
    return Math.sqrt(s / (n || 1));
  };
  const peak = (a, z) => {
    let m = 0;
    for (let i = a; i < z && i < L.length; i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
    return m;
  };
  const perShot = bounds.map((q) => ({ id: q.id,
    rms: +rms(Math.round(q.in * rate), Math.round(q.out * rate)).toFixed(6),
    peak: +peak(Math.round(q.in * rate), Math.round(q.out * rate)).toFixed(4) }));
  // Is the last half-second actually going down with the picture?
  const tailA = rms(Math.round((b.duration - 0.8) * rate), Math.round((b.duration - 0.6) * rate));
  const tailB = rms(Math.round((b.duration - 0.15) * rate), Math.round(b.duration * rate));

  // ---- played for real, meter on -----------------------------------------
  const v = document.getElementById('v');
  v.muted = false;
  const pctx = new AudioContext();
  const src = pctx.createMediaElementSource(v);
  const an = pctx.createAnalyser(); an.fftSize = 2048;
  src.connect(an); an.connect(pctx.destination);
  const probe = [];
  const data = new Float32Array(an.fftSize);
  for (const at of [1, 6, 13.6, 17]) {
    await new Promise((r) => { v.onseeked = r; v.currentTime = at; });
    await v.play();
    await new Promise((r) => setTimeout(r, 600));
    let bestv = 0;
    for (let k = 0; k < 12; k++) {
      an.getFloatTimeDomainData(data);
      let s = 0; for (let i = 0; i < data.length; i++) s += data[i] * data[i];
      bestv = Math.max(bestv, Math.sqrt(s / data.length));
      await new Promise((r) => setTimeout(r, 40));
    }
    v.pause();
    probe.push({ at, playedRms: +bestv.toFixed(5) });
  }
  return { rate, seconds: b.duration, channels: b.numberOfChannels, perShot, probe,
    whole: +rms(0, L.length).toFixed(6), wholePeak: +peak(0, L.length).toFixed(4),
    tailA: +tailA.toFixed(5), tailB: +tailB.toFixed(5), ctxState: pctx.state };
}, { bounds });

if (audio.err) { console.error(audio.err); await browser.close(); server.close(); process.exit(1); }
console.log(`\naudio     ${audio.channels} ch  ${audio.rate} Hz  ${audio.seconds.toFixed(3)} s decoded`);
console.log('\nshot              in     out   decoded RMS    dBFS   cut RMS   delta   peak');
let worstDelta = 0;
for (let i = 0; i < audio.perShot.length; i++) {
  const p = audio.perShot[i], q = bounds[i];
  const d = ((p.rms - q.cutRms) / (q.cutRms || 1)) * 100;
  worstDelta = Math.max(worstDelta, Math.abs(d));
  console.log(`${p.id.padEnd(15)} ${q.in.toFixed(1).padStart(5)} ${q.out.toFixed(1).padStart(7)}   `
    + `${p.rms.toFixed(5)}   ${(20 * Math.log10(p.rms || 1e-9)).toFixed(1).padStart(6)}   `
    + `${q.cutRms.toFixed(5)}  ${(d >= 0 ? '+' : '') + d.toFixed(2)} %  ${p.peak.toFixed(3)}`);
}
console.log(`\nwhole track  decoded RMS ${audio.whole} (${(20 * Math.log10(audio.whole)).toFixed(1)} dBFS)  `
  + `peak ${audio.wholePeak}  |  cut wrote ${meta.rms} / ${meta.peak}`);
console.log(`worst per-shot disagreement with the mixdown: ${worstDelta.toFixed(2)} %`);
console.log(`tail: RMS ${audio.tailA} at -0.8..-0.6 s -> ${audio.tailB} over the last 0.15 s `
  + `(the sound goes down with the picture)`);
console.log('\nplayed through a <video> element and an analyser:');
for (const p of audio.probe) console.log(`  t=${p.at}s  peak block RMS ${p.playedRms}`);
if (audio.probe.every((p) => p.playedRms < 1e-4)) console.error('! nothing came out of the element');

await writeFile(path.join(OUT, 'review.json'), JSON.stringify({ file: FILE, bytes: size, info,
  perShot: audio.perShot, probe: audio.probe, psnrs, seconds: audio.seconds,
  whole: audio.whole, wholePeak: audio.wholePeak }, null, 1));
console.log(`\n-> ${path.join(OUT, 'review.json')}`);
await browser.close();
server.close();
