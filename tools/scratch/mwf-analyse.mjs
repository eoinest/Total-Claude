#!/usr/bin/env node
/**
 * Read a `mwf-trace` dump and answer three questions with numbers:
 *   1. time from contact-at-the-wall to rout, per attacker unit;
 *   2. which morale term carried the fall, integrated over that window;
 *   3. whether the trace is self-consistent — does the sum of the reported terms
 *      actually account for the morale the unit lost?
 *
 * (3) is not optional. `moraleTerms` reports instantaneous pressure while the applied
 * value is low-passed and rate-limited, and one-shot contagion shocks appear in no term
 * at all. The residual is printed so a term share can be read as what it is.
 */
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const FILE = args.get('in') ?? '/tmp/mwf-trace.json';
const ONLY = args.get('unit') ? Number(args.get('unit')) : null;
const FAC = args.get('fac') ? Number(args.get('fac')) : null;
const DUMP = args.has('dump');

const d = JSON.parse(await readFile(FILE, 'utf8'));
const C = Object.fromEntries(d.cols.map((c, i) => [c, i]));
const W = d.cols.length;
const TERMS = ['attrition', 'casualties', 'flanked', 'exchange', 'cavalry', 'fatigue',
  'missiles', 'witness', 'ground', 'army'];
const fmt = (n, p = 2) => (Number.isFinite(n) ? n.toFixed(p) : 'na');
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo); };

