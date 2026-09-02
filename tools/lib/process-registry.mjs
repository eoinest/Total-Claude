#!/usr/bin/env node
/**
 * Every process this repository starts is owned, killable as a group, and reaped when its owner
 * is gone.
 *
 * ## The three leaks this closes, all measured on 23 Aug 2026
 *
 * **1. A stopped agent did not take its children with it.** An agent started
 * `tools/scratch/net-flake-load.mjs --runs=6`. The agent was stopped; the loop had been
 * reparented to init and went on relaunching browsers. It survived **two** `pkill` sweeps and
 * was found only by walking parents up from a live browser. This is the second orphan of this
 * shape here — the first was the `npx vite` wrapper — so `tools/lib/vite-runner.mjs` fixed the
 * instance and this fixes the class.
 *
 * **2. The unit of the cap was not the unit the owner sees.** `tools/browsers.mjs` warns, in
 * prose, that one browser is several OS processes, because a raw `ps` count misleads. The owner
 * has now asked twice how many *processes* are running. A cap expressed only in browsers cannot
 * answer the question he is asking, so there is now a ceiling in both units — see
 * `procCeiling` and the note on which unit is authoritative for what.
 *
 * **3. Nothing linked a process to the agent that owned it.** One agent killed a Vite server on
 * port 5901 that belonged to a sibling, and wrote afterwards that a single
 * `lsof -a -p <pid> -d cwd` would have told it. Ownership was inferable and not recorded. It is
 * now recorded on the way in, and `attribute()` still does the inference for anything that was
 * started outside this file.
 *
 * ## The design, and why it is not a daemon
 *
 * There is no supervisor process. A daemon would be the obvious shape and it is the wrong one:
 * it becomes the single thing whose death leaks everything, and the semaphore in
 * `browser-budget.mjs` already demonstrated the better pattern — **state on disk, liveness
 * re-derived on every read, never trusted.** So this is three independent mechanisms, any two of
 * which can fail without leaking and without wedging:
 *
 *   1. **The group, plus the descendant closure.** `spawnOwned` runs everything under
 *      `tools/lib/spawn-guard.mjs` with `detached: true`, so the guard is a process-group leader
 *      and the real command is in its group. `detached: true` *without* a group kill is precisely
 *      what happened on 23 Aug. But the group alone is **not** enough, and that was measured
 *      rather than assumed: Playwright launches the browser with `detached: true` too, so the
 *      browser sits in a group of its own and `kill(-pgid)` misses all four of its processes. See
 *      `treeMembers`. Everything here kills the group *and* everything descended from it.
 *   2. **The guard's anchor watch.** The guard polls the PIDs whose lives the job requires — the
 *      spawning process, and the agent session — and kills its tree when the first of them is
 *      gone. This is the fast path: an orphan lives about two seconds, not overnight.
 *   3. **The registry, and `reapOwned()`.** Every entry is a file naming the group, the anchors
 *      and the boot generation. `reapOwned()` re-derives liveness and kills the trees whose owners
 *      are gone. It is called from `acquireSlot`, so **every browser launch on this machine, by
 *      any agent, sweeps the registry first** — the window on a leak is "until anybody next
 *      starts a browser", not "until somebody remembers".
 *
 * Fail each in turn: guard SIGKILLed → the reaper finds the entry and kills the tree. Registry
 * unwritable → the guard still kills on anchor death. Both → the group id is still inherited by
 * everything in it, so one `node tools/browsers.mjs sweep --force` finishes it, and `machine` can
 * say whose it was.
 * Machine rebooted mid-anything → every entry's boot generation is wrong, so every entry is
 * dropped **without signalling any PID in it**, because those numbers now belong to strangers.
 *
 * ## Which unit the ceiling is in
 *
 * Both, deliberately, and they answer different questions.
 *
 * **Browsers is the admission unit**, because admission is a decision taken *before* anything is
 * spent, and the thing being decided is one `launch()`. You cannot grant three-fifths of a
 * browser.
 *
 * **Processes is the audit unit and the backstop**, because it is the number the owner reads off
 * `ps`, and because it catches three things a browser count provably cannot:
 *
 *   - a browser that took no slot — an unconverted tool, or `TC_BROWSER_BUDGET=off`;
 *   - a tool that takes **one** slot and opens twenty pages. `check-browser-budget.mjs` names
 *     this in its own "what it cannot catch" list. Each page is a renderer process, so the
 *     process count sees it and the browser count cannot;
 *   - a spawned tree that is not a browser at all — the 23 Aug loop, which held no slot at any
 *     moment a sweep looked.
 *
 * The number per unit is **measured on this machine**, not quoted:
 * `tools/scratch/procs-per-browser.mjs`, chrome-headless-shell under Playwright 1.62 —
 *
 * | state | chromium | vite | total |
 * |---|---|---|---|
 * | browser, no page | 3 (browser + gpu-process + utility) | 0 | 3 |
 * | browser + Vite + the real menu page | 4 (+ 1 renderer) | 1 + 1 guard | **6** |
 * | each additional page | +1 renderer | — | +1 |
 *
 * **So one unit of gate work is six OS processes** — four Chromium, one Vite, and one guard, which
 * is this file's own overhead and is counted rather than exempted. The ceiling is
 * `cap × (6 + 3)`: the measured six, plus three renderers of headroom so that a legitimately
 * multi-page tool is not refused for being multi-page. That is **36 away, 18 present, 9 playing**.
 * Override with `TC_MAX_PROCS`.
 *
 * ## Environment
 *
 * | variable | default | meaning |
 * |---|---|---|
 * | `TC_MAX_PROCS` | derived (36 / 18 / 9) | OS-process ceiling, machine-wide |
 * | `TC_PROC_BUDGET` | `on` | `off` disables the process ceiling — loudly |
 * | `TC_GUARD_WATCH_MS` | `2000` | how often the guard checks its anchors |
 * | `TC_GUARD_GRACE_MS` | `3000` | SIGTERM to SIGKILL, for a group being taken down |
 * | `TC_AGENT_ID` | from `CLAUDE_CODE_SESSION_ID` | who to record as the owner |
 * | `TC_AGENT_PID` | from `CLAUDE_PID` | the anchor whose death means the work is unowned |
 *
 * ## Usage
 *
 *     import { spawnOwned } from './lib/process-registry.mjs';
 *
 *     const job = spawnOwned(process.execPath, ['tools/scratch/load.mjs', '--runs=6'],
 *                            { label: 'net-flake-load', root: ROOT });
 *     await job.done;           // resolves with the exit code
 *     job.kill();               // or take the whole group down early
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { bootId, heartbeatAge, killable, pidAlive, stalenessOf } from './liveness.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(LIB_DIR, '..');
const REPO_ROOT = path.resolve(TOOLS_DIR, '..');
const GUARD = path.join(LIB_DIR, 'spawn-guard.mjs');

export const BUDGET_DIR = process.env.TC_BUDGET_DIR || '/tmp/tc-browser-budget';
export const REGISTRY_DIR = path.join(BUDGET_DIR, 'owned');
const TMP_DIR = path.join(BUDGET_DIR, 'tmp');

/** Nine guard heartbeats, matching the semaphore's margin for the same reason. */
const STALE_MS = Number(process.env.TC_PROC_STALE_MS || 90_000);

