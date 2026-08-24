#!/usr/bin/env node
/**
 * What is running, who owns it, and what is stale.
 *
 * ## Why this exists
 *
 * On 22 August 2026 this machine reached load average 160 on 16 cores with 136 concurrent
 * `vite` and `chrome-headless-shell` processes and had to be recovered by hand. The first
 * question in that state is "what is running", and answering it took three greps and a wrong
 * kill — an agent shot a dev server on port 5901 that belonged to a different agent.
 *
 * This is the one command that answers it. It is deliberately read-only by default: `status`
 * kills nothing, `reap` only removes lock records whose holder is provably gone, and `sweep`
 * refuses to kill anything at all unless you pass `--force`.
 *
 * ## Commands
 *
 *     node tools/browsers.mjs                 status (the default)
 *     node tools/browsers.mjs status --json   the same, machine-readable
 *     node tools/browsers.mjs machine         **everything**: browsers, servers, worktrees, disk
 *     node tools/browsers.mjs machine --no-disk   …without the worktree scan, which is the slow bit
 *     node tools/browsers.mjs owner           what the machine thinks the owner is doing
 *     node tools/browsers.mjs owner playing   tell it, rather than letting it guess
 *     node tools/browsers.mjs owner auto      go back to detecting
 *     node tools/browsers.mjs reap            drop lock records whose holder is dead
 *     node tools/browsers.mjs sweep           list servers and browsers nobody owns
 *     node tools/browsers.mjs sweep --force   …and kill them
 *     node tools/browsers.mjs cap             print the machine-wide cap and where it came from
 *     node tools/browsers.mjs cap 6           set it, for every agent, until it is set again
 *
 * ## `machine` is the one to run first
 *
 * `status` answers "who holds a browser slot". That was the right question on 22 August and it
 * is half the question now: on 23 August the owner reported lag with **one** agent browser
 * running, load average 6.25 of 16 cores, and the GPU pinned at 62–100 %. `machine` prints the
 * GPU, what the owner is doing, the memory, the disk, and how much of the 28 GB of worktrees is
 * reclaimable and why — one screen, no greps, and it changes nothing.
 *
 * ## Two counts, and they are not the same number
 *
 * One headless Chromium is **six or seven OS processes** — a browser process, a GPU process,
 * a couple of utility processes and a renderer per page. `ps | grep -c chrome-headless-shell`
 * returning 136 is not 136 browsers; it is roughly twenty. This prints both, because the cap
 * counts browsers and `ps` counts processes, and confusing them is how you conclude the cap
 * is not working.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  BUDGET_DIR, budgetCap, budgetEnabled, capSource, listSlots, listWaiters, paths, reapStale,
} from './lib/browser-budget.mjs';
import {
  OWNER_FLAG, POLICY, observe, ownerState, policyFor, qosEnabled, workBudgetEnabled,
} from './lib/work-budget.mjs';

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) ?? 'status';
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const JSON_OUT = flags.has('--json');

const CORES = os.cpus().length;
const ps = (fmt) => {
  try { return execFileSync('ps', ['-A', '-o', fmt], { encoding: 'utf8', maxBuffer: 64 << 20 }); }
  catch { return ''; }
};

const dur = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return '?';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

/**
 * Total CPU actually in use, in cores.
 *
 * The load average is an exponentially-weighted mean with a sixty-second time constant, so it
 * lags a headless run badly and is useless for "is the machine busy right now". Two samples of
 * the summed CPU-time of every process, two seconds apart, divided by the elapsed wall clock,
 * is exact and immediate.
 */
/**
 * `ps -o time` on Darwin is `[DD-][HH:]MM:SS.ss` — minutes and *fractional* seconds for almost
 * everything on the machine. The first parser here read it as `HH:MM:SS`, dropped the
 * fraction, and therefore reported whole seconds only; over a two-second sampling window that
 * quantised nearly every process to a delta of zero and the tool cheerfully printed
 * "0.0 cores actually in use" while the load average sat at 8.
 */
