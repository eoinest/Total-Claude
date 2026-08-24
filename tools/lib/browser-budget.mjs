#!/usr/bin/env node
/**
 * A cap on concurrent headless browsers that holds across independent processes.
 *
 * ## What this is for
 *
 * On 22 August this machine went to **load average 160 on 16 cores with 136 concurrent `vite`
 * and `chrome-headless-shell` processes** and had to be recovered by hand. Earlier the same
 * morning nineteen orphaned dev servers were swept off it, several more than a day old, from
 * worktrees whose agent sessions had ended.
 *
 * The cause is not one bad tool. Every agent runs in its own git worktree and starts its own
 * Vite server and its own Playwright Chromium, and a survey of the tree counted **303 runnable
 * entry points that open a browser** and **92 files that spawn `npx vite`**. None of them knew
 * any of the others existed. Twelve agents each behaving impeccably still produce twelve
 * browsers, and the measurement in `docs/tech/BROWSER-BUDGET.md` puts eight of them at 1.09x
 * this machine's cores.
 *
 * Every agent is a separate `node` process with no shared memory, so the cap has to live on
 * the filesystem. This is that: a slot directory under a well-known path, one lock file per
 * slot, taken atomically, released on exit, and reaped when its holder dies.
 *
 * ## The five properties, and the failure each one is for
 *
 * 1. **A holder that dies releases its slot.** The machine *crashed*: every lock held at that
 *    moment would otherwise still be held, and the first thing the cap would have done on
 *    reboot is refuse every launch forever. Liveness is three independent tests — boot
 *    generation, `kill(pid, 0)`, and a heartbeat mtime — and any one of them failing reaps the
 *    slot. See `isStale`.
 *
 * 2. **It is the path of least resistance.** `launchBrowser()` is a drop-in for
 *    `chromium.launch()`: same return value, same `close()`, one changed line per tool. It
 *    also *defaults the good GPU arguments*, so the lazy call — `launchBrowser({ label })` —
 *    is both budgeted and faster than the hand-rolled one it replaces. If doing it right is
 *    more work than doing it wrong, someone writing a probe at 2 a.m. does it wrong.
 *
 * 3. **The orphan mechanism is fixed here too**, because a cap on browsers that leaves the
 *    servers behind fixes half a problem. `startVite()` spawns `tools/lib/vite-runner.mjs`
 *    with `node` directly — no `npx` wrapper standing between the handle and the port — in its
 *    own process group, and the runner exits on its own within two seconds of its parent
 *    dying. The Vite PID is recorded in the lock, so `tools/browsers.mjs sweep` can find a
 *    server whose owner is gone even if all of that failed.
 *
 * 4. **It is observable.** `node tools/browsers.mjs` prints who holds what, for how long, on
 *    which port, in which worktree, and which entries are stale. On 22 August the answer to
 *    "what is running" took three greps and a wrong kill.
 *
 * 5. **It fails loudly.** Waiting is a queue with a stated timeout that prints what it is
 *    waiting on and who is ahead of it, not a silent hang. A hang is worse than a refusal.
 *
 * ## The cap
 *
 * Default **4**, measured rather than guessed — see `docs/tech/BROWSER-BUDGET.md` for the
 * sweep. Override with `TC_MAX_BROWSERS`, or set it machine-wide for every agent at once with
 * `node tools/browsers.mjs cap <n>`, which writes `<budget dir>/cap`. Resolution order is
 * env, then that file, then the default; every holder records the cap it believed, so
 * `status` can say when two agents disagree.
 *
 * ## 23 Aug 2026: the cap was not enough, and here is what it missed
 *
 * A count of browsers prices CPU, and CPU was never the contended resource. With **one** agent
 * browser rendering the field battle the load average sat at 6.25 of 16 cores — 39 %, "idle" —
 * while the GPU read `62, 94, 100, 26, 46, 99`. The owner reported lag twice while this file
 * printed *within budget*, and both times he was right and this file was wrong.
 *
 * `tools/lib/work-budget.mjs` adds the missing half, and it hooks in at exactly two points:
 *
 *   - **`acquireSlot`** consults `admit()` before granting. A free slot is now necessary and
 *     not sufficient: the cap becomes 4 / 2 / 1 depending on whether the owner is away,
 *     working or playing, and a new browser is refused while measured GPU utilisation is over
 *     the ceiling for that state. Both refusals queue, exactly as a full slot table does.
 *   - **the heartbeat** reconciles QoS. When he sits down, every running agent browser is
 *     moved to the background band with `taskpolicy -b` — efficiency cores, lower GPU
 *     priority — and moved back when he leaves. This is the only part that can help a film
 *     that took its slot six minutes ago, which is the shape both of his reports had.
 *
 * ## Environment
 *
 * | variable | default | meaning |
 * |---|---|---|
 * | `TC_MAX_BROWSERS` | `4` | concurrent browser slots, machine-wide |
 * | `TC_BROWSER_BUDGET` | `on` | `off` disables the cap — loudly, on every acquire |
 * | `TC_BUDGET_DIR` | `/tmp/tc-browser-budget` | where the locks live |
 * | `TC_BROWSER_WAIT_MS` | `1800000` (30 min) | how long to queue before failing |
 * | `TC_BROWSER_STALE_MS` | `90000` | no heartbeat for this long and the slot is reaped |
 * | `TC_WORK_BUDGET` | `on` | `off` disables admission and QoS but keeps the count cap |
 * | `TC_OWNER` | `auto` | `away` \| `present` \| `playing` — beats detection |
 * | `TC_QOS` | `on` | `off` keeps running browsers at foreground priority |
 *
 * ## Usage
 *
 *     import { launchBrowser, startVite } from './lib/browser-budget.mjs';
 *
 *     const { base, server } = await startVite({ port: PORT, root: ROOT });
 *     const browser = await launchBrowser({ label: 'probe-seams', port: PORT, root: ROOT });
 *     ...
 *     await browser.close();        // releases the slot
 *     await server.close();         // stops the dev server, if we started it
 *
 * or, for a new tool, the whole thing at once:
 *
 *     await withHarness({ label: 'probe-x', port: 5901, root: ROOT }, async ({ base, browser }) => {
 *       ...
 *     });
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync,
  unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  admit, describe, makeThrottle, newBrowserPid, ourBrowserPids, ownerState, workBudgetEnabled,
} from './work-budget.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(LIB_DIR, '..');
const REPO_ROOT = path.resolve(TOOLS_DIR, '..');

export const BUDGET_DIR = process.env.TC_BUDGET_DIR || '/tmp/tc-browser-budget';
const SLOT_DIR = path.join(BUDGET_DIR, 'slots');
const WAIT_DIR = path.join(BUDGET_DIR, 'waiting');
const TMP_DIR = path.join(BUDGET_DIR, 'tmp');
const CAP_FILE = path.join(BUDGET_DIR, 'cap');

export const DEFAULT_CAP = 4;
const STALE_MS = Number(process.env.TC_BROWSER_STALE_MS || 90_000);
const HEARTBEAT_MS = 10_000;
const WAIT_MS = Number(process.env.TC_BROWSER_WAIT_MS || 30 * 60_000);
const POLL_MS = 700;

const ensureDirs = () => {
  for (const d of [BUDGET_DIR, SLOT_DIR, WAIT_DIR, TMP_DIR]) mkdirSync(d, { recursive: true });
};

/**
 * The boot generation.
 *
 * A PID is not an identity across a reboot, and the event this exists for **was** a reboot: a
 * lock file recording pid 4711 from before the crash will match some unrelated process
 * afterwards, and `kill(4711, 0)` will say "alive". Stamping every record with the kernel's
 * boot time makes every pre-crash lock unambiguously dead without waiting for any timeout.
 *
 * `sysctl kern.boottime` on Darwin; elsewhere, `Date.now() - uptime`, rounded to ten seconds
 * because `os.uptime()` has enough jitter to disagree with itself between two processes.
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

export const capSource = () => {
  if (process.env.TC_MAX_BROWSERS) return { cap: Number(process.env.TC_MAX_BROWSERS), from: 'TC_MAX_BROWSERS' };
  try {
    const n = Number(readFileSync(CAP_FILE, 'utf8').trim());
    if (Number.isFinite(n) && n > 0) return { cap: n, from: CAP_FILE };
  } catch { /* no file */ }
  return { cap: DEFAULT_CAP, from: 'default' };
};

