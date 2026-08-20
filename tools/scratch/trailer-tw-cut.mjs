/**
 * trailer-tw-cut.mjs — a twenty-one second cut of the trailer, for a muted phone feed.
 *
 * Nothing is re-simulated and nothing is re-captured. The master is the 3,000-frame
 * 1920x1080 JPEG sequence at `/tmp/tc-trailer-frames` and the thirteen per-beat mixer
 * recordings at `/tmp/tc-sound/beats`, both from `6698e196ed84f0e456b13cf1ab04c90eeea07d55`;
 * this only chooses windows into them and rebuilds the sound to match.
 *
 * This is the second edit. The first shipped seven beats and 21.933 s and the owner sent four
 * notes back: two escalade beats is one too many, he wants Carthage, he wants the elephants,
 * and cut `rome-arch`. All four are in here, and the two questions the notes left open — which
 * escalade beat survives, and what carries the ending once `rome-arch` is gone — were answered
 * with an instrument rather than with taste (`trailer-tw-legible.mjs`, which downscales to the
 * delivered 400 px and reports how much gradient energy survives the resample and how much the
 * picture moves between frames at that size).
 *
 *  - **The close escalade beat wins, not the wide one.** At 400 px `siege-parapet` beats
 *    `siege-ladders` on every axis the instrument has: gradient energy 10.86 vs 10.07, frame
 *    contrast 59.4 vs 32.0, inter-frame motion 3.22 vs 2.20. The wide shot is the better
 *    photograph and the worse thumbnail: it is one mid-brown wall against mid-green grass, and
 *    its ladders are two faint diagonals. The close one is hard sky against dark brick with a
 *    ladder full of men on it. It also puts the only Roman escalade *closer* than the Punic one
 *    that now precedes it, so the back half of the film pushes in the whole way.
 *  - **Carthage goes in the middle, as a block, hinged at both ends.** The previous pass cut
 *    Carthage on the grounds that a 146 BC white-sand map dropped into a Roman escalation is a
 *    non-sequitur, and that was right about *dropping* it in. So it is not dropped in: the film
 *    enters Carthage on `carth-eles`, which is a field beat with the same green-and-gold palette
 *    as the `field-clash` it cuts from, and leaves it on `carth-tower`, which is a wall being
 *    escaladed and cuts to a wall being escaladed. One boundary is motivated by palette and the
 *    other by subject, and neither is a jump. What the film then reads as is a sweep across the
 *    war that narrows into one gate: field, field, wall, wall, gate — with the palette walking
 *    green -> gold -> pale stone -> red brick -> shadow in the same direction.
 *
 * The other constraint is editorial and comes from the owner: **the ram is one take.** Beats
 * 12 and 13 of the released silent cut were rejoined into a single sixteen-second push and
 * that join must not come back. Trimming the head or the tail of a take is not a cut inside it,
 * so the window is contiguous — one `[from, to]` into `rome-ram-gate`, asserted below.
 *
 * **The tail of that take is shorter than last time, and that is the opposite of what was
 * asked.** The brief suggested holding longer on the collapse now that `rome-arch` is not there
 * to pay it off. Measured at 400 px, holding longer is the wrong way round: the leaves give way
 * at frames 355-370 and that is a genuine event — whole-frame |dluma| peaks at 9.54 against a
 * beat mean of 1.78 +/- 1.23, z = +6.3, the largest thing that happens in the shot — but
 * *afterwards* the picture decays. Inter-frame motion falls monotonically 1.67 -> 0.58 across
 * the aftermath and frame contrast falls 28.6 -> 23.3, because what the break does to the
 * picture is take a pale panel out of a dark arch. Every frame held past the break is emptier
 * than the one before it. So the window ends at 390, thirty-five frames tighter than the
 * shipped cut, on the last frame where the surge of men on the road is still above its
 * pre-break level — and the second that buys goes to the end card instead, which is the one
 * thing in the back half of the film that is unambiguous at 400 px.
 *
 * The picture's fades are burned into the master frames, so the windows are chosen around
 * them rather than over them, and that is now asserted rather than remembered: every window is
 * checked to sit at full picture gain, except `endcard`, which runs to 209 precisely so that it
 * keeps its fade to black. There is no fade *up* at the head: a feed video autoplays muted and
 * one that opens on black has already lost. The sound is given the same curve, recomputed from
 * the same formula `trailer-mixdown.mjs` uses, so the track goes down with the picture at the end.
 *
 *   node tools/scratch/trailer-tw-cut.mjs --work=/tmp/tc-recut-work
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
       + 'frame 60 is the thumbnail a feed will freeze on. Unchanged from the first edit.' },
  { id: 'field-clash', len: 210, src: [100, 177], one: false,
    why: 'The lines are already in contact by frame 80; this is the melee with the dust band '
       + 'along it and the camera still closing. Two dark hosts and a bright seam: it reads '
       + 'small because it is three big shapes, not because of any detail in it. Unchanged.' },
  { id: 'carth-eles', len: 150, src: [72, 149], one: false,
    why: 'The elephants, asked for by name, and the door into Carthage. Two reasons it is this '
       + 'beat that opens the block rather than the wall or the towers: it is the most legible '
       + 'thing in the film after `rome-arch` — gradient energy 17.19 at 400 px against 13.79 '
       + 'for `field-line` and 7.30 for the ram — and it is a *field* beat, green grass and gold '
       + 'stubble under a pale sky, so cutting to it from `field-clash` is a cut between two '
       + 'shots of the same colour. That is what stops 146 BC reading as a mistake. The window '
       + 'runs to the last frame of the beat because the camera is closing the whole way (eye '
       + '5.0 -> 3.6 m, standoff 52 -> 32 m) and the animals are largest at the end: at 72 they '
       + 'are a legible row, at 149 they fill the lower half of the frame. Nothing is burned '
       + 'into this beat at either end.' },
  { id: 'carth-tower', len: 150, src: [76, 140], one: false,
    why: 'The Carthage action, and the door out. Two siege towers docked on the Punic parapet '
       + 'with columns queuing into them: dark timber against a pale limestone curtain, which is '
       + 'the highest-contrast geometry on that map (frame contrast 55.4 at 400 px, against '
       + '32.0 for the wide Roman escalade this cut drops). It leaves the block on a wall being '
       + 'climbed and hands to a wall being climbed, so the map changes on a cut where the '
       + 'subject does not. Ends at 140 because 141-149 are a burned fade to black — the act '
       + 'boundary of the 86 s cut, which this cut does not have.' },
  { id: 'siege-parapet', len: 150, src: [68, 140], one: false,
    why: 'The Aurelian Wall, close, at the height of the crest, and the survivor of the two '
       + 'escalade beats. Measured at 400 px it beats the wide `siege-ladders` on all three '
       + 'numbers — gradient 10.86 vs 10.07, contrast 59.4 vs 32.0, motion 3.22 vs 2.20 — and '
       + 'the reason is visible as soon as both are put at that size: the wide shot is brown '
       + 'wall on green grass with two faint diagonals on it, and this one is hard sky against '
       + 'dark brick with a ladder that has a chain of men on it. It is also the closer of the '
       + 'two, which matters now that a Punic wall precedes it: wide wall, close wall, gate '
       + 'mouth, and the film pushes in without a step backwards. Ends at 140, before the '
       + 'burned fade at 141-149.' },
  { id: 'rome-ram-gate', len: 480, src: [206, 390], one: true,
    why: 'ONE TAKE, contiguous, no join. It cuts in *on* a ram blow: the shed hide fills the '
       + 'lens until frame 152, a blow lands at 212-231 so entering at 206 puts the shake 0.2 s '
       + 'after the cut, and the leaves give way at 355-370 (measured at the delivered size: '
       + 'whole-frame |dluma| peaks at 9.54 there against a beat mean of 1.78 +/- 1.23, z = '
       + '+6.3, and it is the largest thing that happens in the shot). It then holds 0.67 s '
       + 'and leaves while the picture is still moving. Not longer, and the brief asked for '
       + 'longer: across 370-479 the whole-frame motion decays 1.67 -> 0.58 and the frame '
       + 'contrast 28.6 -> 23.3, because what the break does to the picture is *remove* a pale '
       + 'panel from a dark arch. The surge of men on the road (box 0.55,0.50,0.45,0.45) runs '
       + '2.38 through frame 389 against a pre-break 1.88 and is back at 1.84 by 434, so 390 is '
       + 'the last frame on which the shot is still doing something. Everything after it is the '
       + 'shot dying, and the end card is a better use of that second. Trimming either end of a '
       + 'take is not a cut inside it; the window is one contiguous run and it is asserted.' },
  { id: 'endcard', len: 210, src: [110, 209], one: false,
    why: 'Title and URL are at full opacity by frame 88, so entering at 110 costs no dead time, '
       + 'and the window keeps the burned fade to black over the last 21 frames. It is a third '
       + 'of a second longer than the first edit gave it, taken off the end of the ram. That is '
       + 'deliberate: with `rome-arch` gone the card has to carry the ending, and at 400 px the '
       + 'white title is the most legible thing in the whole back half of the film. Cutting to '
       + 'it while the gate is still coming apart lands the break on the title rather than '
       + 'letting the break dissipate against brick first.' },
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
  /*
   * The burned-fade assertion. The 86 s cut's dips to black are photographed *into* the master
   * frames, so a window that overlaps one delivers black frames in the middle of a hard-cut
   * feed video. Every window was chosen by hand to miss them, and the first edit relied on
   * remembering which beats had them; this checks it instead. `endcard` is the one window
   * allowed to end inside a fade, because its fade to black is the end of the film.
   */
  if (s.id !== 'endcard') {
    for (let i = a; i <= b; i++) {
      const f = pictureFade(s.id, i, s.len, s.id === 'field-line');
      if (f > 1e-6) {
        throw new Error(`${s.id}: frame ${i} sits ${(f * 100).toFixed(0)} % inside a burned fade`);
      }
    }
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