const parseCpuTime = (t) => {
  const [days, rest] = t.includes('-') ? t.split('-') : ['0', t];
  let secs = 0;
  for (const p of rest.split(':').map(Number)) secs = secs * 60 + p;
  return secs + Number(days) * 86400;
};

const cpuSample = () => {
  const byPid = new Map();
  for (const line of ps('pid=,time=,command=').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m || !/^[\d:.-]+$/.test(m[2])) continue;
    byPid.set(Number(m[1]), { secs: parseCpuTime(m[2]), cmd: m[3] });
  }
  return { byPid, t: Date.now() };
};

/**
 * Sum the deltas **per PID, over processes present in both samples**.
 *
 * Summing the whole machine's CPU time and subtracting is the obvious version and it is wrong:
 * a process that exits between the two samples takes its accumulated CPU time out of the
 * total, so a browser closing during the window makes the machine appear to have used minus
 * eighty-four cores. Measured, in this file's first draft: `cores=-84.48`.
 */
const coresInUse = (ms = 2000) => {
  const a = cpuSample();
  execFileSync('sleep', [String(ms / 1000)]);
  const b = cpuSample();
  const dt = (b.t - a.t) / 1000;
  let all = 0; let chrome = 0; let vite = 0;
  for (const [pid, cur] of b.byPid) {
    const prev = a.byPid.get(pid);
    // A PID that appeared during the window is counted from zero, which under-counts its
    // startup burst slightly and is the safe direction for a "how busy is it" reading.
    const d = cur.secs - (prev ? prev.secs : cur.secs);
    if (d <= 0) continue;
    all += d;
    if (/chrome-headless-shell|Chromium Helper/.test(cur.cmd)) chrome += d;
    if (/vite-runner\.mjs|bin\/vite|npm exec vite/.test(cur.cmd)) vite += d;
  }
  return { all: all / dt, chrome: chrome / dt, vite: vite / dt };
};

/**
 * The processes, as the machine sees them.
 *
 * A `chrome-headless-shell` line **without** `--type=` is a browser; one with it is a child of
 * a browser. That distinction is the whole reason this function exists.
 */
const scanProcesses = () => {
  const browsers = []; const children = []; const vites = []; const guards = [];
  for (const line of ps('pid=,ppid=,etime=,command=').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, etime, command] = m;
    const rec = { pid: Number(pid), ppid: Number(ppid), etime, command };
    if (/chrome-headless-shell/.test(command)) {
      (/--type=/.test(command) ? children : browsers).push(rec);
    } else if (/spawn-guard\.mjs/.test(command)) {
      /*
       * A guard's command line contains the command it supervises, so `node spawn-guard.mjs …
       * -- node vite-runner.mjs --port=5947` matches every Vite pattern below. Counted as a Vite
       * server it makes one server look like two — measured on the first run of the supervisor,
       * `vite 2` where there was one. Classify the guard first and continue.
       */
      guards.push({ ...rec, pgid: null });
    } else if (/vite-runner\.mjs|node_modules\/\.bin\/vite|bin\/vite\.js|npm exec vite/.test(command)) {
      const p = command.match(/--port[= ](\d+)/);
      vites.push({
        ...rec,
        port: p ? Number(p[1]) : null,
        style: /vite-runner\.mjs/.test(command) ? 'runner' : 'npx',
        /*
         * `npm exec vite …` is the wrapper; `node …/.bin/vite …` two processes below it is the
         * one holding the port. Counting both is how a `ps | grep -c` turns twenty servers into
         * forty and makes the problem look twice its size — and the wrapper is precisely the
         * thing SIGTERM hits while the server survives, so the pair has to be told apart.
         */
        wrapper: /npm exec vite/.test(command),
      });
    }
  }
  // One logical server per port: prefer the process that is actually listening.
  const byPort = new Map();
  for (const v of vites) {
    const key = v.port ?? `pid${v.pid}`;
    const prev = byPort.get(key);
    if (!prev || (prev.wrapper && !v.wrapper)) byPort.set(key, v);
  }
  return { browsers, children, vites: [...byPort.values()], viteProcs: vites, guards };
};

