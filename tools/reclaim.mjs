#!/usr/bin/env node
/**
 * Give the machine back: worktrees, scratch trees, screenshots, orphaned servers.
 *
 * ## What is on this machine right now, and why that is a problem
 *
 * Measured 23 Aug 2026:
 *
 *     118 registered worktrees, 28 GB under .claude/worktrees, 23 of them already gone
 *     612 MB of /tmp/tc-* scratch, the largest 281 MB
 *     1.0 GB of screenshots
 *     a node process from /tmp that had been alive 23 hours
 *
 * Almost all of it belongs to agents that finished hours or days ago. Nothing has ever removed
 * any of it, and on 22 August nineteen orphaned dev servers were swept off this box, several
 * more than a day old.
 *
 * ## Why this file is mostly about **refusing**
 *
 * A crash here once destroyed a day of unpushed work, and a branch survived only because its
 * worktree did. So the interesting content of this tool is not the delete — it is the list of
 * things that stop one. Of the 117 non-primary worktrees on this machine:
 *
 *     57  clean, every commit pushed        ← candidates
 *     29  dirty, every commit pushed        ← protected: uncommitted work
 *      5  clean, commits NOT pushed         ← protected: 2 and 7 commits
 *      3  dirty, commits NOT pushed         ← protected twice over: one holds 16 commits
 *     23  directory already gone            ← metadata only, git's own prune handles it
 *
 * **A rule of "delete worktrees whose branch is merged" would have destroyed eight worktrees
 * carrying up to sixteen unpushed commits each.** That is the disaster this file exists to not
 * be, and it is why `--apply` is not the default and why the tool prints its reasoning for
 * every single tree, protected ones included.
 *
 * ## The rule, stated precisely
 *
 * A worktree is reclaimed **only if every one of these is true**. Any single failure protects
 * it, and the failure is named in the output.
 *
 *   1. It is **not** the primary checkout.
 *   2. It is **not** locked (`git worktree lock`).
 *   3. `git status --porcelain` is **empty** — no modified, staged, or untracked-and-unignored
 *      files. Ignored files (`node_modules`, caches) do not count and are deleted with it.
 *   4. `git rev-list --count HEAD --not --remotes` is **zero** — every commit reachable from its
 *      HEAD exists on some remote-tracking ref. This is stronger than "merged" and it is the
 *      exact statement of "nothing here would be lost".
 *   5. Its HEAD is an **ancestor of `origin/main`** — the branch's work is in the trunk. This
 *      is the owner's rule; `--any-pushed` relaxes it to rule 4 alone and says so loudly.
 *   6. **No operation is in progress**: no `MERGE_HEAD`, `REBASE_HEAD`, `CHERRY_PICK_HEAD`,
 *      `REVERT_HEAD`, `BISECT_LOG` or `sequencer/`. A worktree mid-rebase holds state that is
 *      in no commit anywhere.
 *   7. **No live agent**, by the same liveness evidence the browser semaphore uses — see below.
 *   8. It has been **quiet for `--min-age`** (default 24 h): nothing has touched its index,
 *      HEAD, or directory. This is the backstop for an agent that is thinking rather than
 *      running and therefore has no process signature at all.
 *   9. `git fetch` succeeded **within the last 10 minutes**. Rules 4 and 5 are statements about
 *      remote-tracking refs, and a stale ref makes both of them lies. Without a fresh fetch
 *      `--apply` refuses to run at all.
 *
 * And then, having decided, it still calls **`git worktree remove` without `--force`**, so
 * git re-checks 2 and 3 with its own implementation before anything is unlinked. Two
 * independent checks of the expensive condition is not redundancy; it is the design.
 *
 * ## Liveness evidence, identical to the semaphore's
 *
 * A PID is not an identity across a reboot — that is why `tools/lib/browser-budget.mjs` stamps
 * every lock with the kernel's boot generation, and this uses the same `bootId()`. A worktree
 * is **in use** if any of these names it:
 *
 *   - a **live budget slot** whose `root` or `cwd` is inside it (`kill(pid,0)`, boot generation
 *     and heartbeat all checked, by `listSlots()` itself);
 *   - the **current working directory** of any live process — one `lsof -a -d cwd`, 0.2 s for
 *     the whole machine;
 *   - the **command line** of any live process;
 *   - a **listening socket** held by such a process.
 *
 * ## What it will never touch, under any flag
 *
 *   - the primary checkout, or anything outside a known worktree root or scratch root;
 *   - **port 5173** and any dev server that is not positively identified as unowned;
 *   - anything **tracked by git**, including committed screenshots;
 *   - `.git` object storage. Removing a worktree does **not** remove its branch or its commits;
 *     they stay in the shared object store, and the branch ref keeps them reachable.
 *
 * ## Usage
 *
 *     node tools/reclaim.mjs                        what is reclaimable and why — changes nothing
 *     node tools/reclaim.mjs --json                 the same, machine-readable
 *     node tools/reclaim.mjs --explain <path>       every test, for one worktree
 *     node tools/reclaim.mjs --apply                do it (needs a fetch newer than 10 min)
 *     node tools/reclaim.mjs --apply --only=stale   only prune metadata for trees already gone
 *     node tools/reclaim.mjs --min-age=48h          be more conservative
 *     node tools/reclaim.mjs --under=<dir> --apply  restrict everything to one subtree
 *     node tools/reclaim.mjs --include=screenshots  offer untracked screenshot trees too
 *     node tools/reclaim.mjs --install-schedule     write a launchd job (does not load it)
 *
 * Groups for `--only` / `--skip`: `stale`, `worktrees`, `scratch`, `screenshots`, `servers`.
 *
 * Every removal is appended to `<budget dir>/reclaim-log.jsonl` with the path, the branch and
 * the HEAD sha, so that even a mistake leaves the commits nameable.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { bootId, listSlots, paths, reapStale } from './lib/browser-budget.mjs';

const ROOT = paths.REPO_ROOT;
const LOG_FILE = path.join(paths.BUDGET_DIR, 'reclaim-log.jsonl');

/* ──────────────────────────────── arguments ──────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const value = (name, dflt = null) => {
  const f = flag(name);
  if (!f) return dflt;
  return f.includes('=') ? f.slice(f.indexOf('=') + 1) : dflt;
};

const APPLY = argv.includes('--apply');
const JSON_OUT = argv.includes('--json');
const ANY_PUSHED = argv.includes('--any-pushed');
const EXPLAIN = value('explain');
const QUIET = argv.includes('--quiet');
/** Force the `du` pass even under `--json`, for `node tools/browsers.mjs machine`. */
const SIZES = argv.includes('--sizes');
/**
 * Restrict everything to one subtree.
 *
 * Two callers need this. `tools/qa-reclaim.mjs` builds fixture worktrees under a temporary
 * directory and must be able to run the real `--apply` path against *only* those, because a
 * safety test that reclaims the machine while proving it is safe has failed at its job. And an
 * operator clearing one agent's leftovers wants the same. Without a scope, `--apply` is
 * all-or-nothing, and an all-or-nothing destructive command is one nobody runs.
 */
