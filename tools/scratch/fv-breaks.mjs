/**
 * Does "when the first unit broke" predict anything about the verdict? No, and here is the
 * number — because the coordinator's brief is built on two columns that say it does.
 *
 * The brief's puzzle: on the integration tree "Rome breaks later (+13.6%) and the enemy breaks
 * earlier (-5.8%) — and yet Rome wins less". Both halves come from `firstBreakUs` and
 * `firstBreakThem`, and both are assigned as `= s.t`, the time of the *sample* on which a
 * routing unit was first seen, on a `--step` grid of 10 s. (`jg-shape` has since fixed exactly
 * this for `at`, quoting its own "t+62.85, sd 0.15 s" as the sampling grid rather than the
 * battle; the two break columns and `contactAt` still carry it.)
 *
 * So this prints, per arm: the within-arm sd of each break column, the distinct values it takes,
 * and the Pearson correlation between the break times and the peak size of each side's rout
 * cascade — which is the quantity `BattleFlow` actually reads the verdict off.
 */
import { readFile } from 'node:fs/promises';

const pearson = (x, y) => {
  const n = x.length;
  if (n < 3) return NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy);
};
const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

for (const f of process.argv.slice(2)) {
  const d = JSON.parse(await readFile(f, 'utf8'));
  const ok = d.rows.filter((r) => !r.error);
  const bu = ok.map((r) => r.firstBreakUs), bt = ok.map((r) => r.firstBreakThem);
  const pf = ok.map((r) => (r.curve ?? []).reduce((m, c) => Math.max(m, c.theirRouting), 0));
  const pm = ok.map((r) => (r.curve ?? []).reduce((m, c) => Math.max(m, c.myRouting), 0));
  const win = ok.map((r) => (r.verdict === 'Victory' ? 1 : 0));
  const buckets = (a) => [...new Set(a.map((v) => Math.round(v / 10) * 10))].sort((x, y) => x - y).join(',');
  console.log(`\n${d.tag}  n=${ok.length}  wins ${win.reduce((a, b) => a + b, 0)}`);
  console.log(`  firstBreakUs   mean ${(bu.reduce((a, b) => a + b, 0) / bu.length).toFixed(2)} sd ${sd(bu).toFixed(2)}  10 s buckets used: {${buckets(bu)}}`);
  console.log(`  firstBreakThem mean ${(bt.reduce((a, b) => a + b, 0) / bt.length).toFixed(2)} sd ${sd(bt).toFixed(2)}  10 s buckets used: {${buckets(bt)}}`);
  console.log(`  r(firstBreakUs, Rome peak cascade)  ${pearson(bu, pm).toFixed(2)}    r(firstBreakUs, win) ${pearson(bu, win).toFixed(2)}`);
  console.log(`  r(firstBreakThem, foe peak cascade) ${pearson(bt, pf).toFixed(2)}    r(firstBreakThem, win) ${pearson(bt, win).toFixed(2)}`);
  console.log(`  r(foe peak cascade, win)            ${pearson(pf, win).toFixed(2)}   <- the one that carries the verdict`);
}