export const procBudgetEnabled = () => (process.env.TC_PROC_BUDGET || 'on').toLowerCase() !== 'off';

const ensureDirs = () => {
  for (const d of [BUDGET_DIR, REGISTRY_DIR, TMP_DIR]) mkdirSync(d, { recursive: true });
};

const rand = () => Math.random().toString(36).slice(2, 10);

const ps = (fmt) => {
  try { return execFileSync('ps', ['-A', '-o', fmt], { encoding: 'utf8', maxBuffer: 64 << 20 }); }
  catch { return ''; }
};

/* ─────────────────────────────── who we are ─────────────────────────────── */

/**
 * The owner of anything this process starts.
 *
 * `CLAUDE_CODE_SESSION_ID` is the agent's session, and `CLAUDE_PID` is the `claude` process
 * itself — verified on this machine: pid 10301 is
 * `claude --resume 98934e6c-19e5-47b6-8f42-ee01238370be`.
 *
 * **Neither of them identifies an *agent*, and that was measured rather than assumed.** Several
 * agents run as subagents of one `claude` CLI, in different worktrees, sharing both values: a
 * `qa-net` run in worktree `agent-aaa44128937a2cb8f` walked up to ppid 23238, which is *this*
 * agent's `claude`. So the **worktree** is the part of this record that distinguishes one agent's
 * work from another's, and `isSibling` treats a differing worktree as decisive on its own.
 *
 * What `CLAUDE_PID` *is* good for is the anchor: while it lives, some agent may still want this
 * work; when it dies, nobody does. The per-command case is covered separately, by anchoring a
 * spawned job on the process that spawned it — which for a directly-run tool is the tool itself.
 * The immediate parent shell comes and goes many times inside one agent's life.
 *
 * Both are overridable — `TC_AGENT_ID`, `TC_AGENT_PID` — because a human at a terminal has
 * neither, and a record that says `agent: null` is still better than no record: it says "a
 * human started this", which is itself a reason a sweep should leave it alone.
 *
 * The worktree is resolved with `git rev-parse --show-toplevel` rather than `process.cwd()`,
 * because a tool run from a subdirectory would otherwise register a different owner from the
 * same tool run from the root, and ownership that depends on where you were standing is not
 * ownership.
 */
