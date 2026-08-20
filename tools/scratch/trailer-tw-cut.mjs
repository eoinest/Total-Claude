/**
 * trailer-tw-cut.mjs — a twenty-two second cut of the trailer, for a muted phone feed.
 *
 * Nothing is re-simulated and nothing is re-captured. The master is the 3,000-frame
 * 1920x1080 JPEG sequence at `/tmp/tc-trailer-frames` and the thirteen per-beat mixer
 * recordings at `/tmp/tc-sound/beats`, both from `6698e196ed84f0e456b13cf1ab04c90eeea07d55`;
 * this only chooses windows into them and rebuilds the sound to match.
 *
 * Why the windows are what they are is a measurement, not a taste: every candidate beat was
 * downscaled to 400 px — a video in a phone feed is about that wide — and looked at
 * (`trailer-tw-scout.mjs`). Two results decided the cut.
 *
 *  - **The scale shot does not survive.** `field-scale` is 8,144 men from the flank at 90 m
 *    and it is the most impressive frame in the film on a desktop. At 400 px it is a hazy
 *    green patchwork with grey smudges on it and the smudges do not read as men. It is out,
 *    despite being the obvious cold open.
 *  - **`field-line` is the mass shot that does read.** A dense band of shields and helmets
 *    across the frame at 2.5 m eye height, hard cross-lit at 08:12, with its own caption
 *    already burned in. It opens the film — but it only holds for about 1.4 s, because the
 *    beat tracks along the line and the line is only in the near field for that long.
 *
 * The other constraint is editorial and comes from the owner: **the ram is one take.** Beats
 * 12 and 13 of the released silent cut were rejoined into a single sixteen-second push and
 * that join must not come back. Trimming the head of a take is not a cut inside it, so the
 * window is contiguous — one `[from, to]` into `rome-ram-gate`, asserted below — and it ends
 * after the leaves give way, never across it.
 *
 * The picture's fades are burned into the master frames, so the windows are chosen around
 * them rather than over them: every window clears its beat's fade-up and stops short of its
 * fade-out, except `endcard`, which runs to 209 precisely so that it keeps its fade to black.
 * There is no fade *up* at the head: a feed video autoplays muted and one that opens on black
 * has already lost. The sound is given the same curve, recomputed from the same formula
 * `trailer-mixdown.mjs` uses, so the track goes down with the picture at the end.
 *
 *   node tools/scratch/trailer-tw-cut.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const FRAMES = args.get('frames') ?? '/tmp/tc-trailer-frames/frames';
const BEATAUDIO = args.get('beataudio') ?? '/tmp/tc-sound/beats';
const WORK = args.get('work') ?? '/tmp/tc-tw';
const FPS = 30;
const RATE = 48000;
const CH = 2;
/** A 3 ms ramp across every hard cut. Below audibility, and no clicks. Same as the 86 s mix. */
const DECLICK = Math.round(0.003 * RATE);
const easeOut = (u) => 1 - (1 - u) * (1 - u);

/**
 * The cut. `src` is [first, last] inclusive into the beat's own frame numbering, `len` is the
 * beat's full length in the master (needed to recompute the burned-in fade the sound has to
 * match), and `why` is the reason the window is where it is.
 */
