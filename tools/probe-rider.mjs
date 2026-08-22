#!/usr/bin/env node
/**
 * Cavalry seating and gait probe.
 *
 * A still frame cannot answer "is the rider on the saddle?" — the horse's back moves
 * through a gallop cycle and the eye cannot measure centimetres through dust. So this
 * loads the animation modules in the page, replays the horse and rider clips frame by
 * frame on the CPU with exactly the maths the vertex shader uses, and prints:
 *
 *   - the horse mesh's animated world bounding box, and its lowest hoof (does it float?)
 *   - the saddle seat's animated height, taken from the skinned mesh surface
 *   - the rider's pelvis height as the render system places him
 *   - the saddle-to-pelvis gap, per frame, over a full cycle
 *   - each gait's stride length and the cadence it forces at the roster's charge speed
 *
 * Second half runs the real battle and reports how the gait phase of a marching unit is
 * distributed, which is the number that says whether a rank is in lockstep.
 *
 *   node tools/probe-rider.mjs --port=5391
 */

import { chromium } from 'playwright';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5391);
const SIM = args.get('sim') !== 'false';

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) { console.error('vite did not start'); process.exit(1); }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const SHOT_W = Number(args.get('w') ?? 1600);
const SHOT_H = Number(args.get('h') ?? 900);
const page = await browser.newPage({ viewport: { width: SHOT_W, height: SHOT_H } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${base}/?harness=1&quality=ultra&w=${SHOT_W}&h=${SHOT_H}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const geom = args.get('geom') === 'false' ? null : await page.evaluate(async () => {
  const [rig, clips, pose, horse] = await Promise.all([
    import('/src/anim/rig.ts'),
    import('/src/anim/clips.ts'),
    import('/src/anim/pose.ts'),
    import('/src/units/horseMesh.ts'),
  ]);
  const { HORSE_RIG, MAN_RIG, HB, MB } = rig;
  const { HORSE_CLIP_SET, MAN_CLIP_SET, HORSE_GAIT_LADDER, HORSE_GAIT_STRIDE } = clips;
  const { frameGlobals } = pose;
  const LIFT = horse.HORSE_GROUND_LIFT;
  const SEAT_RISE = 0.07;

  // --- skinning transforms, exactly as animTexture.ts bakes them -------------
  const skin = (r, clip, f) => {
    const n = r.boneCount;
    const wq = new Float32Array(n * 4);
    const wt = new Float32Array(n * 3);
    frameGlobals(r, clip, f, wq, wt);
    const mq = new Float32Array(n * 4);
    const mt = new Float32Array(n * 3);
    for (let b = 0; b < n; b++) {
      const ax = wq[b * 4], ay = wq[b * 4 + 1], az = wq[b * 4 + 2], aw = wq[b * 4 + 3];
      const bx = r.bindInvQ[b * 4], by = r.bindInvQ[b * 4 + 1];
      const bz = r.bindInvQ[b * 4 + 2], bw = r.bindInvQ[b * 4 + 3];
      let qx = aw * bx + ax * bw + ay * bz - az * by;
      let qy = aw * by - ax * bz + ay * bw + az * bx;
      let qz = aw * bz + ax * by - ay * bx + az * bw;
      let qw = aw * bw - ax * bx - ay * by - az * bz;
      const l = Math.hypot(qx, qy, qz, qw) || 1;
      mq[b * 4] = qx / l; mq[b * 4 + 1] = qy / l; mq[b * 4 + 2] = qz / l; mq[b * 4 + 3] = qw / l;
      const vx = r.bindInvT[b * 3], vy = r.bindInvT[b * 3 + 1], vz = r.bindInvT[b * 3 + 2];
      const cx = 2 * (ay * vz - az * vy);
      const cy = 2 * (az * vx - ax * vz);
      const cz = 2 * (ax * vy - ay * vx);
      mt[b * 3] = vx + aw * cx + (ay * cz - az * cy) + wt[b * 3];
      mt[b * 3 + 1] = vy + aw * cy + (az * cx - ax * cz) + wt[b * 3 + 1];
      mt[b * 3 + 2] = vz + aw * cz + (ax * cy - ay * cx) + wt[b * 3 + 2];
    }
    return { mq, mt, wq, wt };
  };
  const apply = (m, b, x, y, z) => {
    const qx = m.mq[b * 4], qy = m.mq[b * 4 + 1], qz = m.mq[b * 4 + 2], qw = m.mq[b * 4 + 3];
    const cx = 2 * (qy * z - qz * y);
    const cy = 2 * (qz * x - qx * z);
    const cz = 2 * (qx * y - qy * x);
    return [
      x + qw * cx + (qy * cz - qz * cy) + m.mt[b * 3],
      y + qw * cy + (qz * cx - qx * cz) + m.mt[b * 3 + 1],
      z + qw * cz + (qx * cy - qy * cx) + m.mt[b * 3 + 2],
    ];
  };

  // --- horse mesh, so the bbox and the back surface come from real vertices ---
  const g = horse.buildHorseGeometry(0);
  const pos = g.getAttribute('position').array;
  const sk = g.getAttribute('aSkin').array;
  const pt = g.getAttribute('aPieceTint').array;
  const vcount = pos.length / 3;

  const horseClip = (name) => HORSE_CLIP_SET.clips[HORSE_CLIP_SET.index(name)];
  const manClip = (name) => MAN_CLIP_SET.clips[MAN_CLIP_SET.index(name)];

  /** Skinned world bbox plus the back-surface height over the saddle station. */
  const horseFrame = (clip, f, saddleZ) => {
    const m = skin(HORSE_RIG, clip, f);
    let minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9, minX = 1e9, maxX = -1e9;
    let backY = -1e9, tackTop = -1e9;
    let hoofY = 1e9;
    for (let v = 0; v < vcount; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const b0 = sk[v * 4], b1 = sk[v * 4 + 1], w0 = sk[v * 4 + 2], w1 = sk[v * 4 + 3];
      const a = apply(m, b0, x, y, z);
      let wx = a[0] * w0, wy = a[1] * w0, wz = a[2] * w0;
      if (w1 > 0.002) {
        const c = apply(m, b1, x, y, z);
        wx += c[0] * w1; wy += c[1] * w1; wz += c[2] * w1;
      }
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      const piece = pt[v * 4];
      // Body surface directly over the saddle station. The barrel ring has 10 segments, so
      // its topmost vertex sits at |x| ~ 0.105 rather than on the spine.
      if (piece === 0 && Math.abs(wz - saddleZ) < 0.12 && Math.abs(wx) < 0.14 && wy > backY) backY = wy;
      if (piece === 1 && Math.abs(wz - saddleZ) < 0.26 && Math.abs(wx) < 0.24 && wy > tackTop) tackTop = wy;
      // Lowest point of any hoof-bound vertex.
      const isHoof = [HB.fHoofL, HB.fHoofR, HB.bHoofL, HB.bHoofR].includes(b0);
      if (isHoof && wy < hoofY) hoofY = wy;
    }
    return { minX, maxX, minY, maxY, minZ, maxZ, backY, tackTop, hoofY };
  };

  /** Where the render system's saddle seat lands once the horse is animated. */
  const anchor = horse.SADDLE_SEAT;
  const SB = horse.SADDLE_BONES;
  const anchorAt = (clip, f) => {
    const m = skin(HORSE_RIG, clip, f);
    const a = apply(m, SB.bone0, 0, anchor.y, anchor.z);
    const b = apply(m, SB.bone1, 0, anchor.y, anchor.z);
    const w = SB.weight0;
    return [
      w * a[0] + (1 - w) * b[0],
      w * a[1] + (1 - w) * b[1],
      w * a[2] + (1 - w) * b[2],
    ];
  };

  /** Rider pelvis / seat bones in his own mesh space. */
  const riderAt = (clip, f) => {
    const n = MAN_RIG.boneCount;
    const wq = new Float32Array(n * 4);
    const wt = new Float32Array(n * 3);
    frameGlobals(MAN_RIG, clip, f, wq, wt);
    return {
      pelvis: [wt[MB.pelvis * 3], wt[MB.pelvis * 3 + 1], wt[MB.pelvis * 3 + 2]],
      head: [wt[MB.head * 3], wt[MB.head * 3 + 1], wt[MB.head * 3 + 2]],
      footL: [wt[MB.footL * 3], wt[MB.footL * 3 + 1], wt[MB.footL * 3 + 2]],
      footR: [wt[MB.footR * 3], wt[MB.footR * 3 + 1], wt[MB.footR * 3 + 2]],
      kneeL: [wt[MB.shinL * 3], wt[MB.shinL * 3 + 1], wt[MB.shinL * 3 + 2]],
    };
  };

  // --- pairs the renderer actually plays together ---------------------------
  const PAIRS = [
    { sim: 'halted', horse: 'idle', man: 'rideIdle' },
    { sim: 'walking', horse: 'walk', man: 'rideMove' },
    { sim: 'trotting', horse: 'trot', man: 'rideMove' },
    { sim: 'galloping', horse: 'gallopOpen', man: 'rideGallop' },
    { sim: 'charging', horse: 'charge', man: 'rideCharge' },
  ];

  const out = { anchor, pairs: [], gaits: [], ladder: [] };

  for (const nm of ['idle', 'walk', 'trot', 'gallopOpen', 'charge']) {
    const c = horseClip(nm);
    out.gaits.push({
      name: nm, frames: c.frames, duration: c.duration, rootSpeed: c.rootSpeed,
      stride: c.rootSpeed * c.duration,
    });
  }
  for (let g = 0; g < HORSE_GAIT_LADDER.length; g++) {
    out.ladder.push({
      rung: g,
      name: HORSE_CLIP_SET.clips[HORSE_GAIT_LADDER[g]].name,
      stride: HORSE_GAIT_STRIDE[g],
    });
  }

  for (const pr of PAIRS) {
    const hc = horseClip(pr.horse);
    const mc = manClip(pr.man);
    const rows = [];
    // Mean pelvis over the rider's clip, which is what the render system subtracts.
    let seatMeanY = 0;
    let seatMeanZ = 0;
    for (let f = 0; f < mc.frames; f++) {
      const r = riderAt(mc, f);
      seatMeanY += r.pelvis[1] / mc.frames;
      seatMeanZ += r.pelvis[2] / mc.frames;
    }
    // Sample 12 evenly-spaced phases of the horse cycle; the renderer picks the man's
    // frame from the same normalised phase.
    for (let k = 0; k < 12; k++) {
      const ph = k / 12;
      const hf = Math.min(hc.frames - 1, Math.floor(ph * hc.frames));
      const mf = Math.min(mc.frames - 1, Math.floor(ph * mc.frames));
      const hm = horseFrame(hc, hf, anchor.z);
      const an = anchorAt(hc, hf);
      const rd = riderAt(mc, mf);
      // Exactly what UnitRenderSystem now does: the animated seat, a hip's clearance, less
      // the rider's own mean pelvis height. The horse mesh is lifted by LIFT as well.
      const seatY = LIFT + an[1];
      const originY = seatY + SEAT_RISE - seatMeanY;
      rows.push({
        ph: +ph.toFixed(3),
        hoofY: +(hm.hoofY + LIFT).toFixed(4),
        backY: +(hm.backY + LIFT).toFixed(4),
        tackTop: +(hm.tackTop + LIFT).toFixed(4),
        bbox: [+(hm.maxX - hm.minX).toFixed(3), +(hm.maxY - hm.minY).toFixed(3), +(hm.maxZ - hm.minZ).toFixed(3)],
        bboxY: [+(hm.minY + LIFT).toFixed(3), +(hm.maxY + LIFT).toFixed(3)],
        anchorY: +seatY.toFixed(4),
        anchorZ: +an[2].toFixed(4),
        originY: +originY.toFixed(4),
        pelvisY: +(originY + rd.pelvis[1]).toFixed(4),
        pelvisZ: +rd.pelvis[2].toFixed(4),
        headY: +(originY + rd.head[1]).toFixed(4),
        footLY: +(originY + rd.footL[1]).toFixed(4),
        footSpread: +(rd.footL[0] - rd.footR[0]).toFixed(4),
        // The number the defect is measured in: pelvis above the saddle seat.
        gap: +(originY + rd.pelvis[1] - seatY).toFixed(4),
      });
    }
    out.pairs.push({ ...pr, hframes: hc.frames, mframes: mc.frames, rows });
  }
  g.dispose();
  return out;
});

const f = (v, w = 7, d = 3) => String(v.toFixed(d)).padStart(w);
if (geom) {
console.log('\n=== gait stride (stride = rootSpeed x duration; cadence = v / stride) ===');
console.log('  clip      frames  dur   rootSpeed  stride   strides/s@9.6  cycle_s@9.6  playbackRate@9.6');
for (const g of geom.gaits) {
  const cad = g.stride > 0.01 ? 9.6 / g.stride : 0;
  console.log(`  ${g.name.padEnd(9)} ${String(g.frames).padStart(5)} ${f(g.duration, 6, 2)}  ` +
    `${f(g.rootSpeed, 8)}  ${f(g.stride, 7)}   ${f(cad, 10, 2)}   ${f(cad > 0 ? 1 / cad : 0, 9, 3)}   ` +
    `${f(g.rootSpeed > 0.1 ? 9.6 / g.rootSpeed : 0, 9, 3)}`);
}

console.log('\n=== gait ladder (renderer picks by measured ground speed) ===');
for (const l of geom.ladder) {
  console.log(`  rung ${l.rung}  ${l.name.padEnd(11)} stride ${f(l.stride)} m   ` +
    `natural speed ${f(l.stride > 0 ? l.stride : 0)} m per cycle`);
}

console.log(`\n=== saddle seat (rest pose) === y ${geom.anchor.y.toFixed(4)}  z ${geom.anchor.z.toFixed(4)}`);
for (const p of geom.pairs) {
  console.log(`\n--- ${p.sim}: horse '${p.horse}' (${p.hframes}f) + rider '${p.man}' (${p.mframes}f) ---`);
  console.log('   ph   hoofY   backY tackTop  seatY originY pelvisY  headY  GAP    bboxY(min..max)   bboxWHD');
  for (const r of p.rows) {
    console.log(`  ${f(r.ph, 4, 2)} ${f(r.hoofY)} ${f(r.backY)} ${f(r.tackTop)} ${f(r.anchorY)} ` +
      `${f(r.originY)} ${f(r.pelvisY)} ${f(r.headY)} ${f(r.gap)}   ` +
      `${f(r.bboxY[0], 6)}..${f(r.bboxY[1], 6)}  ${r.bbox.join(' x ')}`);
  }
  const gaps = p.rows.map((r) => r.gap);
  const hoofs = p.rows.map((r) => r.hoofY);
  const backs = p.rows.map((r) => r.backY);
  const heads = p.rows.map((r) => r.headY);
  console.log(`  GAP (pelvis above seat)  min ${Math.min(...gaps).toFixed(3)}  max ${Math.max(...gaps).toFixed(3)}  ` +
    `mean ${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(3)}  swing ${(Math.max(...gaps) - Math.min(...gaps)).toFixed(3)}`);
  console.log(`  hoof  min ${Math.min(...hoofs).toFixed(3)} (0 = on the ground)   ` +
    `back ${Math.min(...backs).toFixed(3)}..${Math.max(...backs).toFixed(3)}   ` +
    `head ${Math.min(...heads).toFixed(3)}..${Math.max(...heads).toFixed(3)}   ` +
    `bootSpread ${Math.abs(p.rows[0].footSpread).toFixed(3)}  bootY ${p.rows[0].footLY.toFixed(3)}`);
}

}

// ---------------------------------------------------------------------------
// Live sim: how spread is the gait phase across a moving unit?
// ---------------------------------------------------------------------------
if (SIM) {
  await page.evaluate(() => window.__game.engine.stop());
  const stats = await page.evaluate(async (secs) => {
    const { MAN_CLIP_SET } = await import('/src/anim/clips.ts');
    const g = window.__game;
    g.engine.advance(secs, 1000 / 60);
    const ur = g.engine.ctx.get('unitRender');
    const b = g.battle;
    const p = b.pool;
    const rows = [];
    for (const u of b.units) {
      let n = 0;
      const ph = [];
      const clip = new Map();
      let speed = 0;
      const spd = [];
      // Cadence in cycles per second, with and without the stature term, so the effect of
      // dividing stride by the man's own scale is isolated rather than asserted.
      const cad = [];
      const cadFlat = [];
      for (const i of u.members) {
        if (!b.pool.aliveAt(i)) continue;
        const v = Math.hypot(p.vx[i], p.vz[i]);
        if (v < 0.3) continue;
        const c = MAN_CLIP_SET.clips[ur.curClip[i]];
        if (!c || c.rootSpeed < 0.1) continue;
        n++;
        ph.push(ur.phase[i]);
        spd.push(v);
        speed += v;
        clip.set(ur.curClip[i], (clip.get(ur.curClip[i]) ?? 0) + 1);
        const sc = p.scale[i] * ur.heightMul[i];
        const lim = (x) => Math.min(1.9, Math.max(0.55, x));
        cad.push(lim(v / (c.rootSpeed * sc)) / c.duration);
        cadFlat.push(lim(v / c.rootSpeed) / c.duration);
      }
      if (n < 20) continue;
      // Circular spread: |mean of unit vectors|. 1 = every man in the same pose, 0 = uniform.
      let cx = 0, cy = 0;
      for (const t of ph) { cx += Math.cos(t * Math.PI * 2); cy += Math.sin(t * Math.PI * 2); }
      const R = Math.hypot(cx, cy) / n;
      // Occupancy of 8 phase octants, so clustering is visible directly.
      const oct = new Array(8).fill(0);
      for (const t of ph) oct[Math.min(7, Math.floor(t * 8))]++;
      const cv = (a) => {
        const m = a.reduce((x, y) => x + y, 0) / a.length;
        const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length);
        return { m, cv: sd / m, uniq: new Set(a.map((v) => v.toFixed(4))).size };
      };
      rows.push({
        unit: u.typeId, n,
        speed: speed / n,
        spdSpread: Math.max(...spd) - Math.min(...spd),
        R, oct, clips: [...clip.entries()].length,
        cad: cv(cad), flat: cv(cadFlat),
      });
    }

    // --- mounts: does the gait chosen actually cover the ground? --------------
    const { HORSE_CLIP_SET, HORSE_GAIT_LADDER, HORSE_GAIT_STRIDE } = await import('/src/anim/clips.ts');
    const mounts = [];
    for (const u of b.units) {
      const def = b.typeOf(u);
      if (def.mass < 300) continue;
      const rec = { unit: u.typeId, n: 0, speed: 0, gaits: {}, slipAbs: 0, slipMax: 0 };
      for (const i of u.members) {
        if (!b.pool.aliveAt(i)) continue;
        const v = Math.hypot(p.vx[i], p.vz[i]);
        const rung = ur.gaitRung[i];
        const stride = HORSE_GAIT_STRIDE[rung];
        const name = HORSE_CLIP_SET.clips[ur.horseCur[i]]?.name ?? '?';
        rec.gaits[name] = (rec.gaits[name] ?? 0) + 1;
          rec.rate = (rec.rate ?? 0) + (stride > 0.05 ? Math.min(2.2, Math.max(0.28, v / stride)) : 0);
        rec.n++;
        rec.speed += v;
        if (stride > 0.05) {
          // Exactly the renderer's clamp; residual is the metres per second the hooves skate.
          const rate = Math.min(2.2, Math.max(0.28, v / stride));
          const slip = v - rate * stride;
          rec.slipAbs += Math.abs(slip);
          if (Math.abs(slip) > Math.abs(rec.slipMax)) rec.slipMax = slip;
        }
      }
      if (rec.n) { rec.speed /= rec.n; rec.slipAbs /= rec.n; rec.rate = (rec.rate ?? 0) / rec.n; mounts.push(rec); }
    }
    return { t: g.simTime(), rows, mounts };
  }, Number(args.get('simat') ?? 24));
  console.log(`\n=== gait phase and cadence across moving units, t=${stats.t.toFixed(1)}s ===`);
  console.log('  R    = circular concentration of phase: 1.0 = perfect lockstep, 0.0 = spread evenly');
  console.log('  cadCV = spread of playback cadence within the unit; uniq = distinct cadences');
  console.log('  "flat" is the same figure with the stature term removed, i.e. the old formula');
  console.log('  unit                       n  speed  vSpread    R    clips  cadCV uniq | flatCV uniq  phase octants');
  for (const r of stats.rows) {
    console.log(`  ${r.unit.padEnd(22)} ${String(r.n).padStart(4)} ${f(r.speed, 6, 2)} ${f(r.spdSpread, 7, 3)} ` +
      `${f(r.R, 6, 3)}  ${String(r.clips).padStart(3)}  ${f(r.cad.cv, 6, 4)} ${String(r.cad.uniq).padStart(4)} | ` +
      `${f(r.flat.cv, 6, 4)} ${String(r.flat.uniq).padStart(4)}  [${r.oct.map((v) => String(v).padStart(3)).join(' ')}]`);
  }
  console.log('\n=== mounts: gait chosen, and the hoof slip it leaves (m/s; 0 = planted) ===');
  console.log('  unit                       n  speed   meanSlip  worstSlip  cyc/s  gaits');
  for (const m of stats.mounts) {
    console.log(`  ${m.unit.padEnd(22)} ${String(m.n).padStart(4)} ${f(m.speed, 6, 2)}   ` +
      `${f(m.slipAbs, 7, 3)}  ${f(m.slipMax, 8, 3)} ${f(m.rate, 6, 2)}  ` +
      Object.entries(m.gaits).map(([k, v]) => `${k}:${v}`).join(' '));
  }
}

// ---------------------------------------------------------------------------
// Close-up on a real mounted man, which is the only way to see the seat.
// ---------------------------------------------------------------------------
const SHOT = args.get('shot');
if (SHOT) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.dirname(SHOT), { recursive: true });
  const at = Number(args.get('at') ?? 30);
  const zoom = Number(args.get('zoom') ?? 0.06);
  const off = Number(args.get('off') ?? 9);
  const turn = Number(args.get('turn') ?? 0.5);
  const info = await page.evaluate(async ({ at, zoom, off, turn }) => {
    const g = window.__game;
    if (!g.engine.running) g.engine.start?.();
    g.advance(at);
    const b = g.battle;
    // Nearest living cavalryman to the middle of the biggest mounted unit.
    let best = null;
    for (const u of b.units) {
      const def = b.typeOf(u);
      if (def.mass < 300) continue;
      let n = 0, sx = 0, sz = 0, spd = 0;
      for (const i of u.members) {
        if (!b.pool.aliveAt(i)) continue;
        n++; sx += b.pool.x[i]; sz += b.pool.z[i];
        spd += Math.hypot(b.pool.vx[i], b.pool.vz[i]);
      }
      if (n < 10) continue;
      if (!best || n > best.n) best = { id: u.id, type: u.typeId, n, x: sx / n, z: sz / n, speed: spd / n };
    }
    if (!best) return null;
    const u = b.unitById(best.id);
    // Focus on the outermost man of the wing and look at him from outside the formation, so
    // one whole horse and rider fill the frame with nothing standing in front of them.
    const cf = Math.cos(u.facing);
    const sf = Math.sin(u.facing);
    let edge = null;
    for (const i of u.members) {
      if (!b.pool.aliveAt(i)) continue;
      const lat = b.pool.x[i] * cf - b.pool.z[i] * sf;
      if (!edge || lat > edge.lat) edge = { lat, x: b.pool.x[i], z: b.pool.z[i] };
    }
    const yaw = u.facing + Math.PI * turn;
    g.setCamera(edge.x + Math.sin(yaw) * off, edge.z + Math.cos(yaw) * off, zoom, yaw);
    g.advance(0.4);
    return { ...best, x: edge.x, z: edge.z };
  }, { at, zoom, off, turn });
  console.log(`\n• close-up: ${info ? `${info.type} n=${info.n} at (${info.x.toFixed(0)},${info.z.toFixed(0)}) speed ${info.speed.toFixed(2)}` : 'no mounted unit found'}`);
  // Triangle attribution for whatever is on screen, so an over-budget frame names an owner.
  const attr = await page.evaluate(() => {
    const eng = window.__game.engine;
    const scene = eng.ctx.scene;
    const rows = new Map();
    const owner = (o) => {
      let n = o;
      while (n.parent && n.parent !== scene) n = n.parent;
      return n.name || n.type;
    };
    const visible = (o) => {
      let n = o;
      while (n) { if (!n.visible) return false; n = n.parent; }
      return true;
    };
    scene.traverse((o) => {
      if (!o.isMesh && !o.isLine && !o.isPoints) return;
      if (!visible(o)) return;
      const g = o.geometry;
      let tris = g?.index ? g.index.count / 3 : g?.attributes?.position ? g.attributes.position.count / 3 : 0;
      tris *= o.isInstancedMesh ? o.count : (g?.instanceCount ?? 1);
      const k = owner(o);
      const r = rows.get(k) ?? { draws: 0, tris: 0 };
      r.draws++; r.tris += tris;
      rows.set(k, r);
    });
    return {
      rows: [...rows.entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.tris - a.tris),
      frame: { draws: eng.ctx.renderer.info.render.calls, tris: eng.ctx.renderer.info.render.triangles },
    };
  });
  console.log(`  frame: ${attr.frame.draws} draws / ${(attr.frame.tris / 1e6).toFixed(2)}M tris (incl. shadow passes)`);
  for (const r of attr.rows.slice(0, 10)) {
    console.log(`    ${String(r.draws).padStart(4)} draws  ${(r.tris / 1000).toFixed(0).padStart(8)}k tris  ${r.k}`);
  }
  await page.evaluate(() => {
    const h = document.getElementById('hud');
    if (h) h.style.display = 'none';
    for (const el of document.querySelectorAll('#hud, .hud, #ui, #ui-root')) el.style.display = 'none';
  });
  await writeFile(SHOT, await page.screenshot({ type: 'png' }));
  console.log(`  wrote ${SHOT}`);
}

