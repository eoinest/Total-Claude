#!/usr/bin/env node
/**
 * Does the work budget actually give the owner his machine back? Measure it.
 *
 * ## The claim under test
 *
 * `tools/lib/work-budget.mjs` asserts that when the owner is playing, demoting agent browsers
 * to the background QoS band with `taskpolicy -b` returns the GPU to him. That is a claim about
 * a scheduler, and the only honest way to hold it is to put a browser in the position he is in
 * and read its frame times while agents render behind it.
 *
 * ## Why this is paired and interleaved rather than three arms in a row
 *
 * The first version of this file ran `solo`, then `contended`, then `throttled`, once each. On
 * this machine that design cannot work, because **other agents are running gates on it while it
 * measures**: the first run reported the contended arm as 28 % *faster* than solo, which is not
 * a thing contention can do, and the explanation was that a neighbouring `qa-net` finished
 * between the two reads. Sequential arms measure the neighbours.
 *
 * So the shape is a **paired, interleaved A/B**: with the agent browser up and rendering the
 * whole time, alternate `foreground` and `background` in short windows, N cycles, and report
 * the per-cycle deltas. Anything drifting on a timescale longer than one cycle cancels. This is
 * the same argument `tools/probe-frametime.mjs` makes for its own two-arm design.
 *
 * ## What this measures and what it does not
 *
 * The "owner" browser here is **headless**, like the agents. That is a real limitation and it
 * is stated rather than hidden: his actual Chrome is a window compositing through the window
 * server at the display's refresh rate, and its absolute frame times are not these. What the
 * headless proxy measures exactly is **GPU throughput contention** — how much less rendering
 * one browser gets done when another is rendering — and that is the mechanism behind both of
 * his lag reports. A ratio here is trustworthy; an absolute millisecond figure is not.
 *
 * A headed arm would be closer, and was rejected: the screen is locked while this runs, and a
 * locked screen suspends compositing for windowed applications, so it would measure the lock
 * screen rather than the game.
 *
 * ## It deliberately bypasses the gate it is measuring
 *
 * `TC_OWNER=away`, `TC_GPU_CEILING=100` and `TC_QOS=off` are set for the run, for the reason
 * `tools/scratch/bb-bench.mjs` gives: an instrument subject to the mechanism under test
 * measures the mechanism and not the machine. The demotion is applied by this file directly,
 * through the same `setQosTree` the budget uses, on the PID `launchBrowser` identified by
 * before-and-after diff.
 *
 * ## Usage
 *
 *     node tools/scratch/gpu-bench.mjs --port=5771 --cycles=4 --window=6
 *     node tools/scratch/gpu-bench.mjs --port=5771 --owner-width=3456 --owner-height=2160
 *     node tools/scratch/gpu-bench.mjs --port=5771 --agents=2 --json --out=/tmp/x.json
 *
 * It holds `agents + 1` slots at its peak and takes roughly
 * `2 × cycles × window` seconds of measurement plus two boots.
 */

import process from 'node:process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';
import { bootThroughMenu } from '../lib/menu-boot.mjs';
import { gpuSample, setQosTree } from '../lib/machine-load.mjs';

process.env.TC_OWNER = 'away';
process.env.TC_GPU_CEILING = '100';
process.env.TC_QOS = 'off';

const arg = (k, d) => {
  const f = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return f ? f.slice(f.indexOf('=') + 1) : d;
};
const PORT = Number(arg('port', 5771));
const AGENTS = Number(arg('agents', 1));
const CYCLES = Number(arg('cycles', 4));
const WINDOW = Number(arg('window', 6));
const MAP = arg('map', 'campus-martius');
/**
 * The pixel load, and the reason it is a parameter.
 *
 * The first paired run used 1280x800 for everybody and found **nothing**: the owner browser sat
 * at exactly 120.0 fps in all eight windows, foreground and background alike, with p95 at
 * 9.5 ms. That is not the absence of contention, it is the absence of *load* — headless
 * Chromium is vsync-locked to the display's 120 Hz and the scene was finishing in 8 ms with
 * room to spare, so there was nothing for an agent to take.
 *
 * He does not play at 1280x800. He plays full-screen on a Retina panel, which is between four
 * and eight times the pixels, and the GPU cost of this scene is very nearly linear in them. A
 * bench whose owner arm has 40% headroom cannot measure an effect that only appears when it has
 * none, and reporting "no effect" from it would have been the wrong answer stated confidently.
 */