/**
 * Which rasteriser the running browsers actually got.
 *
 * This must read the **value of `--use-angle`** and nothing else. The first version of it
 * grepped the GPU process's command line for `swiftshader` and reported every healthy
 * Metal-backed browser on this machine as software-rasterising, because
 * `--enable-unsafe-swiftshader` is on that command line too — and that flag is a *permission*
 * to fall back, not a statement that anything fell back. An instrument that reports a fault
 * on a working configuration is worse than no instrument.
 *
 *   ps -A -o command | grep 'type=gpu-process'
 *
 * is the manual version, and `--use-angle=swiftshader-webgl` in the output is the real tell.
 */
const gpuBackend = () => {
  const lines = ps('command=').split('\n')
    .filter((l) => /chrome-headless-shell/.test(l) && /--type=gpu-process/.test(l));
  let sw = 0; let metal = 0; let unknown = 0;
  for (const l of lines) {
    const m = l.match(/--use-angle=(\S+)/);
    if (!m) unknown++;
    else if (/swiftshader/i.test(m[1])) sw++;
    else if (/metal/i.test(m[1])) metal++;
    else unknown++;
  }
  return { procs: lines.length, swiftshader: sw, metal, unknown };
};

/* ─────────────────────────────────── cap ─────────────────────────────────── */

if (cmd === 'cap') {
  const n = argv.find((a) => /^\d+$/.test(a));
  if (n) {
    mkdirSync(BUDGET_DIR, { recursive: true });
    writeFileSync(paths.CAP_FILE, `${Number(n)}\n`);
    console.log(`machine-wide cap set to ${n} (${paths.CAP_FILE}).`);
    console.log('Every agent that starts a browser from now on reads this. Runs already holding');
    console.log('a slot are unaffected, so lowering it takes effect as they finish.');
  } else {
    const { cap, from } = capSource();
    console.log(`cap ${cap}  (from ${from})`);
    console.log(`  TC_MAX_BROWSERS beats ${paths.CAP_FILE}, which beats the default.`);
  }
  process.exit(0);
}

/* ─────────────────────────────────── owner ─────────────────────────────────── */

/**
 * What the machine believes the owner is doing, and how to tell it otherwise.
 *
 * Detection is a guess made from three signals — a locked screen (a fact, no false positives),
 * `HIDIdleTime` (says *input*, not attention: reading a diff looks like leaving the building),
 * and the frontmost application. His own statement is not a guess, so the flag beats all of it,
 * and it is written where every agent on the machine reads it rather than into one shell.
 */
