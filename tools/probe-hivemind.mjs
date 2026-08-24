#!/usr/bin/env node
/**
 * Probe: is the crowd one organism, or nine thousand men?
 *
 * The owner's report is that troops "sway left and right magically along some sort of
 * function" and keep geometric shapes in a melee. Both halves of that are measurable, and
 * neither is measurable from a screenshot, so this measures them.
 *
 * It records every living man's position for a window of ticks and reports, per case:
 *
 * **coherence R** — the length of the mean per-tick displacement over the mean length of the
 *   per-tick displacements. If every man steps the same way at the same moment the two are
 *   equal and R = 1: one organism. If each man moves for his own reasons the vector sum
 *   cancels and R goes towards 1/sqrt(n). This is the number the report is about.
 *
 * **latticeStd** — the standard deviation of nearest-neighbour distance. A crowd resolved to
 *   a fixed separation has a small one; men standing where they chose to have a large one.
 *
 * **frontStd** — the RMS deviation of the contact line from the straight line fitted through
 *   it. This is "two lines meeting stay a rectangle" as a number, in metres.
 *
 * **period** — the dominant period of the unit-mean lateral offset, by autocorrelation. A
 *   real crowd has no one period; a crowd driven by a function does.
 *
 * Usage:
 *   node tools/probe-hivemind.mjs --port=5610 [--json=path] [--label=before]
 */

import { writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from './lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5610);
const JSON_OUT = args.get('json') ?? null;
const LABEL = args.get('label') ?? '';

let rev = 'unknown';
try {
  rev = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  if (execSync('git status --porcelain -- src/', { cwd: ROOT }).toString().trim()) rev += '+dirty';
} catch { /* not a checkout */ }

const { base, close: closeServer } = await startVite({ port: PORT, root: ROOT });
const browser = await launchBrowser({ label: 'probe-hivemind', port: PORT, root: ROOT });

const HELPERS = `
window.__hm = (() => {
  const g = window.__game, b = g.battle, ctx = g.engine.context, p = b.pool;
  const DEAD = 11, DYING = 10;
  const alive = (i) => p.state[i] !== DEAD && p.state[i] !== DYING;
  const teardown = async () => {
    for (const u of b.units) {
      if (u.destroyed) continue;
      for (const i of u.members) if (alive(i)) p.setState(i, DEAD);
      u.alive = 0; u.destroyed = true;
    }
    const shared = await import('/src/sim/combatShared.ts');
    shared.resetCombatShared();
    const mor = ctx.tryGet('morale');
    if (mor && mor.redeploy) mor.redeploy();
    for (const name of ['tactical-ai', 'general-ai', 'battleFlow', 'projectiles']) {
      const s = ctx.tryGet(name);
      if (s && s.fixedUpdate) s.fixedUpdate = () => {};
    }
    for (const s of (g.engine.systems || g.engine.subsystems || [])) {
      for (const hook of ['update', 'preRender', 'resize']) {
        const fn = s[hook];
        if (typeof fn !== 'function') continue;
        const bound = fn.bind(s);
        s[hook] = (...a) => { try { return bound(...a); } catch (e) { /* shielded */ } };
      }
    }
  };
  return { g, b, ctx, p, alive, teardown };
})();
`;

/** Everything below runs in the page. */
const CASES = `
window.__hmRun = async (spec) => {
  const H = window.__hm, { g, b, ctx, p } = H;
  await H.teardown();
  b.unitSizeScale = 1;

  const ids = [];
  for (const s of spec.spawn) ids.push(b.spawnUnit(s.type, s.x, s.z, s.facing, s.form));
  const units = ids.map((i) => b.unitById(i)).filter(Boolean);
  if (units.length !== spec.spawn.length) return { case: spec.id, error: 'spawn failed' };
  for (const u of units) if (u.alive < 50) return { case: spec.id, error: 'pool exhausted ' + u.alive };

  if (spec.halt) for (const u of units) ctx.events.emit('orderIssued', { unitIds: [u.id], kind: 'halt' });

  // Settle to the state we want to look at.
  if (spec.toContact) {
    let hit = -1;
    for (let t = 0; t < 40 && hit < 0; t++) { g.advance(1); if (units.some((u) => u.contactLock)) hit = t; }
    if (hit < 0) return { case: spec.id, error: 'no contact in 40 s' };
    g.advance(spec.after ?? 30);
  } else {
    g.advance(spec.settle ?? 8);
  }

  const subject = units[0];
  const men = subject.members.filter(H.alive);
  const n = men.length;
  if (n < 30) return { case: spec.id, error: 'subject too small ' + n };

  // ---- sample the window, one row per tick -----------------------------------
  const TICKS = spec.ticks ?? 240;         // 8 s at 30 Hz
  const xs = new Float64Array(TICKS * n), zs = new Float64Array(TICKS * n);
  const stillAlive = new Uint8Array(TICKS * n);
  for (let t = 0; t < TICKS; t++) {
    g.advanceTicks(1);
    for (let k = 0; k < n; k++) {
      const i = men[k];
      xs[t * n + k] = p.x[i]; zs[t * n + k] = p.z[i];
      stillAlive[t * n + k] = H.alive(i) ? 1 : 0;
    }
  }

  // ---- coherence R -----------------------------------------------------------
  let sumMeanLen = 0, sumLenMean = 0;
  const lateral = [];               // unit-mean lateral offset, per tick
  const cos = Math.cos(subject.facing), sin = Math.sin(subject.facing);
  for (let t = 1; t < TICKS; t++) {
    let mx = 0, mz = 0, sl = 0, m = 0;
    for (let k = 0; k < n; k++) {
      if (!stillAlive[t * n + k] || !stillAlive[(t - 1) * n + k]) continue;
      const dx = xs[t * n + k] - xs[(t - 1) * n + k];
      const dz = zs[t * n + k] - zs[(t - 1) * n + k];
      mx += dx; mz += dz; sl += Math.sqrt(dx * dx + dz * dz); m++;
    }
    if (m < 10) continue;
    mx /= m; mz /= m; sl /= m;
    sumMeanLen += Math.sqrt(mx * mx + mz * mz);
    sumLenMean += sl;
    // lateral component of the unit centroid, in the unit's frame
    let cx = 0, cz = 0, c = 0;
    for (let k = 0; k < n; k++) {
      if (!stillAlive[t * n + k]) continue;
      cx += xs[t * n + k]; cz += zs[t * n + k]; c++;
    }
    lateral.push((cx / c) * cos - (cz / c) * sin);
  }
  const R = sumLenMean > 1e-9 ? sumMeanLen / sumLenMean : 0;

  // ---- dominant period of the unit-mean lateral offset, by autocorrelation ----
  const detrend = (() => {
    const L = lateral.length;
    if (L < 30) return [];
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < L; i++) { sx += i; sy += lateral[i]; sxx += i * i; sxy += i * lateral[i]; }
    const den = L * sxx - sx * sx;
    const slope = den !== 0 ? (L * sxy - sx * sy) / den : 0;
    const a = (sy - slope * sx) / L;
    return lateral.map((v, i) => v - (a + slope * i));
  })();
  // A smooth signal is most autocorrelated at the *shortest* lag you look at, so an argmax
  // over all lags reports the bottom of the search range and calls it a period. It did:
  // the first cut of this probe claimed a 0.10 s period at strength 0.95 on a melee, which
  // is a 3-tick oscillation nothing in the tick order could produce. A real period is the
  // first local maximum *after* the autocorrelation has gone negative once — the standard
  // pitch-detection guard — and if it never goes negative there is no period, only drift.
  const ac0 = detrend.reduce((s, v) => s + v * v, 0) / Math.max(1, detrend.length);
  const acAt = (lag) => {
    let s = 0;
    for (let i = 0; i + lag < detrend.length; i++) s += detrend[i] * detrend[i + lag];
    return ac0 > 1e-12 ? (s / Math.max(1, detrend.length - lag)) / ac0 : 0;
  };
  let bestLag = 0, bestAc = 0, wentNegative = false;
  for (let lag = 1; lag < Math.floor(detrend.length / 2); lag++) {
    const r = acAt(lag);
    if (r < 0) { wentNegative = true; continue; }
    if (wentNegative && r > bestAc) { bestAc = r; bestLag = lag; }
  }
  const swingAmp = detrend.length ? Math.max(...detrend.map(Math.abs)) : 0;

  // ---- lattice: nearest-neighbour distance across the whole field -------------
  const all = [];
  for (const u of b.units) if (!u.destroyed) for (const i of u.members) if (H.alive(i)) all.push(i);
  const nnd = [];
  for (const i of all) {
    let best = Infinity;
    for (const j of all) {
      if (j === i) continue;
      const dx = p.x[j] - p.x[i], dz = p.z[j] - p.z[i];
      const d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
    if (best < 100) nnd.push(Math.sqrt(best));
  }
  nnd.sort((a, c) => a - c);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
  const nndMean = mean(nnd);
  const nndStd = Math.sqrt(mean(nnd.map((d) => (d - nndMean) ** 2)));
  const med = nnd[Math.floor(nnd.length * 0.5)] ?? 0;
  const atFloor = nnd.filter((d) => Math.abs(d - med) < 0.02).length;

  // ---- front line straightness ------------------------------------------------
  const fr = [];
  const byFile = new Map();
  for (const i of subject.members) {
    if (!H.alive(i)) continue;
    const lx = p.x[i] * cos - p.z[i] * sin;
    const lz = p.x[i] * sin + p.z[i] * cos;
    const f = p.file[i];
    const cur = byFile.get(f);
    if (!cur || lz < cur.lz) byFile.set(f, { lx, lz });
  }
  for (const v of byFile.values()) fr.push(v);
  let frontStd = -1;
  const frontN = fr.length;
  if (fr.length >= 5) {
    const mx = mean(fr.map((v) => v.lx)), mz = mean(fr.map((v) => v.lz));
    let sxx = 0, sxz = 0;
    for (const v of fr) { sxx += (v.lx - mx) ** 2; sxz += (v.lx - mx) * (v.lz - mz); }
    const slope = sxx > 1e-9 ? sxz / sxx : 0;
    frontStd = Math.sqrt(mean(fr.map((v) => (v.lz - (mz + slope * (v.lx - mx))) ** 2)));
  }

  // ---- per-man speed spread ---------------------------------------------------
  const spd = [];
  for (let k = 0; k < n; k++) {
    let s = 0, c = 0;
    for (let t = 1; t < TICKS; t++) {
      if (!stillAlive[t * n + k] || !stillAlive[(t - 1) * n + k]) continue;
      const dx = xs[t * n + k] - xs[(t - 1) * n + k], dz = zs[t * n + k] - zs[(t - 1) * n + k];
      s += Math.sqrt(dx * dx + dz * dz) * 30; c++;
    }
    if (c) spd.push(s / c);
  }
  spd.sort((a, c) => a - c);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    case: spec.id, n, ticks: TICKS,
    R: r3(R),
    swingAmp: r3(swingAmp), periodS: bestLag ? r3(bestLag / 30) : 0, periodStrength: r3(bestAc),
    nnd: {
      n: nnd.length, mean: r3(nndMean), std: r3(nndStd),
      p05: r3(nnd[Math.floor(nnd.length * 0.05)] ?? 0), p50: r3(med),
      p95: r3(nnd[Math.floor(nnd.length * 0.95)] ?? 0),
      atFloorShare: r3(atFloor / Math.max(1, nnd.length)),
    },
    frontStd: r3(frontStd), frontN,
    speed: {
      p05: r3(spd[Math.floor(spd.length * 0.05)] ?? 0), p50: r3(spd[Math.floor(spd.length * 0.5)] ?? 0),
      p95: r3(spd[Math.floor(spd.length * 0.95)] ?? 0), mean: r3(mean(spd)),
    },
  };
};
`;

const SPECS = [
  {
    id: 'at-ease',
    spawn: [{ type: 'legio-cohort', x: 0, z: 0, facing: Math.PI, form: 'line' }],
    halt: true, settle: 8, ticks: 300,
  },
  {
    id: 'ordered-line',
    spawn: [{ type: 'legio-cohort', x: 0, z: 0, facing: Math.PI, form: 'line' }],
    halt: true, settle: 14, ticks: 120,
  },
  {
    id: 'ordered-testudo',
    spawn: [{ type: 'legio-cohort', x: 0, z: 0, facing: Math.PI, form: 'testudo' }],
    halt: true, settle: 14, ticks: 120,
  },
  {
    id: 'melee-30s',
    spawn: [
      { type: 'legio-cohort', x: 0, z: 2.5, facing: Math.PI, form: 'line' },
      { type: 'juthungi-warband', x: 0, z: -2.5, facing: 0, form: 'horde' },
    ],
    toContact: true, after: 30, ticks: 300,
  },
];

const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(300000);
await page.goto(`${base}/?harness=1&quality=high&autoplay=1&w=480&h=270`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, undefined, { timeout: 300000 });
await page.evaluate((s) => { new Function(s)(); }, HELPERS);
await page.evaluate((s) => { new Function(s)(); }, CASES);

console.log(`[probe-hivemind] tree ${rev}${LABEL ? ` — ${LABEL}` : ''}`);
const results = [];
for (const spec of SPECS) {
  const r = await page.evaluate((s) => window.__hmRun(s), spec);
  results.push(r);
  if (r.error) { console.log(`\n${r.case}: ERROR ${r.error}`); continue; }
  console.log(`\n=== ${r.case} — ${r.n} men in the subject unit, ${r.ticks} ticks ===`);
  console.log(`  coherence R        ${r.R.toFixed(3)}   (1 = one organism, ~${(1 / Math.sqrt(r.n)).toFixed(3)} = independent)`);
  console.log(`  lateral swing      ${r.swingAmp.toFixed(3)} m   period ${r.periodS.toFixed(2)} s   strength ${r.periodStrength.toFixed(3)}`);
  console.log(`  nearest neighbour  mean ${r.nnd.mean.toFixed(3)} m  std ${r.nnd.std.toFixed(3)}  p05/p50/p95 ${r.nnd.p05.toFixed(2)}/${r.nnd.p50.toFixed(2)}/${r.nnd.p95.toFixed(2)}  at floor ${(r.nnd.atFloorShare * 100).toFixed(0)}%`);
  console.log(`  front line RMS     ${r.frontStd.toFixed(3)} m over ${r.frontN} files`);
  console.log(`  per-man speed      p05 ${r.speed.p05.toFixed(3)}  p50 ${r.speed.p50.toFixed(3)}  p95 ${r.speed.p95.toFixed(3)} m/s`);
}
if (errors.length) console.log('\n[page errors]', errors.slice(0, 3));

await page.close();
await browser.close();
await closeServer();
if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify({ rev, label: LABEL, results }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
