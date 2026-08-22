/**
 * THE SHAPE OF A BATTLE, not its body count.
 *
 * Built to answer one question a survivor count cannot: **when a change moves the outcome by
 * a couple of per cent, does the battle still feel like the same battle?** A 2.6 % mean shift
 * is invisible; a 2.6 % mean shift that hides one seed in twelve taking a completely different
 * branch is not, and only a per-seed comparison of *shape* can tell those apart.
 *
 * So per seed it records the things a player would notice, in order:
 *
 *   contactAt      when the first forty men die — the battle starting
 *   firstBreakUs   when my first unit routs, and theirs
 *   flips          how many times the top plaque's advantage crosses sides
 *   swing          the largest lead either side ever held, and the smallest gap after contact
 *   contestWindow  seconds between contact and the verdict — how long it was in doubt
 *   verdict        who, why, at what tick
 *   curve          living men every 10 s, both sides, for the whole battle
 *   hashes         the product's own state hashes at fixed ticks, which is how a re-run
 *                  proves it is or is not the same simulation
 *
 * The hashes are the control. If a later run has identical hashes the tree did not move and
 * any difference I claim to see is me. If they differ, the tree moved and the shape columns
 * are the evidence about whether it mattered.
 *
 *   node tools/judge/jg-shape.mjs --port=5911 --map=pydna --scen=field --runs=8 --tag=before
 */
import { argsOf, boot, ledger, dump, ff, ended, ROOT, secTicks } from './jg-lib.mjs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const A = argsOf();
const MAP = A.get('map') ?? 'pydna';
const SCEN = A.get('scen') ?? 'field';
const RUNS = Number(A.get('runs') ?? 8);
const UNTIL = Number(A.get('until') ?? 2400);
const STEP = Number(A.get('step') ?? 10);
const TAG = A.get('tag') ?? 'run';
const PORT = Number(A.get('port') ?? 5911);
const OUT = path.join(ROOT, 'screenshots/judge/shape');
const L = ledger(`shape ${MAP}/${SCEN} ${TAG}`);

const SEEDS = [4265438264, 1, 7, 99, 12345, 777777, 2718281828, 31415926,
  8675309, 424242, 1000003, 4000000000].slice(0, RUNS);
/**
 * Ticks the state hash is taken at, and why the first one is not 900.
 *
 * `boot()` waits 1,500 ms of wall clock after `ready`. Under autoplay the live rAF loop runs at
 * ~120 fps with up to `maxStepsPerFrame = 5` ticks a frame, so that wait can advance the
 * simulation by as much as **900 ticks** — measured, two loads arrived at tick 904 and 901. A
 * mark the boot has already passed cannot be hit exactly, and a hash taken at 904 in one run and
 * 901 in another is the whole of why these were never reproducible.
 *
 * Held to *exact* ticks past that point, the engine is reproducible to the bit: the same two
 * loads agree on `hash`, `uf64` and `uctl` at 2,700 and at 6,000. So the simulation really is a
 * pure function of (config, seed, tick index) — the instrument was the problem, not the engine.
 *
 * 1,800 (t+60) is the first mark comfortably clear of the maximum boot advance. An overshoot is
 * now a hard failure of the run rather than a recorded number.
 */
const MARKS = [1800, 2700, 4500, 6000, 12000];

// Separate try blocks: sharing one made a checkout with no `.git` report BOTH as '?', so a
// failure to read the commit silently took the src hash with it and neither failed loudly.
let head = '?', srcHash = '?';
try { head = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); }
catch (e) { console.error(`[shape] could not read HEAD: ${e.message}`); }
try {
  srcHash = execSync("find src -type f \\( -name '*.ts' -o -name '*.css' -o -name '*.glsl' \\) -print0 | sort -z | xargs -0 cat | shasum -a 256 | cut -c1-16",
    { cwd: ROOT, shell: '/bin/sh' }).toString().trim();
} catch (e) { console.error(`[shape] could not hash src/: ${e.message}`); }
L.say(`tree: HEAD ${head} srcHash ${srcHash}`);
L.say(`${MAP}/${SCEN}, ${SEEDS.length} seeds, sampling every ${STEP} s to t+${UNTIL}`);

