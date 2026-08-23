#!/usr/bin/env node
/**
 * BEFORE AGAINST AFTER — distribution against distribution, never seed against itself.
 *
 * Takes two `jg-shape` records and answers the only questions that separate "the instrument can
 * see it" from "a player would feel it".
 *
 *  1. **Did the tree actually move?** From the product's own state hashes at fixed ticks. If they
 *     are identical the comparison is refused, because grading noise is worse than not grading.
 *
 *  2. **Translation or reshuffle?** This is the whole of the "it is the same order as changing
 *     the seed" argument, and it is decidable. A reroll is a *draw from* the distribution; a
 *     change that moves every seed the same way *moves* the distribution. Sign test across the
 *     seed set: all-same-direction at n=8 is p = 2/256 = 0.008 under reshuffle.
 *
 *  3. **Does the new mean clear the old range?** The sharpest perceptibility question there is.
 *     If the post-change mean sits outside the pre-change min-max, then no amount of rerolling
 *     before the change could ever have produced the *average* battle after it — which is
 *     exactly what "distinguishable from a reroll" means, stated without a sigma.
 *
 *  4. **Shape**, each column against its own measured spread.
 *
 * Deliberately does NOT decide whether a shift is good. A bloodier, shorter battle could be an
 * improvement here — the standing complaint about the field battle is that its back half is a
 * grind — so direction is reported and judged in prose, not by this script's sign.
 *
 *   node tools/judge/jg-compare.mjs before.json after.json
 */
import { readFile } from 'node:fs/promises';

const [,, A, B] = process.argv;
if (!A || !B) { console.error('usage: jg-compare.mjs <before.json> <after.json>'); process.exit(2); }
const before = JSON.parse(await readFile(A, 'utf8'));
const after = JSON.parse(await readFile(B, 'utf8'));

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = (a) => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : 0;
const median = (a) => { const b = [...a].sort((x, y) => x - y); const h = b.length >> 1;
  return b.length ? (b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2) : null; };

/**
 * A dispersion test beside every location test, because this game's regressions live in the spread.
 *
 * Every location test in this file said RESHUFFLE on a change whose real effect was **half the
 * spread** in decided-at, contested window and peak routing (F p = 0.016-0.018). A comparator
 * that only asks "did the mean move" is blind to "the battles all became the same battle", which
 * is the more damaging of the two: a shifted mean is a different balance, a collapsed spread is a
 * game that has stopped surprising anybody.
 *
 * Two-tailed F on the variance ratio. Regularised incomplete beta for the tail, which is enough
 * precision to separate 0.02 from 0.2 and is all this decision needs.
 */
const lgamma = (x) => { // Lanczos
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = 0.99999999999980993, t = x + 7.5;
  for (let i = 0; i < 8; i++) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
};
const betacf = (a, b, x) => { let qab = a + b, qap = a + 1, qam = a - 1, c = 1,
  d = 1 - qab * x / qap; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d; let h = d;
  for (let m = 1; m <= 200; m++) { const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-12) break; }
  return h; };
const betai = (a, b, x) => { if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b; };
/** Two-tailed p for var(a) vs var(b). */
const fTest = (a, b) => {
  if (a.length < 3 || b.length < 3) return null;
  const va = sd(a) ** 2, vb = sd(b) ** 2;
  if (va === 0 && vb === 0) return { ratio: 1, p: 1 };
  if (vb === 0 || va === 0) return { ratio: va === 0 ? 0 : Infinity, p: 0 };
  const [hi, lo, dfh, dfl] = va > vb ? [va, vb, a.length - 1, b.length - 1]
    : [vb, va, b.length - 1, a.length - 1];
  const F = hi / lo;
  const p = 2 * betai(dfl / 2, dfh / 2, dfl / (dfl + dfh * F));
  return { ratio: va / vb, p: Math.min(1, p) };
};
const at = (r, t) => { const c = (r.curve ?? []).filter(x => x.t >= t); return c.length ? c[0].me + c[0].them : null; };
const live = (r, t) => (r.at ?? 0) > t;   // was the battle still being fought at t?

