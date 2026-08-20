/**
 * trailer-mp4-review.mjs — decode the delivered MP4 back and measure it, at phone size, and
 * put it beside the WebM it is the counterpart to.
 *
 * This is `trailer-tw-review.mjs` with the container changed and three questions added. Both
 * of the ways that file's ancestors came back green and wrong are carried over unchanged and
 * still commented where they apply: the server answers range requests, because a media element
 * treats a resource served without them as unseekable and every `currentTime = t` then
 * silently does nothing — which is how one pass produced seventeen stills of frame 2; and
 * stills are element screenshots taken while playing and paused inside
 * `requestVideoFrameCallback`, because headless Chromium will not repaint a paused `<video>`.
 * PSNR is still measured against the presented frame, found by search over a nine-frame
 * window, because a reference two frames of camera travel away scores a clean encode at 23 dB.
 *
 * What is new, and new because the container changed:
 *
 *   0. **The file is parsed as bytes before anything plays it.** `ftyp`, the position of
 *      `moov` relative to `mdat` (an MP4 with its index at the end is one an uploader must
 *      buffer whole), the sample entry four-CCs, `avcC`'s profile and level, and the
 *      `AudioSpecificConfig` in `esds`. A player accepting a file says nothing about whether
 *      the file is the file that was asked for.
 *   6. **The audio lag is measured, not assumed.** AAC-LC has an encoder priming delay: the
 *      decoder must be fed and discard roughly the first frame before its output lines up with
 *      what went in, and unlike Opus — which carries its pre-skip in the container and gets it
 *      taken off — a plain MP4 written from raw AAC frames has no edit list to correct it. So
 *      the decoded track is cross-correlated against the mixdown the cut wrote and the best
 *      lag is reported in samples and milliseconds, and the per-shot RMS is then taken both
 *      raw and shifted by it. A lossy codec's RMS will not agree exactly; a *misaligned* one
 *      disagrees at the cuts specifically, and these two columns tell those apart.
 *   7. **`--vs` puts a second file through the identical path**, so the MP4 and the WebM are
 *      measured by one instrument against one reference and looked at side by side at 400 px,
 *      which is the only viewing condition either of them will face.
 *
 *   node tools/scratch/trailer-mp4-review.mjs --file=/tmp/tc-mp4/x.mp4
 *   node tools/scratch/trailer-mp4-review.mjs --file=... --vs=/tmp/tc-tw/....webm
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const WORK = args.get('work') ?? '/tmp/tc-mp4';
const FILE = args.get('file') ?? path.join(WORK, 'total-claude-trailer-720p-twitter.mp4');
const VS = args.get('vs') ?? null;
const CUT = args.get('cut') ?? path.join(WORK, 'cut-tw.json');
const PCM = args.get('pcm') ?? path.join(WORK, 'mix-tw.f32');
const META = args.get('meta') ?? path.join(WORK, 'cut-tw.meta.json');
const OUT = args.get('out') ?? path.join(WORK, 'review');
const PORT = Number(args.get('port') ?? 5283);
const PHONE = Number(args.get('phone') ?? 400);
const W = Number(args.get('w') ?? 1280);
const H = Number(args.get('h') ?? 720);
const FPS = 30;

await mkdir(OUT, { recursive: true });
const files = { a: await readFile(FILE), b: VS ? await readFile(VS) : null };
const mime = (p) => (p.endsWith('.webm') ? 'video/webm' : 'video/mp4');
const size = (await stat(FILE)).size;
const cut = JSON.parse(await readFile(CUT, 'utf8'));
const meta = JSON.parse(await readFile(META, 'utf8'));
const pcm = await readFile(PCM);
const bounds = meta.shots.map((s) => ({ id: s.id, in: s.in, out: s.out, cutRms: s.cutRms }));
const SHOTS = (args.get('shots') ?? [
  0.4, 1.6, 3.2, 4.6, 5.8, 7.4, 8.6, 11.0, 13.4, 14.0, 14.6, 15.6, 16.6, 17.9, 19.4, 21.2,
].join(',')).split(',').map(Number);
/** Where an encode fails first: dust and men at distance, the escalade, the gate in shadow. */
const CROPS = (args.get('crops') ?? '3.6,6.4,11.5,15.2,17.5').split(',').map(Number);