let identityCache = null;
export const identity = ({ root = null, refresh = false } = {}) => {
  if (identityCache && !refresh && !root) return identityCache;
  const agent = process.env.TC_AGENT_ID || process.env.CLAUDE_CODE_SESSION_ID || null;
  const agentPidRaw = Number(process.env.TC_AGENT_PID || process.env.CLAUDE_PID || 0);
  const agentPid = Number.isFinite(agentPidRaw) && agentPidRaw > 1 ? agentPidRaw : null;
  let worktree = root ? path.resolve(root) : null;
  let branch = null;
  try {
    const cwd = worktree ?? process.cwd();
    worktree = execFileSync('git', ['rev-parse', '--show-toplevel'],
      { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || worktree;
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: worktree, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { /* not a git tree, or git is slow; the path we have is still an answer */ }
  const id = {
    agent,
    agentPid,
    agentAlive: agentPid ? pidAlive(agentPid) : null,
    worktree: worktree ?? process.cwd(),
    branch,
    human: !agent,
    from: process.env.TC_AGENT_ID ? 'TC_AGENT_ID' : (agent ? 'CLAUDE_CODE_SESSION_ID' : 'none — a human, or an unset environment'),
  };
  if (!root) identityCache = id;
  return id;
};

/** A short, stable, human-readable name for an owner. `a0ebb9da` beats a full UUID in a table. */
export const shortOwner = (rec) => {
  if (!rec) return '?';
  if (rec.agent) return rec.agent.slice(0, 8);
  if (rec.worktree) return path.basename(rec.worktree).replace(/^agent-/, '').slice(0, 8);
  return 'human';
};

/* ───────────────────────────── the registry ───────────────────────────── */

/**
 * Atomic create-with-contents, the same `link()` trick the semaphore uses.
 *
 * `open(…, 'wx')` is atomic but leaves a window in which the file exists and is empty, and a
 * reaper landing in that window reads an unreadable record, calls it stale, and deletes an entry
 * somebody is in the middle of creating — which for this file would mean losing the only record
 * of a process group that is about to start.
 */
const linkAtomic = (target, payload) => {
  const tmp = path.join(TMP_DIR, `owned-${process.pid}-${rand()}.json`);
  writeFileSync(tmp, payload);
  try { linkSync(tmp, target); return true; }
  catch (err) { if (err?.code !== 'EEXIST') throw err; return false; }
  finally { try { unlinkSync(tmp); } catch { /* already gone */ } }
};

/**
 * The substring a kill must find in a group before it is allowed to signal it.
 *
 * A recorded pgid is only a number, and after enough PID churn some unrelated process leads that
 * group. `killTree`'s `expect` guard is what turns "kill group 75122" into "kill group 75122 if it
 * still contains what the record says it contains", and this decides what to look for.
 *
 * **The script, not the interpreter.** The first version derived it from `argv[1]`, which is
 * `-c` for `/bin/sh -c '…'` and matched by luck, and would have been `node` for everything this
 * repository actually starts — a check that matches every Node process on the machine is not a
 * check. So: the first argument that looks like a script file, and only if there is none, the
 * command itself. `vite-runner.mjs` for a dev server, `browser-loop.mjs` for a probe, `sh` for a
 * shell one-liner.
 */
const expectOf = (command, args) => {
  const script = args.map(String).find((a) => /\.(?:mjs|cjs|js|ts|sh|py)$/.test(a));
  return path.basename(script ?? String(command)) || null;
};

const readEntry = (file) => {
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    rec._file = file;
    rec._mtimeMs = statSync(file).mtimeMs;
    return rec;
  } catch { return null; }
};

/**
 * The lives this entry requires, read from the entry rather than recomputed.
 *
 * `spawnOwned` writes the anchor list it actually handed the guard, so the reaper and the guard
 * cannot disagree about what would kill this job. The `guardPid` is added here rather than
 * stored, because it is only known after the spawn — and it is an anchor: a guard that has gone
 * is no longer supervising anything, whatever else is still alive.
 *
 * The fallback covers an entry written by an older version of this file, where `keepAlive` is the
 * only way to tell whether `ownerPid` was an anchor.
 */
const anchorsOf = (rec) => {
  if (!rec) return [];
  const declared = Array.isArray(rec.anchors) && rec.anchors.length
    ? rec.anchors
    : [...(rec.keepAlive ? [] : [rec.ownerPid]), rec.agentPid];
  return [...declared, rec.guardPid].filter((p) => Number.isFinite(p) && p > 1);
};

/**
 * Every registered process group, with a liveness verdict.
 *
 * The anchors are the guard, the process that spawned it, and the agent session, and the record
 * is alive only while **all** of them are. `keepAlive` entries record no `ownerPid` anchor, so
 * the set is smaller for them and the rule is the same. A guard that has exited after a clean
 * child exit makes its entry stale, which is correct: the group is empty, and reaping it costs
 * one `unlink` and one kill of nothing.
 */
export const listOwned = ({ table = null } = {}) => {
  ensureDirs();
  const now = Date.now();
  const t = table ?? psTable();
  const out = [];
  for (const name of readdirSync(REGISTRY_DIR).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(REGISTRY_DIR, name);
    const rec = readEntry(file);
    const anchors = anchorsOf(rec);
    const stale = stalenessOf(rec, { pids: anchors, mtimeMs: rec?._mtimeMs, staleMs: STALE_MS, now });
    out.push({
      file,
      rec,
      anchors,
      stale,
      /*
       * Why it is stale matters more here than in the semaphore, because the *action* differs.
       * An entry whose agent is dead needs its group killed. An entry from a previous boot needs
       * its file deleted and nothing signalled.
       */
      deadAnchors: anchors.filter((p) => !pidAlive(p)),
      groupAlive: rec?.pgid ? treeMembers(rec.pgid, t).length > 0 : false,
      ageMs: rec?.registeredAt ? now - Date.parse(rec.registeredAt) : null,
    });
  }
  return out;
};

/** One `ps`, parsed once, for every function here that needs to reason about a tree. */
export const psTable = () => {
  const out = [];
  for (const line of ps('pid=,pgid=,ppid=,etime=,command=').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    out.push({ pid: Number(m[1]), pgid: Number(m[2]), ppid: Number(m[3]), etime: m[4], command: m[5] });
  }
  return out;
};

/** The live PIDs currently in a process group, with their command lines. */
export const groupMembers = (pgid, table = null) => {
  if (!Number.isFinite(pgid) || pgid <= 1) return [];
  return (table ?? psTable()).filter((r) => r.pgid === pgid);
};

/**
 * Everything in a process group **and everything descended from it**, however many groups deep.
 *
 * ## The measurement that made this necessary
 *
 * A process group was supposed to be enough. It is not, and `tools/scratch/pgid-of-browser.mjs`
 * is why. Playwright launches the browser with `detached: true`, so the browser gets a **new
 * process group of its own** — measured on this tree:
 *
 *     this node: pid 75124 pgid 75122
 *       pid 75520 pgid 75520 ppid 75124   (browser)      ← its own group, our child
 *       pid 75521 pgid 75520 ppid 75520   --type=gpu-process
 *       pid 75670 pgid 75520 ppid 75520   --type=renderer
 *
 * So `kill(-75122)` reaches the harness and **not one of the four browser processes**. The first
 * version of the load-bearing test passed anyway, which is the dangerous part: it passed because
 * Playwright installs its own SIGTERM handler and closed the browsers politely. Under SIGKILL —
 * the shape an agent being stopped actually has — nothing would have closed them, and the test
 * would have been reporting a group kill that never reached the thing it existed to kill. **This
 * is the third orphan-outliving-its-parent bug in this repository**, and it was found by
 * measuring the pgid rather than assuming it.
 *
 * Hence the closure over `ppid` as well as `pgid`. Reparenting does not defeat it: `pgid` is
 * inherited and does **not** change when a process is reparented to init, so a loop whose shell
 * has died is still findable by group, and its browser is still findable as its child.
 *
 * The one case this cannot reach is a browser whose own launcher has already died — ppid 1, its
 * own group, nothing linking it to anybody. That is why `launchBrowser` records the browser PID
 * in its slot and `reapStale` kills it: two records, two mechanisms, one hole between them
 * closed by the other.
 */
export const treeMembers = (pgid, table = null) => {
  const t = table ?? psTable();
  const seen = new Map();
  const stack = [];
  for (const r of t) if (r.pgid === pgid) { seen.set(r.pid, r); stack.push(r.pid); }
  const byParent = new Map();
  for (const r of t) {
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid).push(r);
  }
  while (stack.length) {
    const pid = stack.pop();
    for (const kid of byParent.get(pid) ?? []) {
      if (seen.has(kid.pid)) continue;
      seen.set(kid.pid, kid);
      stack.push(kid.pid);
    }
  }
  return [...seen.values()];
};

/**
 * Take a whole tree down: SIGTERM to everything, then SIGKILL to whatever is left.
 *
 * Returns what it signalled, because "I killed a group" with no list of members is not an account
 * anybody can check, and this is the function that will one day be blamed for killing the wrong
 * thing.
 *
 * ## Two things it does that `kill(-pgid)` does not
 *
 * **It signals the closure, not the group.** See `treeMembers` for the measurement: Playwright's
 * browser is in its own group, so the group signal misses it.
 *
 * **It verifies before it signals.** A recorded pgid is a number, and after enough PID churn some
 * unrelated process leads that group. `expect` is a substring that must appear in at least one
 * member's command line; when given and matched by nothing, this **refuses and says so**. That is
 * the difference between this and the `pkill` that missed twice on 23 Aug, and between this and
 * the kill that took out a sibling's server on port 5901.
 *
 * The member list is captured **before** the first signal. It has to be: the moment the loop dies
 * its browser is reparented to init and the evidence linking them is gone. Snapshot, then kill.
 */
export const killTree = (pgid, { expect = null, graceMs = 2500, signal = 'SIGTERM' } = {}) => {
  const members = treeMembers(pgid);
  if (!members.length) return { pgid, killed: [], why: 'group is already empty' };
  if (expect && !members.some((m) => m.command.includes(expect))) {
    return {
      pgid, killed: [], refused: true, members,
      why: `group ${pgid} exists but nothing in it looks like ${JSON.stringify(expect)} — `
        + 'the PID has been recycled and this is somebody else\'s group',
    };
  }
  const pids = members.map((m) => m.pid).filter((p) => p !== process.pid);
  // The group signal first, because it is atomic with respect to anything forking right now, then
  // the individual PIDs for the members that are in a different group.
  try { process.kill(-pgid, signal); } catch { /* raced us */ }
  for (const pid of pids) { try { process.kill(pid, signal); } catch { /* already gone */ } }

  const deadline = Date.now() + graceMs;
  let left = pids.filter((p) => pidAlive(p));
  while (Date.now() < deadline && left.length) {
    try { execFileSync('sleep', ['0.15']); } catch { break; }
    left = pids.filter((p) => pidAlive(p));
  }
  if (left.length) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
    for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  return { pgid, killed: members, hardKilled: left, why: `signalled ${members.length} process(es) around group ${pgid}` };
};

/** @deprecated The name understated what has to happen; `killTree` is the same call. */
export const killGroup = killTree;

/* ─────────────────────────────── spawnOwned ─────────────────────────────── */

/**
 * `spawn()`, but the thing you start is owned, grouped, recorded and reaped.
 *
 * Returns a handle:
 *
 *   - `pgid` / `guardPid` — the group to kill; they are the same number by construction
 *   - `done` — a promise for the exit code
 *   - `kill()` — take the whole group down now, idempotent
 *   - `entry` — the registry file, for anything that wants to read it back
 *
 * ## The four things it does that plain `spawn` does not
 *
 * 1. **A group.** `detached: true` on the guard makes it a session and group leader; the guard
 *    runs the real command inside that group. One signal, whole tree, however deep.
 * 2. **A death watch that does not live in the child.** The guard polls the anchors. The child
 *    needs no cooperation, which is the entire reason this is not just "add a parent watch to
 *    the script" — there are three hundred scripts.
 * 3. **A record with an owner in it.** Agent id, agent PID, worktree, branch, port, label, argv,
 *    start time, boot generation. This is what lets `browsers.mjs machine` say *whose* a process
 *    is, and what lets a sweep refuse a sibling's.
 * 4. **A cleanup registered in this process.** If we exit normally we kill the group on the way
 *    out, so the guard's watch is a backstop rather than the primary path. Three mechanisms, and
 *    the fast one is the one that runs.
 *
 * ## `keepAlive`
 *
 * Default `false`: the group dies when we do, and it dies when the agent does. `keepAlive: true`
 * is for a deliberately long-lived server the caller intends to outlive the current process — it
 * drops the exit-time kill *and* drops the caller from the anchor list, but **keeps everything
 * else**, so the guard still kills the group when the agent dies and the registry still records
 * who owns it. It is a way to outlive a script. It is not a way to outlive an agent, and there is
 * deliberately no flag for that.
 */
export function spawnOwned(command, args = [], {
  label = path.basename(String(args[0] ?? command)),
  root = REPO_ROOT,
  cwd = null,
  port = null,
  env = {},
  stdio = 'inherit',
  keepAlive = false,
  meta = {},
} = {}) {
  ensureDirs();
  reapOwned({ quiet: true });

  const id = identity({ root });
  /*
   * The anchors: the lives this job requires. The guard kills the group when the **first** one
   * dies, not the last.
   *
   *   - `process.pid` unless `keepAlive` — a job whose caller has gone is unowned.
   *   - `id.agentPid` always, when we know it — the 23 Aug orphan was a loop whose spawning
   *     shell had exited normally hours before and whose agent was then stopped.
   *
   * **An empty anchor list is refused rather than tolerated.** A guard with nothing to watch is
   * worse than no guard, because it looks like one. It can only happen for `keepAlive: true`
   * outside an agent — a human at a terminal — and in that case the honest answer is that this
   * file cannot supervise it and should say so rather than pretend.
   */
  const anchors = [...(keepAlive ? [] : [process.pid]), ...(id.agentPid ? [id.agentPid] : [])];
  if (!anchors.length) {
    throw new Error(
      'spawnOwned: keepAlive:true outside an agent session leaves nothing to anchor the job to.\n'
      + '  There is no agent PID (CLAUDE_PID is unset) and keepAlive drops the caller as an\n'
      + '  anchor, so the guard would watch nothing and the group would live forever.\n'
      + '  Either drop keepAlive, or set TC_AGENT_PID to the process whose death should end it.'
    );
  }

  const token = `${process.pid}-${Date.now()}-${rand()}`;
  const entry = path.join(REGISTRY_DIR, `${token}.json`);
  const record = {
    token,
    label,
    command,
    argv: [command, ...args].map(String),
    ownerPid: process.pid,
    ownerArgv: process.argv.slice(1, 4),
    anchors,
    agent: id.agent,
    agentPid: id.agentPid,
    worktree: id.worktree,
    branch: id.branch,
    human: id.human,
    port: port == null ? null : Number(port),
    cwd: cwd ? path.resolve(cwd) : path.resolve(root),
    bootId: bootId(),
    registeredAt: new Date().toISOString(),
    keepAlive,
    // What a kill must find in the group before it signals it. See `expectOf`.
    expect: expectOf(command, args),
    ...meta,
  };
  if (!linkAtomic(entry, JSON.stringify(record, null, 2))) {
    throw new Error(`spawnOwned: registry collision on ${entry} — this should be impossible`);
  }

  const child = spawn(
    process.execPath,
    [GUARD, `--entry=${entry}`, `--label=${label}`, ...(cwd ? [`--cwd=${path.resolve(cwd)}`] : []),
      ...anchors.map((p) => `--anchor=${p}`), '--', command, ...args.map(String)],
    {
      cwd: cwd ? path.resolve(cwd) : root,
      // `detached` is what makes the guard a group leader. Without it the guard shares our group
      // and `kill(-guardPid)` would kill us too — and the guard refuses to run in that case.
      detached: true,
      stdio: stdio === 'inherit' ? ['ignore', 'inherit', 'inherit'] : stdio,
      env: {
        ...process.env,
        ...env,
        TC_OWNED_ENTRY: entry,
        TC_OWNER_AGENT: id.agent ?? '',
        TC_OWNER_AGENT_PID: id.agentPid ? String(id.agentPid) : '',
      },
    }
  );

  /*
   * `unref` so this process can exit on its own schedule; the *kill* on the way out is what
   * makes that safe. Without the cleanup below, `unref` here would be the 23 Aug bug written
   * deliberately.
   */
  child.unref();

  // The guard's PID *is* the group id, because it is the group leader. Record it so a reaper in
  // another process has something to kill.
  try {
    const rec = JSON.parse(readFileSync(entry, 'utf8'));
    writeFileSync(entry, JSON.stringify({ ...rec, guardPid: child.pid, pgid: child.pid }, null, 2));
  } catch { /* the entry was reaped under us; the guard will notice and stop */ }

  let killed = false;
  const kill = ({ graceMs = 2500 } = {}) => {
    if (killed) return null;
    killed = true;
    cleanups.delete(exitKill);
    const res = killTree(child.pid, { graceMs });
    try { unlinkSync(entry); } catch { /* already reaped */ }
    return res;
  };
  const exitKill = () => { if (!keepAlive) kill({ graceMs: 600 }); };
  registerCleanup(exitKill);

  const done = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      cleanups.delete(exitKill);
      /*
       * **Do not drop the record just because the guard has gone.**
       *
       * The first version of this unlinked unconditionally, on the reasoning that the guard sweeps
       * its own tree before exiting so by here the tree is empty. That is true when the guard exits
       * *normally* and false in the one case this whole file is a defence against: a guard that was
       * SIGKILLed. `tools/qa-supervisor.mjs` case 8 caught it — the guard died, its children kept
       * running, and this handler deleted the only record naming their process group, turning the
       * supervisor into the single point of failure it was designed not to be.
       *
       * So: check. If the tree is still up, kill it here — we are the owner, we are alive, and it
       * is ours. Only then drop the record. If *we* cannot act either, the record stays on disk and
       * `reapOwned()` in any other process finishes it, which is the third mechanism doing its job.
       */
      const left = treeMembers(child.pid);
      if (left.length && !killed) {
        process.stderr.write(
          `process registry: guard ${child.pid} (${label}) exited with ${left.length} process(es) `
          + 'still in its tree — killing them here rather than leaving the record to a reaper\n'
        );
        killTree(child.pid, { graceMs: 1500 });
      }
      if (!treeMembers(child.pid).length) { try { unlinkSync(entry); } catch { /* already gone */ } }
      resolve(signal ? 143 : (code ?? 0));
    });
    child.once('error', () => {
      if (!treeMembers(child.pid).length) { try { unlinkSync(entry); } catch { /* gone */ } }
      resolve(127);
    });
  });

  return {
    guardPid: child.pid,
    pgid: child.pid,
    entry,
    record,
    child,
    done,
    kill,
    get killed() { return killed; },
  };
}

