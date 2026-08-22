#!/usr/bin/env node
/**
 * Digitise the Tiber's channel centreline off the georeferenced Lanciani raster, by colour.
 *
 * Why this and not a gazetteer: modern bridge midpoints are only good to ~70 m when read from
 * memory, and 70 m is the same order as the fault being measured. The plate's own channel is
 * inked in a distinctive pale blue that nothing else on the sheet uses at scale, and the plate
 * carries a 1.26 m georeference. So the plate can be its own ruler.
 *
 * Method: for each survey-frame northing n, walk east across the sheet in survey metres,
 * classify each sample as channel or not, and take the midpoint of the widest contiguous run.
 * Reported with the run's width, so a row where the classifier caught a lake, a contour band
 * or a sheet seam instead of the river is visible as an absurd width rather than silently
 * averaged in.
 */
import { createRequire } from 'node:module';
const require = createRequire('/Users/ernestmccarter/Documents/dev/Total-Claude/package.json');
const sharp = require('sharp');
import { pxOf } from './plate.mjs';
import fs from 'node:fs';

const SRC = '/Users/ernestmccarter/Documents/dev/Total-Claude/reference/rome-plans/lanciani-georef-EPSG3004-2307658_4638583_2314671_4643263-4096px.png';
const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, C = info.channels;
const at = (px, py) => { const i = ((py | 0) * W + (px | 0)) * C; return [data[i], data[i + 1], data[i + 2]]; };
// The channel ink: pale cyan-blue on cream. Cream is roughly (243,238,222) — r>g>b.
// Channel is b >= g > r with a real blue excess. Contour blue is thin and does not form runs.
const isWater = (px, py) => {
  if (px < 1 || py < 1 || px > W - 2 || py > H - 2) return false;
  const [r, g, b] = at(px, py);
  return b - r > 8 && b > 120 && b < 245 && g >= r;
};

const rows = [];
const argN0 = Number(process.argv[2] ?? -1200), argN1 = Number(process.argv[3] ?? 2600), step = Number(process.argv[4] ?? 25);
for (let n = argN0; n <= argN1; n += step) {
  // walk e from -2200 to +400, 3 m steps, with 3 sub-samples across the scan line to
  // survive the plate's hatching
  const hits = [];
  for (let e = -2400; e <= 500; e += 3) {
    const p = pxOf(e, n);
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) if (isWater(Math.round(p.px), Math.round(p.py) + dy)) k++;
    hits.push([e, k >= 2]);
  }
  // widest contiguous run, allowing 2 sample gaps (bridges, quay lines)
  let best = null, s = null, gap = 0;
  for (let i = 0; i < hits.length; i++) {
    if (hits[i][1]) { if (s === null) s = i; gap = 0; }
    else if (s !== null) { gap++; if (gap > 3) { const run = { a: hits[s][0], b: hits[i - gap][0] }; if (!best || run.b - run.a > best.b - best.a) best = run; s = null; gap = 0; } }
  }
  if (s !== null) { const run = { a: hits[s][0], b: hits[hits.length - 1][0] }; if (!best || run.b - run.a > best.b - best.a) best = run; }
  if (best) rows.push({ n, e: (best.a + best.b) / 2, width: best.b - best.a });
}
fs.writeFileSync('/tmp/judge/river-digitised.json', JSON.stringify(rows));
console.log(`n\tcentre e\twidth (survey m)`);
for (const r of rows) if (r.n % 100 === 0) console.log(`${r.n}\t${r.e.toFixed(0)}\t${r.width.toFixed(0)}`);
console.log(`rows ${rows.length}; median width ${rows.map(r=>r.width).sort((a,b)=>a-b)[rows.length>>1].toFixed(0)} m`);
