/**
 * trailer-montage.mjs — a contact sheet, so a pass of the trailer can be looked at in one go.
 *
 *   node tools/scratch/trailer-montage.mjs <dir-of-jpegs> <out.png> [columns]
 *
 * Files are ordered by the number in their name, which is how both `trailer-review.mjs`
 * (`t00019.jpg`) and the frame cache (`beat-0093.jpg`) name things.
 */
import { chromium } from 'playwright';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const DIR = process.argv[2], OUT = process.argv[3], COLS = Number(process.argv[4] ?? 4);
const files = (await readdir(DIR)).filter((f) => f.endsWith('.jpg')).sort((a, b) =>
  parseFloat(a.slice(1)) - parseFloat(b.slice(1)));
const b64s = [];
for (const f of files) b64s.push((await readFile(path.join(DIR, f))).toString('base64'));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');
const png = await page.evaluate(async ({ b64s, labels, COLS }) => {
  const cw = 480, ch = 270, rows = Math.ceil(b64s.length / COLS);
  const c = new OffscreenCanvas(COLS * cw, rows * ch);
  const g = c.getContext('2d');
  g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < b64s.length; i++) {
    const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64s[i])).blob());
    g.drawImage(bmp, (i % COLS) * cw, Math.floor(i / COLS) * ch, cw, ch);
    g.fillStyle = '#ff0'; g.font = 'bold 20px monospace';
    g.fillText(labels[i], (i % COLS) * cw + 8, Math.floor(i / COLS) * ch + 26);
    bmp.close();
  }
  const blob = await c.convertToBlob({ type: 'image/png' });
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
  return btoa(s);
}, { b64s, labels: files.map((f) => f.replace('.jpg', '').replace(/^t0*/, 't')), COLS });
await writeFile(OUT, Buffer.from(png, 'base64'));
await browser.close();
console.log(OUT, files.length);
