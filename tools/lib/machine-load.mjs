#!/usr/bin/env node
/**
 * What the machine is actually doing, and whether its owner is sitting at it.
 *
 * ## The bug this exists for
 *
 * `tools/lib/browser-budget.mjs` caps the machine at four concurrent headless browsers, and
 * the cap holds. It is still possible — and it has now happened twice — for the owner to
 * report that the machine is laggy while `node tools/browsers.mjs` prints *within budget* and
 * the CPU looks half idle. Measured on 23 Aug 2026 with **one** agent browser rendering the
 * field battle:
 *
 *     load average 6.25 / 16 cores   ← 39%, "idle"
 *     Device Utilization %  62, 94, 100, 26, 46, 99   ← the GPU, pinned
 *
 * There is one GPU. Every headless Chromium here runs `--use-angle=metal` (deliberately: the
 * SwiftShader fallback turns a seconds-long boot into four to six minutes) and therefore
 * queues its draw calls on **the same silicon the owner's game draws on**. A count of browsers
 * is a proxy for CPU, and CPU was never the contended resource. This module measures the
 * contended resource directly.
 *
 * ## The five readings, why each one, and how each can lie
 *
 * | reading | source | lies when |
 * |---|---|---|
 * | GPU utilisation | `ioreg -c IOAccelerator` | it is instantaneous and very noisy — never read one sample |
 * | cores in use | two `ps` samples | a process that exits mid-window is not counted |
 * | memory pressure | `memory_pressure` | free-percentage lags a sudden allocation by seconds |
 * | owner at the keyboard | `IOHIDSystem.HIDIdleTime` | he is reading, not typing → looks away |
 * | owner in a browser | `lsappinfo front` | the game is in a window that is not frontmost |
 *
 * Every one of these is available **without `sudo`**, which is a hard requirement: an
 * admission-control check that prompts for a password is one that gets disabled. `powermetrics`
 * gives better GPU numbers and needs root, so it is not used here.
 *
 * ## Usage
 *
 *     import { machineSnapshot, gpuUtilisation, owner } from './lib/machine-load.mjs';
 *
 *     const snap = machineSnapshot();          // ~1.2 s: GPU averaged, CPU sampled, owner
 *     if (snap.gpu.mean > 60) …
 *
 * `node tools/lib/machine-load.mjs` prints a snapshot, and `--watch` prints one a second,
 * which is the honest way to watch what a probe does to the machine.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import process from 'node:process';

const sh = (cmd, args, ms = 4000) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: ms, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
};

export const CORES = os.cpus().length;

/**
 * Performance and efficiency core counts, because they are not interchangeable.
 *
 * On this M4 Max, 12 P + 4 E. `taskpolicy -b` moves a process to the E cores, so "we demoted
 * four browsers" means their combined ceiling is now four cores, not twelve — and the owner's
 * foreground work keeps the P cores to itself. A rule expressed in "cores" without saying
 * which kind is a rule that means two different things on two machines.
 */
export const coreSplit = () => {
  const n = (k) => { const v = Number(sh('sysctl', ['-n', k]).trim()); return Number.isFinite(v) && v > 0 ? v : null; };
  const p = n('hw.perflevel0.logicalcpu');
  const e = n('hw.perflevel1.logicalcpu');
  return { total: CORES, performance: p ?? CORES, efficiency: e ?? 0, heterogeneous: Boolean(p && e) };
};

/* ───────────────────────────────── the GPU ───────────────────────────────── */

/**
 * One instantaneous read of the Apple GPU's own driver counters.
 *
 * `AGXAcceleratorG16X` publishes `Device Utilization %`, `Renderer Utilization %` and
 * `Tiler Utilization %` in its `PerformanceStatistics` dictionary. These are **not** cumulative
 * counters to be differenced: they are the driver's current estimate, they update several times
 * a second, and six consecutive reads on an idle-looking machine with one browser rendering gave
 * `62, 94, 100, 26, 46, 99`. A single sample is worthless. `gpuUtilisation` below averages.
 *
 * Returns `null` on any machine that has no such node — an Intel Mac, a Linux box, a VM. Every
 * caller must treat `null` as "no GPU signal" and fall back to the CPU rule rather than
 * assuming zero, because assuming zero means assuming infinite headroom.
 */