// ---- 0. the container, as bytes -------------------------------------------
/**
 * A small MP4 walker. Not a parser for general use — it knows the handful of boxes this file
 * is supposed to contain and reports what it finds, which is the point: the check has to be
 * able to fail.
 */
function boxes(buf, start = 0, end = buf.length, depth = 0) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let sz = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    let hdr = 8;
    if (sz === 1) { sz = Number(buf.readBigUInt64BE(o + 8)); hdr = 16; }
    if (sz === 0) sz = end - o;
    if (sz < hdr || o + sz > end) break;
    out.push({ type, off: o, size: sz, hdr });
    o += sz;
  }
  return out;
}
function find(buf, pathStr) {
  let range = [0, buf.length];
  let hit = null;
  for (const want of pathStr.split('/')) {
    hit = boxes(buf, range[0], range[1]).find((b) => b.type === want);
    if (!hit) return null;
    // Containers whose payload starts after extra fixed fields.
    const skip = { stsd: 8, meta: 4 }[want] ?? 0;
    range = [hit.off + hit.hdr + skip, hit.off + hit.size];
  }
  return { ...hit, inner: range };
}
const PROFILES = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10' };
const IS_MP4 = !FILE.endsWith('.webm');
const container = !IS_MP4 ? null : (() => {
  const b = files.a;
  const top = boxes(b);
  const ftyp = top.find((x) => x.type === 'ftyp');
  const moov = top.find((x) => x.type === 'moov');
  const mdat = top.find((x) => x.type === 'mdat');
  const brands = ftyp
    ? { major: b.toString('latin1', ftyp.off + 8, ftyp.off + 12),
      compat: [...Array(Math.max(0, (ftyp.size - 16) / 4))]
        .map((_, i) => b.toString('latin1', ftyp.off + 16 + i * 4, ftyp.off + 20 + i * 4)) }
    : null;
  // Sample entries: walk every trak's stsd.
  const traks = [];
  if (moov) {
    for (const t of boxes(b, moov.off + moov.hdr, moov.off + moov.size).filter((x) => x.type === 'trak')) {
      // The subarray starts at the `trak` header, so every path has to descend through it.
      const sub = (p) => find(b.subarray(t.off, t.off + t.size), 'trak/' + p);
      const stsd = sub('mdia/minf/stbl/stsd');
      const hdlr = sub('mdia/hdlr');
      const stsz = sub('mdia/minf/stbl/stsz');
      const mdhd = sub('mdia/mdhd');
      const tb = b.subarray(t.off, t.off + t.size);
      const entry = stsd ? boxes(tb, stsd.inner[0], stsd.inner[1])[0] : null;
      const rec = {
        handler: hdlr ? tb.toString('latin1', hdlr.off + hdlr.hdr + 8, hdlr.off + hdlr.hdr + 12) : '?',
        sampleEntry: entry ? entry.type : '?',
        samples: stsz ? tb.readUInt32BE(stsz.off + stsz.hdr + 8) : null,
        timescale: mdhd ? tb.readUInt32BE(mdhd.off + mdhd.hdr + 12) : null,
        durTicks: mdhd ? tb.readUInt32BE(mdhd.off + mdhd.hdr + 16) : null,
        elst: !!sub('edts/elst'),
      };
      if (entry) {
        const kids = boxes(tb, entry.off + entry.hdr + (rec.handler === 'vide' ? 78 : 28),
          entry.off + entry.size);
        const avcC = kids.find((k) => k.type === 'avcC');
        const esds = kids.find((k) => k.type === 'esds');
        if (avcC) {
          const p = tb[avcC.off + avcC.hdr + 1], c = tb[avcC.off + avcC.hdr + 2],
            l = tb[avcC.off + avcC.hdr + 3];
          rec.avcC = { profile: p, name: PROFILES[p] ?? String(p), constraints: c, level: l / 10,
            codecString: `avc1.${p.toString(16).padStart(2, '0')}${c.toString(16).padStart(2, '0')}${l.toString(16).padStart(2, '0')}` };
        }
        if (esds) {
          /*
           * Walk the ES descriptor tree properly rather than searching for a 0x05 byte. The
           * first version of this did search, found a 0x05 inside `avgBitrate`, and reported
           * an 88.2 kHz zero-channel HE-AAC track for a file that is 48 kHz stereo AAC-LC —
           * a check that cannot fail is not a check.
           */
          const seg = tb.subarray(esds.off + esds.hdr + 4, esds.off + esds.size);
          const desc = (o) => {                 // tag, length (7 bits per byte), payload start
            const tag = seg[o];
            let len = 0, k = o + 1;
            for (let i = 0; i < 4; i++) { len = (len << 7) | (seg[k] & 0x7f); if (!(seg[k++] & 0x80)) break; }
            return { tag, len, body: k, end: k + len };
          };
          const es = desc(0);
          let asc = null;
          if (es.tag === 0x03) {
            let o = es.body + 2;
            const flags = seg[o++];
            if (flags & 0x80) o += 2;            // streamDependenceFlag
            if (flags & 0x40) o += 1 + seg[o];   // URL_Flag
            if (flags & 0x20) o += 2;            // OCRstreamFlag
            const dcd = desc(o);
            if (dcd.tag === 0x04) {
              const dsi = desc(dcd.body + 13);
              if (dsi.tag === 0x05 && dsi.len >= 2) asc = seg.subarray(dsi.body, dsi.end);
            }
          }
          if (asc) {
            const v = (asc[0] << 8) | asc[1];
            rec.asc = { bytes: [...asc].map((x) => x.toString(16).padStart(2, '0')).join(' '),
              objectType: v >> 11, freqIndex: (v >> 7) & 0xf, channels: (v >> 3) & 0xf };
          }
        }
        if (rec.handler === 'vide') {
          rec.width = tb.readUInt16BE(entry.off + entry.hdr + 24);
          rec.height = tb.readUInt16BE(entry.off + entry.hdr + 26);
        }
      }
      traks.push(rec);
    }
  }
  return { top: top.map((x) => `${x.type}(${x.size})`), brands, traks,
    fastStart: !!(moov && mdat && moov.off < mdat.off) };
})();

