#!/usr/bin/env node
/**
 * Cut a trailer out of the live simulation. **Picture only.**
 *
 * Forked from the tool that shot the released silent cut, with two changes: beats 12 and 13
 * (`rome-ram` and `rome-gate`) are one continuous sixteen-second take, and `--noencode` stops
 * it spending twenty minutes of `libvpx -cpu-used 0` on frames nobody has looked at yet.
 * The shipped 1080p file with sound is encoded by `trailer-encode.mjs` from these same frames
 * and `trailer-mixdown.mjs`'s track; the encoder here is only useful for a quick VP8 look.
 *
 * -------------------------------------------------------------------------------------
 * What this is, and why it is not a screen recording.
 * -------------------------------------------------------------------------------------
 *
 * There is no `ffmpeg` on this machine and no permission to install one, but Playwright
 * ships its own stripped build for `recordVideo` (`libvpx_vp8` + `webm` + `image2pipe`),
 * and that is enough to encode a JPEG frame sequence into a WebM. So the capture is a
 * frame sequence and the cut is a file list, which buys three things a `recordVideo`
 * session cannot have:
 *
 *   - **No dead air across a page load.** Four of the beats need a different map or
 *     scenario, and those are fixed before `Engine` is constructed — they cost a reload.
 *     A single recorded session would have eight seconds of loading screen baked into an
 *     eighty-second trailer. Frames are addressed by name, so the cut order and the
 *     capture order are independent.
 *   - **Every frame is rendered, none are dropped.** The GPU is shared with other agents
 *     today. A wall-clock recorder would stutter wherever they happened to be busy.
 *   - **The clock is exact.** One captured frame is one `engine.advance(1/30, 1000/30)`,
 *     which is one rendered frame and one 30 Hz simulation tick — the same `frame()` the
 *     rAF loop calls, at the dt a player at 30 fps gets. Playback at 30 fps is therefore
 *     real time, and `simTime` is asserted to advance by 1/30 s across every frame of
 *     every beat. See `--verify`: this project has shipped a battle that froze for
 *     sixteen minutes and photographed perfectly, so the clock is asserted, not assumed.
 *
 * Usage:
 *   node tools/scratch/trailer-recut.mjs --port=5237 --stills   # 3 frames a beat, to look at
 *   node tools/scratch/trailer-recut.mjs --port=5237              # the whole thing
 *   node tools/scratch/trailer-recut.mjs --port=5237 --beats=gate,ram
 *   node tools/scratch/trailer-recut.mjs --encode                 # frames -> webm, no capture
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? '1'];
}));
const PORT = Number(args.get('port') ?? 5219);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const DPR = Number(args.get('dpr') ?? 1);
const FPS = 30;
const QUALITY = args.get('quality') ?? 'ultra';
const STILLS = args.has('stills');
const ENCODE_ONLY = args.has('encode');
// Capture without encoding: the join has to be looked at before twenty minutes of libvpx
// at `-cpu-used 0` is spent on it, and the encode is a pure function of the frames on disk.
const NO_ENCODE = args.has('noencode');
const WORK = args.get('work') ?? '/tmp/tc-trailer-frames';
/*
 * Not a path inside the repository, deliberately. This tool's encoder is the VP8-only ffmpeg
 * Playwright bundles; the shipped 1080p cut with sound is built by `trailer-encode.mjs` from
 * the same frames, and neither file is committed — both are release assets. Defaulting to
 * `docs/video/` would put a 14 MB build artefact on a committable path on every run.
 */
const OUT = args.get('out') ?? '/tmp/tc-sound/picture-vp8.webm';
const BEAT_FILTER = args.get('beats') ? String(args.get('beats')).split(',') : null;
const FFMPEG = args.get('ffmpeg')
  ?? `${process.env.HOME}/Library/Caches/ms-playwright/ffmpeg-1011/ffmpeg-mac`;
/*
 * Encoder settings, and why they are arguments.
 *
 * The only video encoder on this machine is the one Playwright ships for `recordVideo`:
 * a `--disable-everything` ffmpeg with `libvpx` (VP8) and nothing else — no VP9, no x264,
 * no audio codec at all. VP8 at 1920x1080 over eighty-four seconds of grass, dust and
 * eight thousand moving men is expensive: the first encode pinned the quantiser at its
 * `qmax` for the whole run and *still* came out at 6.5 Mbit/s and 68.8 MB, which is a file
 * that lives in every clone of this repository forever. `qmax` was the binding constraint,
 * not the bitrate target, so it is a knob here rather than a constant.
 */
/*
 * The shipped setting, chosen by encoding the same 2,520 frames three ways and looking at
 * the result: 1920x1080 / qmax 48 came out at 68.8 MB, 1600x900 / qmax 60 at 20.8 MB, and
 * this at 14.2 MB with no difference I could find on the two hardest frames (the clash,
 * which is dust and eight thousand moving men, and the escalade, which is flat brick).
 * A file committed to this repository is in every clone of it forever, so the smallest one
 * that still shows the rendering wins.
 */
const BITRATE = args.get('bitrate') ?? '1350k';
const CRF = args.get('crf') ?? '41';
const QMAX = args.get('qmax') ?? '63';
const SCALE = args.get('scale') ?? '1600:900';

const ease = (u) => u * u * (3 - 2 * u);            // smoothstep: gentle in and out
const easeOut = (u) => 1 - (1 - u) * (1 - u);
const lerp = (a, b, u) => a + (b - a) * u;
/** Interpolate every numeric field of two like-shaped param objects. */
const mix = (a, b, u) => {
  const o = {};
  for (const k of Object.keys(a)) {
    const va = a[k], vb = b === undefined || b[k] === undefined ? va : b[k];
    o[k] = typeof va === 'number' && typeof vb === 'number' ? lerp(va, vb, u) : va;
  }
  return o;
};

