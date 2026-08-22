/**
 * The one test the shape comparator does not have: **did the distribution CONTRACT?**
 *
 * `jg-compare` asks two questions about a change — did the mean move (sign test across seeds)
 * and does the new mean clear the old range. Both are about *location*. "The battle lost its
 * outcome variety" is a claim about *dispersion*, and a distribution can contract to a point
 * without its mean moving at all, at which point every location test reports RESHUFFLE and the
 * tool is right and useless in the same breath.
 *
 * So this prints, for each column, both:
 *
 *   - the paired sign test, exactly as jg-compare does it, declining under n=5;
 *   - a variance ratio F = s_before^2 / s_after^2 on (n-1, n-1) df, with the raw sd and range
 *     beside it so a reader can see whether either spread has collapsed (rule 12) or is bloated
 *     by a single outlier (rule 12's mirror -- print the median too, so one 630 s run cannot
 *     carry a 15% "shift" on its own).
 *
 * And for the outcome mix, Fisher's exact test on wins, because 2-of-8 against 0-of-8 is a
 * two-seed difference and somebody is going to quote it as if it were the finding.
 *
 *   node tools/scratch/fv-stats.mjs before.json after.json
 */
import { readFile } from 'node:fs/promises';

const [, , A, B] = process.argv;
const before = JSON.parse(await readFile(A, 'utf8'));
const after = JSON.parse(await readFile(B, 'utf8'));

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const vr = (a) => a.length > 1 ? a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1) : 0;
const sd = (a) => Math.sqrt(vr(a));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** Regularised incomplete beta, for the F distribution tail. Continued fraction, Lentz. */
function betacf(a, b, x) {
  const EPS = 3e-12, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
const lgamma = (z) => {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
};
const betai = (a, b, x) => {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
};
/** P(F_{d1,d2} >= f), the upper tail. */
const fTail = (f, d1, d2) => f <= 0 ? 1 : betai(d2 / 2, d1 / 2, d2 / (d2 + d1 * f));

const lfact = (n) => lgamma(n + 1);
/** Fisher's exact test, two-sided, on a 2x2 table. */
function fisher(a, b, c, d) {
  const n = a + b + c + d;
  const p = (i, j, k, l) => Math.exp(lfact(i + j) + lfact(k + l) + lfact(i + k) + lfact(j + l) - lfact(n) - lfact(i) - lfact(j) - lfact(k) - lfact(l));
  const obs = p(a, b, c, d);
  let sum = 0;
  const r1 = a + b, c1 = a + c;
  for (let i = Math.max(0, c1 - (c + d)); i <= Math.min(r1, c1); i++) {
    const q = p(i, r1 - i, c1 - i, n - r1 - c1 + i);
    if (q <= obs * (1 + 1e-9)) sum += q;
  }
  return Math.min(1, sum);
}

const peak = (rec, side) => rec.rows.filter((r) => !r.error)
  .map((r) => (r.curve ?? []).reduce((m, c) => Math.max(m, c[side]), 0));
const col = (rec, f) => rec.rows.filter((r) => !r.error).map(f).filter((x) => x != null);
const src = (r) => (r.srcHash && r.srcHash !== '?') ? r.srcHash : (r.srcHashVerified ?? '?');

console.log(`before ${before.tag} src ${src(before)}   after ${after.tag} src ${src(after)}   ${before.map}/${before.scen}`);
if (src(before) === src(after)) {
  console.log('REFUSED: the two arms have the same src hash — the tree did not move.');
  process.exit(3);
}

const show = (name, b, a) => {
  if (b.length < 2 || a.length < 2) { console.log(`  ${name}: n too small (${b.length}/${a.length})`); return; }
  const f = vr(b) / Math.max(1e-12, vr(a));
  const p = f >= 1 ? fTail(f, b.length - 1, a.length - 1) : fTail(1 / f, a.length - 1, b.length - 1);
  console.log(`  ${name.padEnd(22)} before n=${b.length} mean ${mean(b).toFixed(1)} median ${med(b).toFixed(1)} sd ${sd(b).toFixed(2)} range ${Math.min(...b)}-${Math.max(...b)}`);
  console.log(`  ${''.padEnd(22)} after  n=${a.length} mean ${mean(a).toFixed(1)} median ${med(a).toFixed(1)} sd ${sd(a).toFixed(2)} range ${Math.min(...a)}-${Math.max(...a)}`);
  // location, the way jg-compare does it: paired sign test over shared seeds
  const bs = before.rows.filter((r) => !r.error).map((r) => r.seed);
  const as = new Set(after.rows.filter((r) => !r.error).map((r) => r.seed));
  const shared = bs.filter((s) => as.has(s));
  if (shared.length >= 5 && b.length === bs.length && a.length === [...as].length) {
    let up = 0, down = 0, same = 0;
    shared.forEach((s) => {
      const i = bs.indexOf(s), j = after.rows.filter((r) => !r.error).findIndex((r) => r.seed === s);
      if (a[j] > b[i]) up++; else if (a[j] < b[i]) down++; else same++;
    });
    const uni = up === shared.length || down === shared.length;
    console.log(`  ${''.padEnd(22)} location: ${down} down, ${up} up, ${same} unchanged over ${shared.length} paired seeds -> ${uni ? `TRANSLATION (p=${(2 / 2 ** shared.length).toFixed(4)})` : 'RESHUFFLE (mixed) — the MEAN is not what moved'}`);
  } else {
    console.log(`  ${''.padEnd(22)} location: paired sign test DECLINED (n=${shared.length})`);
  }
  console.log(`  ${''.padEnd(22)} dispersion: F(${b.length - 1},${a.length - 1}) = ${f.toFixed(2)}  p = ${p.toFixed(4)}  -> the spread ${p < 0.05 ? (f > 1 ? 'CONTRACTED' : 'WIDENED') : 'is not distinguishable'}`);
};

console.log('\nrout cascade — the only thing Rome can win on (BattleFlow: COLLAPSE_STRENGTH 0.22):');
show('peak routing, foe', peak(before, 'theirRouting'), peak(after, 'theirRouting'));
show('peak routing, Rome', peak(before, 'myRouting'), peak(after, 'myRouting'));
console.log('\nshape:');
show('decided at (s)', col(before, (r) => r.at), col(after, (r) => r.at));
show('contested window (s)', col(before, (r) => r.contestWindow), col(after, (r) => r.contestWindow));
show('max lead', col(before, (r) => r.maxLead), col(after, (r) => r.maxLead));

const wins = (rec) => rec.rows.filter((r) => !r.error && r.verdict === 'Victory').length;
const n = (rec) => rec.rows.filter((r) => !r.error).length;
const wb = wins(before), wa = wins(after), nb = n(before), na = n(after);
console.log(`\noutcome mix: Rome wins ${wb}/${nb} -> ${wa}/${na}`);
console.log(`  Fisher exact, two-sided: p = ${fisher(wb, nb - wb, wa, na - wa).toFixed(4)}`);
console.log('  On its own a two-seed difference at n=8 is NOT significant. The win count is the');
console.log('  symptom; the dispersion rows above are the measurement.');