console.log(`file      ${FILE}`);
console.log(`bytes     ${size}  (${(size / 1e6).toFixed(3)} MB)   headroom under 5,000,000: ${5e6 - size} B`);
if (container) console.log(`boxes     ${container.top.join(' ')}`);
if (container) console.log(`brand     ${container.brands.major}  compatible: ${container.brands.compat.join(' ')}`);
if (container) console.log(`faststart ${container.fastStart ? 'yes — moov before mdat' : 'NO — index is at the end of the file'}`);
for (const t of (container ? container.traks : [])) {
  const dur = t.durTicks / t.timescale;
  let line = `track     ${t.handler}  ${t.sampleEntry}  ${t.samples} samples  `
    + `${t.timescale} Hz  ${dur.toFixed(3)} s  edit list: ${t.elst ? 'yes' : 'no'}`;
  if (t.avcC) line += `\n          ${t.width}x${t.height}  ${t.avcC.name} profile, level `
    + `${t.avcC.level.toFixed(1)}, constraints 0x${t.avcC.constraints.toString(16).padStart(2, '0')}`
    + `  -> ${t.avcC.codecString}`;
  if (t.asc) {
    const FREQ = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    line += `\n          AudioSpecificConfig ${t.asc.bytes}  object type ${t.asc.objectType}`
      + `${t.asc.objectType === 2 ? ' (AAC-LC)' : ''}  ${FREQ[t.asc.freqIndex]} Hz  ${t.asc.channels} ch`;
  }
  console.log(line);
}
if (container && !container.fastStart) console.error('! moov is after mdat');

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const which = u.pathname === '/b' ? 'b' : u.pathname === '/a' ? 'a' : null;
  if (which) {
    const buf = files[which];
    const ct = mime(which === 'a' ? FILE : VS);
    /*
     * Range requests, because without them the element will not seek. Answering with the whole
     * file and no `Accept-Ranges` makes a media element treat the resource as unseekable no
     * matter how much of it is buffered, and every `currentTime = t` then silently does
     * nothing — which is how a previous pass got seventeen stills of frame 2.
     */
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const a = range[1] ? Number(range[1]) : 0;
      const b = range[2] ? Number(range[2]) : buf.length - 1;
      res.writeHead(206, { 'content-type': ct, 'accept-ranges': 'bytes',
        'content-range': `bytes ${a}-${b}/${buf.length}`, 'content-length': b - a + 1 });
      return res.end(buf.subarray(a, b + 1));
    }
    res.writeHead(200, { 'content-type': ct, 'accept-ranges': 'bytes', 'content-length': buf.length });
    return res.end(buf);
  }
  if (u.pathname === '/pcm') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(pcm);
  }
  if (u.pathname.startsWith('/f/')) {
    const i = Number(u.pathname.slice(3));
    if (!cut[i]) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(await readFile(cut[i]));
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><meta charset=utf-8><body style="margin:0;background:#000">'
    + `<video id=a src="/a" preload=auto style="position:fixed;left:0;top:0;width:${W}px;height:${H}px"></video>`
    + (VS ? `<video id=b src="/b" preload=auto style="position:fixed;left:0;top:${H}px;width:${W}px;height:${H}px"></video>` : ''));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/*
 * Seek, play until a frame is presented, then stop *on that frame*.
 *
 * `onseeked` fires when the pipeline has moved, not when a decoded frame is on the compositor,
 * and headless Chromium will not repaint a paused `<video>` at all. `requestVideoFrameCallback`
 * is the event that means "there is a frame"; the element is paused inside it, and the position
 * it actually stopped at is returned, because the frame that was presented is the only frame a
 * measurement may be made against.
 */