const OW = Number(arg('owner-width', 2560));
const OH = Number(arg('owner-height', 1600));
const AW = Number(arg('agent-width', 1920));
const AH = Number(arg('agent-height', 1080));
const DPR = Number(arg('dpr', 1));
const JSON_OUT = process.argv.includes('--json');
const OUT = arg('out', null);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const say = (s) => { if (!JSON_OUT) console.log(s); };

const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

/**
 * rAF deltas from a live page and GPU utilisation over **the same window**.
 *
 * The GPU sampler must not be `gpuUtilisation()`: that spaces its reads with a synchronous
 * `execFileSync('sleep')`, which blocks node's event loop and therefore the CDP pump, so the
 * two measurements would neither overlap nor be independent. A `setInterval` firing one
 * `ioreg` (about 15 ms) leaves the loop free and spans the whole window.
 */
const measure = async (page, ms) => {
  const gpu = [];
  const timer = setInterval(() => { const s = gpuSample(); if (s) gpu.push(s.device); }, 250);
  let deltas;
  try {
    deltas = await page.evaluate((duration) => new Promise((resolve) => {
      const out = []; let last = performance.now(); const end = last + duration;
      const tick = (t) => { out.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else resolve(out); };
      requestAnimationFrame(tick);
    }), ms);
  } finally { clearInterval(timer); }
  // The first delta straddles the evaluate round trip and is not a frame.
  const d = deltas.slice(1);
  return {
    frames: d.length,
    fps: d.length / (ms / 1000),
    p50: pct(d, 0.5), p95: pct(d, 0.95), p99: pct(d, 0.99), max: Math.max(...d),
    // A frame over 20 ms is a visible hitch at any refresh rate this machine runs at.
    hitchPct: (100 * d.filter((x) => x > 20).length) / d.length,
    gpuMean: gpu.length ? mean(gpu) : null,
    gpuSamples: gpu.length,
  };
};

const openBattle = async (browser, base, label, w, h) => {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: DPR });
  await bootThroughMenu(page, { base, map: MAP, tier: 'high', readyTimeout: 300_000 });
  say(`   ${label} up at ${w}x${h}${DPR !== 1 ? ` @${DPR}x` : ''}`);
  return page;
};

/** Keep an agent page rendering hard: a rAF loop that never resolves. */
const renderForever = (page) => page.evaluate(() => {
  const spin = () => requestAnimationFrame(spin);
  requestAnimationFrame(spin);
});

