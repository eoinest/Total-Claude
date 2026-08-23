#!/usr/bin/env node
/**
 * Solve the testudo arm poses instead of guessing them.
 *
 * A shield roof is a geometry problem. "Raise the left arm until the scutum looks flat"
 * is a hand-authoring loop that costs a browser launch per guess and converges on
 * something that is nearly level, which is exactly the failure the eye reads as an
 * undulating roof. The relation is closed-form, so this solves it.
 *
 * The chain, all of it already in `src/`:
 *
 *   - the scutum is skinned rigidly to `lowerArmL` through `socket('march', 0, …)` in
 *     `soldierMesh.ts`, so its world transform is `worldPose(lowerArmL) · L`, where
 *     `L = poseM(march@0, lowerArmL)⁻¹ · desired(march@0)` and nothing else;
 *   - an `absTr` track sets that bone's world orientation outright to `delta ⊗ restQ`
 *     (`pose.ts`, the `tr.abs` branch), so the board's orientation is *exactly* solvable:
 *     `delta = Qboard · R12⁻¹ · Qmarch · restQ⁻¹`;
 *   - the board's *position* is `pos(lowerArmL) + Qforearm · (Qmarch⁻¹ · offset)`, and
 *     `pos(lowerArmL) = pos(upperArmL) + Qupper · localT(lowerArmL)` — a point on a sphere
 *     of the upper arm's own length about a shoulder the arm tracks cannot move. So the
 *     upper arm has two useful degrees of freedom and the board's centre has three: pick
 *     the direction, accept the radius, and iterate the target to a fixed point.
 *
 * Run against a live dev server, because the rig, the clip set and the socket solver are
 * TypeScript modules and Vite is the only thing here that can load them. A blank page on
 * the same origin plus `import('/src/anim/clips.ts')` is enough — no game boot.
 *
 *   node tools/scratch/testudo-solve.mjs --port=5592
 */

import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5592);

/**
 * The poses to solve, and what each one is for.
 *
 * `board` is the world orientation of the shield: XYZ Euler in degrees applied to the
 * carry orientation's own frame, where the panel's +Z is the face a missile hits and its
 * +Y is the top of the board as carried. `Rx(-90)` therefore lays the board flat with its
 * face up and its top edge pointing aft, which is the roof; `Rx(0)` leaves it upright,
 * which is the front rank.
 *
 * `centre` is where the middle of the board should end up, in the man's own frame: +Y up
 * from the ground he stands on, +Z the way he faces, +X his left (the model faces +Z with
 * its own right hand at -X).
 */
/**
 * The stances the arms are solved against, and why there are two.
 *
 * The arms have to be solved *after* the legs and spine, because the shoulder they hang
 * from is placed by them and the reach is short: the scutum's socket sits 0.285 m from the
 * elbow and the upper arm is 0.30 m, so the board's centre lives on a sphere of radius
 * 0.30 m about a point the stance decides. An arm solved against a standing shoulder is a
 * quarter of its whole reach out on a crouched man.
 *
 * That same short reach is why the roof men are **hunched and not crouched**. Drop the
 * shoulder to 1.24 m and the highest the board will go is 1.70 m, which is below the top
 * of a standing man's own helmet; the roof would have to be built through the heads
 * holding it. The interior of a testudo is men standing with their arms up and their heads
 * pulled in, and the geometry says so as firmly as the sources do.
 */