// ---------------------------------------------------------------------------
// Scenes: one page load each. Anything here is fixed before `Engine` exists.
// ---------------------------------------------------------------------------
const SCENES = {
  'rome-field':    { map: 'campus-martius', scenario: 'field',   hour: 8.2 },
  'rome-assault':  { map: 'campus-martius', scenario: 'assault', hour: 14.3 },
  'carth-assault': { map: 'carthage', enemy: 'carthage', scenario: 'assault', hour: 16.2 },
  'carth-field':   { map: 'carthage', enemy: 'carthage', scenario: 'field',   hour: 10.4 },
};

// ---------------------------------------------------------------------------
// The cut.
// ---------------------------------------------------------------------------
//
// `at` is [simStart, simEnd] and the beat lasts exactly (simEnd - simStart) seconds of
// screen time, so nothing is sped up or slowed down anywhere in this file.
//
// `anchor` is resolved once, at the beat's first frame, against the live world — the wall
// is generated and where two armies meet is emergent, so a world coordinate written down
// here would be a guess with a shelf life. `from`/`to` are then interpolated in metres and
// radians around that anchor, eased so a move starts and ends gently.
const BEATS = [
  // ---- I. the line, standing to -------------------------------------------
  {
    // Looking *north*, from behind the Roman line at the host it is waiting for, and that
    // is a lighting decision rather than a compositional one. Rome sits south of the field,
    // so a camera on the enemy's side looking back at the shields looks south — and at
    // 08:12 that is 20 degrees off a 12-degree sun. Two passes of this beat came back as
    // one flat cream wash with the men barely legible in it. Turned around, the same dawn
    // is a 90-degree cross-light and the same men have edges.
    id: 'field-line', scene: 'rome-field', at: [4, 9],
    desc: 'Dawn. Behind the Roman line, tracking along it, the Juthungi host beyond.',
    anchor: { kind: 'unitClass', faction: 0, cls: 'heavy-infantry', pick: 'frontmost' },
    from: { along: -40, eye: 2.7, aim: 1.55, dist: 27, fov: 32, yawAdd: Math.PI - 0.34 },
    to:   { along: 32, eye: 2.5, aim: 1.50, dist: 21, fov: 32, yawAdd: Math.PI - 0.22 },
    caption: { text: 'THE CAMPUS MARTIUS', sub: 'Rome, 271 AD', at: [0.14, 0.94] },
  },
  // ---- II. the build -------------------------------------------------------
  {
    id: 'field-clash', scene: 'rome-field', at: [63, 70],
    desc: 'The last fifty metres and the crash: the lines meet.',
    anchor: { kind: 'frontGap' },
    from: { dx: 0, dz: 0, eye: 15, aim: 2.4, dist: 96, fov: 32, yawAdd: 1.02 },
    to:   { dx: 0, dz: 0, eye: 11, aim: 2.0, dist: 62, fov: 32, yawAdd: 0.80 },
  },
  {
    id: 'field-cav', scene: 'rome-field', at: [74, 78],
    desc: 'The equites wing coming round the flank at the gallop.',
    anchor: { kind: 'cavalryUnit' },
    from: { dx: 0, dz: 0, eye: 8, aim: 2.0, dist: 58, fov: 32, yawAdd: 0.50 },
    to:   { dx: 0, dz: 0, eye: 6, aim: 1.8, dist: 40, fov: 32, yawAdd: 0.86 },
  },
  {
    /*
     * The scale shot, and the reason it looks *along* the battle line rather than at it.
     *
     * Two earlier framings of this failed in opposite directions. At zoom 0.78 the RTS
     * camera's own pitch curve is 50 degrees down and eight thousand men render as smudges
     * on a map. Pulled back to a 500 m standoff with a long lens instead, the aerial
     * perspective at that range washed the whole field to one cream and the hosts stopped
     * reading as hosts. A camera on the flank at 90 m, looking down the length of the
     * engagement, gets the whole frontage without the distance: the near end is 200 m away
     * and the far end recedes, which is what depth is for.
     */
    id: 'field-scale', scene: 'rome-field', at: [92, 98],
    desc: 'From the flank at ninety metres, down the length of the whole engagement.',
    anchor: { kind: 'contact' },
    from: { dx: 46, dz: 0, eye: 74, aim: 5, dist: 250, fov: 34, yaw: -Math.PI / 2 - 0.22 },
    to:   { dx: 16, dz: 0, eye: 58, aim: 5, dist: 196, fov: 34, yaw: -Math.PI / 2 - 0.08 },
  },
  // ---- III. the wall -------------------------------------------------------
  {
    id: 'siege-approach', scene: 'rome-assault', at: [15, 22],
    desc: 'Siege towers and ladders crossing open ground toward the wall, under artillery.',
    anchor: { kind: 'bay', k: 0, subject: 'gate' },
    from: { stand: 74, lift: 0, eye: 27, aim: 7, dist: 178, fov: 32, yaw: 'in', yawAdd: -0.38 },
    to:   { stand: 62, lift: 0, eye: 19, aim: 6, dist: 138, fov: 32, yaw: 'in', yawAdd: -0.18 },
    caption: { text: 'THE AURELIAN WALL', sub: 'The Juthungi at the gates', at: [0.12, 0.92] },
  },
  {
    id: 'siege-ladders', scene: 'rome-assault', at: [40, 46],
    desc: 'Escalade against the unfinished stretch: men on the rungs, the garrison above them.',
    anchor: { kind: 'bay', k: -3 },
    from: { stand: 4, lift: 0, eye: 10, aim: 5.5, dist: 54, fov: 34, yaw: 'in', yawAdd: 0.58 },
    to:   { stand: 4, lift: 0, eye: 17, aim: 7.5, dist: 41, fov: 34, yaw: 'in', yawAdd: 0.34 },
  },
  {
    /*
     * The parapet from *outside*, at the height of the crest.
     *
     * The first attempt stood the camera on the wall-walk and looked along it, which is the
     * composition this shot wants and is not survivable: the run is 34 m of walk and every
     * fifth bay carries a covered gallery or a tower chamber, so the camera ended up inside
     * one and the frame was a photograph of a doorway. Outside the face at crest height,
     * looking obliquely along the curtain, gets the embrasures, the men in them and the
     * ladder heads without putting the lens inside the masonry.
     */
    id: 'siege-parapet', scene: 'rome-assault', at: [52, 57],
    desc: 'The crest from outside: the garrison in the embrasures, escaladers at the top.',
    anchor: { kind: 'bay', k: -3 },
    from: { stand: 3, lift: 'crest', eye: 1.3, aim: -1.5, dist: 46, fov: 32, yaw: 'in', yawAdd: 1.06 },
    to:   { stand: 3, lift: 'crest', eye: 1.0, aim: -1.3, dist: 33, fov: 32, yaw: 'in', yawAdd: 0.86 },
    fadeOut: 9,
  },
  // ---- IV. Carthage --------------------------------------------------------
  {
    id: 'carth-wall', scene: 'carth-assault', at: [12, 19],
    desc: 'A descending crane: the city and the Byrsa, then down onto the great wall and its ditch.',
    anchor: { kind: 'bay', k: 0, subject: 'gate' },
    from: { stand: 20, lift: 0, eye: 158, aim: 22, dist: 380, fov: 34, yaw: 'in', yawAdd: -0.30 },
    to:   { stand: 52, lift: 0, eye: 44, aim: 9, dist: 196, fov: 34, yaw: 'in', yawAdd: -0.10 },
    caption: { text: 'CARTHAGE', sub: 'Spring, 146 BC', at: [0.12, 0.92] },
    fadeIn: 9,
  },
  {
    id: 'carth-eles', scene: 'carth-field', at: [96, 101],
    desc: 'The war elephants coming on in front of the Punic centre.',
    anchor: { kind: 'unitType', id: 'war-elephants' },
    from: { dx: 0, dz: 0, eye: 5.0, aim: 2.4, dist: 52, fov: 32, yawAdd: 0.45 },
    to:   { dx: 0, dz: 0, eye: 3.6, aim: 2.8, dist: 32, fov: 32, yawAdd: 0.72 },
  },
  {
    id: 'carth-tower', scene: 'carth-assault', at: [252, 257],
    desc: 'Two siege towers docked on the Punic parapet, columns queuing up into them.',
    anchor: { kind: 'bay', k: 1 },
    from: { stand: 26, lift: 0, eye: 26, aim: 15, dist: 60, fov: 32, yaw: 'in', yawAdd: 0.62 },
    to:   { stand: 22, lift: 0, eye: 21, aim: 14, dist: 44, fov: 32, yaw: 'in', yawAdd: 0.42 },
    fadeOut: 9,
  },
  // ---- V. the climax: the gate --------------------------------------------
  {
    /*
     * One take, and it used to be two.
     *
     * The released cut broke this in the middle: `rome-ram` ran t+202..208 and `rome-gate`
     * t+210..218, so the join had a two-second hole in sim time the capture never shot, and
     * the camera stepped *backwards* across it — eye 8 -> 8.5 m, standoff 33 -> 44 m. A
     * viewer reads a wider frame after a tighter one as a new setup, which is precisely the
     * thing this shot must not be: the ram is one continuous push and the payoff is the
     * twenty-sixth blow at the end of it. Shot as a single sixteen-second beat with one
     * eased move, monotonic in eye, standoff and yaw, so nothing can read as a cut. It
     * costs the trailer two seconds. The slow push is what the two seconds buy.
     */
    id: 'rome-ram-gate', scene: 'rome-assault', at: [202, 218],
    desc: 'One take: the ram at the Porta Flaminia, pushing in, and the leaves giving way at t+215.',
    anchor: { kind: 'bay', k: 0, subject: 'gate' },
    from: { stand: 10, lift: 0, eye: 11, aim: 3.8, dist: 46, fov: 34, yaw: 'in', yawAdd: -0.98 },
    to:   { stand: 3, lift: 0, eye: 6.0, aim: 3.4, dist: 30, fov: 32, yaw: 'in', yawAdd: -0.44 },
    fadeIn: 9,
  },
  {
    id: 'rome-arch', scene: 'rome-assault', at: [218, 224],
    desc: 'From the street inside: the arch is open, and the last cohort stands in it.',
    anchor: { kind: 'bay', k: 0, subject: 'gate' },
    from: { stand: -14, lift: 0, eye: 6.0, aim: 3.4, dist: 33, fov: 32, yaw: 'out', yawAdd: 0.16 },
    to:   { stand: -9, lift: 0, eye: 4.4, aim: 3.2, dist: 25, fov: 32, yaw: 'out', yawAdd: 0.04 },
  },
  // ---- VI. end card --------------------------------------------------------
  {
    id: 'endcard', scene: 'rome-assault', at: [230, 237],
    desc: 'The Aurelian Wall with Rome behind it, and the title.',
    anchor: { kind: 'bay', k: 6 },
    from: { stand: 128, lift: 0, eye: 66, aim: 16, dist: 250, fov: 32, yaw: 'in', yawAdd: 0.34 },
    to:   { stand: 112, lift: 0, eye: 58, aim: 15, dist: 218, fov: 32, yaw: 'in', yawAdd: 0.20 },
    endcard: true,
  },
];

