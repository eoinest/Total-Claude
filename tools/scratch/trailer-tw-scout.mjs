/**
 * trailer-tw-scout.mjs — look at the master frames the way a phone will, before cutting.
 *
 * Two questions the 1080p pass never had to ask, and neither can be answered from a beat
 * table:
 *
 *  1. **Which beats survive at 400 px?** A feed video is about a third of a phone's width.
 *     A frame that reads at 1920 can be an indistinct brown smear at 400, and the ones that
 *     survive are the ones with big shapes and hard silhouettes, not the ones with the most
 *     detail. So this downscales candidates to exactly the delivered width and lays them out
 *     at that size, labelled, with nothing upscaled anywhere in the chain.
 *  2. **Which frame do the leaves actually give way on?** `gateReport().open` was sampled
 *     every five seconds, so all the capture knows is "between t+210 and t+215". The cut has
 *     to land on the picture, not on the sample grid, so the beat is scanned for the frame
 *     where the pixels in the gate mouth change.
 *
 *   node tools/scratch/trailer-tw-scout.mjs --sheet=field-scale:0,60,120,179
 *   node tools/scratch/trailer-tw-scout.mjs --diff=rome-ram-gate --box=0.38,0.30,0.30,0.46
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const FRAMES = args.get('frames') ?? '/tmp/tc-trailer-frames/frames';
const OUT = args.get('out') ?? '/tmp/tc-tw/scout';
const PORT = Number(args.get('port') ?? 5271);
const WIDE = Number(args.get('wide') ?? 400);          // a video in a phone feed, roughly
const COLS = Number(args.get('cols') ?? 4);

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

// ---- contact sheet, at the delivered width -------------------------------
if (args.has('sheet')) {
  // "id:a,b,c id2:d,e" — several beats in one sheet.
  const spec = args.get('sheet').split(' ').map((s) => {
    const [id, list] = s.split(':');
    return { id, idx: list.split(',').map(Number) };
  });
  const sbox = (args.get('sbox') ?? '0,0,1,1').split(',').map(Number);
  const png = await page.evaluate(async ({ spec, WIDE, COLS, sbox }) => {
    const cells = [];
    for (const s of spec) for (const i of s.idx) cells.push({ id: s.id, i });
    const H = Math.round((WIDE * 9) / 16);
    const rows = Math.ceil(cells.length / COLS);
    const LAB = 20, GAP = 6;
    const c = new OffscreenCanvas(COLS * (WIDE + GAP) + GAP, rows * (H + LAB + GAP) + GAP);
    const g = c.getContext('2d');
    g.fillStyle = '#101010'; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    for (let k = 0; k < cells.length; k++) {
      const { id, i } = cells[k];
      const bmp = await createImageBitmap(await (await fetch(`/f?id=${id}&i=${i}`)).blob());
      const x = GAP + (k % COLS) * (WIDE + GAP), y = GAP + Math.floor(k / COLS) * (H + LAB + GAP);
      g.drawImage(bmp, Math.round(sbox[0] * bmp.width), Math.round(sbox[1] * bmp.height),
        Math.round(sbox[2] * bmp.width), Math.round(sbox[3] * bmp.height), x, y, WIDE, H);
      bmp.close();
      g.fillStyle = '#ffd479'; g.font = '13px monospace';
      g.fillText(`${id} #${i}`, x + 2, y + H + 15);
    }
    const blob = await c.convertToBlob({ type: 'image/png' });
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return btoa(s);
  }, { spec, WIDE, COLS, sbox });
  const f = path.join(OUT, (args.get('name') ?? 'sheet') + '.png');
  await writeFile(f, Buffer.from(png, 'base64'));
  console.log(`sheet → ${f}  (${WIDE} px wide cells)`);
}

// ---- where does the picture actually change? -----------------------------
if (args.has('diff')) {
  const id = args.get('diff');
  const n = Number(args.get('n') ?? 480);
  const step = Number(args.get('step') ?? 1);
  const box = (args.get('box') ?? '0,0,1,1').split(',').map(Number);
  const r = await page.evaluate(async ({ id, n, step, box }) => {
    const grab = async (i) => {
      const bmp = await createImageBitmap(await (await fetch(`/f?id=${id}&i=${i}`)).blob());
      const x = Math.round(box[0] * bmp.width), y = Math.round(box[1] * bmp.height);
      const w = Math.round(box[2] * bmp.width), h = Math.round(box[3] * bmp.height);
      // Quarter scale: this is looking for a gate leaf swinging, not for grain.
      const c = new OffscreenCanvas(Math.round(w / 4), Math.round(h / 4));
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, x, y, w, h, 0, 0, c.width, c.height);
      bmp.close();
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const L = new Float32Array(d.length / 4);
      for (let k = 0; k < L.length; k++) {
        L[k] = 0.2126 * d[k * 4] + 0.7152 * d[k * 4 + 1] + 0.0722 * d[k * 4 + 2];
      }
      return L;
    };
    const out = [];
    let prev = await grab(0);
    for (let i = step; i < n; i += step) {
      const cur = await grab(i);
      let s = 0; for (let k = 0; k < cur.length; k++) s += Math.abs(cur[k] - prev[k]);
      out.push({ i, d: +(s / cur.length).toFixed(3) });
      prev = cur;
      if (i % 60 === 0) await fetch('/log', { method: 'POST', body: `diff ${i}/${n}` });
    }
    return out;
  }, { id, n, step, box });
  const mean = r.reduce((a, b) => a + b.d, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b.d - mean) ** 2, 0) / r.length);
  console.log(`\n${id}  box ${box.join(',')}  mean |dluma| ${mean.toFixed(3)} +/- ${sd.toFixed(3)}`);
  const top = [...r].sort((a, b) => b.d - a.d).slice(0, 14).sort((a, b) => a.i - b.i);
  console.log('biggest changes:');
  for (const x of top) console.log(`  frame ${String(x.i).padStart(4)}  t+${(202 + x.i / 30).toFixed(2)}  ${x.d.toFixed(3)}  z=${((x.d - mean) / sd).toFixed(2)}`);
  await writeFile(path.join(OUT, `diff-${id}.json`), JSON.stringify({ id, box, mean, sd, series: r }, null, 1));
}

await browser.close(); server.close();