/* ──────────────────────────────── reaping ──────────────────────────────── */

/**
 * Kill the groups whose owners are gone, and drop the records that are no longer evidence.
 *
 * Called from `acquireSlot`, so it runs before every budgeted browser launch on this machine.
 * That is the design decision that keeps this from needing a daemon: the sweep is paid for by
 * whoever next wants something, which is exactly the moment somebody cares.
 *
 * ## The two verdicts, because the action differs
 *
 *   - **`reboot`** — drop the file and **signal nothing**. The PIDs in it belong to strangers
 *     now. This is the case a machine that slept or crashed comes back in, and getting it wrong
 *     means an agent killing an unrelated process group on every boot.
 *   - **anything else** — the owner is gone, so kill the group and drop the file. The group is
 *     verified against the recorded command before it is signalled, so a recycled pgid is
 *     refused rather than obeyed.
 *
 * A record with `keepAlive` is not exempt. `keepAlive` means "outlive the script that started
 * me"; it has never meant "outlive the agent", and the anchor list is what enforces the
 * difference.
 */
export const reapOwned = ({ quiet = false, dryRun = false } = {}) => {
  ensureDirs();
  const reaped = [];
  for (const e of listOwned()) {
    if (!e.stale) continue;
    // Re-read under the same rule before acting. A guard heartbeats every two seconds and
    // without this a reaper that decided `silent` on a stale read could kill a group that came
    // back to life a millisecond later.
    const fresh = readEntry(e.file);
    const why = stalenessOf(fresh, { pids: anchorsOf(fresh), mtimeMs: fresh?._mtimeMs, staleMs: STALE_MS });
    if (!why) continue;

    let killResult = null;
    if (killable(why) && fresh?.pgid) {
      /*
       * `expect` is the command the entry recorded. Verifying it is what makes this safe to run
       * from any process at any time: if the pgid now names an unrelated group, the kill is
       * refused and reported instead of performed.
       */
      const expect = fresh.expect
        ?? expectOf(fresh.command ?? fresh.argv?.[0] ?? '', fresh.argv?.slice(1) ?? []);
      killResult = dryRun
        ? { pgid: fresh.pgid, killed: treeMembers(fresh.pgid), why: 'dry run' }
        : killTree(fresh.pgid, { expect: expect || null });
    }
    if (!dryRun) { try { unlinkSync(e.file); } catch { continue; } }
    reaped.push({ file: e.file, why, rec: fresh ?? e.rec, kill: killResult });
    if (!quiet) {
      const n = killResult?.killed?.length ?? 0;
      process.stderr.write(
        `process registry: reaped ${fresh?.label ?? '?'} (${why}) — owner `
        + `${shortOwner(fresh)}${fresh?.agentPid ? ` pid ${fresh.agentPid}` : ''}`
        + `${killResult?.refused ? `; kill REFUSED: ${killResult.why}` : `; killed ${n} process(es) in group ${fresh?.pgid}`}\n`
      );
    }
  }
  return reaped;
};

