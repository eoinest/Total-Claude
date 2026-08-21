/**
 * Look at what shipped: decode each poster AVIF and grab three frames out of each WebM,
 * including the two either side of the loop wrap, so the dissolve can be judged rather than
 * assumed. Writes JPEGs to /tmp/tc-menu-check (never-indexed).
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'public', 'menu');
const OUT = '/tmp/tc-menu-check';
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, '.metadata_never_index'), '');

const IDS = ['rome', 'carthage', 'pydna'];

for (const id of IDS) {
  const buf = await readFile(path.join(SRC, `${id}.avif`));
  await sharp(buf).jpeg({ quality: 88 }).toFile(path.join(OUT, `${id}-poster.jpg`));
}

const server = createServer(async (req, res) => {
  const p = req.url === '/' ? null : path.join(SRC, path.basename(req.url));
  if (!p) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><meta charset=utf-8><body style="margin:0;background:#000">'
      + '<video id=v muted playsinline style="width:1280px;height:720px"></video>');
  }
  try {
    const b = await readFile(p);
    res.writeHead(200, { 'content-type': p.endsWith('.webm') ? 'video/webm' : 'image/avif' });
    res.end(b);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(5943, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:5943/');

for (const id of IDS) {
  const meta = await page.evaluate(async (i) => {
    const v = document.getElementById('v');
    v.src = `/${i}.webm`;
    await new Promise((res, rej) => {
      v.onloadeddata = res; v.onerror = () => rej(new Error('load failed'));
    });
    return { duration: v.duration, w: v.videoWidth, h: v.videoHeight };
  }, id);
  console.log(`${id.padEnd(9)} ${meta.w}x${meta.h}  ${meta.duration.toFixed(2)} s`);
  for (const [label, t] of [['head', 0.0], ['mid', 4.5], ['tail', 8.93]]) {
    await page.evaluate(async (tt) => {
      const v = document.getElementById('v');
      v.currentTime = tt;
      await new Promise((res) => { v.onseeked = res; });
    }, t);
    await page.locator('#v').screenshot({ path: path.join(OUT, `${id}-${label}.jpg`), type: 'jpeg', quality: 88 });
  }
}
await browser.close();
server.close();
console.log(`→ ${OUT}`);
