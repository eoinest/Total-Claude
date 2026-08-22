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
/** Ticks the state hash is taken at. 30 Hz, so t+30/90/150/200/400. */
const MARKS = [900, 2700, 4500, 6000, 12000];

let head = '?', srcHash = '?';
try {
  head = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
  srcHash = execSync("find src -type f \\( -name '*.ts' -o -name '*.css' -o -name '*.glsl' \\) -print0 | sort -z | xargs -0 cat | shasum -a 256 | cut -c1-16",
    { cwd: ROOT, shell: '/bin/sh' }).toString().trim();
} catch { /* not a checkout */ }
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
    const start = await page.evaluate(() => { const t = window.__TRUTH();
      return { per: t.per, strength: { ...t.strength } }; });
    const n0 = Object.values(start.per).reduce((a, p) => a + p.alive, 0);

    const curve = [], hashes = {};
    let contactAt = null, firstBreakUs = null, firstBreakThem = null;
    let lastSign = 0, flips = 0, maxLead = 0, minGapAfterContact = 1;
    let verdict = null, tEnd = null, reason = null, victor = null;
    let markI = 0;

    for (let t = 0; t <= UNTIL; t += STEP) {
      // hash exactly on the marks, so two runs are compared at equal tick counts
      const nextMark = MARKS[markI];
      const nowTick = await page.evaluate(() => window.__game.engine.time.tick);
      if (nextMark !== undefined && nowTick >= nextMark) {
        hashes[nextMark] = await page.evaluate(() => window.__game.hashes());
        markI++;
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
      if (contactAt === null && n0 - living >= 40) contactAt = s.t;
      if (firstBreakUs === null && me.routing > 0) firstBreakUs = s.t;
      if (firstBreakThem === null && them.routing > 0) firstBreakThem = s.t;
      // the advantage, as the plaque computes it: share of surviving men
      const share = living > 0 ? me.alive / living : 0.5;
      const lead = (share - 0.5) * 2;
      maxLead = Math.max(maxLead, Math.abs(lead));
      if (contactAt !== null) minGapAfterContact = Math.min(minGapAfterContact, Math.abs(lead));
      const sign = Math.abs(lead) < 0.04 ? 0 : Math.sign(lead);
      if (sign !== 0 && lastSign !== 0 && sign !== lastSign) flips++;
      if (sign !== 0) lastSign = sign;

      const e = await ended(page);
      if (e) { verdict = e.verdict; tEnd = s.t; reason = s.res?.reason; victor = s.res?.victor; break; }
    }
    const row = { seed, verdict, reason, victor, at: tEnd, contactAt, firstBreakUs, firstBreakThem,
      contestWindow: tEnd !== null && contactAt !== null ? +(tEnd - contactAt).toFixed(1) : null,
      flips, maxLead: +maxLead.toFixed(3), minGapAfterContact: +minGapAfterContact.toFixed(3),
      n0, curve, hashes };
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