const main = async () => {
  const agents = [];
  let owner = null; let ownerPage = null; let server = null;
  const cycles = [];
  let solo = null; let soloEnd = null;

  try {
    say(`gpu-bench — ${AGENTS} agent(s), ${CYCLES} paired cycles of ${WINDOW}s, map ${MAP}`);
    say(`             owner ${OW}x${OH}, agents ${AW}x${AH}, dpr ${DPR}\n`);

    owner = await launchBrowser({ label: 'gpu-bench-owner', port: PORT, root: ROOT });
    server = await startVite({ port: PORT, root: ROOT, label: 'gpu-bench', slot: owner.budgetSlot });
    ownerPage = await openBattle(owner, server.base, 'owner browser', OW, OH);

    // Thrown away: the seconds after `ready` include shader compilation and impostor
    // generation, and pooling those with steady state makes the first arm the slowest whatever
    // order the arms run in.
    await measure(ownerPage, 4000);

    say('\nreference — the owner browser alone');
    solo = await measure(ownerPage, WINDOW * 1000);
    say(`   ${solo.fps.toFixed(1)} fps, p95 ${solo.p95.toFixed(1)} ms, gpu ${solo.gpuMean?.toFixed(0)}%`);

    say(`\nbringing up ${AGENTS} agent browser(s)`);
    for (let i = 0; i < AGENTS; i++) {
      const b = await launchBrowser({ label: `gpu-bench-agent${i}`, port: PORT, root: ROOT });
      const p = await openBattle(b, server.base, `agent ${i}`, AW, AH);
      // `launchBrowser` identifies its own browser by before/after diff and publishes it here.
      // Reading it any other way is what produced a 6.5 fps arm in the first run of this file:
      // the ps scan it used returned the *owner's* browser, and the throttle demoted him.
      if (!b.budgetPid) throw new Error('gpu-bench: cannot identify the agent browser pid; refusing to demote a browser I cannot name');
      renderForever(p).catch(() => {});
      agents.push({ browser: b, page: p, pid: b.budgetPid });
    }
    say(`   agent pids ${agents.map((a) => a.pid).join(', ')} (owner is ${owner.budgetPid})`);

    say(`\n${CYCLES} paired cycles — foreground then background, alternating\n`);
    say('  cycle   agents           owner fps   p95 ms   hitches   gpu');
    for (let c = 0; c < CYCLES; c++) {
      const row = {};
      for (const bg of [false, true]) {
        for (const a of agents) setQosTree(a.pid, bg);
        // Migration between core clusters is not instantaneous; a read taken immediately
        // catches the transition rather than the state.
        await new Promise((r) => setTimeout(r, 2000));
        const m = await measure(ownerPage, WINDOW * 1000);
        row[bg ? 'background' : 'foreground'] = m;
        say(`  ${String(c + 1).padStart(5)}   ${(bg ? 'background' : 'foreground').padEnd(15)} `
          + `${m.fps.toFixed(1).padStart(9)}   ${m.p95.toFixed(1).padStart(6)}   `
          + `${`${m.hitchPct.toFixed(0)}%`.padStart(7)}   ${m.gpuMean?.toFixed(0)}%`);
      }
      cycles.push(row);
    }

    for (const a of agents) setQosTree(a.pid, false);
    for (const a of agents) { try { await a.browser.close(); } catch { /* gone */ } }
    agents.length = 0;
    await new Promise((r) => setTimeout(r, 2000));
    say('\nreference again — agents closed, to show the machine did not simply drift');
    soloEnd = await measure(ownerPage, WINDOW * 1000);
    say(`   ${soloEnd.fps.toFixed(1)} fps, p95 ${soloEnd.p95.toFixed(1)} ms, gpu ${soloEnd.gpuMean?.toFixed(0)}%`);

    const fg = cycles.map((c) => c.foreground);
    const bg = cycles.map((c) => c.background);
    const summary = {
      soloFps: solo.fps, soloFpsAfter: soloEnd.fps,
      foregroundFps: mean(fg.map((x) => x.fps)), backgroundFps: mean(bg.map((x) => x.fps)),
      foregroundP95: mean(fg.map((x) => x.p95)), backgroundP95: mean(bg.map((x) => x.p95)),
      foregroundHitch: mean(fg.map((x) => x.hitchPct)), backgroundHitch: mean(bg.map((x) => x.hitchPct)),
      // Paired: each cycle contributes one ratio, so a machine drifting between cycles cannot
      // move the answer the way it can move a difference of two pooled means.
      perCycleGain: cycles.map((c) => c.background.fps / c.foreground.fps),
    };
    summary.meanGain = mean(summary.perCycleGain);
    summary.recoveredPct = 100 * (summary.backgroundFps / ((solo.fps + soloEnd.fps) / 2));
    summary.costOfContentionPct = 100 * (summary.foregroundFps / ((solo.fps + soloEnd.fps) / 2));

    const payload = { agents: AGENTS, cycles: CYCLES, windowSeconds: WINDOW, map: MAP,
      viewports: { owner: [OW, OH], agent: [AW, AH], dpr: DPR }, solo, soloEnd, cycleData: cycles, summary };
    if (JSON_OUT) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log('\n─────────────────────────────────────────────────────────────────────');
      console.log(`owner alone            ${solo.fps.toFixed(1)} fps before, ${soloEnd.fps.toFixed(1)} fps after`);
      console.log(`agents at foreground   ${summary.foregroundFps.toFixed(1)} fps  = ${summary.costOfContentionPct.toFixed(0)}% of alone`
        + `   p95 ${summary.foregroundP95.toFixed(1)} ms, ${summary.foregroundHitch.toFixed(0)}% hitches`);
      console.log(`agents at background   ${summary.backgroundFps.toFixed(1)} fps  = ${summary.recoveredPct.toFixed(0)}% of alone`
        + `   p95 ${summary.backgroundP95.toFixed(1)} ms, ${summary.backgroundHitch.toFixed(0)}% hitches`);
      console.log(`\nper-cycle gain from demoting: ${summary.perCycleGain.map((g) => `${g.toFixed(2)}x`).join('  ')}`);
      console.log(`mean ${summary.meanGain.toFixed(2)}x — paired, so drift between cycles cannot produce it.`);
      console.log('\nThe owner browser is headless, so these are GPU throughput ratios and not his');
      console.log('frame times. The ratio is the claim; the milliseconds are not.');
    }
    if (OUT) writeFileSync(OUT, JSON.stringify(payload, null, 2));
  } finally {
    for (const a of agents) { try { setQosTree(a.pid, false); } catch { /* gone */ } try { await a.browser.close(); } catch { /* gone */ } }
    try { await owner?.close(); } catch { /* gone */ }
    try { await server?.close(); } catch { /* gone */ }
  }
};

main().catch((e) => { console.error(e); process.exitCode = 1; });
