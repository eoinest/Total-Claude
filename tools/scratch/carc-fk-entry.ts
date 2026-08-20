import { ELEPHANT_RIG } from '../../src/anim/rig';
import { frameGlobals } from '../../src/anim/pose';
import { ELEPHANT_CLIP, ELEPHANT_CLIP_SET } from '../../src/anim/elephantClips';

const rig = ELEPHANT_RIG;
const n = rig.boneCount;
const q = new Float32Array(n * 4);
const t = new Float32Array(n * 3);
const clip = ELEPHANT_CLIP_SET.clips[ELEPHANT_CLIP.death];
const out: any = { frames: clip.frames, duration: clip.duration, rows: [] };
const want = [0, 0.25, 0.39, 0.5, 0.6, 0.75, 1];
for (const w of want) {
  const f = Math.min(clip.frames - 1, Math.round(w * (clip.frames - 1)));
  frameGlobals(rig, clip, f, q, t);
  const byName: Record<string, number[]> = {};
  for (let b = 0; b < n; b++) {
    byName[rig.names[b]] = [+t[b * 3].toFixed(3), +t[b * 3 + 1].toFixed(3), +t[b * 3 + 2].toFixed(3)];
  }
  out.rows.push({ w, f, byName });
}
// local rotation magnitude per bone per frame, to see which bones actually animate
const moved: Record<string, number> = {};
for (let b = 0; b < n; b++) {
  let maxAng = 0;
  for (let f = 0; f < clip.frames; f++) {
    const o = (f * n + b) * 4;
    const w = Math.min(1, Math.abs(clip.rot[o + 3]));
    const ang = 2 * Math.acos(w) * 180 / Math.PI;
    if (ang > maxAng) maxAng = ang;
  }
  moved[rig.names[b]] = +maxAng.toFixed(2);
}
out.maxLocalRotDeg = moved;
console.log(JSON.stringify(out));
