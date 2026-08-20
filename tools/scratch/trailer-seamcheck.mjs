/**
 * trailer-seamcheck.mjs — is the join a move or a cut?
 *
 * The released trailer broke the ram push in two, and the owner saw the join. The fix is one
 * sixteen-second beat, and "monotonic in the numbers" is not the same as "reads as one take":
 * a camera whose *rate* changes across the old seam still reads as a new setup. So this
 * measures the thing an eye measures — how much the picture changes from one frame to the
 * next — and prints it around every boundary, including the one that no longer exists.
 *
 * A hard cut is a spike. A move is a smooth curve. The point of interest is frame 180 of
 * `rome-ram-gate` (0:63.0 in the old cut), where two shots used to be spliced.
 *
 *   node tools/scratch/trailer-seamcheck.mjs --beat=rome-ram-gate
 */
import { chromium } from 'playwright';
import { readdir, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const FRAMES = args.get('frames') ?? '/tmp/tc-trailer-frames/frames';
const BEAT = args.get('beat') ?? 'rome-ram-gate';
const OUT = args.get('out') ?? '/tmp/tc-sound/seam';
const SHEET = (args.get('sheet') ?? '').split(',').filter(Boolean).map(Number);

await mkdir(OUT, { recursive: true });
const files = (await readdir(FRAMES)).filter((f) => /^(.*)-\d{4}\.jpg$/.exec(f)?.[1] === BEAT).sort();
if (!files.length) { console.error(`no frames for ${BEAT}`); process.exit(2); }
console.log(`${BEAT}: ${files.length} frames`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
await page.goto('about:blank');
await page.evaluate(() => {
  window.__d = { prev: null, out: [] };
  window.__push = async (b64) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob());
    const c = new OffscreenCanvas(192, 108);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, 192, 108);
    const d = g.getImageData(0, 0, 192, 108).data;
    const lum = new Float32Array(192 * 108);
    for (let i = 0; i < lum.length; i++) {
      lum[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    }
    let diff = 0;
    if (window.__d.prev) {
      for (let i = 0; i < lum.length; i++) diff += Math.abs(lum[i] - window.__d.prev[i]);
      diff /= lum.length;
    }
    window.__d.prev = lum;
    window.__d.out.push(+diff.toFixed(3));
    bmp.close();
  };
});
for (const f of files) {
  const b64 = (await readFile(path.join(FRAMES, f))).toString('base64');
  await page.evaluate((b) => window.__push(b), b64);
}
const diffs = await page.evaluate(() => window.__d.out);

// A contact sheet across the join, so the join can be looked at as well as measured.
if (SHEET.length) {
  const picks = SHEET.map((i) => files[i]).filter(Boolean);
  const b64s = [];
  for (const f of picks) b64s.push((await readFile(path.join(FRAMES, f))).toString('base64'));
  const png = await page.evaluate(async ({ b64s, labels }) => {
    const cols = Math.min(3, b64s.length), rows = Math.ceil(b64s.length / cols);
    const cw = 640, ch = 360;
    const c = new OffscreenCanvas(cols * cw, rows * ch);
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < b64s.length; i++) {
      const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64s[i])).blob());
      g.drawImage(bmp, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch);
      g.fillStyle = '#ff0'; g.font = 'bold 26px monospace';
      g.fillText(labels[i], (i % cols) * cw + 12, Math.floor(i / cols) * ch + 34);
      bmp.close();
    }
    const blob = await c.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
    return btoa(s);
  }, { b64s, labels: SHEET.map((i) => `f${i}  t+${(202 + i / 30).toFixed(1)}`) });
  await writeFile(path.join(OUT, `${BEAT}-sheet.png`), Buffer.from(png, 'base64'));
  console.log(`sheet → ${path.join(OUT, `${BEAT}-sheet.png`)}`);
}
await browser.close();

await writeFile(path.join(OUT, `${BEAT}-diff.json`), JSON.stringify(diffs));
const body = diffs.slice(1);
const mean = body.reduce((a, b) => a + b, 0) / body.length;
const sd = Math.sqrt(body.reduce((a, b) => a + (b - mean) ** 2, 0) / body.length);
const max = Math.max(...body), argmax = body.indexOf(max) + 1;
console.log(`mean |dluma| ${mean.toFixed(2)}  sd ${sd.toFixed(2)}  max ${max.toFixed(2)} at frame ${argmax}`);
const at = (i) => `${i}:${diffs[i]?.toFixed(2)}`;
for (const j of [180, 240]) {
  const win = [];
  for (let i = j - 4; i <= j + 4; i++) if (diffs[i] !== undefined) win.push(at(i));
  const z = ((diffs[j] - mean) / sd).toFixed(2);
  console.log(`  around frame ${j} (t+${(202 + j / 30).toFixed(2)}): ${win.join(' ')}   z=${z}`);
}
// The rate of the move, sampled: a take that changes gear reads as a cut even when it is not.
const bucket = 30;
const line = [];
for (let i = 1; i < diffs.length; i += bucket) {
  const w = diffs.slice(i, i + bucket);
  line.push(`${((i / 30)).toFixed(0)}s:${(w.reduce((a, b) => a + b, 0) / w.length).toFixed(1)}`);
}
console.log('  per-second mean: ' + line.join(' '));