export const SHOTS = [
  { id: 'field-line', len: 150, src: [60, 101], one: false,
    why: 'Mass, and the only beat that is unambiguous at 400 px. It is short because the beat '
       + 'tracks *along* the line: frames 0-23 are the burned fade-up, 24-55 are empty grass '
       + 'ahead of the line, 60-85 is the army filling the frame, and by 100 it has receded to '
       + 'a dusty band. 1.4 s is what the shot actually has, so 1.4 s is what it gets — and '
       + 'frame 60 is the thumbnail a feed will freeze on.' },
  { id: 'field-clash', len: 210, src: [100, 177], one: false,
    why: 'The lines are already in contact by frame 80; this is the melee with the dust band '
       + 'along it and the camera still closing. Two dark hosts and a bright seam: it reads '
       + 'small because it is three big shapes, not because of any detail in it.' },
  { id: 'siege-ladders', len: 180, src: [104, 179], one: false,
    why: 'The wall, wide. Horizontal masonry, diagonal ladders, the garrison as a dark line on '
       + 'the parapet and the assault massed at the foot — the most legible geometry in the '
       + 'film after the arch. Late in the beat, where the crowd at the foot is thickest.' },
  { id: 'siege-parapet', len: 150, src: [44, 115], one: false,
    why: 'The wall, close, at the height of the crest: the same escalade one step further on, '
       + 'with the garrison massed in the embrasures. Ends at 115 because 141-149 are a burned '
       + 'fade to black — the act boundary of the 86 s cut, which this cut does not have.' },
  { id: 'rome-ram-gate', len: 480, src: [206, 425], one: true,
    why: 'ONE TAKE, contiguous, no join. It cuts in *on* a ram blow: the shed hide fills the '
       + 'lens until frame 152, a blow lands at 212-231 so entering at 206 puts the shake 0.2 s '
       + 'after the cut, the leaves give way at 353-369 (measured: mean |dluma| in the gate '
       + 'mouth goes 1.06 -> 6.54, and the pale leaf panel is present at frame 352 and gone at '
       + '362), and it holds 1.9 s past that. Ending before 480 trims the take; it does not cut '
       + 'inside it.' },
  { id: 'rome-arch', len: 180, src: [100, 179], one: false,
    why: 'The consequence, and the shot that makes the payoff legible at phone size: the arch '
       + 'is a black void in a warm brick wall with a packed cohort and a red standard in '
       + 'front of it. The break itself is a small dark change in a dark arch; this is what '
       + 'tells a 400 px viewer the gate is open.' },
  { id: 'endcard', len: 210, src: [120, 209], one: false,
    why: 'Title and URL already at full opacity at 120, so no dead time, and it keeps the '
       + 'burned fade to black over the last 21 frames.' },
];

/** The black-plane opacity the capture photographed through, for frame `i` of a full beat. */
function pictureFade(id, i, total, isFirstInMaster) {
  let fade = 0;
  if (id === 'endcard') {
    const uu = total <= 1 ? 0 : i / (total - 1);
    fade = Math.max(0, (uu - 0.9) / 0.1);
  }
  const fadeIn = isFirstInMaster ? 24 : (id === 'carth-wall' || id === 'rome-ram-gate' ? 9 : 0);
  if (fadeIn && i < fadeIn) fade = Math.max(fade, 1 - easeOut(i / (fadeIn - 1)));
  if (id === 'siege-parapet' || id === 'carth-tower') {
    if (i >= total - 9) fade = Math.max(fade, easeOut((i - (total - 9)) / 8));
  }
  return Math.min(1, Math.max(0, fade));
}

const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / (a.length || 1)); };
const peak = (a) => { let m = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; } return m; };
const dbfs = (v) => (v > 0 ? +(20 * Math.log10(v)).toFixed(1) : -999);

await mkdir(WORK, { recursive: true });

// ---- picture ---------------------------------------------------------------
const list = [];
const bounds = [];
const keyAt = [];                          // force a keyframe on the first frame of every shot
let cursor = 0;
for (const s of SHOTS) {
  const [a, b] = s.src;
  if (b < a) throw new Error(`${s.id}: window runs backwards`);
  if (b >= s.len) throw new Error(`${s.id}: frame ${b} past the end of the beat (${s.len})`);
  /*
   * The one-take assertion. A contiguous [a, b] cannot contain a cut; the failure mode this
   * guards against is someone later "tightening" the ram by listing two windows for it.
   */
  if (s.one && list.some((p) => p.includes(`/${s.id}-`))) {
    throw new Error(`${s.id} is marked one-take and already appears in the cut — that is a join`);
  }
  keyAt.push(cursor);
  for (let i = a; i <= b; i++) list.push(path.join(FRAMES, `${s.id}-${String(i).padStart(4, '0')}.jpg`));
  const n = b - a + 1;
  bounds.push({ id: s.id, src: s.src, frames: n,
    in: +(cursor / FPS).toFixed(3), out: +((cursor + n) / FPS).toFixed(3), why: s.why });
  cursor += n;
}
const N = cursor;

