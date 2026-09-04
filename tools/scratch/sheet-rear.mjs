#!/usr/bin/env node
/**
 * Contact sheet: matched frames of the same charge, before and after, one row each.
 *
 * `tools/scratch/shot-rear.mjs` shoots the same lab twice off two builds on one fixed
 * schedule, so `before-tNNN.png` and `after-tNNN.png` are the same sim second seen from the
 * same camera. This lays the chosen seconds out in two rows with the caption each frame
 * earned, which is the only form in which the owner can check the claim himself.
 *
 * Usage: node tools/scratch/sheet-rear.mjs [--dir=screenshots/rear] [--at=7.0,13.5,16.0]
 */
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const DIR = path.resolve(ROOT, args.get('dir') ?? 'screenshots/rear');
const AT = (args.get('at') ?? '7.0,13.5,16.0').split(',').map(Number);

const meta = {};
for (const label of ['before', 'after']) {
  meta[label] = JSON.parse(await readFile(path.join(DIR, `${label}.json`), 'utf8'));
}

const CELL_W = 620;
const CELL_H = 349;
const CAP = 34;
const PAD = 8;
const cols = AT.length;
const W = PAD + cols * (CELL_W + PAD);
const H = PAD + 2 * (CELL_H + CAP + PAD);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const composites = [];
for (let r = 0; r < 2; r++) {
  const label = r === 0 ? 'before' : 'after';
  for (let c = 0; c < cols; c++) {
    const t = AT[c];
    const name = `${label}-t${String(Math.round(t * 10)).padStart(3, '0')}.png`;
    const buf = await sharp(path.join(DIR, name)).resize(CELL_W, CELL_H).toBuffer();
    const x = PAD + c * (CELL_W + PAD);
    const y = PAD + r * (CELL_H + CAP + PAD);
    composites.push({ input: buf, left: x, top: y });
    const row = meta[label].rows.find((q) => Math.abs(q.t - t) < 0.3) ?? {};
    const text = `${label}   t+${t.toFixed(1)}s   rearing ${row.rear ?? '?'} of ${row.alive ?? '?'}`
      + `   skating ${row.skate ?? '?'}`;
    const svg = `<svg width="${CELL_W}" height="${CAP}">
      <rect width="${CELL_W}" height="${CAP}" fill="${r === 0 ? '#3a1f1c' : '#1c3a24'}"/>
      <text x="10" y="23" font-family="Menlo,monospace" font-size="16" fill="#f0e8dc">${esc(text)}</text>
    </svg>`;
    composites.push({ input: Buffer.from(svg), left: x, top: y + CELL_H });
  }
}

const out = path.join(DIR, 'sheet.png');
await sharp({ create: { width: W, height: H, channels: 3, background: '#14110e' } })
  .composite(composites)
  .png()
  .toFile(out);
console.log(`wrote ${out}  (${W}x${H}, ${cols} matched seconds)`);