const STANCES = {
  /** Interior and flanks: knees soft, back rounded, head tucked. Shoulder near 1.38 m. */
  hunch: {
    root: [0, -0.045, 0.03],
    tracks: {
      thighL: [-15, 4, 0], shinL: [26, 0, 0],
      thighR: [-9, -4, 0], shinR: [18, 0, 0],
      pelvis: [0, 9, 0], spineLow: [-9, 4, 0], chest: [-5, 2, 0], neck: [14, -5, 0],
    },
  },
  /** Front rank: down behind the board, weight over the front foot. Shoulder near 1.18 m. */
  deep: {
    root: [0, -0.244, 0.05],
    tracks: {
      thighL: [-56, 7, 0], shinL: [98, 0, 0],
      thighR: [-34, -7, 0], shinR: [70, 0, 0],
      pelvis: [0, 26, 0], spineLow: [-19, 8, 0], chest: [-10, 4, 0], neck: [18, -7, 0],
    },
  },
  /**
   * The same two, walking.
   *
   * The legs are left to the march base — an authored thigh angle over a stride is a limp —
   * so only the root drop and the spine carry the crouch, and the root drop is tuned here
   * against the standing stance rather than copied from it. **The arm angles must come out
   * of the halted solve unchanged**, because an absolute arm track fixes the board's
   * orientation and only the shoulder moves it: if the two stances put the shoulder at
   * different heights the whole roof steps up the moment the cohort halts.
   */
  hunchMarch: {
    base: 'march',
    root: [0, -0.03, 0.03],
    tracks: {
      thighL: [-10, 0, 0], shinL: [18, 0, 0], thighR: [-10, 0, 0], shinR: [18, 0, 0],
      pelvis: [0, 9, 0], spineLow: [-9, 4, 0], chest: [-5, 2, 0], neck: [14, -5, 0],
    },
  },
  deepMarch: {
    base: 'march',
    root: [0, -0.21, 0.05],
    tracks: {
      thighL: [-36, 0, 0], shinL: [62, 0, 0], thighR: [-36, 0, 0], shinR: [62, 0, 0],
      pelvis: [0, 26, 0], spineLow: [-19, 8, 0], chest: [-10, 4, 0], neck: [18, -7, 0],
    },
  },
};

/**
 * The five boards of a testudo, as targets rather than as arm angles.
 *
 * `board` is the world orientation of the shield: an XYZ Euler in degrees applied to the
 * panel, whose +Z is the face a missile hits and whose +Y is the top of the board as
 * carried. `Rx(-90)` therefore lays it flat, face up, top edge aft — that is the roof.
 * `Rx(0)` leaves it upright — that is the front rank.
 *
 * `centre` is where the middle of the board should end up in the man's own frame: +Y up
 * from the ground he stands on, +Z the way he faces, +X his left.
 *
 * The five interlock, and the arithmetic is written out here because the whole point is
 * that no horizontal ray from outside reaches a man. At a dressed rank interval of 0.63 m:
 *
 *   - `face` covers 0.42–1.48 m of height at the very front;
 *   - `nose` runs from 1.23 m up to 1.97 m and 0.72 m forward, so it takes over exactly
 *     where the face stops and slopes back to the roof line — this is the piece that
 *     stops a testudo having an open band across its front at head height;
 *   - `roofA`/`roofB` are the two tile courses, 1.83 and 1.87 m, each 1.06 m of board over
 *     a 0.63 m rank interval, so every board laps the one in front by 0.43 m;
 *   - `tail` mirrors the nose at the back.
 */
const POSES = {
  face: {
    stance: 'deep', board: [-7, 0, 0], centre: [-0.02, 0.80, 0.34],
    // The right hand goes up onto the back of his own board rather than to the hip. It can,
    // because a testudo stows the weapon — `TESTUDO_STOW_HI` in `kit.ts` — and a man holding
    // a 10 kg scutum against a volley with one hand and nothing in the other is the pose that
    // makes the whole formation read as men doing something difficult.
    elbowR: [-0.30, 0.86, -0.06], handR: [-0.21, 0.92, 0.10],
  },
  nose: {
    stance: 'hunch', board: [-52, 0, 0], centre: [-0.02, 1.44, 0.34],
    elbowR: [-0.32, 1.22, 0.02], handR: [-0.21, 1.36, 0.16],
  },
  // Two courses, four degrees and forty millimetres apart. A single roof clip gives one
  // printed plane; alternating ranks between these two gives a surface with a grain, which
  // is what a roof of hand-held boards actually looks like from above.
  roofA: {
    stance: 'hunch', board: [-82, 0, 0], centre: [0, 1.72, 0.24],
    elbowR: [-0.30, 1.32, 0.02], handR: [-0.20, 1.48, 0.16],
  },
  roofB: {
    stance: 'hunch', board: [-78, 0, 0], centre: [0, 1.755, 0.20],
    elbowR: [-0.30, 1.32, 0.02], handR: [-0.20, 1.50, 0.13],
  },
  // Turned outward by the renderer rather than by the pose — a flank man in a testudo
  // faces the flank, so his whole body turns and the same board maths serves.
  flank: {
    stance: 'hunch', board: [6, 0, 0], centre: [-0.02, 1.24, 0.30],
    elbowR: [-0.31, 1.16, -0.05], handR: [-0.21, 1.24, 0.10],
  },
};