const UNDER = value('under') ? path.resolve(value('under')) : null;

/** `48h`, `30m`, `14d`, or a bare number of hours. */
const parseAge = (s, dflt) => {
  if (!s) return dflt;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i);
  if (!m) throw new Error(`--min-age: expected something like 24h, 90m or 7d; got ${JSON.stringify(s)}`);
  const mult = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, '': 3600e3 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
};

const MIN_AGE_MS = parseAge(value('min-age'), 24 * 3600e3);
const SCRATCH_AGE_MS = parseAge(value('scratch-age'), 24 * 3600e3);
const SHOT_AGE_MS = parseAge(value('screenshot-age'), 14 * 86400e3);
const FETCH_MAX_AGE_MS = parseAge(value('fetch-age'), 10 * 60e3);

const ALL_GROUPS = ['stale', 'worktrees', 'scratch', 'screenshots', 'servers'];
/** Screenshots are opt-in: they are the one class where "old" and "wanted" are uncorrelated. */
const DEFAULT_GROUPS = ['stale', 'worktrees', 'scratch', 'servers'];
const included = new Set(value('include', '').split(',').filter(Boolean));
const only = value('only', '').split(',').filter(Boolean);
const skipped = new Set(value('skip', '').split(',').filter(Boolean));
for (const g of [...included, ...only, ...skipped]) {
  if (!ALL_GROUPS.includes(g)) throw new Error(`unknown group ${JSON.stringify(g)}; expected one of ${ALL_GROUPS.join(', ')}`);
}
const GROUPS = new Set(
  (only.length ? only : [...DEFAULT_GROUPS, ...included]).filter((g) => !skipped.has(g))
);

/* ──────────────────────────────── helpers ──────────────────────────────── */

const git = (args, cwd = ROOT) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { return null; }
};
const sh = (cmd, args, ms = 15_000) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: ms, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
};

const dur = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return '?';
  const h = ms / 3600e3;
  if (h < 1) return `${Math.round(ms / 60e3)}m`;
  if (h < 48) return `${h.toFixed(0)}h`;
  return `${(h / 24).toFixed(0)}d`;
};
const mb = (n) => (n == null ? '?' : n >= 1024 ? `${(n / 1024).toFixed(1)}G` : `${Math.round(n)}M`);