console.log(`before: ${before.tag} @ ${(before.head ?? '?').slice(0, 8)}  src ${before.srcHash}`);
console.log(`after:  ${after.tag} @ ${(after.head ?? '?').slice(0, 8)}  src ${after.srcHash}`);
console.log(`${before.map}/${before.scen}\n`);

// ---- 1. did the tree move?
const bh = Object.fromEntries(before.rows.filter(r => r.hashes).map(r => [r.seed, JSON.stringify(r.hashes)]));
const ah = Object.fromEntries(after.rows.filter(r => r.hashes).map(r => [r.seed, JSON.stringify(r.hashes)]));
const shared = Object.keys(bh).filter(s => s in ah);
const identical = shared.filter(s => bh[s] === ah[s]);
console.log(`state hashes: ${identical.length} of ${shared.length} seeds bit-identical`);
if (identical.length === shared.length && shared.length > 0) {
  console.log('\nREFUSED: the simulation is bit-identical on every shared seed. The tree did not move,');
  console.log('so any difference below would be measurement noise and grading it would be dishonest.');
  process.exit(3);
}
console.log(`-> the tree moved on ${shared.length - identical.length} of ${shared.length} seeds\n`);

// ---- 2 & 3. magnitude, at each checkpoint, with liveness reported
for (const t of [200, 400]) {
  const pairs = shared.map(s => {
    const rb = before.rows.find(r => String(r.seed) === s), ra = after.rows.find(r => String(r.seed) === s);
    return { s, b: at(rb, t), a: at(ra, t), bLive: live(rb, t), aLive: live(ra, t) };
  }).filter(p => p.b != null && p.a != null);
  if (!pairs.length) { console.log(`t+${t}: no seed reaches it in both arms\n`); continue; }
  const nLive = pairs.filter(p => p.bLive && p.aLive).length;
  const vb = pairs.map(p => p.b), va = pairs.map(p => p.a);
  const mb = mean(vb), ma = mean(va), sb = sd(vb);
  const down = pairs.filter(p => p.a < p.b).length, up = pairs.filter(p => p.a > p.b).length;
  console.log(`t+${t}  (still being fought in ${nLive} of ${pairs.length} seeds${nLive < pairs.length ? ' — the rest were already decided, so this checkpoint is measuring an emptying field' : ''})`);
  console.log(`  before  mean ${mb.toFixed(0)}  sd ${sb.toFixed(1)}  range ${Math.min(...vb)}-${Math.max(...vb)}  spread ${(100 * (Math.max(...vb) - Math.min(...vb)) / mb).toFixed(1)}% of mean`);
  console.log(`  after   mean ${ma.toFixed(0)}  sd ${sd(va).toFixed(1)}  range ${Math.min(...va)}-${Math.max(...va)}`);
  console.log(`  shift   ${(ma - mb).toFixed(0)} men = ${(100 * (ma - mb) / mb).toFixed(1)}% = ${sb > 0 ? (Math.abs(ma - mb) / sb).toFixed(2) + ' sd of the seed spread' : 'sd undefined (single seed)'}`);
  /*
   * A sign test needs a sample. Caught by the positive control: at t+400 exactly one seed was
   * still being fought in both arms, and the tool printed "TRANSLATION (every seed moved the
   * same way; p=1.0000)" — n=1, p=1, and it still named the conclusion. It also printed
   * "Infinity sd" from an sd of 0 over that one seed. Both are the same error as the src-hash
   * watch and the zero-spread threshold: a statistic whose sample has collapsed still returns a
   * confident-looking number, and confident-looking numbers are what get quoted.
   *
   * MIN_SIGN is 5 because 2/2^5 = 0.06 is the first n at which unanimity is worth saying out
   * loud at all, and this decision deserves better than that — so n<5 declines rather than
   * hedges.
   */
  const MIN_SIGN = 5, MIN_RANGE = 3;
  if (pairs.length < MIN_SIGN) {
    console.log(`  sign    ${down} down, ${up} up over only ${pairs.length} seed(s) — DECLINED, a sign test needs >= ${MIN_SIGN}`);
  } else {
    console.log(`  sign    ${down} seeds down, ${up} up  -> ${down === pairs.length || up === pairs.length
      ? `TRANSLATION (every seed moved the same way; p=${(2 / 2 ** pairs.length).toFixed(4)} under reshuffle) — the distribution MOVED, which a reroll cannot do`
      : 'RESHUFFLE (mixed directions) — consistent with "the same order as changing the seed"'}`);
  }
  if (pairs.length < MIN_RANGE) {
    console.log(`  reach   DECLINED — ${pairs.length} seed(s) is not a range`);
  } else {
    const clears = ma < Math.min(...vb) || ma > Math.max(...vb);
    console.log(`  reach   the after-mean ${clears ? 'FALLS OUTSIDE' : 'sits inside'} the whole before-range${clears
      ? ` — no reroll before the change could produce the AVERAGE battle after it` : ''}`);
  }
  console.log();
}

