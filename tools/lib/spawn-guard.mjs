#!/usr/bin/env node
/**
 * A nanny that outlives nothing.
 *
 * ## The bug this exists for, measured on 23 Aug 2026
 *
 * An agent ran `tools/scratch/net-flake-load.mjs --runs=6` to reproduce a gate flake under
 * load. The agent was stopped. The loop had been **reparented to init** and went on relaunching
 * browsers; it survived two `pkill` sweeps, and it was found only by walking parents up from a
 * live browser. **This is the second time in this repository that a child has outlived the
 * thing that started it** — the first was the `npx vite` wrapper that `tools/lib/vite-runner.mjs`
 * exists to fix — so it is a pattern and not an incident.
 *
 * `tools/lib/vite-runner.mjs` already solves it *for Vite*: the runner polls its parent and
 * exits when the parent is gone. That works because the runner is our code. It cannot be
 * generalised, because the thing we want to supervise is an arbitrary script — a scratch loop,
 * a film, a probe — and we are not going to edit three hundred entry points to add a parent
 * watch to each of them.
 *
 * So the watch moves out of the child and into a wrapper. This file is that wrapper. It is
 * spawned in place of the real command, with the real command as its arguments, and it does
 * three things and nothing else:
 *
 *   1. **Becomes a process group leader**, and runs the real command as its own child, in that
 *      group. One `kill(-guardPid)` therefore takes the guard, the command, and everything the
 *      command started, however deep. `detached: true` *without* a group kill is what happened
 *      on 23 Aug: the child was detached, so it survived, and nothing knew its group.
 *   2. **Polls the anchors.** Every `TC_GUARD_WATCH_MS` (default 2 s) it asks `kill(pid, 0)` of
 *      each anchor PID it was given. **An anchor is a life the job requires: the first one that
 *      dies takes the group down.** By default there are two — the process that called
 *      `spawnOwned`, and the agent session it belongs to — and either death is enough, because
 *      each corresponds to a real orphan seen on this machine. The spawning process dying is the
 *      `npx vite` shape; the agent dying is the 23 Aug `net-flake-load` shape, where the
 *      spawning shell was long gone and the loop was reparented to init.
 *   3. **Heartbeats the registry entry**, so that a reaper in any other process can tell a guard
 *      that is working from one that is wedged, using the same evidence the slot semaphore uses.
 *
 * ## What it deliberately does not do
 *
 * It is not a supervisor with a policy. It does not restart, it does not rate-limit, it does not
 * decide anything. It relays the child's exit code and dies. A guard with judgement is a guard
 * that can be wrong in a way that is hard to see, and this one has to be simple enough that its
 * failure mode is obvious: if it dies, the registry entry it left behind still names the process
 * group, and `reapOwned()` in any other process will finish the job. **It is one of two
 * independent mechanisms, not the mechanism.**
 *
 * ## The one thing it cannot do
 *
 * If the guard is SIGKILLed *and* nothing ever runs a reaper again, the child survives. That is
 * why the registry is on disk and why `reapOwned()` is called from `acquireSlot` — every browser
 * launch on this machine, from any agent, sweeps the registry first. The window is bounded by
 * "the next time anybody starts a browser", not by anybody remembering.
 *
 * ## Usage
 *
 * Nobody should run this by hand. `spawnOwned()` in `tools/lib/process-registry.mjs` spawns it:
 *
 *     node tools/lib/spawn-guard.mjs --entry=<registry file> --anchor=<pid> --anchor=<pid> \
 *          -- <command> [args...]
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { pidAlive } from './liveness.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1) {
  process.stderr.write('spawn-guard: expected `-- <command> [args...]`\n');
  process.exit(2);
}
const opts = argv.slice(0, sep);
const [command, ...args] = argv.slice(sep + 1);
if (!command) {
  process.stderr.write('spawn-guard: no command after `--`\n');
  process.exit(2);
}

const valueOf = (name) => {
  const hit = opts.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const ANCHORS = opts.filter((a) => a.startsWith('--anchor=')).map((a) => Number(a.slice(9)))
  .filter((p) => Number.isFinite(p) && p > 1);
const ENTRY = valueOf('entry');
const LABEL = valueOf('label') ?? command;
const WATCH_MS = Number(process.env.TC_GUARD_WATCH_MS || 2000);
/** How long the group gets between SIGTERM and SIGKILL. Vite needs about 200 ms to let go. */
const GRACE_MS = Number(process.env.TC_GUARD_GRACE_MS || 3000);