/* ─────────────────────────── the process census ─────────────────────────── */

/**
 * What is actually running, in the unit the owner counts in.
 *
 * A `chrome-headless-shell` line **without** `--type=` is a browser; one with it is a child of a
 * browser. That distinction is why `ps | grep -c` is misleading and why this function exists —
 * and it is why the numbers here are reported separately rather than summed into one figure
 * whose meaning has to be explained every time.
 *
 * Port 5173 is excluded from the Vite count. That is the owner's playtest server; it is not
 * agent work and counting it against the agent budget would make his own game the reason his
 * agents queue.
 */
export const procCensus = ({ table = null } = {}) => {
  const t = table ?? psTable();
  const browsers = []; const browserKids = []; const vites = []; const ownerVites = []; const guards = [];
  for (const rec of t) {
    /*
     * **Guards first, and this ordering is a bug fix.** A guard's own command line contains the
     * command it is supervising — `node spawn-guard.mjs --entry=… -- node vite-runner.mjs
     * --port=5947` — so every Vite pattern below matches the guard as well as the server. The
     * first version of this counted 2 Vite servers where there was 1, on the very first run.
     * Anything that classifies processes by command line has to take the guard out of the
     * running before it looks for what the guard is holding.
     */
    if (/spawn-guard\.mjs/.test(rec.command)) {
      guards.push({ ...rec, type: 'guard' });
      continue;
    }
    if (/chrome-headless-shell/.test(rec.command)) {
      const ty = rec.command.match(/--type=(\S+)/);
      if (ty) browserKids.push({ ...rec, type: ty[1] });
      else browsers.push({ ...rec, type: 'browser' });
    } else if (/vite-runner\.mjs|node_modules\/\.bin\/vite|bin\/vite\.js|npm exec vite/.test(rec.command)) {
      const p = rec.command.match(/--port[= ](\d+)/);
      const port = p ? Number(p[1]) : null;
      (port === 5173 ? ownerVites : vites).push({ ...rec, port });
    }
  }

  // Everything inside a registered group, minus what we already counted, so the total is a
  // count of distinct PIDs rather than a sum of overlapping sets.
  const counted = new Set([...browsers, ...browserKids, ...vites, ...guards].map((r) => r.pid));
  const owned = [];
  const groups = [];
  for (const e of listOwned({ table: t })) {
    if (e.stale || !e.rec?.pgid) continue;
    const members = treeMembers(e.rec.pgid, t);
    groups.push({ pgid: e.rec.pgid, rec: e.rec, members });
    for (const m of members) if (!counted.has(m.pid)) { counted.add(m.pid); owned.push({ ...m, entry: e.rec }); }
  }

  return {
    browsers, browserKids, vites, ownerVites, guards, owned, groups,
    /*
     * The headline, and it counts the supervisor's own processes.
     *
     * Chromium and its children, plus agent Vite servers, plus every guard, plus anything else in
     * a registered group — every OS process on this machine that exists because an agent asked for
     * it. The guards are in the total on purpose: this file costs one process per supervised job,
     * and a budget that exempted its own overhead from the number it reports to the owner would be
     * lying in exactly the direction that flatters it.
     */
    total: browsers.length + browserKids.length + vites.length + guards.length + owned.length,
    chromium: browsers.length + browserKids.length,
  };
};