const rows = [];
for (const seed of SEEDS) {
  let browser;
  try {
    const r = await boot({ port: PORT, map: MAP, scenario: SCEN, tier: 'ultra', out: OUT,
      label: `sh-${seed}`, seed, query: 'autoplay=1&deploy=0' });
    browser = r.browser;
    const page = r.page;
    /*
     * Tick-exact firsts, off the event bus.
     *
     * `contactAt`, `firstBreakUs` and `firstBreakThem` were all assigned `= s.t`, the sample
     * clock, on a 10 s grid — the same fault I fixed for `at` and failed to generalise to the
     * three columns beside it in the same function. On `main` their within-arm sd came out at
     * 0.10 s and 0.17 s with every seed in one bucket, and a "+13.6% / -5.8%" pair I reported
     * as beyond-its-own-spread was that artefact rather than a finding.
     *
     * The bus knows the exact moment. `unitRouted` and `linesClashed` are emitted inside the
     * tick, so `simTime()` at emission is tick-exact and free — no finer polling needed.
     *
     * The column that does NOT need this is peak routing, and the reason is worth keeping:
     * `Morale.rally` is gated on a 12 s delay, so every rout episode outlasts a 10 s sample and
     * cannot be missed. **A sampled column is trustworthy exactly when the thing it samples
     * outlasts the sampling interval** — that is the test, not the sample rate on its own.
     */
    await page.evaluate(() => {
      window.__firsts = { contact: null, breakBy: {} };
      const g = window.__game, ev = g.engine.context.events;
      const now = () => Math.round(g.simTime() * 100) / 100;
      ev.on('linesClashed', () => { window.__firsts.contact ??= now(); });
      ev.on('unitRouted', (e) => {
        const f = e.faction ?? (g.battle.unitById(e.unitId)?.faction ?? -1);
        window.__firsts.breakBy[f] ??= now();
      });
    });
    const start = await page.evaluate(() => { const t = window.__TRUTH();
      return { per: t.per, strength: { ...t.strength } }; });
    const n0 = Object.values(start.per).reduce((a, p) => a + p.alive, 0);

    const curve = [], hashes = {};
    let gridContact = null, gridBreakUs = null, gridBreakThem = null;
    let lastSign = 0, flips = 0, maxLead = 0, minGapAfterContact = 1;
    let verdict = null, tEnd = null, reason = null, victor = null, seenAt = null;
    let markI = 0, overshot = false;

    for (let t = 0; t <= UNTIL; t += STEP) {
      // hash exactly on the marks, so two runs are compared at equal tick counts
      /*
       * Land EXACTLY on the mark before hashing.
       *
       * This took the hash on the first sample whose tick was `>= mark`, which is a different
       * tick every run — and `boot()` waits 1,500 ms of wall clock after `ready` with autoplay
       * on, so the simulation has already advanced a jitter-dependent number of ticks before
       * the first sample. Between them, the MARKS hashes were never reproducible, which means
       * the hash-equality refusal in `jg-compare` **could not fire**, and I invoked it as my
       * safety mechanism all day. Measured: two loads of one seed on one tree gave 51b3a42a and
       * e4bb3a6a at tick 900, and 8,249 against 8,256 alive at 2,700.
       *
       * The engine documents the simulation as a pure function of (config, seed, tick index),
       * so the cure is to ask for the tick rather than for a moment: advance the exact shortfall
       * and hash there. `advanceTicks` exists precisely for this.
       */
      /*
       * Read the tick, advance the shortfall and hash — all inside ONE evaluate, because the
       * three of them must be atomic with respect to the rAF loop.
       *
       * Split across three evaluates this still drifted: a live frame lands between the read and
       * the advance and carries up to `maxStepsPerFrame = 5` ticks with it, so two runs asking
       * for tick 6,000 arrived at 6,000 and 6,004 and disagreed on every hash. One synchronous
       * evaluate cannot be interleaved by rAF, so the delta cannot go stale between computing it
       * and spending it.
       */
      const nextMark = MARKS[markI];
      if (nextMark !== undefined) {
        const got = await page.evaluate((mark) => {
          const g = window.__game, now = g.engine.time.tick;
          if (now >= mark) return { overshot: now };
          g.advanceTicks(mark - now, 1000 / 60);
          return { at: g.engine.time.tick, ...g.hashes() };
        }, nextMark);
        if (got.overshot !== undefined) { overshot = true; hashes[nextMark] = got; markI++; }
        else if (got.at === nextMark) { hashes[nextMark] = got; markI++; }
        else { hashes[nextMark] = { ...got, missed: true }; overshot = true; markI++; }
      }
      await ff(page, STEP);
      const s = await page.evaluate(() => {
        const tr = window.__TRUTH(), h = window.__HUD();
        return { t: tr.t, tick: tr.tick, per: tr.per, res: tr.flowResult,
          adv: h.adv, phase: h.phase, obj: tr.objective };
      });
      const f = Object.keys(s.per).map(Number);
      const me = s.per[0] ?? { alive: 0, routing: 0, units: 0, dead: 0 };
      const foeKey = f.find(k => k !== 0);
      const them = s.per[foeKey] ?? { alive: 0, routing: 0, units: 0, dead: 0 };
      curve.push({ t: s.t, me: me.alive, them: them.alive, myRouting: me.routing,
        theirRouting: them.routing, myDead: me.dead, theirDead: them.dead, phase: s.phase, adv: s.adv });
      const living = me.alive + them.alive;
      // grid-quantised fallbacks kept only to detect a missing event, never quoted
      if (gridContact === null && n0 - living >= 40) gridContact = s.t;
      if (gridBreakUs === null && me.routing > 0) gridBreakUs = s.t;
      if (gridBreakThem === null && them.routing > 0) gridBreakThem = s.t;
      // the advantage, as the plaque computes it: share of surviving men
      const share = living > 0 ? me.alive / living : 0.5;
      const lead = (share - 0.5) * 2;
      maxLead = Math.max(maxLead, Math.abs(lead));
      if (contactAt !== null) minGapAfterContact = Math.min(minGapAfterContact, Math.abs(lead));
      const sign = Math.abs(lead) < 0.04 ? 0 : Math.sign(lead);
      if (sign !== 0 && lastSign !== 0 && sign !== lastSign) flips++;
      if (sign !== 0) lastSign = sign;

      const e = await ended(page);
      if (e) {
        verdict = e.verdict; reason = s.res?.reason; victor = s.res?.victor;
        /*
         * The arbiter's own `at`, not the sample clock.
         *
         * This recorded `tEnd = s.t` — the time of the sample on which the result panel was
         * first *seen* — and the loop samples every `STEP` seconds. So every verdict was
         * reported up to STEP late, and worse, twelve seeds that truly finish at 55-58 s all
         * landed in one 10 s bucket and came out as "t+62.85, sd 0.15 s". I quoted that sd as
         * evidence the battle was identical on every seed. **It was the sampling grid, not the
         * battle.** The true spread is about 3 s, which is still extraordinary and is not what
         * I said.
         *
         * MAP-METHOD rule 12 in a third costume: the statistic did not lose its sample or its
         * spread, it lost its *resolution*, and returned a confident number anyway. A before/
         * after comparison survives it because both arms share the grid; an absolute claim does
         * not, and the absolute claim is the one I put in front of people.
         */
        tEnd = s.res?.at != null ? Math.round(s.res.at * 100) / 100 : s.t;
        seenAt = s.t;
        break;
      }
    }
    const firsts = await page.evaluate(() => window.__firsts);
    const foeKey0 = Object.keys(start.per).map(Number).find(k => k !== 0);
    const contactAt = firsts.contact, firstBreakUs = firsts.breakBy[0] ?? null,
      firstBreakThem = firsts.breakBy[foeKey0] ?? null;
    const row = { seed, verdict, reason, victor, at: tEnd, seenAt,
      grid: { contact: gridContact, breakUs: gridBreakUs, breakThem: gridBreakThem }, contactAt, firstBreakUs, firstBreakThem,
      contestWindow: tEnd !== null && contactAt !== null ? +(tEnd - contactAt).toFixed(1) : null,
      flips, maxLead: +maxLead.toFixed(3), minGapAfterContact: +minGapAfterContact.toFixed(3),
      n0, curve, hashes, overshot };
    rows.push(row);
    // the two numbers the coordinator's own measurement is on
    const at200 = curve.find(c => c.t >= 200) ?? curve[curve.length - 1];
    const at400 = curve.find(c => c.t >= 400) ?? curve[curve.length - 1];
    L.say(`seed ${String(seed).padStart(10)}  ${String(verdict ?? 'none').padEnd(8)} ${String(reason ?? '-').padEnd(10)} at t+${String(tEnd ?? '-').padStart(6)} | contact t+${String(contactAt ?? '-').padStart(5)} firstBreak me t+${String(firstBreakUs ?? '-').padStart(5)} them t+${String(firstBreakThem ?? '-').padStart(5)} | contested ${String(row.contestWindow ?? '-').padStart(6)} s flips ${flips} maxLead ${row.maxLead} minGap ${row.minGapAfterContact} | alive@200 ${at200 ? at200.me + '+' + at200.them + '=' + (at200.me + at200.them) : '-'} alive@400 ${at400 ? at400.me + '+' + at400.them + '=' + (at400.me + at400.them) : '-'}`);
  } catch (e) {
    L.say(`seed ${seed}: THREW ${String(e).slice(0, 200)}`);
    rows.push({ seed, error: String(e).slice(0, 200) });
  } finally { if (browser) await browser.close(); }
}

