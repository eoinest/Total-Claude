/**
 * trailer-cropcheck.mjs — judge the encode at 100 %, against the frame it came from.
 *
 * The released cut was downscaled to 1600x900 because VP8 could not carry 1080p, and the
 * previous pass reported "no difference I could find on the two hardest frames" — which was
 * true of VP8 at its ceiling quantiser and says nothing about the source. So this puts a
 * 1:1 crop of a decoded frame directly under the same crop of the 1920x1080 JPEG it was
 * encoded from, and prints the PSNR between them, on the frames where an encode fails first:
 * dust over a moving camera, eight thousand men at distance, and the gate mouth in shadow.
 *
 *   node tools/scratch/trailer-cropcheck.mjs --file=x.webm --at=8.5,20.5,66 --crop=520,300
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const FILE = args.get('file') ?? '/tmp/tc-sound/total-claude-trailer-sound.webm';
const CUT = args.get('cut') ?? '/tmp/tc-trailer-frames/cut.json';
const OUT = args.get('out') ?? '/tmp/tc-sound/crops';
const PORT = Number(args.get('port') ?? 5240);
const AT = (args.get('at') ?? '8.5,20.5,33,66').split(',').map(Number);
const [CW, CH] = (args.get('crop') ?? '640,360').split(',').map(Number);

await mkdir(OUT, { recursive: true });
const cut = JSON.parse(await readFile(CUT, 'utf8'));
const buf = await readFile(FILE);
const server = createServer(async (req, res) => {
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
  if (u.pathname.startsWith('/f/')) {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(await readFile(cut[Number(u.pathname.slice(3))]));
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
/*
 * Seek, play until a frame is presented, then stop *on that frame*.
 *
 * Headless Chromium will not repaint a paused `<video>` after a seek, so the frame has to be
 * played out. But the screenshot round trip takes long enough for two or three more frames to
 * present, and against a moving camera that reads as a bad encode: the first version of this
 * measured 23 dB on a crop that turned out to be two frames of camera travel, not compression.
 * So the element is paused inside `requestVideoFrameCallback` and the position it actually
 * stopped at is what the source frame is chosen by.
 */
const SEEK_HELPER = `window.__playAt = async (t) => {
  const v = document.getElementById('v');
  v.muted = true;
  await new Promise((r) => { v.onseeked = r; v.currentTime = t; });
  await v.play();
  for (let k = 0; k < 2; k++) {
    await new Promise((r) => {
      let done = false;
      const f = () => { if (!done) { done = true; if (k === 1) v.pause(); r(); } };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => f());
      setTimeout(f, 600);
    });
  }
  v.pause();
  await new Promise((r) => setTimeout(r, 60));
  return v.currentTime;
};
window.__pause = () => { document.getElementById('v').pause(); };`;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.addScriptTag({ content: SEEK_HELPER });
await page.evaluate(() => new Promise((r) => {
  const v = document.getElementById('v');
  if (v.readyState >= 2) return r();
  v.oncanplay = r;
}));

