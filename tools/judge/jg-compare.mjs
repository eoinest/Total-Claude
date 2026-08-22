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
  console.log(`  shift   ${(ma - mb).toFixed(0)} men = ${(100 * (ma - mb) / mb).toFixed(1)}% = ${(Math.abs(ma - mb) / sb).toFixed(2)} sd of the seed spread`);
  console.log(`  sign    ${down} seeds down, ${up} up  -> ${down === pairs.length || up === pairs.length
    ? `TRANSLATION (every seed moved the same way; p=${(2 / 2 ** pairs.length).toFixed(4)} under reshuffle) — the distribution MOVED, which a reroll cannot do`
    : 'RESHUFFLE (mixed directions) — consistent with "the same order as changing the seed"'}`);
  const clears = ma < Math.min(...vb) || ma > Math.max(...vb);
  console.log(`  reach   the after-mean ${clears ? 'FALLS OUTSIDE' : 'sits inside'} the whole before-range${clears
    ? ` — no reroll before the change could produce the AVERAGE battle after it` : ''}`);
  console.log();
}

// ---- 4. shape
const col = (rows, f) => rows.map(f).filter(x => x != null);
const cmp = (name, f, unit = '') => {
  const b = col(before.rows, f), a = col(after.rows, f);
  if (!b.length || !a.length) return;
  const mb = mean(b), ma = mean(a), s = sd(b);
  const outside = Math.abs(ma - mb) > s;
  console.log(`  ${name.padEnd(22)} ${mb.toFixed(1)}${unit} -> ${ma.toFixed(1)}${unit}   (before sd ${s.toFixed(1)})  ${outside ? '** beyond its own spread **' : 'inside its own spread'}`);
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