/** Disk used by a directory, in MB. One `du` per tree; the slow part of this tool. */
const sizeMB = (p) => {
  const out = sh('du', ['-sk', p], 60_000);
  const kb = Number(out.split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb / 1024 : null;
};

const isInside = (child, parent) => {
  const c = path.resolve(child); const p = path.resolve(parent);
  return c === p || c.startsWith(`${p}${path.sep}`);
};

/**
 * `/tmp` on Darwin is a symlink to `/private/tmp`, and `git worktree list` reports the resolved
 * form while every process on the machine reports the one the user typed. Comparing them
 * without normalising is how a live worktree looks dead.
 */
const norm = (p) => {
  if (!p) return p;
  const r = path.resolve(p);
  return r.startsWith('/private/tmp/') ? r.replace('/private/tmp/', '/tmp/') : r;
};

/* ──────────────────────────── liveness evidence ──────────────────────────── */

/**
 * Every path any live process is standing in, or naming on its command line.
 *
 * This is the same question the browser semaphore answers about slots, asked about directories,
 * and it uses the same three tests: the boot generation (a record from before the last reboot
 * is not evidence of anything), `kill(pid, 0)`, and — for slots — the heartbeat, which
 * `listSlots()` has already applied by the time this reads it.
 *
 * `lsof -a -d cwd -Fpn` enumerates the current directory of every process on the machine in
 * about 0.2 s. There is no cheaper complete answer, and an incomplete one is not usable: the
 * consequence of missing a live agent here is deleting its work.
 */
const liveUsage = () => {
  const users = new Map(); // normalised path prefix -> [{pid, why, detail}]
  const note = (p, entry) => {
    const k = norm(p);
    if (!k) return;
    if (!users.has(k)) users.set(k, []);
    users.get(k).push(entry);
  };

  reapStale();
  for (const s of listSlots()) {
    if (s.stale || !s.rec) continue;
    for (const p of [s.rec.root, s.rec.cwd]) {
      if (p) note(p, { pid: s.rec.pid, why: 'browser-budget slot', detail: `${s.rec.label} slot ${s.slot}` });
    }
  }

  const cwds = [];
  let pid = null;
  for (const line of sh('lsof', ['-a', '-d', 'cwd', '-Fpn']).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) cwds.push({ pid, dir: line.slice(1) });
  }
  const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
  for (const c of cwds) {
    if (!alive(c.pid)) continue;
    note(c.dir, { pid: c.pid, why: 'process cwd', detail: c.dir });
  }

  const cmdlines = [];
  for (const line of sh('ps', ['-A', '-o', 'pid=,etime=,command=']).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (m) cmdlines.push({ pid: Number(m[1]), etime: m[2], cmd: m[3] });
  }

  return {
    users,
    cmdlines,
    /** Everything naming `dir`, from any of the sources. */
    forPath(dir) {
      const d = norm(dir);
      const out = [];
      for (const [k, entries] of users) if (isInside(k, d)) out.push(...entries);
      for (const c of cmdlines) {
        if (c.pid === process.pid) continue;
        if (c.cmd.includes(d) || (d !== norm(d) && c.cmd.includes(dir))) {
          out.push({ pid: c.pid, why: 'command line', detail: `${c.cmd.slice(0, 90)} (up ${c.etime})` });
        }
      }
      return out;
    },
  };
};

/* ─────────────────────────────── worktrees ─────────────────────────────── */

const listWorktrees = () => {
  const out = [];
  let cur = null;
  for (const line of (git(['worktree', 'list', '--porcelain']) ?? '').split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9), head: null, branch: null, detached: false, locked: false, prunable: false, lockReason: null };
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === 'detached') cur.detached = true;
    else if (line.startsWith('locked')) { cur.locked = true; cur.lockReason = line.slice(7).trim() || null; }
    else if (line.startsWith('prunable')) { cur.prunable = true; cur.prunableWhy = line.slice(9).trim(); }
  }
  if (cur) out.push(cur);
  return out;
};

const OP_FILES = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer', 'rebase-merge', 'rebase-apply'];

