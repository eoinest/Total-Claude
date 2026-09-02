#!/usr/bin/env node
/**
 * Prove the supervisor kills before proving it permits.
 *
 * ## Why this exists in this shape
 *
 * **A limiter that has only been shown to permit is not one anybody should run unattended**, and
 * this repository has shipped several checks in exactly that condition. `tools/qa-reclaim.mjs`
 * settled the pattern for the reclaimer: build real fixtures, run the destructive path for real,
 * and assert the *refusals* first. This is the same shape for the process supervisor.
 *
 * The load-bearing case is the one that failed on 23 Aug 2026, and it goes first: **a detached
 * child that launches browsers, its parent killed, and the child and its browsers dead.** Every
 * other assertion here is worth less than that one.
 *
 * ## The eight things it proves, and the failure each is for
 *
 * | # | case | must |
 * |---|---|---|
 * | 1 | detached child launching browsers, parent SIGKILLed | child **and browsers** die |
 * | 2 | the same, unsupervised — the 23 Aug spawn, exactly | **still leak**, or 1 proves nothing |
 * | 3 | the child SIGKILLed, not the parent | the guard sweeps the browsers it left |
 * | 4 | a sibling's process | a sweep **refuses** it |
 * | 5 | a registry entry whose owner was killed | reaped, and its tree killed |
 * | 6 | an entry from a previous boot | dropped, and **nothing signalled** |
 * | 7 | the ceiling with no room | **refuses with a reason**, bounded, does not hang |
 * | 8 | the guard **and its owner** SIGKILLed | leaks nothing, wedges nothing |
 *
 * Case 2 is the control and it is the reason to trust case 1. A test that shows the fixed path
 * working, without showing the unfixed path failing, cannot distinguish "the fix works" from
 * "the bug does not reproduce here" — and this bug's whole history is that it did not reproduce
 * when anybody looked.
 *
 * Case 8 removes **both** live mechanisms — the guard and the process that owns the record — and
 * leaves only a file on disk and a reaper in an unrelated process. An earlier version killed the
 * guard alone and was quietly measuring the owner's own exit handler instead of the reaper; see
 * the note in the case itself.
 *
 * Case 6 is the one that matters most for a machine that sleeps. After a reboot the PIDs in a
 * record name strangers, so the *only* correct action is to delete the record and signal nothing.
 * The assertion is therefore about a process that must **survive**.
 *
 * ## What it costs
 *
 * It opens browsers — it has to, because the assertion is that browsers die — through
 * `launchBrowser`, so it is inside the cap like everything else. They load `about:blank` rather
 * than the game: what is under test is the lifetime of a process tree, and thirty seconds of Vite
 * boot per iteration would make this too slow to run and would put a real GPU load on the owner's
 * machine for no additional evidence.
 *
 * It uses its **own registry directory** under `TC_BUDGET_DIR`, so nothing it does can reap a
 * sibling agent's real entry — a test for a reaper that reaped the machine while proving itself
 * safe would have failed at its job.
 *
 * ## Usage
 *
 *     node tools/qa-supervisor.mjs
 *     node tools/qa-supervisor.mjs --quick     # skip the two browser arms (1, 3); 6 cases
 *     node tools/qa-supervisor.mjs --keep      # leave the sandbox for inspection
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEEP = process.argv.includes('--keep');
const QUICK = process.argv.includes('--quick');
const SANDBOX = `/tmp/tc-qa-supervisor-${process.pid}`;

/*
 * The sandbox is the budget directory, not a copy of one. `process-registry.mjs` resolves
 * `TC_BUDGET_DIR` at import time, so it has to be set before the first import of anything that
 * reads it — hence the assignment above the dynamic imports below rather than at the top.
 */
process.env.TC_BUDGET_DIR = SANDBOX;
mkdirSync(path.join(SANDBOX, 'owned'), { recursive: true });
mkdirSync(path.join(SANDBOX, 'slots'), { recursive: true });
mkdirSync(path.join(SANDBOX, 'tmp'), { recursive: true });

