/**
 * trailer-mixdown.mjs — thirteen recorded beats into one 86-second track, cut to the picture.
 *
 * The picture's fades are burned into the frames: `trailer-recut.mjs` draws a black DOM plane
 * over the canvas and photographs through it, so the trailer opens out of black over 0.8 s,
 * dips 0.6 s at each act boundary and fades out over the last 0.7 s. This applies the
 * *identical* curve to the sound — same `easeOut`, same frame counts, read off the same beat
 * table — so the track goes down exactly as the picture does and comes back with it.
 *
 * Nothing else is done to the audio. No music is added (the score in it is the game's own
 * adaptive one, recorded live off the mixer), no sample is added, no beat is level-matched,
 * no compression, no EQ. Where the game's mix is thin, the track is thin, and the report
 * says which beats those are.
 *
 *   node tools/scratch/trailer-mixdown.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BEATS, FPS, easeOut } from './trailer-shot.mjs';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const WORK = args.get('work') ?? '/tmp/tc-sound';
const RATE = Number(args.get('rate') ?? 48000);
const OUT = args.get('out') ?? path.join(WORK, 'mix.f32');
/** A 3 ms ramp across every hard cut. Below any threshold of audibility, and no clicks. */
const DECLICK = Math.round(0.003 * RATE);

/** The picture's black-plane opacity for frame `i` of a beat — copied from `trailer-recut.mjs`. */
function pictureFade(beat, i, total, first) {
  let fade = 0;
  if (beat.endcard) {
    const uu = total <= 1 ? 0 : i / (total - 1);
    fade = Math.max(0, (uu - 0.9) / 0.1);
  }
  const fadeIn = beat === first ? 24 : (beat.fadeIn ?? 0);
  if (fadeIn && i < fadeIn) fade = Math.max(fade, 1 - easeOut(i / (fadeIn - 1)));
  if (beat.fadeOut && i >= total - beat.fadeOut) {
    fade = Math.max(fade, easeOut((i - (total - beat.fadeOut)) / (beat.fadeOut - 1)));
  }
  return Math.min(1, Math.max(0, fade));
}

const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / (a.length || 1)); };
const peak = (a) => { let m = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; } return m; };
const dbfs = (v) => (v > 0 ? +(20 * Math.log10(v)).toFixed(1) : -999);

let totalFrames = 0;
for (const b of BEATS) totalFrames += Math.round((b.at[1] - b.at[0]) * FPS);
const totalSamples = Math.round((totalFrames / FPS) * RATE);
const mix = new Float32Array(totalSamples * 2);
console.log(`${BEATS.length} beats  ${totalFrames} frames  ${(totalFrames / FPS).toFixed(2)} s  `
  + `${totalSamples} samples/ch @ ${RATE} Hz`);

const rows = [];
let cursorFrames = 0;
for (const beat of BEATS) {
  const total = Math.round((beat.at[1] - beat.at[0]) * FPS);
  const file = path.join(WORK, 'beats', `${beat.id}.f32`);
  if (!existsSync(file)) throw new Error(`no recording for beat ${beat.id} (${file})`);
  const raw = await readFile(file);
  const src = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const need = Math.round((total / FPS) * RATE);
  if (src.length / 2 !== need) {
    console.warn(`  ! ${beat.id}: ${src.length / 2} samples, expected ${need} (padding/trimming)`);
  }
  const rawRms = rms(src), rawPeak = peak(src);

  // Per-frame picture gain, then linear interpolation between frames so nothing steps.
  const g = new Float64Array(total + 1);
  for (let i = 0; i < total; i++) g[i] = 1 - pictureFade(beat, i, total, BEATS[0]);
  g[total] = g[total - 1];

  const off = Math.round((cursorFrames / FPS) * RATE);
  for (let s = 0; s < need; s++) {
    const fi = (s * FPS) / RATE;
    const i0 = Math.min(total, Math.floor(fi));
    const gain = g[i0] + (g[Math.min(total, i0 + 1)] - g[i0]) * (fi - i0);
    const dc = Math.min(1, Math.min(s + 1, need - s) / DECLICK);
    const k = gain * dc;
    const j = s * 2;
    mix[(off + s) * 2] = (src[j] ?? 0) * k;
    mix[(off + s) * 2 + 1] = (src[j + 1] ?? 0) * k;
  }
  const outSlice = mix.subarray(off * 2, (off + need) * 2);
  rows.push({ id: beat.id, in: +(cursorFrames / FPS).toFixed(2), out: +((cursorFrames + total) / FPS).toFixed(2),
    frames: total, rawRms: +rawRms.toFixed(6), rawRmsDbfs: dbfs(rawRms),
    rawPeak: +rawPeak.toFixed(4), rawPeakDbfs: dbfs(rawPeak),
    cutRms: +rms(outSlice).toFixed(6), cutRmsDbfs: dbfs(rms(outSlice)),
    cutPeak: +peak(outSlice).toFixed(4),
    fade: (beat === BEATS[0] ? 'up 0.8 s' : beat.fadeIn ? 'in 0.3 s' : '')
      + (beat.fadeOut ? (beat === BEATS[0] || beat.fadeIn ? ' / ' : '') + 'out 0.3 s' : '')
      + (beat.endcard ? 'out 0.7 s' : '') });
  cursorFrames += total;
}

await writeFile(OUT, Buffer.from(mix.buffer));
const allR = rms(mix), allP = peak(mix);
console.log('\nbeat              in     out    raw RMS   dBFS   raw pk   cut RMS   dBFS   fade');
for (const r of rows) {
  console.log(`${r.id.padEnd(16)} ${String(r.in).padStart(6)} ${String(r.out).padStart(6)}  `
    + `${r.rawRms.toFixed(5)}  ${String(r.rawRmsDbfs).padStart(6)}  ${r.rawPeak.toFixed(3)}   `
    + `${r.cutRms.toFixed(5)}  ${String(r.cutRmsDbfs).padStart(6)}  ${r.fade}`);
}
console.log(`\nwhole track  rms ${allR.toFixed(5)} (${dbfs(allR)} dBFS)  peak ${allP.toFixed(4)} (${dbfs(allP)} dBFS)`);
if (allP >= 0.999) console.warn('! the track touches full scale — the mixer\'s soft clip is being hit');
if (allR === 0) throw new Error('the whole track is silent');
await writeFile(path.join(WORK, 'mixdown.json'), JSON.stringify({ rate: RATE, totalFrames,
  seconds: +(totalFrames / FPS).toFixed(2), rms: +allR.toFixed(6), peak: +allP.toFixed(4),
  beats: rows }, null, 1));
console.log(`\n→ ${OUT}  ${(mix.byteLength / 1e6).toFixed(1)} MB raw f32 stereo`);
