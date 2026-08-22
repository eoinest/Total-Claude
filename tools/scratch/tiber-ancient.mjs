#!/usr/bin/env node
/**
 * **The ancient channel's width, off Lanciani, along the course found on the orthophoto.**
 *
 * The map is 271 AD and the orthophoto is 2012, and between them stand the *muraglioni* — the
 * embankments built 1876-1926, which straightened the Tiber at Rome and narrowed it. Measured on
 * the orthophoto the channel runs a median 51 m between gated water edges; the real modern river
 * is 90-100 m between the embankment faces, and the ancient one was wider again. Two things are
 * going on and only one of them is a fact about the river:
 *
 *  - **The gate erodes the bank.** The roughness window is 7x7, so a pixel within 3 px of a hard
 *    edge is rough and fails, and the *muraglioni* cast a shadow onto the water that fails the
 *    luminance floor. Between them that is 10-20 m a side. This is an artefact and must not be
 *    carried into the map.
 *  - **The ancient river was wider and its banks were somewhere else**, particularly at the
 *    Campus Martius quays, the Ripa and around the island. This is a fact and must be carried.
 *
 * So the centreline comes from the orthophoto (where water is measurable) and the **width comes
 * from Lanciani** (where the ancient bank is drawn). Lanciani inks the channel with a pale blue
 * bank line either side and leaves the water as paper; the classifier below finds those lines.
 *
 * False positives: Lanciani also washes the *modern* street plan in a similar pale blue. They are
 * excluded by the corridor — only pixels within `--corridor` metres of the course are considered,
 * and the corridor comes from the orthophoto, not from a guess about where the Tiber is.
 *
 *   node tools/scratch/tiber-ancient.mjs
 */
import sharp from 'sharp';
import fs from 'node:fs';
import { surveyToPx, M_PER_PX, worldOf } from './tiber-plate.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const LANC = 'reference/rome-plans/lanciani-georef-EPSG3004-2307658_4638583_2314671_4643263-4096px.png';
const CORRIDOR = Number(arg('corridor', 230));
const BR_MIN = Number(arg('br', 3));
const LUM_MIN = Number(arg('lum', 150));
const STEP_M = Number(arg('step', 12));

const { data, info } = await sharp(LANC).raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, C = info.channels;
/** 1 = Lanciani's channel tint, 0 = not, -1 = off the plate. */
const blueAt = (px, py) => {
  const x = Math.round(px), y = Math.round(py);
  if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return -1;
  let r = 0, g = 0, b = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const i = ((y + dy) * W + x + dx) * C; r += data[i]; g += data[i + 1]; b += data[i + 2];
  }
  r /= 9; g /= 9; b /= 9;
  const lum = (r + g + b) / 3;
  return (b - r >= BR_MIN && g >= r - 2 && lum >= LUM_MIN && lum <= 245) ? 1 : 0;
};

const course = JSON.parse(fs.readFileSync('tools/scratch/tiber-course.json', 'utf8')).course.map(([e, n]) => ({ e, n }));
if (course[0].n < course[course.length - 1].n) course.reverse();
const resample = (poly, step) => {
  const out = [poly[0]]; let carry = 0;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1];
    const L = Math.hypot(b.e - a.e, b.n - a.n);
    if (L < 1e-9) continue;
    let t = step - carry;
    while (t <= L) { out.push({ e: a.e + (b.e - a.e) * (t / L), n: a.n + (b.n - a.n) * (t / L) }); t += step; }
    carry = L - (t - step);
  }
  out.push(poly[poly.length - 1]);
  return out;
};
const line = resample(course, STEP_M);
const tangentAt = (i) => {
  const a = line[Math.max(0, i - 3)], b = line[Math.min(line.length - 1, i + 3)];
  const de = b.e - a.e, dn = b.n - a.n, L = Math.hypot(de, dn) || 1;
  return [de / L, dn / L];
};

const rows = [];
let off = 0;
for (let i = 0; i < line.length; i++) {
  const [te, tn] = tangentAt(i);
  const pe = -tn, pn = te;
  const N = Math.round(CORRIDOR / M_PER_PX);
  /**
   * The **outer** edge of Lanciani's channel tint on this side, not the nearest blue pixel.
   *
   * The plate is a mosaic of forty-six sheets and they are not inked alike: on some the Tiber is
   * a filled pale-blue band, on others two blue bank lines with the water left as paper. A
   * "nearest blue" rule reads the first kind correctly and the second kind's *near* bank, which
   * is why the first attempt put the east bank inside the channel for a third of the course. So
   * walk outward and keep the farthest blue that is still part of the same feature: a first blue
   * may appear up to 120 m out (paper interior), and after that a gap of more than 13 px (22 m)
   * ends the channel. Sheet seams are white paper and are covered by the same gap allowance.
   */
  const find = (dir) => {
    let lastBlue = null;
    for (let k = 2; k <= N; k++) {
      const t = dir * k;
      const p = surveyToPx(line[i].e + pe * t * M_PER_PX, line[i].n + pn * t * M_PER_PX);
      const v = blueAt(p.px, p.py);
      if (v < 0) return lastBlue === null ? null : lastBlue * M_PER_PX;
      if (v === 1) {
        if (lastBlue === null) { if (k * M_PER_PX > 120) break; lastBlue = k; }
        else if (k - lastBlue <= 13) lastBlue = k;
        else break;
      }
    }
    return lastBlue === null ? null : lastBlue * M_PER_PX;
  };
  const a = find(+1), b = find(-1);
  if (a === null && b === null) { off++; continue; }
  if (a === null || b === null) continue;
  rows.push({
    e: +line[i].e.toFixed(2), n: +line[i].n.toFixed(2),
    left: +a.toFixed(1), right: +b.toFixed(1), width: +(a + b).toFixed(1),
    le: +(line[i].e + pe * a).toFixed(2), ln: +(line[i].n + pn * a).toFixed(2),
    re: +(line[i].e - pe * b).toFixed(2), rn: +(line[i].n - pn * b).toFixed(2),
  });
}
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
const widths = rows.map((r) => r.width).sort((x, y) => x - y);
console.error(`${rows.length} stations with both ancient banks found (${off} off plate, ${line.length} total)`);
console.error(`ancient channel width off Lanciani: p10 ${q(widths, 0.1).toFixed(0)}  median ${q(widths, 0.5).toFixed(0)}`
  + `  p90 ${q(widths, 0.9).toFixed(0)}  min ${widths[0].toFixed(0)}  max ${widths[widths.length - 1].toFixed(0)} m`);
const nn = rows.map((r) => r.n);
console.error(`n ${Math.min(...nn).toFixed(0)} .. ${Math.max(...nn).toFixed(0)}  -> world z ${worldOf(0, Math.max(...nn)).z.toFixed(0)} .. ${worldOf(0, Math.min(...nn)).z.toFixed(0)}`);

fs.writeFileSync('tools/scratch/tiber-ancient.json', JSON.stringify({
  source: LANC, corridorM: CORRIDOR, brMin: BR_MIN, lumMin: LUM_MIN, stepM: STEP_M,
  widthM: { p10: +q(widths, 0.1).toFixed(1), median: +q(widths, 0.5).toFixed(1), p90: +q(widths, 0.9).toFixed(1) },
  rows,
}, null, 1));
console.error('wrote tools/scratch/tiber-ancient.json');
