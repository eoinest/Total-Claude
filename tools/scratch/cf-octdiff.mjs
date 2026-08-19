#!/usr/bin/env node
/**
 * cf-octdiff — two `probe-octave --json` runs, per plate, as percentage moves.
 *
 * The pooled medians the probe prints hide the thing worth knowing on a per-piece change:
 * whether the plates that actually carry the changed surface moved, and in which bands. A
 * cloth pass cannot move a plate whose figure is 60 % shield board, and reading only the
 * pool makes a real gain on three plates look like nothing on ten.
 *
 *   node tools/scratch/cf-octdiff.mjs /tmp/a.json /tmp/b.json
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

const [A, B] = process.argv.slice(2);
if (!A || !B) { console.error('usage: cf-octdiff.mjs base.json cand.json'); process.exit(1); }
const load = (p) => {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  const m = new Map();
  for (const r of j.rows) if (r.pool === 'ours') m.set(r.name, r);
  return { m, dir: j.ours?.dir ?? p };
};
const a = load(A), b = load(B);
console.log(`base ${a.dir}\ncand ${b.dir}\n`);
console.log('plate            R base   R cand    dR%     dE1%    dE2%    dE4%    dE8%   dE16%');
const acc = { R: [], E1: [], E2: [], E4: [], E8: [], E16: [] };
for (const k of [...a.m.keys()].sort()) {
  const x = a.m.get(k), y = b.m.get(k);
  if (!y) continue;
  const d = (n) => ((y[n] - x[n]) / x[n]) * 100;
  for (const n of Object.keys(acc)) acc[n].push(d(n));
  console.log(`${k.padEnd(15)} ${x.R.toFixed(3).padStart(7)} ${y.R.toFixed(3).padStart(8)}`
    + ` ${d('R').toFixed(1).padStart(6)} ${d('E1').toFixed(1).padStart(8)} ${d('E2').toFixed(1).padStart(7)}`
    + ` ${d('E4').toFixed(1).padStart(7)} ${d('E8').toFixed(1).padStart(7)} ${d('E16').toFixed(1).padStart(7)}`);
}
const med = (v) => { const s = [...v].sort((p, q) => p - q); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
console.log(`\nmedian move   dR ${med(acc.R).toFixed(1)}%   dE1 ${med(acc.E1).toFixed(1)}%`
  + `   dE2 ${med(acc.E2).toFixed(1)}%   dE4 ${med(acc.E4).toFixed(1)}%`
  + `   dE8 ${med(acc.E8).toFixed(1)}%   dE16 ${med(acc.E16).toFixed(1)}%`);
console.log('A real gain is dR negative with dE2 and dE4 POSITIVE. dR negative with the mid');
console.log('bands also negative is the blur signature and must be rejected.');