if (cmd === 'owner') {
  const want = argv.find((a) => /^(away|present|playing|auto)$/.test(a));
  if (want) {
    mkdirSync(BUDGET_DIR, { recursive: true });
    writeFileSync(OWNER_FLAG, `${want}\n`);
    const pol = policyFor(want === 'auto' ? ownerState().state : want);
    console.log(`owner set to ${want} (${OWNER_FLAG}).`);
    if (want === 'auto') console.log('  Back to detection: locked screen, then HID idle time, then the frontmost app.');
    else console.log(`  Every agent that starts a browser from now on sees this: cap ${pol.cap}, GPU ceiling ${pol.gpuCeiling}%.`);
    console.log('  Runs already holding a slot pick it up on their next heartbeat, within 10 s,');
    console.log(`  and ${pol.qos === 'background' ? 'move to the background band' : 'return to normal priority'}.`);
    process.exit(0);
  }
  const st = ownerState();
  const pol = policyFor(st.state);
  console.log(`owner: ${st.state}   (from ${st.from})`);
  if (st.from === 'auto') {
    console.log(`  screen locked   ${st.locked === null ? 'unreadable' : st.locked ? 'yes — nobody is looking at this machine' : 'no'}`);
    console.log(`  last input      ${st.idleMs == null ? 'unreadable' : `${(st.idleMs / 1000).toFixed(0)}s ago`}`
      + `  (over ${(Number(process.env.TC_OWNER_IDLE_MS || 180000) / 1000).toFixed(0)}s means away)`);
    console.log(`  frontmost app   ${st.app ?? 'unreadable'}`);
  }
  console.log(`\npolicy while ${st.state}: at most ${pol.cap} browser(s), GPU ceiling ${pol.gpuCeiling}%, `
    + `running work ${pol.qos === 'background' ? 'demoted to the efficiency cores' : 'at normal priority'}`);
  console.log(`  because ${pol.why}`);
  console.log('\nthe whole ladder:');
  for (const [k, v] of Object.entries(POLICY)) {
    console.log(`  ${k.padEnd(8)} cap ${v.cap}  gpu <= ${String(v.gpuCeiling).padStart(3)}%  ${v.qos.padEnd(10)}  ${v.why}`);
  }
  console.log('\n  set it:  node tools/browsers.mjs owner playing|present|away|auto');
  console.log('  one run: TC_OWNER=away <command>');
  process.exit(0);
}

/* ────────────────────────────────── machine ────────────────────────────────── */

/**
 * Everything, on one screen, changing nothing.
 *
 * The 22 August recovery needed "what is running". The 23 August lag report needed "what is
 * *contended*", and those turned out to be different questions with different answers: one
 * browser, 39 % of the CPU, and a GPU at 100 %. This prints both, plus the disk, because the
 * third question nobody had a command for was "why is there 28 GB of worktrees on here".
 *
 * The worktree section shells out to `tools/reclaim.mjs --json --sizes` rather than
 * reimplementing its rule. There must be exactly one definition of what is safe to delete, and
 * a second copy of it in a status command is the way that stops being true.
 */
