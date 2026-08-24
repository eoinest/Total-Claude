#!/usr/bin/env node
/**
 * Prove the reclaimer refuses before proving it deletes.
 *
 * ## Why this exists and not just a dry run
 *
 * A crash on this machine once destroyed a day of unpushed work, and a branch survived only
 * because its worktree did. `tools/reclaim.mjs` is therefore the most dangerous file in this
 * repository, and the only evidence worth anything about it is a **live demonstration that it
 * declines**, against worktrees constructed to be exactly the cases that must never go.
 *
 * A reclaimer that has only ever been shown to delete things is not one anybody should run
 * unattended. So this builds five fixtures, runs the real `--apply` path against them, and
 * asserts one thing about each:
 *
 *   | fixture | what it is | must be |
 *   |---|---|---|
 *   | `unpushed` | clean, one commit that exists on no remote | REFUSED |
 *   | `busy`     | clean and merged, but a live process is standing in it | REFUSED |
 *   | `dirty`    | a modified tracked file | REFUSED |
 *   | `rebasing` | clean and merged, with `REBASE_HEAD` present | REFUSED |
 *   | `dead`     | clean, merged, idle, nothing using it | **TAKEN** |
 *
 * and then a sixth assertion that matters more than any of them: after the run, the commit
 * that `unpushed` was holding is **still reachable**.
 *
 * ## What makes the demonstration real rather than staged
 *
 *   - It is `--apply`, not a preview. The destructive path executes.
 *   - The scope is `--under=<tmpdir>`, which is the only concession, and it is not a safety
 *     concession: a safety test that reclaimed the whole machine while proving it is safe
 *     would have failed at its job.
 *   - `--min-age=0s` is set for the main pass, because the fixtures are seconds old. That gate
 *     is a *timer*, not a safety property, and it is proved separately in step 2 — with the
 *     default 24 h, all five fixtures including `dead` come back protected by `too-young`.
 *   - The `busy` fixture holds a real process with a real `cwd`, discovered by the same
 *     `lsof -a -d cwd` sweep the tool uses in anger.
 *
 * ## Usage
 *
 *     node tools/qa-reclaim.mjs           # 12 assertions
 *     node tools/qa-reclaim.mjs --keep    # leave the fixtures behind for inspection
 *
 * It opens no browser and takes no budget slot. It runs one `git fetch`.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEEP = process.argv.includes('--keep');
const TAG = `qa-reclaim-${process.pid}`;
const TMP = `/tmp/tc-${TAG}`;

const git = (args, cwd = ROOT, tolerant = false) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (tolerant) return null;
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${String(err.stderr ?? err.message).slice(0, 300)}`);
  }
};

let pass = 0; const failures = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL  ${name}\n          ${detail}`); }
};

const reclaim = (extra) => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'reclaim.mjs'), '--json', `--under=${TMP}`, ...extra],
    { cwd: ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 << 20 });
  return JSON.parse(out);
};

const find = (report, name) => report.worktrees.find((w) => path.basename(w.path) === name);
const verdictOf = (report, name) => find(report, name)?.verdict ?? '(absent)';
const protectedBy = (report, name) => (find(report, name)?.protections ?? []).map((p) => p.test);

let sleeper = null;
const fixtures = ['unpushed', 'busy', 'dirty', 'rebasing', 'dead'];

const cleanup = () => {
  try { if (sleeper) process.kill(sleeper, 'SIGKILL'); } catch { /* already gone */ }
  if (KEEP) { console.log(`\n--keep: fixtures left at ${TMP}`); return; }
  for (const name of fixtures) {
    git(['worktree', 'remove', '--force', path.join(TMP, name)], ROOT, true);
    git(['branch', '-D', `${TAG}-${name}`], ROOT, true);
  }
  git(['worktree', 'prune'], ROOT, true);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ }
};

process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

/* ─────────────────────────────── build ─────────────────────────────── */

console.log(`qa-reclaim — building five fixtures under ${TMP}\n`);

git(['fetch', '--prune', '--quiet', 'origin']);
const BASE = git(['rev-parse', 'origin/main']);
mkdirSync(TMP, { recursive: true });

for (const name of fixtures) {
  git(['worktree', 'add', '--quiet', '-b', `${TAG}-${name}`, path.join(TMP, name), BASE]);
}

// unpushed: a commit that exists on no remote. The one case the owner named explicitly.
writeFileSync(path.join(TMP, 'unpushed', 'QA-UNPUSHED.txt'), 'a day of work\n');
git(['add', 'QA-UNPUSHED.txt'], path.join(TMP, 'unpushed'));
git(['-c', 'user.name=qa', '-c', 'user.email=qa@local', 'commit', '--quiet', '-m', 'qa: work that exists nowhere else'], path.join(TMP, 'unpushed'));
const UNPUSHED_SHA = git(['rev-parse', 'HEAD'], path.join(TMP, 'unpushed'));

// dirty: uncommitted changes to a tracked file.
const tracked = git(['ls-files'], path.join(TMP, 'dirty')).split('\n').find((f) => f.endsWith('.md')) ?? 'README.md';
appendFileSync(path.join(TMP, 'dirty', tracked), '\n<!-- qa-reclaim: uncommitted -->\n');