export const budgetCap = () => {
  const { cap } = capSource();
  if (!Number.isFinite(cap) || cap < 1) {
    throw new Error(
      `TC_MAX_BROWSERS must be an integer >= 1; got ${JSON.stringify(process.env.TC_MAX_BROWSERS)}.\n`
      + '  To run without a cap, set TC_BROWSER_BUDGET=off — which says so on every launch.'
    );
  }
  return Math.floor(cap);
};

export const budgetEnabled = () => (process.env.TC_BROWSER_BUDGET || 'on').toLowerCase() !== 'off';

const pidAlive = (pid) => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
};

const readRecord = (file) => {
  try {
    const raw = readFileSync(file, 'utf8');
    const rec = JSON.parse(raw);
    rec._file = file;
    rec._mtimeMs = statSync(file).mtimeMs;
    return rec;
  } catch { return null; }
};

/**
 * Three independent reasons a lock is dead, and the reason is reported rather than swallowed
 * because "why did my slot disappear" is the next question after it does.
 *
 *   - `reboot`  — the record predates the current boot. Instant, certain, and the case the
 *                 crash produced.
 *   - `no-pid`  — `kill(pid, 0)` says ESRCH. Instant. Covers SIGKILL and a plain crash.
 *   - `silent`  — the heartbeat mtime has not moved for `TC_BROWSER_STALE_MS`. This is the
 *                 backstop for a holder that is technically alive and permanently wedged, and
 *                 it is the only one with a false-positive risk, so its margin is nine
 *                 heartbeats rather than two.
 */