if (cmd === 'machine') {
  const snap = observe({ force: true });
  const pol = policyFor(snap.owner.state);
  const procs = scanProcesses();
  const gpuBack = gpuBackend();
  reapStale();
  const live = listSlots().filter((s) => !s.stale);
  const { cap, from } = capSource();

  let reclaim = null;
  if (!flags.has('--no-disk')) {
    try {
      reclaim = JSON.parse(execFileSync(process.execPath,
        [path.join(paths.TOOLS_DIR, 'reclaim.mjs'), '--json', '--sizes', '--quiet'],
        { cwd: paths.REPO_ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 128 << 20 }));
    } catch { /* reclaim is advisory here; a failure must not take down status */ }
  }

  let df = null;
  try {
    const out = execFileSync('df', ['-g', '/'], { encoding: 'utf8' }).split('\n')[1].split(/\s+/);
    df = { totalGB: Number(out[1]), freeGB: Number(out[3]) };
  } catch { /* no df */ }

  if (JSON_OUT) {
    console.log(JSON.stringify({ machine: snap, policy: pol, cap, capFrom: from,
      slots: live.length, browsers: procs.browsers.length, viteServers: procs.vites.length,
      gpuBackend: gpuBack, disk: df, reclaim: reclaim?.summary ?? null }, null, 2));
    process.exit(0);
  }

  const bar2 = (n, max, width = 24) => {
    const f = Math.max(0, Math.min(width, Math.round((n / max) * width)));
    return `[${'#'.repeat(f)}${'.'.repeat(width - f)}]`;
  };
  const gb = (n) => (n == null ? '?' : n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);

  console.log(`machine — ${snap.cores.total} cores (${snap.cores.performance}P + ${snap.cores.efficiency}E), `
    + `${snap.memory.totalGB} GB\n`);

  const o = snap.owner;
  console.log(`owner        ${o.state.toUpperCase()}   (${o.from === 'auto'
    ? `detected: screen ${o.locked ? 'locked' : 'unlocked'}, last input ${o.idleMs == null ? '?' : `${(o.idleMs / 1000).toFixed(0)}s`} ago, front ${o.app ?? '?'}`
    : `set in ${o.from}`})`);
  console.log(`             policy: at most ${pol.cap} browser(s), GPU ceiling ${pol.gpuCeiling}%, `
    + `running work ${pol.qos === 'background' ? 'DEMOTED' : 'at normal priority'}`);
  if (!workBudgetEnabled()) console.log('             !! TC_WORK_BUDGET=off in THIS shell — no admission control, no demotion.');
  else if (!qosEnabled()) console.log('             !! TC_QOS=off in THIS shell — running browsers are not demoted.');

  console.log('');
  if (snap.gpu.available) {
    const over = snap.gpu.mean > pol.gpuCeiling;
    console.log(`gpu          ${snap.gpu.mean.toFixed(0)}% mean, p90 ${snap.gpu.p90}%, max ${snap.gpu.max}%  ${bar2(snap.gpu.mean, 100)}`
      + `${over ? '  ← OVER the ceiling; new browsers are refused' : ''}`);
    console.log(`             renderer ${snap.gpu.renderer}%, tiler ${snap.gpu.tiler}%, ${snap.gpu.inUseMB} MB in use`);
    console.log('             This is the contended resource. A count of browsers does not price it.');
  } else {
    console.log('gpu          unavailable on this machine — the ladder still applies, the ceiling does not');
  }
  console.log(`cpu          ${snap.cpu.all.toFixed(1)} of ${snap.cores.total} cores  ${bar2(snap.cpu.all, snap.cores.total)}`);
  console.log(`             chromium ${snap.cpu.chrome.toFixed(1)}, vite ${snap.cpu.vite.toFixed(1)}, other node ${snap.cpu.node.toFixed(1)}`
    + `; load ${os.loadavg().map((l) => l.toFixed(1)).join(' / ')}`);
  console.log(`memory       ${snap.memory.freePct}% free of ${snap.memory.totalGB} GB`
    + `${snap.memory.compressedMB ? `, ${gb(snap.memory.compressedMB)} compressed` : ''}`
    + `${snap.memory.swapping ? '   !! SWAPPING — this is felt harder than any CPU number' : ''}`);
  if (df) console.log(`disk         ${df.freeGB} GB free of ${df.totalGB} GB`);

  console.log('');
  console.log(`browsers     ${live.length} slot(s) held of ${cap} configured (from ${from}); `
    + `${procs.browsers.length} running = ${procs.browsers.length + procs.children.length} OS processes`);
  for (const s of live) {
    console.log(`             slot ${s.slot}: ${(s.rec?.label ?? '?').slice(0, 22).padEnd(22)} pid ${String(s.rec?.pid ?? '?').padEnd(7)}`
      + ` ${String(s.rec?.port ?? '—').padEnd(5)} held ${dur(s.heldMs).padEnd(8)} ${s.rec?.root ? path.basename(s.rec.root) : '?'}`);
  }
  const unbudgeted = procs.browsers.length - live.length;
  if (unbudgeted > 0) console.log(`             !! ${unbudgeted} browser(s) hold no slot — an unconverted tool, or TC_BROWSER_BUDGET=off`);
  if (gpuBack.swiftshader) console.log(`             !! ${gpuBack.swiftshader} GPU process(es) on swiftshader, not metal — a boot goes from seconds to minutes`);

  console.log(`servers      ${procs.vites.length} vite (${procs.vites.filter((v) => v.style === 'runner').length} runner, `
    + `${procs.vites.filter((v) => v.style === 'npx').length} npx)`);
  if (reclaim) {
    const orph = reclaim.servers?.filter((x) => x.verdict === 'reclaimable') ?? [];
    if (orph.length) console.log(`             !! ${orph.length} unowned: ${orph.map((x) => `pid ${x.pid} port ${x.port} up ${x.etime}`).join('; ')}`);
  }

  console.log('');
  if (!reclaim) {
    console.log(flags.has('--no-disk')
      ? 'worktrees    (skipped by --no-disk; the worktree scan is the slow part of this command)'
      : 'worktrees    (tools/reclaim.mjs did not answer — run it directly for the reason)');
  } else {
    const wt = reclaim.worktrees ?? [];
    const onDisk = wt.filter((w) => w.exists);
    const recl = wt.filter((w) => w.verdict === 'reclaimable');
    const prot = wt.filter((w) => w.verdict === 'protected');
    const staleMeta = wt.filter((w) => w.verdict === 'stale-metadata');
    console.log(`worktrees    ${wt.length} registered, ${onDisk.length} on disk`
      + `${staleMeta.length ? `, ${staleMeta.length} registrations whose directory is gone` : ''}`);
    console.log(`             ${recl.length} reclaimable (${gb(reclaim.summary.reclaimableMB)}) — clean, every commit pushed, `
      + `merged, idle, nothing using them`);
    const byReason = new Map();
    for (const w of prot) for (const x of w.protections) byReason.set(x.test, (byReason.get(x.test) ?? 0) + 1);
    console.log(`             ${prot.length} protected: ${[...byReason].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ')}`);
    const unpushed = prot.filter((w) => w.protections.some((x) => x.test === 'unpushed'));
    if (unpushed.length) {
      console.log(`             !! ${unpushed.length} hold ${unpushed.reduce((a, b) => a + (b.unpushed ?? 0), 0)} commits that exist on no remote.`);
      console.log(`                ${unpushed.sort((a, b) => b.unpushed - a.unpushed).slice(0, 4)
        .map((w) => `${path.basename(w.path)} (${w.unpushed})`).join(', ')}${unpushed.length > 4 ? ' …' : ''}`);
      console.log('                Push them. Nothing here will ever delete one, but nothing protects them');
      console.log('                from a crash either — that is how a day of work was lost once.');
    }
    const scr = (reclaim.scratch ?? []).filter((x) => x.verdict === 'reclaimable');
    if (scr.length) console.log(`scratch      ${scr.length} /tmp/tc-* trees reclaimable (${gb(scr.reduce((a, b) => a + (b.sizeMB ?? 0), 0))})`);
  }

  console.log('');
  console.log('  what the owner is doing:  node tools/browsers.mjs owner [playing|present|away|auto]');
  console.log('  what would be reclaimed:  node tools/reclaim.mjs');
  console.log('  do it:                    node tools/reclaim.mjs --apply');
  process.exit(0);
}

