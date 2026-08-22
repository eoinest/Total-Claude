/**
 * The bisect table: one row per arm, in commit order, from the jg-shape records.
 *
 * Prints, for each arm, the outcome mix over the whole seed set and the two things the field
 * battle's verdict is actually read off — how far the *enemy's* rout cascade got, and how far
 * Rome's did. `BattleFlow.update` calls a side spent when its men in units that are not routing
 * fall below `COLLAPSE_STRENGTH` (0.22) of its start, or below `DECISIVE_OWN` (0.5) of its start
 * while also below `DECISIVE_RATIO` (0.33) of the strongest side. Rome starts with 3,772 men
 * against 4,860, so the ratio arm is unreachable for Rome in practice and Rome's only route to a
 * win is the enemy's own cascade. Peak routing units is therefore the column to read, and its
 * *spread* is the thing that decides whether the battle has more than one ending.
 *
 * n and range are printed beside every figure, per rule 12.
 */
import { readFile } from 'node:fs/promises';

const order = process.argv.slice(2);
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

console.log('arm                     src              n  outcome mix                              peak routing units: foe (spread)      Rome            decided at (median)');
for (const f of order) {
  let d;
  try { d = JSON.parse(await readFile(f, 'utf8')); } catch { console.log(`${f}: MISSING`); continue; }
  const ok = d.rows.filter((r) => !r.error);
  const mix = {};
  for (const r of ok) mix[`${r.verdict}/${r.reason}`] = (mix[`${r.verdict}/${r.reason}`] ?? 0) + 1;
  const peak = (side) => ok.map((r) => (r.curve ?? []).reduce((m, c) => Math.max(m, c[side]), 0));
  const pf = peak('theirRouting'), pm = peak('myRouting');
  const ats = ok.map((r) => r.at).filter((x) => x != null).sort((a, b) => a - b);
  const med = ats.length ? ats[Math.floor(ats.length / 2)] : NaN;
  const src = d.srcHash && d.srcHash !== '?' ? d.srcHash : (d.srcHashVerified ?? '?');
  console.log(`${String(d.tag).padEnd(22)} ${String(src).padEnd(16)} ${String(ok.length).padStart(2)}  ${JSON.stringify(mix).padEnd(40)} `
    + `mean ${mean(pf).toFixed(1)} [${Math.min(...pf)}-${Math.max(...pf)}] sd ${sd(pf).toFixed(1)}   `
    + `mean ${mean(pm).toFixed(1)} [${Math.min(...pm)}-${Math.max(...pm)}]   ${med.toFixed(0)} s`);
}
