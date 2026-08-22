#!/usr/bin/env node
/**
 * trailer2-cutmeta.mjs — turn the studio's `cut.json` into the meta the shipping encoders want.
 *
 * `trailer-mp4-encode.mjs` and `trailer-tw-encode.mjs` both take a `--meta` JSON whose only
 * load-bearing field is `keyframesAt`: the frame indices at which the encoder must force an
 * IDR. `tools/film.mjs` does not write one, because its own VP8 preview does not need it. This
 * derives it from the cut, which is an ordered list of frame paths named `<shot>-NNNNN.jpg`, by
 * putting a keyframe on every shot boundary.
 *
 * **Why every cut and not a fixed GOP.** A hard cut is the one place a P-frame cannot predict
 * anything: the reference is a different battle on a different map. Left to a 150-frame GOP,
 * the frame after a cut is the most expensive frame in the file and the codec pays for it by
 * starving the two seconds that follow — which in a montage whose mean shot is 2.6 s is most
 * of the film. Eleven forced keys cost a few tens of kilobytes and buy a clean first frame at
 * every cut, which is exactly where a viewer is looking.
 *
 *   node tools/scratch/trailer2-cutmeta.mjs /tmp/tc-video-studio/war-machine/cut.json out.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [cutPath, out] = process.argv.slice(2);
if (!cutPath || !out) {
  console.error('usage: trailer2-cutmeta.mjs <cut.json> <meta.json>');
  process.exit(2);
}
const cut = JSON.parse(await readFile(cutPath, 'utf8'));
const idOf = (p) => path.basename(p).replace(/-\d+\.jpg$/, '');
const keyAt = [];
const shots = [];
let last = null;
for (let i = 0; i < cut.length; i++) {
  const id = idOf(cut[i]);
  if (id !== last) { keyAt.push(i); shots.push({ id, from: i }); last = id; }
}
for (let i = 0; i < shots.length; i++) {
  const s = shots[i];
  s.to = (i + 1 < shots.length ? shots[i + 1].from : cut.length) - 1;
  s.frames = s.to - s.from + 1;
  s.in = +(s.from / 30).toFixed(4);
  s.out = +((s.to + 1) / 30).toFixed(4);
}
const meta = {
  fps: 30, rate: 48000, frames: cut.length, seconds: +(cut.length / 30).toFixed(3),
  keyframesAt: keyAt, shots,
};
await writeFile(out, JSON.stringify(meta, null, 1));
console.log(`${cut.length} frames, ${shots.length} shots, keyframes at ${keyAt.join(',')}`);
for (const s of shots) {
  console.log(`  ${s.id.padEnd(14)} ${String(s.frames).padStart(4)}f  `
    + `${s.in.toFixed(3)}..${s.out.toFixed(3)} s`);
}
console.log(`-> ${out}`);
