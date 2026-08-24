#!/usr/bin/env node
/**
 * A budget in *work*, not in count — and a reserve that belongs to the owner.
 *
 * ## The bug this exists for
 *
 * `tools/lib/browser-budget.mjs` caps concurrent headless browsers at four and the cap holds.
 * Twice since it landed the owner has reported the machine lagging while `node
 * tools/browsers.mjs` printed *within budget*, and both times the CPU looked half idle.
 * Measured on 23 Aug 2026 with **one** agent browser rendering the field battle:
 *
 *     load average 6.25 on 16 cores   ← 39 %, "idle"
 *     Device Utilization %   62, 94, 100, 26, 46, 99   ← the GPU, pinned
 *
 * A count of browsers prices CPU. The contended resource was never CPU. There is exactly one
 * GPU on this machine, every headless Chromium here runs `--use-angle=metal` on purpose, and
 * so every one of them queues its draw calls behind the owner's game. **Four browsers is not
 * four-sixteenths of the machine; it is most of the GPU.**
 *
 * ## What this adds, in one sentence each
 *
 *   1. **A ladder, not a number.** The cap is a function of what the owner is doing: 4 when he
 *      is away, 2 when he is working, 1 when he is playing. See `POLICY`.
 *   2. **A gate that measures before it grants.** Admission reads the GPU and refuses while it
 *      is above the ceiling for the current state, so four *cheap* browsers are still allowed
 *      and two *expensive* ones are not. A count cannot express that; this can.
 *   3. **A lever that reaches work already running.** Admission control is useless against a
 *      film that took its slot six minutes ago. Every holder re-reads the owner state on the
 *      heartbeat it already sends and puts its own browser into the background QoS band when
 *      he sits down — `taskpolicy -b`, which moves it to the efficiency cores and de-prioritises
 *      its GPU submissions. It comes back out when he leaves.
 *   4. **A shared observation.** Sampling the GPU costs about a second. One holder wins the
 *      observer lock and writes `<budget>/machine.json`; everybody else reads it. Without this,
 *      four holders heartbeating every ten seconds would spend four seconds a minute measuring
 *      how busy the machine is, which is its own small contribution to the problem.
 *
 * ## The numbers, and where each came from
 *
 * | knob | value | provenance |
 * |---|---|---|
 * | cap, owner away | 4 | measured: `bb-bench` — 0.45–0.48× cores, 92–98 % of linear scaling |
 * | cap, owner present | 2 | measured: `tools/scratch/gpu-bench.mjs`, see `docs/tech/RESOURCE-BUDGET.md` |
 * | cap, owner playing | 1 | measured: same bench, owner-frame-time arm |
 * | GPU ceiling, away | 92 % | a machine with nobody on it should be *used* |
 * | GPU ceiling, present | 70 % | **the owner's preference — asked, see below** |
 * | GPU ceiling, playing | 45 % | **the owner's preference — asked, see below** |
 * | idle before "away" | 180 s | judgement: long enough to survive reading a diff |
 *
 * The two ceilings marked *preference* are not measurements and must not be presented as any.
 * "How much of my machine do I want left free while I work" is a question only he can answer;
 * the values here are a defensible default pending his. Everything else in the table is a
 * number this repository measured.
 *
 * ## Environment
 *
 * | variable | default | meaning |
 * |---|---|---|
 * | `TC_WORK_BUDGET` | `on` | `off` disables admission and QoS — loudly |
 * | `TC_OWNER` | `auto` | `away` \| `present` \| `playing` \| `auto` |
 * | `TC_OWNER_IDLE_MS` | `180000` | HID idle before `auto` decides `away` |
 * | `TC_GPU_CEILING` | per-state | override the admission ceiling, in percent |
 * | `TC_QOS` | `on` | `off` leaves running browsers at foreground priority |
 */

import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { gpuUtilisation, coresInUse, memory, owner, setQosTree, coreSplit } from './machine-load.mjs';

