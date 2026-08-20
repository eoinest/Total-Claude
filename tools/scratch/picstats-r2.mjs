// Scratch: the eight deck statistics on a shot directory against its paired reference plates,
// without building a deck. Same `pictureStats` the audit uses, so the numbers are comparable.
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { pictureStats, PICTURE_STAT_KEYS } from '../lib/deck-audit.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const OURS = path.resolve(ROOT, arg('ours', 'screenshots/ab-r2'));
const REFS = path.resolve(ROOT, arg('refs', 'reference/rome2-steam'));
const PAIRS = path.resolve(ROOT, arg('pairs', 'tools/ab-pairs-round2.json'));

const pairs = JSON.parse(await readFile(PAIRS, 'utf8')).pairs;
const have = new Set((await readdir(OURS)).map((f) => f.replace(/\.[^.]+$/, '')));
const F = PICTURE_STAT_KEYS;   // the single source for which statistics exist, and how many
const acc = { ours: [], rome2: [] };
const rows = [];
for (const p of pairs) {
  if (!have.has(p.ours)) continue;
  const a = await pictureStats(path.join(OURS, `${p.ours}.png`));
  const b = await pictureStats(path.join(REFS, `${p.ref}.jpg`));
  acc.ours.push(a); acc.rome2.push(b);
  rows.push({ pair: p.ours, ref: p.ref, a, b });
}
const mean = (xs, f) => xs.reduce((s, x) => s + x[f], 0) / xs.length;
console.log(`n = ${rows.length} pairs (whole frames, no crop — indicative, not the deck audit)\n`);
console.log('field       ours      rome2     gap');
for (const f of F) {
  const o = mean(acc.ours, f), r = mean(acc.rome2, f);
  console.log(`${f.padEnd(11)} ${o.toFixed(4).padStart(8)}  ${r.toFixed(4).padStart(8)}  ${(o - r >= 0 ? '+' : '') + (o - r).toFixed(4)}`);
}
console.log('\nper pair (lum / p01 / p99 / hueSpread), ours -> rome2');
for (const r of rows) {
  console.log(`  ${r.pair.padEnd(20)} ${r.a.lum.toFixed(3)}->${r.b.lum.toFixed(3)}  `
    + `${r.a.p01.toFixed(3)}->${r.b.p01.toFixed(3)}  ${r.a.p99.toFixed(3)}->${r.b.p99.toFixed(3)}  `
    + `${r.a.hueSpread.toFixed(1)}->${r.b.hueSpread.toFixed(1)}`);
}