/*
 * The guard is its own process group leader.
 *
 * `spawnOwned` spawned us with `detached: true`, which on POSIX means `setsid()`: we are a new
 * session and a new group, our PID is the group id, and we are not in the caller's group. The
 * child below inherits *our* group, which is the whole point — it is what makes one signal reach
 * the tree. Verified rather than assumed, because if it is not true the group kill silently
 * becomes a single-process kill and we are back to the 23 Aug bug with extra machinery.
 *
 * **`ps` rather than `process.getpgrp()`.** That function does not exist in the Node on this
 * machine, and the first version of this check fell back to `process.pid` when it threw — which
 * made the comparison `process.pid !== process.pid`, an assertion that could never fail. A
 * self-consistent instrument cannot detect anything; the group id has to come from outside the
 * process being asked about.
 */
const OWN_PGID = (() => {
  try {
    const n = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)],
      { encoding: 'utf8', timeout: 5000 }).trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
})();
if (OWN_PGID === null) {
  process.stderr.write('spawn-guard: could not read own process group from ps; refusing to run a group kill blind.\n');
  process.exit(2);
}
if (OWN_PGID !== process.pid) {
  process.stderr.write(
    `spawn-guard: not a group leader (pid ${process.pid}, pgid ${OWN_PGID}). A group kill would\n`
    + 'spawn-guard: reach processes that are not ours, so refusing to run. This means the caller\n'
    + 'spawn-guard: did not pass detached:true — see spawnOwned() in tools/lib/process-registry.mjs.\n'
  );
  process.exit(2);
}

/*
 * The child, in our group, stdio passed straight through.
 *
 * `detached: false` here is deliberate and is the opposite of what the caller did to us: we
 * *want* the child in our group so it dies with us. The caller wanted us out of *its* group so
 * that a Ctrl-C in the caller's terminal does not race us to the kill.
 */
const child = spawn(command, args, {
  cwd: valueOf('cwd') || process.cwd(),
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: false,
  env: {
    ...process.env,
    TC_GUARD_PID: String(process.pid),
    TC_OWNED_PGID: String(process.pid),
  },
});

/** Record the real child's PID next to the group, so a census can name the leaf as well. */
const stampEntry = (patch) => {
  if (!ENTRY) return;
  try {
    const rec = JSON.parse(readFileSync(ENTRY, 'utf8'));
    writeFileSync(ENTRY, JSON.stringify({ ...rec, ...patch }, null, 2));
  } catch { /* the entry may already have been reaped; that is not our problem to fix */ }
};
stampEntry({ childPid: child.pid, guardPid: process.pid, startedAt: new Date().toISOString() });

let dying = false;

/**
 * Everything in our group **and everything descended from it**, snapshotted now.
 *
 * The group alone is not enough, and the reason is measured: Playwright launches the browser with
 * `detached: true`, so the browser sits in a **new process group of its own** while remaining our
 * grandchild. `tools/scratch/pgid-of-browser.mjs` on this tree —
 *
 *     this node: pid 75124 pgid 75122
 *       pid 75520 pgid 75520 ppid 75124   (browser)   ← its own group
 *
 * so `kill(-75122)` reaches the harness and none of the four browser processes. The first version
 * of the load-bearing test passed regardless, because Playwright's own SIGTERM handler closed the
 * browsers politely — which means the test was passing for a reason that would not exist under
 * SIGKILL, the shape a stopped agent actually has.
 *
 * The snapshot must be taken **before** the first signal: the instant the child dies its browser
 * is reparented to init and the ppid that linked them is gone.
 */
const treePids = () => {
  let rows = [];
  try {
    const raw = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,ppid=,command='],
      { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 10_000 });
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), ppid: Number(m[3]), command: m[4] });
    }
  } catch { rows = []; }
  const byParent = new Map();
  for (const r of rows) {
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid).push(r);
  }
  const seen = new Set();
  const stack = rows.filter((r) => r.pgid === process.pid).map((r) => r.pid);
  for (const p of stack) seen.add(p);
  while (stack.length) {
    const pid = stack.pop();
    for (const kid of byParent.get(pid) ?? []) {
      if (seen.has(kid.pid)) continue;
      seen.add(kid.pid);
      stack.push(kid.pid);
    }
  }
  seen.delete(process.pid);
  return [...seen];
};

/**
 * Kill the whole tree, us included, and mean it.
 *
 * SIGTERM to the group *and* to every descendant outside it, then SIGKILL to whatever is left
 * after the grace period. A browser mid-render ignores SIGTERM for longer than you would expect,
 * and "we asked politely and it stayed" is the failure this whole file exists to prevent — so the
 * second signal is not optional and not conditional.
 *
 * The guard excludes *itself* from the signals for as long as it takes to finish and report;
 * `process.exit` at the end is what finishes it.
 */