// ---- sound -----------------------------------------------------------------
const totalSamples = Math.round((N / FPS) * RATE);
const mix = new Float32Array(totalSamples * CH);
let sCursor = 0;
for (let k = 0; k < SHOTS.length; k++) {
  const s = SHOTS[k];
  const raw = await readFile(path.join(BEATAUDIO, `${s.id}.f32`));
  const src = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const have = src.length / CH;
  const want = Math.round((s.len / FPS) * RATE);
  if (have !== want) console.warn(`  ! ${s.id}: recording is ${have} samples, beat is ${want}`);
  const from = Math.round((s.src[0] / FPS) * RATE);
  const n = Math.round(((s.src[1] - s.src[0] + 1) / FPS) * RATE);

  /*
   * Per-frame picture gain, interpolated between frames so nothing steps — the same thing
   * `trailer-mixdown.mjs` does, recomputed here for the *source* frame index, because that is
   * where the burned fade lives. Only `endcard` has one inside a window; every other window
   * was chosen to miss them.
   */
  const g = new Float64Array(s.len + 1);
  for (let i = 0; i < s.len; i++) g[i] = 1 - pictureFade(s.id, i, s.len, s.id === 'field-line');
  g[s.len] = g[s.len - 1];

  const rawSlice = src.subarray(from * CH, (from + n) * CH);
  for (let j = 0; j < n; j++) {
    const fi = ((from + j) * FPS) / RATE;
    const i0 = Math.min(s.len, Math.floor(fi));
    const gain = g[i0] + (g[Math.min(s.len, i0 + 1)] - g[i0]) * (fi - i0);
    const dc = Math.min(1, Math.min(j + 1, n - j) / DECLICK);
    const kk = gain * dc;
    mix[(sCursor + j) * CH] = (src[(from + j) * CH] ?? 0) * kk;
    mix[(sCursor + j) * CH + 1] = (src[(from + j) * CH + 1] ?? 0) * kk;
  }
  const outSlice = mix.subarray(sCursor * CH, (sCursor + n) * CH);
  Object.assign(bounds[k], {
    rawRms: +rms(rawSlice).toFixed(6), rawRmsDbfs: dbfs(rms(rawSlice)),
    rawPeak: +peak(rawSlice).toFixed(4),
    cutRms: +rms(outSlice).toFixed(6), cutRmsDbfs: dbfs(rms(outSlice)),
    cutPeak: +peak(outSlice).toFixed(4),
  });
  sCursor += n;
}
if (sCursor !== totalSamples) console.warn(`  ! sound is ${sCursor} samples, picture wants ${totalSamples}`);

await writeFile(path.join(WORK, 'cut-tw.json'), JSON.stringify(list));
await writeFile(path.join(WORK, 'mix-tw.f32'), Buffer.from(mix.buffer));
const allR = rms(mix), allP = peak(mix);
const meta = { fps: FPS, rate: RATE, frames: N, seconds: +(N / FPS).toFixed(3),
  keyframesAt: keyAt, rms: +allR.toFixed(6), rmsDbfs: dbfs(allR), peak: +allP.toFixed(4),
  peakDbfs: dbfs(allP), shots: bounds };
await writeFile(path.join(WORK, 'cut-tw.meta.json'), JSON.stringify(meta, null, 1));

console.log(`${SHOTS.length} shots  ${N} frames  ${(N / FPS).toFixed(2)} s  `
  + `${totalSamples} samples/ch @ ${RATE} Hz\n`);
console.log('shot             src frames      n     in     out   raw RMS   dBFS   cut RMS   dBFS');
for (const b of bounds) {
  console.log(`${b.id.padEnd(15)} ${String(b.src[0]).padStart(4)}-${String(b.src[1]).padEnd(4)} `
    + `${String(b.frames).padStart(6)} ${b.in.toFixed(2).padStart(6)} ${b.out.toFixed(2).padStart(7)}  `
    + `${b.rawRms.toFixed(5)}  ${String(b.rawRmsDbfs).padStart(6)}  ${b.cutRms.toFixed(5)}  `
    + `${String(b.cutRmsDbfs).padStart(6)}`);
}
console.log(`\nwhole track  rms ${allR.toFixed(5)} (${dbfs(allR)} dBFS)  peak ${allP.toFixed(4)} (${dbfs(allP)} dBFS)`);
if (allR === 0) throw new Error('the whole track is silent');
if (allP >= 0.999) console.warn('! the track touches full scale');
console.log(`keyframes forced at frames ${keyAt.join(', ')} (every cut)`);
console.log(`\n-> ${path.join(WORK, 'cut-tw.json')}  ${N} frames`);
console.log(`-> ${path.join(WORK, 'mix-tw.f32')}  ${(mix.byteLength / 1e6).toFixed(1)} MB raw f32 stereo`);