export const BUDGET_DIR = process.env.TC_BUDGET_DIR || '/tmp/tc-browser-budget';
const OBS_FILE = path.join(BUDGET_DIR, 'machine.json');
const OBS_LOCK = path.join(BUDGET_DIR, 'machine.lock');
export const OWNER_FLAG = path.join(BUDGET_DIR, 'owner');

/** How long an observation stays usable. Longer than a heartbeat, shorter than a page load. */
const OBS_FRESH_MS = 6_000;
/** After this the observation is not merely stale but suspect, and the lock is broken. */
const OBS_LOCK_MS = 20_000;

export const workBudgetEnabled = () => (process.env.TC_WORK_BUDGET || 'on').toLowerCase() !== 'off';
export const qosEnabled = () => (process.env.TC_QOS || 'on').toLowerCase() !== 'off';

/**
 * The ladder.
 *
 * `cap` is the *most* browsers allowed in this state; the configured cap still applies and the
 * smaller of the two wins, so lowering `node tools/browsers.mjs cap` still works and this can
 * only ever make the machine quieter.
 *
 * `gpuCeiling` is the admission gate: a new browser is refused while measured GPU utilisation
 * is above it. Note that this is measured *including* the applicant's competitors, so it is
 * self-limiting in the right direction — three cheap browsers stay under it and two expensive
 * ones do not, which is the entire point of pricing work rather than counting handles.
 *
 * `qos` is what to do to browsers **already running** when the state is entered.
 */
export const POLICY = {
  away: { cap: 4, gpuCeiling: 92, qos: 'foreground', why: 'nobody is inconvenienced by a hot machine' },
  present: { cap: 2, gpuCeiling: 70, qos: 'foreground', why: 'he wants his terminal and editor responsive' },
  playing: { cap: 1, gpuCeiling: 45, qos: 'background', why: 'the GPU is the thing he needs and agents must yield it' },
};

/** The policy for a state, with `TC_GPU_CEILING` applied if set. */
export const policyFor = (state) => {
  const base = POLICY[state] ?? POLICY.present;
  const override = Number(process.env.TC_GPU_CEILING);
  return Number.isFinite(override) && override > 0 && override <= 100
    ? { ...base, gpuCeiling: override, ceilingFrom: 'TC_GPU_CEILING' }
    : { ...base, ceilingFrom: 'policy' };
};

/** The owner's state, honouring the on-disk flag that `browsers.mjs owner` writes. */
export const ownerState = () => owner({ flagFile: OWNER_FLAG });

/* ────────────────────────── the shared observation ────────────────────────── */

const readObs = () => {
  try {
    const o = JSON.parse(readFileSync(OBS_FILE, 'utf8'));
    o._ageMs = Date.now() - Date.parse(o.at);
    return o;
  } catch { return null; }
};

/**
 * Try to become the observer.
 *
 * Same atomic-link trick the slot semaphore uses, and for the same reason: `open(…, 'wx')`
 * leaves a window in which the file exists and is empty. A lock older than `OBS_LOCK_MS` is
 * broken on sight — an observer that died mid-sample must not stop the machine being measured
 * ever again, and the worst case of breaking it wrongly is two processes sampling at once.
 */