const killGroup = (why, code) => {
  if (dying) return;
  dying = true;
  const pids = treePids();
  if (!pids.length) {
    // The ordinary end of a well-behaved job: the child exited and left nothing. Say nothing.
    process.exit(code);
  }
  process.stderr.write(
    `spawn-guard: ${why} — killing ${pids.length} process(es) around group ${process.pid} (${LABEL})\n`
  );
  /*
   * The group signal first, and it is not redundant with the per-PID loop below: it is atomic with
   * respect to anything that forks between the snapshot and now, which a list of PIDs read a
   * moment ago cannot be. `pids` then covers the descendants that are in *other* groups, which is
   * where Playwright puts every browser.
   *
   * SIGKILL is per-PID only. `kill(-ownGroup, SIGKILL)` would include this process, and a guard
   * that kills itself before it has finished cannot report what it did.
   */
  try { process.kill(-process.pid, 'SIGTERM'); } catch { /* nothing left in the group */ }
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  const hard = setTimeout(() => {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    process.exit(code);
  }, GRACE_MS);
  hard.unref();
  /*
   * The child exiting is *not* on its own a reason to stop early. Its browsers are in a different
   * process group and may still be up; leaving before the SIGKILL pass is how a polite child with
   * an impolite grandchild produces the orphan one level down. So the grace timer always runs, and
   * the only thing the child's exit changes is that a fast path is available when the tree is
   * genuinely empty.
   */
  const finishIfEmpty = () => {
    if (pids.every((p) => { try { process.kill(p, 0); return false; } catch (e) { return e?.code !== 'EPERM'; } })) {
      clearTimeout(hard);
      process.exit(code);
    }
  };
  child.once('exit', () => setTimeout(finishIfEmpty, 300).unref());
  if (child.exitCode !== null || child.signalCode !== null) setTimeout(finishIfEmpty, 300).unref();
};

/*
 * A signal aimed at the guard is aimed at the tree. Without this, `kill <guardPid>` — which is
 * what a human types — would kill the nanny and leave the baby, producing exactly the orphan
 * the guard was hired to prevent, with the additional insult that the registry entry would now
 * be silent and look merely wedged.
 */
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => killGroup(`received ${sig}`, sig === 'SIGINT' ? 130 : 143));
}

/*
 * The anchor watch. `kill(pid, 0)` asks whether a process exists without signalling it: ESRCH
 * means gone, EPERM means alive and owned by somebody else, which counts as alive.
 *
 * **Any dead anchor is enough.** An anchor is not a hint, it is a life the job requires, and the
 * two defaults are required for different reasons:
 *
 *   - the **spawning process**, because a job whose caller has gone is by definition unowned —
 *     this is the property the brief asks for in one line, *"a detached child cannot outlive its
 *     parent"*;
 *   - the **agent session**, because on 23 Aug the spawning shell had exited long before and the
 *     loop had been reparented to init, so watching the parent alone would have watched a PID
 *     that was already gone and concluded nothing.
 *
 * A caller that genuinely wants to outlive its own process asks `spawnOwned` for
 * `keepAlive: true`, which drops the *spawning process* from the anchor list and keeps the
 * agent. There is deliberately no way to drop the agent: outliving your agent is the bug.
 *
 * An empty anchor list is not "watch nothing"; `spawnOwned` refuses to produce one.
 */
const watch = setInterval(() => {
  if (dying) return;
  try { const t = Date.now() / 1000; if (ENTRY) utimesSync(ENTRY, t, t); } catch { /* reaped */ }
  if (!ANCHORS.length) return;
  const dead = ANCHORS.filter((p) => !pidAlive(p));
  if (!dead.length) return;
  killGroup(`owner ${dead.join(', ')} is gone (anchors ${ANCHORS.join(', ')})`, 143);
}, WATCH_MS);
watch.unref();

/*
 * `unref` on the watch matters: the timer must not be the reason this process stays alive. The
 * child's stdio handles keep the event loop busy while the child runs, and when the child exits
 * we exit. A ref'd timer here would leave a guard spinning forever on a dead child.
 */
child.on('exit', (code, signal) => {
  if (dying) return;
  clearInterval(watch);
  stampEntry({ exited: new Date().toISOString(), exitCode: code, exitSignal: signal });
  /*
   * The child is gone, but its own children may not be. A probe that was SIGKILLed leaves its
   * browser behind — in a *different* process group, which is exactly the case a group kill
   * misses. Sweep the whole descendant closure before leaving, or the guard becomes a machine for
   * producing the very orphan it was hired to prevent, one level further down and therefore
   * harder to see.
   */
  killGroup(`child exited (${signal ?? `code ${code}`}); sweeping what it left`, signal ? 143 : (code ?? 0));
});

child.on('error', (err) => {
  process.stderr.write(`spawn-guard: could not start ${command}: ${err?.message ?? err}\n`);
  stampEntry({ exited: new Date().toISOString(), error: String(err?.message ?? err) });
  process.exit(127);
});
