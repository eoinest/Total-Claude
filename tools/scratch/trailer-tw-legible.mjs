/**
 * trailer-tw-legible.mjs — measure what survives the downscale to a phone feed, per frame.
 *
 * `trailer-tw-scout.mjs` answers "which beats survive at 400 px?" by laying them out at that
 * size and looking. Looking is necessary and it is what finally decided this cut, but it
 * cannot rank two shots that are both "fine", and it cannot see a thing that lasts four
 * frames. Two questions on this pass needed a number:
 *
 *  1. **Which of the two escalade beats reads better at 400 px?** The owner asked for one of
 *     them and left the choice open. "Reads better" is not a taste if it is defined: at the
 *     delivered width, how much *structure* is left after the browser's own downscale has
 *     thrown away five sixths of the pixels. A shot that is big shapes and hard silhouettes
 *     keeps its gradient energy; a shot that was carried by fine detail loses it.
 *  2. **Does the gate breaking read at 400 px at all?** The previous pass said it does not,
 *     and put `rome-arch` after it for exactly that reason. `rome-arch` is now cut, so the
 *     claim has to be re-tested rather than inherited — and tested the right way. At feed
 *     size the eye does not resolve a leaf swinging; what it resolves is *motion*. So the
 *     instrument reports inter-frame |Dluma| **of the whole downscaled frame**, which is what
 *     a viewer's peripheral vision actually gets, alongside the gate-mouth box the scout's
 *     `--diff` measured. If the break is a spike in the first, it lands; if it is only a
 *     spike in the second, it does not.
 *
 * Everything is computed on the frame downscaled to exactly the delivered width with
 * `imageSmoothingQuality = 'high'`, which is the same path the encoder and the browser take.
 * Nothing is upscaled anywhere.
 *
 *   node tools/scratch/trailer-tw-legible.mjs --beats=siege-ladders:104-179,siege-parapet:44-115
 *   node tools/scratch/trailer-tw-legible.mjs --beats=rome-ram-gate:300-479 --step=1 \
 *     --box=0.38,0.30,0.30,0.46 --series
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const FRAMES = args.get('frames') ?? '/tmp/tc-trailer-frames/frames';
const OUT = args.get('out') ?? '/tmp/tc-recut-work/legible';
const PORT = Number(args.get('port') ?? 5342);
const WIDE = Number(args.get('wide') ?? 400);
const STEP = Number(args.get('step') ?? 1);
const BOX = (args.get('box') ?? '').split(',').filter(Boolean).map(Number);
const SERIES = args.has('series');
/** "id:a-b,id2:a-b" */
const SPEC = (args.get('beats') ?? '').split(',').filter(Boolean).map((s) => {
  const [id, range] = s.split(':');
  const [a, b] = range.split('-').map(Number);
  return { id, a, b };
});
if (!SPEC.length) { console.error('need --beats=id:a-b[,id:a-b]'); process.exit(2); }