const takeObserverLock = () => {
  mkdirSync(BUDGET_DIR, { recursive: true });
  try {
    if (Date.now() - statSync(OBS_LOCK).mtimeMs > OBS_LOCK_MS) unlinkSync(OBS_LOCK);
  } catch { /* no lock, or someone else just removed it */ }
  const tmp = path.join(BUDGET_DIR, `obs-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    writeFileSync(tmp, `${process.pid}\n`);
    linkSync(tmp, OBS_LOCK);
    return true;
  } catch { return false; }
  finally { try { unlinkSync(tmp); } catch { /* already gone */ } }
};

const releaseObserverLock = () => { try { unlinkSync(OBS_LOCK); } catch { /* already gone */ } };

/**
 * The current machine observation: fresh from the file if somebody measured recently, otherwise
 * measured here and published for everyone else.
 *
 * `force` skips the cache, for the one caller (`browsers.mjs`) whose whole job is to tell the
 * truth about right now.
 */
export const observe = ({ force = false, cpuMs = 1200, gpuSamples = 8 } = {}) => {
  if (!force) {
    const cached = readObs();
    if (cached && cached._ageMs < OBS_FRESH_MS) return { ...cached, cached: true };
  }
  const mine = force || takeObserverLock();
  if (!mine) {
    // Somebody is measuring. Their answer, however stale, beats spending a second duplicating
    // it — this path exists precisely to stop four holders sampling the GPU at once.
    const cached = readObs();
    if (cached) return { ...cached, cached: true, contended: true };
  }
  try {
    const snap = {
      at: new Date().toISOString(),
      by: process.pid,
      cores: coreSplit(),
      gpu: gpuUtilisation({ samples: gpuSamples }),
      cpu: coresInUse(cpuMs),
      memory: memory(),
      owner: ownerState(),
    };
    try { mkdirSync(BUDGET_DIR, { recursive: true }); writeFileSync(OBS_FILE, JSON.stringify(snap)); } catch { /* unwritable */ }
    return { ...snap, _ageMs: 0, cached: false };
  } finally {
    if (mine && !force) releaseObserverLock();
  }
};

/* ─────────────────────────────── admission ─────────────────────────────── */

/**
 * May one more browser start right now?
 *
 * Two independent refusals, reported separately because the fix for each is different:
 *
 *   - `cap` — the ladder says this state allows fewer browsers than are already running. Wait,
 *     or change what the owner is doing. This is a *count* test and it is cheap.
 *   - `gpu` — measured GPU utilisation is above the ceiling. Wait for the machine to quieten.
 *     This is the test the old cap could not express, and the one that catches three browsers
 *     rendering nine thousand men each.
 *
 * `liveCount` is the caller's own count of live slots, passed in rather than recomputed, so
 * that the semaphore and this agree by construction about what "in use" means.
 *
 * **The GPU test is deliberately not applied when nothing is holding a slot.** A machine whose
 * GPU is busy for reasons that have nothing to do with agents — the owner playing, a video
 * call, Xcode — would otherwise refuse the *first* browser forever, and a budget that can
 * deadlock on the owner's own activity is one that gets switched off. With zero holders the
 * ladder alone applies, which still means one browser while he plays and never more.
 */
export const admit = ({ liveCount, snapshot = null, state = null } = {}) => {
  if (!workBudgetEnabled()) return { ok: true, reason: 'work budget disabled (TC_WORK_BUDGET=off)' };
  const snap = snapshot ?? observe();
  const who = state ?? snap.owner?.state ?? 'present';
  const pol = policyFor(who);

  if (liveCount >= pol.cap) {
    return {
      ok: false, why: 'cap', owner: who, policy: pol, snapshot: snap,
      reason: `owner is ${who}, so the cap is ${pol.cap} (${pol.why}); ${liveCount} already running`,
    };
  }
  if (liveCount > 0 && snap.gpu?.available && snap.gpu.mean > pol.gpuCeiling) {
    return {
      ok: false, why: 'gpu', owner: who, policy: pol, snapshot: snap,
      reason: `GPU at ${snap.gpu.mean.toFixed(0)}% (p90 ${snap.gpu.p90}%), ceiling ${pol.gpuCeiling}%`
        + ` while owner is ${who}; ${liveCount} browser(s) already rendering`,
    };
  }
  return { ok: true, owner: who, policy: pol, snapshot: snap, reason: `owner ${who}, cap ${pol.cap}, gpu ok` };
};

/* ──────────────────────────── in-flight throttling ──────────────────────────── */

/**
 * Put this run's browser into, or out of, the background band — and do it idempotently, because
 * this is called from a heartbeat that fires every ten seconds for the life of the run.
 *
 * `taskpolicy -b` is not inherited by children created afterwards, so `setQosTree` re-walks the
 * family every time it is applied. That is one `ps` per transition, not per heartbeat: the
 * `applied` bookkeeping means a run that starts while he is playing and finishes while he is
 * still playing pays for exactly one walk.
 *
 * **What this cannot do.** It de-prioritises; it does not stop. A demoted browser rendering a
 * nine-thousand-man battle still submits work to the GPU, and if it is the *only* thing
 * submitting it will still get all of it. The lever that matters is relative: when the owner's
 * game and a demoted probe both want the GPU, the game wins. That is the whole claim, and
 * `tools/scratch/gpu-bench.mjs` measures it rather than asserting it.
 */
export const makeThrottle = ({ pids = [], label = 'run' } = {}) => {
  let applied = false;
  const targets = new Set(pids.filter((p) => Number.isFinite(p) && p > 1));
  return {
    add(pid) { if (Number.isFinite(pid) && pid > 1) targets.add(pid); },
    get applied() { return applied; },
    /** Reconcile against a state. Returns `'demoted'`, `'restored'` or `null` for no change. */
    reconcile(state) {
      if (!qosEnabled() || !workBudgetEnabled()) return null;
      const want = policyFor(state).qos === 'background';
      if (want === applied) return null;
      let n = 0;
      for (const pid of targets) n += setQosTree(pid, want);
      applied = want;
      if (process.env.TC_BUDGET_VERBOSE === '1') {
        process.stderr.write(`work budget: ${want ? 'demoted' : 'restored'} ${n} process(es) for ${label}`
          + ` — owner is ${state}\n`);
      }
      return want ? 'demoted' : 'restored';
    },
    /** Unconditionally restore, for the exit path. Never leave a process demoted after we die. */
    restore() {
      if (!applied) return;
      for (const pid of targets) setQosTree(pid, false);
      applied = false;
    },
  };
};

/**
 * The PIDs of every `chrome-headless-shell` **browser** process this node process launched.
 *
 * A browser line has no `--type=`; its GPU, network and renderer children do. Only direct
 * children are counted, because a browser launched by a sibling agent is not ours to demote.
 */
export const ourBrowserPids = () => {
  const out = new Set();
  try {
    const ps = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
    for (const line of ps.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m || Number(m[2]) !== process.pid) continue;
      if (/chrome-headless-shell/.test(m[3]) && !/--type=/.test(m[3])) out.add(Number(m[1]));
    }
  } catch { /* ps failed; the caller gets an empty set and skips throttling */ }
  return out;
};

/**
 * Which browser did *this* launch produce?
 *
 * Playwright 1.62 exposes no PID for a locally launched browser — `browser.process()`,
 * `browser._process` and `browser._channel._connection._transport._process` are all undefined,
 * verified on this tree rather than assumed. So the only reliable identification is a
 * before-and-after diff of our own direct children.
 *
 * **This replaces a version that was wrong, and the bench caught it.** The first draft scanned
 * `ps` for the first `chrome-headless-shell` whose parent is us and returned that. With one
 * browser it is right; with two it returns the same PID twice. `tools/scratch/gpu-bench.mjs`
 * runs an "owner" browser and an "agent" browser from one process, asked for the agent to be
 * demoted, and the owner was demoted instead — 88.7 fps to 6.5 fps, and the arm that was
 * supposed to demonstrate the throttle helping demonstrated it hurting. Any harness that opens
 * a second browser would have hit this silently, because a demotion produces no error.
 *
 * `before` is the set captured immediately prior to `type.launch()`. If the diff is not exactly
 * one PID — two launches racing inside one process, or a `ps` that failed — this returns `null`
 * rather than guessing, and the cost is that one run is not throttled.
 */
export const newBrowserPid = (before) => {
  const after = ourBrowserPids();
  const fresh = [...after].filter((p) => !before.has(p));
  return fresh.length === 1 ? fresh[0] : null;
};

/** Human-readable one-liner for a snapshot, shared by every caller that prints one. */
export const describe = (snap) => {
  const g = snap?.gpu?.available ? `gpu ${snap.gpu.mean.toFixed(0)}% (p90 ${snap.gpu.p90}%)` : 'gpu n/a';
  const c = snap?.cpu ? `cpu ${snap.cpu.all.toFixed(1)}/${snap.cores?.total ?? '?'}` : 'cpu n/a';
  return `${g}, ${c}, owner ${snap?.owner?.state ?? '?'}`;
};
