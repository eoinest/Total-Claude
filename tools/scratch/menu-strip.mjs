/**
 * Throwaway: the frame strip as one readable contact sheet.
 *
 * Forty-six 1440x900 PNGs are the evidence; a 4-wide grid of 360-wide thumbs is the thing a
 * person can actually look at, and it is what goes in the report beside the clip.
 */
import path from 'node:path';
import process from 'node:process';
import { readdir } from 'node:fs/promises';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const DIR = path.resolve(ROOT, args.get('dir') ?? 'screenshots/menu-clip');
const PICK = (args.get('pick') ?? '').split(',').filter(Boolean);
const OUT = path.resolve(ROOT, args.get('out') ?? path.join(DIR, 'strip.png'));
const TW = Number(args.get('tw') ?? 360);
const COLS = Number(args.get('cols') ?? 4);

const files = PICK.length
  ? PICK
  : (await readdir(DIR)).filter((f) => f.endsWith('.png') && f !== path.basename(OUT)).sort();
const th = Math.round(TW * 900 / 1440);
const tiles = [];
for (let i = 0; i < files.length; i += 1) {
  const buf = await sharp(path.join(DIR, files[i])).resize(TW, th, { fit: 'cover' }).toBuffer();
  tiles.push({ input: buf, left: (i % COLS) * TW, top: Math.floor(i / COLS) * th });
}
const rows = Math.ceil(files.length / COLS);
await sharp({
  create: { width: COLS * TW, height: rows * th, channels: 3, background: { r: 8, g: 6, b: 4 } },
}).composite(tiles).png().toFile(OUT);
console.log(`${files.length} frames -> ${OUT}`);