/* ─────────────────────────────────── reap ─────────────────────────────────── */

if (cmd === 'reap') {
  const gone = reapStale();
  if (!gone.length) { console.log('nothing stale.'); process.exit(0); }
  for (const g of gone) {
    console.log(`reaped ${path.basename(g.file)} — ${g.why} — ${g.rec?.label ?? '?'} `
      + `pid ${g.rec?.pid ?? '?'}${g.rec?.port ? ` port ${g.rec.port}` : ''}`);
  }
  console.log(`\n${gone.length} released. Reasons: reboot = held from before the last boot, `
    + 'no-pid = the process is gone, silent = no heartbeat for 90 s.');
  process.exit(0);
}

/* ────────────────────────────────── sweep ────────────────────────────────── */

if (cmd === 'sweep') {
  const force = flags.has('--force');
  reapStale();
  const live = listSlots().filter((s) => !s.stale);
  const ownedPorts = new Set(live.map((s) => s.rec?.port).filter(Boolean));
  const ownedVitePids = new Set(live.map((s) => s.rec?.vitePid).filter(Boolean));
  const { vites, browsers } = scanProcesses();

  /*
   * What this will and will not touch.
   *
   * **Never 5173.** That is the owner's playtest server and killing it is the single worst
   * thing this command could do. It is excluded by port and it is excluded again by the fact
   * that it has no `--port` argument at all when started by `npm run dev`, so an unattributable
   * Vite is left alone rather than guessed at.
   *
   * Everything else has to be positively identified as unowned: a Vite whose port belongs to a
   * live slot is somebody's, and so is one whose PID a live slot recorded.
   */
  const orphans = vites.filter((v) => {
    if (v.port === 5173 || v.port === null) return false;
    if (ownedPorts.has(v.port) || ownedVitePids.has(v.pid)) return false;
    return true;
  });

  console.log(`${live.length} live slot(s); ${vites.length} vite server(s) running; `
    + `${browsers.length} browser(s).\n`);
  if (!orphans.length) {
    console.log('No unowned dev servers. (Servers on 5173, or with no --port, are never touched.)');
  } else {
    console.log(`${orphans.length} dev server(s) that no live slot claims:\n`);
    for (const o of orphans) {
      console.log(`  pid ${o.pid} port ${o.port} up ${o.etime} ${o.style === 'npx' ? '[npx-style — the orphan mechanism]' : '[runner]'}`);
      console.log(`      ${o.command.slice(0, 150)}`);
    }
    if (!force) {
      console.log('\nNothing killed. Re-run with --force to kill them.');
      console.log('Check first: a server with no slot may belong to an agent on an unconverted tool.');
    } else {
      for (const o of orphans) {
        try { process.kill(-o.pid, 'SIGTERM'); } catch { try { process.kill(o.pid, 'SIGTERM'); } catch { /* gone */ } }
        console.log(`  killed ${o.pid} (port ${o.port})`);
      }
    }
  }
  process.exit(0);
}