export const isStale = (rec, now = Date.now()) => {
  if (!rec) return 'unreadable';
  if (rec.bootId && rec.bootId !== bootId()) return 'reboot';
  if (!pidAlive(rec.pid)) return 'no-pid';
  if (now - (rec._mtimeMs ?? 0) > STALE_MS) return 'silent';
  return null;
};

export const listSlots = () => {
  ensureDirs();
  const now = Date.now();
  const out = [];
  for (const name of readdirSync(SLOT_DIR).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(SLOT_DIR, name);
    const rec = readRecord(file);
    out.push({
      slot: Number(name.replace('.json', '')),
      file,
      rec,
      stale: isStale(rec, now),
      heldMs: rec?.acquiredAt ? now - Date.parse(rec.acquiredAt) : null,
    });
  }
  return out;
};

export const listWaiters = () => {
  ensureDirs();
  const now = Date.now();
  const out = [];
  for (const name of readdirSync(WAIT_DIR).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(WAIT_DIR, name);
    const rec = readRecord(file);
    out.push({ ticket: name.replace('.json', ''), file, rec, stale: isStale(rec, now),
      waitingMs: rec?.since ? now - Date.parse(rec.since) : null });
  }
  return out;
};

/**
 * Remove dead entries. Returns what it removed and why.
 *
 * The re-stat before unlinking is not paranoia: a holder heartbeats every ten seconds, and
 * without it a reaper that decided "silent" on a stale read could delete a lock that had come
 * back to life two milliseconds later. Re-reading and re-testing under the same rule closes
 * that window to the width of one `unlink`.
 */
export const reapStale = ({ killVite = true } = {}) => {
  ensureDirs();
  const reaped = [];
  for (const entry of [...listSlots(), ...listWaiters()]) {
    if (!entry.stale) continue;
    const fresh = readRecord(entry.file);
    if (fresh && !isStale(fresh)) continue;
    try { unlinkSync(entry.file); } catch { continue; }
    reaped.push({ file: entry.file, why: entry.stale, rec: entry.rec });
    // A dead holder may have left a dev server behind. The runner kills itself within two
    // seconds of losing its parent, so this is the third line of defence, not the first.
    const vpid = entry.rec?.vitePid;
    if (killVite && Number.isFinite(vpid) && vpid > 1 && entry.stale !== 'reboot' && pidAlive(vpid)) {
      try { process.kill(-vpid, 'SIGTERM'); } catch { try { process.kill(vpid, 'SIGTERM'); } catch { /* gone */ } }
    }
  }
  // Sweep the scratch directory too; a crash between write and link leaves a file there.
  try {
    for (const name of readdirSync(TMP_DIR)) {
      const f = path.join(TMP_DIR, name);
      if (Date.now() - statSync(f).mtimeMs > 5 * 60_000) rmSync(f, { force: true });
    }
  } catch { /* nothing to sweep */ }
  return reaped;
};

const rand = () => Math.random().toString(36).slice(2, 10);

