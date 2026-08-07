// Is R measuring the model, or the reference pool's upscale?
//
// The rebuilt reference crops are cut at 285x380 to 570x760 native and lanczos-upscaled to
// 900x1200 (1.58x to 3.16x). Ours are shot at 1800x2400 and downsampled by 2. That is a 3-6x
// relative resolution difference between the pools. This puts OUR OWN plate through the
// REFERENCE's chain and asks where R lands. The model does not change; only the resampling.
//
// NOTE: chaining two .resize() calls on one sharp pipeline REPLACES the first. The first
// version of this file did exactly that and printed four bit-identical rows for four
// different rungs -- a number that cannot be true given its neighbour. Round-trip a buffer.
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const src = process.argv[2];
const out = '/tmp/r3-resample';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const [name, h] of [['a-native', 2400], ['b-up1.58x', 760], ['c-up2.37x', 506], ['d-up3.16x', 380]]) {
  const w = Math.round(h * 0.75);
  const small = await sharp(src).resize(w, h, { kernel: 'lanczos3' }).png().toBuffer();
  await sharp(small).resize(900, 1200, { kernel: 'lanczos3' }).png().toFile(`${out}/${name}.png`);
}
fs.writeFileSync(`${out}/report.json`, JSON.stringify({ tool: 'r3-resample', hud: false, commit: 'n/a', dpr: 2 }));
console.log(execFileSync('node', ['tools/probe-octave.mjs', `--ours=${out}`], { encoding: 'utf8' }).split('\n').slice(6, 12).join('\n'));