const reg = await import('./lib/process-registry.mjs');
const { bootId } = await import('./lib/liveness.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

let pass = 0; const failures = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL  ${name}\n          ${detail}`); }
};

/** Every `chrome-headless-shell` browser process on the machine, by PID. */
const browserPids = () => reg.procCensus().browsers.map((b) => b.pid);

/**
 * Wait for a condition, and **return how long it took**, because "it eventually died" and "it died
 * in two seconds" are different claims and only one of them is a limiter.
 */
const waitFor = async (what, fn, timeoutMs) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return { ok: true, ms: Date.now() - t0 };
    await sleep(400);
  }
  return { ok: false, ms: Date.now() - t0, what };
};

/* ───────────────────────────── cleanup, always ───────────────────────────── */

const litter = new Set();          // PIDs this test created and must not leave behind
const noteLitter = (pid) => { if (Number.isFinite(pid) && pid > 1) litter.add(pid); };

const cleanup = () => {
  /*
   * The test's own hygiene, and it is not optional. This file spawns detached trees on the owner's
   * machine on purpose; leaving one behind would make it the exact bug it is testing for, with the
   * additional insult of having printed PASS.
   */
  for (const pid of litter) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  // Anything still registered in the sandbox, tree and all.
  try {
    for (const e of reg.listOwned()) {
      if (e.rec?.pgid) { try { process.kill(-e.rec.pgid, 'SIGKILL'); } catch { /* gone */ } }
    }
  } catch { /* the sandbox may already be gone */ }
  if (KEEP) { console.log(`\n--keep: sandbox left at ${SANDBOX}`); return; }
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

/**
 * Start `tools/fixtures/orphan-parent.mjs` detached, and wait until its loop has a browser open.
 *
 * Detached deliberately: the parent must not be in *this* process's group, or killing it would be
 * indistinguishable from this test tidying up after itself.
 */
const startOrphanParent = async ({ owned, port }) => {
  const report = `${SANDBOX}/report-${owned ? 'owned' : 'unowned'}.json`;
  const before = new Set(browserPids());
  const parent = spawn(process.execPath,
    [path.join(ROOT, 'tools/fixtures/orphan-parent.mjs'), `--report=${report}`,
      `--port=${port}`, '--runs=6', `--owned=${owned ? 1 : 0}`],
    { cwd: ROOT, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, TC_BUDGET_DIR: SANDBOX } });
  parent.unref();
  noteLitter(parent.pid);

  const got = await waitFor('a browser to open',
    () => existsSync(report) && browserPids().some((p) => !before.has(p)), 180_000);
  const rec = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null;
  if (rec?.pgid) noteLitter(rec.pgid);
  const fresh = browserPids().filter((p) => !before.has(p));
  for (const p of fresh) noteLitter(p);
  return { parentPid: parent.pid, report: rec, browsers: fresh, opened: got.ok, openedMs: got.ms };
};

console.log(`qa-supervisor — sandbox ${SANDBOX}\n`);
console.log(`  agent      ${reg.identity().agent ?? '(none — running as a human)'}`);
console.log(`  agent pid  ${reg.identity().agentPid ?? '—'}`);
console.log(`  worktree   ${reg.identity().worktree}`);
console.log(`  boot       ${bootId()}\n`);

/* ═══════════════ 1. the load-bearing case ═══════════════ */

console.log('1. THE LOAD-BEARING CASE — a detached child launching browsers, parent SIGKILLed');
if (QUICK) {
  console.log('   (skipped by --quick; this is the case that matters, so do not trust a --quick run)');
} else {
  const job = await startOrphanParent({ owned: true, port: 5948 });
  check('the fixture got a browser open before the kill', job.opened && job.browsers.length > 0,
    `opened=${job.opened} after ${job.openedMs} ms, browsers=${job.browsers.join(', ') || 'none'}`);
  console.log(`        parent pid ${job.parentPid}, guarded group ${job.report?.pgid}, `
    + `browser(s) ${job.browsers.join(', ')}`);

  const treeBefore = reg.treeMembers(job.report?.pgid ?? 0).length;
  process.kill(job.parentPid, 'SIGKILL');
  console.log(`        SIGKILL ${job.parentPid} — no handler runs, nothing gets to be polite`);

  const died = await waitFor('the tree to go',
    () => reg.treeMembers(job.report?.pgid ?? 0).length === 0
      && job.browsers.every((p) => !alive(p)), 45_000);
  check('the child process tree is gone', reg.treeMembers(job.report?.pgid ?? 0).length === 0,
    `${reg.treeMembers(job.report?.pgid ?? 0).length} of ${treeBefore} process(es) still up`);
  check('and every browser it had open is gone', job.browsers.every((p) => !alive(p)),
    `still alive: ${job.browsers.filter((p) => alive(p)).join(', ')}`);
  console.log(`        died ${died.ms} ms after the kill (the guard polls every `
    + `${process.env.TC_GUARD_WATCH_MS || 2000} ms)`);

  reg.reapOwned({ quiet: true });
  check('and the registry entry it left is gone', reg.listOwned().length === 0,
    `${reg.listOwned().length} entr${reg.listOwned().length === 1 ? 'y' : 'ies'} remain`);
}

/* ═══════════════ 2. the control ═══════════════ */

console.log('\n2. THE CONTROL — the same thing spawned the 23 Aug way, which must still leak');
{
  const job = await startOrphanParent({ owned: false, port: 5949 });
  check('the unsupervised fixture got a browser open', job.opened, `opened=${job.opened}`);
  process.kill(job.parentPid, 'SIGKILL');
  /*
   * Fifteen seconds is seven times the guard's poll interval. If the unsupervised child were going
   * to die of its own accord it would have done so; this assertion is that it does not, and it is
   * the assertion that makes case 1 mean something.
   */
  await sleep(15_000);
  const survivors = reg.treeMembers(job.report?.pgid ?? 0);
  const stillBrowsing = job.browsers.filter((p) => alive(p));
  check('the unsupervised child SURVIVED its parent — the bug still reproduces',
    survivors.length > 0 || stillBrowsing.length > 0,
    'the unowned child died on its own, so case 1 proves nothing about the supervisor: '
    + 'either the fixture is wrong or something else on this machine is cleaning up');
  console.log(`        ${survivors.length} process(es) and ${stillBrowsing.length} browser(s) `
    + 'outlived a SIGKILLed parent, exactly as on 23 Aug');

  // And then take it down by hand, which is what somebody had to do that night.
  for (const m of survivors) { try { process.kill(m.pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const p of stillBrowsing) { try { process.kill(-p, 'SIGKILL'); } catch { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } }
  await sleep(1500);
  check('  …and a tree kill by hand does clear it', reg.treeMembers(job.report?.pgid ?? 0).length === 0
    && job.browsers.every((p) => !alive(p)),
    `left: ${reg.treeMembers(job.report?.pgid ?? 0).length} process(es), `
    + `${job.browsers.filter((p) => alive(p)).length} browser(s)`);
}

/* ═══════════════ 3. the child dies, not the parent ═══════════════ */

console.log('\n3. THE CHILD SIGKILLed, not the parent — does the guard sweep what it left?');
if (QUICK) {
  console.log('   (skipped by --quick)');
} else {
  /*
   * This is the case Playwright's own SIGTERM handler hides. SIGKILL the loop and no handler runs,
   * so the browser — which is in its own process group — is not closed by anybody. The only thing
   * that can clear it is the guard sweeping its descendant closure, which is why `treeMembers`
   * walks ppid as well as pgid.
   */
  const job = await startOrphanParent({ owned: true, port: 5950 });
  check('the fixture got a browser open', job.opened && job.browsers.length > 0,
    `opened=${job.opened}, browsers=${job.browsers.join(', ') || 'none'}`);
  const loop = reg.treeMembers(job.report?.pgid ?? 0)
    .find((m) => /browser-loop\.mjs/.test(m.command));
  check('the loop process is findable in the guarded tree', !!loop,
    `tree: ${reg.treeMembers(job.report?.pgid ?? 0).map((m) => m.command.slice(0, 40)).join(' | ')}`);
  if (loop) {
    process.kill(loop.pid, 'SIGKILL');
    console.log(`        SIGKILL the loop (${loop.pid}) — Playwright's SIGTERM handler never runs`);
    const gone = await waitFor('browsers to go', () => job.browsers.every((p) => !alive(p)), 30_000);
    check('the browsers it orphaned were swept anyway', gone.ok,
      `still alive after ${gone.ms} ms: ${job.browsers.filter((p) => alive(p)).join(', ')}`);
    console.log(`        swept ${gone.ms} ms after the kill`);
  }
  const guardGone = await waitFor('the guard to exit',
    () => reg.treeMembers(job.report?.pgid ?? 0).length === 0, 20_000);
  check('and the guard exited rather than spinning on a dead child', guardGone.ok,
    `${reg.treeMembers(job.report?.pgid ?? 0).length} process(es) left after ${guardGone.ms} ms`);
  reg.reapOwned({ quiet: true });

  /*
   * And now the fixture's parent, which this case deliberately did **not** kill — the whole point
   * was to kill the child instead. It is still sitting in its `setInterval`, and case 9 is
   * watching: the first run of this file passed all forty assertions about other people's orphans
   * and then left one of its own, which is the exact failure mode being tested, with PASS printed
   * above it.
   */
  process.kill(job.parentPid, 'SIGKILL');
  const parentGone = await waitFor('the fixture parent to go', () => !alive(job.parentPid), 10_000);
  check('and the fixture parent this case spared is cleaned up before moving on', parentGone.ok,
    `pid ${job.parentPid} still alive after ${parentGone.ms} ms`);
}

