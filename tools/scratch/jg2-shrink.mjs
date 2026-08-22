#!/usr/bin/env node
/**
 * Downscale this pass's plates to 1500 px wide, which is the width the first ground pass's
 * plates are and the width `docs/CITY-GROUND-JUDGE.md` shows them at.
 *
 * ImageMagick is not installed on this box and the ffmpeg that ships with Playwright is a
 * minimal build with no mjpeg decoder — it reports "Invalid data found" on a valid JPEG. So
 * the resize goes through a canvas in the browser Playwright *does* ship, which is already a
 * dependency of every shot script in this directory.
 *
 *   node tools/scratch/jg2-shrink.mjs <dir> [width]
 */
import { chromium } from 'playwright';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DIR = process.argv[2];
const W = Number(process.argv[3] ?? 1500);
if (!DIR) { console.error('usage: jg2-shrink.mjs <dir> [width]'); process.exit(2); }

const files = (await readdir(DIR)).filter((f) => /^lm2-.*\.jpg$/.test(f));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');

let before = 0;
let after = 0;
for (const f of files) {
  const buf = await readFile(path.join(DIR, f));
  before += buf.length;
  const out = await page.evaluate(async ({ b64, W }) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = W;
    c.height = Math.round((img.naturalHeight / img.naturalWidth) * W);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82).split(',')[1];
  }, { b64: buf.toString('base64'), W });
  const nb = Buffer.from(out, 'base64');
  await writeFile(path.join(DIR, f), nb);
  after += nb.length;
  console.log(`  ${f.padEnd(30)} ${(buf.length / 1024).toFixed(0)} -> ${(nb.length / 1024).toFixed(0)} kB`);
}
console.log(`\n${files.length} plates, ${(before / 1048576).toFixed(1)} -> ${(after / 1048576).toFixed(1)} MB`);
await browser.close();
process.exit(0);
