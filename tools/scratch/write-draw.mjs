/**
 * One-shot: write `rome-landmarks --floorsweep`'s allocation into `survey.ts` as `draw:` lines.
 *
 * Kept out of `rome-landmarks.mjs` on purpose. That file is an instrument and this is an edit;
 * an instrument that can rewrite the thing it grades is one keystroke from grading its own
 * output. Run it, read the diff, and re-run it whenever a coordinate, a dimension, a `complex`
 * or an `abuts` changes — the allocation depends on all four. Never wire it into a build.
 *
 * Idempotent: it strips every existing `draw:` line before writing the new set.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = execSync('node tools/scratch/rome-landmarks.mjs --floorsweep', { cwd: ROOT, encoding: 'utf8' });
const alloc = new Map();
for (const line of out.split('\n')) {
  const m = /^ {2}([a-z0-9-]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+) x ([\d.]+) m\s+\|\s+(\d+) x (\d+) m/.exec(line);
  if (m) alloc.set(m[1], { draw: +m[2], len: +m[3], wid: +m[4], dl: +m[5], dw: +m[6] });
}
if (alloc.size < 20) throw new Error(`only parsed ${alloc.size} rows from the allocation`);

const p = resolve(ROOT, 'src/city/rome/survey.ts');
let s = readFileSync(p, 'utf8');
s = s.replace(/^ *draw: [\d.]+,.*\n/gm, '');
let n = 0;
for (const [id, a] of alloc) {
  if (a.draw >= 0.9995) continue;
  const marker = `    id: '${id}',`;
  const at = s.indexOf(marker);
  if (at < 0) throw new Error(`no row ${id}`);
  const geom = /\n( *)(e: -?[\d.]+, n: -?[\d.]+, len: [\d.]+, wid: [\d.]+, bearing: -?[\d.]+,)( axis: 'z',)?\n/.exec(
    s.slice(at, at + 900)
  );
  if (!geom) throw new Error(`no geometry line for ${id}`);
  const abs = at + geom.index;
  const insert = `\n${geom[1]}${geom[2]}${geom[3] ?? ''}\n${geom[1]}draw: ${a.draw.toFixed(3)}, // ${a.len} x ${a.wid} m real -> ${a.dl} x ${a.dw} m drawn\n`;
  s = s.slice(0, abs) + insert + s.slice(abs + geom[0].length);
  n++;
}
writeFileSync(p, s);
console.log(`wrote ${n} draw lines; ${alloc.size - n} rows left at full published plan`);