/* ═══════════════ 4. a sibling's process is refused ═══════════════ */

console.log("\n4. A SIBLING'S PROCESS — a sweep must refuse it");
{
  const sleeper = spawn('/bin/sleep', ['300'], { cwd: ROOT, detached: true, stdio: 'ignore' });
  sleeper.unref();
  noteLitter(sleeper.pid);
  await sleep(600);

  /*
   * A registry entry that looks exactly like a sibling's: a different agent id, a different agent
   * PID that is genuinely alive (this process, which is not us as far as the id is concerned), a
   * different worktree. Written by hand rather than by `spawnOwned`, because `spawnOwned` can only
   * ever produce *our* ownership — and the thing under test is the refusal, not the writing.
   */
  const entry = path.join(SANDBOX, 'owned', 'sibling.json');
  writeFileSync(entry, JSON.stringify({
    token: 'sibling', label: 'sibling-vite', command: '/bin/sleep',
    argv: ['/bin/sleep', '300'],
    ownerPid: process.pid, anchors: [process.pid], agent: 'ffffffff-0000-0000-0000-000000000000',
    agentPid: process.pid, worktree: '/Users/somebody/else/worktrees/agent-deadbeef',
    branch: 'e/city/not-ours', port: 5901, pgid: sleeper.pid, guardPid: sleeper.pid,
    bootId: bootId(), registeredAt: new Date().toISOString(),
  }, null, 2));

  const owned = reg.listOwned().filter((e) => !e.stale);
  const att = reg.attribute(sleeper.pid, { owned, slots: [] });
  check('the sweep can name the owner from the registry', att.how === 'registry' && att.recorded,
    `attributed by ${att.how}: ${att.detail}`);
  check('  …and names the branch and the port, not just a pid',
    att.branch === 'e/city/not-ours' && att.port === 5901,
    `branch=${att.branch}, port=${att.port}`);
  check('  …and calls it a sibling', reg.isSibling(att) === true,
    `isSibling returned ${reg.isSibling(att)}`);
  console.log(`        "${att.detail}" — agent ${String(att.agent).slice(0, 8)}, `
    + `worktree ${path.basename(att.worktree)}`);

  const swept = reg.reapOwned({ quiet: true });
  check('the reaper leaves a live sibling entirely alone',
    swept.length === 0 && alive(sleeper.pid),
    `reaped ${swept.length} entr${swept.length === 1 ? 'y' : 'ies'}; sleeper alive=${alive(sleeper.pid)}`);

  /*
   * And the other half of the 5901 incident: a *recycled* group id must be refused. The entry
   * still names `sleeper.pid`, but `expect` is a command that is not in that group, so the kill
   * must decline rather than take out whatever now holds the number.
   */
  const refused = reg.killTree(sleeper.pid, { expect: 'vite-runner.mjs' });
  check('killTree refuses a group whose contents do not match the record',
    refused.refused === true && alive(sleeper.pid),
    `refused=${refused.refused}, why=${refused.why}, sleeper alive=${alive(sleeper.pid)}`);
  console.log(`        ${refused.why}`);

  try { rmSync(entry, { force: true }); } catch { /* gone */ }
  try { process.kill(sleeper.pid, 'SIGKILL'); } catch { /* gone */ }
}