// ---- 4. shape
const col = (rows, f) => rows.map(f).filter(x => x != null);
const cmp = (name, f, unit = '') => {
  const b = col(before.rows, f), a = col(after.rows, f);
  if (!b.length || !a.length) return;
  const F = fTest(b, a);
  const mb = mean(b), ma = mean(a), s = sd(b);
  /*
   * A near-zero spread cannot be a threshold on its own.
   *
   * The positive control flagged `closest it got  0.2 -> 0.2 (before sd 0.0)` as "beyond its own
   * spread", because with sd 0 every difference is infinitely many sigma and a column that is
   * *identical to a rounding step* reads as the loudest signal in the table. Rome's assault has
   * columns with sd 0.0-0.2 by nature — twelve seeds break within a sixth of a second — so this
   * is not a corner case here, it is most of the table.
   *
   * So a move must clear the measured spread AND be worth more than 1% of the column's own
   * value. That is the same mistake as the src-hash watch in a different costume: a test whose
   * threshold collapses to zero always fires, and a test that always fires measures nothing.
   */
  const floor = Math.max(s, Math.abs(mb) * 0.01);
  const outside = Math.abs(ma - mb) > floor;
  const tag = outside ? '** beyond its own spread **'
    : s < Math.abs(mb) * 0.01 ? 'inside the 1% floor (spread too small to threshold on)'
      : 'inside its own spread';
  const pct = mb !== 0 ? ((ma - mb) / Math.abs(mb) * 100) : 0;
  const mdb = median(b), mda = median(a);
  const mdPct = mdb ? ((mda - mdb) / Math.abs(mdb) * 100) : 0;
  console.log(`  ${name.padEnd(20)} mean ${mb.toFixed(1)}${unit} -> ${ma.toFixed(1)}${unit} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%  |  median ${mdb.toFixed(1)} -> ${mda.toFixed(1)} ${mdPct >= 0 ? '+' : ''}${mdPct.toFixed(1)}%  |  sd ${s.toPrecision(2)} -> ${sd(a).toPrecision(2)}${F ? `  F=${F.ratio.toFixed(2)} p=${F.p.toFixed(3)}${F.p < 0.05 ? ' ** SPREAD CHANGED **' : ''}` : ''}`);
  if (outside) console.log(`  ${' '.repeat(20)} ^ mean move beyond its own spread`);
};
console.log('shape:');
cmp('contact', r => r.contactAt, ' s');
cmp('my first break', r => r.firstBreakUs, ' s');
cmp('their first break', r => r.firstBreakThem, ' s');
cmp('decided at', r => r.at, ' s');
cmp('contested window', r => r.contestWindow, ' s');
cmp('advantage flips', r => r.flips);
cmp('closest it got', r => r.minGapAfterContact);
const mix = (rows) => { const o = {}; for (const r of rows) if (!r.error) o[`${r.verdict}/${r.reason}`] = (o[`${r.verdict}/${r.reason}`] ?? 0) + 1; return o; };
console.log(`  outcome mix            ${JSON.stringify(mix(before.rows))} -> ${JSON.stringify(mix(after.rows))}`);
const bRange = [Math.min(...col(before.rows, r => r.at)), Math.max(...col(before.rows, r => r.at))];
const aOut = col(after.rows, r => r.at).filter(x => x < bRange[0] || x > bRange[1]).length;
console.log(`  verdicts outside the before-range (${bRange[0].toFixed(0)}-${bRange[1].toFixed(0)} s): ${aOut} of ${col(after.rows, r => r.at).length}`);