// ---------------------------------------------------------------------------
// Per-LOD instance counts. Settles "which tier is the triangle spike in" in one shot.
// ---------------------------------------------------------------------------
if (args.get('lod')) {
  const CASES = [
    { name: 'marching   (romanline t+2)', at: 2, zoom: 0.36, follow: 'romanFront' },
    { name: 'melee      (contact t+94)', at: 94, zoom: 0.30, follow: 'contact' },
    { name: 'rout       (routing unit)', at: 150, zoom: 0.55, follow: 'rout' },
    { name: 'rout close (routing unit)', at: 150, zoom: 0.30, follow: 'rout' },
    { name: 'cavalry    (graded shot)', at: 150, zoom: 0.42, x: 97, z: -23, yaw: Math.PI * 1.6 },
    // The frame the 15-shot pass never renders: wide camera, late, mid-collapse. Measured
    // 18.30 M against a 16 M budget by `shoot.mjs --shots=routC`, and it gets *worse* as men
    // die, which rules out headcount as the cause and needs an owner named.
    { name: 'rout wide  (over budget)', at: 171, zoom: 0.60, x: 0, z: 60, yaw: Math.PI * 0.82 },
  ];
  console.log('\n=== per-LOD instance counts and soldier triangles, 1600x900 ===');
  let prev = 0;
  for (const c of CASES) {
    const r = await page.evaluate(async ({ c, prev }) => {
      const g = window.__game;
      const b = g.battle;
      if (c.at > prev) g.advance(c.at - prev);
      // Resolve the focus the same way the shot harness does: on the live formation.
      let fx = 0;
      let fz = 0;
      let n = 0;
      const want = (u) => {
        if (c.follow === 'rout') return u.routTimer > 0;
        if (c.follow === 'romanFront') return u.faction === 0 && u.routTimer <= 0;
        return true;
      };
      let best = null;
      for (const u of b.units) {
        if (!want(u)) continue;
        let m = 0;
        let sx = 0;
        let sz = 0;
        for (const i of u.members) {
          if (!b.pool.aliveAt(i)) continue;
          m++; sx += b.pool.x[i]; sz += b.pool.z[i];
        }
        if (m < 20) continue;
        if (c.follow === 'contact') { fx += sx / m; fz += sz / m; n++; continue; }
        if (!best || m > best.m) best = { m, x: sx / m, z: sz / m };
      }
      if (best) { fx = best.x; fz = best.z; n = 1; }
      if (c.x !== undefined) { fx = c.x; fz = c.z; n = 1; }
      if (!n) return null;
      g.setCamera(fx / n, fz / n, c.zoom, c.yaw ?? Math.PI);
      g.advance(0.35);
      g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);

      const tiers = [];
      g.engine.ctx.scene.traverse((o) => {
        if (!o.isMesh || !/soldiers|horses/.test(o.name)) return;
        const gm = o.geometry;
        const per = gm.index ? gm.index.count / 3 : gm.attributes.position.count / 3;
        tiers.push({ name: o.name, per, count: gm.instanceCount ?? 0, vis: !!o.visible });
      });
      const states = {};
      let routing = 0;
      for (let i = 0; i < b.pool.count; i++) {
        const s = b.pool.state[i];
        states[s] = (states[s] ?? 0) + 1;
        if (s === 12) routing++;
      }
      // Attribution by top-level scene node, so an over-budget frame names an owner.
      const scene = g.engine.ctx.scene;
      const rows = new Map();
      const visible = (o) => { let m = o; while (m) { if (!m.visible) return false; m = m.parent; } return true; };
      const owner = (o) => { let m = o; while (m.parent && m.parent !== scene) m = m.parent; return m.name || m.type; };
      scene.traverse((o) => {
        if (!o.isMesh && !o.isLine && !o.isPoints) return;
        if (!visible(o)) return;
        const gm = o.geometry;
        let t = gm?.index ? gm.index.count / 3 : gm?.attributes?.position ? gm.attributes.position.count / 3 : 0;
        t *= o.isInstancedMesh ? o.count : (gm?.instanceCount ?? 1);
        const k = owner(o);
        const rec = rows.get(k) ?? { draws: 0, tris: 0 };
        rec.draws++; rec.tris += t;
        rows.set(k, rec);
      });
      const info = g.engine.renderer.info.render;
      return {
        tiers, routing,
        attr: [...rows.entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.tris - a.tris).slice(0, 8),
        frameDraws: info.calls, frameTris: info.triangles,
        focus: [Math.round(fx / n), Math.round(fz / n)],
      };
    }, { c, prev });
    prev = Math.max(prev, c.at);
    if (!r) { console.log(`  ${c.name}: no matching unit`); continue; }
    const soldierTris = r.tiers.reduce((a, t) => a + t.per * t.count, 0);
    console.log(`\n  ${c.name}  focus (${r.focus.join(',')})  routing ${r.routing}`);
    console.log(`    whole frame ${r.frameDraws} draws / ${(r.frameTris / 1e6).toFixed(2)}M tris` +
      `    soldier geometry ${(soldierTris / 1e6).toFixed(2)}M tris`);
    for (const t of r.tiers) {
      if (!t.count) continue;
      console.log(`      ${t.name.padEnd(26)} ${String(t.per).padStart(6)} tris x ${String(t.count).padStart(5)} = ` +
        `${((t.per * t.count) / 1e6).toFixed(2)}M`);
    }
    console.log('    whole-frame attribution by owner:');
    for (const a of r.attr) {
      console.log(`      ${String(a.draws).padStart(4)} draws ${((a.tris) / 1e6).toFixed(2).padStart(7)}M  ${a.k}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Frame cost, measured as the *minimum* over many blocks.
//
// shoot.mjs times one block of 30 frames, which on a machine running other work reports
// anything from 8 to 22 ms for the same scene — useless for a before/after. The minimum over
// ten blocks is the cost when nothing else is competing, which is the number a change is
// actually responsible for.
// ---------------------------------------------------------------------------
if (args.get('perf')) {
  const CAMS = [
    { name: 'cavalry', x: 97, z: -23, zoom: 0.42, yaw: 0, at: 62 },
    { name: 'melee', x: -29, z: -37, zoom: 0.30, yaw: 0, at: 88 },
  ];
  let prev = 0;
  console.log('\n=== frame cost, min of 10 blocks of 30 frames, 1600x900 ===');
  for (const c of CAMS) {
    const r = await page.evaluate(async ({ c, prev }) => {
      const g = window.__game;
      if (c.at > prev) g.advance(c.at - prev);
      g.setCamera(c.x, c.z, c.zoom, c.yaw);
      g.advance(0.4);
      const gl = g.engine.renderer.getContext();
      const px = new Uint8Array(4);
      const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const N = 30;
      const blocks = [];
      for (let b = 0; b < 10; b++) {
        g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
        sync();
        const t0 = performance.now();
        for (let i = 0; i < N; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
        sync();
        blocks.push((performance.now() - t0) / N);
      }
      blocks.sort((a, b) => a - b);
      const info = g.engine.renderer.info.render;
      let soldierDraws = 0;
      let soldierTris = 0;
      g.engine.ctx.scene.traverse((o) => {
        if (!o.isMesh || !o.visible || !/soldiers|horses/.test(o.name)) return;
        const gm = o.geometry;
        if (!gm?.instanceCount) return;
        soldierDraws++;
        soldierTris += (gm.index ? gm.index.count / 3 : gm.attributes.position.count / 3) * gm.instanceCount;
      });
      return {
        min: blocks[0], med: blocks[5], max: blocks[9],
        draws: info.calls, tris: info.triangles, soldierDraws, soldierTris,
      };
    }, { c, prev });
    prev = Math.max(prev, c.at);
    console.log(`  ${c.name.padEnd(10)} min ${f(r.min, 6, 2)} ms   median ${f(r.med, 6, 2)} ms   max ${f(r.max, 6, 2)} ms   ` +
      `${r.draws} draws  ${(r.tris / 1e6).toFixed(2)}M tris  |  soldier ${r.soldierDraws} draws ${(r.soldierTris / 1e6).toFixed(2)}M tris`);
  }
}

if (errors.length) console.log('\nPAGE ERRORS:\n' + errors.join('\n'));
await browser.close();
if (server) server.kill('SIGTERM');