const SEEK_HELPER = `window.__playAt = async (id, t) => {
  const v = document.getElementById(id);
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
window.__size = (id, w, h, top) => {
  const v = document.getElementById(id);
  v.style.width = w + 'px'; v.style.height = h + 'px'; v.style.top = top + 'px';
};`;

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=metal'],
});
const page = await browser.newPage({ viewport: { width: W, height: H * (VS ? 2 : 1) } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.addScriptTag({ content: SEEK_HELPER });
const die = async (msg) => { console.error(msg); await browser.close(); server.close(); process.exit(1); };

// ---- 1. does a player take it? -------------------------------------------
const info = await page.evaluate(async ({ ids }) => {
  const out = {};
  for (const id of ids) {
    const v = document.getElementById(id);
    await new Promise((r, j) => {
      if (v.readyState >= 1) return r();
      v.onloadedmetadata = r;
      v.onerror = () => j(new Error(id + ' video error ' + (v.error && v.error.message)));
    });
    out[id] = { duration: v.duration, w: v.videoWidth, h: v.videoHeight };
  }
  out.mse = {
    high: MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001f,mp4a.40.2"'),
    main: MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d001f,mp4a.40.2"'),
    base: MediaSource.isTypeSupported('video/mp4; codecs="avc1.42001f,mp4a.40.2"'),
  };
  return out;
}, { ids: VS ? ['a', 'b'] : ['a'] });
console.log(`player    accepts it: ${info.a.w}x${info.a.h}  ${info.a.duration.toFixed(3)} s  `
  + `(cut says ${meta.seconds} s, ${meta.frames} frames)`);
console.log(`          MSE says avc1.64001f+aac ${info.mse.high ? 'yes' : 'no'}, `
  + `4d001f ${info.mse.main ? 'yes' : 'no'}, 42001f ${info.mse.base ? 'yes' : 'no'}`);
if (info.a.w !== W || info.a.h !== H) await die(`! frame size is ${info.a.w}x${info.a.h}, expected ${W}x${H}`);
if (VS) console.log(`vs        ${VS}: ${info.b.w}x${info.b.h}  ${info.b.duration.toFixed(3)} s  `
  + `${files.b.length} bytes`);

// ---- 2. what it looks like in a feed -------------------------------------
/*
 * Screenshot the element, do not `drawImage` it: the compositor has the frame, a 2D context
 * does not. And screenshot it at 400 px rather than downscaling a 1280 px shot afterwards, so
 * the browser's own scaler is the one in the picture, as it would be on a phone.
 */
const PH = Math.round((PHONE * H) / W);
await page.evaluate(([w, h]) => window.__size('a', w, h, 0), [PHONE, PH]);
if (VS) await page.evaluate(([w, h]) => window.__size('b', w, h, h + 4), [PHONE, PH]);
const phoneShots = [];
for (const s of SHOTS) {
  const r = await page.evaluate((t) => window.__playAt('a', t), s);
  await page.locator('#a').screenshot({
    path: path.join(OUT, `phone-${String(s.toFixed(1)).padStart(5, '0')}.png`),
    type: 'png', animations: 'allow',
  });
  let rb = null;
  if (VS) {
    rb = await page.evaluate((t) => window.__playAt('b', t), s);
    await page.locator('#b').screenshot({
      path: path.join(OUT, `phone-vs-${String(s.toFixed(1)).padStart(5, '0')}.png`),
      type: 'png', animations: 'allow',
    });
  }
  phoneShots.push({ asked: s, got: r.mt < 0 ? null : +r.mt.toFixed(3),
    gotB: rb && rb.mt >= 0 ? +rb.mt.toFixed(3) : null });
}
console.log(`\nphone stills at ${PHONE}x${PH}: `
  + phoneShots.map((q) => `${q.asked}->${q.got ?? '?'}`).join(' '));
if (phoneShots.some((q) => q.got === null)) console.error('! some seeks presented no frame');
{
  const uniq = new Set(phoneShots.map((q) => q.got));
  if (uniq.size < phoneShots.length) console.error(`! only ${uniq.size} distinct frames for `
    + `${phoneShots.length} seeks — the element is not repainting`);
}

// a single sheet, so the whole cut can be judged at feed size in one look
{
  const shots = [];
  for (const s of SHOTS) {
    const p = path.join(OUT, `phone-${String(s.toFixed(1)).padStart(5, '0')}.png`);
    const q = { t: s, a: (await readFile(p)).toString('base64') };
    if (VS) q.b = (await readFile(path.join(OUT, `phone-vs-${String(s.toFixed(1)).padStart(5, '0')}.png`))).toString('base64');
    shots.push(q);
  }
  const png = await page.evaluate(async ({ shots, PHONE, PH, VS }) => {
    const COLS = 4, GAP = 6, LAB = 18;
    const cellH = PH * (VS ? 2 : 1) + (VS ? 3 : 0);
    const rows = Math.ceil(shots.length / COLS);
    const c = new OffscreenCanvas(COLS * (PHONE + GAP) + GAP, rows * (cellH + LAB + GAP) + GAP);
    const g = c.getContext('2d');
    g.fillStyle = '#101010'; g.fillRect(0, 0, c.width, c.height);
    for (let k = 0; k < shots.length; k++) {
      const x = GAP + (k % COLS) * (PHONE + GAP), y = GAP + Math.floor(k / COLS) * (cellH + LAB + GAP);
      const one = async (b64, dy) => {
        const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
        g.drawImage(bmp, x, y + dy); bmp.close();
      };
      await one(shots[k].a, 0);
      if (VS) await one(shots[k].b, PH + 3);
      g.fillStyle = '#ffd479'; g.font = '12px monospace';
      g.fillText('t=' + shots[k].t.toFixed(1) + 's' + (VS ? '  top MP4 / bottom WebM' : ''),
        x + 2, y + cellH + 13);
    }
    const blob = await c.convertToBlob({ type: 'image/png' });
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return btoa(s);
  }, { shots, PHONE, PH, VS: !!VS });
  await writeFile(path.join(OUT, 'phone-sheet.png'), Buffer.from(png, 'base64'));
  console.log(`phone sheet -> ${path.join(OUT, 'phone-sheet.png')}`);
}

// ---- 2b. the same comparison, at the size it will be watched -------------
/*
 * A 1:1 crop of a 720p encode is a picture of a viewing condition this file will never be in.
 * Every number above is measured at 1280 px; this one is measured at 400, against the source
 * put through a 1920 -> 400 downscale, and — when there is a second file — against the other
 * encode's own presented 400 px frame. If the MP4 and the WebM agree to within a fraction of a
 * dB here, then whatever the 1:1 crops show, a feed cannot tell them apart.
 */
const phonePsnr = [];
{
  const PW = PHONE, PHh = PH;
  for (const at of CROPS) {
    const ra = await page.evaluate(([i, t]) => window.__playAt(i, t), ['a', at]);
    const sa = await page.locator('#a').screenshot({ type: 'png' });
    let sb = null;
    if (VS) {
      await page.evaluate(([i, t]) => window.__playAt(i, t), ['b', at]);
      sb = await page.locator('#b').screenshot({ type: 'png' });
    }
    const idx = Math.round((ra.mt >= 0 ? ra.mt : ra.ct) * FPS);
    const r = await page.evaluate(async ({ aB64, bB64, idx, PW, PHh }) => {
      const dec = async (u) => createImageBitmap(await (await fetch(u)).blob());
      const px = async (b64) => {
        const bmp = await dec('data:image/png;base64,' + b64);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); bmp.close();
        return g.getImageData(0, 0, PW, PHh).data;
      };
      const A = await px(aB64);
      const B = bB64 ? await px(bB64) : null;
      const ref = async (i) => {
        const src = await dec('/f/' + i);
        const c = new OffscreenCanvas(PW, PHh);
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(src, 0, 0, src.width, src.height, 0, 0, PW, PHh);
        src.close();
        return g.getImageData(0, 0, PW, PHh).data;
      };
      const psnr = (x, y) => {
        let m = 0;
        for (let i = 0; i < x.length; i += 4) for (let k = 0; k < 3; k++) m += (x[i + k] - y[i + k]) ** 2;
        return 10 * Math.log10(65025 / (m / ((x.length / 4) * 3)));
      };
      let best = { i: idx, v: -1, px: null };
      for (let d = -4; d <= 4; d++) {
        if (idx + d < 0) continue;
        let rp;
        try { rp = await ref(idx + d); } catch { continue; }
        const v = psnr(rp, A);
        if (v > best.v) best = { i: idx + d, v, px: rp };
      }
      return { frame: best.i, a: best.v, b: B ? psnr(best.px, B) : null,
        ab: B ? psnr(A, B) : null };
    }, { aB64: sa.toString('base64'), bB64: sb ? sb.toString('base64') : null, idx, PW, PHh });
    phonePsnr.push({ at, ...r });
  }
  console.log(`\nthe same five moments at ${PHONE}x${PH}, against the source downscaled 1920 -> ${PHONE}:`);
  for (const r of phonePsnr) {
    console.log(`  t=${String(r.at).padStart(5)}s  frame ${String(r.frame).padStart(3)}  `
      + `MP4 ${r.a.toFixed(2)} dB`
      + (r.b !== null ? `   WebM ${r.b.toFixed(2)} dB   difference ${(r.a - r.b).toFixed(2)} dB`
        + `   MP4 vs WebM ${r.ab.toFixed(2)} dB` : ''));
  }
}

// ---- 5. what the encode cost ---------------------------------------------
await page.evaluate(([w, h]) => window.__size('a', w, h, 0), [W, H]);
if (VS) await page.evaluate(([w, h]) => window.__size('b', w, h, h), [W, H]);
const measure = async (id, at, label) => {
  const r0 = await page.evaluate(([i, t]) => window.__playAt(i, t), [id, at]);
  const shot = await page.locator('#' + id).screenshot({ type: 'png' });
  const idx = Math.round((r0.mt >= 0 ? r0.mt : r0.ct) * FPS);
  return page.evaluate(async ({ shotB64, idx, W, H, label }) => {
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
     * compression artefact there is — that is how a good encode got scored at 23 dB once.
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
    /*
     * The other reference the brief asks for: not the ideal downscale, but the frame the
     * *player* actually presents — the same decoded picture the phone will composite. That is
     * `encPx` itself, so what is reported here is the pair, and the gap between them is how
     * much of the loss is the encoder rather than the resampler.
     */
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
    og.fillText(label + '  frame PSNR ' + (10 * Math.log10(65025 / mse)).toFixed(2)
      + ' dB  worst tile ' + (10 * Math.log10(65025 / worst.mse)).toFixed(2), 8, CHh + 52);
    const blob = await out.convertToBlob({ type: 'image/png' });
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    enc.close();
    return { png: btoa(s), psnr: 10 * Math.log10(65025 / mse),
      worstPsnr: 10 * Math.log10(65025 / worst.mse), frame: best.i, offset: best.i - idx,
      at: [cx, cy] };
  }, { shotB64: shot.toString('base64'), idx, W, H, label });
};

console.log('\ncompression, against the source downscaled the same way the encoder did it:');
const psnrs = [];
for (const at of CROPS) {
  const r = await measure('a', at, 'ENCODED H.264 High 720p');
  await writeFile(path.join(OUT, `crop-${at}.png`), Buffer.from(r.png, 'base64'));
  let vs = null;
  if (VS) {
    vs = await measure('b', at, 'ENCODED VP9 720p (the WebM)');
    await writeFile(path.join(OUT, `crop-vs-${at}.png`), Buffer.from(vs.png, 'base64'));
  }
  psnrs.push({ at, psnr: r.psnr, worstPsnr: r.worstPsnr, frame: r.frame, offset: r.offset,
    vsPsnr: vs ? vs.psnr : null, vsWorst: vs ? vs.worstPsnr : null, vsFrame: vs ? vs.frame : null });
  console.log(`  t=${String(at).padStart(5)}s  frame ${String(r.frame).padStart(3)}`
    + ` (${r.offset >= 0 ? '+' : ''}${r.offset})  PSNR ${r.psnr.toFixed(2)} dB`
    + `  worst 64px tile ${r.worstPsnr.toFixed(2)} dB`
    + (vs ? `   | WebM frame ${vs.frame} ${vs.psnr.toFixed(2)} / ${vs.worstPsnr.toFixed(2)} dB` : ''));
}

// ---- 3/4/6. the sound, decoded out of the delivered file ------------------
const audio = await page.evaluate(async ({ bounds, rate0 }) => {
  const ab = await (await fetch('/a')).arrayBuffer();
  const ctx = new AudioContext();
  let b;
  try { b = await ctx.decodeAudioData(ab.slice(0)); }
  catch (e) { return { err: 'decodeAudioData refused the file: ' + e }; }
  const L = b.getChannelData(0), R = b.numberOfChannels > 1 ? b.getChannelData(1) : L;
  const rate = b.sampleRate;
  const rms = (a, z, sh = 0) => {
    let s = 0, n = 0;
    for (let i = a; i < z; i++) {
      const j = i + sh;
      if (j < 0 || j >= L.length) continue;
      s += L[j] * L[j] + R[j] * R[j]; n += 2;
    }
    return Math.sqrt(s / (n || 1));
  };
  const peak = (a, z) => {
    let m = 0;
    for (let i = Math.max(0, a); i < z && i < L.length; i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
    return m;
  };

  /*
   * How far out of step is the delivered track? AAC-LC primes the decoder with about a frame
   * of samples before its output is valid, and an MP4 written straight from raw AAC frames has
   * no edit list to take that back off. Correlate a coarse energy envelope of the decoded track
   * against one of the mixdown the cut wrote, over +/- 100 ms, and report where it peaks.
   */
  const refBuf = await (await fetch('/pcm')).arrayBuffer();
  const ref = new Float32Array(refBuf);
  const nRef = ref.length / 2;
  const HOP = 32;
  const envOf = (get, n) => {
    const e = new Float32Array(Math.floor(n / HOP));
    for (let k = 0; k < e.length; k++) {
      let s = 0;
      for (let i = 0; i < HOP; i++) { const v = get(k * HOP + i); s += v * v; }
      e[k] = Math.sqrt(s / HOP);
    }
    return e;
  };
  const eRef = envOf((i) => (Math.abs(ref[i * 2]) + Math.abs(ref[i * 2 + 1])) / 2, nRef);
  const eDec = envOf((i) => (Math.abs(L[i] ?? 0) + Math.abs(R[i] ?? 0)) / 2, L.length);
  const corrAt = (lagHops) => {
    let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0, n = 0;
    for (let k = 40; k < eRef.length - 40; k++) {
      const j = k + lagHops;
      if (j < 0 || j >= eDec.length) continue;
      const x = eRef[k], y = eDec[j];
      sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y; n++;
    }
    const num = n * sxy - sx * sy;
    const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    return den > 0 ? num / den : 0;
  };
  let bestLag = 0, bestR = -2;
  for (let lag = -Math.round((0.1 * rate) / HOP); lag <= Math.round((0.1 * rate) / HOP); lag++) {
    const r = corrAt(lag);
    if (r > bestR) { bestR = r; bestLag = lag; }
  }
  const lagSamples = bestLag * HOP;

  const perShot = bounds.map((q) => ({ id: q.id,
    rms: +rms(Math.round(q.in * rate), Math.round(q.out * rate)).toFixed(6),
    rmsAligned: +rms(Math.round(q.in * rate), Math.round(q.out * rate), lagSamples).toFixed(6),
    peak: +peak(Math.round(q.in * rate), Math.round(q.out * rate)).toFixed(4) }));
  const tailA = rms(Math.round((b.duration - 0.8) * rate), Math.round((b.duration - 0.6) * rate));
  const tailB = rms(Math.round((b.duration - 0.15) * rate), Math.round(b.duration * rate));

  // ---- played for real, meter on -----------------------------------------
  const v = document.getElementById('a');
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
    lagSamples, lagMs: +((lagSamples / rate) * 1000).toFixed(2), lagCorr: +bestR.toFixed(4),
    whole: +rms(0, L.length).toFixed(6), wholePeak: +peak(0, L.length).toFixed(4),
    tailA: +tailA.toFixed(5), tailB: +tailB.toFixed(5), ctxState: pctx.state };
}, { bounds, rate0: 48000 });

if (audio.err) await die(audio.err);
console.log(`\naudio     ${audio.channels} ch  ${audio.rate} Hz  ${audio.seconds.toFixed(3)} s decoded`);
console.log(`lag       delivered track leads/lags the mixdown by ${audio.lagSamples} samples `
  + `(${audio.lagMs} ms), envelope correlation r=${audio.lagCorr}`);
console.log('\nshot              in     out   decoded RMS    dBFS   cut RMS    delta   aligned   delta   peak');
let worstDelta = 0, worstAligned = 0;
for (let i = 0; i < audio.perShot.length; i++) {
  const p = audio.perShot[i], q = bounds[i];
  const d = ((p.rms - q.cutRms) / (q.cutRms || 1)) * 100;
  const da = ((p.rmsAligned - q.cutRms) / (q.cutRms || 1)) * 100;
  worstDelta = Math.max(worstDelta, Math.abs(d));
  worstAligned = Math.max(worstAligned, Math.abs(da));
  console.log(`${p.id.padEnd(15)} ${q.in.toFixed(1).padStart(5)} ${q.out.toFixed(1).padStart(7)}   `
    + `${p.rms.toFixed(5)}   ${(20 * Math.log10(p.rms || 1e-9)).toFixed(1).padStart(6)}   `
    + `${q.cutRms.toFixed(5)}  ${((d >= 0 ? '+' : '') + d.toFixed(2)).padStart(7)} %  `
    + `${p.rmsAligned.toFixed(5)}  ${((da >= 0 ? '+' : '') + da.toFixed(2)).padStart(7)} %  ${p.peak.toFixed(3)}`);
}
console.log(`\nwhole track  decoded RMS ${audio.whole} (${(20 * Math.log10(audio.whole)).toFixed(1)} dBFS)  `
  + `peak ${audio.wholePeak}  |  cut wrote ${meta.rms} / ${meta.peak}`);
console.log(`worst per-shot disagreement with the mixdown: ${worstDelta.toFixed(2)} % raw, `
  + `${worstAligned.toFixed(2)} % after taking the ${audio.lagMs} ms off`);
console.log(`tail: RMS ${audio.tailA} at -0.8..-0.6 s -> ${audio.tailB} over the last 0.15 s `
  + `(the sound goes down with the picture)`);
console.log('\nplayed through a <video> element and an analyser:');
for (const p of audio.probe) console.log(`  t=${p.at}s  peak block RMS ${p.playedRms}`);
if (audio.probe.every((p) => p.playedRms < 1e-4)) console.error('! nothing came out of the element');

await writeFile(path.join(OUT, 'review.json'), JSON.stringify({ file: FILE, bytes: size, container,
  info, perShot: audio.perShot, lagSamples: audio.lagSamples, lagMs: audio.lagMs,
  probe: audio.probe, psnrs, phonePsnr, seconds: audio.seconds, worstDelta, worstAligned,
  whole: audio.whole, wholePeak: audio.wholePeak }, null, 1));
console.log(`\n-> ${path.join(OUT, 'review.json')}`);
await browser.close();
server.close();