let browser = null;
let server = null;
try {
  browser = await launchBrowser({ label: 'testudo-solve', port: PORT, root: ROOT });
  const started = await startVite({ port: PORT, root: ROOT, label: 'testudo-solve', slot: browser.budgetSlot });
  server = started.started ? started : null;
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
  // A blank document on the dev server's own origin. Vite will still serve and transform
  // any module asked for by path, which is all this needs.
  await page.route('**/__solve.html', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>solve</title>' }));
  await page.goto(`${started.base}/__solve.html`, { waitUntil: 'domcontentloaded' });

  const out = await page.evaluate(async ({ POSES, STANCES }) => {
    const { MAN_RIG, MB } = await import('/src/anim/rig.ts');
    const { MAN_CLIP_SET } = await import('/src/anim/clips.ts');
    const { sampleGlobals, buildOverlay } = await import('/src/anim/pose.ts');

    const DEG = Math.PI / 180;
    const n = MAN_RIG.boneCount;
    const q = new Float32Array(n * 4);
    const t = new Float32Array(n * 3);

    // Quaternion and vector maths, hand-rolled. `three` is a bare specifier and this page
    // is deliberately not transformed by Vite, so it cannot be imported here; the handful
    // of operations needed is shorter than any workaround. Quaternions are [x, y, z, w]
    // and Euler is THREE's own 'XYZ' order, which is the order `pose.ts` builds an
    // authored delta in — see the `tr.abs` branch of `buildOverlay`.
    const clipByName = (name) => MAN_CLIP_SET.clips[MAN_CLIP_SET.index(name)];
    const Q = (i, arr) => [arr[i * 4], arr[i * 4 + 1], arr[i * 4 + 2], arr[i * 4 + 3]];
    const V = (i, arr) => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
    const qmul = (a, b) => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
    const qinv = (a) => [-a[0], -a[1], -a[2], a[3]];
    const qrot = (a, v) => {
      const [x, y, z, w] = a;
      const ix = w * v[0] + y * v[2] - z * v[1];
      const iy = w * v[1] + z * v[0] - x * v[2];
      const iz = w * v[2] + x * v[1] - y * v[0];
      const iw = -x * v[0] - y * v[1] - z * v[2];
      return [
        ix * w + iw * -x + iy * -z - iz * -y,
        iy * w + iw * -y + iz * -x - ix * -z,
        iz * w + iw * -z + ix * -y - iy * -x,
      ];
    };
    const eul = (a) => {
      const [x, y, z] = a.map((d) => d * DEG * 0.5);
      const cx = Math.cos(x), sx = Math.sin(x);
      const cy = Math.cos(y), sy = Math.sin(y);
      const cz = Math.cos(z), sz = Math.sin(z);
      return [
        sx * cy * cz + cx * sy * sz,
        cx * sy * cz - sx * cy * sz,
        cx * cy * sz + sx * sy * cz,
        cx * cy * cz - sx * sy * sz,
      ];
    };
    /** `THREE.Euler.setFromQuaternion` in 'XYZ', which is the inverse of `eul` above. */
    const toEul = (a) => {
      const [x, y, z, w] = a;
      const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
      const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w);
      const m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
      const clamp = (v) => Math.min(1, Math.max(-1, v));
      const ey = Math.asin(clamp(m13));
      let ex, ez;
      if (Math.abs(m13) < 0.9999999) { ex = Math.atan2(-m23, m33); ez = Math.atan2(-m12, m11); }
      else { ex = Math.atan2(m32, m22); ez = 0; }
      return [ex / DEG, ey / DEG, ez / DEG];
    };
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
    const len = (a) => Math.hypot(a[0], a[1], a[2]);
    const norm = (a) => scl(a, 1 / (len(a) || 1));
    /** `THREE.Quaternion.setFromUnitVectors`: the minimal rotation taking `a` onto `b`. */
    const between = (a, b) => {
      let w = 1 + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      let out;
      if (w < 1e-8) {
        out = Math.abs(a[0]) > Math.abs(a[2]) ? [-a[1], a[0], 0, 0] : [0, -a[2], a[1], 0];
      } else {
        out = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], w];
      }
      const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
      return [out[0] / l, out[1] / l, out[2] / l, out[3] / l];
    };

    // ---- the socket, exactly as soldierMesh.ts solves it -------------------
    // `L` is the shield's rigid transform in the forearm's own posed frame.
    const march = clipByName('march');
    sampleGlobals(MAN_RIG, march, 0, q, t);
    const Qm = Q(MB.lowerArmL, q);
    const OFF = [-0.13, -0.16, 0.2];
    const R12 = eul([0, 12, 0]);
    // t_L = Qm^-1 * offset ; R_L = Qm^-1 * R12
    const QmInv = qinv(Qm);
    const tL = qrot(QmInv, OFF);
    const RL = qmul(QmInv, R12);

    // ---- the stances -------------------------------------------------------
    const tr = (bone, k) => ({ bone, keys: [[0, k[0], k[1], k[2]]] });
    const shoulders = {};
    const shouldersR = {};
    const heads = {};
    const bobs = {};
    for (const [name, st] of Object.entries(STANCES)) {
      const clip = buildOverlay(MAN_RIG, clipByName(st.base ?? 'idleAlertReady'), {
        name: `__${name}`, frames: 2, duration: 1, loop: true,
        root: [[0, st.root[0], st.root[1], st.root[2]]],
        tracks: Object.entries(st.tracks).map(([b, k]) => tr(MB[b], k)),
      });
      // Averaged over the cycle, not sampled at frame 0. A walking man's shoulder rises
      // and falls, and that bob is the roof's own undulation while the cohort advances —
      // so it is measured and reported rather than discovered in a frame.
      const acc = [0, 0, 0];
      const racc = [0, 0, 0];
      const hacc = [0, 0, 0];
      let lo = Infinity;
      let hi = -Infinity;
      // The lowest either foot reaches over the cycle. A root drop is how a crouch keeps
      // the hips down, and it takes the feet with it: an uncompensated one buries them.
      let footLo = Infinity;
      const N = 16;
      for (let k = 0; k < N; k++) {
        sampleGlobals(MAN_RIG, clip, k / N, q, t);
        const s = V(MB.upperArmL, t);
        const sr = V(MB.upperArmR, t);
        const h = V(MB.head, t);
        for (let c = 0; c < 3; c++) {
          acc[c] += s[c] / N; racc[c] += sr[c] / N; hacc[c] += h[c] / N;
        }
        lo = Math.min(lo, s[1]);
        hi = Math.max(hi, s[1]);
        footLo = Math.min(footLo, V(MB.footL, t)[1], V(MB.footR, t)[1]);
      }
      shoulders[name] = acc;
      shouldersR[name] = racc;
      heads[name] = hacc;
      bobs[name] = { bob: +(hi - lo).toFixed(3), footLo: +footLo.toFixed(3) };
    }
    // The two bases, unmodified, so the stances above have something to be level with.
    for (const nm of ['idleAlertReady', 'march']) {
      let footLo = Infinity;
      let sh = 0;
      for (let k = 0; k < 16; k++) {
        sampleGlobals(MAN_RIG, clipByName(nm), k / 16, q, t);
        footLo = Math.min(footLo, V(MB.footL, t)[1], V(MB.footR, t)[1]);
        sh += V(MB.upperArmL, t)[1] / 16;
      }
      bobs[`base:${nm}`] = { bob: 0, footLo: +footLo.toFixed(3), shoulderY: +sh.toFixed(3) };
    }
    const restQUpperL = Q(MB.upperArmL, MAN_RIG.restQ);
    const restQLowerL = Q(MB.lowerArmL, MAN_RIG.restQ);
    const localTLower = V(MB.lowerArmL, MAN_RIG.localT);
    const armLen = len(localTLower);
    const uRest = norm(localTLower);
    // The right arm, for the supporting hand. Same forward kinematics, one bone further:
    // the elbow is on a sphere about the shoulder and the hand on a sphere about the elbow,
    // so naming both targets and snapping each to its own sphere is the whole solve.
    const restQUpperR = Q(MB.upperArmR, MAN_RIG.restQ);
    const restQLowerR = Q(MB.lowerArmR, MAN_RIG.restQ);
    const localTLowerR = V(MB.lowerArmR, MAN_RIG.localT);
    const localTHandR = V(MB.handR, MAN_RIG.localT);
    const armLenR = len(localTLowerR);
    const foreLenR = len(localTHandR);
    const uRestR = norm(localTLowerR);
    const uRestHandR = norm(localTHandR);

    const solved = {};
    for (const [name, spec] of Object.entries(POSES)) {
      const shoulderL = shoulders[spec.stance];
      const shoulderR = shouldersR[spec.stance];
      // 1. Orientation is exact. Qboard = Qforearm * RL  =>  Qforearm = Qboard * RL^-1.
      const Qboard = eul(spec.board);
      const Qfore = qmul(Qboard, qinv(RL));
      const dLower = qmul(Qfore, qinv(restQLowerL));

      // 2. Position, by fixed point. The elbow can only sit on a sphere about the
      //    shoulder, so aim at the target, take what the sphere gives, and push the aim
      //    by the residual until it stops moving.
      const want = spec.centre.slice();
      const armOffset = qrot(Qfore, tL);
      let aim = want.slice();
      let got = null;
      let Qup = null;
      for (let k = 0; k < 80; k++) {
        const dir = norm(sub(sub(aim, armOffset), shoulderL));
        Qup = between(uRest, dir);
        got = add(add(shoulderL, scl(dir, armLen)), armOffset);
        aim = add(aim, sub(want, got));
      }
      const dUpper = qmul(Qup, qinv(restQUpperL));
      const degs = (qq) => toEul(qq).map((v) => +v.toFixed(1));
      // What the board actually does, reported rather than assumed: the extremes of the
      // 0.66 x 1.06 m panel in the man's own frame, and the face normal.
      const corner = (sx, sy) => add(qrot(Qboard, [sx * 0.33, sy * 0.53, 0]), got);
      const normal = qrot(Qboard, [0, 0, 1]);
      // ---- the right arm ----------------------------------------------------
      const dirE = norm(sub(spec.elbowR, shoulderR));
      const QupR = between(uRestR, dirE);
      const elbowR = add(shoulderR, scl(dirE, armLenR));
      const dirH = norm(sub(spec.handR, elbowR));
      const QloR = between(uRestHandR, dirH);
      const handR = add(elbowR, scl(dirH, foreLenR));
      const dUpperR = qmul(QupR, qinv(restQUpperR));
      const dLowerR = qmul(QloR, qinv(restQLowerR));

      solved[name] = {
        stance: spec.stance,
        upperArmL: degs(dUpper), lowerArmL: degs(dLower),
        upperArmR: degs(dUpperR), lowerArmR: degs(dLowerR),
        handRAt: handR.map((v) => +v.toFixed(3)),
        handRMiss: +len(sub(handR, spec.handR)).toFixed(3),
        centre: got.map((v) => +v.toFixed(3)),
        miss: +len(sub(got, want)).toFixed(4),
        normal: normal.map((v) => +v.toFixed(3)),
        yTop: +Math.max(corner(0, 1)[1], corner(0, -1)[1]).toFixed(3),
        yBottom: +Math.min(corner(0, 1)[1], corner(0, -1)[1]).toFixed(3),
        zFront: +Math.max(corner(0, 1)[2], corner(0, -1)[2]).toFixed(3),
        zBack: +Math.min(corner(0, 1)[2], corner(0, -1)[2]).toFixed(3),
        xSpan: [+corner(-1, 0)[0].toFixed(3), +corner(1, 0)[0].toFixed(3)],
      };
    }
    const round = (o) => Object.fromEntries(Object.entries(o)
      .map(([k, v]) => [k, v.map((x) => +x.toFixed(3))]));
    return {
      armLen: +armLen.toFixed(4), shoulders: round(shoulders), heads: round(heads), bobs, solved,
    };
  }, { POSES, STANCES });

  console.log(`upper arm ${out.armLen} m`);
  for (const [k, v] of Object.entries(out.bobs)) {
    const sh = out.shoulders[k] ? JSON.stringify(out.shoulders[k]) : `y ${v.shoulderY}`;
    const hd = out.heads[k] ? JSON.stringify(out.heads[k]) : '—';
    console.log(`  ${k.padEnd(20)} shoulder ${sh}  head ${hd}  bob ${v.bob}  footLo ${v.footLo}`);
  }
  console.log('');
  for (const [name, s] of Object.entries(out.solved)) {
    console.log(`${name}  (${s.stance})`);
    console.log(`  absTr(MB.upperArmL, [[0, ${s.upperArmL.join(', ')}]]),`);
    console.log(`  absTr(MB.lowerArmL, [[0, ${s.lowerArmL.join(', ')}]]),`);
    console.log(`  absTr(MB.upperArmR, [[0, ${s.upperArmR.join(', ')}]]),`);
    console.log(`  absTr(MB.lowerArmR, [[0, ${s.lowerArmR.join(', ')}]]),`);
    console.log(`  right hand at ${JSON.stringify(s.handRAt)} miss ${s.handRMiss} m`);
    console.log(`  board centre ${JSON.stringify(s.centre)} miss ${s.miss} m  normal ${JSON.stringify(s.normal)}`);
    console.log(`  covers y ${s.yBottom}..${s.yTop}  z ${s.zBack}..${s.zFront}  x ${JSON.stringify(s.xSpan)}\n`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
