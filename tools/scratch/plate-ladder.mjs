/**
 * Throwaway: what each rung of a rendition ladder costs, and what it buys.
 *
 * The brief for this pass carries a warning taken from a prior measurement — these frames are
 * grass and mail, so they are high-frequency everywhere and WebP's quality knob barely moves
 * them (q58 to q76 was 181 kB to 245 kB at 1440). The conclusion drawn from that was *density
 * is the lever, not quality*, and this is the instrument that checks it rather than repeating
 * it.
 *
 * For one target — the number of **device** pixels the backdrop is actually painted across on
 * the machine being argued about — it builds the reference the display could show if it had
 * every pixel, then asks of each candidate rendition: how many bytes, and how much of the
 * reference's detail survives being upscaled back to that size.
 *
 *   reference    the 5,120 px capture resized to the painted width. This is the ceiling.
 *   candidate    the rendition at width W, encoded, decoded, and resized up to the same
 *                painted width the way a browser would.
 *   rmse         per-channel root mean square error against the reference, 0-255.
 *   detail       gradient energy as a fraction of the reference's. 1.00 is "as sharp as the
 *                display could ever show"; 0.50 is "half the acutance is gone".
 *
 * `detail` is the number that matters and `rmse` is the one that is easy to fool: a blurred
 * image has low gradient energy and can still have a respectable RMSE, which is exactly the
 * failure mode of judging resampling by error alone.
 *
 *   node tools/scratch/plate-ladder.mjs --src=screenshots/press-hi --painted=4851
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const SRC = path.resolve(ROOT, args.get('src') ?? 'screenshots/press-hi');
/** 4,851 is the front door on a 16-inch MacBook Pro at 2x, measured by menu-density.mjs. */
const PAINTED = Number(args.get('painted') ?? 4851);
const WIDTHS = (args.get('widths') ?? '960,1440,1920,2560,3200,3840')
  .split(',').map(Number);
const QUALITIES = (args.get('q') ?? '76').split(',').map(Number);
const FORMATS = (args.get('formats') ?? 'webp,avif').split(',');

/**
 * Gradient energy: the mean absolute first difference along both axes, on luma.
 *
 * Deliberately the crudest possible acutance measure rather than an SSIM, because the claim
 * being tested is coarse — "this rendition is soft" — and a crude measure that is obviously
 * what it says it is beats a composite nobody can check by eye.
 */
const detailOf = async (buf, w) => {
  const h = Math.round((w * 9) / 16);
  const { data } = await sharp(buf).resize(w, h, { fit: 'fill' }).greyscale().raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  let n = 0;
  for (let y = 1; y < h; y += 1) {
    for (let x = 1; x < w; x += 1) {
      const i = y * w + x;
      sum += Math.abs(data[i] - data[i - 1]) + Math.abs(data[i] - data[i - w]);
      n += 2;
    }
  }
  return sum / n;
};

const rmseOf = async (a, b, w) => {
  const h = Math.round((w * 9) / 16);
  const [pa, pb] = await Promise.all([a, b].map((buf) =>
    sharp(buf).resize(w, h, { fit: 'fill' }).greyscale().raw().toBuffer()));
  let acc = 0;
  for (let i = 0; i < pa.length; i += 1) { const d = pa[i] - pb[i]; acc += d * d; }
  return Math.sqrt(acc / pa.length);
};

const files = (await readdir(SRC)).filter((f) => f.endsWith('.png')).sort();
if (!files.length) { console.error(`no PNGs in ${SRC}`); process.exit(2); }

/** The size everything is compared at: a manageable slice of the painted width. */
const CMP = 1600;

console.log(`\n  source ${path.relative(ROOT, SRC)} — ${files.length} frame(s)`);
console.log(`  painted target ${PAINTED} device px (the 16-inch MacBook Pro front door)\n`);

const totals = new Map();
for (const f of files) {
  const src = path.join(SRC, f);
  const meta = await sharp(src).metadata();
  // What the display could show if the frame had every pixel it is painted across.
  const reference = await sharp(src)
    .resize(PAINTED, null, { kernel: 'lanczos3' }).png().toBuffer();
  const refDetail = await detailOf(reference, CMP);
  console.log(`  ${f}  (source ${meta.width}x${meta.height})`);
  console.log(`    ${'rendition'.padEnd(20)}${'bytes'.padStart(10)}${'rmse'.padStart(9)}`
    + `${'detail'.padStart(9)}   upscale`);
  for (const fmt of FORMATS) {
    for (const q of QUALITIES) {
      for (const w of WIDTHS) {
        if (w > meta.width) continue;
        const h = Math.round((w * meta.height) / meta.width);
        const pipe = sharp(src).resize(w, h, { fit: 'cover', withoutEnlargement: true });
        const enc = fmt === 'avif'
          ? await pipe.avif({ quality: q, effort: 5 }).toBuffer()
          : await pipe.webp({ quality: q, effort: 6 }).toBuffer();
        // What the browser puts on the glass: the rendition, back up to the painted width.
        const shown = await sharp(enc)
          .resize(PAINTED, null, { kernel: 'lanczos3' }).png().toBuffer();
        const d = await detailOf(shown, CMP);
        const e = await rmseOf(shown, reference, CMP);
        const label = `${fmt} q${q} ${w}w`;
        console.log(`    ${label.padEnd(20)}${(enc.length / 1024).toFixed(0).padStart(8)} kB`
          + `${e.toFixed(2).padStart(9)}${(d / refDetail).toFixed(3).padStart(9)}`
          + `   ${(PAINTED / w).toFixed(2)}x`);
        const k = label;
        totals.set(k, (totals.get(k) ?? 0) + enc.length);
      }
    }
  }
  console.log('');
}

console.log(`  whole set of ${files.length}, per rung:`);
for (const [k, v] of totals) {
  console.log(`    ${k.padEnd(20)}${(v / 1024 / 1024).toFixed(2).padStart(8)} MB`
    + `   ${(v / files.length / 1024).toFixed(0).padStart(5)} kB each`);
}
await stat(SRC);
console.log('');