// rebasing: the marker git leaves mid-operation. State that is in no commit anywhere.
const rebasingGitDir = readFileSync(path.join(TMP, 'rebasing', '.git'), 'utf8').match(/gitdir:\s*(.+)/)[1].trim();
writeFileSync(path.join(rebasingGitDir, 'REBASE_HEAD'), `${BASE}\n`);

// busy: a live process whose cwd is inside it, discovered exactly as a live agent would be.
const child = spawn('/bin/sleep', ['600'], { cwd: path.join(TMP, 'busy'), detached: true, stdio: 'ignore' });
child.unref();
sleeper = child.pid;
execFileSync('sleep', ['0.5']);

console.log(`  unpushed  1 commit ${UNPUSHED_SHA.slice(0, 12)} on no remote`);
console.log(`  busy      pid ${sleeper} has cwd inside it`);
console.log(`  dirty     ${tracked} modified, uncommitted`);
console.log(`  rebasing  REBASE_HEAD present`);
console.log('  dead      clean, at origin/main, nothing using it\n');

/* ───────────────────────── 1. the preview ───────────────────────── */

console.log('1. preview, age gate relaxed — what does it say it will do?');
const preview = reclaim(['--min-age=0s']);
check('unpushed is protected', verdictOf(preview, 'unpushed') === 'protected', `got ${verdictOf(preview, 'unpushed')}`);
check('  …and the named reason is `unpushed`', protectedBy(preview, 'unpushed').includes('unpushed'),
  `protections: ${protectedBy(preview, 'unpushed').join(', ') || 'none'}`);
check('busy is protected', verdictOf(preview, 'busy') === 'protected', `got ${verdictOf(preview, 'busy')}`);
check('  …and the named reason is `in-use`', protectedBy(preview, 'busy').includes('in-use'),
  `protections: ${protectedBy(preview, 'busy').join(', ') || 'none'}`);
check('dirty is protected', protectedBy(preview, 'dirty').includes('uncommitted'),
  `protections: ${protectedBy(preview, 'dirty').join(', ') || 'none'}`);
check('rebasing is protected', protectedBy(preview, 'rebasing').includes('operation-in-progress'),
  `protections: ${protectedBy(preview, 'rebasing').join(', ') || 'none'}`);
check('dead is the only reclaimable one', verdictOf(preview, 'dead') === 'reclaimable'
  && preview.worktrees.filter((w) => w.verdict === 'reclaimable').length === 1,
  `reclaimable: ${preview.worktrees.filter((w) => w.verdict === 'reclaimable').map((w) => path.basename(w.path)).join(', ') || 'none'}`);

/* ───────────────────── 2. the age gate on its own ───────────────────── */

console.log('\n2. the same, with the default 24 h age gate — the timer, proved separately');
const aged = reclaim([]);
check('with --min-age=24h even `dead` is protected by too-young',
  protectedBy(aged, 'dead').includes('too-young') && aged.worktrees.every((w) => w.verdict !== 'reclaimable'),
  `dead: ${protectedBy(aged, 'dead').join(', ') || 'nothing'}`);

/* ─────────────────────── 3. the destructive path ─────────────────────── */

console.log('\n3. --apply, for real');
const applied = reclaim(['--apply', '--min-age=0s']);
const removedPaths = applied.removed.map((r) => path.basename(r.path ?? ''));
check('it removed exactly one thing', applied.removed.length === 1, `removed ${applied.removed.length}: ${removedPaths.join(', ')}`);
check('and that thing was `dead`', removedPaths[0] === 'dead', `removed ${removedPaths.join(', ') || 'nothing'}`);
check('`dead` is gone from disk', !existsSync(path.join(TMP, 'dead')), 'the directory is still there');

const survivors = ['unpushed', 'busy', 'dirty', 'rebasing'].filter((n) => existsSync(path.join(TMP, n)));
check('all four protected worktrees survived on disk', survivors.length === 4,
  `survived: ${survivors.join(', ')}`);

/* ────────────── 4. the assertion that matters most ────────────── */

console.log('\n4. is the unpushed work still there?');
const stillThere = git(['cat-file', '-e', `${UNPUSHED_SHA}^{commit}`], ROOT, true) !== null;
const stillNamed = git(['rev-parse', '--verify', '--quiet', `${TAG}-unpushed`], ROOT, true) === UNPUSHED_SHA;
check(`commit ${UNPUSHED_SHA.slice(0, 12)} is still in the object store`, stillThere, 'the object is gone');
check('and its branch still names it', stillNamed, `branch points at ${git(['rev-parse', '--verify', '--quiet', `${TAG}-unpushed`], ROOT, true)}`);

/* ─────────────────────────── the verdict ─────────────────────────── */

console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${pass}/${pass + failures.length} assertions`);
if (failures.length) {
  for (const f of failures) console.log(`  ${f}`);
  console.log('\nThe reclaimer must not be run until this passes. Every failure above is a case');
  console.log('where it would have deleted something it was told never to touch.');
  process.exitCode = 1;
} else {
  console.log('It refuses unpushed commits, uncommitted work, an in-progress rebase, and a tree');
  console.log('with a live process standing in it. It takes the one that is genuinely dead.');
}