/* ─────────────────────────── the process ceiling ─────────────────────────── */

/**
 * One unit of gate work, in OS processes. **Measured**, `tools/scratch/procs-per-browser.mjs`:
 *
 *     browser              1   chrome-headless-shell, no --type=
 *     gpu-process          1
 *     utility              1
 *     renderer             1   one per open page
 *     vite-runner          1
 *     spawn-guard          1   this file's own overhead, one per supervised job
 *                          ─
 *                          6
 *
 * `browsers.mjs` has said "six or seven" in a warning since 22 Aug, and six turns out to be right
 * — but for different reasons than the prose implied. That figure is full Chromium, which carries
 * separate network and audio services; chrome-headless-shell has neither, and this repository only
 * ever launches chrome-headless-shell. Four of the six are Chromium, one is Vite, and one is the
 * supervisor. The last row is counted rather than exempted: a budget that left its own overhead
 * out of the number it reports would be lying in the direction that flatters it.
 */
export const PROCS_PER_UNIT = 6;
/**
 * Headroom, in renderers. A tool that opens a second and third page is doing something
 * legitimate — `qa-net.mjs` runs a host and a guest — and refusing it for being multi-page would
 * be the ceiling punishing the wrong behaviour. Three is judgement, not measurement, and it is
 * the one number here that is neither.
 */
export const PROC_SLACK_PER_UNIT = 3;

/**
 * The ceiling, in processes, for a browser cap.
 *
 * Derived from the cap rather than set independently, so that
 * `node tools/browsers.mjs cap <n>` moves both and the two can never drift into disagreeing
 * about how much machine there is. `TC_MAX_PROCS` overrides, for the case where the derivation
 * is wrong and somebody has measured why.
 */