await mkdir(OUT, { recursive: true });
const fpath = (id, i) => path.join(FRAMES, `${id}-${String(i).padStart(4, '0')}.jpg`);

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/f') {
    try {
      const b = await readFile(fpath(u.searchParams.get('id'), Number(u.searchParams.get('i'))));
      res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(b);
    } catch { res.writeHead(404); return res.end('no'); }
  }
  if (u.pathname === '/log' && req.method === 'POST') {
    const bufs = []; for await (const c of req) bufs.push(c);
    console.log('  ' + Buffer.concat(bufs).toString('utf8')); res.writeHead(204); return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><meta charset=utf-8><body style="margin:0;background:#111">');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const all = [];
for (const s of SPEC) {
  const r = await page.evaluate(async ({ id, a, b, WIDE, STEP, BOX }) => {
    const H = Math.round((WIDE * 9) / 16);
    const c = new OffscreenCanvas(WIDE, H);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    const luma = async (i) => {
      const bmp = await createImageBitmap(await (await fetch(`/f?id=${id}&i=${i}`)).blob());
      g.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, WIDE, H);
      bmp.close();
      const d = g.getImageData(0, 0, WIDE, H).data;
      const L = new Float32Array(WIDE * H);
      for (let k = 0; k < L.length; k++) {
        L[k] = 0.2126 * d[k * 4] + 0.7152 * d[k * 4 + 1] + 0.0722 * d[k * 4 + 2];
      }
      return L;
    };
    /** Mean |gradient| over the downscaled frame: the structure that survived the resample. */
    const grad = (L) => {
      let s = 0, n = 0;
      for (let y = 0; y < H - 1; y++) {
        for (let x = 0; x < WIDE - 1; x++) {
          const k = y * WIDE + x;
          s += Math.abs(L[k + 1] - L[k]) + Math.abs(L[k + WIDE] - L[k]); n++;
        }
      }
      return s / n;
    };
    const sd = (L) => {
      let m = 0; for (let k = 0; k < L.length; k++) m += L[k]; m /= L.length;
      let v = 0; for (let k = 0; k < L.length; k++) v += (L[k] - m) ** 2;
      return Math.sqrt(v / L.length);
    };
    /** Same, restricted to a normalised sub-box, so a local event can be told from a global one. */
    const boxDelta = (L, P) => {
      if (!BOX.length) return null;
      const x0 = Math.round(BOX[0] * WIDE), y0 = Math.round(BOX[1] * H);
      const x1 = Math.min(WIDE, x0 + Math.round(BOX[2] * WIDE));
      const y1 = Math.min(H, y0 + Math.round(BOX[3] * H));
      let s = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const k = y * WIDE + x; s += Math.abs(L[k] - P[k]); n++;
      }
      return s / n;
    };
    const out = [];
    let prev = null;
    for (let i = a; i <= b; i += STEP) {
      const L = await luma(i);
      let dt = null, dbox = null;
      if (prev) {
        let s = 0; for (let k = 0; k < L.length; k++) s += Math.abs(L[k] - prev[k]);
        dt = s / L.length;
        dbox = boxDelta(L, prev);
      }
      out.push({ i, grad: +grad(L).toFixed(3), sd: +sd(L).toFixed(2),
        dt: dt === null ? null : +dt.toFixed(3), dbox: dbox === null ? null : +dbox.toFixed(3) });
      prev = L;
      if ((i - a) % 60 === 0) await fetch('/log', { method: 'POST', body: `${id} ${i}/${b}` });
    }
    return out;
  }, { id: s.id, a: s.a, b: s.b, WIDE, STEP, BOX });
  all.push({ ...s, rows: r });
}
await browser.close(); server.close();

console.log(`\nat ${WIDE} px wide (the delivered feed size), step ${STEP}\n`);
console.log('beat                window     n   grad mean  grad med   sd mean   |dt| mean  |dt| med  |dt| max @');
for (const b of all) {
  const G = b.rows.map((r) => r.grad), S = b.rows.map((r) => r.sd);
  const D = b.rows.filter((r) => r.dt !== null);
  const dmax = D.reduce((m, r) => (r.dt > m.dt ? r : m), D[0] ?? { dt: 0, i: 0 });
  console.log(`${b.id.padEnd(16)} ${String(b.a).padStart(4)}-${String(b.b).padEnd(4)} `
    + `${String(b.rows.length).padStart(5)}  ${mean(G).toFixed(3).padStart(9)}  `
    + `${med(G).toFixed(3).padStart(8)}  ${mean(S).toFixed(2).padStart(8)}  `
    + `${mean(D.map((r) => r.dt)).toFixed(3).padStart(10)}  ${med(D.map((r) => r.dt)).toFixed(3).padStart(8)}  `
    + `${(dmax.dt ?? 0).toFixed(3)} @${dmax.i}`);
}

if (SERIES) {
  for (const b of all) {
    const D = b.rows.filter((r) => r.dt !== null).map((r) => r.dt);
    const m = mean(D), s = Math.sqrt(mean(D.map((x) => (x - m) ** 2)));
    console.log(`\n${b.id}: whole-frame |dt| ${m.toFixed(3)} +/- ${s.toFixed(3)} at ${WIDE} px`
      + (BOX.length ? `   (box ${BOX.join(',')} shown too)` : ''));
    const top = b.rows.filter((r) => r.dt !== null).sort((x, y) => y.dt - x.dt).slice(0, 12)
      .sort((x, y) => x.i - y.i);
    for (const r of top) {
      console.log(`  frame ${String(r.i).padStart(4)}  |dt| ${r.dt.toFixed(3)}  z=${((r.dt - m) / s).toFixed(2)}`
        + (r.dbox !== null ? `   box |dt| ${r.dbox.toFixed(3)}` : ''));
    }
  }
}
const f = path.join(OUT, (args.get('name') ?? 'legible') + '.json');
await writeFile(f, JSON.stringify({ wide: WIDE, step: STEP, box: BOX, beats: all }, null, 1));
console.log(`\n-> ${f}`);
