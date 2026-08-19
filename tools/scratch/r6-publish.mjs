// Resize and encode the r6 release plates.
//
// `docs/RELEASING.md` §4a: JPEG, about 1000-1500 px on the long edge, 60-180 KB a frame,
// `sharp` at quality ~74 with mozjpeg. A single (width, quality) pair does not hit that band
// for every subject — a dark gate frame encodes at a third of the size of a field of shields
// — so each plate is tried down a short ladder and the first result inside the band wins,
// largest first. Whatever each file lands on is printed, because "about 74" is a starting
// point and the band is the actual rule.
import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
if (!OUT) throw new Error('--out=DIR required');
await mkdir(OUT, { recursive: true });

/** [source, published name] */
const PLATES = JSON.parse(await readFile(process.argv.find((a) => a.startsWith('--list='))?.slice(7), 'utf8'));

// 1280 px is what the existing set is: `r5-postern-cut.jpg` is 1280x720 at 108 KB and
// `r3-deployment.jpg` is 1280x720 at 84 KB, so the published house size is 1100-1280 rather
// than the top of the 1000-1500 range the procedure quotes.
const LADDER = [[1280, 74], [1280, 70], [1200, 70], [1100, 68], [1000, 66]];
const MIN = 60 * 1024, MAX = 180 * 1024;

for (const [src, name] of PLATES) {
  const meta = await sharp(src).metadata();
  const long = Math.max(meta.width, meta.height);
  let chosen = null;
  for (const [w, q] of LADDER) {
    // Never upscale: a 1080 px crop stays 1080 px.
    const width = Math.min(w, long);
    const buf = await sharp(src)
      .resize(meta.width >= meta.height ? { width } : { height: width })
      .jpeg({ quality: q, mozjpeg: true })
      .toBuffer();
    chosen = { buf, w: width, q };
    if (buf.length <= MAX) break;
  }
  await writeFile(path.join(OUT, name), chosen.buf);
  const kb = (chosen.buf.length / 1024).toFixed(0);
  const flag = chosen.buf.length < MIN ? '  (under 60 KB)'
    : chosen.buf.length > MAX ? '  *** OVER 180 KB ***' : '';
  const out = await sharp(path.join(OUT, name)).metadata();
  console.log(`${name.padEnd(34)} ${out.width}x${out.height}  q${chosen.q}  ${kb} KB${flag}`);
}
