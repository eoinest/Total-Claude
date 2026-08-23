/**
 * THE GAP — passive against played, on one tree, and then one tree against another.
 *
 * The number the whole wall-control workstream is graded on is not "did the battle change",
 * it is **"does playing it change it"**. So this reads `jg-arms` records and reports, for
 * each tree, the passive arm beside the played arm on the same seeds:
 *
 *   · location   mean and median of the difference, and the difference of the means
 *   · dispersion sd of each arm and sd of the per-seed difference, because a gap whose
 *                spread is wider than itself is not a gap
 *   · pairing    a sign test over the per-seed differences. Twelve seeds all moving the same
 *                way is p = 2/4096 under "the player is noise", which is the null this is
 *                actually testing — not "the means differ".
 *
 * Refuses to compare two records taken on the same `srcHash`, for the reason the judge's own
 * `jg-compare` header gives at length: a comparison of a tree with itself is a measurement of
 * the instrument, and reporting it as a result is how a day of work gets withdrawn.
 *
 *   node tools/judge/jg-armcmp.mjs before-passive.json before-played.json \
 *                                  after-passive.json  after-played.json
 */
import { readFile } from 'node:fs/promises';

const files = process.argv.slice(2);
if (files.length !== 2 && files.length !== 4) {
  console.error('usage: jg-armcmp.mjs <passive.json> <played.json> [<passive2.json> <played2.json>]');
  process.exit(2);
}
const load = async (f) => JSON.parse(await readFile(f, 'utf8'));
const recs = [];
for (const f of files) recs.push({ f, ...(await load(f)) });

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => (a.length > 1
  ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : 0);
const median = (a) => { const b = [...a].sort((x, y) => x - y); const h = b.length >> 1;
  return b.length ? (b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2) : null; };
const r1 = (x) => (x === null || x === undefined ? 'n/a' : (Math.round(x * 10) / 10).toString());
/** Two-tailed exact sign test; ties are dropped, which is the conservative reading. */
const signP = (diffs) => {
  const nz = diffs.filter((d) => Math.abs(d) > 1e-9);
  const n = nz.length;
  if (n === 0) return { n: 0, pos: 0, p: 1 };
  const pos = nz.filter((d) => d > 0).length;
  const k = Math.min(pos, n - pos);
  let c = 0;
  const choose = (a, b) => { let r = 1; for (let i = 0; i < b; i++) r = (r * (a - i)) / (i + 1); return r; };
  for (let i = 0; i <= k; i++) c += choose(n, i);
  return { n, pos, p: Math.min(1, (2 * c) / 2 ** n) };
};

const COLS = ['decidedAt', 'mine', 'theirs', 'wallSeconds', 'worstLodge'];

function arm(rec) {
  const rows = rec.rows.filter((r) => typeof r.decidedAt === 'number');
  return { tag: rec.tag, armName: rec.arm, srcHash: rec.srcHash, head: rec.head, rows, file: rec.f };
}

function gap(passive, played, label) {
  console.log(`\n================  ${label}  ================`);
  console.log(`  passive ${passive.file}   src ${passive.srcHash}`);
  console.log(`  played  ${played.file}   src ${played.srcHash}`);
  if (passive.srcHash !== played.srcHash) {
    console.log('  *** REFUSED: the two arms were taken on different trees. A gap measured across');
    console.log('      a code change is not a gap between arms.');
    return null;
  }
  const seeds = passive.rows.map((r) => r.seed).filter((s) => played.rows.some((p) => p.seed === s));
  console.log(`  ${seeds.length} seeds paired`);
  const out = { seeds: seeds.length, cols: {} };
  for (const k of COLS) {
    const a = seeds.map((s) => passive.rows.find((r) => r.seed === s)[k]);
    const b = seeds.map((s) => played.rows.find((r) => r.seed === s)[k]);
    const d = seeds.map((_, i) => b[i] - a[i]);
    const st = signP(d);
    out.cols[k] = { passive: { mean: mean(a), sd: sd(a) }, played: { mean: mean(b), sd: sd(b) },
      diffMean: mean(d), diffSd: sd(d), diffMedian: median(d), sign: st };
    console.log(`  ${k.padEnd(12)} passive ${r1(mean(a)).padStart(8)} ±${r1(sd(a)).padStart(6)}`
      + `   played ${r1(mean(b)).padStart(8)} ±${r1(sd(b)).padStart(6)}`
      + `   gap ${r1(mean(d)).padStart(8)} ±${r1(sd(d)).padStart(6)}`
      + `  median ${r1(median(d)).padStart(7)}`
      + `  ${st.pos}/${st.n} up  p=${st.p.toFixed(4)}`);
  }
  const verd = (rows) => rows.reduce((m, r) => { m[r.verdict] = (m[r.verdict] ?? 0) + 1; return m; }, {});
  console.log(`  verdicts  passive ${JSON.stringify(verd(passive.rows))}`
    + `   played ${JSON.stringify(verd(played.rows))}`);
  const orders = played.rows.map((r) => r.ordersLocal);
  console.log(`  orders the played arm issued: ${JSON.stringify(orders)}`);
  if (passive.rows.some((r) => r.ordersLocal > 0)) {
    console.log('  *** the passive arm issued player orders — it is not passive.');
  }
  return out;
}

if (recs.length === 2) {
  gap(arm(recs[0]), arm(recs[1]), `${recs[0].map} — one tree`);
} else {
  const before = gap(arm(recs[0]), arm(recs[1]), 'BEFORE');
  const after = gap(arm(recs[2]), arm(recs[3]), 'AFTER');
  if (recs[0].srcHash === recs[2].srcHash) {
    console.log('\n*** REFUSED: before and after are the same tree. Nothing moved, so there is');
    console.log('    nothing to compare and any difference below is the instrument.');
    process.exit(1);
  }
  if (before && after) {
    console.log('\n================  DID THE GAP OPEN?  ================');
    for (const k of COLS) {
      const b = before.cols[k];
      const a = after.cols[k];
      console.log(`  ${k.padEnd(12)} gap ${r1(b.diffMean).padStart(8)} ±${r1(b.diffSd).padStart(6)}`
        + `  ->  ${r1(a.diffMean).padStart(8)} ±${r1(a.diffSd).padStart(6)}`
        + `     ${r1(a.diffMean - b.diffMean).padStart(8)} of change`
        + `   sign ${b.sign.pos}/${b.sign.n} p=${b.sign.p.toFixed(3)} -> ${a.sign.pos}/${a.sign.n} p=${a.sign.p.toFixed(3)}`);
    }
  }
}
