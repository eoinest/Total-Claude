/**
 * Which determinism pin moved at which commit, straight out of git.
 *
 * A pin is the product's own state hash at fixed ticks. If an arm's pin for a battle is
 * byte-identical to the previous arm's, that arm did not change that battle *for the pinned
 * seed and checkpoints* -- which is not proof for every seed, but it is a cheap and strong
 * first filter, and it is the project's own instrument rather than a new one.
 *
 *   node tools/scratch/fv-pins.mjs <rev> <rev> ...
 */
import { execFileSync } from 'node:child_process';

const W = '/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/agent-ad82a43c18e618daf';
const revs = process.argv.slice(2);
const read = (rev) => JSON.parse(execFileSync('git', ['-C', W, 'show', `${rev}:tools/determinism-baseline.json`]).toString());
const subj = (rev) => execFileSync('git', ['-C', W, 'log', '-1', '--format=%s', rev]).toString().trim().slice(0, 58);

let prev = null;
for (const rev of revs) {
  const j = read(rev);
  const keys = Object.keys(j);
  const cells = keys.map((k) => {
    const s = JSON.stringify(j[k]);
    if (!prev) return `${k}: -`;
    const p = JSON.stringify(prev[k]);
    return `${k}: ${p === s ? 'same' : 'MOVED'}`;
  });
  console.log(`${rev}  ${subj(rev)}`);
  for (const c of cells) console.log(`    ${c}`);
  prev = j;
}