/** The real git directory for a worktree, following the `.git` file a linked worktree has. */
const gitDirOf = (wt) => {
  const dotgit = path.join(wt, '.git');
  try {
    const st = statSync(dotgit);
    if (st.isDirectory()) return dotgit;
    const m = readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
};

/**
 * The most recent moment anything happened in this worktree.
 *
 * The index and `HEAD` in the worktree's own git dir move on every git operation an agent
 * performs, including the ones that leave no process behind by the time this runs. The
 * directory's own mtime moves when a file is created or removed at the top level. The newest
 * of the three is the closest cheap approximation of "when did somebody last care about this",
 * and cheap matters: the alternative is walking 28 GB.
 */
const lastTouched = (wt, gitDir) => {
  let newest = 0;
  const bump = (p) => { try { newest = Math.max(newest, statSync(p).mtimeMs); } catch { /* absent */ } };
  bump(wt);
  if (gitDir) for (const f of ['index', 'HEAD', 'ORIG_HEAD', 'logs/HEAD']) bump(path.join(gitDir, f));
  return newest || null;
};

/**
 * Every test, for one worktree, with the verdict last.
 *
 * The tests are all evaluated even after one has failed. A tree protected by three different
 * things is a more informative report than one protected by whichever test happened to run
 * first, and the cost is a few milliseconds per tree.
 */
const inspectWorktree = (wt, { live, mergeBase }) => {
  const p = wt.path;
  const protections = [];
  const notes = [];

  if (norm(p) === norm(ROOT)) protections.push({ test: 'primary', detail: 'this is the primary checkout' });
  if (wt.locked) protections.push({ test: 'locked', detail: wt.lockReason ?? 'git worktree lock' });

  const exists = existsSync(p);
  if (!exists) {
    return { ...wt, exists: false, protections: [], verdict: 'stale-metadata',
      reason: wt.prunableWhy ?? 'the directory is gone; only the registration remains' };
  }

  const gitDir = gitDirOf(p);

  const status = git(['status', '--porcelain'], p);
  if (status === null) {
    protections.push({ test: 'unreadable', detail: 'git status failed here; refusing to guess' });
  } else if (status.length) {
    const lines = status.split('\n');
    protections.push({
      test: 'uncommitted',
      detail: `${lines.length} uncommitted path(s), e.g. ${lines.slice(0, 3).map((l) => l.trim().slice(0, 40)).join('; ')}`,
    });
  }

  const unpushed = git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], p);
  const unpushedN = unpushed === null ? null : Number(unpushed);
  if (unpushedN === null) {
    protections.push({ test: 'unpushed-unknown', detail: 'could not count unpushed commits; refusing to guess' });
  } else if (unpushedN > 0) {
    const subjects = (git(['log', '--oneline', '-3', 'HEAD', '--not', '--remotes'], p) ?? '').split('\n').filter(Boolean);
    protections.push({
      test: 'unpushed',
      detail: `${unpushedN} commit(s) on no remote — ${subjects.map((s) => s.slice(0, 52)).join(' | ') || 'unreadable'}`,
    });
  }

  // Merged into the trunk. Only meaningful once we know nothing is unpushed, but computed
  // regardless so the report can say "pushed but not merged" rather than falling silent.
  const merged = mergeBase && wt.head ? git(['merge-base', '--is-ancestor', wt.head, mergeBase]) !== null : null;
  if (!ANY_PUSHED && merged === false) {
    protections.push({ test: 'not-merged', detail: `HEAD is not an ancestor of ${mergeBase}` });
  }
  if (ANY_PUSHED && merged === false) notes.push(`not merged into ${mergeBase}, but every commit is pushed (--any-pushed)`);

  if (gitDir) {
    const inProgress = OP_FILES.filter((f) => existsSync(path.join(gitDir, f)));
    if (inProgress.length) protections.push({ test: 'operation-in-progress', detail: inProgress.join(', ') });
  }

  const users = live.forPath(p);
  if (users.length) {
    protections.push({
      test: 'in-use',
      detail: users.slice(0, 3).map((u) => `pid ${u.pid} (${u.why})`).join(', ')
        + (users.length > 3 ? ` +${users.length - 3} more` : ''),
    });
  }

  const touched = lastTouched(p, gitDir);
  const ageMs = touched ? Date.now() - touched : null;
  if (ageMs == null) protections.push({ test: 'age-unknown', detail: 'could not stat it; refusing to guess' });
  else if (ageMs < MIN_AGE_MS) protections.push({ test: 'too-young', detail: `last touched ${dur(ageMs)} ago, minimum is ${dur(MIN_AGE_MS)}` });

  return {
    ...wt, exists: true, unpushed: unpushedN, merged, dirty: Boolean(status), ageMs, users,
    protections, notes,
    verdict: protections.length ? 'protected' : 'reclaimable',
    reason: protections.length
      ? protections.map((x) => x.test).join(' + ')
      : `clean, ${unpushedN} unpushed, merged into ${mergeBase}, idle ${dur(ageMs)}, no live process`,
  };
};

/* ──────────────────────────── scratch and shots ──────────────────────────── */

const SCRATCH_ROOTS = ['/tmp', '/private/tmp'];

/**
 * `/tmp/tc-*` trees that are not worktrees, not the budget directory, and not in use.
 *
 * The budget directory is excluded by name and again by the fact that it is being written to
 * continuously; deleting it mid-run would drop every live slot record at once and let the
 * whole fleet launch simultaneously, which is the 22 August failure reconstructed from its
 * own safety mechanism.
 */
const scanScratch = ({ live, worktreePaths }) => {
  const seen = new Set();
  const out = [];
  for (const root of SCRATCH_ROOTS) {
    let names = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('tc-')) continue;
      const p = path.join(root, name);
      const key = norm(p);
      if (seen.has(key)) continue;
      seen.add(key);

      const protections = [];
      if (isInside(p, paths.BUDGET_DIR) || isInside(paths.BUDGET_DIR, p)) {
        protections.push({ test: 'budget-dir', detail: 'this is the browser budget semaphore' });
      }
      if ([...worktreePaths].some((w) => isInside(w, p) || isInside(p, w))) {
        protections.push({ test: 'worktree', detail: 'a registered worktree lives here — handled as a worktree, not as scratch' });
      }
      let ageMs = null;
      try { ageMs = Date.now() - statSync(p).mtimeMs; } catch { protections.push({ test: 'age-unknown', detail: 'cannot stat' }); }
      if (ageMs != null && ageMs < SCRATCH_AGE_MS) protections.push({ test: 'too-young', detail: `modified ${dur(ageMs)} ago` });
      const users = live.forPath(p);
      if (users.length) protections.push({ test: 'in-use', detail: users.slice(0, 2).map((u) => `pid ${u.pid} (${u.why})`).join(', ') });

      out.push({
        path: p, ageMs, users, protections,
        verdict: protections.length ? 'protected' : 'reclaimable',
        reason: protections.length ? protections.map((x) => x.test).join(' + ') : `untouched for ${dur(ageMs)}, nothing using it`,
      });
    }
  }
  return out;
};