export const procCeiling = (browserCap) => {
  const override = Number(process.env.TC_MAX_PROCS);
  if (Number.isFinite(override) && override > 0) return { ceiling: Math.floor(override), from: 'TC_MAX_PROCS' };
  return {
    ceiling: Math.max(PROCS_PER_UNIT, browserCap * (PROCS_PER_UNIT + PROC_SLACK_PER_UNIT)),
    from: `${browserCap} × (${PROCS_PER_UNIT} measured + ${PROC_SLACK_PER_UNIT} headroom)`,
  };
};

/**
 * Is there room in the process budget for one more unit of work?
 *
 * Returns the same shape as `admit()` in `work-budget.mjs` so the caller can treat all refusals
 * alike: transient, re-tested every poll, queued rather than failed.
 *
 * **Why this can refuse when the browser count says there is room.** Three cases, all real:
 * a browser holding no slot; one slot holding twenty pages; a spawned tree that is not a browser
 * at all. Each is invisible to a count of slots and visible here. That is the entire argument
 * for having two units.
 */
export const admitProcesses = ({ browserCap, census = null } = {}) => {
  if (!procBudgetEnabled()) return { ok: true, reason: 'process ceiling disabled (TC_PROC_BUDGET=off)' };
  const c = census ?? procCensus();
  const { ceiling, from } = procCeiling(browserCap);
  if (c.total + PROCS_PER_UNIT <= ceiling) {
    return { ok: true, census: c, ceiling, ceilingFrom: from, reason: `${c.total}/${ceiling} processes` };
  }
  return {
    ok: false, why: 'procs', census: c, ceiling, ceilingFrom: from,
    reason: `${c.total} OS processes already (${c.browsers.length} browser(s) = `
      + `${c.chromium} chromium, ${c.vites.length} vite, ${c.owned.length} other owned); `
      + `ceiling ${ceiling} (${from}), and one more unit of work is ${PROCS_PER_UNIT} more`,
  };
};

/* ────────────────────────── ownership attribution ────────────────────────── */

/**
 * The current working directory of every live process, in one `lsof`.
 *
 * This is the call the agent that killed a sibling's server on port 5901 said afterwards would
 * have told it: `lsof -a -p <pid> -d cwd`. Done for the whole machine at once it costs about
 * 0.2 s, and `tools/reclaim.mjs` already relies on it for exactly this reason.
 */
export const cwdByPid = () => {
  const out = new Map();
  let pid = null;
  try {
    const raw = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn'],
      { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of raw.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid) out.set(pid, line.slice(1));
    }
  } catch { /* lsof unavailable; attribution falls back to the parent walk */ }
  return out;
};

/**
 * Is this command line an **agent process** — the `claude` CLI itself?
 *
 * The test is on **argv[0]**, and that is a bug fix rather than a nicety. `\bclaude\b` matches
 * inside `/Users/…/.claude/shell-snapshots/…`, because a dot and a slash are both word boundaries,
 * so every shell that sources a snapshot from that directory looked like an agent. Two things read
 * this — `attribute()`'s parent walk and `browsers.mjs sweep`'s "is a live agent standing in this
 * worktree" — and both were wrong in the same way, in opposite directions: the walk attributed a
 * browser to a shell, and the sweep would have decided that a shell standing in *my* worktree was
 * a sibling occupying it, so my own servers were somebody else's.
 */
export const isAgentCommand = (command) => {
  const first = String(command ?? '').trim().split(/\s+/)[0] ?? '';
  return path.basename(first.replace(/:$/, '')) === 'claude';
};

/** ppid for every process, for walking a parent chain the way it had to be walked by hand. */
const parentMap = () => {
  const parents = new Map(); const cmds = new Map();
  for (const line of ps('pid=,ppid=,command=').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    parents.set(Number(m[1]), Number(m[2]));
    cmds.set(Number(m[1]), m[3]);
  }
  return { parents, cmds };
};

/**
 * Whose process is this?
 *
 * Four sources of evidence, best first, and the answer says which one it used — because
 * "recorded" and "inferred" justify different actions. A sweep may refuse to kill either, but
 * only *recorded* ownership is good enough to kill *on*.
 *
 *   1. **A registry entry** whose process group contains this PID. Recorded on the way in.
 *      Names the agent, the worktree, the branch, the port and the label.
 *   2. **A live budget slot** whose `pid` or `vitePid` is this PID, or whose port it holds.
 *      Recorded, and now carries the agent id too.
 *   3. **The parent chain**, walked up to a `claude` process. This is what had to be done by
 *      hand on 23 Aug to find the orphaned loop, and it is the only source that works for a
 *      process started before any of this existed.
 *   4. **`lsof -d cwd`** — the worktree the process is standing in. Weakest, because a probe's
 *      cwd is the tree it is measuring and not necessarily the tree that started it, but it is
 *      never nothing, and it was the missing sentence in the 5901 incident.
 */
