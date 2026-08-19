// Scratch: contact sheet of the deck-eligible Rome II plates with a horizontal rule grid,
// so the round-2 capture policy can be matched to the reference's camera geometry by eye.
import sharp from 'sharp';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const REFS = path.join(ROOT, 'reference/rome2-steam');
const names = ['s2-04','s2-09','s2-00','s2-01','s2-13','s2-16','s2-17','s2-19','s2-12','s2-14','s2-15','s2-08','s2-02','s2-03'];
const TW = 480, TH = 270, COLS = 3;
const tiles = [];
for (const [i, n] of names.entries()) {
  const src = path.join(REFS, `${n}.jpg`);
  const body = await sharp(src).resize(TW, TH, { fit: 'fill' }).toBuffer();
  let lines = '';
  for (let k = 1; k < 10; k++) {
    const y = Math.round((k / 10) * TH);
    lines += `<line x1="0" y1="${y}" x2="${TW}" y2="${y}" stroke="#00ff88" stroke-width="${k===5?1.6:0.6}" stroke-opacity="0.55"/>`
      + `<text x="2" y="${y - 2}" font-size="9" fill="#00ff88" font-family="monospace">${k}</text>`;
  }
  const svg = `<svg width="${TW}" height="${TH}">${lines}`
    + `<rect x="0" y="0" width="86" height="16" fill="#000"/>`
    + `<text x="3" y="12" font-size="12" fill="#ff2fdc" font-family="monospace">${n}</text></svg>`;
  tiles.push({ input: await sharp(body).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer(),
    top: Math.floor(i / COLS) * TH, left: (i % COLS) * TW });
}
const out = path.join(ROOT, 'screenshots/refcam-r2.png');
await sharp({ create: { width: TW * COLS, height: TH * Math.ceil(names.length / COLS), channels: 3, background: { r: 0, g: 0, b: 0 } } })
  .composite(tiles).png().toFile(out);
console.log(out);