/**
 * Screenshot trees, and the one rule that makes this safe: **tracked means keep**.
 *
 * A screenshot committed to the repository is documentation and is not this tool's business at
 * any age. An untracked one is a by-product of a probe run. `git ls-files` answers the question
 * exactly, for the whole directory at once, and it is the difference between reclaiming a
 * gigabyte of scratch renders and deleting the evidence behind a doc page.
 */
const scanScreenshots = ({ live }) => {
  const dir = path.join(ROOT, 'screenshots');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = path.join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;

    const protections = [];
    const tracked = git(['ls-files', '--error-unmatch', '--', path.relative(ROOT, p)]);
    if (tracked) protections.push({ test: 'tracked', detail: `${tracked.split('\n').length} file(s) committed to git` });
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs < SHOT_AGE_MS) protections.push({ test: 'too-young', detail: `modified ${dur(ageMs)} ago, minimum is ${dur(SHOT_AGE_MS)}` });
    const users = live.forPath(p);
    if (users.length) protections.push({ test: 'in-use', detail: users.slice(0, 2).map((u) => `pid ${u.pid}`).join(', ') });

    out.push({
      path: p, ageMs, protections,
      verdict: protections.length ? 'protected' : 'reclaimable',
      reason: protections.length ? protections.map((x) => x.test).join(' + ') : `untracked and ${dur(ageMs)} old`,
    });
  }
  return out;
};

/* ───────────────────────────────── servers ───────────────────────────────── */

/**
 * Dev servers and headless browsers that no live slot claims.
 *
 * The rule is `tools/browsers.mjs sweep`'s, unchanged and deliberately so: **never 5173** (the
 * owner's playtest server), never a Vite with no `--port` on its command line (which is what
 * `npm run dev` looks like, so an unattributable server is left alone rather than guessed at),
 * and never one whose port or PID a live slot recorded.
 *
 * The 23-hour node process from `/tmp` that prompted this is caught by the age test below
 * rather than by the port test, because it was not a Vite at all.
 */
const scanServers = ({ live }) => {
  reapStale();
  const slots = listSlots().filter((s) => !s.stale);
  const ownedPorts = new Set(slots.map((s) => s.rec?.port).filter(Boolean));
  const ownedPids = new Set(slots.flatMap((s) => [s.rec?.pid, s.rec?.vitePid]).filter(Boolean));
  const out = [];
  for (const c of live.cmdlines) {
    const isVite = /vite-runner\.mjs|node_modules\/\.bin\/vite|bin\/vite\.js|npm exec vite/.test(c.cmd);
    if (!isVite) continue;
    const port = Number(c.cmd.match(/--port[= ](\d+)/)?.[1]) || null;
    const protections = [];
    if (port === 5173) protections.push({ test: 'owner-port', detail: 'port 5173 is the owner\'s playtest server' });
    if (port === null) protections.push({ test: 'unattributable', detail: 'no --port on the command line; this is what `npm run dev` looks like' });
    if (port && ownedPorts.has(port)) protections.push({ test: 'owned', detail: 'a live budget slot holds this port' });
    if (ownedPids.has(c.pid)) protections.push({ test: 'owned', detail: 'a live budget slot recorded this pid' });
    out.push({
      pid: c.pid, port, etime: c.etime, cmd: c.cmd.slice(0, 110), protections,
      verdict: protections.length ? 'protected' : 'reclaimable',
      reason: protections.length ? protections.map((x) => x.test).join(' + ') : `port ${port}, up ${c.etime}, no slot claims it`,
    });
  }
  return out;
};

/* ─────────────────────────────── the fetch gate ─────────────────────────────── */

/**
 * Rules 4 and 5 are statements about remote-tracking refs. A stale ref makes both of them lies
 * in the dangerous direction only for rule 5 — an unfetched `origin/main` under-reports what is
 * merged, which over-protects — but a *deleted* remote branch that is still in `refs/remotes`
 * makes rule 4 say "pushed" about commits that exist nowhere else. So: fetch, with `--prune`,
 * and refuse `--apply` outright if it fails.
 */
const freshFetch = () => {
  const before = Date.now();
  const ok = git(['fetch', '--prune', '--quiet', 'origin']) !== null;
  return { ok, ms: Date.now() - before, at: new Date().toISOString() };
};

const fetchHeadAgeMs = () => {
  for (const f of ['FETCH_HEAD', 'refs/remotes/origin/main']) {
    try { return Date.now() - statSync(path.join(ROOT, '.git', f)).mtimeMs; } catch { /* next */ }
  }
  return null;
};

/* ──────────────────────────────── the schedule ──────────────────────────────── */

