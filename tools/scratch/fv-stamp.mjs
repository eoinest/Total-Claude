/**
 * Stamp each collected record with the arm's verified src identity.
 *
 * `jg-shape` computes `head` and `srcHash` inside one try block, so in a copied arm with no
 * `.git` the `git rev-parse` throws first and BOTH come out `?`. That is exactly the failure the
 * coordinator warned about — a bisect step that silently measured the previous tree — so the
 * identity is recomputed here from the arm's own `src/`, by the same formula jg-shape uses, and
 * written to NEW fields. `srcHash` itself is left as the tool wrote it: a measurement is not
 * edited after the fact, it is annotated.
 *
 *   node tools/scratch/fv-stamp.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const W = '/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/agent-ad82a43c18e618daf';
const D = `${W}/screenshots/judge/shape`;
const ARMS = {
  'A-mainsrc': { dir: '/tmp/tc-fv-mainsrc', rev: 'd299837', note: 'main src (== 58bc584); the commit before the deploy-boxes merge' },
  'B-boxes': { dir: '/tmp/tc-fv-boxes', rev: '0060874', note: 'the deployment boxes widened east' },
  'C-qsplit': { dir: '/tmp/tc-fv-qsplit', rev: '0cfd865', note: 'the graphics/simulation split' },
  'D-rams': { dir: '/tmp/tc-fv-rams', rev: '77e4479', note: 'the ram and the garrison fan' },
  'D-rams-carthage': { dir: '/tmp/tc-fv-rams', rev: '77e4479', note: 'the ram and the garrison fan' },
  'E-noinset': { dir: '/tmp/tc-fv-noinset', rev: '0060874 -feather inset', note: 'diagnostic: standOnDeploymentGround does not inset by box.feather' },
  'F-oldcore': { dir: '/tmp/tc-fv-oldcore', rev: '0060874 -corridor move', note: 'diagnostic: battleCoreMask back to (0,-30,540,360)' },
  'G-oldbox': { dir: '/tmp/tc-fv-oldbox', rev: '0060874 -box widening', note: 'diagnostic: DEPLOY_GROUND back to +-380 / +-250 about x 205' },
};
const hashOf = (dir) => execSync(
  "find src -type f \\( -name '*.ts' -o -name '*.css' -o -name '*.glsl' \\) -print0 | sort -z | xargs -0 cat | shasum -a 256 | cut -c1-16",
  { cwd: dir, shell: '/bin/sh' }).toString().trim();

for (const [tag, a] of Object.entries(ARMS)) {
  const h = existsSync(a.dir) ? hashOf(a.dir) : null;
  for (const m of ['campus-martius-field', 'carthage-assault', 'campus-martius-assault']) {
    const f = `${D}/shape-${m}-${tag}.json`;
    if (!existsSync(f)) continue;
    const j = JSON.parse(await readFile(f, 'utf8'));
    j.srcHashVerified = h;
    j.armDir = a.dir;
    j.armRev = a.rev;
    j.armNote = a.note;
    j.provenance = 'srcHash/head read `?` because the arm is a plain copy with no .git; srcHashVerified is the same formula run against the arm directory after the run.';
    await writeFile(f, JSON.stringify(j, null, 1));
    console.log(`${tag.padEnd(16)} ${m.padEnd(22)} srcHashVerified ${h}  rev ${a.rev}`);
  }
}
