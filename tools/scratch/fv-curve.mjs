/**
 * The casualty exchange, seed by seed, out of two jg-shape records.
 *
 * jg-compare answers "did it move and would a player feel it". This answers the next question
 * down: *who was losing men, and from when*. `me` is faction 0 (Rome); `them` is the other.
 *
 * `myDead`/`theirDead` in the curve are **destroyed units**, not men — `jg-lib`'s `__TRUTH`
 * increments them once per `u.destroyed`. So men are read off `me`/`them` (living), which is
 * what the plaque's advantage is computed from too. That distinction cost one wrong table.
 *
 * Every column prints its own n and its own range. There is no sigma here on purpose: at t+200
 * on this map some columns have sd under 0.2, and a sigma on that is the trap in rule 12.
 */
import { readFile } from 'node:fs/promises';

const [, , ...files] = process.argv;
const TS = [100, 150, 200, 250, 300, 400];
const recs = [];
for (const f of files) recs.push(JSON.parse(await readFile(f, 'utf8')));

const atT = (r, t) => {
  const c = (r.curve ?? []).filter((x) => x.t >= t);
  return c.length ? c[0] : null;
};
const pad = (n, w = 6) => String(n).padStart(w);
const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;

for (const rec of recs) {
  console.log(`\n=== ${rec.tag}  src ${rec.srcHash}  ${rec.map}/${rec.scen}  n=${rec.rows.length} ===`);
  for (const r of rec.rows) {
    if (r.error) { console.log(`${pad(r.seed, 10)} THREW ${r.error.slice(0, 80)}`); continue; }
    const cols = TS.map((t) => {
      const c = atT(r, t);
      if (!c) return '|      -  ';
      // Rome's men as a share of all living men: the plaque's own advantage number.
      return `| ${pad(c.me, 4)}/${pad(c.them, 4)} ${(c.me / (c.me + c.them)).toFixed(3)}`;
    });
    console.log(`${pad(r.seed, 10)} ${String(r.verdict).padEnd(7)} ${pad(Math.round(r.at ?? -1), 4)}s ` + cols.join(''));
  }
  for (const t of TS) {
    const rows = rec.rows.filter((r) => !r.error && atT(r, t));
    if (!rows.length) { console.log(`  t+${t}: n=0`); continue; }
    const share = rows.map((r) => { const c = atT(r, t); return c.me / (c.me + c.them); });
    const mine = rows.map((r) => atT(r, t).me), theirs = rows.map((r) => atT(r, t).them);
    const live = rec.rows.filter((r) => !r.error && (r.at ?? 0) > t).length;
    const rng = (v, d = 0) => `${Math.min(...v).toFixed(d)}-${Math.max(...v).toFixed(d)}`;
    console.log(`  t+${t}: n=${rows.length} live=${live}  Rome ${mean(mine).toFixed(0)} [${rng(mine)}]  foe ${mean(theirs).toFixed(0)} [${rng(theirs)}]  Rome share ${mean(share).toFixed(3)} [${rng(share, 3)}]`);
  }
}