/* ═══════════════ 5. a stale entry from a killed owner ═══════════════ */

console.log('\n5. A STALE ENTRY — owner killed, tree still up');
{
  /*
   * A group that is genuinely running, owned by a process that is genuinely dead. The owner here is
   * a real `/bin/sh` that this test kills, so the entry's `no-pid` verdict is reached by the same
   * `kill(pid, 0)` the semaphore uses rather than by a fabricated flag.
   */
  const owner = spawn('/bin/sh', ['-c', 'sleep 300'], { detached: true, stdio: 'ignore' });
  owner.unref();
  noteLitter(owner.pid);
  const tree = spawn('/bin/sh', ['-c', 'sleep 300 & sleep 300 & wait'], { detached: true, stdio: 'ignore' });
  tree.unref();
  noteLitter(tree.pid);
  await sleep(800);

  const entry = path.join(SANDBOX, 'owned', 'stale.json');
  writeFileSync(entry, JSON.stringify({
    token: 'stale', label: 'stale-job', command: '/bin/sh', argv: ['/bin/sh', '-c', 'sleep 300 & sleep 300 & wait'],
    ownerPid: owner.pid, anchors: [owner.pid], agent: reg.identity().agent, agentPid: reg.identity().agentPid,
    worktree: ROOT, branch: 'e/tools/process-supervisor', port: null,
    pgid: tree.pid, guardPid: null, bootId: bootId(), registeredAt: new Date().toISOString(),
  }, null, 2));

  check('while the owner lives the entry is not stale',
    reg.listOwned().every((e) => e.stale === null),
    `verdicts: ${reg.listOwned().map((e) => `${e.rec?.label}=${e.stale}`).join(', ')}`);

  const treeSize = reg.treeMembers(tree.pid).length;
  process.kill(owner.pid, 'SIGKILL');
  await sleep(600);
  const verdicts = reg.listOwned().map((e) => e.stale);
  check('with the owner dead the entry is stale for `no-pid`', verdicts.includes('no-pid'),
    `verdicts: ${verdicts.join(', ') || 'none'}`);

  const reaped = reg.reapOwned({ quiet: true });
  await sleep(800);
  check('the reaper killed the tree it named', reg.treeMembers(tree.pid).length === 0,
    `${reg.treeMembers(tree.pid).length} of ${treeSize} process(es) still up`);
  check('  …and dropped the entry', !existsSync(entry), 'the file is still there');
  console.log(`        reaped ${reaped.length}: ${reaped.map((r) => `${r.rec?.label} (${r.why}, `
    + `killed ${r.kill?.killed?.length ?? 0})`).join('; ')}`);
}

