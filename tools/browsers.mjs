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
 * This is the one command that answers it, and it is deliberately close to read-only. `reap` only
 * removes lock records whose holder is provably gone, and `sweep` refuses to kill anything at all
 * unless you pass `--force`.
 *
 * **`status`, `procs` and `machine` are not quite read-only, and the exception is deliberate.**
 * They call `reapStale()`, which drops records whose holder is dead and — since the process
 * registry landed — takes down the process groups those dead records name. That is the design: the
 * sweep is paid for by whoever next looks, rather than by a daemon that can itself die, so the
 * window on a leak is "until somebody runs this" and not "until somebody remembers to clean up".
 * Nothing with a live owner is ever touched by it, and a record from before the last boot is
 * dropped **without signalling any PID in it**.
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
 *     node tools/browsers.mjs procs           **how many OS processes, and whose** — in a second
 *     node tools/browsers.mjs reap            drop lock records whose holder is dead
 *     node tools/browsers.mjs sweep           list servers nobody owns, and say whose the rest are
 *     node tools/browsers.mjs sweep --force   …and kill the ones no live sibling owns
 *     node tools/browsers.mjs sweep --force --include-others   …a sibling's too, named first
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
 * One unit of gate work is **six OS processes**, measured on this machine with
 * `tools/scratch/procs-per-browser.mjs`: four `chrome-headless-shell` (browser, gpu-process,
 * utility, one renderer per page), one Vite, and one `spawn-guard`. The older prose here said "six
 * or seven" from full Chromium, which carries network and audio services this repository never
 * launches. `ps | grep -c chrome-headless-shell` returning 136 is not 136 browsers.
 *
 * So both counts are printed, and **each is authoritative for a different thing**. Browsers is the
 * admission unit, because admission happens before anything is spent and you cannot grant
 * three-fifths of a browser. Processes is the audit unit and the backstop, because it is the number
 * the owner reads off `ps` and it catches three things a slot count provably cannot: a browser
 * holding no slot, one slot holding twenty pages, and a spawned tree that is not a browser at all —
 * which is what the 23 Aug loop was at every moment a sweep looked at it.
 *
 * ## Whose is it?
 *
 * `procs`, `machine` and `sweep` all name an owner, and they say whether they **recorded** it or
 * **inferred** it. Recorded means a registry entry or a budget slot written on the way in and
 * carrying the agent id, worktree, branch and port. Inferred means a walk up the parent chain to a
 * live `claude`, or `lsof -d cwd` — the sentence missing from the 5901 incident, where one agent
 * killed a sibling's dev server. A sweep may refuse to kill either, and only kills on the first.
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
  attribute, cwdByPid, groupIndex, identity, isAgentCommand, isSibling, listOwned, procCeiling,
  procCensus, psTable, shortOwner, PROCS_PER_UNIT,
} from './lib/process-registry.mjs';
import {
  OWNER_FLAG, POLICY, observe, ownerState, policyFor, procPolicy, qosEnabled, workBudgetEnabled,
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

/* ──────────────────────────── ownership and processes ──────────────────────────── */

const bar2 = (n, max, width = 24) => {
  const f = Math.max(0, Math.min(width, Math.round((n / max) * width)));
  return `[${'#'.repeat(f)}${'.'.repeat(width - f)}]`;
};
const gb = (n) => (n == null ? '?' : n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);

/**
 * Whose is it? — the question this command could not answer until now.
 *
 * ## Asked twice, and the incident behind it
 *
 * The owner has now asked twice **how many processes** are running, and until now the honest
 * answer here was a warning that the number is misleading. That is a true warning and a useless
 * one. So the process count is printed against a ceiling, in the unit he counts in, and split into
 * the parts that make the raw total misleading.
 *
 * The other half is ownership. On 23 Aug an agent killed a Vite server on port 5901 that belonged
 * to a sibling and wrote afterwards that one `lsof -a -p <pid> -d cwd` would have told it. Nothing
 * recorded ownership then. `spawnOwned` records it now, and `attribute()` infers it for anything
 * started before this existed or outside it — **and the difference between recorded and inferred
 * is carried all the way to the screen**, because a sweep may refuse to kill either but should
 * only ever kill on the strength of the first.
 *
 * One `ps`, one `lsof` and one registry read, shared by every caller: `machine` already takes
 * about four seconds and the ownership scan must not be the reason it takes eight.
 */
const ownership = ({ browserCap }) => {
  const table = psTable();
  const census = procCensus({ table });
  const { ceiling, from } = procCeiling(browserCap);
  const owned = listOwned({ table }).filter((e) => !e.stale);
  const slots = listSlots().filter((s) => !s.stale);
  const ctx = { owned, slots, table, groupOf: groupIndex(), cwds: cwdByPid() };
  const me = identity();

  /*
   * The processes that no registry entry claims, attributed by inference. They are the ones that
   * matter: a group with an entry is already answered for, and everything else is either an
   * unconverted tool, something started with the budget off, or a leak.
   */
  const inGroup = new Set();
  for (const g of census.groups) for (const m of g.members) inGroup.add(m.pid);
  const unclaimed = [...census.browsers, ...census.vites]
    .filter((r) => !inGroup.has(r.pid))
    .map((r) => {
      const att = attribute(r.pid, ctx);
      return { ...r, att, sibling: isSibling(att, me) };
    });

  return { table, census, ceiling, ceilingFrom: from, owned, slots, ctx, me, unclaimed };
};

/** `a0ebb9da  rome-fill  city/rome-fill` — as much of an owner as fits on one line. */
const ownerLine = (rec) => {
  const who = shortOwner(rec);
  const where = rec?.worktree ? path.basename(rec.worktree).replace(/^agent-/, '') : '?';
  const br = rec?.branch ? rec.branch.replace(/^e\//, '') : '';
  return `${who.padEnd(9)} ${where.slice(0, 18).padEnd(18)} ${br.slice(0, 22)}`;
};

/**
 * The process block: the count, the ceiling, and what makes up the count.
 *
 * **Browsers is the admission unit and processes is the audit unit**, and they are printed
 * together so that the relationship is on the screen rather than in a document. You cannot grant
 * three-fifths of a browser, so admission decides in browsers; but a slot count cannot see a
 * browser that took no slot, a slot holding twenty pages, or a spawned tree that is not a browser
 * at all — and the 23 Aug loop was the third of those.
 */
const printProcesses = (own) => {
  const c = own.census;
  const over = c.total > own.ceiling;
  console.log(`processes    ${c.total} of ${own.ceiling} ceiling  `
    + `${bar2(c.total, Math.max(own.ceiling, c.total, 1))}   (${own.ceilingFrom})`);
  console.log(`             ${c.chromium} chromium = ${c.browsers.length} browser(s) + `
    + `${c.browserKids.length} of their own processes; ${c.vites.length} vite; `
    + `${c.guards.length} guard; ${c.owned.length} other owned`);
  if (c.ownerVites.length) {
    console.log(`             ${c.ownerVites.length} vite on 5173 — the owner's playtest server, `
      + 'never counted against agents');
  }
  console.log(`             One unit of gate work is ${PROCS_PER_UNIT} OS processes, measured: `
    + '4 chromium, 1 vite, 1 guard.');
  if (over) {
    console.log(`             !! OVER the ceiling by ${c.total - own.ceiling}. New work is refused and`);
    console.log('                queued, not failed, until this falls.');
  }
};

/**
 * Who owns what, recorded first and inferred second.
 *
 * The `how` column is the load-bearing one. `registry` and `slot` are recorded on the way in and
 * are good enough to act on; `parent-chain` and `cwd` are inferences — the parent walk is what had
 * to be done by hand on 23 Aug to find the orphaned loop, and the cwd is the sentence missing from
 * the port-5901 incident. Neither is a licence to kill anything, and `sweep` treats them that way.
 */
const printOwners = (own) => {
  console.log(`owners       ${own.owned.length} registered process group(s)`);
  if (own.owned.length) {
    console.log('             agent     worktree           branch                 pgid    port   label');
    for (const e of own.owned) {
      const r = e.rec ?? {};
      const members = own.census.groups.find((g) => g.pgid === r.pgid)?.members?.length ?? 0;
      console.log(`             ${ownerLine(r).padEnd(52)} ${String(r.pgid ?? '?').padEnd(7)} `
        + `${String(r.port ?? '—').padEnd(5)}  ${String(r.label ?? '?').slice(0, 20)} (${members} proc)`);
    }
  }
  if (!own.unclaimed.length) {
    console.log('             nothing running outside a registered group.');
    return;
  }
  /*
   * Recorded and inferred are printed apart, because they justify different actions. A browser
   * outside a registered group but holding a *slot* is fully accounted for — the slot names its
   * agent, its worktree and its branch. Only the inferred ones get a `!!`.
   */
  const line = (u) => {
    const kind = u.type === 'browser' ? 'browser' : `vite:${u.port ?? '?'}`;
    console.log(`                pid ${String(u.pid).padEnd(7)} ${kind.padEnd(12)} `
      + `${u.att.how.padEnd(13)} ${u.sibling === true ? "a sibling's" : u.sibling === false ? 'mine' : 'unattributable'}`);
    console.log(`                        ${u.att.detail}`);
  };
  const recorded = own.unclaimed.filter((u) => u.att.recorded);
  const inferred = own.unclaimed.filter((u) => !u.att.recorded);
  if (recorded.length) {
    console.log(`             ${recorded.length} outside a registered group but with a recorded owner:`);
    for (const u of recorded) line(u);
  }
  if (inferred.length) {
    console.log(`             !! ${inferred.length} that nothing recorded — owner inferred, not known:`);
    for (const u of inferred) line(u);
  }
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

/* ────────────────────────────────── procs ────────────────────────────────── */

/**
 * How many processes are running, and whose — in about a second.
 *
 * `machine` answers this too, but it also shells out to `reclaim.mjs` and scans sixty worktrees,
 * which takes four seconds and prints two screens. The owner has asked this question twice and it
 * deserves an answer he can type quickly and read at a glance, so it is its own command.
 *
 * It changes nothing except that `reapStale()` runs first, which is not a change so much as the
 * count being true: a record whose holder is dead is not evidence of a process.
 */
if (cmd === 'procs') {
  reapStale();
  const st = ownerState();
  const pol = policyFor(st.state);
  const own = ownership({ browserCap: pol.cap });

  if (JSON_OUT) {
    console.log(JSON.stringify({
      owner: st.state, browserCap: pol.cap,
      total: own.census.total, ceiling: own.ceiling, ceilingFrom: own.ceilingFrom,
      perUnit: PROCS_PER_UNIT,
      breakdown: {
        browsers: own.census.browsers.length, browserProcs: own.census.browserKids.length,
        vite: own.census.vites.length, guards: own.census.guards.length,
        otherOwned: own.census.owned.length, ownerVite: own.census.ownerVites.length,
      },
      owners: own.owned.map((e) => ({
        agent: e.rec?.agent ?? null, worktree: e.rec?.worktree, branch: e.rec?.branch ?? null,
        pgid: e.rec?.pgid, port: e.rec?.port ?? null, label: e.rec?.label ?? null,
      })),
      unclaimed: own.unclaimed.map((u) => ({
        pid: u.pid, kind: u.type === 'browser' ? 'browser' : 'vite', port: u.port ?? null,
        how: u.att.how, recorded: u.att.recorded, sibling: u.sibling, detail: u.att.detail,
      })),
    }, null, 2));
    process.exit(0);
  }

  console.log(`owner        ${st.state.toUpperCase()} (${st.from}) — at most ${pol.cap} browser(s)\n`);
  printProcesses(own);
  console.log('');
  printOwners(own);
  console.log('');
  console.log('  the whole machine:  node tools/browsers.mjs machine');
  console.log('  who holds a slot:   node tools/browsers.mjs');
  console.log('  kill what is left:  node tools/browsers.mjs sweep');
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
  const own = ownership({ browserCap: pol.cap });

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
    console.log(JSON.stringify({ machine: snap, policy: procPolicy(snap.owner.state), cap, capFrom: from,
      slots: live.length, browsers: procs.browsers.length, viteServers: procs.vites.length,
      processes: {
        total: own.census.total, ceiling: own.ceiling, ceilingFrom: own.ceilingFrom,
        perUnit: PROCS_PER_UNIT, chromium: own.census.chromium,
        vite: own.census.vites.length, guards: own.census.guards.length,
        otherOwned: own.census.owned.length, ownerVite: own.census.ownerVites.length,
      },
      owners: own.owned.map((e) => ({
        agent: e.rec?.agent ?? null, agentPid: e.rec?.agentPid ?? null, worktree: e.rec?.worktree,
        branch: e.rec?.branch ?? null, pgid: e.rec?.pgid, port: e.rec?.port ?? null,
        label: e.rec?.label ?? null, keepAlive: !!e.rec?.keepAlive,
        procs: own.census.groups.find((g) => g.pgid === e.rec?.pgid)?.members?.length ?? 0,
      })),
      unclaimed: own.unclaimed.map((u) => ({
        pid: u.pid, kind: u.type === 'browser' ? 'browser' : 'vite', port: u.port ?? null,
        how: u.att.how, recorded: u.att.recorded, agent: u.att.agent,
        worktree: u.att.worktree, sibling: u.sibling, detail: u.att.detail,
      })),
      gpuBackend: gpuBack, disk: df, reclaim: reclaim?.summary ?? null }, null, 2));
    process.exit(0);
  }

  console.log(`machine — ${snap.cores.total} cores (${snap.cores.performance}P + ${snap.cores.efficiency}E), `
    + `${snap.memory.totalGB} GB\n`);

  const o = snap.owner;
  console.log(`owner        ${o.state.toUpperCase()}   (${o.from === 'auto'
    ? `detected: screen ${o.locked ? 'locked' : 'unlocked'}, last input ${o.idleMs == null ? '?' : `${(o.idleMs / 1000).toFixed(0)}s`} ago, front ${o.app ?? '?'}`
    : `set in ${o.from}`})`);
  console.log(`             policy: at most ${pol.cap} browser(s) = ${procCeiling(pol.cap).ceiling} `
    + `OS processes, GPU ceiling ${pol.gpuCeiling}%, `
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
  printProcesses(own);
  console.log('');
  printOwners(own);

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
    + 'no-pid = the process is gone, no-agent = the agent that owned it was stopped while the '
    + 'harness lived on, silent = no heartbeat for 90 s.');
  process.exit(0);
}

/* ────────────────────────────────── sweep ────────────────────────────────── */

/**
 * The one command here that kills things, and therefore the one that has to know whose they are.
 *
 * ## What changed, and the incident it is for
 *
 * On 23 Aug an agent killed a Vite server on port 5901 that belonged to a sibling. Its own account
 * afterwards was that a single `lsof -a -p <pid> -d cwd` would have told it. The version of this
 * command that existed then would have done exactly the same thing: it killed every Vite whose
 * port no live slot claimed, and "no live slot claims it" is not the same fact as "nobody owns it".
 *
 * Now every candidate is attributed before anything is signalled, and the verdicts are three:
 *
 *   - **mine** — same agent, or same worktree. Killed by `--force`.
 *   - **a sibling's** — a *live* owner that is not us. **Refused**, and named. `--include-others`
 *     is the escape hatch, and it exists because a human recovering a wedged machine must be able
 *     to override a judgement; it prints whose each one is first.
 *   - **unowned** — nothing alive claims it: no registry entry, no slot, no live `claude` ancestor,
 *     and no live agent standing in its worktree. This is the 22 Aug shape — nineteen servers,
 *     several more than a day old — and `--force` takes them.
 *
 * A worktree with a **live agent in it** is what makes the middle verdict possible, and it is the
 * distinction the old code could not draw: a stopped agent's leftover server stands in the same
 * directory as a running agent's, and only one of them is somebody's.
 *
 * **Never 5173**, and never a Vite with no `--port` at all. That is the owner's playtest server,
 * and killing it is the single worst thing this command could do.
 */
if (cmd === 'sweep') {
  const force = flags.has('--force');
  const includeOthers = flags.has('--include-others');
  reapStale();
  const live = listSlots().filter((s) => !s.stale);
  const ownedPorts = new Set(live.map((s) => s.rec?.port).filter(Boolean));
  const ownedVitePids = new Set(live.map((s) => s.rec?.vitePid).filter(Boolean));
  const own = ownership({ browserCap: policyFor(ownerState().state).cap });
  const { vites, browsers } = scanProcesses();

  /*
   * The worktrees that a live `claude` is standing in. This is the fact that separates "a sibling
   * is using this" from "somebody's agent died and left it", and neither `ps` nor the slot table
   * can supply it — it needs the cwd of every process, which `ownership()` already read.
   */
  const agentDirs = new Map();
  for (const r of own.table) {
    // `isAgentCommand` tests argv[0], not the whole line. `\bclaude\b` matches inside
    // `~/.claude/shell-snapshots/…`, so every shell sourcing a snapshot counted as an agent — and
    // one of those stands in *my* worktree, which would have made my own servers a sibling's.
    if (!isAgentCommand(r.command)) continue;
    const dir = own.ctx.cwds.get(r.pid);
    if (dir) agentDirs.set(path.resolve(dir), r.pid);
  }

  const registered = new Set();
  for (const g of own.census.groups) for (const m of g.members) registered.add(m.pid);

  /*
   * **"I cannot tell" is not "mine".** That was the whole of the 5901 mistake, so an attribution
   * that cannot be resolved to *this* agent counts as somebody else's and is refused. The cost of
   * being wrong that way is a sweep that leaves something behind and says so; the cost of being
   * wrong the other way is killing a sibling's running work.
   */
  const isMine = (att) => {
    /*
     * **The worktree decides when both are known.** Several agents run as subagents of one `claude`
     * CLI, so they share `CLAUDE_PID` and the session id: a `qa-net` run in a sibling's worktree
     * walked up to *this* agent's `claude` and, on the first version of this function, came back
     * "mine". `--force` would then have killed it, which is the 5901 incident with better logging.
     */
    if (att.worktree && own.me.worktree) {
      return path.resolve(att.worktree) === path.resolve(own.me.worktree);
    }
    if (own.me.agentPid && att.agentPid) return att.agentPid === own.me.agentPid;
    if (own.me.agent && att.agent) return att.agent === own.me.agent;
    return false;
  };

  const verdictOf = (att) => {
    // Recorded, and the parent chain — whose `claude` came out of the same `ps` snapshot and is
    // therefore alive by construction. Somebody owns these; the only question is who.
    if (att.how === 'registry' || att.how === 'slot' || att.how === 'parent-chain') {
      return isMine(att) ? 'mine' : 'sibling';
    }
    /*
     * Inferred from where it is standing, which is the weakest evidence and the one that needs the
     * extra fact: **is a live agent standing there too?** A stopped agent's leftover server sits in
     * the same directory as a running agent's, and only one of them is somebody's.
     */
    if (att.how === 'cwd' && att.worktree) {
      const holder = agentDirs.get(path.resolve(att.worktree));
      if (!holder) return 'unowned';
      return holder === own.me.agentPid ? 'mine' : 'sibling';
    }
    return 'unowned';
  };

  const candidates = vites
    .filter((v) => {
      if (v.port === 5173 || v.port === null) return false;
      if (ownedPorts.has(v.port) || ownedVitePids.has(v.pid)) return false;
      // A live registry entry already answers for it, and `reapOwned` is what ends it.
      if (registered.has(v.pid)) return false;
      return true;
    })
    .map((v) => {
      const att = attribute(v.pid, own.ctx);
      return { ...v, att, verdict: verdictOf(att) };
    });

  const mine = candidates.filter((c) => c.verdict === 'mine');
  const theirs = candidates.filter((c) => c.verdict === 'sibling');
  const unowned = candidates.filter((c) => c.verdict === 'unowned');

  console.log(`${live.length} live slot(s); ${vites.length} vite server(s) running; `
    + `${browsers.length} browser(s); ${own.owned.length} registered group(s).`);
  console.log(`I am ${own.me.agent ? own.me.agent.slice(0, 8) : 'a human, with no agent id'}`
    + ` in ${path.basename(own.me.worktree)}\n`);

  const show = (list, heading) => {
    if (!list.length) return;
    console.log(`${heading}\n`);
    for (const o of list) {
      console.log(`  pid ${o.pid} port ${o.port} up ${o.etime} `
        + `${o.style === 'npx' ? '[npx-style — the orphan mechanism]' : '[runner]'}`);
      console.log(`      owner: ${o.att.how} — ${o.att.detail}`);
    }
    console.log('');
  };

  show(theirs, `${theirs.length} that belong to a LIVE sibling — refused:`);
  show(mine, `${mine.length} that are mine:`);
  show(unowned, `${unowned.length} that nothing alive claims:`);

  if (!candidates.length) {
    console.log('No dev servers to sweep. (Servers on 5173, or with no --port, are never touched,');
    console.log('and a server inside a live registry entry is reaped by its owner, not by this.)');
  }

  const killable = [...mine, ...unowned, ...(includeOthers ? theirs : [])];
  if (candidates.length && !force) {
    console.log(`Nothing killed. \`--force\` would kill ${killable.length} of ${candidates.length}`
      + `${theirs.length && !includeOthers ? `, sparing ${theirs.length} that a live sibling owns` : ''}.`);
    if (theirs.length && !includeOthers) {
      console.log('To take a sibling\'s as well — and be sure first — add --include-others.');
    }
  } else if (candidates.length) {
    for (const o of killable) {
      /*
       * The group, then the PID. A Vite started through `npx` leaves the server holding the port
       * when only the wrapper is signalled, which is the mechanism that produced nineteen orphans
       * on 22 Aug; a group signal reaches both.
       */
      try { process.kill(-o.pid, 'SIGTERM'); } catch { try { process.kill(o.pid, 'SIGTERM'); } catch { /* gone */ } }
      console.log(`  killed ${o.pid} (port ${o.port}) — ${o.verdict}`);
    }
    if (theirs.length && !includeOthers) {
      console.log(`  spared ${theirs.length} belonging to a live sibling: `
        + `${theirs.map((o) => `pid ${o.pid} port ${o.port}`).join(', ')}`);
    }
  }

  /*
   * Browsers are reported and not killed. A browser with no slot is a real problem — it is outside
   * the cap and nothing counts it — but it is somebody's *running work*, and a command that kills
   * running work on an inference is the 5901 incident with a wider blast radius. Naming the owner
   * is the useful thing this can do; `tools/reclaim.mjs` is the tool that ends a whole worktree.
   */
  const looseBrowsers = own.unclaimed.filter((u) => u.type === 'browser');
  if (looseBrowsers.length) {
    const loose = looseBrowsers.filter((b) => !b.att.recorded);
    console.log(`\n${looseBrowsers.length} browser(s) outside a registered group — reported, not killed`
      + `${loose.length ? `, ${loose.length} of them with no recorded owner at all` : ''}:`);
    for (const b of looseBrowsers) {
      console.log(`  ${b.att.recorded ? '  ' : '!!'} pid ${b.pid}  ${b.att.how}  `
        + `${b.sibling === true ? "a sibling's" : b.sibling === false ? 'mine' : 'unattributable'}`);
      console.log(`      ${b.att.detail}`);
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
/*
 * The process figure, in the unit the owner counts in. `status` answers "who holds a slot"; that
 * was the right question on 22 Aug and it is half of it now, because a slot count cannot see a
 * browser that took no slot, a slot holding twenty pages, or a spawned tree that is not a browser
 * at all — and the 23 Aug loop was the third.
 */
const statProcs = ownership({ browserCap: policyFor(ownerState().state).cap });

if (JSON_OUT) {
  console.log(JSON.stringify({
    cap, capFrom: from, enabled: budgetEnabled(), budgetDir: BUDGET_DIR,
    slots: slots.map((s) => ({ slot: s.slot, stale: s.stale, heldMs: s.heldMs, ...s.rec })),
    waiting: waiters.map((w) => ({ ticket: w.ticket, stale: w.stale, waitingMs: w.waitingMs, ...w.rec })),
    machine: {
      cores: CORES, load: os.loadavg(), coresInUse: cpu,
      browsers: procs.browsers.length, browserChildProcs: procs.children.length,
      viteServers: procs.vites.length, gpu,
      processes: statProcs.census.total, processCeiling: statProcs.ceiling,
      processCeilingFrom: statProcs.ceilingFrom, procsPerUnit: PROCS_PER_UNIT,
    },
    owners: statProcs.owned.map((e) => ({
      agent: e.rec?.agent ?? null, worktree: e.rec?.worktree, branch: e.rec?.branch ?? null,
      pgid: e.rec?.pgid, port: e.rec?.port ?? null, label: e.rec?.label ?? null,
    })),
    unclaimed: statProcs.unclaimed.map((u) => ({
      pid: u.pid, kind: u.type === 'browser' ? 'browser' : 'vite', how: u.att.how,
      recorded: u.att.recorded, sibling: u.sibling, detail: u.att.detail,
    })),
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
  + 'OS processes. One unit of gate work is six, measured: 4 chromium, 1 vite, 1 guard.');
console.log(`  ${statProcs.census.total} agent OS process(es) against a ceiling of ${statProcs.ceiling} `
  + `(${statProcs.ceilingFrom})${statProcs.census.total > statProcs.ceiling ? '  ← OVER; new work queues' : ''}`);
const unrecorded = statProcs.unclaimed.filter((u) => !u.att.recorded);
console.log(`  ${statProcs.owned.length} registered process group(s) with a recorded owner`
  + `${unrecorded.length ? `; ${unrecorded.length} process(es) whose owner is only an inference` : ''}`
  + '   (node tools/browsers.mjs procs)');
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
console.log('  how many processes, and whose: node tools/browsers.mjs procs');
console.log('  find unowned servers: node tools/browsers.mjs sweep');