// ---------------------------------------------------------------------------
// In-page helpers, installed once per load.
// ---------------------------------------------------------------------------
const PAGE_LIB = () => {
  const g = window.__game;
  const rig = g.engine.rig;
  const T = {
    savedHeightAt: rig.heightAt,
    savedPitch: rig.pitchForZoom,
    savedFov: rig.fovForZoom,
    savedRadius: Object.getOwnPropertyDescriptor(rig, 'radius') ?? null,
  };
  window.__tr = T;

  T.reset = () => {
    rig.heightAt = T.savedHeightAt;
    rig.pitchForZoom = T.savedPitch;
    rig.fovForZoom = T.savedFov;
    if (T.savedRadius) Object.defineProperty(rig, 'radius', T.savedRadius);
    else delete rig.radius;
  };

  /** Resolve a beat's anchor against the live world. Plain numbers only. */
  T.anchor = (spec) => {
    const b = g.battle;
    const city = g.engine.context.tryGet('city');
    const ground = (x, z) => T.savedHeightAt ? T.savedHeightAt(x, z) : 0;
    if (spec.kind === 'world') return { x: 0, z: 0, terrY: ground(0, 0) };
    if (spec.kind === 'bay') {
      const bays = city.getGarrisonBays();
      const gi = bays.findIndex((q) => q.isGate);
      const bay = bays[Math.max(0, Math.min(bays.length - 1, (gi < 0 ? 0 : gi) + spec.k))];
      let mx = (bay.x0 + bay.x1) * 0.5, mz = (bay.z0 + bay.z1) * 0.5;
      if (spec.subject === 'gate') {
        // The gate is not at the centre of its own bay — the road decides where it is.
        const gate = city.getGates()[0];
        if (gate) { mx = gate.x; mz = gate.z; }
      }
      return { x: mx, z: mz, nx: bay.nx, nz: bay.nz, dx: bay.dx, dz: bay.dz,
        walkY: bay.walkY, crestY: bay.crestY, terrY: ground(mx, mz), bayIndex: bay.index };
    }
    if (spec.kind === 'frontGap') {
      // Midpoint of the two *front lines*, not of the two hosts. The hosts' centroids
      // include the reserves and the artillery, so their midpoint sits tens of metres
      // behind where the lines are about to touch — which is how the first pass of the
      // clash beat opened on two thirds of a frame of empty grass.
      let ours = null, theirs = null;
      for (const u of b.units) {
        if (u.destroyed || u.alive === 0) continue;
        const cls = b.typeOf(u).unitClass;
        const line = cls === 'heavy-infantry' || cls === 'spear-infantry'
          || cls === 'shock-infantry' || cls === 'light-infantry';
        if (!line) continue;
        if (u.faction === 0) { if (!ours || u.z < ours.z) ours = u; }
        else if (!theirs || u.z > theirs.z) theirs = u;
      }
      if (!ours || !theirs) return null;
      const x = (ours.x + theirs.x) / 2, z = (ours.z + theirs.z) / 2;
      return { x, z, terrY: ground(x, z), gap: +(ours.z - theirs.z).toFixed(1),
        axis: Math.atan2(theirs.x - ours.x, theirs.z - ours.z) };
    }
    if (spec.kind === 'contact' || spec.kind === 'closing') {
      // The densest 40 m cell of men actually fighting; before contact, the midpoint of
      // the two hosts on the axis between them.
      const p = b.pool;
      const cells = new Map();
      const cx = [0, 0, 0], cz = [0, 0, 0], cn = [0, 0, 0];
      for (let i = 0; i < p.count; i++) {
        const st = p.state[i];
        if (st === 11 || st === 10) continue;
        const f = p.faction[i];
        cx[f] += p.x[i]; cz[f] += p.z[i]; cn[f]++;
        if (st !== 4) continue;
        const key = Math.floor((p.z[i] + 1400) / 40) * 128 + Math.floor((p.x[i] + 1400) / 40);
        const c = cells.get(key);
        if (c) { c.x += p.x[i]; c.z += p.z[i]; c.n++; } else cells.set(key, { x: p.x[i], z: p.z[i], n: 1 });
      }
      const foe = cn[2] > cn[1] ? 2 : 1;
      const ax = cn[0] ? cx[0] / cn[0] : 0, az = cn[0] ? cz[0] / cn[0] : 0;
      const bx = cn[foe] ? cx[foe] / cn[foe] : 0, bz = cn[foe] ? cz[foe] / cn[foe] : 0;
      let best = null;
      for (const c of cells.values()) if (!best || c.n > best.n) best = c;
      const useCell = best && best.n >= 12;
      const x = useCell ? best.x / best.n : (ax + bx) / 2;
      const z = useCell ? best.z / best.n : (az + bz) / 2;
      return { x, z, terrY: ground(x, z), axis: Math.atan2(bx - ax, bz - az),
        cellN: best ? best.n : 0 };
    }
    if (spec.kind === 'unitType' || spec.kind === 'unitClass' || spec.kind === 'cavalryUnit') {
      let best = null;
      for (const u of b.units) {
        if (u.destroyed || u.alive === 0) continue;
        const t = b.typeOf(u);
        if (spec.kind === 'unitType' && t.id !== spec.id) continue;
        if (spec.kind === 'unitClass') {
          if (u.faction !== spec.faction || t.unitClass !== spec.cls) continue;
        }
        if (spec.kind === 'cavalryUnit'
            && t.unitClass !== 'heavy-cavalry' && t.unitClass !== 'light-cavalry') continue;
        if (spec.pick === 'frontmost') {
          // Nearest the enemy: faction 0 faces -Z on both maps.
          if (!best || (spec.faction === 0 ? u.z < best.z : u.z > best.z)) best = u;
        } else if (!best || u.alive > best.alive) best = u;
      }
      if (!best) return null;
      return { x: best.x, z: best.z, facing: best.facing, alive: best.alive,
        terrY: ground(best.x, best.z), unit: b.typeOf(best).id };
    }
    return null;
  };

  /** Park the camera for one frame. Everything is absolute; nothing is remembered. */
  T.apply = (s) => {
    T.reset();
    if (s.liftY !== null && s.liftY !== undefined) {
      const y = s.liftY;
      rig.heightAt = () => y;
    }
    if (s.cam) {
      const LIFT = 1.55;
      const groundY = (s.liftY !== null && s.liftY !== undefined)
        ? s.liftY : T.savedHeightAt(s.fx, s.fz);
      const rise = s.cam.eye - s.cam.aim + LIFT;
      const R = Math.hypot(rise, s.cam.dist);
      const P = Math.atan2(rise, s.cam.dist);
      rig.zoom = 0; rig.zoomTarget = 0;
      rig.pitchForZoom = () => P;
      rig.fovForZoom = () => s.cam.fov;
      Object.defineProperty(rig, 'radius', { get: () => R, configurable: true });
      rig.heightAt = () => groundY + s.cam.aim - LIFT;
      rig.jumpTo(s.fx, s.fz, 0, s.yaw);
    } else {
      rig.jumpTo(s.fx, s.fz, s.zoom, s.yaw);
    }
  };

  /** One rendered frame == one 30 Hz simulation tick. */
  T.step = () => { g.engine.advance(1 / 30, 1000 / 30); };

  T.stats = () => {
    const b = g.battle, p = b.pool;
    let alive = 0, fighting = 0, corpses = 0, moving = 0, climbing = 0, shooting = 0, routing = 0;
    for (let i = 0; i < p.count; i++) {
      const st = p.state[i];
      if (st === 11 || st === 10) { corpses++; continue; }
      alive++;
      if (st === 4) fighting++;
      else if (st === 1 || st === 2 || st === 3) moving++;
      else if (st === 13) climbing++;
      else if (st === 6 || st === 7 || st === 8) shooting++;
      else if (st === 12) routing++;
    }
    const st = g.engine.stats();
    const cam = g.engine.rig.camera;
    /*
     * How far off the sun the lens points, in degrees, and how high the sun is.
     *
     * Inside about 45 degrees of a low sun every surface in frame goes to one flat cream —
     * bloom, god rays and forward scatter all peak at once. The first pass of the opening
     * beat came back at 14 degrees off an 8-degree sun and read as a lighting fault rather
     * than as dawn. It is a number, so it is recorded rather than argued about.
     */
    let sunAngle = null, sunElev = null;
    const sky = g.engine.context.tryGet('sky');
    const sd = sky && sky.sunDirection;
    if (sd) {
      const f = new (cam.position.constructor)(0, 0, -1).applyQuaternion(cam.quaternion);
      const fl = Math.hypot(f.x, f.z) || 1e-6, sl = Math.hypot(sd.x, sd.z) || 1e-6;
      const c = (f.x * sd.x + f.z * sd.z) / (fl * sl);
      sunAngle = +((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI).toFixed(1);
      sunElev = +((Math.asin(Math.max(-1, Math.min(1, sd.y))) * 180) / Math.PI).toFixed(1);
    }
    return { t: +g.simTime().toFixed(4), alive, fighting, corpses, moving, climbing,
      shooting, routing, draws: st.calls, tris: st.tris, sunAngle, sunElev,
      fov: +cam.fov.toFixed(1),
      eye: [+cam.position.x.toFixed(1), +cam.position.y.toFixed(1), +cam.position.z.toFixed(1)] };
  };
};

// ---------------------------------------------------------------------------
// Overlay: captions, the end card, and the fades. Drawn as DOM over the canvas.
// ---------------------------------------------------------------------------
const OVERLAY_HTML = `
<div id="tr-ov" style="position:fixed;inset:0;pointer-events:none;z-index:99999;font-kerning:normal">
  <div id="tr-scrim" style="position:absolute;inset:0;opacity:0;
    background:linear-gradient(to top,rgba(0,0,0,.72) 0%,rgba(0,0,0,.34) 16%,rgba(0,0,0,0) 34%)"></div>
  <div id="tr-cap" style="position:absolute;left:6.2%;bottom:8.5%;opacity:0;
    font-family:'Optima','Palatino Linotype',Palatino,Georgia,serif;color:#f3ece0;
    text-shadow:0 2px 18px rgba(0,0,0,.85),0 0 3px rgba(0,0,0,.7)">
    <div id="tr-cap-t" style="font-size:34px;letter-spacing:.34em;font-weight:600"></div>
    <div id="tr-cap-s" style="font-size:20px;letter-spacing:.16em;margin-top:10px;opacity:.82;
      font-style:italic"></div>
  </div>
  <div id="tr-endscrim" style="position:absolute;inset:0;opacity:0;
    background:radial-gradient(ellipse 74% 62% at 50% 46%,rgba(0,0,0,.70) 0%,rgba(0,0,0,.52) 55%,rgba(0,0,0,.30) 100%)"></div>
  <div id="tr-end" style="position:absolute;inset:0;opacity:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;
    font-family:'Optima','Palatino Linotype',Palatino,Georgia,serif;color:#f6efe2;
    text-shadow:0 4px 40px rgba(0,0,0,.9)">
    <div style="font-size:96px;letter-spacing:.30em;font-weight:600;padding-left:.30em">TOTAL CLAUDE</div>
    <div style="width:230px;height:1px;background:linear-gradient(90deg,transparent,#c9a24a,transparent);
      margin:34px 0 30px"></div>
    <div style="font-size:25px;letter-spacing:.20em;opacity:.88;padding-left:.20em">
      8,632 MEN &nbsp;&middot;&nbsp; ONE BROWSER TAB</div>
    <div id="tr-url" style="font-size:29px;letter-spacing:.13em;margin-top:64px;opacity:0;
      color:#e8d9b4">total-claude.vercel.app</div>
  </div>
  <div id="tr-fade" style="position:absolute;inset:0;background:#000;opacity:1"></div>
</div>`;

const setOverlay = (o) => {
  const cap = document.getElementById('tr-cap');
  const scrim = document.getElementById('tr-scrim');
  const endScrim = document.getElementById('tr-endscrim');
  const capT = document.getElementById('tr-cap-t');
  const capS = document.getElementById('tr-cap-s');
  const end = document.getElementById('tr-end');
  const url = document.getElementById('tr-url');
  const fade = document.getElementById('tr-fade');
  if (o.capText !== undefined) { capT.textContent = o.capText; capS.textContent = o.capSub ?? ''; }
  cap.style.opacity = String(o.cap ?? 0);
  scrim.style.opacity = String((o.cap ?? 0) * 0.92);
  endScrim.style.opacity = String(o.end ?? 0);
  cap.style.transform = `translateY(${(1 - (o.cap ?? 0)) * 9}px)`;
  end.style.opacity = String(o.end ?? 0);
  url.style.opacity = String(o.url ?? 0);
  fade.style.opacity = String(o.fade ?? 0);
};

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------
async function encode(listFile, outPath) {
  const list = JSON.parse(await readFile(listFile, 'utf8'));
  await mkdir(path.dirname(outPath), { recursive: true });
  const vf = SCALE ? ['-vf', `scale=${SCALE}:flags=lanczos`] : [];
  const ff = spawn(FFMPEG, [
    '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', 'pipe:0',
    ...vf,
    '-c:v', 'libvpx', '-b:v', BITRATE, '-crf', CRF, '-qmin', '6', '-qmax', QMAX,
    '-quality', 'good', '-cpu-used', '0', '-auto-alt-ref', '1', '-lag-in-frames', '20',
    '-arnr-maxframes', '7', '-arnr-strength', '4',
    '-g', '150', '-threads', '6', '-pix_fmt', 'yuv420p', '-an',
    '-f', 'webm', outPath,
  ], { stdio: ['pipe', 'inherit', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err += d.toString(); });
  const done = new Promise((ok, no) => {
    ff.on('exit', (c) => (c === 0 ? ok() : no(new Error(`ffmpeg exit ${c}\n${err.slice(-3000)}`))));
  });
  for (const f of list) {
    const buf = await readFile(f);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;
  const s = await stat(outPath);
  console.log(`\n→ ${outPath}  ${(s.size / 1e6).toFixed(1)} MB  ${list.length} frames  `
    + `${(list.length / FPS).toFixed(1)} s  ${SCALE || '1920:1080'}  b:v ${BITRATE} crf ${CRF} qmax ${QMAX}`);
  return s.size;
}

if (ENCODE_ONLY) {
  await encode(path.join(WORK, 'cut.json'), OUT);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------
const wanted = BEATS.filter((b) => !BEAT_FILTER || BEAT_FILTER.includes(b.id));
if (!wanted.length) { console.error('no beats matched'); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }

const FRAMES = path.join(WORK, STILLS ? 'stills' : 'frames');
// `--keep`: leave frames from earlier runs in place, so one badly framed beat can be
// re-shot on its own. The cut is rebuilt from what is on disk either way, so a partial
// re-shoot cannot silently drop the beats it did not touch.
if (!STILLS && !args.has('keep') && existsSync(FRAMES)) await rm(FRAMES, { recursive: true });
await mkdir(FRAMES, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-dev-shm-usage',
    '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

let loaded = null;
async function load(sceneId) {
  if (loaded === sceneId) return;
  const s = SCENES[sceneId];
  const url = `${base}/?harness=1&quality=${QUALITY}&w=${W}&h=${H}`
    + `&map=${s.map}&scenario=${s.scenario}${s.enemy ? `&enemy=${s.enemy}` : ''}`;
  console.log(`\n• load ${sceneId}: ${url}`);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null,
    { timeout: 420000 });
  console.log(`  world ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.addStyleTag({ content:
    '#hud-root,#loading,#menu-root{display:none!important;visibility:hidden!important}' });
  await page.evaluate(() => {
    const hud = window.__game?.engine?.context?.tryGet?.('hud');
    if (hud && hud.overlay) hud.overlay.visible = false;
    // Drive the clock ourselves: rAF frames interleaved with synthetic ones would make the
    // step between two captured frames depend on how busy the machine was.
    window.__game.engine.stop();
  });
  const got = await page.evaluate((h) => {
    const sky = window.__game.engine.context.tryGet('sky');
    if (!sky?.setTimeOfDay) return null;
    sky.setTimeOfDay(h);
    return sky.timeOfDay;
  }, s.hour);
  if (got === null || Math.abs(got - s.hour) > 0.01) throw new Error(`hour ${s.hour} refused (${got})`);
  await page.evaluate(PAGE_LIB);
  await page.evaluate((html) => {
    document.body.insertAdjacentHTML('beforeend', html);
  }, OVERLAY_HTML);
  await page.evaluate(`window.__setOverlay = ${setOverlay.toString()}`);
  loaded = sceneId;
}

const log = [];
/** beat id -> its frame files, in order. The cut is assembled from this afterwards. */
const byBeat = new Map();

/*
 * Capture order is not cut order.
 *
 * `map`, `scenario` and the opposing faction are fixed before `Engine` is constructed, so a
 * beat on another world costs a page load, and a page load resets the clock — the simulation
 * cannot be rewound, only fast-forwarded. The cut wants Carthage in the middle and the gate
 * at the end, which would mean loading the Roman assault twice and fast-forwarding 200 s of
 * battle the second time. So beats are captured grouped by scene and in ascending sim time
 * within each group, exactly as `tools/shoot.mjs` does, and the file list handed to the
 * encoder is rebuilt in declaration order at the end.
 */
const sceneOrder = [...new Set(wanted.map((b) => b.scene))];
const captureOrder = sceneOrder.flatMap((sc) =>
  wanted.filter((b) => b.scene === sc).sort((a, b) => a.at[0] - b.at[0]));
const firstInCut = wanted[0];

for (const beat of captureOrder) {
  await load(beat.scene);
  const [t0, t1] = beat.at;
  const total = Math.round((t1 - t0) * FPS);

  // Fast-forward to the beat's start. Same fixed 1/30 grid the capture uses, so a beat
  // reaches the same battle state whichever subset of beats was requested.
  const ff0 = Date.now();
  await page.evaluate((t) => {
    const g = window.__game;
    while (g.simTime() < t - 1e-6) g.engine.advance(1 / 30, 1000 / 30);
  }, t0);
  const anchor = await page.evaluate((spec) => window.__tr.anchor(spec), beat.anchor);
  if (!anchor) throw new Error(`${beat.id}: anchor ${JSON.stringify(beat.anchor)} resolved to nothing`);
  console.log(`\n▸ ${beat.id}  t+${t0}..${t1}  ${total} frames  `
    + `(ff ${((Date.now() - ff0) / 1000).toFixed(1)} s)  anchor ${JSON.stringify(anchor).slice(0, 150)}`);

  const idx = STILLS ? [0, Math.floor(total / 2), total - 1] : [...Array(total).keys()];
  const beatLog = { id: beat.id, scene: beat.scene, at: beat.at, desc: beat.desc, anchor, frames: [] };
  let prevT = null;

  for (let i = 0; i < total; i++) {
    const u = ease(total <= 1 ? 0 : i / (total - 1));
    const p = mix(beat.from, beat.to, u);

    // ---- build the absolute camera state for this frame --------------------
    /*
     * One camera model, not three.
     *
     * The first pass had a `zoom`-based mode and a `cam` mode and they do not measure the
     * same thing: `zoom` is a single scalar from which `RTSCamera` derives the orbit radius
     * (exponential, 3.2 m to 620 m), the pitch and the field of view all at once, and then
     * `place()` refuses to let the eye sit closer to the ground than `lerp(1.7, 22, ...)`.
     * So "close to the subject" and "far enough back to see the wall" are the same dial, and
     * three of the first pass's siege frames came back as a 1080p photograph of brick because
     * zoom 0.22 means an orbit radius of six metres whatever the shot wanted.
     *
     * Every beat therefore names what a photographer names — eye height, aim height,
     * standoff, focal length — and the curves are bypassed. `zoom` remains for the two
     * strategic overviews, where the coupling is exactly right.
     */
    const st = { fx: 0, fz: 0, yaw: 0, zoom: 0.5, liftY: null, cam: null };

    // Focus, in whichever frame the anchor provides.
    if (p.x !== undefined) { st.fx = p.x; st.fz = p.z; }
    else if (anchor.nx !== undefined) {
      // A wall bay: out along its own outward normal, and along its own run.
      st.fx = anchor.x + anchor.nx * (p.stand ?? 0) + anchor.dx * (p.along ?? 0);
      st.fz = anchor.z + anchor.nz * (p.stand ?? 0) + anchor.dz * (p.along ?? 0);
    } else if (anchor.facing !== undefined && p.along !== undefined) {
      // A unit: slide down its own frontage, which is perpendicular to its facing.
      const f = anchor.facing;
      st.fx = anchor.x + Math.cos(f) * p.along;
      st.fz = anchor.z - Math.sin(f) * p.along;
    } else {
      st.fx = anchor.x + (p.dx ?? 0); st.fz = anchor.z + (p.dz ?? 0);
    }

    // The ground datum this beat measures its heights against.
    const lift = beat.from.lift;
    if (lift !== undefined) {
      const parse = (v) => (typeof v === 'string'
        ? (v.startsWith('walk') ? { base: 'walk', add: v.length > 4 ? Number(v.slice(4)) : 0 }
          : { base: 'crest', add: v.length > 5 ? Number(v.slice(5)) : 0 })
        : { base: 'terrain', add: v });
      const la = parse(lift), lb = parse(beat.to.lift ?? lift);
      if (la.base !== lb.base) throw new Error(`${beat.id}: lift datum changes mid-beat`);
      const add = lerp(la.add, lb.add, u);
      st.liftY = la.base === 'walk' ? anchor.walkY + add
        : la.base === 'crest' ? anchor.crestY + add
          : anchor.terrY + add;
    }

    // Yaw. Named against the wall where there is one, so it cannot go stale when the
    // curtain is re-cut; otherwise off the axis between the armies or the unit's facing.
    const yw = p.yaw === 'in' ? Math.atan2(-anchor.nx, -anchor.nz)
      : p.yaw === 'out' ? Math.atan2(anchor.nx, anchor.nz)
        : p.yaw === 'along' ? Math.atan2(anchor.dx, anchor.dz)
          : typeof p.yaw === 'number' ? p.yaw
            : (anchor.axis ?? ((anchor.facing ?? 0) + Math.PI));
    st.yaw = yw + (p.yawAdd ?? 0);

    // Framing.
    if (p.eye !== undefined) st.cam = { eye: p.eye, aim: p.aim, dist: p.dist, fov: p.fov };
    else st.zoom = p.zoom;

    // ---- overlay -----------------------------------------------------------
    const ov = { fade: 0, cap: 0, end: 0, url: 0 };
    if (beat.caption) {
      const [a, bnd] = beat.caption.at;
      const uu = total <= 1 ? 0 : i / (total - 1);
      const fadeIn = Math.min(1, Math.max(0, (uu - a) / 0.10));
      const fadeOut = Math.min(1, Math.max(0, (bnd - uu) / 0.10));
      ov.cap = Math.min(fadeIn, fadeOut);
      ov.capText = beat.caption.text; ov.capSub = beat.caption.sub;
    }
    if (beat.endcard) {
      const uu = total <= 1 ? 0 : i / (total - 1);
      ov.end = Math.min(1, Math.max(0, (uu - 0.05) / 0.15));
      ov.url = Math.min(1, Math.max(0, (uu - 0.26) / 0.13));
      ov.fade = Math.max(0, (uu - 0.90) / 0.10);
    }
    /*
     * Fades. Hard cuts everywhere else — the brief asks for cuts on action and a
     * dissolve between two moving cameras reads as a smear — but the trailer opens out
     * of black and the two act boundaries dip through it, which is what tells a viewer
     * that the map has changed rather than the camera.
     */
    const fadeIn = beat === firstInCut ? 24 : (beat.fadeIn ?? 0);
    if (fadeIn && i < fadeIn) ov.fade = Math.max(ov.fade, 1 - easeOut(i / (fadeIn - 1)));
    if (beat.fadeOut && i >= total - beat.fadeOut) {
      ov.fade = Math.max(ov.fade, easeOut((i - (total - beat.fadeOut)) / (beat.fadeOut - 1)));
    }

    // ---- render one frame, then photograph it ------------------------------
    const rec = await page.evaluate(({ s, o }) => {
      window.__tr.apply(s);
      window.__setOverlay(o);
      window.__tr.step();
      return window.__tr.stats();
    }, { s: st, o: ov });

    if (prevT !== null) {
      const d = rec.t - prevT;
      if (Math.abs(d - 1 / 30) > 1e-3) {
        throw new Error(`${beat.id} frame ${i}: clock moved ${d.toFixed(4)} s, expected 0.0333`);
      }
    }
    prevT = rec.t;

    beatLog.frames.push({ i, t: rec.t, alive: rec.alive, fighting: rec.fighting,
      corpses: rec.corpses, moving: rec.moving, climbing: rec.climbing,
      shooting: rec.shooting, routing: rec.routing, draws: rec.draws, eye: rec.eye,
      sunAngle: rec.sunAngle, sunElev: rec.sunElev, fov: rec.fov });
    if (STILLS && !idx.includes(i)) continue;
    const file = path.join(FRAMES, `${beat.id}-${String(i).padStart(4, '0')}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 94 });
    if (!STILLS) (byBeat.get(beat.id) ?? byBeat.set(beat.id, []).get(beat.id)).push(file);
  }

  // What actually moved during this beat — the anti-freeze assertion.
  const f = beatLog.frames;
  const first = f[0], last = f[f.length - 1];
  beatLog.moved = {
    simSeconds: +(last.t - first.t).toFixed(3),
    aliveDelta: last.alive - first.alive,
    corpseDelta: last.corpses - first.corpses,
    fightingRange: [Math.min(...f.map((q) => q.fighting)), Math.max(...f.map((q) => q.fighting))],
    movingRange: [Math.min(...f.map((q) => q.moving)), Math.max(...f.map((q) => q.moving))],
    climbingMax: Math.max(...f.map((q) => q.climbing)),
    shootingMax: Math.max(...f.map((q) => q.shooting)),
  };
  console.log(`  ${f.length} frames  sim +${beatLog.moved.simSeconds}s  `
    + `alive ${first.alive}->${last.alive}  corpses +${beatLog.moved.corpseDelta}  `
    + `fighting ${beatLog.moved.fightingRange}  moving ${beatLog.moved.movingRange}  `
    + `climb<=${beatLog.moved.climbingMax}  shoot<=${beatLog.moved.shootingMax}  `
    + `draws ${last.draws}`);
  log.push(beatLog);
}

// The cut: declaration order, not capture order, and read back off disk rather than from
// what this run happened to produce.
let cutList = [];
if (!STILLS) {
  const onDisk = (await readdir(FRAMES)).filter((f) => f.endsWith('.jpg')).sort();
  for (const b of BEATS) {
    const mine = onDisk.filter((f) => /^(.*)-\d{4}\.jpg$/.exec(f)?.[1] === b.id);
    if (!mine.length) { console.warn(`  ! no frames on disk for beat ${b.id}`); continue; }
    cutList.push(...mine.map((f) => path.join(FRAMES, f)));
  }
}
/*
 * Merge the record by beat name rather than overwriting it.
 *
 * `--beats=field-scale,endcard` into a directory that already held a fourteen-beat capture
 * used to replace the record with a two-beat one, so the file describing the trailer went
 * silent about twelve of its own shots. Re-framing one bad beat is the normal thing to
 * want; losing the provenance of the other thirteen is not. Same fix, and the same reason,
 * as the `report.json` merge in `tools/shoot.mjs`.
 */
const recPath = path.join(WORK, STILLS ? 'stills.json' : 'capture.json');
let mergedBeats = log;
if (existsSync(recPath)) {
  const prior = JSON.parse(await readFile(recPath, 'utf8'));
  const byName = new Map((prior.beats ?? []).map((b) => [b.id, b]));
  for (const b of log) byName.set(b.id, b);
  mergedBeats = BEATS.map((b) => byName.get(b.id)).filter(Boolean);
}
await writeFile(recPath,
  JSON.stringify({ at: new Date().toISOString(), w: W, h: H, dpr: DPR, fps: FPS,
    quality: QUALITY, scenes: SCENES, cut: BEATS.map((b) => b.id),
    capturedThisRun: captureOrder.map((b) => b.id), beats: mergedBeats,
    errs: [...new Set(errs)] }, null, 1));
if (!STILLS) await writeFile(path.join(WORK, 'cut.json'), JSON.stringify(cutList, null, 0));
const frameNo = cutList.length;

await browser.close();

if (errs.length) {
  console.error(`\n⚠ ${errs.length} page error(s):`);
  for (const e of [...new Set(errs)].slice(0, 10)) console.error('   ' + e);
}
console.log(`\n${STILLS ? 'stills' : 'frames'} → ${FRAMES}`);
if (!STILLS) {
  console.log(`total ${frameNo} frames = ${(frameNo / FPS).toFixed(1)} s`);
  if (NO_ENCODE) console.log('--noencode: frames only; run --encode to build the webm');
  else await encode(path.join(WORK, 'cut.json'), OUT);
}
