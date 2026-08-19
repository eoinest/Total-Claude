#!/usr/bin/env node
/**
 * cf-atlas — read the soldier atlas's own texels, per material tile.
 *
 * Everything else in this workstream measures a rendered plate, where a tile's contribution
 * is mixed with lighting, tone mapping and the sampler. This reads the sheet the bake
 * produced, so a claim about a *tile* ("6 % of the scale area is flat 255") can be checked
 * against the tile rather than against a photograph of it.
 *
 * It imports the shipped `src/units/atlas.ts` through the dev server, so it measures the
 * generator rather than a re-implementation.
 *
 *   node tools/scratch/cf-atlas.mjs --port=5417 --json=/tmp/x.json
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));
const PORT = Number(args.get('port') ?? 5417);
const BASE = `http://127.0.0.1:${PORT}`;

const alive = await fetch(`${BASE}/viewer.html`).then((r) => r.ok).catch(() => false);
if (!alive) { console.error(`No dev server on ${PORT}.`); process.exit(2); }

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });

const out = await page.evaluate(async () => {
  const m = await import('/src/units/atlas.ts');
  const a = m.buildSoldierAtlas(1);
  const TILE = 256, PER_ROW = 8, ROWS = 4;
  const W = m.ATLAS_W, H = m.ATLAS_H;
  const grab = (tex) => {
    const c = tex.image;
    const g = document.createElement('canvas');
    g.width = W; g.height = H;
    const cx = g.getContext('2d');
    cx.drawImage(c, 0, 0);
    return cx.getImageData(0, 0, W, H).data;
  };
  const alb = grab(a.albedo), nrm = grab(a.normal), orm = grab(a.orm);
  const names = ['IronWorn', 'IronPlate', 'Bronze', 'Mail', 'Scale', 'LeatherBrown', 'LeatherDark',
    'WoolCoarse', 'Linen', 'Skin', 'Hair', 'WoodPlank', 'Fur', 'Plume', 'Rope', 'Bands',
    'HideBay', 'HideGrey', 'HideBlack', 'SaddleLeather', 'Hoof', 'Mane', 'Bone', 'ClothFine',
    'ShieldBack', 'OakBeam', 'SinewCord', 'ElephantHide', 'Face'];
  const res = [];
  for (let id = 0; id < names.length; id++) {
    const col = id % PER_ROW, row = Math.floor(id / PER_ROW);
    if (row >= ROWS) break;
    const ox = col * TILE, oy = row * TILE;
    let albMax255 = 0, albAll255 = 0, aoMax = 0, ao255 = 0, rough255 = 0, rough0 = 0;
    let sumA = 0, sumA2 = 0, sumAO = 0, sumR = 0, sumNXY = 0, nxyMax = 0, nrmFlat = 0;
    const n = TILE * TILE;
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const o = ((oy + y) * W + ox + x) * 4;
      const r = alb[o], g = alb[o + 1], b = alb[o + 2];
      const mx = Math.max(r, g, b);
      if (mx >= 255) albMax255++;
      if (r >= 255 && g >= 255 && b >= 255) albAll255++;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sumA += l; sumA2 += l * l;
      const ao = orm[o], rg = orm[o + 1];
      if (ao >= 255) ao255++;
      if (ao > aoMax) aoMax = ao;
      if (rg >= 255) rough255++;
      if (rg <= 1) rough0++;
      sumAO += ao; sumR += rg;
      const nx = (nrm[o] - 128) / 127, ny = (nrm[o + 1] - 128) / 127;
      const xy = Math.hypot(nx, ny);
      sumNXY += xy; if (xy > nxyMax) nxyMax = xy;
      if (nrm[o] === 128 && nrm[o + 1] === 128) nrmFlat++;
    }
    const meanA = sumA / n;
    res.push({
      id, name: names[id],
      albMax255: (albMax255 / n) * 100,
      albAll255: (albAll255 / n) * 100,
      albMean: meanA,
      albStd: Math.sqrt(Math.max(0, sumA2 / n - meanA * meanA)),
      ao255: (ao255 / n) * 100, aoMean: sumAO / n,
      roughMean: sumR / n, rough255: (rough255 / n) * 100, rough0: (rough0 / n) * 100,
      nxyMean: sumNXY / n, nxyMax, nrmFlat: (nrmFlat / n) * 100,
    });
  }
  a.dispose();
  return { W, H, res };
});

await browser.close();
if (errs.length) { console.error('pageerror:', errs.slice(0, 5)); }

console.log(`cf-atlas — ${out.W}x${out.H} sheet, 256 px tiles\n`);
console.log('tile             alb255%  albAll%  albMean  albStd   ao255%  aoMean  rgMean  rg255%   |n.xy|  nxyMax  flatN%');
for (const r of out.res) {
  console.log(
    `${r.name.padEnd(15)} ${r.albMax255.toFixed(2).padStart(7)} ${r.albAll255.toFixed(2).padStart(8)}`
    + ` ${r.albMean.toFixed(1).padStart(8)} ${r.albStd.toFixed(1).padStart(7)}`
    + ` ${r.ao255.toFixed(2).padStart(8)} ${r.aoMean.toFixed(1).padStart(7)}`
    + ` ${r.roughMean.toFixed(1).padStart(7)} ${r.rough255.toFixed(2).padStart(7)}`
    + ` ${r.nxyMean.toFixed(3).padStart(8)} ${r.nxyMax.toFixed(3).padStart(7)} ${r.nrmFlat.toFixed(2).padStart(6)}`
  );
}
if (args.has('json')) writeFileSync(args.get('json'), `${JSON.stringify(out, null, 2)}\n`);
