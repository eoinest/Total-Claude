/**
 * Audit every record this branch commits: row count, thrown seeds, verified src identity,
 * and whether the peak-routing statistic can survive the sampling grid.
 *
 * The last one matters and is not obvious. `myRouting`/`theirRouting` are sampled every
 * `--step` seconds (10 by default), so a *peak* would be unreliable if a rout could start and
 * end inside one step. It cannot: `Morale.rally` is gated on `u.routTimer > RALLY_DELAY` and
 * `RALLY_DELAY` is 12 s, so every routing episode spans at least one sample. That is the
 * difference between this column and `firstBreakUs`, which is a single edge on the same grid
 * and therefore quantised to it.
 */
import { readFile, readdir } from 'node:fs/promises';

const D = '/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/agent-ad82a43c18e618daf/screenshots/judge/shape';
const files = (await readdir(D)).filter((f) => f.endsWith('.json')).sort();
const seen = new Map();
for (const f of files) {
  const d = JSON.parse(await readFile(`${D}/${f}`, 'utf8'));
  const bad = d.rows.filter((r) => r.error);
  const src = d.srcHash && d.srcHash !== '?' ? d.srcHash : (d.srcHashVerified ?? '?');
  const key = `${d.map}/${d.scen}|${src}`;
  const dup = seen.get(key);
  seen.set(key, f);
  console.log(`${f.padEnd(52)} tag ${String(d.tag).padEnd(16)} src ${src}  rows ${d.rows.length}  threw ${bad.length}`
    + `  n0 ${d.rows.find((r) => r.n0)?.n0 ?? '-'}${dup ? `  [same src as ${dup} — expect the same battle]` : ''}`);
  for (const b of bad) console.log(`    THREW seed ${b.seed}: ${b.error}`);
}