const ok = rows.filter(r => !r.error);
const sum = (f) => ok.map(f).filter(n => n != null);
const mean = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null;
const s200 = sum(r => { const c = r.curve.find(c => c.t >= 200); return c ? c.me + c.them : null; });
const s400 = sum(r => { const c = r.curve.find(c => c.t >= 400); return c ? c.me + c.them : null; });
L.say(`\n--- ${TAG} @ ${head.slice(0, 8)} / src ${srcHash} ---`);
L.say(`survivors at t+200: ${JSON.stringify(s200)}  mean ${mean(s200)}`);
L.say(`survivors at t+400: ${JSON.stringify(s400)}  mean ${mean(s400)}`);
L.say(`contact:            ${JSON.stringify(sum(r => r.contactAt))}  mean ${mean(sum(r => r.contactAt))}`);
L.say(`my first break:     ${JSON.stringify(sum(r => r.firstBreakUs))}  mean ${mean(sum(r => r.firstBreakUs))}`);
L.say(`their first break:  ${JSON.stringify(sum(r => r.firstBreakThem))}  mean ${mean(sum(r => r.firstBreakThem))}`);
L.say(`decided at:         ${JSON.stringify(sum(r => r.at))}  mean ${mean(sum(r => r.at))}`);
L.say(`contested window:   ${JSON.stringify(sum(r => r.contestWindow))}  mean ${mean(sum(r => r.contestWindow))}`);
L.say(`advantage flips:    ${JSON.stringify(sum(r => r.flips))}`);
L.say(`closest it ever got:${JSON.stringify(sum(r => r.minGapAfterContact))}`);
const outcomes = {};
for (const r of ok) outcomes[`${r.verdict}/${r.reason}`] = (outcomes[`${r.verdict}/${r.reason}`] ?? 0) + 1;
L.say(`outcomes:           ${JSON.stringify(outcomes)}`);
L.say(`hash marks:         ${JSON.stringify(ok.map(r => ({ seed: r.seed, h: Object.fromEntries(Object.entries(r.hashes).map(([k, v]) => [k, typeof v === 'object' ? Object.values(v).join('/') : v])) })), null, 0).slice(0, 2000)}`);
await dump(OUT, `shape-${MAP}-${SCEN}-${TAG}`, { tag: TAG, head, srcHash, map: MAP, scen: SCEN,
  seeds: SEEDS, step: STEP, marks: MARKS, rows, log: L.log });
L.say(`\nwritten to screenshots/judge/shape/shape-${MAP}-${SCEN}-${TAG}.json`);