/**
 * Atomic create-with-contents.
 *
 * `open(..., 'wx')` is atomic but leaves a window in which the file exists and is empty, and a
 * reader landing in that window sees an unreadable record and calls it stale — which is a
 * reaper deleting a lock somebody is in the middle of taking. Writing to a scratch file and
 * `link()`ing it into place has no such window: `link` is atomic, fails `EEXIST` if the target
 * exists, and the file is fully formed the instant it is visible.
 */
const linkAtomic = (target, payload) => {
  const tmp = path.join(TMP_DIR, `${process.pid}-${rand()}.json`);
  writeFileSync(tmp, payload);
  try {
    linkSync(tmp, target);
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    return false;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
};

const describeHolder = (e) => {
  const r = e.rec ?? {};
  const held = e.heldMs != null ? `${(e.heldMs / 1000).toFixed(0)}s` : '?';
  return `slot ${e.slot}: ${r.label ?? '?'} pid ${r.pid ?? '?'}`
    + `${r.port ? ` port ${r.port}` : ''} held ${held}`
    + `${r.root ? ` [${path.basename(r.root)}]` : ''}`;
};

/**
 * Take one slot, or wait for one.
 *
 * Returns a handle with `release()`. `release()` is idempotent and safe to call after the slot
 * has already been reaped out from under us — it checks the token before unlinking, so it can
 * never delete a slot that has since been taken by somebody else.
 */
export async function acquireSlot({
  label = path.basename(process.argv[1] ?? 'unknown'),
  port = null,
  root = REPO_ROOT,
  meta = {},
  waitMs = WAIT_MS,
  quiet = false,
} = {}) {
  ensureDirs();

  if (!budgetEnabled()) {
    process.stderr.write(
      '!! BROWSER BUDGET DISABLED (TC_BROWSER_BUDGET=off). Nothing is counting browsers on this\n'
      + '!! machine. This is the setting that produced load average 160 on 22 Aug 2026.\n'
    );
    return {
      slot: -1, disabled: true, release: () => {}, setVitePid: () => {}, record: null,
      throttle: { add: () => {}, reconcile: () => null, restore: () => {}, applied: false },
    };
  }

  const cap = budgetCap();
  const token = `${process.pid}-${Date.now()}-${rand()}`;
  const base = {
    token, label, pid: process.pid, port, root,
    cwd: process.cwd(), bootId: bootId(), cap, argv: process.argv.slice(1, 4), ...meta,
  };

  reapStale();
  assertPortNotStolen({ port, root, label });

  /*
   * The queue ticket. Without one this is a free-for-all and a process that has been waiting
   * eleven minutes loses to one that arrived a millisecond ago; with one, `status` can also
   * say who is in line, which is half the value of the observability command.
   *
   * Tickets sort lexicographically because the timestamp is zero-padded.
   */
  const ticket = `${String(Date.now()).padStart(16, '0')}-${process.pid}-${rand()}`;
  const ticketFile = path.join(WAIT_DIR, `${ticket}.json`);
  let ticketed = false;
  const dropTicket = () => {
    if (!ticketed) return;
    ticketed = false;
    try { unlinkSync(ticketFile); } catch { /* already gone */ }
  };

  const deadline = Date.now() + waitMs;
  let announced = false;
  let lastNote = 0;

  try {
    for (;;) {
      reapStale();
      const slots = listSlots();
      const live = slots.filter((s) => !s.stale);
      const taken = new Set(live.map((s) => s.slot));
      const free = [];
      for (let i = 0; i < cap; i++) if (!taken.has(i)) free.push(i);

      // Only the front of the queue may take a slot, and only as many as are free. Waiters
      // whose process has died are not in the line; `reapStale` has already removed them.
      let mayTry = free.length > 0;
      if (mayTry && ticketed) {
        const queue = listWaiters().filter((w) => !w.stale).map((w) => w.ticket).sort();
        const idx = queue.indexOf(ticket);
        if (idx >= 0 && idx >= free.length) mayTry = false;
      }

      /*
       * The work gate. A free slot is necessary and no longer sufficient.
       *
       * `admit` prices the machine rather than counting handles: it applies the owner-state
       * ladder (4 away / 2 present / 1 playing) and refuses while measured GPU utilisation is
       * over the ceiling for that state. Both refusals are transient by construction — they
       * are re-tested every poll — so this queues rather than fails, exactly as a full slot
       * table does. See `tools/lib/work-budget.mjs` for why the count-based cap was not enough.
       *
       * The observation is shared through `<budget dir>/machine.json` and cached for six
       * seconds, so polling this at 700 ms costs one filesystem read almost every time.
       */
      let gate = null;
      if (mayTry) {
        // `selfHeld` is what stops a two-browser gate deadlocking against itself; see `admit`.
        gate = admit({
          liveCount: live.length,
          selfHeld: live.filter((s) => s.rec?.pid === process.pid).length,
        });
        if (!gate.ok) mayTry = false;
      }

      if (mayTry) {
        for (const i of free) {
          const rec = { ...base, slot: i, acquiredAt: new Date().toISOString() };
          const file = path.join(SLOT_DIR, `${String(i).padStart(2, '0')}.json`);
          if (!linkAtomic(file, JSON.stringify(rec, null, 2))) continue;
          dropTicket();
          if (announced && !quiet) {
            process.stderr.write(`   … got slot ${i} of ${cap} after `
              + `${((Date.now() - (deadline - waitMs)) / 1000).toFixed(0)}s.\n`);
          }
          return makeHandle({ file, rec, cap, quiet });
        }
        // Lost every race this round. Fall through and try again.
      }

      if (!ticketed) {
        writeFileSync(ticketFile, JSON.stringify({ ...base, since: new Date().toISOString() }, null, 2));
        ticketed = true;
      } else {
        try { const t = Date.now() / 1000; utimesSync(ticketFile, t, t); } catch { /* recreate next round */ }
      }

      if (Date.now() > deadline) {
        const holders = listSlots().filter((s) => !s.stale);
        const lastGate = gate && !gate.ok ? gate : null;
        throw new Error(
          `browser budget: waited ${(waitMs / 60000).toFixed(0)} min for one of ${cap} slots and gave up.\n`
          + `  Asked for: ${label}${port ? ` (port ${port})` : ''} in ${root}\n`
          + (lastGate
            ? `  Refused by the work budget, not the slot table: ${lastGate.reason}\n`
              + `  Machine at the last check: ${describe(lastGate.snapshot)}\n`
            : '')
          + `  Held by:\n${holders.map((h) => `    ${describeHolder(h)}`).join('\n') || '    (none — the cap may be 0 or the dir unwritable)'}\n`
          + `  Inspect: node tools/browsers.mjs\n`
          + `  Free a wedged slot: node tools/browsers.mjs reap\n`
          + `  Raise the cap for this run only: TC_MAX_BROWSERS=${cap + 1} <command>\n`
          + '  If the owner is not actually at the machine: TC_OWNER=away <command>'
        );
      }

      if (!quiet && (!announced || Date.now() - lastNote > 30_000)) {
        const holders = listSlots().filter((s) => !s.stale);
        const queue = listWaiters().filter((w) => !w.stale).map((w) => w.ticket).sort();
        const place = queue.indexOf(ticket);
        const selfHeld = holders.filter((h) => h.rec?.pid === process.pid).length;
        process.stderr.write(
          `browser budget: ${holders.length}/${cap} in use, waiting for a slot`
          + `${place >= 0 ? ` (position ${place + 1} of ${queue.length})` : ''}.\n`
          /*
           * When the refusal is the *work* gate rather than a full slot table, say so. "Waiting
           * for a slot" while three slots stand empty is the single most confusing thing this
           * change could print, and an agent that cannot tell the two apart will conclude the
           * budget is broken and set TC_BROWSER_BUDGET=off.
           */
          + (gate && !gate.ok
            ? `   work budget: ${gate.reason}\n`
              + `   ${gate.why === 'gpu'
                ? 'The GPU is the contended resource, not the CPU. Slots may look free.'
                : 'Slots may look free; the owner-state ladder is the tighter limit.'}\n`
              + '   Override for one run: TC_OWNER=away <command>   (say why in your report)\n'
            : '')
          + holders.map((h) => `   ${describeHolder(h)}\n`).join('')
          + (selfHeld > 0 && selfHeld === holders.length
            ? `   !! every slot is held by THIS process (${process.pid}). It is waiting on itself.\n`
              + '   !! Raise TC_MAX_BROWSERS or close a browser before opening another.\n'
            : '')
        );
        announced = true;
        lastNote = Date.now();
      }

      await new Promise((r) => setTimeout(r, POLL_MS + Math.floor(Math.random() * 300)));
    }
  } finally {
    dropTicket();
  }
}

/**
 * A port claimed by a live holder in a *different* tree is a refusal, not a warning.
 *
 * This is the 5901 incident, encoded. Two agents picked the same port; the second reused the
 * first's server, measured the first's branch, and then killed it. Reuse within one root is
 * legitimate and common — reuse across roots is a measurement of the wrong tree, and there is
 * no version of that which is what anybody wanted.
 */
export const assertPortNotStolen = ({ port, root, label }) => {
  if (!port) return;
  const clash = listSlots().find((s) => !s.stale && s.rec?.port === Number(port)
    && s.rec?.root && path.resolve(s.rec.root) !== path.resolve(root));
  if (!clash) return;
  throw new Error(
    `browser budget: port ${port} is already held by another worktree.\n`
    + `  ${describeHolder(clash)}\n`
    + `    their root: ${clash.rec.root}\n`
    + `    your root:  ${root}   (${label})\n`
    + '  Reusing it would measure their branch and report it as yours, and killing it would\n'
    + '  take down their run. Pick another port in the 5900s.\n'
    + '  See what is taken: node tools/browsers.mjs'
  );
};

const makeHandle = ({ file, rec, cap, quiet }) => {
  let released = false;

  /*
   * The lever that reaches work already running.
   *
   * Admission control cannot help against a film that took its slot six minutes ago and is
   * still rendering when the owner sits down — and *both* of his lag reports were of exactly
   * that shape. The heartbeat is already firing every ten seconds for the life of the run, so
   * it re-reads the owner state (about 50 ms: two `ioreg` calls and an `lsappinfo`) and
   * demotes or restores this run's own browser accordingly.
   *
   * `reconcile` is a no-op when the state has not changed, so the steady-state cost is the
   * owner read alone. The `restore()` on release, and on every exit path through
   * `registerCleanup`, is not optional: a process left in the background band outlives us.
   */
  const throttle = makeThrottle({ label: rec.label });

  const beat = setInterval(() => {
    try { const t = Date.now() / 1000; utimesSync(file, t, t); } catch { /* reaped */ }
    if (!workBudgetEnabled()) return;
    try {
      const state = ownerState().state;
      const moved = throttle.reconcile(state);
      if (moved && !quiet) {
        process.stderr.write(`work budget: owner is ${state} — ${rec.label} `
          + `${moved === 'demoted' ? 'moved to the background band (efficiency cores, lower GPU priority)'
            : 'returned to normal priority'}.\n`);
      }
    } catch { /* a sensor failing must never take down a run */ }
  }, HEARTBEAT_MS);
  beat.unref();

  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    try { throttle.restore(); } catch { /* the process is probably already gone */ }
    cleanups.delete(release);
    /*
     * Token check before unlink. If this slot was reaped while we were wedged and handed to
     * somebody else, deleting it would silently over-subscribe the machine by one — which is
     * precisely the bug the whole file exists to prevent, reintroduced by its own cleanup.
     */
    try {
      const cur = JSON.parse(readFileSync(file, 'utf8'));
      if (cur.token !== rec.token) return;
    } catch { return; }
    try { unlinkSync(file); } catch { /* already gone */ }
  };

  registerCleanup(release);

  const setVitePid = (pid) => {
    rec.vitePid = pid;
    try { writeFileSync(file, JSON.stringify(rec, null, 2)); } catch { /* reaped */ }
  };

  if (!quiet && process.env.TC_BUDGET_VERBOSE === '1') {
    process.stderr.write(`browser budget: took slot ${rec.slot} of ${cap} for ${rec.label}\n`);
  }
  return { slot: rec.slot, cap, file, record: rec, release, setVitePid, throttle, disabled: false };
};

