// Scratch: labelled side-by-side of each pair, ours left, reference right. Builder's eyes
// only — this is the one artefact that must never reach a grader, which is why it is named
// for the round and lives in tools/scratch rather than anywhere near a deck.
import sharp from 'sharp';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

const ROOT = path.resolve(import.meta.dirname, '../..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const OURS = path.resolve(ROOT, arg('ours', 'screenshots/ab-r2'));
const PAIRS = path.resolve(ROOT, arg('pairs', 'tools/ab-pairs-round2.json'));
const OUT = path.resolve(ROOT, arg('out', 'screenshots/sbs-r2.png'));
const TW = 560, TH = 315;

const pairs = JSON.parse(await readFile(PAIRS, 'utf8')).pairs;
const have = new Set((await readdir(OURS)).map((f) => f.replace(/\.[^.]+$/, '')));
const rows = pairs.filter((p) => have.has(p.ours));
const tiles = [];
for (const [i, p] of rows.entries()) {
  for (const [j, src] of [
    [0, path.join(OURS, `${p.ours}.png`)],
    [1, path.join(ROOT, 'reference/rome2-steam', `${p.ref}.jpg`)],
  ]) {
    const body = await sharp(src).resize(TW, TH, { fit: 'fill' }).toBuffer();
    const label = j === 0 ? `OURS ${p.ours}` : `ROME2 ${p.ref}`;
    const svg = `<svg width="${TW}" height="${TH}">`
      + `<rect x="0" y="0" width="${label.length * 8 + 8}" height="16" fill="#000"/>`
      + `<text x="3" y="12" font-size="12" fill="${j ? '#ff2fdc' : '#00ff88'}" font-family="monospace">${label}</text>`
      + `<line x1="0" y1="${TH / 3}" x2="${TW}" y2="${TH / 3}" stroke="#00ffff" stroke-opacity="0.45" stroke-width="0.8"/>`
      + `</svg>`;
    tiles.push({
      input: await sharp(body).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer(),
      top: i * TH, left: j * TW,
    });
  }
}
await sharp({ create: { width: TW * 2, height: TH * rows.length, channels: 3, background: { r: 0, g: 0, b: 0 } } })
  .composite(tiles).png().toFile(OUT);
console.log(OUT, rows.length, 'pairs');
