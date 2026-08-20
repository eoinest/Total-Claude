// Scratch: the eight deck statistics across the arms of one interleaved A/B session.
//
// Same `pictureStats` the blind A/B deck is graded on, so a movement here is a movement the
// graders would be shown. The row that matters is `base-2` — the drift check. Any arm whose
// delta is not larger than base-2's is inside the session's own noise and is not evidence.
//
//   node tools/scratch/gpucost-picstats.mjs --dir=screenshots/gpucost-ab-final --base=rome-base-1
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { pictureStats, PICTURE_STAT_KEYS } from '../lib/deck-audit.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DIR = path.resolve(ROOT, arg('dir', 'screenshots/gpucost-ab-final'));
const BASE = arg('base', '');

const files = (await readdir(DIR)).filter((f) => f.endsWith('.png')).sort();
if (!files.length) throw new Error(`no PNGs in ${DIR}`);
const baseName = BASE || files.find((f) => f.includes('base-1'))?.replace(/\.png$/, '') || files[0].replace(/\.png$/, '');

const stats = new Map();
for (const f of files) stats.set(f.replace(/\.png$/, ''), await pictureStats(path.join(DIR, f)));

const b = stats.get(baseName);
if (!b) throw new Error(`base ${baseName} not among ${[...stats.keys()].join(', ')}`);

console.log(`# ${DIR}`);
console.log(`# base = ${baseName};  ${PICTURE_STAT_KEYS.length} statistics, the deck's own\n`);
console.log(`${'arm'.padEnd(22)} ${PICTURE_STAT_KEYS.map((k) => k.padStart(10)).join('')}`);
console.log(`${baseName.padEnd(22)} ${PICTURE_STAT_KEYS.map((k) => b[k].toFixed(4).padStart(10)).join('')}`);
console.log('-'.repeat(22 + 10 * PICTURE_STAT_KEYS.length));
for (const [name, s] of stats) {
  if (name === baseName) continue;
  const row = PICTURE_STAT_KEYS.map((k) => {
    const d = s[k] - b[k];
    return (d === 0 ? '0' : (d > 0 ? '+' : '') + d.toFixed(4)).padStart(10);
  }).join('');
  console.log(`${(name + ' Δ').padEnd(22)} ${row}`);
}
console.log('\nedge and halo are the two the round is argued in: if either moves, the picture moved.');
