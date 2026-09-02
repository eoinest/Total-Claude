#!/usr/bin/env node
/**
 * mon-corridor — what a monument in a carriageway actually costs, in the units of the harm.
 *
 * `probe-fabric` G4 measures monument area inside a way's ribbon and gates it at zero. Rome
 * reads **12,731 m² over 24 segments and 10 monuments**, and that number cannot distinguish
 * the two cases it is made of:
 *
 *   - a temple clipping 2 m off the edge of a 42 m artery over 60 m of its length — 120 m²,
 *     and 40 m of corridor still passes the cohort the artery exists for;
 *   - a bath block standing across the middle of a 24 m secondary — the same area, and the
 *     way does not exist any more.
 *
 * `WAY_WIDTH`'s own comment says what the widths are for: *"artery: a cohort in line, 35 m,
 * with 3.5 m either side"*, *"secondary: two columns abreast"*, *"local: one column of about
 * 16 files"*, *"vicus: men in file"*. So the question with the units of the harm is **how much
 * clear corridor is left**, station by station, and that question is frame-honest in a way the
 * area is not: `MAP-METHOD.md` rule 4 — positions compress by `KX`/`KZ`, cross-sections do
 * not — so a way's width and a monument's footprint are both true world metres, and only
 * their *separation* carries the projection's bill.
 *
 * This walks every authored way at 2 m and reports, per way:
 *   - the narrowest clear corridor anywhere on it, and where;
 *   - how much of its length is SEVERED, meaning no clear lane of any width;
 *   - the clear-width distribution, so a threshold can be argued about with a picture.
 *
 * Two rulers, both printed, because they have different owners (rule 25): the monument's own
 * **collision box** (what the game collides with) and its **reserved footprint** (the box
 * times `PRECINCT`, which is the apron a man may walk on but a formation should not have to).
 *
 *   node --experimental-strip-types --import ./tools/lib/ts-resolve.mjs \
 *     tools/scratch/mon-corridor.mjs [--step=2]
 */
import '../../src/terrain/topography.ts';
import '../../src/city/rome/survey.ts';
import '../../src/city/rome/apertures.ts';
import '../../src/city/rome/section.ts';
import '../../src/city/rome/monuments.ts';
import '../../src/city/rome/ways.ts';
import '../../src/city/rome/layout.ts';

import process from 'node:process';
import { LANDMARKS, PRECINCT, WAYS, WAY_WIDTH } from '../../src/city/rome/layout.ts';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit === undefined ? d : hit.slice(k.length + 3);
};
const STEP = Number(arg('step', '2'));

/** What each rank's width is FOR, from `WAY_WIDTH`'s own comment. Not a new constant. */
const FORMATION = {
  artery: 35,      // "a cohort in line, 35 m, with 3.5 m either side"
  secondary: 24,   // "two columns abreast" — the whole width is the claim
  local: 14,       // "one column of about 16 files"
  vicus: 8,        // "men in file"
};

function boxesAt(scale) {
  return LANDMARKS.filter((l) => !l.soft).map((l) => ({
    id: l.id, name: l.name, x: l.x, z: l.z, rot: l.rot,
    hw: (l.hw / PRECINCT) * scale, hd: (l.hd / PRECINCT) * scale,
  })).map((b) => ({ ...b, reach: b.hw + b.hd }));
}

/**
 * The blocked interval of the cross-section at one station, per monument.
 *
 * A rotated rectangle's intersection with a line is an interval, and this computes it exactly
 * rather than by sampling — the whole point of the exercise is not to repeat the fault the
 * paving guard had (rule 36). Clip the offset axis against the box's four half-space slabs.
 */
function blockedInterval(b, cx, cz, nx, nz) {
  const cs = Math.cos(b.rot);
  const sn = Math.sin(b.rot);
  // Station and direction in the box's own frame.
  const dx = cx - b.x;
  const dz = cz - b.z;
  const pu = dx * cs - dz * sn;
  const pv = dx * sn + dz * cs;
  const du = nx * cs - nz * sn;
  const dv = nx * sn + nz * cs;
  let lo = -Infinity;
  let hi = Infinity;
  for (const [p, d, h] of [[pu, du, b.hw], [pv, dv, b.hd]]) {
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(p) > h) return null;   // parallel and outside: never blocked
      continue;
    }
    const t0 = (-h - p) / d;
    const t1 = (h - p) / d;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
  }
  if (!(hi > lo)) return null;
  return [lo, hi];
}

/** The widest clear run of [-half, half] once every blocked interval is removed. */
function widestClear(half, blocked) {
  const iv = blocked
    .map(([a, b]) => [Math.max(a, -half), Math.min(b, half)])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  let best = 0;
  let cur = -half;
  for (const [a, b] of iv) {
    if (a > cur) best = Math.max(best, a - cur);
    cur = Math.max(cur, b);
  }
  best = Math.max(best, half - cur);
  return best;
}