for (const run of d.runs) {
  console.log(`\n=== seed ${run.seed}  map ${d.map}  q ${d.quality}  `
    + `t=${d.until}s  stride=${d.stride} ticks ===`);
  const byUnit = new Map();
  for (let o = 0; o < run.rows.length; o += W) {
    const id = run.rows[o + C.id];
    if (!byUnit.has(id)) byUnit.set(id, []);
    byUnit.get(id).push(run.rows.subarray ? run.rows.subarray(o, o + W) : run.rows.slice(o, o + W));
  }
  const meta = new Map(run.meta.units.map((u) => [u.id, u]));
  const ramUnits = new Set((run.meta.rams ?? []).map((r) => r.unitId));
  const ladderUnits = new Set((run.meta.ladders ?? []).map((l) => l.unitId));
  const towerUnits = new Set((run.meta.towers ?? []).map((t) => t.unitId));

  const rows = [];
  for (const [id, series] of [...byUnit].sort((a, b) => a[0] - b[0])) {
    if (ONLY !== null && id !== ONLY) continue;
    const m = meta.get(id) ?? {};
    if (FAC !== null && m.faction !== FAC) continue;
    // --- contact, three independent definitions -----------------------------
    let tFire = null, tMelee = null, tNearWall = null, tRout = null, tBroken = null;
    let minOff = Infinity;
    for (const r of series) {
      const t = r[C.t];
      if (tFire === null && r[C.missPulse] > 0.5) tFire = t;
      if (tMelee === null && r[C.engagedFrac] > 0.02) tMelee = t;
      const off = r[C.wallDist];
      if (off > -50 && off < minOff) minOff = off;
      if (tNearWall === null && r[C.wallSide] > 0 && off < 14 && off > -50) tNearWall = t;
      if (tRout === null && r[C.order] === 5) tRout = t;
      if (tBroken === null && r[C.band] === 2) tBroken = t;
    }
    const start = tFire ?? tNearWall ?? tMelee;
    // --- integrate the terms over the window that ends at the rout ----------
    const acc = Object.fromEntries([...TERMS, 'recovery'].map((k) => [k, 0]));
    let dtTot = 0, mStart = null, mEnd = null, n = 0;
    let aliveStart = null, aliveEnd = null, missTot = 0, casTot = 0, killTot = 0;
    const stride = d.stride / 30;
    for (const r of series) {
      const t = r[C.t];
      if (start === null || t < start) continue;
      if (tRout !== null && t > tRout) break;
      if (mStart === null) { mStart = r[C.morale]; aliveStart = r[C.alive]; }
      mEnd = r[C.morale]; aliveEnd = r[C.alive];
      for (const k of TERMS) acc[k] += r[C[k]] * stride;
      acc.recovery += r[C.recovery] * stride;
      missTot += r[C.missPulse]; casTot += r[C.casPulse]; killTot += r[C.killPulse];
      dtTot += stride; n++;
    }
    const pressure = TERMS.reduce((s, k) => s + acc[k], 0);
    const predicted = acc.recovery - pressure;                  // pts, unlimited
    const actual = mEnd !== null && mStart !== null ? mEnd - mStart : NaN;
    rows.push({ id, type: m.typeId, init: m.init, disc: m.discipline, maxMorale: m.maxMorale,
      role: ramUnits.has(id) ? 'ram' : ladderUnits.has(id) ? 'ladder'
        : towerUnits.has(id) ? 'tower' : '-',
      tFire, tMelee, tNearWall, tRout, tBroken, minOff: minOff === Infinity ? null : minOff,
      window: dtTot, acc, pressure, predicted, actual,
      aliveStart, aliveEnd, missTot: missTot * stride, casTot: casTot * stride,
      killTot: killTot * stride, series });
  }

  // ---- time-from-contact-to-rout ----
  console.log('\n-- attacker units: contact -> rout --');
  console.log('  id role   type              N0   disc  tFire tWall tMelee tRout  ttr(fire) ttr(wall)  alive@rout  minOff');
  const ttrFire = [], ttrWall = [];
  for (const r of rows) {
    const tf = r.tFire, tw = r.tNearWall, tr = r.tRout;
    const a = tr !== null && tf !== null ? tr - tf : null;
    const bq = tr !== null && tw !== null ? tr - tw : null;
    if (a !== null) ttrFire.push(a);
    if (bq !== null) ttrWall.push(bq);
    console.log(`  ${String(r.id).padStart(2)} ${r.role.padEnd(6)} ${String(r.type).padEnd(17)}`
      + `${String(r.init).padStart(4)} ${fmt(r.disc)} `
      + `${String(r.tFire === null ? '-' : r.tFire.toFixed(0)).padStart(5)} `
      + `${String(r.tNearWall === null ? '-' : r.tNearWall.toFixed(0)).padStart(5)} `
      + `${String(r.tMelee === null ? '-' : r.tMelee.toFixed(0)).padStart(6)} `
      + `${String(r.tRout === null ? '-' : r.tRout.toFixed(0)).padStart(5)} `
      + `${String(a === null ? '-' : a.toFixed(1)).padStart(10)} `
      + `${String(bq === null ? '-' : bq.toFixed(1)).padStart(9)} `
      + `${String(r.aliveEnd ?? '-').padStart(11)} ${fmt(r.minOff, 1).padStart(7)}`);
  }
  const stat = (a, name) => a.length
    ? console.log(`  ${name}: n=${a.length} min=${fmt(Math.min(...a), 1)} `
      + `p25=${fmt(q(a, 0.25), 1)} median=${fmt(q(a, 0.5), 1)} p75=${fmt(q(a, 0.75), 1)} `
      + `max=${fmt(Math.max(...a), 1)}`)
    : console.log(`  ${name}: none`);
  stat(ttrFire, 'time-to-rout from first missile hit (s)');
  stat(ttrWall, 'time-to-rout from arriving at the wall (s)');

  // ---- per-term integrals ----
  console.log('\n-- morale points contributed over [contact, rout], after discipline --');
  console.log('  id  ' + TERMS.map((t) => t.slice(0, 6).padStart(7)).join('') + '   recov'
    + '    press   pred    actual  resid   win_s  dead');
  for (const r of rows) {
    if (r.window <= 0) continue;
    console.log(`  ${String(r.id).padStart(2)} `
      + TERMS.map((k) => fmt(r.acc[k], 1).padStart(7)).join('')
      + fmt(r.acc.recovery, 1).padStart(8)
      + fmt(r.pressure, 1).padStart(9) + fmt(r.predicted, 1).padStart(8)
      + fmt(r.actual, 1).padStart(9)
      + fmt(r.actual - r.predicted, 1).padStart(8)
      + fmt(r.window, 0).padStart(7)
      + String((r.aliveStart ?? 0) - (r.aliveEnd ?? 0)).padStart(6));
  }

  // ---- mean rates in the last 20 s before the rout ----
  console.log('\n-- mean pressure rate (pts/s) over the last 20 s before rout --');
  console.log('  id  ' + TERMS.map((t) => t.slice(0, 6).padStart(7)).join('') + '   recov'
    + '   netfall  cap?  engFrac flkFrac rearF surr nearE  missP  casP  killP  alive%');
  for (const r of rows) {
    if (r.tRout === null) continue;
    const win = r.series.filter((x) => x[C.t] > r.tRout - 20 && x[C.t] <= r.tRout);
    if (!win.length) continue;
    const mean = (k) => win.reduce((s, x) => s + x[C[k]], 0) / win.length;
    const press = TERMS.reduce((s, k) => s + mean(k), 0);
    const net = mean('recovery') - press;
    console.log(`  ${String(r.id).padStart(2)} `
      + TERMS.map((k) => fmt(mean(k)).padStart(7)).join('')
      + fmt(mean('recovery')).padStart(8) + fmt(net).padStart(9)
      + (net < -5 ? '  YES' : '   no')
      + fmt(mean('engagedFrac')).padStart(9) + fmt(mean('flankedFrac')).padStart(8)
      + fmt(mean('rearFrac')).padStart(6) + fmt(mean('surrounded')).padStart(5)
      + fmt(mean('nearestEnemy'), 0).padStart(6)
      + fmt(mean('missPulse'), 1).padStart(7) + fmt(mean('casPulse'), 1).padStart(6)
      + fmt(mean('killPulse'), 1).padStart(7)
      + fmt(100 * mean('alive') / (r.init || 1), 0).padStart(7));
  }

  if (DUMP) {
    for (const r of rows) {
      if (r.tRout === null) continue;
      console.log(`\n-- unit ${r.id} ${r.type} full trace around rout t=${r.tRout.toFixed(1)} --`);
      console.log('    t  alive  mor band ord | ' + TERMS.map((x) => x.slice(0, 5).padStart(6)).join('')
        + '  recov |  engF  flkF rearF surr  nearE frontG  missP  casP killP  wallOff  y');
      for (const x of r.series) {
        if (x[C.t] < r.tRout - 45 || x[C.t] > r.tRout + 5) continue;
        console.log(`${fmt(x[C.t], 1).padStart(6)}${String(x[C.alive]).padStart(6)}`
          + fmt(x[C.morale], 1).padStart(6) + String(x[C.band]).padStart(4)
          + String(x[C.order]).padStart(4) + ' |'
          + TERMS.map((k) => fmt(x[C[k]], 1).padStart(6)).join('')
          + fmt(x[C.recovery], 1).padStart(7) + ' |'
          + fmt(x[C.engagedFrac]).padStart(6) + fmt(x[C.flankedFrac]).padStart(6)
          + fmt(x[C.rearFrac]).padStart(6) + String(x[C.surrounded]).padStart(4)
          + fmt(x[C.nearestEnemy], 0).padStart(7) + fmt(x[C.frontGap], 0).padStart(7)
          + fmt(x[C.missPulse], 1).padStart(7) + fmt(x[C.casPulse], 1).padStart(6)
          + fmt(x[C.killPulse], 1).padStart(6) + fmt(x[C.wallDist], 1).padStart(9)
          + fmt(x[C.y], 1).padStart(6));
      }
    }
  }

  // ---- rout event log ----
  console.log('\n-- rout / rally events --');
  for (const e of run.routs) {
    console.log(`  t=${e.t.toFixed(1)} unit=${e.unitId} ${e.rally ? 'RALLY' : 'ROUT'}`
      + ` ${meta.get(e.unitId)?.typeId ?? '?'} fac=${meta.get(e.unitId)?.faction ?? '?'}`);
  }
  if (run.siege) console.log('\n-- siege:', JSON.stringify(run.siege));
  if (run.errs?.length) console.log('-- page errors:', run.errs.slice(0, 5));
}