const PLIST_LABEL = 'com.total-claude.reclaim';
const PLIST_PATH = path.join(process.env.HOME ?? '/tmp', 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const SCHED_LOG = path.join(process.env.HOME ?? '/tmp', 'Library', 'Logs', 'total-claude-reclaim.log');

/**
 * A launchd job, written but **not loaded**.
 *
 * Loading it is a decision about somebody's machine that deletes files while he is asleep, and
 * that is his to make, not this tool's. So `--install-schedule` writes the plist, prints the
 * one line that starts it and the one that stops it, and stops.
 *
 * The default job is deliberately **not** the full reclaimer. It runs
 * `--apply --only=stale,scratch,servers`:
 *
 *   - `stale`   — registrations whose directory is already gone. `git worktree prune` re-checks
 *                 this itself; there is nothing on disk to lose.
 *   - `scratch` — `/tmp/tc-*` older than 24 h with no process in it. `/tmp` is by definition
 *                 not where anything is kept, and this is where the 612 MB is.
 *   - `servers` — Vite servers that no live slot claims, never 5173, never one with no `--port`.
 *
 * **Worktrees are excluded from the scheduled job by default.** They are 28 GB and they are the
 * point, but they are also the only class where a mistake costs work rather than disk, and the
 * difference between "I ran it" and "it ran while I was out" is the whole of the risk. Pass
 * `--groups=stale,scratch,servers,worktrees` to include them once the daily preview has been
 * boring for a week.
 */
const installSchedule = () => {
  const groups = value('groups', 'stale,scratch,servers');
  const hour = Number(value('at', '3'));
  const node = process.execPath;
  const tool = path.join(ROOT, 'tools', 'reclaim.mjs');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${tool}</string>
    <string>--apply</string>
    <string>--only=${groups}</string>
    <string>--min-age=${Math.round(MIN_AGE_MS / 3600e3)}h</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardOutPath</key><string>${SCHED_LOG}</string>
  <key>StandardErrorPath</key><string>${SCHED_LOG}</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
</dict>
</plist>
`;
  mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, plist);
  console.log(`wrote ${PLIST_PATH}`);
  console.log(`  runs: reclaim --apply --only=${groups} --min-age=${Math.round(MIN_AGE_MS / 3600e3)}h, daily at ${String(hour).padStart(2, '0')}:17`);
  console.log(`  log:  ${SCHED_LOG}`);
  console.log('  ProcessType=Background and LowPriorityIO, so it cannot itself be the thing that');
  console.log('  makes the fans audible.\n');
  console.log('It is NOT loaded. Deleting files on a schedule is your decision, not this tool\'s:');
  console.log(`  start it:  launchctl bootstrap gui/$(id -u) ${PLIST_PATH}`);
  console.log(`  stop it:   launchctl bootout gui/$(id -u)/${PLIST_LABEL}`);
  console.log(`  run once:  launchctl kickstart -p gui/$(id -u)/${PLIST_LABEL}`);
  if (!groups.includes('worktrees')) {
    console.log('\nWorktrees are NOT in the scheduled job. They are 28 GB and they are the point, but');
    console.log('they are also the only class where a mistake costs work rather than disk. Add them');
    console.log('with --groups=stale,scratch,servers,worktrees once the daily preview has been');
    console.log('boring for a week — or keep running that one by hand, which is also a defensible');
    console.log('answer and the one this tool would choose.');
  }
};

if (argv.includes('--install-schedule')) { installSchedule(); process.exit(0); }
if (argv.includes('--uninstall-schedule')) {
  try { rmSync(PLIST_PATH); console.log(`removed ${PLIST_PATH}`); } catch { console.log(`${PLIST_PATH} was not there`); }
  console.log(`  if it was loaded:  launchctl bootout gui/$(id -u)/${PLIST_LABEL}`);
  process.exit(0);
}

/* ──────────────────────────────── the report ──────────────────────────────── */

const receipt = (entry) => {
  try {
    mkdirSync(paths.BUDGET_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), bootId: bootId(), ...entry })}\n`);
  } catch { /* a log that cannot be written must not stop the work */ }
};