/*
 * One set of process-wide hooks, installed once, running every registered cleanup.
 *
 * Per-handle `process.on('exit')` listeners were the obvious spelling and are wrong twice
 * over: node warns at eleven listeners, and a harness that opens and closes browsers in a loop
 * accumulates one dead listener per iteration.
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
  process.on('uncaughtException', (err) => {
    runCleanups();
    console.error(err);
    process.exit(1);
  });
}

/**
 * The GPU arguments, in one place.
 *
 * Without `--use-angle=metal` Chromium falls back to SwiftShader and rasterises this scene in
 * software: measured boots of four to six minutes against seconds, silently, with the only
 * outward sign being a probe that looks slow. Several tools in this directory pass
 * `--use-gl=angle --enable-unsafe-swiftshader` and *no* `--use-angle`, which is the fallback
 * spelled out. Defaulting it here means the shortest possible call is also the fast one.
 *
 * `--enable-unsafe-swiftshader` stays because WebGL context creation fails outright on some
 * headless configurations without it; it is a permission to fall back, not an instruction to.
 * Check which you actually got:  ps -A -o command | grep 'type=gpu-process'
 */
export const GPU_ARGS = [
  '--use-gl=angle',
  '--use-angle=metal',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/**
 * `chromium.launch()`, with a slot.
 *
 * Drop-in: the returned object is Playwright's own `Browser`, with `close()` wrapped so that
 * releasing the slot cannot be forgotten. Every other method is untouched, so a tool that
 * calls `newContext`, `newPage`, `contexts()` needs no other change.
 *
 *     - const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
 *     + const browser = await launchBrowser({ label: 'probe-x', port: PORT, root: ROOT });
 *
 * `args` are *added to* `GPU_ARGS`, not substituted for them, so a caller that wants
 * `--hide-scrollbars` does not accidentally drop itself into software rendering.
 */
export async function launchBrowser({
  label = path.basename(process.argv[1] ?? 'unknown'),
  engine = 'chromium',
  args = [],
  port = null,
  root = REPO_ROOT,
  meta = {},
  waitMs = WAIT_MS,
  quiet = false,
  gpuArgs = GPU_ARGS,
  ...launchOptions
} = {}) {
  const { chromium, firefox, webkit } = await import('playwright');
  const engines = { chromium, firefox, webkit };
  const type = engines[engine];
  if (!type) throw new Error(`launchBrowser: unknown engine ${engine}; use chromium, firefox or webkit`);

  const handle = await acquireSlot({
    label, port, root, waitMs, quiet, meta: { ...meta, engine },
  });

  let browser;
  /*
   * Snapshot our own browser children *before* launching, so the one that appears can be
   * identified by difference. Playwright 1.62 exposes no PID for a locally launched browser —
   * see `newBrowserPid` for the three private paths that are all undefined, and for the bug
   * that shipped when this guessed instead.
   */
  const before = engine === 'chromium' ? ourBrowserPids() : new Set();
  try {
    // Only Chromium takes these; Firefox and WebKit reject unknown flags.
    const finalArgs = engine === 'chromium'
      ? [...gpuArgs, ...args.filter((a) => !gpuArgs.includes(a))]
      : args;
    browser = await type.launch({ ...launchOptions, args: finalArgs });
  } catch (err) {
    handle.release();
    throw err;
  }

  /*
   * Register the browser with the throttle and reconcile once, immediately.
   *
   * Once, here, matters: a run that starts *while* the owner is already playing would otherwise
   * render at full priority until the first heartbeat ten seconds later, and ten seconds of a
   * nine-thousand-man battle at foreground GPU priority is precisely the stutter he reports.
   * After this the heartbeat keeps it in step.
   */
  const bpid = engine === 'chromium' ? newBrowserPid(before) : null;
  if (bpid) {
    handle.throttle.add(bpid);
    try { handle.throttle.reconcile(ownerState().state); } catch { /* sensors are advisory */ }
  }
  browser.budgetPid = bpid;

  const origClose = browser.close.bind(browser);
  browser.close = async (...rest) => {
    try { return await origClose(...rest); } finally { handle.release(); }
  };
  browser.on('disconnected', () => handle.release());
  browser.budgetSlot = handle;
  return browser;
}

/**
 * Start a dev server that cannot outlive us, or reuse one that is serving **this** tree.
 *
 * Returns `{ base, server, started, pid, close }`. `close()` is always safe to call: it stops
 * the server if we started it and does nothing if we reused somebody's.
 *
 * The reuse path checks `/__tc/tree` first. A listener that answers with a different root is
 * refused, because measuring another worktree and reporting it as yours is the failure mode
 * that is impossible to notice from the output. A listener that does not answer at all is an
 * older-style server; that is a warning, and `TC_STRICT_TREE=1` promotes it to a refusal.
 */
export async function startVite({
  port, root = REPO_ROOT, cacheDir, label = 'vite', slot = null, timeoutMs = 120_000,
} = {}) {
  const base = `http://127.0.0.1:${port}`;
  const existing = await probeTree(base, 1500);
  if (existing.up) {
    if (existing.tree && path.resolve(existing.tree.root) !== path.resolve(root)) {
      throw new Error(
        `startVite: something is already listening on ${port}, and it is not this tree.\n`
        + `  serving: ${existing.tree.root} (pid ${existing.tree.pid})\n`
        + `  wanted:  ${root}\n`
        + '  Reusing it would measure that branch under this branch\'s name. Pick another port.'
      );
    }
    if (!existing.tree) {
      const msg = `startVite: reusing an unidentified listener on ${port}. It predates`
        + ' tools/lib/vite-runner.mjs, so which tree it is serving cannot be established.';
      if (process.env.TC_STRICT_TREE === '1') throw new Error(`${msg}\n  TC_STRICT_TREE=1 is set, so this is a refusal.`);
      process.stderr.write(`!! ${msg}\n!! Confirm by headcount, or restart it. TC_STRICT_TREE=1 makes this fatal.\n`);
    }
    return { base, server: null, started: false, pid: existing.tree?.pid ?? null, close: async () => {} };
  }

  const runner = path.join(LIB_DIR, 'vite-runner.mjs');
  const child = spawn(
    process.execPath,
    [runner, `--port=${port}`, `--root=${root}`, `--parent=${process.pid}`,
      ...(cacheDir || process.env.TC_VITE_CACHE_DIR ? [`--cache-dir=${cacheDir || process.env.TC_VITE_CACHE_DIR}`] : [])],
    {
      cwd: root,
      // Its own process group, so one `kill(-pid)` takes the server and anything it spawned.
      // The old `spawn('npx', ...)` left the wrapper in ours and Vite in a third place.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TC_NO_HMR: '1' },
    }
  );
  child.unref();
  if (slot?.setVitePid) slot.setVitePid(child.pid);
  // The server is part of this run's footprint and yields with it. Vite is a CPU cost, not a
  // GPU one, so demoting it does nothing for the frame rate — it is here so that an agent that
  // has been told to get off the owner's performance cores actually gets off all of them.
  // Cached module serving on an efficiency core is still milliseconds; boot waits are minutes.
  if (slot?.throttle) slot.throttle.add(child.pid);

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });

  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += String(d);
      if (buf.includes('TC_VITE_READY')) { clearTimeout(timer); resolve(true); }
    });
    child.once('exit', () => { clearTimeout(timer); resolve(false); });
  });

  const killGroup = () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  };
  const close = async () => { cleanups.delete(killGroup); killGroup(); };

  if (!ready) {
    await close();
    throw new Error(
      `startVite: vite did not come up on ${port} within ${(timeoutMs / 1000).toFixed(0)}s`
      + ` (${label}).\n${stderr.split('\n').slice(-8).join('\n')}`
    );
  }

  registerCleanup(killGroup);
  return { base, server: child, started: true, pid: child.pid, close };
}