/* ────────────────────────────────── status ────────────────────────────────── */

reapStale();
const slots = listSlots();
const waiters = listWaiters();
const { cap, from } = capSource();
const procs = scanProcesses();
const gpu = gpuBackend();
const cpu = coresInUse();
const live = slots.filter((s) => !s.stale);

if (JSON_OUT) {
  console.log(JSON.stringify({
    cap, capFrom: from, enabled: budgetEnabled(), budgetDir: BUDGET_DIR,
    slots: slots.map((s) => ({ slot: s.slot, stale: s.stale, heldMs: s.heldMs, ...s.rec })),
    waiting: waiters.map((w) => ({ ticket: w.ticket, stale: w.stale, waitingMs: w.waitingMs, ...w.rec })),
    machine: {
      cores: CORES, load: os.loadavg(), coresInUse: cpu,
      browsers: procs.browsers.length, browserChildProcs: procs.children.length,
      viteServers: procs.vites.length, gpu,
    },
  }, null, 2));
  process.exit(0);
}

const bar = (n, max, width = 20) => {
  const f = Math.max(0, Math.min(width, Math.round((n / max) * width)));
  return `[${'#'.repeat(f)}${'.'.repeat(width - f)}]`;
};

console.log(`browser budget — ${live.length}/${cap} slots in use  ${bar(live.length, cap)}   (cap from ${from})`);
if (!budgetEnabled()) console.log('  !! TC_BROWSER_BUDGET=off in THIS shell. Other agents may still be capped.');
console.log(`  ${BUDGET_DIR}\n`);

if (!slots.length) {
  console.log('  no slots held.\n');
} else {
  console.log('  slot  label                 pid      port   held      beat   worktree');
  console.log('  ────  ────────────────────  ───────  ─────  ────────  ─────  ────────────────────');
  for (const s of slots.sort((a, b) => a.slot - b.slot)) {
    const r = s.rec ?? {};
    const beat = s.rec?._mtimeMs ? dur(Date.now() - s.rec._mtimeMs) : '?';
    console.log(`  ${String(s.slot).padEnd(4)}  ${String(r.label ?? '?').slice(0, 20).padEnd(20)}  `
      + `${String(r.pid ?? '?').padEnd(7)}  ${String(r.port ?? '—').padEnd(5)}  `
      + `${dur(s.heldMs).padEnd(8)}  ${beat.padEnd(5)}  ${r.root ? path.basename(r.root) : '?'}`
      + (s.stale ? `   ← STALE (${s.stale})` : ''));
  }
  console.log('');
}