for (const at of AT) {
  /*
   * The decoded frame comes out as an element screenshot rather than a canvas `drawImage`:
   * headless Chromium will not paint a paused `<video>` into a 2D context, and it will not
   * repaint one after a seek at all, so both give the same early frame every time. The
   * screenshot is the compositor's own output, which is what a viewer sees.
   */
  const mt = await page.evaluate((t) => window.__playAt(t), at);
  const shot = await page.locator('#v').screenshot({ type: 'png' });
  /*
   * Compare against the frame the player actually presented, not the one that was asked for.
   * `requestVideoFrameCallback` reports its `mediaTime`; the first version ignored that and
   * measured a two-frame-old source against a moving camera, which reads as a 21 dB encode.
   */
  const idx = Math.round(mt * 30);
  await page.evaluate(() => window.__pause());
  const r = await page.evaluate(async ({ shotB64, idx, CW, CH }) => {
    const dec = async (u) => createImageBitmap(await (await fetch(u)).blob());
    const enc = await dec('data:image/png;base64,' + shotB64);
    const grab = (img, x, y, w, h) => {
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
      return c;
    };
    /*
     * Which source frame is this, really?
     *
     * The presented frame is whatever the compositor stopped on, and against a camera moving
     * a metre a second two frames of travel swamp every compression artefact there is — the
     * first version of this scored a perfectly good encode at 23 dB for exactly that reason.
     * So the reference is chosen by search: the frame in a nine-frame window that matches
     * best. If the best match is not the one asked for, the offset is printed.
     */
    const encFull = grab(enc, 0, 0, enc.width, enc.height)
      .getContext('2d').getImageData(0, 0, enc.width, enc.height).data;
    let bestFrame = { i: idx, mse: Infinity, bmp: null };
    for (let d = -4; d <= 4; d++) {
      const src = await dec('/f/' + (idx + d));
      const px = grab(src, 0, 0, src.width, src.height)
        .getContext('2d').getImageData(0, 0, src.width, src.height).data;
      let mse = 0, n = 0;
      for (let i = 0; i < px.length; i += 4 * 37) {          // sparse: this is only a search
        for (let k = 0; k < 3; k++) { mse += (px[i + k] - encFull[i + k]) ** 2; n++; }
      }
      mse /= n;
      if (mse < bestFrame.mse) {
        if (bestFrame.bmp) bestFrame.bmp.close();
        bestFrame = { i: idx + d, mse, bmp: src };
      } else src.close();
    }
    const src = bestFrame.bmp;
    // Centre the crop on the busiest tile: highest local luma variance in the source.
    const px = grab(src, 0, 0, src.width, src.height)
      .getContext('2d').getImageData(0, 0, src.width, src.height).data;
    let best = { x: 0, y: 0, v: -1 };
    for (let y = 0; y + CH <= src.height; y += 60) {
      for (let x = 0; x + CW <= src.width; x += 60) {
        let a = 0, a2 = 0, n = 0;
        for (let j = y; j < y + CH; j += 8) {
          for (let i = x; i < x + CW; i += 8) {
            const o = (j * src.width + i) * 4;
            const l = 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
            a += l; a2 += l * l; n++;
          }
        }
        const varr = a2 / n - (a / n) ** 2;
        if (varr > best.v) best = { x, y, v: varr };
      }
    }
    /*
     * Align before measuring.
     *
     * Even the right frame is not pixel-registered here: the compositor presents a frame
     * whose exact index cannot be read back reliably, and a camera travelling a metre a
     * second turns half a frame of parallax into a 40-pixel offset. Uncorrected that scored
     * a visually clean encode at 23 dB. So the crop is matched by a coarse-to-fine shift
     * search and the PSNR quoted is the compression difference, not the motion.
     */
    const cs = grab(src, best.x, best.y, CW, CH);
    const a2 = cs.getContext('2d').getImageData(0, 0, CW, CH).data;
    const encPx = grab(enc, 0, 0, enc.width, enc.height)
      .getContext('2d').getImageData(0, 0, enc.width, enc.height).data;
    const mseAt = (dx, dy, step) => {
      let m = 0, n = 0;
      for (let j = 0; j < CH; j += step) {
        const sy = best.y + j + dy;
        if (sy < 0 || sy >= enc.height) return Infinity;
        for (let i = 0; i < CW; i += step) {
          const sx = best.x + i + dx;
          if (sx < 0 || sx >= enc.width) return Infinity;
          const o1 = (j * CW + i) * 4, o2 = (sy * enc.width + sx) * 4;
          for (let k = 0; k < 3; k++) { m += (a2[o1 + k] - encPx[o2 + k]) ** 2; n++; }
        }
      }
      return m / n;
    };
    let sh = { dx: 0, dy: 0, m: Infinity };
    for (let dy = -72; dy <= 72; dy += 4) {
      for (let dx = -72; dx <= 72; dx += 4) {
        const m = mseAt(dx, dy, 4);
        if (m < sh.m) sh = { dx, dy, m };
      }
    }
    let fine = { dx: sh.dx, dy: sh.dy, m: Infinity };
    for (let dy = sh.dy - 3; dy <= sh.dy + 3; dy++) {
      for (let dx = sh.dx - 3; dx <= sh.dx + 3; dx++) {
        const m = mseAt(dx, dy, 2);
        if (m < fine.m) fine = { dx, dy, m };
      }
    }
    const cv = grab(enc, best.x + fine.dx, best.y + fine.dy, CW, CH);
    const b2 = cv.getContext('2d').getImageData(0, 0, CW, CH).data;
    let mse = 0;
    for (let i = 0; i < a2.length; i += 4) for (let k = 0; k < 3; k++) mse += (a2[i + k] - b2[i + k]) ** 2;
    mse /= (a2.length / 4) * 3;
    const out = new OffscreenCanvas(CW, CH * 2 + 34);
    const g = out.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, out.width, out.height);
    g.drawImage(cs, 0, 0); g.drawImage(cv, 0, CH + 34);
    g.fillStyle = '#ff0'; g.font = 'bold 20px monospace';
    g.fillText('SOURCE frame ' + bestFrame.i + ' 1920x1080 JPEG q94  crop @' + best.x + ',' + best.y, 8, 22);
    g.fillText('ENCODED  aligned ' + fine.dx + ',' + fine.dy + ' px   PSNR '
      + (10 * Math.log10(65025 / mse)).toFixed(2) + ' dB', 8, CH + 56);
    const blob = await out.convertToBlob({ type: 'image/png' });
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let str = '';
    for (let i = 0; i < u8.length; i += 32768) str += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    const dims = { encW: enc.width, encH: enc.height, srcW: src.width, srcH: src.height };
    src.close(); enc.close();
    return { png: btoa(str), psnr: 10 * Math.log10(65025 / mse), x: best.x, y: best.y,
      frame: bestFrame.i, offset: bestFrame.i - idx, shift: [fine.dx, fine.dy], ...dims };
  }, { shotB64: shot.toString('base64'), idx, CW, CH });
  await writeFile(path.join(OUT, `crop-${at}.png`), Buffer.from(r.png, 'base64'));
  console.log(`t=${at}s (presented ${mt.toFixed(3)})  matched frame ${r.frame} `
    + `(${r.offset >= 0 ? '+' : ''}${r.offset})  crop @${r.x},${r.y}  `
    + `aligned ${r.shift[0]},${r.shift[1]} px  PSNR ${r.psnr.toFixed(2)} dB`
    + `  → ${path.join(OUT, `crop-${at}.png`)}`);
}
await browser.close();
server.close();
