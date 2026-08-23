/**
 * shep-grid — crop a window of a reference plate at native resolution with a PIXEL grid
 * drawn on it, so control points can be read off by eye to a few pixels.
 *
 * Scratch instrument for the Rome road survey (`docs/ROME-FABRIC.md` §4.2). The Shepherd
 * 1923 plate is the only plate in the pool that NAMES the streets, and it is not
 * georeferenced; this is how its control points get read.
 *
 *   node tools/scratch/shep-grid.mjs --x0=600 --y0=200 --w=800 --h=600 --grid=50 --out=/tmp/a.png
 */
import sharp from 'sharp';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const h = argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.slice(k.length + 3) : d;
};
const ROOT = resolve(import.meta.dirname, '../..');
const PLATES = {
  shep: 'reference/rome-plans/shepherd-1923-plan-of-imperial-rome-350ad-2826px.jpg',
  coldeel: 'reference/rome-plans/coldeel-2006-rome-14-regions-and-roads-1128px.png',
  kiepert: 'reference/rome-plans/kiepert-eb1911-plan-of-ancient-rome-2430px.jpg',
  lanciani: 'reference/rome-plans/lanciani-georef-EPSG3004-2307658_4638583_2314671_4643263-4096px.png',
  agea: 'reference/rome-plans/agea-2012-ortofoto-EPSG3004-2307658_4638583_2314671_4643263-4096px.jpg',
};
const file = resolve(ROOT, PLATES[arg('plate', 'shep')] ?? arg('plate'));
const src = sharp(file, { limitInputPixels: false });
const meta = await src.metadata();
const x0 = +arg('x0', '0');
const y0 = +arg('y0', '0');
const w = Math.min(+arg('w', String(meta.width)), meta.width - x0);
const h = Math.min(+arg('h', String(meta.height)), meta.height - y0);
const zoom = +arg('zoom', '1');
const G = +arg('grid', '100');
const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * zoom)}" height="${Math.round(h * zoom)}">`];
for (let x = Math.ceil(x0 / G) * G; x <= x0 + w; x += G) {
  const px = (x - x0) * zoom;
  parts.push(`<line x1="${px}" y1="0" x2="${px}" y2="${h * zoom}" stroke="#f0f" stroke-width="0.8" stroke-opacity="0.7" stroke-dasharray="6 6"/>`);
  parts.push(`<text x="${px + 3}" y="14" fill="#c0c" font-size="13" font-family="Helvetica" font-weight="bold" paint-order="stroke" stroke="#fff" stroke-width="3">${x}</text>`);
}
for (let y = Math.ceil(y0 / G) * G; y <= y0 + h; y += G) {
  const py = (y - y0) * zoom;
  parts.push(`<line x1="0" y1="${py}" x2="${w * zoom}" y2="${py}" stroke="#f0f" stroke-width="0.8" stroke-opacity="0.7" stroke-dasharray="6 6"/>`);
  parts.push(`<text x="3" y="${py - 3}" fill="#c0c" font-size="13" font-family="Helvetica" font-weight="bold" paint-order="stroke" stroke="#fff" stroke-width="3">${y}</text>`);
}
parts.push('</svg>');
const out = resolve(ROOT, arg('out', '/tmp/rr/shep-grid.png'));
mkdirSync(dirname(out), { recursive: true });
let img = src.extract({ left: x0, top: y0, width: w, height: h });
if (zoom !== 1) img = img.resize(Math.round(w * zoom), Math.round(h * zoom), { kernel: 'lanczos3' });
await img.composite([{ input: Buffer.from(parts.join('\n')) }]).png().toFile(out);
console.log(
  `wrote ${out}  ${Math.round(w * zoom)}x${Math.round(h * zoom)} of ${meta.width}x${meta.height}`
  + `  window px ${x0}..${x0 + w} , ${y0}..${y0 + h}`
);