function measure(scale, label) {
  const boxes = boxesAt(scale);
  const rows = [];
  let severedTotal = 0;
  let lenTotal = 0;
  for (const w of WAYS) {
    const half = w.width * 0.5;
    const want = FORMATION[w.cls] ?? w.width;
    let len = 0;
    let severed = 0;
    let below = 0;
    let worst = Infinity;
    let worstAt = null;
    const widths = [];
    const culprits = new Map();
    for (let s = 0; s + 1 < w.path.length; s++) {
      const a = w.path[s];
      const b = w.path[s + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-6) continue;
      const dx = (b.x - a.x) / L;
      const dz = (b.z - a.z) / L;
      const nx = -dz;
      const nz = dx;
      const n = Math.max(1, Math.round(L / STEP));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const cx = a.x + (b.x - a.x) * t;
        const cz = a.z + (b.z - a.z) * t;
        const seg = L / n;
        len += seg;
        const blocked = [];
        for (const bx of boxes) {
          const ddx = cx - bx.x;
          const ddz = cz - bx.z;
          if (ddx * ddx + ddz * ddz > (bx.reach + half) * (bx.reach + half)) continue;
          const iv = blockedInterval(bx, cx, cz, nx, nz);
          if (iv && iv[1] > -half && iv[0] < half) {
            blocked.push(iv);
            culprits.set(bx.id, (culprits.get(bx.id) ?? 0) + seg);
          }
        }
        const clear = widestClear(half, blocked);
        widths.push(clear);
        if (clear < worst) { worst = clear; worstAt = { x: cx, z: cz }; }
        if (clear <= 0.01) severed += seg;
        if (clear < want) below += seg;
      }
    }
    if (len === 0) continue;
    widths.sort((p, q) => p - q);
    const q = (f) => widths[Math.min(widths.length - 1, Math.floor(f * (widths.length - 1)))];
    lenTotal += len;
    severedTotal += severed;
    rows.push({
      id: w.id, cls: w.cls, width: w.width, want, lenM: len,
      severedM: severed, belowM: below,
      worstM: worst === Infinity ? half : worst, worstAt,
      p05: q(0.05), p50: q(0.5),
      culprits: [...culprits].sort((p, r) => r[1] - p[1]),
    });
  }
  rows.sort((p, q2) => q2.belowM - p.belowM);
  const pad = (s, n) => String(s).padEnd(n);
  const num = (v, n, d = 1) => String(typeof v === 'number' ? v.toFixed(d) : v).padStart(n);
  console.log(`\n=== ${label} (scale ${scale}) ===`);
  console.log(`${pad('way', 22)}${pad('cls', 11)}${num('w', 5, 0)}${num('needs', 7, 0)}${num('len', 8)}${num('worst', 7)}${num('p05', 7)}${num('p50', 7)}${num('severed', 9)}${num('<needs', 9)}`);
  console.log('-'.repeat(94));
  for (const r of rows) {
    console.log(`${pad(r.id, 22)}${pad(r.cls, 11)}${num(r.width, 5, 0)}${num(r.want, 7, 0)}${num(r.lenM, 8)}`
      + `${num(r.worstM, 7)}${num(r.p05, 7)}${num(r.p50, 7)}${num(r.severedM, 9)}${num(r.belowM, 9)}`
      + (r.culprits.length ? `   ${r.culprits.slice(0, 3).map(([id, m]) => `${id} ${m.toFixed(0)}m`).join(', ')}` : ''));
  }
  const totalBelow = rows.reduce((s, r) => s + r.belowM, 0);
  console.log(`\n  ${lenTotal.toFixed(0)} m of authored way; ${severedTotal.toFixed(0)} m SEVERED (no clear lane at all)`
    + `; ${totalBelow.toFixed(0)} m below its own rank's formation width`);
  console.log(`  ways severed anywhere: ${rows.filter((r) => r.severedM > 0).length} of ${rows.length}`
    + ` [${rows.filter((r) => r.severedM > 0).map((r) => `${r.id} ${r.severedM.toFixed(0)}m`).join(', ')}]`);
  return { rows, severedTotal, lenTotal, totalBelow };
}

console.log('mon-corridor — how much of each way a monument actually takes away');
console.log(`step ${STEP} m; ${WAYS.length} authored ways; formation widths from WAY_WIDTH's own comment:`);
console.log(`  ${Object.entries(FORMATION).map(([k, v]) => `${k} ${WAY_WIDTH[k]} m wide, needs ${v} m`).join('; ')}`);

const box = measure(1, 'against the COLLISION BOX — what the game collides with');
const res = measure(PRECINCT, 'against the RESERVED footprint — box x PRECINCT, the apron too');

console.log('\n---- the reading ----');
console.log(`  severed length, collision box:      ${box.severedTotal.toFixed(0)} m of ${box.lenTotal.toFixed(0)}`);
console.log(`  severed length, reserved footprint: ${res.severedTotal.toFixed(0)} m of ${res.lenTotal.toFixed(0)}`);
console.log(`  below own formation width, box:     ${box.totalBelow.toFixed(0)} m`);
console.log(`  below own formation width, reserved:${res.totalBelow.toFixed(0)} m`);