/* ═══════════════ 6. a previous boot ═══════════════ */

console.log('\n6. A PREVIOUS BOOT — drop the record, and signal NOTHING');
{
  /*
   * The assertion here is about a process that must **survive**. After a reboot the PIDs in a
   * record name whoever holds those numbers now, so a reaper that killed them would be shooting
   * strangers on every boot. `/bin/sleep` stands in for the stranger.
   */
  const stranger = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
  stranger.unref();
  noteLitter(stranger.pid);
  await sleep(500);

  const entry = path.join(SANDBOX, 'owned', 'prev-boot.json');
  writeFileSync(entry, JSON.stringify({
    token: 'prev-boot', label: 'from-before-the-crash', command: '/bin/sleep',
    argv: ['/bin/sleep', '300'], ownerPid: stranger.pid, anchors: [stranger.pid],
    agent: reg.identity().agent, agentPid: reg.identity().agentPid, worktree: ROOT,
    pgid: stranger.pid, guardPid: stranger.pid,
    bootId: 'darwin:1', registeredAt: new Date(Date.now() - 86_400_000).toISOString(),
  }, null, 2));

  const verdict = reg.listOwned().find((e) => e.rec?.token === 'prev-boot')?.stale;
  check('an entry from another boot is stale for `reboot`', verdict === 'reboot', `verdict: ${verdict}`);
  const reaped = reg.reapOwned({ quiet: true });
  check('the record is dropped', !existsSync(entry), 'the file is still there');
  check('and the PID it named was NOT signalled', alive(stranger.pid),
    'the reaper killed a process whose PID it had no right to trust after a reboot');
  check('  …and the reaper says it signalled nothing',
    reaped.find((r) => r.rec?.token === 'prev-boot')?.kill == null,
    `kill result: ${JSON.stringify(reaped.find((r) => r.rec?.token === 'prev-boot')?.kill)}`);
  try { process.kill(stranger.pid, 'SIGKILL'); } catch { /* gone */ }
}

/* ═══════════════ 7. the ceiling refuses, bounded ═══════════════ */

