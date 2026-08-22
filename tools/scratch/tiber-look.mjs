#!/usr/bin/env node
/**
 * Draw whatever the Tiber scripts have produced onto whichever plate is asked for, and crop.
 * `--layer=course|banks|both`, `--plate=ortho|lanciani`, `--px/--py/--pw/--ph`, `--out`, `--w`.
 */
import sharp from 'sharp';
import fs from 'node:fs';
import { surveyToPx } from './tiber-plate.mjs';
import { loadVirtual } from './tiber-raster.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PLATE = arg('plate', 'ortho');
const LAYER = arg('layer', 'course');
const PX = Number(arg('px', 0)), PY = Number(arg('py', -4095));
const PW = Number(arg('pw', 4096)), PH = Number(arg('ph', 6829));
const OUTW = Number(arg('w', 900));
const OUT = arg('out', 'screenshots/tiber/look.png');

const LANC = 'reference/rome-plans/lanciani-georef-EPSG3004-2307658_4638583_2314671_4643263-4096px.png';
let sampler;
if (PLATE === 'lanciani') {
  const { data, info } = await sharp(LANC).raw().toBuffer({ resolveWithObject: true });
  sampler = (px, py) => {
    const x = Math.round(px), y = Math.round(py);
    if (x < 0 || y < 0 || x >= info.width || y >= info.height) return [246, 242, 230];
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
} else {
  const V = await loadVirtual();
  sampler = (px, py) => V.rgbAt(px, py) ?? [24, 24, 24];
}

const rgb = Buffer.alloc(PW * PH * 3, 24);
for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
  const c = sampler(PX + x, PY + y);
  const o = (y * PW + x) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
}
const dot = (e, n, col, rad = 1) => {
  const p = surveyToPx(e, n);
  const x0 = Math.round(p.px) - PX, y0 = Math.round(p.py) - PY;
  for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
    const x = x0 + dx, y = y0 + dy;
    if (x < 0 || y < 0 || x >= PW || y >= PH) continue;
    const o = (y * PW + x) * 3; rgb[o] = col[0]; rgb[o + 1] = col[1]; rgb[o + 2] = col[2];
  }
};
if (LAYER === 'course' || LAYER === 'both') {
  const C = JSON.parse(fs.readFileSync('tools/scratch/tiber-course.json', 'utf8'));
  for (const [e, n] of C.course) dot(e, n, [255, 40, 40], 1);
}
if (LAYER === 'ancient' || LAYER === 'both') {
  const A = JSON.parse(fs.readFileSync('tools/scratch/tiber-ancient.json', 'utf8'));
  for (const r of A.rows) { dot(r.le, r.ln, [255, 140, 0], 1); dot(r.re, r.rn, [0, 200, 60], 1); }
}
if (LAYER === 'banks' || LAYER === 'both') {
  const D = JSON.parse(fs.readFileSync('tools/scratch/tiber-digitised.json', 'utf8'));
  for (const s of D.stations) {
    dot(s.we, s.wn, [255, 235, 40], 1);
    dot(s.ee, s.en, [40, 220, 255], 1);
  }
  for (const il of D.islands ?? []) for (const p of il.ring) dot(p[0], p[1], [255, 0, 255], 1);
}
await sharp(rgb, { raw: { width: PW, height: PH, channels: 3 } }).resize(OUTW).png().toFile(OUT);
console.log(`wrote ${OUT}`);