const liveWaiters = waiters.filter((w) => !w.stale);
if (liveWaiters.length) {
  console.log(`  ${liveWaiters.length} waiting in the queue, oldest first:`);
  for (const [i, w] of liveWaiters.sort((a, b) => a.ticket.localeCompare(b.ticket)).entries()) {
    console.log(`    ${i + 1}. ${w.rec?.label ?? '?'} pid ${w.rec?.pid ?? '?'}`
      + `${w.rec?.port ? ` port ${w.rec.port}` : ''} — waiting ${dur(w.waitingMs)}`);
  }
  console.log('');
}

console.log('machine');
console.log(`  ${CORES} cores; load ${os.loadavg().map((l) => l.toFixed(2)).join(' / ')}; `
  + `${cpu.all.toFixed(1)} cores actually in use right now  ${bar(cpu.all, CORES)}`);
console.log(`    of which chromium ${cpu.chrome.toFixed(1)}, vite ${cpu.vite.toFixed(1)}`);
console.log(`  ${procs.browsers.length} headless browser(s) = ${procs.browsers.length + procs.children.length} `
  + `OS processes (one browser is six or seven of them — do not read a ps count as a browser count)`);
console.log(`  ${procs.vites.length} vite server(s) on ${procs.viteProcs.length} processes: `
  + `${procs.vites.filter((v) => v.style === 'runner').length} via vite-runner, `
  + `${procs.vites.filter((v) => v.style === 'npx').length} via npx`
  + `; gpu ${gpu.metal} metal / ${gpu.swiftshader} swiftshader / ${gpu.unknown} unstated`);

/*
 * The two disagreements worth printing, because each is a specific past failure.
 */
const unbudgeted = procs.browsers.length - live.length;
if (unbudgeted > 0) {
  console.log(`\n  !! ${unbudgeted} browser(s) running that hold no slot.`);
  console.log('     Either an unconverted tool (most of tools/scratch/ is still direct — see');
  console.log('     `node tools/check-browser-budget.mjs`), or something started with');
  console.log('     TC_BROWSER_BUDGET=off. The cap cannot count what does not ask.');
}
const npxVites = procs.vites.filter((v) => v.style === 'npx');
if (npxVites.length) {
  console.log(`\n  !! ${npxVites.length} vite server(s) started through npx.`);
  console.log('     `kill` on an npx-spawned server signals the wrapper and leaves Vite holding');
  console.log('     the port. This is the mechanism that left nineteen orphans on 22 Aug.');
  console.log(`     Ports: ${npxVites.map((v) => v.port ?? '?').join(', ')}   (node tools/browsers.mjs sweep)`);
}
if (gpu.swiftshader) {
  console.log(`\n  !! ${gpu.swiftshader} GPU process(es) running --use-angle=swiftshader, not metal.`);
  console.log('     Software rasterisation turns a seconds-long boot into four to six minutes,');
  console.log('     silently. Pass no args to launchBrowser and it gets GPU_ARGS, which has metal.');
}

const capDisagreement = [...new Set(live.map((s) => s.rec?.cap).filter(Boolean))];
if (capDisagreement.length > 1) {
  console.log(`\n  !! holders disagree about the cap: ${capDisagreement.join(', ')}.`);
  console.log(`     Someone has TC_MAX_BROWSERS set in their shell. Set it for everyone with`);
  console.log('     `node tools/browsers.mjs cap <n>` and unset the environment variable.');
}

console.log(`\n  reap dead records: node tools/browsers.mjs reap`);
console.log('  find unowned servers: node tools/browsers.mjs sweep');