console.log('\n7. THE CEILING — refuses with a reason, in bounded time, rather than hanging');
{
  const wb = await import('./lib/work-budget.mjs');
  const census = reg.procCensus();

  // A ceiling of 1 cannot fit one more unit of anything, whatever else is or is not running.
  process.env.TC_MAX_PROCS = '1';
  const refused = reg.admitProcesses({ browserCap: 4 });
  check('with TC_MAX_PROCS=1 the process ceiling refuses', refused.ok === false && refused.why === 'procs',
    `ok=${refused.ok}, why=${refused.why}`);
  check('  …and the refusal names the count, the ceiling and where the ceiling came from',
    /\d+ OS processes/.test(refused.reason) && refused.ceiling === 1 && refused.ceilingFrom === 'TC_MAX_PROCS',
    `reason: ${refused.reason}`);
  console.log(`        "${refused.reason}"`);

  const gate = wb.admit({ liveCount: 0, selfHeld: 0, state: 'away' });
  check('admit() surfaces it as a `procs` refusal, not as a full slot table',
    gate.ok === false && gate.why === 'procs', `ok=${gate.ok}, why=${gate.why}`);

  /*
   * Bounded, not hung. `acquireSlot` with a short `waitMs` must **throw**, and the message must
   * name which of the three limits refused it — a silent wait is worse than a refusal, and "waiting
   * for a slot" while every slot stands empty is the single most confusing thing this could print.
   */
  const bb = await import('./lib/browser-budget.mjs');
  const t0 = Date.now();
  let err = null;
  try {
    const h = await bb.acquireSlot({ label: 'qa-supervisor-ceiling', root: ROOT, waitMs: 4000, quiet: true });
    h.release();
  } catch (e) { err = e; }
  const waited = Date.now() - t0;
  check('acquireSlot gave up rather than hanging', err !== null && waited < 60_000,
    `err=${err ? 'thrown' : 'none'} after ${waited} ms`);
  check('  …and said the work budget refused it, not the slot table',
    /work budget/.test(String(err?.message)) && /process/i.test(String(err?.message)),
    `message: ${String(err?.message).split('\n').slice(0, 3).join(' / ')}`);
  console.log(`        gave up after ${waited} ms with: `
    + `${String(err?.message).split('\n').find((l) => /Refused|process/i.test(l))?.trim() ?? '(no such line)'}`);

  delete process.env.TC_MAX_PROCS;
  const allowed = reg.admitProcesses({ browserCap: 4 });
  check('with the override removed the derived ceiling admits again', allowed.ok === true,
    `ok=${allowed.ok}, reason=${allowed.reason}`);
  console.log(`        derived ceiling ${reg.procCeiling(4).ceiling} (${reg.procCeiling(4).from}); `
    + `census now ${census.total} process(es)`);
}

/* ═══════════════ 8. the supervisor itself dies ═══════════════ */