/** Ask a listener what tree it is serving. `up` is whether anything answered at all. */
export async function probeTree(base, ms = 1500) {
  const end = Date.now() + ms;
  let up = false;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(1200) });
      if (r.ok || r.status === 304) { up = true; break; }
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) return { up: false, tree: null };
  try {
    const r = await fetch(`${base}/__tc/tree`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const tree = await r.json();
      if (tree?.tc === 'vite-runner') return { up: true, tree };
    }
  } catch { /* older server */ }
  return { up: true, tree: null };
}

/**
 * Server, browser and slot in one call, released in the right order whatever happens.
 *
 * For a *new* tool this should be the whole setup. It exists so that the correct thing is also
 * the short thing — the entire reason the previous convention (a comment in HANDOFF.md asking
 * agents to use the 5900s) did not hold.
 */
export async function withHarness({
  label, port, root = REPO_ROOT, engine = 'chromium', args = [], cacheDir, waitMs = WAIT_MS,
  ...launchOptions
}, fn) {
  const browser = await launchBrowser({ label, engine, args, port, root, waitMs, ...launchOptions });
  let server = null;
  try {
    server = await startVite({ port, root, cacheDir, label, slot: browser.budgetSlot });
    return await fn({ browser, base: server.base, server });
  } finally {
    try { await browser.close(); } catch { /* already closed */ }
    try { await server?.close(); } catch { /* already down */ }
  }
}

export const paths = { BUDGET_DIR, SLOT_DIR, WAIT_DIR, TMP_DIR, CAP_FILE, REPO_ROOT, TOOLS_DIR };
