#!/usr/bin/env node
/**
 * Is this record still evidence of anything? — the three tests, in one place.
 *
 * ## Why this file exists rather than a copy
 *
 * `tools/lib/browser-budget.mjs` worked out how to decide whether a lock file is live, and it
 * got it right: boot generation, `kill(pid, 0)`, heartbeat mtime, any one failing is enough.
 * `tools/lib/process-registry.mjs` needs exactly the same decision about a different kind of
 * record, and the one thing that must not happen is two answers to "is pid 4711 alive" that
 * disagree — a reaper that thinks a holder is dead while the semaphore thinks it is alive will
 * kill a process that still holds a slot, and the slot will then be released by nobody.
 *
 * So the tests live here and both files import them. `browser-budget.mjs` re-exports `bootId`
 * so that `tools/reclaim.mjs`, which imports it from there, keeps working unchanged.
 *
 * ## The three tests, and what each one is for
 *
 *   - **`reboot`** — the record predates the current boot. A PID is not an identity across a
 *     reboot: a record naming pid 4711 from before the crash will match some unrelated process
 *     afterwards and `kill(4711, 0)` will cheerfully say "alive". This test is instant and
 *     certain, and it is the one that makes a machine which has slept or crashed come back
 *     clean rather than either wedged or homicidal.
 *   - **`no-pid`** — `kill(pid, 0)` raises ESRCH. Instant. Covers SIGKILL, a crash, and an
 *     agent that was stopped. EPERM counts as *alive*: it means the process exists and belongs
 *     to somebody else.
 *   - **`silent`** — the heartbeat mtime has not moved for the stale window. This is the
 *     backstop for a holder that is technically alive and permanently wedged, and it is the
 *     only one of the three with a false-positive risk, so its margin is nine heartbeats.
 *
 * **`reboot` is not merely a different reason, it is a different action.** A record from a
 * previous boot must be deleted and its recorded PIDs must *not* be signalled, because those
 * numbers now belong to strangers. Every caller here has to branch on that, so `killable()`
 * says it out loud rather than leaving it to be remembered.
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import process from 'node:process';

/**
 * The boot generation.
 *
 * `sysctl kern.boottime` on Darwin; elsewhere, `Date.now() - uptime`, rounded to ten seconds
 * because `os.uptime()` has enough jitter to disagree with itself between two processes started
 * a moment apart, and a boot id that differs between two readers reaps everything on sight.
 */
let bootIdCache = null;
export const bootId = () => {
  if (bootIdCache) return bootIdCache;
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
      const m = out.match(/sec\s*=\s*(\d+)/);
      if (m) return (bootIdCache = `darwin:${m[1]}`);
    } catch { /* fall through */ }
  }
  const approx = Math.round((Date.now() / 1000 - os.uptime()) / 10) * 10;
  return (bootIdCache = `uptime:${approx}`);
};

/** `kill(pid, 0)` sends no signal. ESRCH is gone; EPERM is alive and not ours. */
export const pidAlive = (pid) => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
};

/** The heartbeat: the mtime of the record itself, so touching it costs one `utimes`. */
export const heartbeatAge = (file, now = Date.now()) => {
  try { return now - statSync(file).mtimeMs; } catch { return Infinity; }
};

/**
 * Why this record is dead, or `null` if it is alive.
 *
 * `pids` is every PID whose life the record requires, and **the first one that is gone makes the
 * record dead.** The semaphore passes one — the holder — so for it the rule is the rule it always
 * had. The registry passes three: the process that spawned the tree, the guard watching it, and
 * **the agent session**, which is the anchor that would have caught the orphan on 23 Aug, when
 * the spawning shell had exited hours earlier and the loop had been reparented to init.
 *
 * `all` rather than `any` is the whole point. A record that stayed alive while *any* anchor
 * lived would keep a job alive on the strength of an agent that no longer owns it, or on the
 * strength of a guard that is still running but supervising a caller that has gone. Requiring
 * all of them is what makes "a detached child cannot outlive its parent" true.
 */
export const stalenessOf = (rec, { pids = [], mtimeMs = null, staleMs = 90_000, now = Date.now() } = {}) => {
  if (!rec) return 'unreadable';
  if (rec.bootId && rec.bootId !== bootId()) return 'reboot';
  const anchors = pids.filter((p) => Number.isFinite(p) && p > 1);
  if (anchors.some((p) => !pidAlive(p))) return 'no-pid';
  if (mtimeMs != null && now - mtimeMs > staleMs) return 'silent';
  return null;
};

/**
 * Is it safe to signal the PIDs in a record that has been found stale?
 *
 * Only when the staleness is *not* `reboot`. After a reboot the numbers in the record name
 * whoever happens to hold them now, and `kill(-4711)` would take down a stranger's process
 * group. This is the check `reapStale` in the semaphore makes inline; naming it means the
 * registry cannot forget it.
 */
export const killable = (why) => why !== 'reboot' && why !== null;