export const attribute = (pid, ctx = {}) => {
  const owned = ctx.owned ?? listOwned().filter((e) => !e.stale);
  const slots = ctx.slots ?? [];
  const { parents, cmds } = ctx.pmap ?? parentMap();
  const cwds = ctx.cwds ?? cwdByPid();

  // 1. A registered group.
  for (const e of owned) {
    if (!e.rec?.pgid) continue;
    if ((ctx.groupOf?.get(pid) ?? null) === e.rec.pgid || treeMembers(e.rec.pgid, ctx.table).some((m) => m.pid === pid)) {
      return { how: 'registry', recorded: true, agent: e.rec.agent, agentPid: e.rec.agentPid,
        worktree: e.rec.worktree, branch: e.rec.branch, label: e.rec.label, port: e.rec.port,
        pgid: e.rec.pgid, detail: `registered group ${e.rec.pgid} (${e.rec.label})` };
    }
  }

  /*
   * 2. A live budget slot.
   *
   * **`browserPid` is in this list and leaving it out was a real wrong answer.** The slot records
   * the harness, the Vite server and the browser; the first version tested only the first two, so a
   * browser holding a slot with a recorded owner fell through to the parent walk and came back
   * attributed to a shell. `browsers.mjs procs` printed my own browser as a sibling's.
   */
  for (const s of slots) {
    const r = s.rec ?? {};
    if (r.pid === pid || r.vitePid === pid || r.browserPid === pid) {
      const role = r.browserPid === pid ? 'browser' : r.vitePid === pid ? 'vite' : 'harness';
      return { how: 'slot', recorded: true, agent: r.agent ?? null, agentPid: r.agentPid ?? null,
        worktree: r.root, branch: r.branch ?? null, label: r.label, port: r.port,
        detail: `browser-budget slot ${s.slot} (${r.label}), as its ${role}` };
    }
  }

  /*
   * 3. The parent chain, up to a `claude`. Bounded at 24 hops: a cycle in ppid should be impossible
   *    and a loop here would hang a sweep, which is worse than an unknown owner.
   *
   * **The test is on argv[0], not on the whole command line, and that is a bug fix.** `\bclaude\b`
   * matches inside `/Users/…/.claude/shell-snapshots/…`, because a dot and a slash are both word
   * boundaries — so every shell that sources a snapshot from that directory looked like an agent.
   * `browsers.mjs procs` attributed a browser to `/bin/zsh -c source …/.claude/shell-snaps` and,
   * since that shell's PID is not this agent's, called my own browser a sibling's. An attribution
   * that can name the wrong owner is worse than one that says "unknown", because a sweep acts on it.
   */
  let cur = pid;
  for (let i = 0; i < 24 && cur && cur > 1; i++) {
    const cmd = cmds.get(cur) ?? '';
    if (isAgentCommand(cmd)) {
      const m = cmd.match(/--resume\s+([0-9a-f-]{8,})/);
      const dir = cwds.get(pid) ?? null;
      /*
       * The worktree is in the detail because it is the part that decides. One `claude` runs
       * several agents, so "descends from claude 98934e6c" is true of a sibling's work as well as
       * of ours, and the directory is what tells them apart. A refusal that does not name the
       * deciding fact cannot be checked by the person reading it.
       */
      return { how: 'parent-chain', recorded: false, agent: m?.[1] ?? null, agentPid: cur,
        worktree: dir, label: null, port: null,
        detail: `descends from ${cmd.slice(0, 48)} (pid ${cur}), ${i} hop(s) up`
          + (dir ? `, standing in ${path.basename(dir)}` : ', with no readable cwd') };
    }
    cur = parents.get(cur) ?? 0;
  }

  // 4. Where it is standing.
  const dir = cwds.get(pid);
  if (dir) {
    return { how: 'cwd', recorded: false, agent: null, agentPid: null, worktree: dir,
      label: null, port: null, detail: `cwd ${dir} — lsof -a -p ${pid} -d cwd` };
  }

  return { how: 'unknown', recorded: false, agent: null, agentPid: null, worktree: null,
    label: null, port: null, detail: 'no registry entry, no slot, no claude ancestor, no cwd' };
};

/**
 * Is this process somebody else's?
 *
 * `null` means "cannot tell", which a sweep must treat as *not* a licence. The 5901 incident was
 * an agent treating "I cannot tell" as "mine".
 *
 * ## Why the worktree can outvote the agent id, measured 1 Sep 2026
 *
 * The first version short-circuited on the agent id: same session, same agent, not a sibling. That
 * is **false on this machine**, and it was found by pointing `browsers.mjs sweep` at a real
 * sibling's dev server and watching it come back "mine".
 *
 * `node tools/qa-net.mjs` running in worktree `agent-aaa44128937a2cb8f` had ppid → `/bin/zsh -c` →
 * **ppid 23238, which is *this* agent's `claude`**. Several agents run as subagents of one `claude`
 * CLI process, so they share `CLAUDE_PID` *and* `CLAUDE_CODE_SESSION_ID`, and neither identifies an
 * agent. An identity that cannot tell two agents apart is not an identity, and treating it as one
 * puts a sweep straight back into the 5901 mistake with a better audit trail.
 *
 * So: **different agent id, or a different worktree, is enough to be a sibling.** Agreement is only
 * "mine" when nothing disagrees. The cost is that one agent deliberately working across two
 * worktrees sees its own work in the other tree as somebody else's and has to pass
 * `--include-others` to sweep it. That is the right direction to be wrong in.
 */
export const isSibling = (att, me = identity()) => {
  if (!att) return null;
  const byAgent = (att.agent && me.agent) ? att.agent !== me.agent
    : (att.agentPid && me.agentPid) ? att.agentPid !== me.agentPid
      : null;
  const byTree = (att.worktree && me.worktree)
    ? path.resolve(att.worktree) !== path.resolve(me.worktree)
    : null;
  if (byAgent === true || byTree === true) return true;
  if (byAgent === false || byTree === false) return false;
  return null;
};

/** Every live process group index, for a caller that wants to attribute many PIDs cheaply. */
export const groupIndex = () => {
  const out = new Map();
  for (const line of ps('pid=,pgid=').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)/);
    if (m) out.set(Number(m[1]), Number(m[2]));
  }
  return out;
};

/* ─────────────────────────── process-wide cleanup ─────────────────────────── */

/*
 * One set of hooks, installed once — the same shape and the same reason as in
 * `browser-budget.mjs`: per-handle `process.on('exit')` listeners make node warn at eleven and
 * leak one dead listener per iteration in any harness that loops.
 */
const cleanups = new Set();
let hooksInstalled = false;
const runCleanups = () => { for (const fn of cleanups) { try { fn(); } catch { /* best effort */ } } };
function registerCleanup(fn) {
  cleanups.add(fn);
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', runCleanups);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { runCleanups(); process.exit(sig === 'SIGINT' ? 130 : 143); });
  }
  process.on('uncaughtException', (err) => { runCleanups(); console.error(err); process.exit(1); });
}

/** Drop scratch files a crash between write and link left behind. */
export const sweepTmp = () => {
  try {
    for (const name of readdirSync(TMP_DIR)) {
      const f = path.join(TMP_DIR, name);
      if (Date.now() - statSync(f).mtimeMs > 5 * 60_000) rmSync(f, { force: true });
    }
  } catch { /* nothing to sweep */ }
};

export const paths = { BUDGET_DIR, REGISTRY_DIR, TMP_DIR, REPO_ROOT, TOOLS_DIR, GUARD };