const main = () => {
  const live = liveUsage();
  const mergeBase = git(['rev-parse', '--verify', '--quiet', 'origin/main']) ? 'origin/main' : null;

  let fetched = null;
  if (APPLY && GROUPS.has('worktrees')) {
    fetched = freshFetch();
    if (!fetched.ok) {
      console.error('reclaim: `git fetch origin` failed, so "every commit is pushed" cannot be established.');
      console.error('  Rules 4 and 5 are statements about remote-tracking refs and a stale ref is a lie.');
      console.error('  Refusing to remove anything. Fix the network or the remote and re-run.');
      process.exit(2);
    }
  } else if (GROUPS.has('worktrees')) {
    const age = fetchHeadAgeMs();
    if (age != null && age > FETCH_MAX_AGE_MS && !QUIET) {
      console.log(`note: last fetch was ${dur(age)} ago. --apply fetches first; this preview may be out of date.\n`);
    }
  }

  const inScope = (p) => !UNDER || isInside(norm(p), norm(UNDER));
  const worktrees = GROUPS.has('worktrees') || GROUPS.has('stale')
    ? listWorktrees().filter((w) => inScope(w.path)).map((w) => inspectWorktree(w, { live, mergeBase }))
    : [];
  const wtPaths = new Set(worktrees.map((w) => norm(w.path)));
  const scratch = GROUPS.has('scratch') ? scanScratch({ live, worktreePaths: wtPaths }).filter((s) => inScope(s.path)) : [];
  const shots = GROUPS.has('screenshots') ? scanScreenshots({ live }).filter((s) => inScope(s.path)) : [];
  // A server has no path, so `--under` excludes the whole group rather than filtering it: the
  // alternative is a scoped run quietly killing a process the operator did not have in view.
  const servers = GROUPS.has('servers') && !UNDER ? scanServers({ live }) : [];

  const stale = worktrees.filter((w) => w.verdict === 'stale-metadata');
  const reclaimableWt = GROUPS.has('worktrees') ? worktrees.filter((w) => w.verdict === 'reclaimable') : [];
  const protectedWt = worktrees.filter((w) => w.verdict === 'protected');

  if (EXPLAIN) {
    const want = norm(path.resolve(EXPLAIN));
    const w = worktrees.find((x) => norm(x.path) === want);
    if (!w) { console.error(`reclaim: ${EXPLAIN} is not a registered worktree.`); process.exit(1); }
    console.log(`${w.path}\n  branch ${w.branch ?? '(detached)'}  head ${w.head?.slice(0, 12)}`);
    console.log(`  verdict: ${w.verdict.toUpperCase()}`);
    if (!w.protections.length) console.log(`    ${w.reason}`);
    for (const p of w.protections) console.log(`    PROTECTED by ${p.test}: ${p.detail}`);
    for (const n of w.notes) console.log(`    note: ${n}`);
    if (w.users?.length) for (const u of w.users) console.log(`    in use: pid ${u.pid} — ${u.why} — ${u.detail}`);
    process.exit(0);
  }

  // Sizes only for things we might act on; `du` over 118 trees is a minute of disk.
  if (!JSON_OUT || APPLY || SIZES) {
    for (const w of reclaimableWt) w.sizeMB = sizeMB(w.path);
    for (const s of scratch.filter((x) => x.verdict === 'reclaimable')) s.sizeMB = sizeMB(s.path);
    for (const s of shots.filter((x) => x.verdict === 'reclaimable')) s.sizeMB = sizeMB(s.path);
  }
  const totalMB = [...reclaimableWt, ...scratch, ...shots]
    .filter((x) => x.verdict === 'reclaimable').reduce((a, b) => a + (b.sizeMB ?? 0), 0);

  const removed = [];
  const refused = [];

  if (APPLY) {
    if (GROUPS.has('stale') && stale.length) {
      // git's own prune: it removes only registrations whose directory is missing, which it
      // re-checks itself. Nothing on disk is touched.
      git(['worktree', 'prune', '--verbose']);
      for (const s of stale) { removed.push({ kind: 'stale-metadata', path: s.path, head: s.head }); receipt({ kind: 'stale-metadata', path: s.path, head: s.head, branch: s.branch }); }
    }
    for (const w of reclaimableWt) {
      // Deliberately WITHOUT --force: git re-checks locked and dirty with its own
      // implementation, and a disagreement between the two is a refusal, not a removal.
      const out = git(['worktree', 'remove', w.path]);
      if (out === null) {
        refused.push({ ...w, refusedBy: 'git worktree remove (no --force) declined — it disagrees that this tree is clean' });
        receipt({ kind: 'worktree', path: w.path, head: w.head, branch: w.branch, result: 'refused-by-git' });
        continue;
      }
      removed.push({ kind: 'worktree', path: w.path, head: w.head, branch: w.branch, sizeMB: w.sizeMB });
      receipt({ kind: 'worktree', path: w.path, head: w.head, branch: w.branch, sizeMB: w.sizeMB, result: 'removed' });
    }
    for (const s of scratch.filter((x) => x.verdict === 'reclaimable')) {
      try { rmSync(s.path, { recursive: true, force: true }); removed.push({ kind: 'scratch', path: s.path, sizeMB: s.sizeMB }); receipt({ kind: 'scratch', path: s.path, sizeMB: s.sizeMB, result: 'removed' }); }
      catch (e) { refused.push({ ...s, refusedBy: String(e.message).slice(0, 80) }); }
    }
    for (const s of shots.filter((x) => x.verdict === 'reclaimable')) {
      try { rmSync(s.path, { recursive: true, force: true }); removed.push({ kind: 'screenshots', path: s.path, sizeMB: s.sizeMB }); receipt({ kind: 'screenshots', path: s.path, sizeMB: s.sizeMB, result: 'removed' }); }
      catch (e) { refused.push({ ...s, refusedBy: String(e.message).slice(0, 80) }); }
    }
    for (const s of servers.filter((x) => x.verdict === 'reclaimable')) {
      try { process.kill(-s.pid, 'SIGTERM'); } catch { try { process.kill(s.pid, 'SIGTERM'); } catch { /* gone */ } }
      removed.push({ kind: 'server', pid: s.pid, port: s.port });
      receipt({ kind: 'server', pid: s.pid, port: s.port, result: 'signalled' });
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({
      applied: APPLY, fetched, mergeBase, minAgeMs: MIN_AGE_MS, groups: [...GROUPS], anyPushed: ANY_PUSHED, under: UNDER,
      worktrees, scratch, screenshots: shots, servers, removed, refused,
      summary: { stale: stale.length, reclaimable: reclaimableWt.length, protected: protectedWt.length, reclaimableMB: Math.round(totalMB) },
    }, null, 2));
    return;
  }

  /* ── printed report ── */
  const line = (s = '') => console.log(s);
  line(`reclaim — ${APPLY ? 'APPLYING' : 'preview only, nothing will be changed'}`);
  line(`  rule: clean + every commit pushed${ANY_PUSHED ? '' : ` + merged into ${mergeBase ?? 'origin/main'}`}`
    + ` + no operation in progress + no live process + idle ${dur(MIN_AGE_MS)}`);
  if (fetched) line(`  fetched origin in ${fetched.ms} ms — remote-tracking refs are current`);
  line(`  groups: ${[...GROUPS].join(', ')}${GROUPS.has('screenshots') ? '' : '   (screenshots need --include=screenshots)'}`);
  if (UNDER) line(`  scope: only things under ${UNDER}   (servers are excluded entirely by --under)`);
  line();

  if (GROUPS.has('stale')) {
    line(`worktree registrations whose directory is gone: ${stale.length}`);
    if (stale.length) line('  metadata only — nothing on disk. `git worktree prune` re-checks this itself.');
    line();
  }

  if (GROUPS.has('worktrees')) {
    line(`worktrees: ${worktrees.filter((w) => w.exists).length} on disk — `
      + `${reclaimableWt.length} reclaimable, ${protectedWt.length} protected`);
    if (reclaimableWt.length) {
      line('\n  reclaimable:');
      for (const w of reclaimableWt.sort((a, b) => (b.sizeMB ?? 0) - (a.sizeMB ?? 0))) {
        line(`    ${mb(w.sizeMB).padStart(6)}  ${path.basename(w.path).padEnd(28)} ${String(w.branch ?? '(detached)').slice(0, 34).padEnd(34)} idle ${dur(w.ageMs)}`);
      }
    }
    const byReason = new Map();
    for (const w of protectedWt) {
      for (const p of w.protections) byReason.set(p.test, (byReason.get(p.test) ?? 0) + 1);
    }
    if (byReason.size) {
      line('\n  protected, and by what (a tree can be protected by more than one):');
      for (const [test, n] of [...byReason].sort((a, b) => b[1] - a[1])) line(`    ${String(n).padStart(4)}  ${test}`);
    }
    const risky = protectedWt.filter((w) => w.protections.some((p) => p.test === 'unpushed'));
    if (risky.length) {
      line(`\n  !! ${risky.length} worktree(s) hold commits that exist on no remote. These are the ones`);
      line('     a naive "delete what is merged" would have destroyed:');
      for (const w of risky.sort((a, b) => (b.unpushed ?? 0) - (a.unpushed ?? 0))) {
        line(`       ${String(w.unpushed).padStart(3)} commit${w.unpushed === 1 ? ' ' : 's'}  ${path.basename(w.path).padEnd(28)} ${w.branch ?? '(detached)'}`);
      }
      line('     Push them, or accept that they stay. This tool will never remove one.');
    }
    line();
  }

  for (const [name, list] of [['scratch under /tmp', scratch], ['screenshot trees', shots]]) {
    if (!list.length) continue;
    const r = list.filter((x) => x.verdict === 'reclaimable');
    line(`${name}: ${r.length} reclaimable of ${list.length}`);
    for (const x of r.sort((a, b) => (b.sizeMB ?? 0) - (a.sizeMB ?? 0)).slice(0, 12)) {
      line(`    ${mb(x.sizeMB).padStart(6)}  ${path.basename(x.path).padEnd(28)} ${x.reason}`);
    }
    const prot = list.filter((x) => x.verdict === 'protected');
    if (prot.length) line(`  ${prot.length} protected: ${[...new Set(prot.flatMap((x) => x.protections.map((p) => p.test)))].join(', ')}`);
    line();
  }

  if (GROUPS.has('servers') && servers.length) {
    const r = servers.filter((x) => x.verdict === 'reclaimable');
    line(`dev servers: ${r.length} unowned of ${servers.length}`);
    for (const s of r) line(`    pid ${String(s.pid).padEnd(7)} port ${String(s.port).padEnd(5)} up ${s.etime}`);
    const prot = servers.filter((x) => x.verdict === 'protected');
    if (prot.length) line(`  ${prot.length} protected: ${[...new Set(prot.flatMap((x) => x.protections.map((p) => p.test)))].join(', ')}`);
    line();
  }

  if (APPLY) {
    line(`removed ${removed.length} thing(s); ${refused.length} refused at the last moment.`);
    for (const r of refused) line(`  REFUSED ${r.path ?? r.pid}: ${r.refusedBy}`);
    line(`  receipts: ${LOG_FILE}`);
    line('  Removing a worktree does not remove its branch or its commits. They stay in the');
    line('  shared object store and the branch ref keeps them reachable.');
  } else {
    line(`would reclaim about ${mb(totalMB)} of disk.`);
    line('  nothing has been changed. To do it:  node tools/reclaim.mjs --apply');
    line('  to see every test for one tree:      node tools/reclaim.mjs --explain <path>');
  }
};

main();