export const gpuSample = () => {
  const out = sh('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
  if (!out) return null;
  const grab = (key) => {
    const m = out.match(new RegExp(`"${key}"=(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const device = grab('Device Utilization %');
  if (device == null) return null;
  return {
    device,
    renderer: grab('Renderer Utilization %'),
    tiler: grab('Tiler Utilization %'),
    inUseBytes: grab('In use system memory'),
    allocBytes: grab('Alloc system memory'),
  };
};

/**
 * GPU utilisation, averaged over `samples` reads `gapMs` apart.
 *
 * Reports `mean`, `p90` and `max` because they answer different questions. `mean` is "how much
 * of the GPU is gone"; `max` is "did anything get the whole thing"; and `p90` is the one that
 * predicts the owner's experience, because a game that misses one frame in ten is a game that
 * feels broken while its *average* frame time looks fine.
 *
 * Eight samples at 120 ms is just under a second. That is long enough for the mean to settle
 * (the standard error of eight samples of this signal is about 10 points) and short enough that
 * an admission check does not become a thing people skip.
 */
export const gpuUtilisation = ({ samples = 8, gapMs = 120 } = {}) => {
  const reads = [];
  for (let i = 0; i < samples; i++) {
    const s = gpuSample();
    if (s) reads.push(s);
    if (i < samples - 1) sh('sleep', [String(gapMs / 1000)]);
  }
  if (!reads.length) return { available: false, mean: null, p90: null, max: null, samples: 0 };
  const dev = reads.map((r) => r.device).sort((a, b) => a - b);
  const mean = dev.reduce((a, b) => a + b, 0) / dev.length;
  return {
    available: true,
    mean,
    p90: dev[Math.min(dev.length - 1, Math.floor(dev.length * 0.9))],
    max: dev[dev.length - 1],
    min: dev[0],
    renderer: reads.at(-1).renderer,
    tiler: reads.at(-1).tiler,
    inUseMB: reads.at(-1).inUseBytes != null ? Math.round(reads.at(-1).inUseBytes / 1e6) : null,
    samples: reads.length,
  };
};

/* ───────────────────────────────── the CPU ───────────────────────────────── */

/**
 * `ps -o time` on Darwin is `[DD-][HH:]MM:SS.ss`.
 *
 * Lifted verbatim from `tools/browsers.mjs`, which learned the hard way: a parser that reads it
 * as `HH:MM:SS` drops the fractional seconds, quantises every process to a delta of zero over a
 * two-second window, and reports "0.0 cores in use" while the load average sits at 8.
 */
export const parseCpuTime = (t) => {
  const [days, rest] = t.includes('-') ? t.split('-') : ['0', t];
  let secs = 0;
  for (const p of rest.split(':').map(Number)) secs = secs * 60 + p;
  return secs + Number(days) * 86400;
};

const cpuSample = () => {
  const byPid = new Map();
  for (const line of sh('ps', ['-A', '-o', 'pid=,time=,command=']).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m || !/^[\d:.-]+$/.test(m[2])) continue;
    byPid.set(Number(m[1]), { secs: parseCpuTime(m[2]), cmd: m[3] });
  }
  return { byPid, t: Date.now() };
};

/**
 * Cores actually in use, split by who is using them.
 *
 * Per-PID deltas over processes present in **both** samples. Summing the machine total and
 * subtracting is the obvious spelling and is wrong: a browser closing inside the window takes
 * its whole accumulated CPU time out of the total and the machine appears to have used minus
 * eighty-four cores. That number is real; it is what the first draft of `browsers.mjs` printed.
 */
export const coresInUse = (ms = 1500) => {
  const a = cpuSample();
  sh('sleep', [String(ms / 1000)]);
  const b = cpuSample();
  const dt = (b.t - a.t) / 1000;
  let all = 0; let chrome = 0; let vite = 0; let node = 0;
  for (const [pid, cur] of b.byPid) {
    const prev = a.byPid.get(pid);
    const d = cur.secs - (prev ? prev.secs : cur.secs);
    if (d <= 0) continue;
    all += d;
    if (/chrome-headless-shell|Chromium Helper/.test(cur.cmd)) chrome += d;
    else if (/vite-runner\.mjs|bin\/vite|npm exec vite/.test(cur.cmd)) vite += d;
    else if (/\bnode\b/.test(cur.cmd)) node += d;
  }
  return { all: all / dt, chrome: chrome / dt, vite: vite / dt, node: node / dt, windowMs: b.t - a.t };
};

/* ─────────────────────────────── memory ─────────────────────────────── */

/**
 * Memory pressure, which the owner feels harder than CPU.
 *
 * Ninety-four worktrees at 28 GB is disk, not RAM, and does not matter here — but six headless
 * Chromiums each holding a 9,000-man scene do, and once this machine swaps, every application
 * on it stutters regardless of how much CPU is free. `memory_pressure` reports a free
 * percentage; `vm_stat`'s compressor page count is the earlier warning, because macOS compresses
 * before it swaps.
 */
export const memory = () => {
  const mp = sh('memory_pressure');
  const freePct = Number(mp.match(/free percentage:\s*(\d+)/)?.[1] ?? NaN);
  const vm = sh('vm_stat');
  const pageSize = Number(vm.match(/page size of (\d+)/)?.[1] ?? 16384);
  const pages = (k) => Number(vm.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] ?? 0);
  const compressedMB = Math.round((pages('Pages occupied by compressor') * pageSize) / 1e6);
  const swapouts = pages('Swapouts');
  return {
    totalGB: Math.round(os.totalmem() / 1e9),
    freePct: Number.isFinite(freePct) ? freePct : null,
    compressedMB,
    swapouts,
    // Swapping at all is the state to avoid; it is what "the machine feels slow" usually is.
    swapping: swapouts > 0,
  };
};

/* ─────────────────────────────── the owner ─────────────────────────────── */

export const OWNER_IDLE_MS = Number(process.env.TC_OWNER_IDLE_MS || 180_000);

/**
 * Nanoseconds since the last human input event of any kind.
 *
 * `IOHIDSystem.HIDIdleTime` is maintained by the window server and resets on any key, click,
 * trackpad or tablet event. It is the only presence signal on macOS that needs no entitlement,
 * no accessibility permission and no root, and it increments in real time — three reads two
 * seconds apart gave 307.7 s, 309.8 s, 311.9 s.
 *
 * **How it is wrong.** It says *input*, not *attention*. Watching a replay, reading a diff or
 * being on a call all look identical to being out of the building. That error is one-sided in
 * the dangerous direction — it under-reports presence — so `ownerPresent()` uses a generous
 * three-minute window and the explicit flag always wins.
 *
 * It cannot be spoofed *upward* by anything here: headless Chromium synthesises input inside
 * its own renderer and never touches the HID stack, so no agent can make itself look like a
 * person. That asymmetry is the reason to trust it.
 */
export const hidIdleMs = () => {
  const out = sh('ioreg', ['-c', 'IOHIDSystem', '-r', '-d', '1', '-w', '0']);
  const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  return m ? Number(m[1]) / 1e6 : null;
};

/**
 * Is the screen locked?
 *
 * `CGSSessionScreenIsLocked` in the console-user dictionary is a yes/no fact rather than an
 * inference, and it is the one presence signal with **no false positives at all**: a locked
 * screen means nobody is looking at this machine, full stop. It also fires *instantly* when he
 * walks away, where `HIDIdleTime` needs the full three-minute window to agree.
 *
 * Returns `null` when the key cannot be read, which must not be confused with `false`.
 */
export const screenLocked = () => {
  const out = sh('ioreg', ['-n', 'Root', '-d', '1', '-w', '0']);
  const m = out.match(/"CGSSessionScreenIsLocked"\s*=\s*(Yes|No)/);
  return m ? m[1] === 'Yes' : null;
};

/** The frontmost application's display name, or `null` if it cannot be read. */
export const frontApp = () => {
  const asn = sh('lsappinfo', ['front']).trim();
  if (!asn) return null;
  const name = sh('lsappinfo', ['info', '-only', 'name', asn]).match(/"LSDisplayName"="([^"]*)"/)?.[1];
  return name || null;
};

/** Applications through which this game can be played. Frontmost + present ⇒ assume playing. */
const BROWSER_APPS = /^(Google Chrome|Chromium|Safari|Safari Technology Preview|Firefox|Arc|Brave Browser|Microsoft Edge|Orion)$/;

/**
 * Is the owner at the machine, and is he plausibly playing?
 *
 * Three states, and the reason there are three rather than two is that they want different
 * things from the budget:
 *
 *   - `away`     — nobody is inconvenienced by a hot machine. Run the full cap.
 *   - `present`  — he is working: editing, reading, running a build. He wants latency in his
 *                  terminal and his editor, which is a CPU and memory ask, not a GPU one.
 *   - `playing`  — he is in a browser and the GPU is the thing he needs. This is the state both
 *                  lag reports came from, and it is the one that has to yield hardest.
 *
 * `TC_OWNER` overrides everything: `away`, `present`, `playing`, or `auto` (the default). The
 * override exists because detection is a guess and his own statement is not.
 */
export const owner = ({ flagFile = null } = {}) => {
  let forced = process.env.TC_OWNER?.trim().toLowerCase();
  let from = forced ? 'TC_OWNER' : null;
  if (!forced && flagFile) {
    try {
      const v = readFileSync(flagFile, 'utf8').trim().toLowerCase();
      if (v) { forced = v; from = flagFile; }
    } catch { /* no flag set */ }
  }
  if (forced && forced !== 'auto') {
    if (!['away', 'present', 'playing'].includes(forced)) {
      throw new Error(`TC_OWNER must be away, present, playing or auto; got ${JSON.stringify(forced)}`);
    }
    return { state: forced, from, idleMs: hidIdleMs(), app: frontApp(), detected: null };
  }

  const locked = screenLocked();
  const idleMs = hidIdleMs();
  const app = frontApp();
  // Order matters. A locked screen is a fact and settles it immediately; only then is the
  // inference from idle time and the frontmost app worth making.
  //
  // No HID signal at all (a headless box, a VM) is treated as `present`: the safe direction is
  // to assume somebody is there, because the cost of being wrong is a slightly slower gate and
  // the cost of the other error is the thing this whole file exists to prevent.
  const detected = locked === true ? 'away'
    : idleMs == null ? 'present'
      : idleMs > OWNER_IDLE_MS ? 'away'
        : (app && BROWSER_APPS.test(app)) ? 'playing' : 'present';
  return { state: detected, from: 'auto', idleMs, app, locked, detected };
};

/* ─────────────────────────────── the snapshot ─────────────────────────────── */

/**
 * Everything at once, in about a second and a quarter.
 *
 * `sampleMs` is the CPU window; the GPU average runs first and takes roughly `8 × 120 ms`. The
 * two are deliberately *not* concurrent — `execFileSync` is synchronous throughout so that this
 * can be called from anywhere, including the middle of a lock acquisition, without an `await`.
 */
export const machineSnapshot = ({ cpuMs = 1500, gpuSamples = 8, flagFile = null } = {}) => ({
  at: new Date().toISOString(),
  cores: coreSplit(),
  gpu: gpuUtilisation({ samples: gpuSamples }),
  cpu: coresInUse(cpuMs),
  load: os.loadavg(),
  memory: memory(),
  owner: owner({ flagFile }),
});

/* ─────────────────────────────── QoS demotion ─────────────────────────────── */

/**
 * Push a process into the background QoS band, or pull it back out.
 *
 * `taskpolicy -b -p <pid>` is Darwin's own throttling primitive and it needs no privileges for
 * a process you own. It does four things at once, and all four are what this wants:
 *
 *   1. moves the process to the **efficiency cores** — on this M4 Max that is a hard ceiling of
 *      4 cores for everything demoted, instead of 16;
 *   2. drops its I/O priority to throttled;
 *   3. drops its timer coalescing to the background tier;
 *   4. **de-prioritises its GPU work** — the window server services foreground submissions
 *      first, which is exactly the lever the GPU contention needs and the one no amount of
 *      `nice` would have given.
 *
 * `-B` restores. Both are idempotent and both fail silently for a PID that has exited, which is
 * the common case by the time a run finishes.
 *
 * **What it cannot do**: it does not apply to children spawned later, so a browser demoted
 * before it opens its renderer keeps a foreground renderer. `demoteTree` walks `ps` and demotes
 * the whole family, and callers re-run it after opening pages.
 */
export const setQos = (pid, background) => {
  if (!Number.isFinite(pid) || pid <= 1) return false;
  try {
    execFileSync('taskpolicy', [background ? '-b' : '-B', '-p', String(pid)], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch { return false; }
};

/** Every descendant of `root`, `root` included, youngest last. */
export const processTree = (root) => {
  const kids = new Map();
  for (const line of sh('ps', ['-A', '-o', 'pid=,ppid=']).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)/);
    if (!m) continue;
    const [pid, ppid] = [Number(m[1]), Number(m[2])];
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const out = []; const seen = new Set(); const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const k of kids.get(pid) ?? []) stack.push(k);
  }
  return out;
};

/** Demote or restore a whole process family. Returns how many calls succeeded. */
export const setQosTree = (root, background) => {
  let n = 0;
  for (const pid of processTree(root)) if (setQos(pid, background)) n++;
  return n;
};

/* ─────────────────────────────────── CLI ─────────────────────────────────── */

if (import.meta.url === `file://${process.argv[1]}`) {
  const watch = process.argv.includes('--watch');
  const json = process.argv.includes('--json');
  const once = () => {
    const s = machineSnapshot({ cpuMs: watch ? 800 : 1500, gpuSamples: watch ? 4 : 8 });
    if (json) { console.log(JSON.stringify(s)); return; }
    const g = s.gpu.available ? `${s.gpu.mean.toFixed(0)}% (p90 ${s.gpu.p90}, max ${s.gpu.max})` : 'unavailable';
    console.log(
      `gpu ${g.padEnd(28)} cpu ${s.cpu.all.toFixed(1)}/${s.cores.total} cores `
      + `(chromium ${s.cpu.chrome.toFixed(1)})  mem ${s.memory.freePct}% free`
      + `${s.memory.swapping ? ' SWAPPING' : ''}  owner ${s.owner.state}`
      + `${s.owner.idleMs != null ? ` (idle ${(s.owner.idleMs / 1000).toFixed(0)}s, front ${s.owner.app ?? '?'})` : ''}`
    );
  };
  if (!watch) once();
  else for (;;) once();
}