console.log('\n8. THE SUPERVISOR DIES — SIGKILL the guard AND its owner; leak nothing, wedge nothing');
{
  /*
   * Both live mechanisms have to be gone at once, which is why the ownership is delegated to
   * `tools/fixtures/owned-job.mjs` rather than taken here.
   *
   * The first version of this case spawned the job from *this* process, killed the guard, and then
   * asserted that a reaper had finished the work. It did not measure that. `spawnOwned` installs a
   * handler in the owning process which — since the fix in that file — kills the tree itself when
   * the guard dies, and this process cannot kill itself and still make assertions. So the thing
   * that looked like proof that "the registry alone is enough" was in fact the *owner* tidying up:
   * one mechanism being credited with another's work, in the one case where the difference is the
   * entire claim. The fixture owns the job instead; both it and the guard are SIGKILLed; what is
   * left is a file on disk and a reaper in an unrelated process.
   */
  const report = `${SANDBOX}/report-guard-death.json`;
  const holder = spawn(process.execPath,
    [path.join(ROOT, 'tools/fixtures/owned-job.mjs'), `--report=${report}`, '--label=guard-death'],
    { cwd: ROOT, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, TC_BUDGET_DIR: SANDBOX } });
  holder.unref();
  noteLitter(holder.pid);
  const got = await waitFor('the fixture to register its job', () => existsSync(report), 30_000);
  const job = got.ok ? JSON.parse(readFileSync(report, 'utf8')) : null;
  if (job?.pgid) noteLitter(job.pgid);
  check('the fixture registered a guarded job it owns', !!job?.pgid && !!job?.ownerPid,
    `report after ${got.ms} ms: ${JSON.stringify(job)}`);

  await sleep(1200);
  const before = reg.treeMembers(job?.pgid ?? 0).filter((m) => m.pid !== job?.guardPid);
  check('the job is running under a guard', before.length >= 2 && reg.listOwned().length === 1,
    `${before.length} process(es) under the guard, ${reg.listOwned().length} registry entr${reg.listOwned().length === 1 ? 'y' : 'ies'}`);
  console.log(`        owner pid ${job?.ownerPid}, guard ${job?.guardPid}, `
    + `${before.length} process(es) in the tree`);

  /*
   * Kill the guard *and* the owner, both with SIGKILL. Nothing polite runs: no exit handler in the
   * owner, no signal handler in the guard. After these two lines every live mechanism this system
   * has is gone and the only remaining evidence that the tree exists is one JSON file.
   */
  process.kill(job.guardPid, 'SIGKILL');
  process.kill(job.ownerPid, 'SIGKILL');
  await sleep(1200);
  check('the guard is gone', !alive(job.guardPid), 'the guard survived SIGKILL, which is impossible');
  check('  …and so is the process that owned the record', !alive(job.ownerPid),
    'the owner survived SIGKILL, which is impossible');
  check('  …and its children are STILL RUNNING — nothing alive could have cleaned them up',
    before.some((m) => alive(m.pid)),
    'they died with the guard, so this case is not testing what it claims to test');
  check('  …and the registry entry it left still names the group',
    reg.listOwned().some((e) => e.rec?.pgid === job.pgid),
    `entries: ${reg.listOwned().map((e) => e.rec?.pgid).join(', ') || 'none'}`);

  const verdict = reg.listOwned().find((e) => e.rec?.pgid === job.pgid)?.stale;
  check('the entry is stale, because a dead guard is a dead anchor', verdict === 'no-pid',
    `verdict: ${verdict}`);

  /*
   * The third mechanism doing the other two's job. This is the whole claim about there being no
   * single point of failure: the guard is dead, the owner is dead, and state on disk plus liveness
   * re-derived from it is enough for any other process on the machine to finish the work.
   */
  const reaped = reg.reapOwned({ quiet: true });
  await sleep(800);
  check('a reaper in an unrelated process finished the job', before.every((m) => !alive(m.pid)),
    `still alive: ${before.filter((m) => alive(m.pid)).map((m) => m.pid).join(', ')}`);
  check('  …and the registry is clean', reg.listOwned().length === 0,
    `${reg.listOwned().length} entr${reg.listOwned().length === 1 ? 'y' : 'ies'} left`);
  console.log(`        reaped ${reaped.length}: ${reaped.map((r) => `${r.rec?.label} (${r.why}, `
    + `killed ${r.kill?.killed?.length ?? 0})`).join('; ') || 'nothing'}`);
}

/* ═══════════════ nothing left behind ═══════════════ */

console.log('\n9. THIS TEST ITSELF — it must not leave a detached anything behind');
{
  const stillMine = [...litter].filter((p) => alive(p));
  check('every process this test started is gone', stillMine.length === 0,
    `still alive: ${stillMine.join(', ')}`);
  const leftovers = readdirSync(path.join(SANDBOX, 'owned')).filter((f) => f.endsWith('.json'));
  check('the sandbox registry is empty', leftovers.length === 0, `left: ${leftovers.join(', ')}`);
}

/* ─────────────────────────────── the verdict ─────────────────────────────── */

console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${pass}/${pass + failures.length} assertions`
  + `${QUICK ? '  (--quick: the two browser arms were skipped)' : ''}`);
if (failures.length) {
  for (const f of failures) console.log(`  ${f}`);
  console.log('\nDo not run agents unattended until this passes. Every failure above is a case');
  console.log('where a process would have outlived the thing that owned it, or where something');
  console.log("that belonged to somebody else would have been killed.");
  process.exitCode = 1;
} else if (!QUICK) {
  console.log('A detached child launching browsers dies with its parent, and its browsers die with');
  console.log('it. The same thing spawned the old way still leaks, so that is a measurement and not');
  console.log("a hope. A sibling's process is refused, by name. A recycled group id is refused. An");
  console.log('entry from a previous boot is dropped without signalling anyone. The ceiling refuses');
  console.log('with a reason in bounded time. And killing the supervisor leaks nothing, because the');
  console.log('supervisor was never the mechanism — the state on disk is.');
}
